// `pecotv evidence create` の integration test。
// 実 PNG / JPEG をテスト内で組み立て、in-process (parseAsync) で CLI を回す。
// 生成 xlsx は yauzl + xmldom の XPath で観測する (contracts/evidence-cli.md §3)。
//
// XPath は prefix 必須。sheet1.xml / workbook.xml は既定名前空間つき文書なので
// prefix なしの `//c` はヒットしない (probe/xpath-check.mjs で確認済み)。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリ配下のテスト生成物のみを触る */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createEvidenceCreateCommand,
  type EvidenceCreateDependencies,
} from '../../../src/commands/evidence-xlsx/create.js'
import { writeEvidenceWorkbook } from '../../../src/infra/evidence-xlsx/workbook-writer.js'
import { defaultLintText } from '../../../src/infra/text-lint.js'
import type { XmlDocument } from '../../../src/domain/_shared/ports.js'
import { buildJpeg, buildPng, buildTruncatedPng } from '../../_helpers/image-fixture.js'
import {
  inlineStringTexts,
  mediaPartsByRelationship,
  OOXML_NS,
  parsePart,
  readSingleJsonEvent,
} from '../../_helpers/ooxml-parts.js'
import { readZipEntries } from '../../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { verifies } from '../../_helpers/verifies.js'

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

const workDirectory = useTemporaryDirectory('pecotv-evidence-create-')
const stdout = makeStream()
const stderr = makeStream()

beforeEach(() => {
  stdout.chunks.length = 0
  stderr.chunks.length = 0
})

afterEach(() => {
  rmSync(workDirectory(), { recursive: true, force: true })
})

/**
実 fs を使う本番相当の deps (writeWorkbook / readFile は差し替えない)。
*/
function realDependencies(): EvidenceCreateDependencies {
  return {
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    readFile: (filePath: string) => Promise.resolve(readFileSync(filePath, 'utf8')),
    lintText: defaultLintText,
    writeWorkbook: writeEvidenceWorkbook,
  }
}

function place(name: string, bytes: Readonly<Buffer>): string {
  const filePath = workDirectory(name)
  writeFileSync(filePath, bytes)
  return filePath
}

function writeSpec(spec: unknown): string {
  const specPath = workDirectory('spec.json')
  writeFileSync(specPath, JSON.stringify(spec), 'utf8')
  return specPath
}

async function runCli(arguments_: readonly string[]): Promise<void> {
  const command = createEvidenceCreateCommand(realDependencies)
  await command.parseAsync([...arguments_], { from: 'user' })
}

/**
単一行 JSON の stdout をオブジェクトとして読む。
*/
function readJsonEvent(): Record<string, unknown> {
  return readSingleJsonEvent(stdout.chunks.join(''))
}

