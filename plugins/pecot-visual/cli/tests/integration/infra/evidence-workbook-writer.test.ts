// infra/evidence-xlsx/workbook-writer.ts の integration test。
// 実ファイル (mkdtemp) へ書き出し、yauzl で読み直してエントリ構成・media の byte 一致・
// skip 分類・部分生成物を残さないことを確認する。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリ配下のテスト生成物のみを触る */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { buildEvidenceLayout } from '../../../src/domain/evidence-xlsx/layout.js'
import type { NormalizedEvidenceItem, NormalizedEvidenceSpec } from '../../../src/domain/evidence-xlsx/spec-schema.js'
import {
  EvidenceWorkbookError,
  writeEvidenceWorkbook,
} from '../../../src/infra/evidence-xlsx/workbook-writer.js'
import { buildJpeg, buildPng, buildTruncatedPng } from '../../_helpers/image-fixture.js'
import { entryText, readZipEntries } from '../../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const EXPECTED_PART_ORDER: readonly string[] = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/_rels/sheet1.xml.rels',
  'xl/styles.xml',
  'xl/drawings/drawing1.xml',
  'xl/drawings/_rels/drawing1.xml.rels',
]

const workDirectory = useTemporaryDirectory('pecotv-evidence-writer-')

afterEach(() => {
  rmSync(workDirectory(), { recursive: true, force: true })
})

function item(imagePath: string, caption = 'キャプション'): NormalizedEvidenceItem {
  return { imagePath, caption, annotations: [] }
}

function spec(items: readonly NormalizedEvidenceItem[]): NormalizedEvidenceSpec {
  return {
    title: 'ログイン機能 動作確認エビデンス',
    createdDate: '2026-08-17',
    extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
    items,
  }
}

/**
指定バイト列を workDirectory() 配下に置き、絶対パスを返す。
*/
function place(name: string, bytes: Readonly<Buffer>): string {
  const filePath = workDirectory(name)
  writeFileSync(filePath, bytes)
  return filePath
}

/**
画像を workDirectory() に置き、その絶対パスを指す item を返す。
*/
function placedItem(name: string, bytes: Readonly<Buffer>, caption?: string): NormalizedEvidenceItem {
  return item(place(name, bytes), caption)
}

/**
workDirectory() 配下の存在しないファイルを指す item を返す。
*/
function missingItem(name: string, caption?: string): NormalizedEvidenceItem {
  return item(workDirectory(name), caption)
}

/**
items から組んだ仕様で xlsx を書き出す。
*/
async function writeItems(items: readonly NormalizedEvidenceItem[], out: string): ReturnType<typeof writeEvidenceWorkbook> {
  return writeEvidenceWorkbook(spec(items), out)
}

function outPath(): string {
  return workDirectory('evidence.xlsx')
}

