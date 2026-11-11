// 有効画像 (原寸判明済み) の列とヘッダー情報から、シート上の配置を決める純関数。
// 統一フォーマットは単一の既定のみで、利用者からは設定できない。
//
// 入力は「skip 判定を通した有効 item だけ」。除外された item を含めないので、
// 通し番号 (No.<n>) は配列順そのままで欠番が出ない (SC-002)。
//
// シートに出るセル・行高・行順はすべてここで確定させ、ooxml 側は rows をそのまま
// 書き下すだけにする。ooxml 側で行をまとめ直すと、セルの取りこぼしと行順のずれが
// 2 か所に分かれて入り込む。
//
// 座標の基数は 2 系統が混在するため、型コメントで固定する。
//   - SheetCell.row / column は 1-based (sheet1.xml の `row/@r` と A1 参照に直結)。
//   - ImageAnchor.row / column は 0-based (drawing1.xml の `xdr:from/xdr:row` に直結)。
// キャプションを 1-based の n 行に書くと、その直下の行は 0-based で n になる。
// この関係が oneCellAnchor の位置を決めるので、両者をずらして持つ。

import type {
  Annotation,
  ArrowAnnotation,
  CalloutAnnotation,
  HeaderField,
  NormalizedEvidenceItem,
  Rect,
} from './spec-schema.js'

/**
単一シート名。
*/
export const SHEET_NAME = 'Evidence'
/**
画像の最大表示幅 (px)。超える画像は縦横比維持で縮小し、以下は原寸 (FR-005)。
*/
export const DISPLAY_WIDTH_PX = 960
/**
左余白列数。テキスト・画像はこの列数を空けた次の列 (B 列) を起点にする。
*/
export const MARGIN_LEFT_COL = 1
/**
標準行高 (px)。画像が占有する行数の算出に使う。
*/
export const ROW_HEIGHT_PX = 20
/**
既定行高 (pt)。ROW_HEIGHT_PX=20 (96 DPI) が 15 pt に対応する。占有行数の計算と
実際の表示を一致させるため、この 2 値は必ず一緒に変える。
*/
export const DEFAULT_ROW_HEIGHT_POINTS = 15
/**
タイトル帯の行高 (pt)。16 pt の文字が上下に詰まらない高さ。
*/
const TITLE_ROW_HEIGHT_POINTS = 24
/**
ヘッダー表・キャプション帯の行高 (pt)。11 pt の日本語が既定行高に収まらないため上げる。
*/
const BAND_ROW_HEIGHT_POINTS = 18
/**
エビデンス項目間の空行数。ヘッダーと最初の項目の間にも同数入れる。
*/
export const ITEM_GAP_ROWS = 2
/**
キャプション行と画像の間に挟む空行数。11pt 太字の日本語キャプションは既定行高
(ROW_HEIGHT_PX) に収まらず行の下へはみ出して描画されるため、直下に画像を置くと
文字の下半分が覆われる (LibreOffice 計測)。行高を上げてもセル下端揃えのため
重なりが残るので、空行で確実に離す。
*/
export const CAPTION_GAP_ROWS = 1
/**
1 px あたりの EMU。96 DPI 前提 (914400 EMU/inch ÷ 96)。
*/
export const EMU_PER_PIXEL = 9525
/**
注記図形の最小辺 (px)。丸めで幅か高さが 0 になる図形 (純水平・垂直の矢印、
極小の box) は描画されず、callout では adj の除数も 0 になるため下限を設ける。
*/
const MIN_SHAPE_SIZE_PX = 1
/**
wedgeRectCallout の adj1 / adj2 のスケール。box 辺長に対する 1/100000 単位。
*/
const CALLOUT_ADJ_SCALE = 100_000

