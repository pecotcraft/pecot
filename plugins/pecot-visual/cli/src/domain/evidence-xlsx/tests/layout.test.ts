import { describe, expect, it } from 'vitest'

import type { Annotation, NormalizedEvidenceItem } from '../spec-schema.js'
import type { AnnotationShape, EvidenceLayout, SheetRow } from '../layout.js'
import {
  buildEvidenceLayout,
  CAPTION_GAP_ROWS,
  DISPLAY_WIDTH_PX,
  EMU_PER_PIXEL,
  LABEL_COLUMN,
  SHEET_NAME,
  VALUE_COLUMN,
} from '../layout.js'

function item(caption: string, imagePath = '/img/shot.png'): NormalizedEvidenceItem {
  return { imagePath, caption, annotations: [] }
}

function image(width: number, height: number, caption = 'キャプション'): {
  readonly item: NormalizedEvidenceItem
  readonly width: number
  readonly height: number
} {
  return { item: item(caption), width, height }
}

const HEADER = { title: 'ログイン機能 動作確認エビデンス', createdDate: '2026-08-17' }

/**
行番号で 1 行を取り出す (未存在は明示的に失敗させる)。
*/
function rowAt(layout: Readonly<EvidenceLayout>, row: number): SheetRow {
  const found = layout.rows.find(entry => entry.row === row)
  if (found === undefined) throw new Error(`行 ${row.toString()} がありません`)
  return found
}

/**
キャプション帯の行だけを行番号で拾う。
*/
function captionRowNumbers(layout: Readonly<EvidenceLayout>): readonly number[] {
  return layout.rows
    .filter(row => row.cells.some(cell => cell.style === 'captionBandLeft'))
    .map(row => row.row)
}

describe('buildEvidenceLayout — ヘッダー行割付', () => {
  it('行 1 = タイトル帯 / 行 2 = 作成日 / 行 3〜 = extraHeaders', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: '' },
      ],
      images: [],
    })

    expect(layout.sheetName).toBe(SHEET_NAME)
    expect(layout.rows).toStrictEqual([
      {
        row: 1,
        heightPoints: 24,
        cells: [
          { row: 1, column: LABEL_COLUMN, text: 'ログイン機能 動作確認エビデンス', style: 'titleBandLeft' },
          // 帯を値列まで伸ばす装飾専用セル。値を持たせるとタイトルの右はみ出しが死ぬ。
          // 書式が左と別なのは帯の内側に面する辺の罫線を落としているため。
          { row: 1, column: VALUE_COLUMN, text: undefined, style: 'titleBandRight' },
        ],
      },
      {
        row: 2,
        heightPoints: 18,
        cells: [
          { row: 2, column: LABEL_COLUMN, text: '作成日', style: 'label' },
          { row: 2, column: VALUE_COLUMN, text: '2026-08-17', style: 'value' },
        ],
      },
      {
        row: 3,
        heightPoints: 18,
        cells: [
          { row: 3, column: LABEL_COLUMN, text: '作成者', style: 'label' },
          { row: 3, column: VALUE_COLUMN, text: 'K. Hayakawa', style: 'value' },
        ],
      },
      {
        row: 4,
        heightPoints: 18,
        cells: [
          { row: 4, column: LABEL_COLUMN, text: '環境', style: 'label' },
          // 値が空のときは値なしセル。罫線つきの空欄として閉じたうえで、長いラベルが
          // 値列へはみ出して読める (空文字を入れるとはみ出せずに切れる)。
          { row: 4, column: VALUE_COLUMN, text: undefined, style: 'value' },
        ],
      },
    ])
    // item が 0 件でも lastRow はヘッダー最終行まで伸びる。
    expect(layout.lastRow).toBe(4)
    expect(layout.placements).toStrictEqual([])
  })

  it('extraHeaders 0 件なら、ヘッダー行は 2 行で lastRow は 2', () => {
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [] })

    expect(layout.rows.map(row => row.row)).toStrictEqual([1, 2])
    expect(layout.lastRow).toBe(2)
  })
})