describe('writeEvidenceWorkbook — 正常系', () => {
  it('xlsx のパーツを決まった順に並べ、画像を加工せずに格納する', async () => {
    await explains('`writeEvidenceWorkbook` が書き出す xlsx のテストです。画像 2 枚を渡した場合に、パーツが決まった順に並び、媒体 `image1.png` と `image2.png` が元の画像と一致し、シートに `No.1` と `No.2` が含まれることを確認します。')
    const first = buildPng(1920, 1080)
    const second = buildPng(800, 600, [10, 20, 30])
    const out = outPath()

    const result = await writeItems([placedItem('01.png', first, '1 枚目'), placedItem('02.png', second, '2 枚目')], out)

    expect(result).toStrictEqual({ outPath: out, items: 2, annotations: 0, skipped: [] })

    const entries = await readZipEntries(out)
    expect(entries.keys().toArray()).toStrictEqual([
      ...EXPECTED_PART_ORDER,
      'xl/media/image1.png',
      'xl/media/image2.png',
    ])
    // FR-005: 入力画像は無加工コピー。
    expect(entries.get('xl/media/image1.png')?.equals(first)).toBe(true)
    expect(entries.get('xl/media/image2.png')?.equals(second)).toBe(true)

    const sheet = entryText(entries, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<t>No.1 1 枚目</t>')
    expect(sheet).toContain('<t>No.2 2 枚目</t>')
    expect(entryText(entries, 'xl/workbook.xml')).toContain('name="Evidence"')
  })

  it('結果の annotations は、有効な画像に配置した注記図形の数を返し、除外された画像の注記は数えない', async () => {
    await explains('`writeEvidenceWorkbook` の結果のテストです。注記を持つ画像・注記のない画像・存在しない画像を渡した場合に、`annotations` が有効な画像の注記 2 件になり、`drawing1.xml` の図形も 2 件であることを確認します。')
    const out = outPath()
    const annotated: NormalizedEvidenceItem = {
      imagePath: place('01.png', buildPng(1920, 1080)),
      caption: '注記あり',
      annotations: [
        {
          type: 'callout',
          text: 'ログインボタン',
          box: { x: 0.5, y: 0.6, w: 0.3, h: 0.1 },
          anchor: { x: 0.25, y: 0.5 },
        },
        { type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } },
      ],
    }
    const skippedWithAnnotations: NormalizedEvidenceItem = {
      imagePath: workDirectory('missing.png'),
      caption: '不在',
      annotations: [{ type: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }],
    }

    const result = await writeItems([annotated, placedItem('02.png', buildPng(400, 300), '注記なし'), skippedWithAnnotations], out)

    // 除外された画像の注記は数に入らない。
    expect(result).toStrictEqual({
      outPath: out,
      items: 2,
      annotations: 2,
      skipped: [{ path: skippedWithAnnotations.imagePath, reason: 'not-found' }],
    })
    const entries = await readZipEntries(out)
    expect(entryText(entries, 'xl/drawings/drawing1.xml').match(/<xdr:sp>/g)).toHaveLength(2)
  })

  it('PNG と JPEG が混在する場合は、両方の Default を宣言し、拡張子を分けて格納する', async () => {
    await explains('画像の形式が混在する場合の、`writeEvidenceWorkbook` のテストです。`[Content_Types].xml` に `png` と `jpeg` の `Default` が宣言され、媒体が `image1.png` と `image2.jpeg` になることを確認します。')
    const png = buildPng(400, 300)
    const jpeg = buildJpeg(640, 480)
    const out = outPath()

    await writeItems([placedItem('01.png', png), placedItem('02.jpg', jpeg)], out)

    const entries = await readZipEntries(out)
    expect(entries.keys().filter(name => name.startsWith('xl/media/')).toArray()).toStrictEqual([
      'xl/media/image1.png',
      'xl/media/image2.jpeg',
    ])
    const contentTypes = entryText(entries, '[Content_Types].xml')
    expect(contentTypes).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(contentTypes).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>')
    expect(entryText(entries, 'xl/drawings/_rels/drawing1.xml.rels'))
      .toContain('Target="../media/image2.jpeg"')
  })

  it('拡張子が実際の形式と異なる画像は、判定した形式の拡張子で格納する', async () => {
    await explains('拡張子と中身の形式が異なる画像の、`writeEvidenceWorkbook` のテストです。中身が JPEG で、ファイル名が `.png` の画像を渡した場合に、`xl/media/image1.jpeg` として格納され、`image1.png` は格納されないことを確認します。')
    const out = outPath()
    // 中身は JPEG、ファイル名は .png。
    await writeItems([placedItem('fake.png', buildJpeg(100, 50))], out)

    const entries = await readZipEntries(out)
    expect(entries.keys().toArray()).toContain('xl/media/image1.jpeg')
    expect(entries.keys().toArray()).not.toContain('xl/media/image1.png')
  })

  it('同じパスの画像を 2 件並べても、重複を除かず、項目ごとに連番で格納する', async () => {
    await explains('同じ画像を 2 件渡した場合の、`writeEvidenceWorkbook` のテストです。結果の `items` が 2 になり、`xl/media/image1.png` と `image2.png` の 2 件が格納されることを確認します。')
    const png = buildPng(200, 100)
    const imagePath = place('same.png', png)
    const out = outPath()

    const result = await writeItems([item(imagePath), item(imagePath)], out)

    expect(result.items).toBe(2)
    const entries = await readZipEntries(out)
    expect(entries.keys().filter(name => name.startsWith('xl/media/')).toArray()).toStrictEqual([
      'xl/media/image1.png',
      'xl/media/image2.png',
    ])
  })

  it('同じ出力先へ続けて 2 回書き出すと、上書きされ、前回の内容は混在しない', async () => {
    await explains('出力先のファイルへの上書きのテストです。画像 2 件と画像 1 件を同じ出力先へ続けて書き出した場合に、2 回目のファイルが小さくなり、媒体が `image1.png` の 1 件だけになることを確認します。')
    const out = outPath()
    const png = buildPng(400, 300)
    const imagePath = place('01.png', png)

    await writeItems([item(imagePath), item(imagePath)], out)
    const firstSize = statSync(out).size
    await writeItems([item(imagePath)], out)

    expect(statSync(out).size).toBeLessThan(firstSize)
    const entries = await readZipEntries(out)
    expect(entries.keys().filter(name => name.startsWith('xl/media/')).toArray()).toStrictEqual([
      'xl/media/image1.png',
    ])
  })
})

/**
書式検証で使う注記。1 枚目にだけ付ける。
*/
const FORMAT_CASE_ANNOTATIONS: NormalizedEvidenceItem['annotations'] = [
  {
    type: 'callout',
    text: 'ログインボタン',
    box: { x: 0.5, y: 0.6, w: 0.3, h: 0.1 },
    anchor: { x: 0.25, y: 0.5 },
  },
  { type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } },
]

