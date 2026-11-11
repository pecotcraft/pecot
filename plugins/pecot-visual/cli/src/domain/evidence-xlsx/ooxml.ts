// 生成 xlsx の各パーツ XML を組み立てる純関数群。zip 化とファイル IO は infra の責務。
//
// 文字列連結で組むのは、要素順・属性順まで含めて「修復ダイアログなしに開ける形
// (SC-005)」を実機検証済みの形どおりに固定するため。
//
// 実機検証で必須と判明した点 (欠くと LibreOffice が画像を描画しない / 修復を要求する)。
//   - [Content_Types].xml に drawing1.xml の Override が必要。
//   - styles.xml の fills は先頭 2 件 (none / gray125) が予約。1 件だと読み込みに失敗する。
//   - xdr:oneCellAnchor の子に xdr:clientData が必要 (省略不可)。
//   - xdr:pic に xdr:spPr (a:xfrm + a:prstGeom) が必要。
// theme1.xml は生成しないため、色は theme 参照ではなく rgb 値で明示する。
//
// styles.xml の count 属性は実子要素数から導く (countedList)。
// 手で数えた count は定義を足したときにずれ、Excel が通知なしに書式を落とす欠陥になる。

import type {
  AnnotationShape,
  CalloutShape,
  CellStyle,
  EvidenceLayout,
  ImagePlacement,
  SheetCell,
  SheetRow,
} from './layout.js'
import {
  DEFAULT_ROW_HEIGHT_POINTS,
  LABEL_COLUMN,
  LABEL_COLUMN_WIDTH_PX,
  VALUE_COLUMN,
  VALUE_COLUMN_WIDTH_PX,
} from './layout.js'
import type { ImageFormat } from './image-dimensions.js'
import { NS_CONTENT_TYPES, NS_DRAWINGML, NS_OFFICE_RELATIONSHIPS, NS_PACKAGE_RELATIONSHIPS, NS_SPREADSHEETML, NS_SPREADSHEET_DRAWING } from '../_shared/ooxml-uris.js'

// パーツ名

export const PART_CONTENT_TYPES = '[Content_Types].xml'
export const PART_ROOT_RELS = '_rels/.rels'
export const PART_WORKBOOK = 'xl/workbook.xml'
export const PART_WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
export const PART_SHEET = 'xl/worksheets/sheet1.xml'
export const PART_SHEET_RELS = 'xl/worksheets/_rels/sheet1.xml.rels'
export const PART_STYLES = 'xl/styles.xml'
export const PART_DRAWING = 'xl/drawings/drawing1.xml'
export const PART_DRAWING_RELS = 'xl/drawings/_rels/drawing1.xml.rels'

const MEDIA_DIRECTORY = 'xl/media'

// 名前空間・ContentType・Relationship 種別

const CT_RELATIONSHIPS = 'application/vnd.openxmlformats-package.relationships+xml'
const CT_XML = 'application/xml'
const CT_WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const CT_WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const CT_STYLES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'

const REL_OFFICE_DOCUMENT = `${NS_OFFICE_RELATIONSHIPS}/officeDocument`
const REL_WORKSHEET = `${NS_OFFICE_RELATIONSHIPS}/worksheet`
const REL_STYLES = `${NS_OFFICE_RELATIONSHIPS}/styles`
const REL_DRAWING = `${NS_OFFICE_RELATIONSHIPS}/drawing`
const REL_IMAGE = `${NS_OFFICE_RELATIONSHIPS}/image`

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

interface ImageTypeDescriptor {
  readonly extension: string
  readonly contentType: string
}

/**
画像形式ごとの zip 内拡張子と ContentType。拡張子はシグネチャ判定結果に従う。
*/
const IMAGE_TYPES = {
  png: { extension: 'png', contentType: 'image/png' },
  jpeg: { extension: 'jpeg', contentType: 'image/jpeg' },
} satisfies Readonly<Record<ImageFormat, ImageTypeDescriptor>>

/**
[Content_Types].xml の Default 宣言順を固定するための走査順。
*/
const IMAGE_FORMAT_ORDER: readonly ImageFormat[] = ['png', 'jpeg']

// セル書式 (styles.xml)
//
// fonts / fills / borders / cellXfs はいずれも「名前 → 定義の Record」と
// 「名前の順序付き配列」の 2 本で持つ。
// XML の並びと id (fontId / fillId / borderId / s 属性) の両方を、そこから導く。
// 手で振った index 定数を置くと、配列の途中に 1 件足したとき、型チェックを通ったまま以降の id がずれる。
//
// 背景色は、テスト用フィクスチャ画像の色 (#c82828 / #2850c8 / #28a050 / #e6e6e6) から明確に離した値を選ぶ。
// レンダリング結果の色ヒストグラムで「帯が塗られているか」を見る e2e が、
// 画像の画素と装飾の画素を取り違えないようにするため。