describe('pecotv evidence create — 正常系 (contracts §3 の観測点)', () => {
  it('画像 3 枚を渡すと、シート 1 枚・No.1 から No.3 の連番・画像 3 件・表示 px × 9525 の EMU・元画像と同じ media の xlsx を出す', async () => {
    const shots = [
      { bytes: buildPng(1920, 1080, [200, 40, 40]), name: '01-login.png', caption: 'ログイン画面を表示' },
      { bytes: buildPng(800, 600, [40, 80, 200]), name: '02-home.png', caption: 'ホーム画面へ遷移' },
      // caption 省略 → ファイル名 (拡張子除く) から補完される (FR-004)。
      { bytes: buildPng(400, 300, [40, 160, 80]), name: '03-logout.png', caption: undefined },
    ]
    const items = shots.map(shot => (shot.caption === undefined
      ? { imagePath: place(shot.name, shot.bytes) }
      : { imagePath: place(shot.name, shot.bytes), caption: shot.caption }))
    const specPath = writeSpec({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      items,
    })
    const out = workDirectory('evidence.xlsx')

    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await runCli(['--input', specPath, '--out', out, '--json'])
      expect(process.exitCode).toBe(undefined)
    }
    finally {
      process.exitCode = previousExit
    }

    const event = readJsonEvent()
    expect(event['event']).toBe('result')
    expect(event['outPath']).toBe(out)
    expect(path.isAbsolute(String(event['outPath']))).toBe(true)
    expect(event['items']).toBe(3)
    expect(event['annotations']).toBe(0)
    expect(event['skipped']).toStrictEqual([])

    const entries = await readZipEntries(out)

    // 単一シート (name=Evidence)
    const workbook = parsePart(entries, 'xl/workbook.xml')
    const sheets = workbook.selectNodes('//s:sheets/s:sheet', OOXML_NS)
    expect(sheets).toHaveLength(1)
    expect(sheets[0]?.getAttr('name')).toBe('Evidence')

    // ヘッダー文言と No.<n> が inline string として現れる (欠番なし)
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    const texts = inlineStringTexts(sheet)
    expect(texts).toStrictEqual([
      'ログイン機能 動作確認エビデンス',
      '作成日',
      '2026-08-17',
      '作成者',
      'K. Hayakawa',
      'No.1 ログイン画面を表示',
      'No.2 ホーム画面へ遷移',
      'No.3 03-logout',
    ])
    // prefix なし XPath が名前空間付きの要素にヒットしないことも pin する。
    expect(sheet.selectNodes('//c')).toHaveLength(0)

    // 画像 3 枚・注記図形 0・EMU は「表示 px × 9525」
    const drawing = parsePart(entries, 'xl/drawings/drawing1.xml')
    expect(drawing.selectNodes('//xdr:oneCellAnchor//xdr:pic', OOXML_NS)).toHaveLength(3)
    expect(drawing.selectNodes('//xdr:sp', OOXML_NS)).toHaveLength(0)
    const extents = drawing.selectNodes('//xdr:oneCellAnchor/xdr:ext', OOXML_NS)
      .map(node => [node.getAttr('cx'), node.getAttr('cy')])
    expect(extents).toStrictEqual([
      // 1920x1080 → 960x540
      ['9144000', '5143500'],
      ['7620000', '5715000'],
      ['3810000', '2857500'],
    ])

    // media は rels から解決した格納名で、入力と byte 一致する (FR-005: 無加工)
    const mediaParts = mediaPartsByRelationship(entries)
    const embeds = drawing.selectNodes('//a:blip', OOXML_NS).map(node => node.getAttr('r:embed') ?? '')
    expect(embeds).toStrictEqual(['rId1', 'rId2', 'rId3'])
    const embedded = embeds.map(embed => entries.get(mediaParts.get(embed) ?? ''))
    expect(embedded).toStrictEqual(shots.map(shot => shot.bytes))
  })

  it('--json なしでは人間向けサマリを stdout に出す', async () => {
    const specPath = writeSpec({
      title: 'T',
      createdDate: '2026-08-17',
      items: [{ imagePath: place('01.png', buildPng(400, 300)) }],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out])

    expect(stdout.chunks.join('')).toBe(`created: ${out}\nitems: 1 / annotations: 0\n`)
    expect(existsSync(out)).toBe(true)
  })

  it('偽装拡張子の JPEG は image<N>.jpeg として格納され rels もそれを指す', async () => {
    const jpeg = buildJpeg(640, 480)
    const specPath = writeSpec({
      title: 'T',
      createdDate: '2026-08-17',
      items: [{ imagePath: place('fake.png', jpeg) }],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out, '--json'])

    const entries = await readZipEntries(out)
    const mediaParts = mediaPartsByRelationship(entries)
    expect(mediaParts.values().toArray()).toStrictEqual(['xl/media/image1.jpeg'])
    expect(entries.get('xl/media/image1.jpeg')?.equals(jpeg)).toBe(true)
  })
})

describe('pecotv evidence create — 混在入力 (FR-006)', () => {
  it('skipped 3 語彙 + 有効 item の再採番で exit 0', async () => {
    const directoryPath = workDirectory('shots')
    mkdirSync(directoryPath)
    const missing = workDirectory('missing.png')
    const fake = place('note.png', Buffer.from('これは画像ではありません', 'utf8'))
    const truncated = place('cut.png', buildTruncatedPng())
    const valid = place('valid.png', buildPng(1000, 333))
    const specPath = writeSpec({
      title: '混在入力',
      createdDate: '2026-08-17',
      items: [
        { imagePath: missing, caption: '不在' },
        { imagePath: valid, caption: '有効な 1 枚' },
        { imagePath: fake, caption: '偽 png' },
        { imagePath: truncated, caption: '切り詰め png' },
      ],
    })
    const out = workDirectory('evidence.xlsx')

    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await runCli(['--input', specPath, '--out', out, '--json'])
      // in-process 実行では成功時に exitCode を設定しないことで exit 0 を観測する。
      expect(process.exitCode).toBe(undefined)
    }
    finally {
      process.exitCode = previousExit
    }

    const event = readJsonEvent()
    expect(event['items']).toBe(1)
    expect(event['skipped']).toStrictEqual([
      { path: missing, reason: 'not-found' },
      { path: fake, reason: 'unsupported-format' },
      { path: truncated, reason: 'unreadable' },
    ])

    const entries = await readZipEntries(out)
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    const texts = inlineStringTexts(sheet)
    expect(texts).toContain('No.1 有効な 1 枚')
    expect(texts.filter(text => text.startsWith('No.'))).toHaveLength(1)
    expect(parsePart(entries, 'xl/drawings/drawing1.xml')
      .selectNodes('//xdr:oneCellAnchor//xdr:pic', OOXML_NS)).toHaveLength(1)
  })

  it('--json なしの混在入力では除外一覧と理由を stdout に出す', async () => {
    const missing = workDirectory('missing.png')
    const specPath = writeSpec({
      title: '混在入力',
      createdDate: '2026-08-17',
      items: [
        { imagePath: place('valid.png', buildPng(400, 300)), caption: '有効' },
        { imagePath: missing, caption: '不在' },
      ],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out])

    expect(stdout.chunks.join('')).toBe(
      `created: ${out}\nitems: 1 / annotations: 0\nskipped: 1\n  - ${missing} (not-found)\n`,
    )
  })
})