/**
1920x1080 (注記 2 件) + 400x300 の 2 枚を書き出して読み直す。
行割付と drawing の両方に幅を持たせた入力。
*/
async function writeTwoImageWorkbook(): Promise<ReadonlyMap<string, Buffer>> {
  const first = place('01.png', buildPng(1920, 1080))
  const second = place('02.png', buildPng(400, 300))
  const out = outPath()
  await writeItems([
    { imagePath: first, caption: '1 枚目', annotations: FORMAT_CASE_ANNOTATIONS },
    { imagePath: second, caption: '2 枚目', annotations: [] },
  ], out)
  return readZipEntries(out)
}

/**
上と同じ入力のレイアウト。出力の期待値は layout 側を正とする。
*/
function twoImageLayout(): ReturnType<typeof buildEvidenceLayout> {
  return buildEvidenceLayout({
    title: 'ログイン機能 動作確認エビデンス',
    createdDate: '2026-08-17',
    extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
    images: [
      { item: item('/img/01.png', '1 枚目'), width: 1920, height: 1080 },
      { item: item('/img/02.png', '2 枚目'), width: 400, height: 300 },
    ],
  })
}

describe('writeEvidenceWorkbook — 書式が出力まで届く', () => {
  it('帯の装飾専用のセルが、期待する行に期待する書式で出力される', async () => {
    await explains('`sheet1.xml` のセルの書式のテストです。タイトル帯とキャプション帯の装飾専用のセルが、値を持たない要素として決まった書式で出力され、ヘッダー表の値のセルは罫線付きの書式になることを確認します。')
    const sheet = entryText(await writeTwoImageWorkbook(), 'xl/worksheets/sheet1.xml')

    // タイトル帯 (行 1) とキャプション帯 (行 6 / 行 37) の値列。値なしの空要素で、
    // ラベル列と対になる帯右側の書式を持つ (帯が 2 セルにまたがって閉じる)。
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr">')
    expect(sheet).toContain('<c r="C1" s="2"/>')
    expect(sheet).toContain('<c r="C6" s="6"/>')
    expect(sheet).toContain('<c r="C37" s="6"/>')
    // ヘッダー表の値セルは装飾専用セルではない (罫線つきの値セル)。
    expect(sheet).toContain('<c r="C2" s="4" t="inlineStr">')
  })

  it('レイアウトが返したすべてのセルが、sheet1.xml に過不足なく出力される', async () => {
    await explains('`sheet1.xml` のセルの出力のテストです。レイアウトが返したセルのすべてが `sheet1.xml` に出力され、セルの数がレイアウトの数と一致することを確認します。')
    const sheet = entryText(await writeTwoImageWorkbook(), 'xl/worksheets/sheet1.xml')
    const cells = twoImageLayout().rows.flatMap(row => row.cells)

    for (const cell of cells) {
      const reference = `${String.fromCodePoint(0x40 + cell.column)}${cell.row.toString()}`
      expect(sheet, `${reference} が sheet1.xml に無い`).toContain(`<c r="${reference}" s=`)
    }
    // 余分なセルも出ていないこと (layout に無いセルが混在すると帯の書式が崩れる)。
    expect(sheet.match(/<c r="/g)).toHaveLength(cells.length)
  })

  it('drawing1.xml の cNvPr の id は一意で、注記の数だけ図形が出力される', async () => {
    await explains('`drawing1.xml` の要素のテストです。グループ 1 つ・画像 2 枚・注記 2 件を書き出した場合に、`cNvPr` の `id` が 5 件とも異なり、`sp` が注記の数、`pic` が 2 件、グレーの枠が 2 件になることを確認します。')
    const drawing = entryText(await writeTwoImageWorkbook(), 'xl/drawings/drawing1.xml')
    const ids = drawing.matchAll(/<xdr:cNvPr id="(\d+)"/g).map(match => match[1]).toArray()

    // グループ 1 + 画像 2 枚 + 注記 2 件。id が重複すると Excel が修復を要求する。
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(ids.length)
    expect(drawing.match(/<xdr:sp>/g)).toHaveLength(FORMAT_CASE_ANNOTATIONS.length)
    expect(drawing.match(/<xdr:pic>/g)).toHaveLength(2)
    // 画像 1 枚につき 1 本のグレー枠。
    expect(drawing.match(/<a:srgbClr val="BFBFBF"\/>/g)).toHaveLength(2)
  })
})

describe('writeEvidenceWorkbook — skip 分類', () => {
  it('存在しないファイルは、除外理由 not-found として除外する', async () => {
    await explains('除外の分類のテストです。存在しない画像のパスを含めた場合に、`skipped` に理由 `not-found` でそのパスだけが含まれることを確認します。')
    const out = outPath()
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), missingItem('missing.png')], out)
    expect(result.skipped).toStrictEqual([
      { path: workDirectory('missing.png'), reason: 'not-found' },
    ])
  })

  it('ディレクトリを指定すると、除外理由 unreadable として除外する', async () => {
    await explains('除外の分類のテストです。画像のパスにディレクトリを指定した場合に、`skipped` に理由 `unreadable` でそのパスだけが含まれることを確認します。')
    const directoryPath = workDirectory('shots')
    mkdirSync(directoryPath)
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(directoryPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: directoryPath, reason: 'unreadable' }])
  })

  it('PNG でも JPEG でもないファイルは、除外理由 unsupported-format として除外する', async () => {
    await explains('除外の分類のテストです。画像ではないテキストのファイルを指定した場合に、`skipped` に理由 `unsupported-format` でそのパスだけが含まれることを確認します。')
    const textPath = place('note.png', Buffer.from('これは画像ではありません', 'utf8'))
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(textPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: textPath, reason: 'unsupported-format' }])
  })

  it('先頭の署名だけに切り詰めた PNG は、除外理由 unreadable として除外する', async () => {
    await explains('除外の分類のテストです。PNG の署名だけに切り詰めたファイルを指定した場合に、`skipped` に理由 `unreadable` でそのパスだけが含まれることを確認します。')
    const truncatedPath = place('cut.png', buildTruncatedPng())
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(truncatedPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: truncatedPath, reason: 'unreadable' }])
  })

  it('除外した項目が混在する場合は、有効な項目だけで No. と media を採番し直す', async () => {
    await explains('一部の画像を除外する場合の、`writeEvidenceWorkbook` のテストです。存在しない画像・形式が不正な画像・ディレクトリを含めた場合に、除外理由が順に並び、有効な 1 枚が `No.1` になり、媒体と画像が 1 件になることを確認します。')
    const directoryPath = workDirectory('shots')
    mkdirSync(directoryPath)
    const out = outPath()

    const result = await writeItems([
      missingItem('missing.png', '不在'),
      placedItem('valid.png', buildPng(320, 240), '有効な 1 枚'),
      placedItem('note.png', Buffer.from('text', 'utf8'), '偽 png'),
      item(directoryPath, 'ディレクトリ'),
    ], out)

    expect(result.items).toBe(1)
    expect(result.skipped.map(entry => entry.reason)).toStrictEqual([
      'not-found',
      'unsupported-format',
      'unreadable',
    ])

    const entries = await readZipEntries(out)
    const sheet = entryText(entries, 'xl/worksheets/sheet1.xml')
    // 除外された item の番号を飛ばさず、有効 item が No.1 になる。
    expect(sheet).toContain('<t>No.1 有効な 1 枚</t>')
    expect(sheet).not.toContain('No.2')
    expect(entries.keys().filter(name => name.startsWith('xl/media/')).toArray()).toStrictEqual([
      'xl/media/image1.png',
    ])
    expect(entryText(entries, 'xl/drawings/drawing1.xml').match(/<xdr:pic>/g)).toHaveLength(1)
  })
})