/**
本文フォント。日本語を含むエビデンスの既定として英語フォント名で指定する。
*/
const FONT_NAME = 'Yu Gothic'
/**
FONT_NAME を 11pt で表示したときの「最大幅の数字 1 文字」の px 幅 (96 DPI)。
列幅は px ではなくこの幅を単位とする文字数でしか宣言できないため、columnWidth の
除数はフォントに従属する。値 7 は Excel 既定フォント (Calibri 11pt) のもの。
Yu Gothic 11pt での実値は Excel 実機でしか測れず、本リポの検証環境には Yu Gothic が無いため確認できていない。
FONT_NAME を変えるときは、ここも見直す。
*/
const FONT_DIGIT_WIDTH_PX = 7
/**
CT_Font の family / charset (128 = Shift_JIS)。日本語フォントの解決に要る。

family は 3 (modern)。
Excel が Yu Gothic に対して書き出す font は 2 種あり、charset を持たない側が family 2。
`charset val="128"` を持つ側が family 3 で、ここは後者と同じ形。
LibreOffice では 0〜5 のどれを与えても、代替フォントの選択は変わらない。
Yu Gothic 不在環境で family だけを差し替えて計測すると、埋め込みフォントは同一だった。
*/
const FONT_FAMILY = 3
const FONT_CHARSET = 128
const FONT_SIZE_BODY = 11
const FONT_SIZE_TITLE = 16
/**
styles.xml の色は 8 桁 ARGB (DrawingML の 6 桁 RGB とは別表記)。
*/
const COLOR_TEXT = 'FF000000'
/**
タイトル帯は地色が濃いので文字を白にする。
*/
const COLOR_TITLE_TEXT = 'FFFFFFFF'
/**
タイトル帯の地色 (濃紺)。
*/
const FILL_COLOR_TITLE = 'FF1F4E79'
/**
ヘッダー表のラベル列の地色 (淡青)。
*/
const FILL_COLOR_LABEL = 'FFBDD7EE'
/**
キャプション帯の地色 (淡黄)。
*/
const FILL_COLOR_CAPTION = 'FFFFF2CC'
/**
罫線色 (中間グレー)。
*/
const BORDER_COLOR = 'FF808080'

/**
表示幅 px を列幅 (文字数単位) へ写す。`trunc(px * 256 / 数字幅) / 256` が Excel の丸め。
ラベル列 140px と値列 820px はこの式で 20 / 117.140625 になる。
その和は、1 列 960px のときの 137.140625 と一致する (この関係は unit test で固定してある)。

逆換算の除数はアプリが実フォントから決めるため、代替フォントが当たった環境では
同じ宣言でも px 幅が変わる (LABEL_COLUMN_WIDTH_PX のコメント参照)。
*/
export function columnWidth(pixels: number): number {
  return Math.trunc((pixels * 256) / FONT_DIGIT_WIDTH_PX) / 256
}

export const LABEL_COLUMN_WIDTH = columnWidth(LABEL_COLUMN_WIDTH_PX)
export const VALUE_COLUMN_WIDTH = columnWidth(VALUE_COLUMN_WIDTH_PX)

interface FontDefinition {
  readonly bold: boolean
  readonly sizePoints: number
  readonly color: string
}

type FontName = 'body' | 'title' | 'bold'

const FONT_DEFINITIONS: Readonly<Record<FontName, FontDefinition>> = {
  body: { bold: false, sizePoints: FONT_SIZE_BODY, color: COLOR_TEXT },
  title: { bold: true, sizePoints: FONT_SIZE_TITLE, color: COLOR_TITLE_TEXT },
  bold: { bold: true, sizePoints: FONT_SIZE_BODY, color: COLOR_TEXT },
}

/**
fonts の並び順 = fontId。
*/
const FONT_ORDER: readonly FontName[] = ['body', 'title', 'bold']

type FillName = 'none' | 'gray125' | 'title' | 'label' | 'caption'

const FILL_DEFINITIONS: Readonly<Record<FillName, string>> = {
  none: `<fill><patternFill patternType="none"/></fill>`,
  gray125: `<fill><patternFill patternType="gray125"/></fill>`,
  title: solidFillXml(FILL_COLOR_TITLE),
  label: solidFillXml(FILL_COLOR_LABEL),
  caption: solidFillXml(FILL_COLOR_CAPTION),
}

