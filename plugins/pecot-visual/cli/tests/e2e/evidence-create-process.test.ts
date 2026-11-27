// Issue #924 — evidence_create を実サーバプロセス（dist/main.js）へ MCP で呼ぶ e2e。
//
// integration test は in-process で execute を呼ぶ。
// そのため dist からの起動と MCP 越しの引数の受け渡しは、
// この流れでしか観測できない。
// ヘッダー・キャプション・並び順 (US3) の指定が実プロセスの出力 xlsx まで届くことを、生成物の中身まで見て確かめる。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { attachFile } from '../_helpers/attach.js'
import { explains } from '../_helpers/explains.js'
import { spawnToolSync } from '../_helpers/pecotv-e2e-run.js'
import { buildPng } from '../_helpers/image-fixture.js'
import {
  inlineStringTexts,
  mediaPartsByRelationship,
  OOXML_NS,
  parsePart,
  readSingleJsonEvent,
} from '../_helpers/ooxml-parts.js'
import { readZipEntries } from '../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')

const CLI_TS_SOURCE = path.join(CLI_TS_ROOT, 'src')
const CLI_TS_DIST = path.join(CLI_TS_ROOT, 'dist', 'main.js')

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
dist が src の変更を取り込んでいるかを見る。存在チェックだけだと、古い dist を
観測して「直したはずの退行が出ない / 直っていない退行が出る」ことに気付けない。
比較対象は tsconfig.build.json が実際にビルドする範囲 (テストファイルは除く) に揃える。
*/
function assertBuiltCliIsFresh(): void {
  if (!existsSync(CLI_TS_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_TS_DIST}\n先に \`pnpm build\` を実行してください`)
  }
  const builtCliMtimeMs = statSync(CLI_TS_DIST).mtimeMs
  const staleSource = readdirSync(CLI_TS_SOURCE, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(filePath => !filePath.includes(`${path.sep}tests${path.sep}`))
    .find(filePath => statSync(filePath).mtimeMs > builtCliMtimeMs)
  if (staleSource !== undefined) {
    throw new Error(
      `cli dist が src より古いです (${staleSource} の方が新しい)\n`
      + '先に `pnpm build` を実行してください',
    )
  }
}

/**
ツールを cwd 指定で起動する。観測対象をサーバ本体に絞るため、build は事前に済ませておく。
*/
function runPecotv(arguments_: readonly string[], cwd: string): RunResult {
  const result = spawnToolSync(arguments_, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return { status: result.status, stdout, stderr }
}

const workDirectory = useTemporaryDirectory('pecotv-924-evidence-cli-', { hook: 'all', resolveRealPath: true })

beforeAll(() => {
  assertBuiltCliIsFresh()
  // --out の cwd 基準解決を絶対パスで比較するため、symlink を解決した実体を使う。
})

afterAll(() => {
  if (workDirectory() !== '' && existsSync(workDirectory())) {
    rmSync(workDirectory(), { recursive: true, force: true })
  }
})

describe('evidence_create の実プロセス実行', () => {
  it('画像の指定順と、キャプションの有無が混在し、ヘッダーが複数ある場合も、作業ディレクトリ基準の `out` へ xlsx を書き出す', async () => {
    await explains('`evidence_create` の実際のプロセスでの書き出しのテストです。3 枚の画像を指定順に並べ、キャプションの有無が混在する場合に、xlsx の文字列と画像の順序が指定どおりで、元の画像のバイト列と一致することを確認します。')
    // caption は 2 件目だけファイル名の stem と異なる文言を明示し、明示と補完 (FR-004) を
    // 判別できるようにする。
    const shots = [
      { name: '03-logout.png', bytes: buildPng(1920, 1080, [200, 40, 40]), caption: undefined },
      { name: '01-login.png', bytes: buildPng(800, 600, [40, 80, 200]), caption: 'ログイン画面を表示' },
      { name: '02-submit.png', bytes: buildPng(400, 300, [40, 160, 80]), caption: undefined },
    ]
    for (const shot of shots) {
      writeFileSync(workDirectory(shot.name), shot.bytes)
    }
    const specPath = workDirectory('spec.json')
    writeFileSync(specPath, JSON.stringify({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      // ファイル名の自然順 (01 → 02 → 03) とは別の順序を宣言する。
      items: shots.map(shot => (shot.caption === undefined
        ? { imagePath: workDirectory(shot.name) }
        : { imagePath: workDirectory(shot.name), caption: shot.caption })),
    }), 'utf8')

    const result = runPecotv(
      ['evidence', 'create', '--input', specPath, '--out', workDirectory('evidence.xlsx')],
      workDirectory(),
    )
    await attachFile('エビデンスの xlsx', workDirectory('evidence.xlsx'))

    expect(result.status).toBe(0)
    const event = readSingleJsonEvent(result.stdout)
    expect(event['event']).toBe('result')
    // 報告される outPath は指定した絶対パスと一致する (FR-007)。
    expect(event['outPath']).toBe(workDirectory('evidence.xlsx'))
    expect(event['items']).toBe(3)
    expect(event['skipped']).toStrictEqual([])

    const entries = await readZipEntries(workDirectory('evidence.xlsx'))
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    expect(inlineStringTexts(sheet)).toStrictEqual([
      'ログイン機能 動作確認エビデンス',
      '作成日',
      '2026-08-17',
      '作成者',
      'K. Hayakawa',
      '環境',
      'staging',
      'No.1 03-logout',
      'No.2 ログイン画面を表示',
      'No.3 02-submit',
    ])

    const drawing = parsePart(entries, 'xl/drawings/drawing1.xml')
    expect(drawing.selectNodes('//xdr:oneCellAnchor//xdr:pic', OOXML_NS)).toHaveLength(3)
    const mediaParts = mediaPartsByRelationship(entries)
    const embeds = drawing.selectNodes('//a:blip', OOXML_NS).map(node => node.getAttr('r:embed') ?? '')
    expect(embeds).toStrictEqual(['rId1', 'rId2', 'rId3'])
    // 3 枚は寸法違いで byte が異なるため、順序を取り違えれば一致しない。
    expect(embeds.map(embed => entries.get(mediaParts.get(embed) ?? '')))
      .toStrictEqual(shots.map(shot => shot.bytes))
  })
})