describe('writeEvidenceWorkbook — 失敗ルート', () => {
  it('有効な画像が 0 件の場合は、書き出さず、既存の出力先を残す', async () => {
    await explains('有効な画像が 1 枚もない場合の、`writeEvidenceWorkbook` のテストです。存在しない画像だけを渡した場合に、理由 `no-valid-images` の `EvidenceWorkbookError` が発生し、既存の出力先のファイルが変更されないことを確認します。')
    const out = outPath()
    const existing = Buffer.from('既存の xlsx 相当のバイト列', 'utf8')
    writeFileSync(out, existing)

    await expect(writeItems([
      missingItem('missing1.png'),
      missingItem('missing2.png'),
    ], out)).rejects.toMatchObject({
      name: 'EvidenceWorkbookError',
      reason: 'no-valid-images',
    })

    // truncate されておらず、上書きもされていないこと。
    expect(readFileSync(out).equals(existing)).toBe(true)
  })

  it('書き込めない出力先を指定すると、output-write-failed のエラーになる', async () => {
    await explains('書き込めない出力先の、`writeEvidenceWorkbook` のテストです。存在しないディレクトリの下を出力先とした場合に、理由 `output-write-failed` の `EvidenceWorkbookError` が発生することを確認します。')
    const out = workDirectory('no-such-directory', 'evidence.xlsx')
    let caught: unknown
    try {
      await writeItems([placedItem('01.png', buildPng(100, 100))], out)
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EvidenceWorkbookError)
    expect(caught).toMatchObject({ reason: 'output-write-failed' })
  })
})