/**
fills の並び順 = fillId。先頭 2 件 (none / gray125) は予約で、欠くと読み込みに失敗する。
*/
const FILL_ORDER: readonly FillName[] = ['none', 'gray125', 'title', 'label', 'caption']

type BorderSide = 'left' | 'right' | 'top' | 'bottom' | 'diagonal'

/**
border の子要素順。線を引かない辺も空要素で明示する。
*/
const BORDER_SIDES: readonly BorderSide[] = ['left', 'right', 'top', 'bottom', 'diagonal']

type BorderName = 'none' | 'all' | 'bandLeft' | 'bandRight'

/**
borders の定義 = thin を引く辺の集合。対角線は引かないので diagonal は常に含まない。

bandLeft / bandRight は「2 セルで 1 本の帯」を作るための片側抜きで、帯の内側に
面する辺 (左セルの右辺・右セルの左辺) を落とす。両セルに全辺を引くと、帯の中央に
縦罫線が残って帯が 2 分割された表に見える。
*/
const BORDER_DEFINITIONS: Readonly<Record<BorderName, readonly BorderSide[]>> = {
  none: [],
  all: ['left', 'right', 'top', 'bottom'],
  bandLeft: ['left', 'top', 'bottom'],
  bandRight: ['right', 'top', 'bottom'],
}

/**
borders の並び順 = borderId。
*/
const BORDER_ORDER: readonly BorderName[] = ['none', 'all', 'bandLeft', 'bandRight']

/**
cellXfs の先頭に置く既定 xf の数。CellStyle の index はこの後ろに続く。
*/
const BASE_CELL_XF_COUNT = 1

interface CellXfDefinition {
  readonly font: FontName
  readonly fill: FillName
  readonly border: BorderName
}

/**
CellStyle ごとの参照先。Record なので CellStyle を増やすと定義抜けがコンパイルエラーになる。
cellXfs 上の並び順は CELL_STYLE_ORDER が持ち、index は styleIndexOf が配列位置から導く。
*/
const CELL_XF_DEFINITIONS: Readonly<Record<CellStyle, CellXfDefinition>> = {
  titleBandLeft: { font: 'title', fill: 'title', border: 'bandLeft' },
  titleBandRight: { font: 'title', fill: 'title', border: 'bandRight' },
  label: { font: 'bold', fill: 'label', border: 'all' },
  value: { font: 'body', fill: 'none', border: 'all' },
  captionBandLeft: { font: 'bold', fill: 'caption', border: 'bandLeft' },
  captionBandRight: { font: 'bold', fill: 'caption', border: 'bandRight' },
}

/**
cellXfs 上の並び順。既定 xf の後ろにこの順で並び、セルの `s` 属性はこの位置から導く。
CELL_XF_DEFINITIONS との過不足は unit test が比較する。
*/
export const CELL_STYLE_ORDER: readonly CellStyle[] = [
  'titleBandLeft',
  'titleBandRight',
  'label',
  'value',
  'captionBandLeft',
  'captionBandRight',
]

// 印刷設定

/**
印刷余白 (inch)。Excel の既定値。
*/
const PAGE_MARGIN_SIDE = 0.7
const PAGE_MARGIN_VERTICAL = 0.75
const PAGE_MARGIN_HEADER_FOOTER = 0.3
/**
pageSetup の paperSize。9 = A4。
*/
const PAPER_SIZE_A4 = 9

// 図形の既定スタイル (単一の既定のみ・設定不可)
//
// theme1.xml を同梱しないため色はすべて rgb 明示で、`xdr:style` (theme の accent 参照)
// は出力しない。値はいずれも LibreOffice 実機で描画を確認した形。
// DrawingML の色は 6 桁 RGB (styles.xml の 8 桁 ARGB とは別表記)。

/**
画像を囲む枠線の色 (グレー) と幅 (EMU、1.5pt)。注記の赤枠とは意味が別なので
ANNOTATION_LINE_COLOR とは独立に持つ (片方を変えても他方が動かない)。
*/
const PICTURE_BORDER_COLOR = 'BFBFBF'
const PICTURE_BORDER_WIDTH_EMU = 19_050

/**
注記の線色 (赤)。
*/
const ANNOTATION_LINE_COLOR = 'FF0000'
/**
callout の地色 (白)。画像の上でも文字が読めるよう塗り潰す。
*/
const CALLOUT_FILL_COLOR = 'FFFFFF'
/**
callout の文字色 (黒)。
*/
const CALLOUT_TEXT_COLOR = '000000'
/**
callout / highlight の枠線幅 (EMU、2.25pt)。
*/
const ANNOTATION_BORDER_WIDTH_EMU = 28_575
/**
arrow の線幅 (EMU、3pt)。矢尻の大きさは線幅比なので枠線より太くする。
*/
const ARROW_LINE_WIDTH_EMU = 38_100
/**
callout の文字サイズ (1/100 pt)。
*/
const CALLOUT_FONT_SIZE = 1100
/**
最初に振る shape id。0 と 1 は避ける (ドキュメント全体の shape id と衝突させない)。
*/
const FIRST_SHAPE_ID = 2