/**
oneCellAnchor 1 件を「どのセルに何を載せたか」に絞った観測用の形。
kind は直下の子 (pic 単体か、注記を束ねた grpSp か)。
*/
interface AnchorSummary {
  readonly kind: string
  readonly cell: string
  readonly colOff: string
  readonly rowOff: string
  readonly extent: readonly [string, string]
}

function anchorSummaries(drawing: Readonly<XmlDocument>): readonly AnchorSummary[] {
  return drawing.selectNodes('//xdr:oneCellAnchor', OOXML_NS).map((anchor) => {
    const from = anchor.selectNodes('./xdr:from', OOXML_NS)[0]
    const extent = anchor.selectNodes('./xdr:ext', OOXML_NS)[0]
    const group = anchor.selectNodes('./xdr:grpSp', OOXML_NS)[0]
    return {
      kind: group === undefined ? 'pic' : 'grpSp',
      cell: [
        from?.selectNodes('./xdr:col', OOXML_NS)[0]?.text() ?? '',
        from?.selectNodes('./xdr:row', OOXML_NS)[0]?.text() ?? '',
      ].join(','),
      colOff: from?.selectNodes('./xdr:colOff', OOXML_NS)[0]?.text() ?? '',
      rowOff: from?.selectNodes('./xdr:rowOff', OOXML_NS)[0]?.text() ?? '',
      extent: [extent?.getAttr('cx') ?? '', extent?.getAttr('cy') ?? ''],
    }
  })
}