/**
ラベル・タイトル・キャプション・画像を置く列 (1-based)。MARGIN_LEFT_COL の次の列 = B。
*/
export const LABEL_COLUMN = MARGIN_LEFT_COL + 1
/**
ヘッダーの値を置く列 (1-based) = C。
*/
export const VALUE_COLUMN = LABEL_COLUMN + 1
/**
ラベル列の表示幅 (px)。ヘッダー表のラベルが折り返さずに収まる幅。
*/
export const LABEL_COLUMN_WIDTH_PX = 140
/**
値列の表示幅 (px)。2 列の和を DISPLAY_WIDTH_PX に合わせ、帯の右端を画像の最大右端に
揃える (画像は帯の左端 = ラベル列の左端からアンカーされる)。

ただし列幅は px ではなく文字数単位でしか宣言できない。
px への換算はアプリが「標準スタイルのフォントの数字 1 文字ぶんの幅」で行う (ooxml.ts の FONT_DIGIT_WIDTH_PX)。
この幅が 7px でない環境では、帯の実幅が画像とずれる。
Yu Gothic の無い LibreOffice では代替フォントが当たる。その場合の帯幅は、画像幅の 1.33 倍で出る (150dpi ラスタでの計測)。
列幅の指定手段が文字数単位しかない以上、この依存はレンダラ間で消せない。
Excel 実機 + 実 Yu Gothic での比率は、目視でしか確かめられない。
*/
export const VALUE_COLUMN_WIDTH_PX = DISPLAY_WIDTH_PX - LABEL_COLUMN_WIDTH_PX

/**
作成日ヘッダーのラベル文言。ヘッダー必須項目なので spec からは受け取らない。
*/
const CREATED_DATE_LABEL = '作成日'

/**
帯 1 本を作る左右セルの書式。
*/
interface BandStyles {
  readonly left: CellStyle
  readonly right: CellStyle
}

const TITLE_BAND: BandStyles = { left: 'titleBandLeft', right: 'titleBandRight' }
const CAPTION_BAND: BandStyles = { left: 'captionBandLeft', right: 'captionBandRight' }

/**
セルに与える書式。ooxml 側で styles.xml の cellXfs index に写す。
並び順は cellXfs 上の契約なので、消費側の ooxml.ts が CELL_STYLE_ORDER として持つ。

帯 (タイトル・キャプション) は 2 セルで 1 本に見せるため、帯の内側に面する辺の
罫線を落とした左右 2 種を持つ。左右を 1 種にまとめると帯の中央に縦罫線が残る。
*/
export type CellStyle
  = 'titleBandLeft'
    | 'titleBandRight'
    | 'label'
    | 'value'
    | 'captionBandLeft'
    | 'captionBandRight'

/**
シート上のセル 1 件。row / column はいずれも 1-based。
*/
export interface SheetCell {
  readonly row: number
  readonly column: number
  /**
  セルの値。undefined は値を持たないセルで、ooxml 側が値なしの空要素として書く
  (帯を値列まで伸ばす装飾専用セルと、値が空のヘッダー行の値セルがこれになる)。
  空文字の値を持たせると「隣が空でない」扱いになり、ラベル列の長い文言が列幅で
  切られて右へはみ出さなくなる。
  */
  readonly text: string | undefined
  readonly style: CellStyle
}

/**
シート上の 1 行。cells は列の昇順、rows 自体は行の昇順で並ぶ。
*/
export interface SheetRow {
  readonly row: number
  /**
  行高 (pt)。全行で明示し、フォントによる既定行高の自動拡張を止める。
  */
  readonly heightPoints: number
  readonly cells: readonly SheetCell[]
}

/**
oneCellAnchor 1 件ぶんの開始位置と実寸。
*/
export interface ImageAnchor {
  /**
  `xdr:from/xdr:col` にそのまま入れる 0-based 列番号。
  */
  readonly column: number
  /**
  `xdr:from/xdr:row` にそのまま入れる 0-based 行番号。
  */
  readonly row: number
  /**
  縮小適用後の表示幅 (px、整数)。
  */
  readonly displayWidthPx: number
  /**
  縮小適用後の表示高 (px、整数)。
  */
  readonly displayHeightPx: number
  /**
  `xdr:ext/@cx`。表示 px を整数化した後に EMU 換算した値 (追加丸めなし)。
  */
  readonly widthEmu: number
  /**
  `xdr:ext/@cy`。
  */
  readonly heightEmu: number
}