// media パーツ

/**
画像 N 件目の zip 内パス。拡張子は入力ファイル名ではなくシグネチャ判定結果に従う
(偽装拡張子のまま格納すると Excel が修復ダイアログを出す)。
*/
export function mediaPartName(index: number, format: ImageFormat): string {
  return `${MEDIA_DIRECTORY}/image${index.toString()}.${imageType(format).extension}`
}

// 各パーツ XML

/**
実際に格納する画像形式ぶんだけ Default を宣言する。
*/
export function buildContentTypesXml(formats: readonly ImageFormat[]): string {
  const imageDefaults = IMAGE_FORMAT_ORDER
    .filter(format => formats.includes(format))
    .map(format => defaultTag(imageType(format).extension, imageType(format).contentType))
    .join('')
  return `${XML_DECLARATION}\n<Types xmlns="${NS_CONTENT_TYPES}">`
    + defaultTag('rels', CT_RELATIONSHIPS)
    + defaultTag('xml', CT_XML)
    + imageDefaults
    + overrideTag(PART_WORKBOOK, CT_WORKBOOK)
    + overrideTag(PART_SHEET, CT_WORKSHEET)
    + overrideTag(PART_STYLES, CT_STYLES)
    + overrideTag(PART_DRAWING, CT_DRAWING)
    + `</Types>`
}

export function buildRootRelsXml(): string {
  return relationshipsXml([
    { id: 'rId1', type: REL_OFFICE_DOCUMENT, target: PART_WORKBOOK },
  ])
}

export function buildWorkbookXml(sheetName: string): string {
  return `${XML_DECLARATION}\n<workbook xmlns="${NS_SPREADSHEETML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
    + `<sheets><sheet name="${escapeXml(sanitizeXmlText(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`
    + `</workbook>`
}

export function buildWorkbookRelsXml(): string {
  return relationshipsXml([
    { id: 'rId1', type: REL_WORKSHEET, target: 'worksheets/sheet1.xml' },
    { id: 'rId2', type: REL_STYLES, target: 'styles.xml' },
  ])
}