describe('pecotv evidence create — 注記の描画 (FR-010 / SC-006)', () => {
  it('注記ありの画像・注記なしの画像・除外された画像が混在すると、注記図形を注記ありの画像のアンカーにだけ付ける', async () => {
    const annotated = place('01-login.png', buildPng(1920, 1080, [200, 40, 40]))
    const plain = place('02-home.png', buildPng(800, 600, [40, 80, 200]))
    const missing = workDirectory('missing.png')
    const specPath = writeSpec({
      title: '注記付きエビデンス',
      createdDate: '2026-08-17',
      items: [
        {
          imagePath: annotated,
          caption: 'ログイン画面を表示',
          annotations: [
            {
              type: 'callout',
              text: `A&B <tag> "q"`,
              box: { x: 0.5, y: 0.6, w: 0.3, h: 0.1 },
              anchor: { x: 0.25, y: 0.5 },
            },
            { type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } },
            { type: 'arrow', from: { x: 0.4, y: 0.6 }, to: { x: 0.25, y: 0.5 } },
          ],
        },
        // 受入シナリオ 3: 同じ spec に注記なしの画像が含まれても sp は増えない。
        { imagePath: plain, caption: 'ホーム画面へ遷移' },
        // FR-006 交差: 除外された画像の注記は、注記数と sp の両方から外れる。
        {
          imagePath: missing,
          caption: '不在',
          annotations: [{ type: 'highlight', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
        },
      ],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out, '--json'])

    const event = readJsonEvent()
    expect(event['items']).toBe(2)
    expect(event['annotations']).toBe(3)
    expect(event['skipped']).toStrictEqual([{ path: missing, reason: 'not-found' }])

    const entries = await readZipEntries(out)
    const drawing = parsePart(entries, 'xl/drawings/drawing1.xml')

    // 出力された sp の実数が --json の annotations と一致する。
    expect(drawing.selectNodes('//xdr:sp', OOXML_NS)).toHaveLength(3)

    // 注記付きの画像は、画像と注記を grpSp にまとめて 1 つのアンカーに置く。
    // アンカーのオフセットは 0。注記の位置は、グループ内の a:off (画像左上が原点) で表す。
    // 1920x1080 → 960x540 なので相対座標には 0.5 倍が伝播する。
    expect(anchorSummaries(drawing)).toStrictEqual([
      { kind: 'grpSp', cell: '1,6', colOff: '0', rowOff: '0', extent: ['9144000', '5143500'] },
      // 注記なしの画像は pic だけを置く。
      { kind: 'pic', cell: '1,37', colOff: '0', rowOff: '0', extent: ['7620000', '5715000'] },
    ])
    const shapes = drawing.selectNodes('//xdr:grpSp/xdr:sp', OOXML_NS).map((shape) => {
      const xfrm = shape.selectNodes('./xdr:spPr/a:xfrm', OOXML_NS)[0]
      const off = xfrm?.selectNodes('./a:off', OOXML_NS)[0]
      const extension = xfrm?.selectNodes('./a:ext', OOXML_NS)[0]
      return {
        kind: shape.selectNodes('./xdr:spPr/a:prstGeom', OOXML_NS)[0]?.getAttr('prst'),
        off: [off?.getAttr('x'), off?.getAttr('y')],
        ext: [extension?.getAttr('cx'), extension?.getAttr('cy')],
      }
    })
    expect(shapes).toStrictEqual([
      { kind: 'wedgeRectCallout', off: ['4572000', '3086100'], ext: ['2743200', '514350'] },
      { kind: 'rect', off: ['914400', '1028700'], ext: ['1828800', '771525'] },
      { kind: 'line', off: ['2286000', '2571750'], ext: ['1371600', '514350'] },
    ])

    // 矢印の向きは flip で表す (左上向きなので両方立つ)。
    const arrow = drawing.selectNodes('//xdr:sp[.//a:prstGeom/@prst="line"]//a:xfrm', OOXML_NS)[0]
    expect([arrow?.getAttr('flipH'), arrow?.getAttr('flipV')]).toStrictEqual(['1', '1'])

    // callout の文言は 5 文字エスケープを通っても元の文字列として読み出せる (SC-006)。
    expect(drawing.selectNodes('//xdr:sp//a:t', OOXML_NS).map(node => node.text()))
      .toStrictEqual([`A&B <tag> "q"`])

    // shape id はグループ・画像・注記を通して一意。
    const ids = drawing.selectNodes('//xdr:cNvPr', OOXML_NS).map(node => node.getAttr('id') ?? '')
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })

  it('--json なしでは注記数もサマリに出す', async () => {
    const specPath = writeSpec({
      title: 'T',
      createdDate: '2026-08-17',
      items: [{
        imagePath: place('01.png', buildPng(400, 300)),
        annotations: [
          { type: 'highlight', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { type: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } },
        ],
      }],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out])

    expect(stdout.chunks.join('')).toBe(`created: ${out}\nitems: 1 / annotations: 2\n`)
  })
})

describe('pecotv evidence create — US3 ヘッダー・キャプション・並び順の指定', () => {
  it('items の指定順が通し番号になり、caption の明示と省略が混在しても崩れない', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-01')
    // 受入シナリオ 1–3 / SC-002: ファイル名の自然順 (01 → 02 → 03) ではなく spec の
    // 宣言順 (03 → 01 → 02) が No. と縦並び順になる。extraHeaders は 2 件を宣言順で出す。
    //
    // caption は 2 件目だけファイル名の stem と異なる文言を明示する。全件省略にすると
    // 「明示された caption を無視して常に stem を使う」実装も通ってしまい、明示と補完
    // (FR-004) の判別ができない。
    const shots = [
      { name: '03-logout.png', bytes: buildPng(1920, 1080, [200, 40, 40]), caption: undefined },
      { name: '01-login.png', bytes: buildPng(800, 600, [40, 80, 200]), caption: 'ログイン画面を表示' },
      { name: '02-submit.png', bytes: buildPng(400, 300, [40, 160, 80]), caption: undefined },
    ]
    const specPath = writeSpec({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      items: shots.map(shot => (shot.caption === undefined
        ? { imagePath: place(shot.name, shot.bytes) }
        : { imagePath: place(shot.name, shot.bytes), caption: shot.caption })),
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out, '--json'])

    expect(readJsonEvent()['items']).toBe(3)

    const entries = await readZipEntries(out)
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    expect(inlineStringTexts(sheet)).toStrictEqual([
      'ログイン機能 動作確認エビデンス',
      '作成日',
      '2026-08-17',
      '作成者',
      'K. Hayakawa',
      '環境',
      'staging',
      // 1 件目・3 件目は省略したのでファイル名の stem、2 件目は明示した文言。
      'No.1 03-logout',
      'No.2 ログイン画面を表示',
      'No.3 02-submit',
    ])

    // 画像も同じ順で並ぶ (rId 順 = 宣言順 = No. 順) ことを media の byte で確かめる。
    // 3 枚は寸法違いで byte が異なるため、取り違えれば一致しない。
    const drawing = parsePart(entries, 'xl/drawings/drawing1.xml')
    expect(drawing.selectNodes('//xdr:oneCellAnchor//xdr:pic', OOXML_NS)).toHaveLength(3)
    const mediaParts = mediaPartsByRelationship(entries)
    const embeds = drawing.selectNodes('//a:blip', OOXML_NS).map(node => node.getAttr('r:embed') ?? '')
    expect(embeds).toStrictEqual(['rId1', 'rId2', 'rId3'])
    expect(embeds.map(embed => entries.get(mediaParts.get(embed) ?? '')))
      .toStrictEqual(shots.map(shot => shot.bytes))
  })

  it('extraHeaders 未指定ではヘッダーがタイトルと作成日だけになる', async () => {
    const specPath = writeSpec({
      title: 'ヘッダー既定のエビデンス',
      createdDate: '2026-08-17',
      items: [{ imagePath: place('01-login.png', buildPng(400, 300)), caption: 'ログイン画面を表示' }],
    })
    const out = workDirectory('evidence.xlsx')

    await runCli(['--input', specPath, '--out', out, '--json'])

    const entries = await readZipEntries(out)
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    // 追加ヘッダー行が 1 行も無いことを全文一致で見る (部分一致だと余分な行を見逃す)。
    expect(inlineStringTexts(sheet)).toStrictEqual([
      'ヘッダー既定のエビデンス',
      '作成日',
      '2026-08-17',
      'No.1 ログイン画面を表示',
    ])
  })
})