/**
注記図形 1 件の共通部分。オフセットはグループ内の座標 (画像左上が原点) の EMU で、
`a:off` にそのまま入る。
*/
interface AnnotationShapeBase {
  readonly offsetXEmu: number
  readonly offsetYEmu: number
  /**
  図形実寸 EMU (`xdr:ext` と `a:ext` の双方に入る)。
  */
  readonly widthEmu: number
  readonly heightEmu: number
}

/**
吹き出し。フィールド名は XML の属性・要素名に揃える。
*/
export interface CalloutShape extends AnnotationShapeBase {
  readonly kind: 'callout'
  readonly text: string
  /**
  `wedgeRectCallout` の adj1 (引き出し先の水平位置。box 中心が 0、右が正)。
  */
  readonly adj1: number
  /**
  adj2 (垂直位置。box 中心が 0、下が正)。
  */
  readonly adj2: number
}

/**
強調枠。
*/
export interface HighlightShape extends AnnotationShapeBase {
  readonly kind: 'highlight'
}

/**
矢印。`prst="line"` + 矢尻を from→to のバウンディングボックスに置き、向きを flip で表す。
rot を使うと、LibreOffice の計測で 8 方位中 4 方位の向きが成立しない。
*/
export interface ArrowShape extends AnnotationShapeBase {
  readonly kind: 'arrow'
  readonly flipH: boolean
  readonly flipV: boolean
}

export type AnnotationShape = CalloutShape | HighlightShape | ArrowShape

/**
エビデンス項目 1 件の配置結果。キャプション帯は rows 側に入る。
*/
export interface ImagePlacement {
  /**
  通し番号 (1 始まり)。有効 item に対する連番なので欠番が出ない。
  */
  readonly index: number
  readonly anchor: ImageAnchor
  /**
  画像に重ねる注記図形。spec の annotations と同じ並び順。
  */
  readonly annotationShapes: readonly AnnotationShape[]
  /**
  画像表示高から算出した占有行数。次項目の開始行の決定に使う。
  */
  readonly occupiedRows: number
}

/**
原寸が判明した有効画像 1 件。
*/
export interface EvidenceImageSource {
  readonly item: NormalizedEvidenceItem
  /**
  原寸幅 (px)。
  */
  readonly width: number
  /**
  原寸高 (px)。
  */
  readonly height: number
}

export interface EvidenceLayoutInput {
  readonly title: string
  readonly createdDate: string
  readonly extraHeaders: readonly HeaderField[]
  readonly images: readonly EvidenceImageSource[]
}

export interface EvidenceLayout {
  readonly sheetName: string
  /**
  シートに書く行 (行の昇順)。sheet1.xml の sheetData はこれだけから組む。
  */
  readonly rows: readonly SheetRow[]
  readonly placements: readonly ImagePlacement[]
  /**
  内容がある最終行 (1-based)。dimension ref の終端に使う。
  */
  readonly lastRow: number
}