/**
sheet1.xml。要素順は次の 2 区間に分けて示す。
前半は `sheetPr → dimension → sheetViews → sheetFormatPr → cols`。
後半は `sheetData → pageMargins → pageSetup → drawing`。
この順はスキーマ (CT_Worksheet の sequence) で決まっており、入れ替えると修復対象になる。

`pageSetUpPr/@fitToPage` は pageSetup の fitToWidth を有効にするための宣言で、
欠くと fitToWidth が無視されて印刷が横に割れる。

`sheetFormatPr/@customHeight` は「既定行高を明示指定した」という宣言。付けないと
日本語フォント化で既定行高が自動拡張され、layout の ROW_HEIGHT_PX 前提が崩れる。
*/
export function buildSheetXml(layout: Readonly<EvidenceLayout>): string {
  const dimension = `${columnName(LABEL_COLUMN)}1:${columnName(VALUE_COLUMN)}${layout.lastRow.toString()}`
  return `${XML_DECLARATION}\n<worksheet xmlns="${NS_SPREADSHEETML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
    + `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`
    + `<dimension ref="${dimension}"/>`
    + `<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="${DEFAULT_ROW_HEIGHT_POINTS.toString()}" customHeight="1"/>`
    + `<cols>`
    + colXml(LABEL_COLUMN, LABEL_COLUMN_WIDTH)
    + colXml(VALUE_COLUMN, VALUE_COLUMN_WIDTH)
    + `</cols>`
    + `<sheetData>${buildRowsXml(layout.rows)}</sheetData>`
    + `<pageMargins left="${PAGE_MARGIN_SIDE.toString()}" right="${PAGE_MARGIN_SIDE.toString()}"`
    + ` top="${PAGE_MARGIN_VERTICAL.toString()}" bottom="${PAGE_MARGIN_VERTICAL.toString()}"`
    + ` header="${PAGE_MARGIN_HEADER_FOOTER.toString()}" footer="${PAGE_MARGIN_HEADER_FOOTER.toString()}"/>`
    // fitToHeight="0" は「縦は必要なだけページを使う」。縦長の画像を 1 ページへ押し込まない。
    + `<pageSetup paperSize="${PAPER_SIZE_A4.toString()}" orientation="portrait"`
    + ` fitToWidth="1" fitToHeight="0"/>`
    + `<drawing r:id="rId1"/>`
    + `</worksheet>`
}

function colXml(column: number, width: number): string {
  return `<col min="${column.toString()}" max="${column.toString()}"`
    + ` width="${width.toString()}" customWidth="1"/>`
}

export function buildSheetRelsXml(): string {
  return relationshipsXml([
    { id: 'rId1', type: REL_DRAWING, target: '../drawings/drawing1.xml' },
  ])
}

/**
styles.xml。要素順 `fonts → fills → borders → cellStyleXfs → cellXfs → cellStyles` は
スキーマで決まっている。fills は先頭 2 件 (none / gray125) が予約で、1 件だと
読み込みに失敗する。cellXfs は既定 xf の後ろに CELL_STYLE_ORDER の順で並ぶ。
*/
export function buildStylesXml(): string {
  return `${XML_DECLARATION}\n<styleSheet xmlns="${NS_SPREADSHEETML}">`
    + countedList('fonts', FONT_ORDER.map(name => fontXml(definitionOf(FONT_DEFINITIONS, name))))
    + countedList('fills', FILL_ORDER.map(name => definitionOf(FILL_DEFINITIONS, name)))
    + countedList('borders', BORDER_ORDER.map(name => borderXml(name)))
    + countedList('cellStyleXfs', [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`])
    + countedList('cellXfs', [
      // 既定 xf。どのセルも使わないが、cellStyles の Normal が指す先として必要。
      `<xf numFmtId="0" fontId="${FONT_ORDER.indexOf('body').toString()}"`
      + ` fillId="${FILL_ORDER.indexOf('none').toString()}"`
      + ` borderId="${BORDER_ORDER.indexOf('none').toString()}" xfId="0"/>`,
      ...CELL_STYLE_ORDER.map(style => cellXfXml(definitionOf(CELL_XF_DEFINITIONS, style))),
    ])
    + countedList('cellStyles', [`<cellStyle name="Normal" xfId="0" builtinId="0"/>`])
    + `<dxfs count="0"/><tableStyles count="0"/>`
    + `</styleSheet>`
}

/**
count 属性を実子要素数から導く。手で数えた count は定義を足したときにずれる。
*/
function countedList(tag: string, children: readonly string[]): string {
  return `<${tag} count="${children.length.toString()}">${children.join('')}</${tag}>`
}

/**
`family` / `charset` は日本語フォント名の解決に要る (欠くと代替フォントへ切り替わる)。
*/
function fontXml(font: Readonly<FontDefinition>): string {
  return `<font>${font.bold ? '<b/>' : ''}`
    + `<sz val="${font.sizePoints.toString()}"/><color rgb="${font.color}"/>`
    + `<name val="${FONT_NAME}"/>`
    + `<family val="${FONT_FAMILY.toString()}"/><charset val="${FONT_CHARSET.toString()}"/>`
    + `</font>`
}

/**
solid の塗り色は fgColor で与える (bgColor はパターンの背地で、solid では働かない)。
*/
function solidFillXml(argb: string): string {
  return `<fill><patternFill patternType="solid">`
    + `<fgColor rgb="${argb}"/><bgColor indexed="64"/>`
    + `</patternFill></fill>`
}

/**
全辺を明示する border。線を引く辺だけ thin にし、残りは空要素で出す。
*/
function borderXml(name: BorderName): string {
  const thinSides = new Set(definitionOf(BORDER_DEFINITIONS, name))
  const sides = BORDER_SIDES
    .map(side => (thinSides.has(side)
      ? `<${side} style="thin"><color rgb="${BORDER_COLOR}"/></${side}>`
      : `<${side}/>`))
    .join('')
  return `<border>${sides}</border>`
}

/**
alignment は xf の子要素で、applyAlignment を立てないと無視される。
*/
function cellXfXml(definition: Readonly<CellXfDefinition>): string {
  return `<xf numFmtId="0" fontId="${FONT_ORDER.indexOf(definition.font).toString()}"`
    + ` fillId="${FILL_ORDER.indexOf(definition.fill).toString()}"`
    + ` borderId="${BORDER_ORDER.indexOf(definition.border).toString()}" xfId="0"`
    + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
    + `<alignment vertical="center"/>`
    + `</xf>`
}