describe('pecotv evidence create — 失敗系', () => {
  it('全滅入力は exit 1 で既存 --out を壊さない', async () => {
    const out = workDirectory('evidence.xlsx')
    const existing = Buffer.from('前回の生成物', 'utf8')
    writeFileSync(out, existing)
    const specPath = writeSpec({
      title: '全滅',
      createdDate: '2026-08-17',
      items: [
        { imagePath: workDirectory('missing1.png') },
        { imagePath: workDirectory('missing2.png') },
      ],
    })

    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await runCli(['--input', specPath, '--out', out, '--json'])
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }

    const event = readJsonEvent()
    expect(event['event']).toBe('evidence.create.error')
    expect(event['reason']).toBe('no-valid-images')
    expect(readFileSync(out).equals(existing)).toBe(true)
  })

  it('検証エラーは exit 1 で全件を stderr に列挙し xlsx を作らない', async () => {
    const specPath = writeSpec({
      title: '検証エラー',
      createdDate: '2026-08-17',
      items: [{
        imagePath: place('01.png', buildPng(100, 100)),
        annotations: [
          { type: 'callout', text: 'はみ出し', box: { x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, anchor: { x: 0.5, y: 0.5 } },
          { type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.2, y: 0.2 } },
        ],
      }],
    })
    const out = workDirectory('evidence.xlsx')

    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await runCli(['--input', specPath, '--out', out])
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }

    const written = stderr.chunks.join('')
    expect(written).toContain('items[0].annotations[0].box.w: x + w exceeds 1')
    expect(written).toContain('items[0].annotations[1]: arrow from and to must not be the same point')
    expect(existsSync(out)).toBe(false)
  })

  it('--input 未指定 + --json は commander エラーを JSON イベント化する', async () => {
    const command = createEvidenceCreateCommand(realDependencies)
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'evidence', 'create', '--json']
    try {
      await expect(command.parseAsync(['--json'], { from: 'user' })).rejects.toThrow()
      const event = readJsonEvent()
      expect(event['event']).toBe('evidence.create.error')
      expect(event['reason']).toBe('invalid-option')
      expect(event['detail']).toContain(`required option '--input <path>' not specified`)
      expect(stderr.chunks).toHaveLength(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('--input 未指定 + --json なしは commander の文言を stderr に素通しする', async () => {
    const command = createEvidenceCreateCommand(realDependencies)
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'evidence', 'create']
    try {
      await expect(command.parseAsync([], { from: 'user' })).rejects.toThrow()
      expect(stderr.chunks.join('')).toContain(`required option '--input <path>' not specified`)
      expect(stdout.chunks).toHaveLength(0)
    }
    finally {
      process.argv = originalArgv
    }
  })
})