/**
行割付を決める。行 1 = タイトル帯、行 2 = 作成日、行 3〜 = extraHeaders。
その後は ITEM_GAP_ROWS の空行を挟み、item ごとに
「キャプション帯 → CAPTION_GAP_ROWS の空行 → 画像 → 空行」を積む。

注記の相対座標は縮小後の表示 px を基準に写すので、画像を縮小しても注記は
同じ位置を指す。
*/
export function buildEvidenceLayout(input: Readonly<EvidenceLayoutInput>): EvidenceLayout {
  const rows: SheetRow[] = [
    bandRow(1, TITLE_ROW_HEIGHT_POINTS, input.title, TITLE_BAND),
    labeledRow(2, CREATED_DATE_LABEL, input.createdDate),
  ]
  let nextRow = 3
  for (const header of input.extraHeaders) {
    rows.push(labeledRow(nextRow, header.label, header.value))
    nextRow += 1
  }
  // ヘッダー最終行。item が 0 件でも dimension が縮退しないよう lastRow の初期値にする。
  let lastRow = nextRow - 1
  nextRow += ITEM_GAP_ROWS

  const placements: ImagePlacement[] = []
  for (const [offset, image] of input.images.entries()) {
    const index = offset + 1
    const display = scaleToDisplay(image.width, image.height)
    const occupiedRows = Math.ceil(display.height / ROW_HEIGHT_PX)
    const captionRow = nextRow
    rows.push(bandRow(
      captionRow,
      BAND_ROW_HEIGHT_POINTS,
      `No.${index.toString()} ${image.item.caption}`,
      CAPTION_BAND,
    ))
    placements.push({
      index,
      anchor: {
        column: MARGIN_LEFT_COL,
        // 1-based の captionRow の直下は 0-based で captionRow。そこから
        // CAPTION_GAP_ROWS だけ下げた行を画像の開始行にする。
        row: captionRow + CAPTION_GAP_ROWS,
        displayWidthPx: display.width,
        displayHeightPx: display.height,
        widthEmu: display.width * EMU_PER_PIXEL,
        heightEmu: display.height * EMU_PER_PIXEL,
      },
      annotationShapes: image.item.annotations
        .map(annotation => toAnnotationShape(annotation, display.width, display.height)),
      occupiedRows,
    })
    // 画像は 1-based で captionRow + CAPTION_GAP_ROWS + 1 行目から occupiedRows 行を占める。
    lastRow = captionRow + CAPTION_GAP_ROWS + occupiedRows
    nextRow = lastRow + 1 + ITEM_GAP_ROWS
  }

  return { sheetName: SHEET_NAME, rows, placements, lastRow }
}

/**
ラベル列に文言を置き、値列は装飾専用セルで埋める帯 1 行。2 セルに同じ塗りを与えて
2 列ぶん (= DISPLAY_WIDTH_PX ぶん) の帯にする。罫線だけは左右で別書式にして帯の
内側の辺を落とす (同じ書式にすると B/C 境界に縦線が残る)。mergeCells は使わない —
merge しても各セルへの塗りは要るので、得るものがない。
*/
function bandRow(
  row: number,
  heightPoints: number,
  text: string,
  band: Readonly<BandStyles>,
): SheetRow {
  return {
    row,
    heightPoints,
    cells: [
      { row, column: LABEL_COLUMN, text, style: band.left },
      { row, column: VALUE_COLUMN, text: undefined, style: band.right },
    ],
  }
}

/**
ラベル列 + 値列の表 1 行。
値が空のときは値なしセルにして、ラベルが列幅 (LABEL_COLUMN_WIDTH_PX) を超えても値列へはみ出して読めるようにする。
空文字を入れると「隣が空でない」扱いになるため、はみ出さず、折り返されず、そのまま切れる。

ラベルと値の両方が入っていて、かつラベルが列幅を超える場合は切れる。
行高を全行で明示している (行割付の前提) ので、折り返し (wrapText) は行高を自前で見積もることになる。
そのため折り返しは取らず、既知の制約として許容する。
*/
function labeledRow(row: number, label: string, value: string): SheetRow {
  return {
    row,
    heightPoints: BAND_ROW_HEIGHT_POINTS,
    cells: [
      { row, column: LABEL_COLUMN, text: label, style: 'label' },
      { row, column: VALUE_COLUMN, text: value === '' ? undefined : value, style: 'value' },
    ],
  }
}

/**
DISPLAY_WIDTH_PX 以下へ縦横比維持で縮小した表示寸法 (px) を返す。拡大はしない。

丸めはここ 1 か所だけで行う。表示 px を Math.round で整数化してから EMU / 占有行数を
導出することで、`ext` と占有行数・キャプション行の関係が px 単位で一貫する。
*/
function scaleToDisplay(width: number, height: number): { readonly width: number, readonly height: number } {
  const scale = Math.min(1, DISPLAY_WIDTH_PX / width)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}