/**
drawing1.xml。`r:embed` の rId は placement の並び順で振るため、buildDrawingRelsXml と同じ順で渡す。
*/
export function buildDrawingXml(placements: readonly ImagePlacement[]): string {
  let nextShapeId = FIRST_SHAPE_ID
  const takeShapeId = (): number => {
    const id = nextShapeId
    nextShapeId += 1
    return id
  }
  const anchors = placements.map((placement, offset) => {
    const { anchor } = placement
    const relationshipId = imageRelationshipId(offset)
    let body: string
    if (placement.annotationShapes.length > 0) {
      const groupId = takeShapeId()
      const pictureXml = buildPictureXml(placement, relationshipId, takeShapeId())
      const shapesXml = placement.annotationShapes.map(shape => buildShapeXml(shape, takeShapeId())).join('')
      body = buildGroupXml(placement, groupId, pictureXml, shapesXml)
    }
    else {
      body = buildPictureXml(placement, relationshipId, takeShapeId())
    }
    return anchorXml({
      column: anchor.column,
      row: anchor.row,
      columnOffsetEmu: 0,
      rowOffsetEmu: 0,
      widthEmu: anchor.widthEmu,
      heightEmu: anchor.heightEmu,
    }, body)
  }).join('')
  return `${XML_DECLARATION}\n<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}"`
    + ` xmlns:r="${NS_OFFICE_RELATIONSHIPS}">${anchors}</xdr:wsDr>`
}

/**
画像と注記をまとめる `xdr:grpSp`。子の座標系 (chOff / chExt) は画像の寸法に揃え、
グループ内の座標が EMU のまま画像左上を原点にする。
*/
function buildGroupXml(
  placement: Readonly<ImagePlacement>,
  groupId: number,
  pictureXml: string,
  shapesXml: string,
): string {
  const { widthEmu, heightEmu } = placement.anchor
  const cx = widthEmu.toString()
  const cy = heightEmu.toString()
  return `<xdr:grpSp>`
    + `<xdr:nvGrpSpPr>`
    + `<xdr:cNvPr id="${groupId.toString()}" name="Group ${placement.index.toString()}"/>`
    + `<xdr:cNvGrpSpPr/>`
    + `</xdr:nvGrpSpPr>`
    + `<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/>`
    + `<a:chOff x="0" y="0"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></xdr:grpSpPr>`
    + pictureXml
    + shapesXml
    + `</xdr:grpSp>`
}

/**
oneCellAnchor の開始セルと実寸。
*/
interface AnchorPosition {
  readonly column: number
  readonly row: number
  readonly columnOffsetEmu: number
  readonly rowOffsetEmu: number
  readonly widthEmu: number
  readonly heightEmu: number
}

/**
oneCellAnchor の外枠。clientData は省略不可 (欠くと LibreOffice が図形を描画しない)。
`editAs` は CT_TwoCellAnchor だけが持つ属性なので oneCellAnchor には出さない。
*/
function anchorXml(position: Readonly<AnchorPosition>, body: string): string {
  return `<xdr:oneCellAnchor>`
    + `<xdr:from><xdr:col>${position.column.toString()}</xdr:col>`
    + `<xdr:colOff>${position.columnOffsetEmu.toString()}</xdr:colOff>`
    + `<xdr:row>${position.row.toString()}</xdr:row>`
    + `<xdr:rowOff>${position.rowOffsetEmu.toString()}</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${position.widthEmu.toString()}" cy="${position.heightEmu.toString()}"/>`
    + body
    + `<xdr:clientData/>`
    + `</xdr:oneCellAnchor>`
}

/**
画像 1 件の `xdr:pic`。子要素順 `nvPicPr → blipFill → spPr` はスキーマで決まっている。
`a:ln` は `a:prstGeom` の直後 (spPr 内の順序もスキーマで決まっている)。
*/
function buildPictureXml(
  placement: Readonly<ImagePlacement>,
  relationshipId: string,
  shapeId: number,
): string {
  const { anchor } = placement
  return `<xdr:pic>`
    + `<xdr:nvPicPr>`
    + `<xdr:cNvPr id="${shapeId.toString()}" name="Picture ${placement.index.toString()}"/>`
    + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>`
    + `</xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr>`
    + `<a:xfrm><a:off x="0" y="0"/>`
    + `<a:ext cx="${anchor.widthEmu.toString()}" cy="${anchor.heightEmu.toString()}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:ln w="${PICTURE_BORDER_WIDTH_EMU.toString()}">`
    + `<a:solidFill><a:srgbClr val="${PICTURE_BORDER_COLOR}"/></a:solidFill>`
    + `</a:ln>`
    + `</xdr:spPr>`
    + `</xdr:pic>`
}