describe('buildEvidenceLayout — 帯と行高', () => {
  it('キャプション行は caption 書式の 2 セルで帯になる', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [],
      images: [image(800, 600, 'ログイン画面を表示')],
    })

    expect(rowAt(layout, 5)).toStrictEqual({
      row: 5,
      heightPoints: 18,
      cells: [
        { row: 5, column: LABEL_COLUMN, text: 'No.1 ログイン画面を表示', style: 'captionBandLeft' },
        { row: 5, column: VALUE_COLUMN, text: undefined, style: 'captionBandRight' },
      ],
    })
  })

  it('タイトル帯だけ行高が高く、他の行は共通の帯行高になる', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      images: [image(800, 600)],
    })

    expect(layout.rows.map(row => [row.row, row.heightPoints])).toStrictEqual([
      [1, 24],
      [2, 18],
      [3, 18],
      [6, 18],
    ])
  })

  it('帯の装飾専用セルはタイトルとキャプションだけで、ヘッダー表の値は持たない', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [{ label: '環境', value: 'staging' }],
      images: [image(800, 600)],
    })

    const valueless = layout.rows
      .flatMap(row => row.cells)
      .filter(cell => cell.text === undefined)
    expect(valueless.map(cell => [cell.row, cell.style]))
      .toStrictEqual([[1, 'titleBandRight'], [6, 'captionBandRight']])
    expect(valueless.every(cell => cell.column === VALUE_COLUMN)).toBe(true)
  })
})

describe('buildEvidenceLayout — 縮小と EMU', () => {
  it('1920x1080 は 960x540 へ縮小され ext は px × 9525', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      images: [image(1920, 1080, 'ログイン画面を表示')],
    })

    const placement = layout.placements[0]
    expect(placement?.index).toBe(1)
    // ヘッダー最終行 3 + ITEM_GAP_ROWS 2 → キャプションは 1-based の 6 行。
    expect(captionRowNumbers(layout)).toStrictEqual([6])
    expect(rowAt(layout, 6).cells[0]?.text).toBe('No.1 ログイン画面を表示')
    // キャプション行 (1-based 6) の直下 = 0-based で 6。CAPTION_GAP_ROWS の
    // 空行を挟むので画像は 1 行下の 0-based 7 から始まる。
    expect(placement?.anchor).toStrictEqual({
      column: 1,
      row: 7,
      displayWidthPx: 960,
      displayHeightPx: 540,
      widthEmu: 9_144_000,
      heightEmu: 5_143_500,
    })
    expect(placement?.occupiedRows).toBe(27)
    expect(layout.lastRow).toBe(34)
  })

  it('960 以下は原寸のまま（拡大しない）', () => {
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(800, 600)] })

    expect(layout.placements[0]?.anchor).toStrictEqual({
      column: 1,
      row: 6,
      displayWidthPx: 800,
      displayHeightPx: 600,
      widthEmu: 800 * EMU_PER_PIXEL,
      heightEmu: 600 * EMU_PER_PIXEL,
    })
    expect(layout.placements[0]?.occupiedRows).toBe(30)
    expect(layout.lastRow).toBe(36)
  })

  it('キャプション行と画像の間に空行が 1 行入る', () => {
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(800, 600)] })
    const placement = layout.placements[0]

    // 0-based の anchor.row を 1-based に直すと画像の開始行。キャプション行との差は
    // 空行 1 行ぶんを含めて 2。実装定数ではなくリテラルで pin することで、
    // 空行を落とす変更 (差が 1 に戻る) をこのテストで捕まえる。
    const imageStartRow = (placement?.anchor.row ?? 0) + 1
    expect(imageStartRow - (captionRowNumbers(layout)[0] ?? 0)).toBe(2)
  })

  it('幅 960 は縮小境界の内側で原寸・961 は縮小される', () => {
    const atLimit = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(960, 100)] })
    expect(atLimit.placements[0]?.anchor.displayWidthPx).toBe(960)
    expect(atLimit.placements[0]?.anchor.displayHeightPx).toBe(100)

    const overLimit = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(961, 961)] })
    expect(overLimit.placements[0]?.anchor.displayWidthPx).toBe(960)
    expect(overLimit.placements[0]?.anchor.displayHeightPx).toBe(960)
  })

  it('非整数スケール (1000x333) は表示 px を Math.round してから EMU 換算する', () => {
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(1000, 333)] })

    // scale = 0.96 → 333 * 0.96 = 319.68 → 320 px
    expect(layout.placements[0]?.anchor.displayHeightPx).toBe(320)
    expect(layout.placements[0]?.anchor.heightEmu).toBe(3_048_000)
    expect(layout.placements[0]?.occupiedRows).toBe(16)
  })

  it('占有行数は表示高の ceil (540 → 27 / 541 → 28)', () => {
    const exact = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(800, 540)] })
    expect(exact.placements[0]?.occupiedRows).toBe(27)

    const remainder = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(800, 541)] })
    expect(remainder.placements[0]?.occupiedRows).toBe(28)
  })
})