/**
表示 px 基準の矩形 (整数 px)。EMU 換算前の中間形。
*/
interface PixelRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function toAnnotationShape(
  annotation: Readonly<Annotation>,
  displayWidthPx: number,
  displayHeightPx: number,
): AnnotationShape {
  switch (annotation.type) {
    case 'callout': {
      return toCalloutShape(annotation, displayWidthPx, displayHeightPx)
    }
    case 'highlight': {
      return {
        kind: 'highlight',
        ...toEmu(toPixelRect(annotation.box, displayWidthPx, displayHeightPx)),
      }
    }
    case 'arrow': {
      return toArrowShape(annotation, displayWidthPx, displayHeightPx)
    }
  }
}

/**
adj1 / adj2 は「box 中心を原点、box の辺長に対する 1/100000」で引き出し先を指す
(LibreOffice 計測)。box の外を指す注記は正当なので ±100000 を超えてもクランプしない。
*/
function toCalloutShape(
  annotation: Readonly<CalloutAnnotation>,
  displayWidthPx: number,
  displayHeightPx: number,
): CalloutShape {
  const box = toPixelRect(annotation.box, displayWidthPx, displayHeightPx)
  const anchorX = Math.round(annotation.anchor.x * displayWidthPx)
  const anchorY = Math.round(annotation.anchor.y * displayHeightPx)
  return {
    kind: 'callout',
    text: annotation.text,
    adj1: Math.round((anchorX - (box.left + box.width / 2)) / box.width * CALLOUT_ADJ_SCALE),
    adj2: Math.round((anchorY - (box.top + box.height / 2)) / box.height * CALLOUT_ADJ_SCALE),
    ...toEmu(box),
  }
}

/**
位置・寸法は from→to の軸平行バウンディングボックス、向きは flipH / flipV。
min / abs で組むので負のオフセットは原理的に発生しない。
*/
function toArrowShape(
  annotation: Readonly<ArrowAnnotation>,
  displayWidthPx: number,
  displayHeightPx: number,
): ArrowShape {
  const fromX = Math.round(annotation.from.x * displayWidthPx)
  const toX = Math.round(annotation.to.x * displayWidthPx)
  const fromY = Math.round(annotation.from.y * displayHeightPx)
  const toY = Math.round(annotation.to.y * displayHeightPx)
  return {
    kind: 'arrow',
    flipH: toX < fromX,
    flipV: toY < fromY,
    ...toEmu({
      left: Math.min(fromX, toX),
      top: Math.min(fromY, toY),
      width: Math.max(Math.abs(toX - fromX), MIN_SHAPE_SIZE_PX),
      height: Math.max(Math.abs(toY - fromY), MIN_SHAPE_SIZE_PX),
    }),
  }
}

/**
相対矩形を表示 px の整数矩形にする。幅は `left` と `right` をそれぞれ丸めた差で
出す。`round(w × W)` を独立に丸めると `x + w = 1` の注記が画像右端を最大 1 px
超えるため、端を一致させるにはこの順序でなければならない。
*/
function toPixelRect(rect: Readonly<Rect>, displayWidthPx: number, displayHeightPx: number): PixelRect {
  const left = Math.round(rect.x * displayWidthPx)
  const top = Math.round(rect.y * displayHeightPx)
  return {
    left,
    top,
    width: Math.max(Math.round((rect.x + rect.w) * displayWidthPx) - left, MIN_SHAPE_SIZE_PX),
    height: Math.max(Math.round((rect.y + rect.h) * displayHeightPx) - top, MIN_SHAPE_SIZE_PX),
  }
}

/**
整数 px の矩形を EMU へ写す。丸めは toPixelRect で済んでいるのでここでは行わない。
*/
function toEmu(rect: Readonly<PixelRect>): AnnotationShapeBase {
  return {
    offsetXEmu: rect.left * EMU_PER_PIXEL,
    offsetYEmu: rect.top * EMU_PER_PIXEL,
    widthEmu: rect.width * EMU_PER_PIXEL,
    heightEmu: rect.height * EMU_PER_PIXEL,
  }
}