/**
注記図形 1 件の `xdr:sp`。macro / textlink 属性なし・`xdr:cNvSpPr` は空要素・
`xdr:style` なしの最小構成で LibreOffice が修復なく描画することを実機確認済み。
*/
function buildShapeXml(shape: Readonly<AnnotationShape>, shapeId: number): string {
  const parts = shapeParts(shape)
  const extent = `<a:ext cx="${shape.widthEmu.toString()}" cy="${shape.heightEmu.toString()}"/>`
  return `<xdr:sp>`
    + `<xdr:nvSpPr>`
    + `<xdr:cNvPr id="${shapeId.toString()}" name="${parts.name} ${shapeId.toString()}"/>`
    + `<xdr:cNvSpPr/>`
    + `</xdr:nvSpPr>`
    + `<xdr:spPr>`
    + `<a:xfrm${parts.transformAttributes}>`
    + `<a:off x="${shape.offsetXEmu.toString()}" y="${shape.offsetYEmu.toString()}"/>${extent}</a:xfrm>`
    + parts.geometry
    + parts.style
    + `</xdr:spPr>`
    + parts.textBody
    + `</xdr:sp>`
}

interface ShapeParts {
  /**
  cNvPr の name の接頭辞。id を後置して drawing 内で一意にする。
  */
  readonly name: string
  /**
  a:xfrm の属性。矢印の向きだけが使い、既定の向きでは属性そのものを出さない。
  */
  readonly transformAttributes: string
  readonly geometry: string
  /**
  spPr 内の塗りと枠線。この順序はスキーマで決まっている。
  */
  readonly style: string
  readonly textBody: string
}