/**
注記付き画像 1 枚だけのレイアウトから、導出された注記図形を取り出す。
*/
function shapesOf(
  annotations: readonly Annotation[],
  width = 1920,
  height = 1080,
): readonly AnnotationShape[] {
  const layout = buildEvidenceLayout({
    ...HEADER,
    extraHeaders: [],
    images: [{
      item: { imagePath: '/img/shot.png', caption: 'キャプション', annotations },
      width,
      height,
    }],
  })
  return layout.placements[0]?.annotationShapes ?? []
}

describe('buildEvidenceLayout — 注記図形の導出', () => {
  it('3 種の注記を spec の並び順で縮小後の表示 px へ写す', () => {
    // 1920x1080 → 960x540。相対座標は縮小後の表示 px に掛かる。
    const shapes = shapesOf([
      {
        type: 'callout',
        text: 'ログインボタン',
        box: { x: 0.5, y: 0.6, w: 0.3, h: 0.1 },
        anchor: { x: 0.25, y: 0.5 },
      },
      { type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } },
      { type: 'arrow', from: { x: 0.25, y: 0.5 }, to: { x: 0.4, y: 0.6 } },
    ])

    expect(shapes).toStrictEqual([
      {
        kind: 'callout',
        text: 'ログインボタン',
        // box = (480, 324) 288x54 px。中心 (624, 351) から anchor (240, 270) への
        // ずれを box 辺長の 1/100000 で表す。
        adj1: -133_333,
        adj2: -150_000,
        offsetXEmu: 480 * EMU_PER_PIXEL,
        offsetYEmu: 324 * EMU_PER_PIXEL,
        widthEmu: 288 * EMU_PER_PIXEL,
        heightEmu: 54 * EMU_PER_PIXEL,
      },
      {
        kind: 'highlight',
        offsetXEmu: 96 * EMU_PER_PIXEL,
        offsetYEmu: 108 * EMU_PER_PIXEL,
        widthEmu: 192 * EMU_PER_PIXEL,
        heightEmu: 81 * EMU_PER_PIXEL,
      },
      {
        kind: 'arrow',
        flipH: false,
        flipV: false,
        offsetXEmu: 240 * EMU_PER_PIXEL,
        offsetYEmu: 270 * EMU_PER_PIXEL,
        widthEmu: 144 * EMU_PER_PIXEL,
        heightEmu: 54 * EMU_PER_PIXEL,
      },
    ])
  })

  it('注記なしの item では空配列になる', () => {
    expect(shapesOf([])).toStrictEqual([])
  })

  it('原寸表示 (960 以下) では相対座標がそのまま原寸 px に乗る', () => {
    const shapes = shapesOf([{ type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } }], 800, 600)

    expect(shapes[0]).toStrictEqual({
      kind: 'highlight',
      offsetXEmu: 80 * EMU_PER_PIXEL,
      offsetYEmu: 120 * EMU_PER_PIXEL,
      widthEmu: 160 * EMU_PER_PIXEL,
      heightEmu: 90 * EMU_PER_PIXEL,
    })
  })

  it('画像全面を覆う box は原点 0・画像と同寸になる', () => {
    const shapes = shapesOf([{ type: 'highlight', box: { x: 0, y: 0, w: 1, h: 1 } }])

    expect(shapes[0]).toStrictEqual({
      kind: 'highlight',
      offsetXEmu: 0,
      offsetYEmu: 0,
      widthEmu: 960 * EMU_PER_PIXEL,
      heightEmu: 540 * EMU_PER_PIXEL,
    })
  })

  it('x + w = 1 の box は右端が画像右端と一致する (幅を独立に丸めない)', () => {
    // 左端 100.5 px / 幅 859.5 px。それぞれ丸めると 101 + 860 = 961 px となり
    // 画像右端 (960) を 1 px 超える。
    const shapes = shapesOf([{
      type: 'highlight',
      box: { x: 100.5 / 960, y: 0.1, w: 859.5 / 960, h: 0.1 },
    }])

    expect(shapes[0]?.offsetXEmu).toBe(101 * EMU_PER_PIXEL)
    expect(shapes[0]?.widthEmu).toBe(859 * EMU_PER_PIXEL)
    expect((shapes[0]?.offsetXEmu ?? 0) + (shapes[0]?.widthEmu ?? 0)).toBe(960 * EMU_PER_PIXEL)
  })

  it('box 外を指す anchor でも adj をクランプしない', () => {
    const shapes = shapesOf([{
      type: 'callout',
      text: '遠くを指す',
      box: { x: 0.8, y: 0.8, w: 0.2, h: 0.1 },
      anchor: { x: 0, y: 0 },
    }])

    // box = (768, 432) 192x54 px。中心 (864, 459) から原点までのずれは box 辺長の
    // 4.5 倍 / 8.5 倍にあたる。
    expect(shapes[0]).toMatchObject({ adj1: -450_000, adj2: -850_000 })
  })

  it.each([
    ['右下向き', { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }, false, false],
    ['左下向き', { x: 0.6, y: 0.2 }, { x: 0.2, y: 0.6 }, true, false],
    ['右上向き', { x: 0.2, y: 0.6 }, { x: 0.6, y: 0.2 }, false, true],
    ['左上向き', { x: 0.6, y: 0.6 }, { x: 0.2, y: 0.2 }, true, true],
  ])('arrow %s は同じ位置・寸法で flip だけが変わる', (_label, from, to, flipH, flipV) => {
    const shapes = shapesOf([{ type: 'arrow', from, to }])

    expect(shapes[0]).toStrictEqual({
      kind: 'arrow',
      flipH,
      flipV,
      offsetXEmu: 192 * EMU_PER_PIXEL,
      offsetYEmu: 108 * EMU_PER_PIXEL,
      widthEmu: 384 * EMU_PER_PIXEL,
      heightEmu: 216 * EMU_PER_PIXEL,
    })
  })

  it.each([
    ['右向き', { x: 0.2, y: 0.4 }, { x: 0.6, y: 0.4 }, false],
    ['左向き', { x: 0.6, y: 0.4 }, { x: 0.2, y: 0.4 }, true],
  ])('純水平の arrow %s は高さだけが最小辺にクランプされる', (_label, from, to, flipH) => {
    const shapes = shapesOf([{ type: 'arrow', from, to }])

    expect(shapes[0]).toStrictEqual({
      kind: 'arrow',
      flipH,
      flipV: false,
      offsetXEmu: 192 * EMU_PER_PIXEL,
      offsetYEmu: 216 * EMU_PER_PIXEL,
      widthEmu: 384 * EMU_PER_PIXEL,
      heightEmu: EMU_PER_PIXEL,
    })
  })

  it.each([
    ['下向き', { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.6 }, false],
    ['上向き', { x: 0.4, y: 0.6 }, { x: 0.4, y: 0.2 }, true],
  ])('純垂直の arrow %s は幅だけが最小辺にクランプされる', (_label, from, to, flipV) => {
    const shapes = shapesOf([{ type: 'arrow', from, to }])

    expect(shapes[0]).toStrictEqual({
      kind: 'arrow',
      flipH: false,
      flipV,
      offsetXEmu: 384 * EMU_PER_PIXEL,
      offsetYEmu: 108 * EMU_PER_PIXEL,
      widthEmu: EMU_PER_PIXEL,
      heightEmu: 216 * EMU_PER_PIXEL,
    })
  })

  it('丸めると同じ px となる from / to でも、辺長を 0 にしない', () => {
    // 0.5 と 0.5004 は 960 px 上でどちらも 480 px に丸まる。
    const shapes = shapesOf([{ type: 'arrow', from: { x: 0.5, y: 0.5 }, to: { x: 0.5004, y: 0.5 } }])

    expect(shapes[0]).toStrictEqual({
      kind: 'arrow',
      flipH: false,
      flipV: false,
      offsetXEmu: 480 * EMU_PER_PIXEL,
      offsetYEmu: 270 * EMU_PER_PIXEL,
      widthEmu: EMU_PER_PIXEL,
      heightEmu: EMU_PER_PIXEL,
    })
  })

  it('丸めると潰れる callout の box も辺長 0 にせず adj を有限値に保つ', () => {
    const shapes = shapesOf([{
      type: 'callout',
      text: '極小',
      box: { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 },
      anchor: { x: 0.5, y: 0.5 },
    }])

    expect(shapes[0]).toStrictEqual({
      kind: 'callout',
      text: '極小',
      adj1: -50_000,
      adj2: -50_000,
      offsetXEmu: 480 * EMU_PER_PIXEL,
      offsetYEmu: 270 * EMU_PER_PIXEL,
      widthEmu: EMU_PER_PIXEL,
      heightEmu: EMU_PER_PIXEL,
    })
  })
})

