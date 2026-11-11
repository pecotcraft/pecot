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
  it('パーツを固定順で並べ media を無加工格納する', async () => {
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

  it('annotations には有効画像に配置した注記図形の実数を返す', async () => {
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

  it('PNG / JPEG 混在では両方の Default を宣言し拡張子を分ける', async () => {
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

  it('拡張子が偽装されていてもシグネチャ判定の拡張子で格納する', async () => {
    const out = outPath()
    // 中身は JPEG、ファイル名は .png。
    await writeItems([placedItem('fake.png', buildJpeg(100, 50))], out)

    const entries = await readZipEntries(out)
    expect(entries.keys().toArray()).toContain('xl/media/image1.jpeg')
    expect(entries.keys().toArray()).not.toContain('xl/media/image1.png')
  })

  it('同一パスを 2 件並べても dedup せず item 単位で連番になる', async () => {
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

  it('同一 --out へ連続 2 回書いても上書きされる (残骸が混在しない)', async () => {
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
  it('帯の装飾専用セルが期待行に期待の書式で出る', async () => {
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

  it('layout が返した全セルが sheet1.xml に過不足なく現れる', async () => {
    const sheet = entryText(await writeTwoImageWorkbook(), 'xl/worksheets/sheet1.xml')
    const cells = twoImageLayout().rows.flatMap(row => row.cells)

    for (const cell of cells) {
      const reference = `${String.fromCodePoint(0x40 + cell.column)}${cell.row.toString()}`
      expect(sheet, `${reference} が sheet1.xml に無い`).toContain(`<c r="${reference}" s=`)
    }
    // 余分なセルも出ていないこと (layout に無いセルが混在すると帯の書式が崩れる)。
    expect(sheet.match(/<c r="/g)).toHaveLength(cells.length)
  })

  it('drawing1.xml の cNvPr id は一意で、注記の数だけ sp が出る', async () => {
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
  it('ENOENT は not-found', async () => {
    const out = outPath()
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), missingItem('missing.png')], out)
    expect(result.skipped).toStrictEqual([
      { path: workDirectory('missing.png'), reason: 'not-found' },
    ])
  })

  it('ディレクトリ指定 (EISDIR) は unreadable', async () => {
    const directoryPath = workDirectory('shots')
    mkdirSync(directoryPath)
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(directoryPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: directoryPath, reason: 'unreadable' }])
  })

  it('PNG / JPEG いずれのシグネチャでもないものは unsupported-format', async () => {
    const textPath = place('note.png', Buffer.from('これは画像ではありません', 'utf8'))
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(textPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: textPath, reason: 'unsupported-format' }])
  })

  it('シグネチャのみに切り詰めた PNG は unreadable', async () => {
    const truncatedPath = place('cut.png', buildTruncatedPng())
    const result = await writeItems([placedItem('01.png', buildPng(100, 100)), item(truncatedPath)], outPath())
    expect(result.skipped).toStrictEqual([{ path: truncatedPath, reason: 'unreadable' }])
  })

  it('混在入力では skip 後の有効 item だけで No. と media を再採番する', async () => {
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
  it('有効画像 0 件では書き出しに触れず既存 --out を残す', async () => {
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

  it('書き込めない出力先では output-write-failed になる', async () => {
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