function shapeParts(shape: Readonly<AnnotationShape>): ShapeParts {
  switch (shape.kind) {
    case 'callout': {
      return calloutParts(shape)
    }
    case 'highlight': {
      return {
        name: 'Highlight',
        transformAttributes: '',
        geometry: `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
        // 塗り潰すと下の画像が隠れるので枠線だけにする。
        style: `<a:noFill/>${solidLineXml()}`,
        textBody: '',
      }
    }
    case 'arrow': {
      return {
        name: 'Arrow',
        transformAttributes: `${shape.flipH ? ' flipH="1"' : ''}${shape.flipV ? ' flipV="1"' : ''}`,
        geometry: `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`,
        style: `<a:noFill/>`
          + `<a:ln w="${ARROW_LINE_WIDTH_EMU.toString()}">`
          + `<a:solidFill><a:srgbClr val="${ANNOTATION_LINE_COLOR}"/></a:solidFill>`
          + `<a:tailEnd type="triangle" w="lg" len="lg"/>`
          + `</a:ln>`,
        textBody: '',
      }
    }
  }
}

function calloutParts(shape: Readonly<CalloutShape>): ShapeParts {
  return {
    name: 'Callout',
    transformAttributes: '',
    geometry: `<a:prstGeom prst="wedgeRectCallout"><a:avLst>`
      + `<a:gd name="adj1" fmla="val ${shape.adj1.toString()}"/>`
      + `<a:gd name="adj2" fmla="val ${shape.adj2.toString()}"/>`
      + `</a:avLst></a:prstGeom>`,
    style: `<a:solidFill><a:srgbClr val="${CALLOUT_FILL_COLOR}"/></a:solidFill>`
      + solidLineXml(),
    // 長文は box をはみ出す (縮小せず、内収めもしない)。box の寸法設計は呼び出し側の責務。
    // 書体はセル書式と同じフォントを明示する。theme1.xml を同梱しないので、指定を
    // 省くとここだけアプリ既定フォントになる。和文には a:ea が働くため、latin と両方置く。
    textBody: `<xdr:txBody><a:bodyPr wrap="square" anchor="ctr"/>`
      + `<a:p><a:pPr algn="ctr"/><a:r>`
      + `<a:rPr lang="ja-JP" sz="${CALLOUT_FONT_SIZE.toString()}">`
      + `<a:solidFill><a:srgbClr val="${CALLOUT_TEXT_COLOR}"/></a:solidFill>`
      + `<a:latin typeface="${FONT_NAME}"/><a:ea typeface="${FONT_NAME}"/></a:rPr>`
      // 制御文字除去・エスケープ・空白保持はインライン文字列と同じ扱いにする。
      + textElementXml('a:t', shape.text)
      + `</a:r></a:p></xdr:txBody>`,
  }
}

function solidLineXml(): string {
  return `<a:ln w="${ANNOTATION_BORDER_WIDTH_EMU.toString()}">`
    + `<a:solidFill><a:srgbClr val="${ANNOTATION_LINE_COLOR}"/></a:solidFill>`
    + `</a:ln>`
}

/**
media パーツ名は `xl/media/...`、drawing からの Target は `../media/...` で参照する。
*/
export function buildDrawingRelsXml(mediaParts: readonly string[]): string {
  return relationshipsXml(mediaParts.map((part, offset) => ({
    id: imageRelationshipId(offset),
    type: REL_IMAGE,
    target: `../${part.slice('xl/'.length)}`,
  })))
}

// 補助

function imageType(format: ImageFormat): ImageTypeDescriptor {
  // eslint-disable-next-line security/detect-object-injection -- key は ImageFormat union に限定済み
  return IMAGE_TYPES[format]
}

/**
cellXfs 上の index。CELL_STYLE_ORDER の並び順に既定 xf ぶんを足した位置。
*/
function styleIndexOf(style: CellStyle): number {
  return BASE_CELL_XF_COUNT + CELL_STYLE_ORDER.indexOf(style)
}

/**
名前引きの定義取得。styles.xml の 4 リストで共通に使う。
*/
function definitionOf<Name extends string, Definition>(
  definitions: Readonly<Record<Name, Definition>>,
  name: Name,
): Definition {
  // eslint-disable-next-line security/detect-object-injection -- key は呼び出し側で union に限定済み
  return definitions[name]
}

function imageRelationshipId(offset: number): string {
  return `rId${(offset + 1).toString()}`
}

function defaultTag(extension: string, contentType: string): string {
  return `<Default Extension="${extension}" ContentType="${contentType}"/>`
}

function overrideTag(part: string, contentType: string): string {
  return `<Override PartName="/${part}" ContentType="${contentType}"/>`
}

interface RelationshipEntry {
  readonly id: string
  readonly type: string
  readonly target: string
}

function relationshipsXml(entries: readonly RelationshipEntry[]): string {
  const body = entries
    .map(entry => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"/>`)
    .join('')
  return `${XML_DECLARATION}\n<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">${body}</Relationships>`
}

/**
1-based 列番号を A1 参照の列名にする。統一フォーマットは B / C 列しか使わないので
26 列を超える表記 (AA 以降) は扱わない。
*/
function columnName(column: number): string {
  return String.fromCodePoint(0x40 + column)
}

/**
layout が確定した行順・列順のまま `<row>` を並べる (並べ替えは layout の責務)。
行高は全行で明示し、`customHeight="1"` で自動調整を止める。
*/
function buildRowsXml(rows: readonly SheetRow[]): string {
  return rows
    .map(row => `<row r="${row.row.toString()}" ht="${row.heightPoints.toString()}" customHeight="1">`
      + row.cells.map(cell => buildCellXml(cell)).join('')
      + `</row>`)
    .join('')
}

function buildCellXml(cell: Readonly<SheetCell>): string {
  const reference = `${columnName(cell.column)}${cell.row.toString()}`
  const attributes = `r="${reference}" s="${styleIndexOf(cell.style).toString()}"`
  // 装飾専用セルは値なしの空要素で出す。空文字の inline string を入れると「隣が空でない」
  // 扱いになり、ラベル列の長い文言が列幅で切られて右へはみ出さなくなる。
  return cell.text === undefined ? `<c ${attributes}/>` : `<c ${attributes} t="inlineStr"><is>${textElementXml('t', cell.text)}</is></c>`
}

/**
テキスト要素。inline string の `<t>` と図形の `<a:t>` で扱いを揃えるため 1 か所にまとめる。
前後の空白はデフォルトで落とされるため、落とすと値が変わる場合だけ `xml:space="preserve"` を付ける。
*/
function textElementXml(tag: string, text: string): string {
  const sanitized = sanitizeXmlText(text)
  const preserve = sanitized === sanitized.trim() ? '' : ' xml:space="preserve"'
  return `<${tag}${preserve}>${escapeXml(sanitized)}</${tag}>`
}

// XML 1.0 が表現できない C0 制御文字 (U+0009 タブ・U+000A 改行・U+000D 復帰を除く)。
function isXmlInvalidCharacter(codePoint: number): boolean {
  return codePoint <= 0x1F && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D
}

/**
XML 1.0 で表現できない制御文字を除去する。エスケープでは表現できないため、
残すと出力 xlsx が parse 不能になる (スクリーンショット名へ紛れ込み得る)。
*/
function sanitizeXmlText(text: string): string {
  let sanitized = ''
  for (const character of text) {
    if (!isXmlInvalidCharacter(character.codePointAt(0) ?? 0)) sanitized += character
  }
  return sanitized
}

/**
属性値としても使えるよう 5 文字すべてエスケープする。
*/
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}
