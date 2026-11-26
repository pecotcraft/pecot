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
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('1 行目にタイトルの帯、2 行目に作成日、3 行目以降に extraHeaders の項目を配置する', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、ヘッダー部分のテストです。タイトルと作成日、値が空のものを含む `extraHeaders` を渡した場合に、1 行目から順に行を配置し、最終行が 4 行目になることを確認します。')
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

  it('extraHeaders がない場合は、ヘッダーを 2 行にし、最終行を 2 行目にする', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、ヘッダー部分のテストです。`extraHeaders` が空の場合に、行がタイトルと作成日の 2 行だけになり、`lastRow` が 2 になることを確認します。')
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [] })

    expect(layout.rows.map(row => row.row)).toStrictEqual([1, 2])
    expect(layout.lastRow).toBe(2)
  })
})

describe('buildEvidenceLayout — 帯と行高', () => {
  it('キャプションの行は、キャプション用の書式を持つ 2 つのセルで帯にする', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、帯と行の高さのテストです。画像が 1 枚の場合に、キャプションの行が `No.1` から始まる文章と、値の列まで帯を伸ばす 2 つのセルになることを確認します。')
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

  it('タイトルの帯だけ行の高さを高くし、ほかの行は共通の高さにする', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、帯と行の高さのテストです。タイトルの行が 24 ポイント、そのほかの行が 18 ポイントになることを確認します。')
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

  it('値を持たない装飾用のセルは、タイトルとキャプションの帯だけに配置する', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、帯と行の高さのテストです。文章を持たないセルが、タイトルの帯とキャプションの帯の右側だけにあり、ヘッダーの表には存在しないことを確認します。')
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
  it('幅 1920 の画像は 960 に縮小し、ext の値を、ピクセル数に 9525 を掛けた EMU にする', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。1920x1080 の画像を渡した場合に、960x540 に縮小し、表示の大きさを EMU に換算して、キャプションの行と画像の位置、最終行を求めることを確認します。')
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

  it('幅が 960 以下の画像は、拡大せず、原寸のまま配置する', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。800x600 の画像を渡した場合に、表示の大きさが 800x600 のままで、占有する行数と最終行を求めることを確認します。')
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

  it('キャプションの行と画像の間に、空行を 1 行入れる', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。キャプションの行と画像の開始行の差が 2 になり、間に空行が 1 行入ることを確認します。')
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(800, 600)] })
    const placement = layout.placements[0]

    // 0-based の anchor.row を 1-based に直すと画像の開始行。キャプション行との差は
    // 空行 1 行ぶんを含めて 2。実装定数ではなくリテラルで pin することで、
    // 空行を落とす変更 (差が 1 に戻る) をこのテストで捕まえる。
    const imageStartRow = (placement?.anchor.row ?? 0) + 1
    expect(imageStartRow - (captionRowNumbers(layout)[0] ?? 0)).toBe(2)
  })

  it('幅が 960 の画像は原寸のまま配置し、961 の画像は縮小する', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。幅が 960 の画像は縮小せず、幅が 961 の画像は 960 に縮小することを確認します。')
    const atLimit = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(960, 100)] })
    expect(atLimit.placements[0]?.anchor.displayWidthPx).toBe(960)
    expect(atLimit.placements[0]?.anchor.displayHeightPx).toBe(100)

    const overLimit = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(961, 961)] })
    expect(overLimit.placements[0]?.anchor.displayWidthPx).toBe(960)
    expect(overLimit.placements[0]?.anchor.displayHeightPx).toBe(960)
  })

  it('縮尺が整数にならない画像（1000x333）は、表示の大きさを四捨五入してから EMU に換算する', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。1000x333 の画像の高さが 319.68 になる場合は、320 へ丸めてから EMU へ換算し、占有する行数を求めることを確認します。')
    const layout = buildEvidenceLayout({ ...HEADER, extraHeaders: [], images: [image(1000, 333)] })

    // scale = 0.96 → 333 * 0.96 = 319.68 → 320 px
    expect(layout.placements[0]?.anchor.displayHeightPx).toBe(320)
    expect(layout.placements[0]?.anchor.heightEmu).toBe(3_048_000)
    expect(layout.placements[0]?.occupiedRows).toBe(16)
  })

  it('占有する行数は、表示の高さを行の高さで割って切り上げた値にする', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、縮小と EMU のテストです。高さが 540 の画像は 27 行、高さが 541 の画像は 28 行を占有することを確認します。')
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
  it('3 種類の注記を、定義の順に、縮小後の表示の大きさに合わせた位置へ変換する', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。3 種類の注記を持つ 1920x1080 の画像を渡した場合に、縮小後の 960x540 を基準にした位置と大きさの図形を、定義の順で返すことを確認します。')
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

  it('注記がない項目の場合は、空の配列を返す', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。注記を持たない項目を渡した場合に、注記の図形が空の配列になることを確認します。')
    expect(shapesOf([])).toStrictEqual([])
  })

  it('画像が原寸で表示される場合は、相対座標を原寸のピクセル数に掛けて位置を求める', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。800x600 の画像に `highlight` を指定した場合に、縮小せず、原寸の大きさに相対座標を掛けた位置と大きさを返すことを確認します。')
    const shapes = shapesOf([{ type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } }], 800, 600)

    expect(shapes[0]).toStrictEqual({
      kind: 'highlight',
      offsetXEmu: 80 * EMU_PER_PIXEL,
      offsetYEmu: 120 * EMU_PER_PIXEL,
      widthEmu: 160 * EMU_PER_PIXEL,
      heightEmu: 90 * EMU_PER_PIXEL,
    })
  })

  it('画像の全体を覆う box は、原点が 0 になり、画像と同じ大きさになる', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。画像の全体を覆う `box` を持つ `highlight` を渡した場合に、位置が 0 で、大きさが縮小後の画像と同じになることを確認します。')
    const shapes = shapesOf([{ type: 'highlight', box: { x: 0, y: 0, w: 1, h: 1 } }])

    expect(shapes[0]).toStrictEqual({
      kind: 'highlight',
      offsetXEmu: 0,
      offsetYEmu: 0,
      widthEmu: 960 * EMU_PER_PIXEL,
      heightEmu: 540 * EMU_PER_PIXEL,
    })
  })

  it('x と w の合計が 1 の box は、幅と位置を別々に丸めず、右端を画像の右端に一致させる', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。左端と幅が小数になる `box` で、`x` と `w` の合計が 1 の場合に、左端と幅の合計が画像の幅（960 ピクセル）と一致し、画像からはみ出さないことを確認します。')
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

  it('anchor が box の外を指す場合でも、adj の値を範囲内に収めない', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、注記のテストです。`callout` の `anchor` が `box` の外側を指す場合は、`adj1` と `adj2` が `box` の辺の長さの倍率をそのまま表す値になることを確認します。')
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
  ])('arrow の向き（%s）が変わった場合は、位置と大きさは同じで、flip だけが変わる', async (_label, from, to, flipH, flipV) => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、`arrow` のテストです。始点と終点の位置関係が右下、左下、右上、左上のいずれの場合も、位置と大きさは同じになり、`flipH` と `flipV` だけが向きに合わせて変わることを確認します。')
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
  ])('水平な arrow（%s）は、高さだけを最小の長さにする', async (_label, from, to, flipH) => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、`arrow` のテストです。始点と終点の高さが同じ `arrow` の場合に、高さを最小の長さ（1 EMU）にし、左向きのときだけ `flipH` が `true` になることを確認します。')
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
  ])('垂直な arrow（%s）は、幅だけを最小の長さにする', async (_label, from, to, flipV) => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、`arrow` のテストです。始点と終点の幅が同じ `arrow` の場合に、幅を最小の長さ（1 EMU）にし、上向きのときだけ `flipV` が `true` になることを確認します。')
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

  it('丸めると同じピクセルになる始点と終点でも、arrow の辺の長さを 0 にしない', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、`arrow` のテストです。始点と終点が丸めると同じ位置になる場合でも、幅と高さがどちらも最小の長さ（1 EMU）になり、0 にならないことを確認します。')
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

  it('丸めると潰れる大きさの callout の box でも、辺の長さを 0 にせず、adj を有限の値にする', async () => {
    await explains('画像の上に重ねる注記の図形を求める `buildEvidenceLayout` の、`callout` のテストです。`box` が極端に小さく、丸めると潰れる場合でも、幅と高さを最小の長さ（1 EMU）にし、`adj1` と `adj2` を有限の値にすることを確認します。')
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
  it('項目の間に ITEM_GAP_ROWS の空行を入れ、通し番号を 1 から順に付ける', async () => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、複数の項目のテストです。画像が 3 枚ある場合に、項目の間へ空行を入れ、通し番号を 1 から順に付けて、キャプションと画像の位置、最終行を求めることを確認します。')
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

  it.each(CASES)('%s の場合は、行が昇順で重複せず、各行のセルが列の昇順に並ぶ', async (_label, sizes) => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、画像の大きさによらない条件のテストです。極端な大きさの画像でも、行番号が昇順で重複せず、各行のセルが列の昇順に並び、セルの行番号が所属する行と一致することを確認します。')
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

  it.each(CASES)('%s の場合は、占有する行の区間が重ならずに増えていき、最終行が画像の終わりの行以上になる', async (_label, sizes) => {
    await explains('エビデンスのシートの行と画像の配置を作成する `buildEvidenceLayout` の、画像の大きさによらない条件のテストです。極端な大きさの画像でも、項目ごとの占有する行が重ならずに増え、`lastRow` が最後の画像の終わりの行以上になることを確認します。')
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