describe('buildEvidenceLayout — 複数項目の行送り', () => {
  it('項目間に ITEM_GAP_ROWS の空行が入り、通し番号は 1 から連番になる', () => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [],
      images: [image(800, 600, '1 枚目'), image(1920, 1080, '2 枚目'), image(800, 600, '3 枚目')],
    })

    expect(layout.placements.map(p => p.index)).toStrictEqual([1, 2, 3])
    expect(captionRowNumbers(layout).map(row => rowAt(layout, row).cells[0]?.text)).toStrictEqual([
      'No.1 1 枚目',
      'No.2 2 枚目',
      'No.3 3 枚目',
    ])
    // 1 枚目は caption 5 / 空行 6 / 画像 7–36。
    // 続けて空行 2 を挟み、2 枚目は caption 39 / 空行 40 / 画像 41–67。
    // さらに空行 2 を挟み、3 枚目は caption 70 / 空行 71 / 画像 72–101。
    expect(captionRowNumbers(layout)).toStrictEqual([5, 39, 70])
    // anchor.row は 0-based なので 1-based の画像開始行より 1 小さい。
    expect(layout.placements.map(p => p.anchor.row)).toStrictEqual([6, 40, 71])
    expect(layout.lastRow).toBe(101)
  })
})

/**
寸法によらず崩れてはいけない性質を、極端な寸法組にまとめて当てる。個別の期待値を
寸法ごとに書き並べると、行割付を変えたときにどれが本質的な退行かが読めなくなる。
*/
describe('buildEvidenceLayout — 寸法によらない不変条件', () => {
  const CASES: readonly (readonly [string, readonly (readonly [number, number])[]])[] = [
    ['1x1 の極小', [[1, 1]]],
    ['縮小境界の内外 959 / 960 / 961', [[959, 400], [960, 400], [961, 400]]],
    ['極端な横長 3840x200', [[3840, 200]]],
    ['極端な縦長 400x3000', [[400, 3000]]],
    ['多件数の混在', [[1920, 1080], [200, 150], [3840, 200], [400, 3000], [1, 1], [960, 960]]],
  ]

  it.each(CASES)('%s: rows は行の昇順・重複なし・各行のセルは列の昇順', (_label, sizes) => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      images: sizes.map(([width, height]) => image(width, height)),
    })

    const rowNumbers = layout.rows.map(row => row.row)
    expect(rowNumbers).toStrictEqual([...rowNumbers].toSorted((left, right) => left - right))
    expect(new Set(rowNumbers).size).toBe(rowNumbers.length)
    for (const row of layout.rows) {
      const columns = row.cells.map(cell => cell.column)
      expect(columns).toStrictEqual([...columns].toSorted((left, right) => left - right))
      // 行に属するセルの row は、必ずその行番号と一致する (ooxml 側は cell.row を参照に使う)。
      expect(row.cells.map(cell => cell.row)).toStrictEqual(columns.map(() => row.row))
      expect(row.heightPoints).toBeGreaterThan(0)
    }
  })

  it.each(CASES)('%s: 占有行区間が単調増加・非重複で lastRow が終端以上', (_label, sizes) => {
    const layout = buildEvidenceLayout({
      ...HEADER,
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      images: sizes.map(([width, height]) => image(width, height)),
    })

    const captionRows = captionRowNumbers(layout)
    expect(captionRows).toHaveLength(sizes.length)
    expect(layout.placements).toHaveLength(sizes.length)

    // ヘッダー最終行 (title + 作成日 + extraHeaders 1 件) より下から項目が始まる。
    let previousEnd = 3
    for (const [offset, placement] of layout.placements.entries()) {
      const captionRow = captionRows.at(offset) ?? 0
      const startRow = placement.anchor.row + 1
      expect(captionRow).toBeGreaterThan(previousEnd)
      expect(startRow).toBe(captionRow + CAPTION_GAP_ROWS + 1)
      expect(placement.occupiedRows).toBeGreaterThanOrEqual(1)
      expect(placement.anchor.displayWidthPx).toBeLessThanOrEqual(DISPLAY_WIDTH_PX)
      previousEnd = startRow + placement.occupiedRows - 1
    }
    expect(layout.lastRow).toBeGreaterThanOrEqual(previousEnd)
  })
})
