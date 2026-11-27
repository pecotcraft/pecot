// ooxml.ts の期待値は「実機 (LibreOffice Calc) が修復なしに開けた形」を pin する。
// sharedStrings / theme / twoCellAnchor を使わない。
// そのため Excel の出力とは、要素構成が 1:1 にならない。
//
// styles.xml は書式そのものが製品仕様なので、色・罫線・行高・列幅を具体値で pin する。
// 「count と実子要素数が合う」「border は全辺を順序どおり持つ」のような決まりがある。
// これらは値ではなく構造の側の決まりなので、リテラルの比較とは別に構造として確かめる。
// リテラルだけだと、定義を足したときにどこが外れたのか読めない。

import { describe, expect, it } from 'vitest'

import type { Annotation, NormalizedEvidenceItem } from '../spec-schema.js'
import {
  buildEvidenceLayout,
  DISPLAY_WIDTH_PX,
  EMU_PER_PIXEL,
  LABEL_COLUMN_WIDTH_PX,
  ROW_HEIGHT_PX,
  VALUE_COLUMN_WIDTH_PX,
} from '../layout.js'
import {
  buildContentTypesXml,
  buildDrawingRelsXml,
  buildDrawingXml,
  buildRootRelsXml,
  buildSheetRelsXml,
  buildSheetXml,
  buildStylesXml,
  buildWorkbookRelsXml,
  buildWorkbookXml,
  CELL_STYLE_ORDER,
  columnWidth,
  LABEL_COLUMN_WIDTH,
  mediaPartName,
  VALUE_COLUMN_WIDTH,
  XML_DECLARATION,
} from '../ooxml.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_SPREADSHEET_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const NS_DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const DECL = `${XML_DECLARATION}\n`

function item(caption: string): NormalizedEvidenceItem {
  return { imagePath: '/img/01-login.png', caption, annotations: [] }
}

/**
ヘッダー 3 行 (title / 作成日 / 作成者 1 件) + 1920x1080 画像 1 枚のレイアウト。
*/
function singleImageLayout(
  annotations: readonly Annotation[] = [],
): ReturnType<typeof buildEvidenceLayout> {
  return buildEvidenceLayout({
    title: 'ログイン機能 動作確認エビデンス',
    createdDate: '2026-08-17',
    extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
    images: [{
      item: { ...item('ログイン画面を表示'), annotations },
      width: 1920,
      height: 1080,
    }],
  })
}

describe('buildContentTypesXml', () => {
  const HEAD = `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
  // drawing1.xml の Override が無いと LibreOffice は画像を描画しない (実機確認済み)。
  const OVERRIDES
    = `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
      + `</Types>`

  it('画像の形式が png だけの場合は、png の Default だけを宣言する', async () => {
    await explains('xlsx の `[Content_Types].xml` を作成する `buildContentTypesXml` のテストです。画像の形式が `png` だけの場合に、`png` の `Default` だけを宣言し、drawing などの `Override` を含めることを確認します。')
    expect(buildContentTypesXml(['png', 'png'])).toBe(
      `${HEAD}<Default Extension="png" ContentType="image/png"/>${OVERRIDES}`,
    )
  })

  it('画像の形式が jpeg だけの場合は、jpeg の Default だけを宣言する', async () => {
    await explains('xlsx の `[Content_Types].xml` を作成する `buildContentTypesXml` のテストです。画像の形式が `jpeg` だけの場合に、`jpeg` の `Default` だけを宣言することを確認します。')
    expect(buildContentTypesXml(['jpeg'])).toBe(
      `${HEAD}<Default Extension="jpeg" ContentType="image/jpeg"/>${OVERRIDES}`,
    )
  })

  it('画像の形式が混在している場合は、png、jpeg の固定の順に、両方を宣言する', async () => {
    await explains('xlsx の `[Content_Types].xml` を作成する `buildContentTypesXml` のテストです。`jpeg` と `png` を渡した場合に、渡した順によらず、`png`、`jpeg` の順に両方の `Default` を宣言することを確認します。')
    expect(buildContentTypesXml(['jpeg', 'png'])).toBe(
      `${HEAD}<Default Extension="png" ContentType="image/png"/>`
      + `<Default Extension="jpeg" ContentType="image/jpeg"/>${OVERRIDES}`,
    )
  })
})

describe('rels パーツ', () => {
  it('_rels/.rels は、workbook を officeDocument として指す', async () => {
    await explains('xlsx のルートの関係を作成する `buildRootRelsXml` のテストです。`xl/workbook.xml` を、種類が `officeDocument` の関係として指すことを確認します。')
    expect(buildRootRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`,
    )
  })

  it('workbook.xml.rels は、worksheet と styles だけを持ち、theme を持たない', async () => {
    await explains('xlsx の workbook の関係を作成する `buildWorkbookRelsXml` のテストです。`worksheet` と `styles` への関係だけを持ち、`theme` への関係を含まないことを確認します。')
    expect(buildWorkbookRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_OFFICE_REL}/styles" Target="styles.xml"/>`
      + `</Relationships>`,
    )
  })

  it('sheet1.xml.rels は、drawing を相対パスで指す', async () => {
    await explains('xlsx のシートの関係を作成する `buildSheetRelsXml` のテストです。`../drawings/drawing1.xml` を、種類が `drawing` の関係として相対パスで指すことを確認します。')
    expect(buildSheetRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/drawing" Target="../drawings/drawing1.xml"/>`
      + `</Relationships>`,
    )
  })

  it('drawing1.xml.rels は、画像を ../media/ の参照で、渡した順に関係づける', async () => {
    await explains('xlsx の drawing の関係を作成する `buildDrawingRelsXml` のテストです。2 つの画像のパスを渡した場合に、`../media/` を指す関係が渡した順に `rId1` と `rId2` になることを確認します。')
    expect(buildDrawingRelsXml(['xl/media/image1.png', 'xl/media/image2.jpeg'])).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/image" Target="../media/image1.png"/>`
      + `<Relationship Id="rId2" Type="${NS_OFFICE_REL}/image" Target="../media/image2.jpeg"/>`
      + `</Relationships>`,
    )
  })
})

describe('buildWorkbookXml', () => {
  it('シートは 1 枚だけで、name にレイアウトのシート名を使う', async () => {
    await explains('xlsx の `workbook.xml` を作成する `buildWorkbookXml` のテストです。シート名 `Evidence` を渡した場合に、`sheet` が 1 つだけで、`name` がそのシート名になることを確認します。')
    expect(buildWorkbookXml('Evidence')).toBe(
      `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_OFFICE_REL}">`
      + `<sheets><sheet name="Evidence" sheetId="1" r:id="rId1"/></sheets>`
      + `</workbook>`,
    )
  })
})

describe('buildSheetXml', () => {
  it('要素の順序、シートの体裁、列の幅、行の高さ、インライン文字列を、具体的な値どおりに出力する', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。画像が 1 枚のレイアウトを渡した場合に、要素の順序、ページ設定、列の幅、行の高さ、インライン文字列のセルが、想定した XML と一致することを確認します。')
    expect(buildSheetXml(singleImageLayout())).toBe(
      `${DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_OFFICE_REL}">`
      // fitToPage を宣言しないと pageSetup の fitToWidth が無視される。
      + `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`
      + `<dimension ref="B1:C34"/>`
      + `<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="15" customHeight="1"/>`
      // ラベル列 140px + 値列 820px = 960px。和は 1 列 960px のときの幅と一致する。
      + `<cols><col min="2" max="2" width="20" customWidth="1"/>`
      + `<col min="3" max="3" width="117.140625" customWidth="1"/></cols>`
      + `<sheetData>`
      // タイトル帯: C1 は値なしの装飾専用セル (帯を値列まで伸ばす)。B1 と C1 で
      // 書式が違うのは、帯の内側に面する辺の罫線を落としているため。
      + `<row r="1" ht="24" customHeight="1">`
      + `<c r="B1" s="1" t="inlineStr"><is><t>ログイン機能 動作確認エビデンス</t></is></c>`
      + `<c r="C1" s="2"/></row>`
      + `<row r="2" ht="18" customHeight="1"><c r="B2" s="3" t="inlineStr"><is><t>作成日</t></is></c>`
      + `<c r="C2" s="4" t="inlineStr"><is><t>2026-08-17</t></is></c></row>`
      + `<row r="3" ht="18" customHeight="1"><c r="B3" s="3" t="inlineStr"><is><t>作成者</t></is></c>`
      + `<c r="C3" s="4" t="inlineStr"><is><t>K. Hayakawa</t></is></c></row>`
      + `<row r="6" ht="18" customHeight="1">`
      + `<c r="B6" s="5" t="inlineStr"><is><t>No.1 ログイン画面を表示</t></is></c>`
      + `<c r="C6" s="6"/></row>`
      + `</sheetData>`
      // pageMargins / pageSetup は sheetData の後・drawing より前 (CT_Worksheet の sequence)。
      + `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`
      + `<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>`
      + `<drawing r:id="rId1"/>`
      + `</worksheet>`,
    )
  })

  it('extraHeaders がない場合は、ヘッダーが 2 行になり、項目の開始行が 1 行上がる', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。`extraHeaders` が空の場合に、キャプションの行が 6 行目から 5 行目に上がり、`dimension` の終端が `C33` になることを確認します。')
    // 作成者 1 件を持つ上のケースとの差は「3 行目の追加ヘッダーが無い」ことだけ。
    // キャプション行が 6 → 5、dimension の終端が 34 → 33 へ 1 行ぶん上がる。
    const xml = buildSheetXml(buildEvidenceLayout({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [],
      images: [{ item: item('ログイン画面を表示'), width: 1920, height: 1080 }],
    }))

    expect(xml).toContain(`<dimension ref="B1:C33"/>`)
    expect(xml).toContain(
      `<sheetData>`
      + `<row r="1" ht="24" customHeight="1">`
      + `<c r="B1" s="1" t="inlineStr"><is><t>ログイン機能 動作確認エビデンス</t></is></c>`
      + `<c r="C1" s="2"/></row>`
      + `<row r="2" ht="18" customHeight="1"><c r="B2" s="3" t="inlineStr"><is><t>作成日</t></is></c>`
      + `<c r="C2" s="4" t="inlineStr"><is><t>2026-08-17</t></is></c></row>`
      + `<row r="5" ht="18" customHeight="1">`
      + `<c r="B5" s="5" t="inlineStr"><is><t>No.1 ログイン画面を表示</t></is></c>`
      + `<c r="C5" s="6"/></row>`
      + `</sheetData>`,
    )
  })

  it('extraHeaders は、宣言した順に、3 行目と 4 行目の B 列にラベル、C 列に値として配置する', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。2 件の `extraHeaders` を渡した場合に、3 行目と 4 行目の B 列にラベル、C 列に値を配置し、`dimension` の終端が `C4` になることを確認します。')
    const xml = buildSheetXml(buildEvidenceLayout({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      images: [],
    }))

    // 2 行ぶんを 1 つの literal で見ることで、セル参照・列の対応・行の前後関係を同時に pin する。
    expect(xml).toContain(
      `<row r="3" ht="18" customHeight="1"><c r="B3" s="3" t="inlineStr"><is><t>作成者</t></is></c>`
      + `<c r="C3" s="4" t="inlineStr"><is><t>K. Hayakawa</t></is></c></row>`
      + `<row r="4" ht="18" customHeight="1"><c r="B4" s="3" t="inlineStr"><is><t>環境</t></is></c>`
      + `<c r="C4" s="4" t="inlineStr"><is><t>staging</t></is></c></row>`,
    )
    // ヘッダーだけの layout では追加ヘッダーの最終行が dimension の終端になる。
    expect(xml).toContain(`<dimension ref="B1:C4"/>`)
  })

  it('行は昇順に、同じ行のセルは列の昇順に並べる', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。ヘッダーと画像が 2 枚あるレイアウトを渡した場合に、`row` が昇順に並び、同じ行では B 列のセルが C 列より前に出力されることを確認します。')
    const xml = buildSheetXml(buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [{ label: 'L1', value: 'V1' }, { label: 'L2', value: 'V2' }],
      images: [{ item: item('1 枚目'), width: 800, height: 40 }, { item: item('2 枚目'), width: 800, height: 40 }],
    }))
    const rows = xml.matchAll(/<row r="(\d+)"/g).map(match => Number(match[1])).toArray()
    expect(rows).toStrictEqual([...rows].toSorted((left, right) => left - right))
    expect(rows).toStrictEqual([1, 2, 3, 4, 7, 13])
    expect(xml.indexOf('r="B2"')).toBeLessThan(xml.indexOf('r="C2"'))
  })

  it('すべてのセルが s 属性を持ち、既定の書式のままのセルを作らない', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。出力したすべてのセルが `s` 属性（書式の番号）を持つことを確認します。')
    const xml = buildSheetXml(singleImageLayout())
    const cells = xml.matchAll(/<c r="[A-Z]\d+"([^>/]*)/g).map(match => match[1] ?? '').toArray()

    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(attributes => attributes.includes(' s="'))).toBe(true)
  })

  it('XML の 5 つの特殊文字をエスケープし、値が空のセルは値なしのセルにする', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。タイトルに `&`、`<`、`>`、`"`、`\'` を含む場合に、それぞれエスケープし、値が空の `extraHeaders` は、空の文字列を持たない値なしのセルになることを確認します。')
    const xml = buildSheetXml(buildEvidenceLayout({
      title: `A&B <tag> "q" 'a'`,
      createdDate: '2026-08-17',
      extraHeaders: [{ label: '環境', value: '' }],
      images: [],
    }))
    expect(xml).toContain(`<t>A&amp;B &lt;tag&gt; &quot;q&quot; &apos;a&apos;</t>`)
    // 値が空の extraHeader は値なしセル。罫線つきの空欄として閉じたうえで、
    // ラベルが列幅を超えたときに値列へはみ出せる (空の inline string だと切れる)。
    expect(xml).toContain(`<c r="C3" s="4"/>`)
    expect(xml).not.toContain(`<is><t></t></is>`)
  })

  it('前後に空白がある値には、xml:space="preserve" を付ける', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。値の前後に空白がある場合に、`xml:space="preserve"` を付け、空白がない値には付けないことを確認します。')
    const xml = buildSheetXml(buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [{ label: '担当', value: '  K. Hayakawa  ' }],
      images: [],
    }))
    expect(xml).toContain(`<t xml:space="preserve">  K. Hayakawa  </t>`)
    // 空白を含まない値には付けない。
    expect(xml).toContain(`<t>担当</t>`)
  })

  it('XML 1.0 で表現できない制御文字を取り除き、タブは残す', async () => {
    await explains('シートの XML を作成する `buildSheetXml` のテストです。タイトルに `\\0` などの制御文字が含まれる場合に取り除き、XML 1.0 で表現できるタブは残すことを確認します。')
    const xml = buildSheetXml(buildEvidenceLayout({
      title: ['タイト', '\0', 'ル', '\u{1F}', 'です', '\b'].join(''),
      createdDate: '2026-08-17',
      extraHeaders: [],
      // タブ・改行は XML 1.0 で表現できるため残す。
      images: [{ item: item('キャプ\tション'), width: 800, height: 40 }],
    }))
    expect(xml).toContain(`<t>タイトルです</t>`)
    expect(xml).toContain(`<t>No.1 キャプ\tション</t>`)
  })
})

/**
thin 罫線 1 辺ぶんの XML。
*/
function thinSide(side: string): string {
  return `<${side} style="thin"><color rgb="FF808080"/></${side}>`
}

/**
Excel が列幅 (文字数単位) を px に戻すときの式。
*/
function columnWidthToPixels(width: number): number {
  return Math.trunc(((256 * width + Math.trunc(128 / 7)) / 256) * 7)
}

describe('buildStylesXml', () => {
  const FONT_SUFFIX = `<name val="Yu Gothic"/><family val="3"/><charset val="128"/>`
  const THIN = thinSide
  const ALL_BORDER = `<border>`
    + THIN('left') + THIN('right') + THIN('top') + THIN('bottom')
    + `<diagonal/>`
    + `</border>`
  // 帯の左セルは右辺なし、右セルは左辺なし。2 セルで 1 本の帯に見せるため、片側を抜く。
  const BAND_LEFT_BORDER = `<border>`
    + THIN('left') + `<right/>` + THIN('top') + THIN('bottom')
    + `<diagonal/>`
    + `</border>`
  const BAND_RIGHT_BORDER = `<border>`
    + `<left/>` + THIN('right') + THIN('top') + THIN('bottom')
    + `<diagonal/>`
    + `</border>`

  it('フォント、塗りつぶし、罫線、cellXfs を、具体的な値どおりに出力する', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。フォント、塗りつぶし、罫線、`cellXfs` の定義が、想定した XML と一致することを確認します。')
    expect(buildStylesXml()).toBe(
      `${DECL}<styleSheet xmlns="${NS_MAIN}">`
      + `<fonts count="3">`
      + `<font><sz val="11"/><color rgb="FF000000"/>${FONT_SUFFIX}</font>`
      // タイトルは濃紺の帯に載るので文字は白。
      + `<font><b/><sz val="16"/><color rgb="FFFFFFFF"/>${FONT_SUFFIX}</font>`
      + `<font><b/><sz val="11"/><color rgb="FF000000"/>${FONT_SUFFIX}</font>`
      + `</fonts>`
      // fillId 0 = none / 1 = gray125 は予約。solid の色は fgColor で与える。
      + `<fills count="5">`
      + `<fill><patternFill patternType="none"/></fill>`
      + `<fill><patternFill patternType="gray125"/></fill>`
      + `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>`
      + `<fill><patternFill patternType="solid"><fgColor rgb="FFBDD7EE"/><bgColor indexed="64"/></patternFill></fill>`
      + `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>`
      + `</fills>`
      + `<borders count="4">`
      + `<border><left/><right/><top/><bottom/><diagonal/></border>`
      + ALL_BORDER
      + BAND_LEFT_BORDER
      + BAND_RIGHT_BORDER
      + `</borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
      // cellXfs の並びは既定 xf → CELL_STYLE_ORDER の順。
      + `<cellXfs count="7">`
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
      // タイトル帯の左右。塗りとフォントは同じで borderId だけが違う。
      + `<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="1" fillId="2" borderId="3" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      // value は塗りなし (fillId 0)。ただし罫線は引く。0 件でも表が閉じる。
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="2" fillId="4" borderId="2" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      + `<xf numFmtId="0" fontId="2" fillId="4" borderId="3" xfId="0"`
      + ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
      + `<alignment vertical="center"/></xf>`
      + `</cellXfs>`
      + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
      + `<dxfs count="0"/><tableStyles count="0"/>`
      + `</styleSheet>`,
    )
  })

  it('count 属性を持つすべてのリストで、count が子要素の数と一致する', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。`fonts` や `cellXfs` など、`count` 属性を持つすべてのリストで、宣言した `count` が実際の子要素の数と一致することを確認します。')
    // count と実体がずれると Excel は修復を出さずに書式だけを落とす。数え直しを
    // テスト側でも手で書かず、宣言と実体の突き合わせだけを見る。
    const lists = buildStylesXml().matchAll(
      /<(fonts|fills|borders|cellStyleXfs|cellXfs|cellStyles) count="(\d+)">(.*?)<\/\1>/gs,
    ).toArray()

    expect(lists.map(list => list[1])).toStrictEqual([
      'fonts',
      'fills',
      'borders',
      'cellStyleXfs',
      'cellXfs',
      'cellStyles',
    ])
    for (const list of lists) {
      // 直接の子だけを数える (patternFill / alignment のような孫は接頭辞が一致しない)。
      const children = (list[3] ?? '').matchAll(/<(?:font|fill|border|xf|cellStyle)[ />]/g).toArray()
      expect(children, `${String(list[1])} の count`).toHaveLength(Number(list[2]))
    }
  })

  it('cellXfs の数は、セルの書式の種類の数より、既定の xf の 1 件だけ多い', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。`cellXfs` の `count` が、`CELL_STYLE_ORDER` の要素の数に既定の `xf` の 1 件を加えた値になることを確認します。')
    // index の対応が 1 つずれると、全セルの書式が隣へずれる。
    // CELL_STYLE_ORDER を増減したときに、cellXfs 側が追従していない状態をここで見つける。
    const count = /<cellXfs count="(\d+)">/.exec(buildStylesXml())?.[1]
    expect(Number(count)).toBe(CELL_STYLE_ORDER.length + 1)
  })

  it('CELL_STYLE_ORDER は、cellXfs の並びと対応する順序で、重複や欠落がない', async () => {
    await explains('セルの書式の並びを表す `CELL_STYLE_ORDER` のテストです。要素が `cellXfs` の並びに対応する、想定した順序で並び、重複がないことを確認します。')
    // 並び順が s 属性の値になるため、順序ごとリテラルで pin する。
    // CellStyle を増やしたとき、CELL_XF_DEFINITIONS 側の不足は Record の型が教える。
    // この配列側の不足は、ここで見つかる。
    expect(CELL_STYLE_ORDER).toStrictEqual([
      'titleBandLeft',
      'titleBandRight',
      'label',
      'value',
      'captionBandLeft',
      'captionBandRight',
    ])
    expect(new Set(CELL_STYLE_ORDER).size).toBe(CELL_STYLE_ORDER.length)
  })

  it('border は、すべての辺を left、right、top、bottom、diagonal の順に持つ', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。すべての `border` が、5 つの辺の要素を `left`、`right`、`top`、`bottom`、`diagonal` の順に持つことを確認します。')
    const borders = /<borders count="\d+">(.*?)<\/borders>/s.exec(buildStylesXml())?.[1] ?? ''
    for (const border of borders.matchAll(/<border>(.*?)<\/border>/gs)) {
      const sides = (border[1] ?? '').matchAll(/<(left|right|top|bottom|diagonal)[ />]/g)
        .map(match => match[1]).toArray()
      expect(sides).toStrictEqual(['left', 'right', 'top', 'bottom', 'diagonal'])
    }
  })

  it('帯の左右のセルは、塗りが同じで、内側に面する辺の罫線だけがない', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。タイトルとキャプションの帯の、左右のセルの書式が、フォントと塗りが同じで、内側に面する辺の罫線だけがないことを確認します。')
    // 帯が「罫線で仕切られた 2 セルの表」に見えるかどうかを分ける条件。
    // リテラル pin とは別に、左右の差が borderId だけであることを構造として当てる。
    const cellXfs = /<cellXfs count="\d+">(.*?)<\/cellXfs>/s.exec(buildStylesXml())?.[1] ?? ''
    const borders = /<borders count="\d+">(.*?)<\/borders>/s.exec(buildStylesXml())?.[1] ?? ''
    const xfs = cellXfs.matchAll(/<xf numFmtId="0" fontId="(\d+)" fillId="(\d+)" borderId="(\d+)"/g).toArray()
    const borderList = borders.matchAll(/<border>(.*?)<\/border>/gs).map(match => match[1] ?? '').toArray()

    for (const [leftIndex = 0, rightIndex = 0] of [[1, 2], [5, 6]]) {
      const left = xfs.at(leftIndex)
      const right = xfs.at(rightIndex)
      // フォントと塗りは同一 (帯の見た目が左右で変わらない)。
      expect(left?.[1]).toBe(right?.[1])
      expect(left?.[2]).toBe(right?.[2])
      const leftBorder = borderList.at(Number(left?.[3])) ?? ''
      const rightBorder = borderList.at(Number(right?.[3])) ?? ''
      expect(leftBorder).toContain(`<right/>`)
      expect(leftBorder).toContain(`<left style="thin">`)
      expect(rightBorder).toContain(`<left/>`)
      expect(rightBorder).toContain(`<right style="thin">`)
    }
  })
})

describe('列幅換算', () => {
  it('ラベルの列と値の列の幅の合計が、1 列で 960 ピクセルの幅と一致する', async () => {
    await explains('列の幅の換算のテストです。ラベルの列と値の列の幅の合計が、画像の表示幅の上限（960 ピクセル）の列幅と一致し、帯の右端が画像の右端に揃うことを確認します。')
    // 帯の右端を画像の最大右端に揃える設計の前提。140 が 7 の倍数でないと丸め損失で
    // 和が縮み、帯が画像より狭く出る。
    expect(LABEL_COLUMN_WIDTH + VALUE_COLUMN_WIDTH).toBe(columnWidth(DISPLAY_WIDTH_PX))
    expect(LABEL_COLUMN_WIDTH_PX + VALUE_COLUMN_WIDTH_PX).toBe(DISPLAY_WIDTH_PX)
  })

  it('Excel の逆換算の式でピクセルに戻した場合は、宣言したピクセル数になる', async () => {
    await explains('列の幅の換算のテストです。Excel が列の幅をピクセルへ戻す式で換算した場合に、ラベルの列、値の列、960 ピクセルの列のいずれも、宣言したピクセル数に戻ることを確認します。')
    // 往復で元の px に戻らない幅を選ぶと、宣言値と実際の表示幅がずれる。
    expect(columnWidthToPixels(LABEL_COLUMN_WIDTH)).toBe(LABEL_COLUMN_WIDTH_PX)
    expect(columnWidthToPixels(VALUE_COLUMN_WIDTH)).toBe(VALUE_COLUMN_WIDTH_PX)
    expect(columnWidthToPixels(columnWidth(DISPLAY_WIDTH_PX))).toBe(DISPLAY_WIDTH_PX)
  })
})

describe('buildStylesXml — theme 非依存', () => {
  it('theme を参照せず、色には 8 桁の ARGB だけを使う', async () => {
    await explains('スタイルの XML を作成する `buildStylesXml` のテストです。XML に `theme` の参照を含まず、`rgb` で指定したすべての色が 8 桁の 16 進数であることを確認します。')
    const xml = buildStylesXml()

    // theme1.xml を同梱しないので theme 参照は禁止。
    expect(xml).not.toContain('theme')
    for (const color of xml.matchAll(/<(?:fgColor|color) rgb="([^"]+)"\/>/g)) {
      expect(color[1]).toMatch(/^[0-9A-F]{8}$/)
    }
  })
})

describe('buildDrawingXml', () => {
  it('oneCellAnchor の子要素の順序と EMU を、具体的な値どおりに出力する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` のテストです。注記のない画像が 1 枚の場合に、`oneCellAnchor` の子要素の順序、画像の位置、EMU の大きさ、枠線が、想定した XML と一致することを確認します。')
    expect(buildDrawingXml(singleImageLayout().placements)).toBe(
      `${DECL}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_REL}">`
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="9144000" cy="5143500"/>`
      + `<xdr:pic>`
      + `<xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/>`
      + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      // 画像を囲む 1.5pt のグレー枠。注記の赤枠とは別の定数。
      + `<a:ln w="19050"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:pic>`
      // clientData は省略不可 (欠くと LibreOffice が画像を描画しない)。
      + `<xdr:clientData/>`
      + `</xdr:oneCellAnchor></xdr:wsDr>`,
    )
  })

  it('複数の画像がある場合は、shape の id と rId を、渡した順に重複なく振る', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` のテストです。画像が 2 枚の場合に、`cNvPr` の id が 2 と 3、`r:embed` が `rId1` と `rId2` になり、注記がないため `xdr:sp` を含まないことを確認します。')
    const layout = buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [],
      images: [
        { item: item('1 枚目'), width: 800, height: 600 },
        { item: item('2 枚目'), width: 1920, height: 1080 },
      ],
    })
    const xml = buildDrawingXml(layout.placements)
    expect(xml.matchAll(/<xdr:cNvPr id="(\d+)" name="([^"]+)"\/>/g).map(m => [m[1], m[2]]).toArray())
      .toStrictEqual([['2', 'Picture 1'], ['3', 'Picture 2']])
    expect(xml.matchAll(/r:embed="(rId\d+)"/g).map(m => m[1]).toArray()).toStrictEqual(['rId1', 'rId2'])
    // 注記のない layout では sp を出さない。
    expect(xml).not.toContain('<xdr:sp>')
  })

  it('画像の枠線は、注記の枠線とは別の色にし、画像ごとに 1 本ずつ引く', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` のテストです。画像が 2 枚で、注記が 1 件ある場合に、画像の枠線の色が 2 件、注記の枠線の色が 1 件、別々に出力されることを確認します。')
    const layout = buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [],
      images: [
        { item: item('1 枚目'), width: 800, height: 600 },
        {
          item: { ...item('2 枚目'), annotations: [{ type: 'highlight', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] },
          width: 1920,
          height: 1080,
        },
      ],
    })
    const xml = buildDrawingXml(layout.placements)

    // 画像 2 枚ぶんのグレー枠と、注記 1 件ぶんの赤枠が別々に出る。
    expect(xml.match(/<a:srgbClr val="BFBFBF"\/>/g)).toHaveLength(2)
    expect(xml.match(/<a:srgbClr val="FF0000"\/>/g)).toHaveLength(1)
  })

  it('画像がない場合は、アンカーを持たない wsDr を出力する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` のテストです。画像の配置が空の場合は、子要素を持たない `xdr:wsDr` だけを出力することを確認します。')
    expect(buildDrawingXml([])).toBe(
      `${DECL}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_REL}"></xdr:wsDr>`,
    )
  })
})

describe('buildDrawingXml — 注記図形', () => {
  // 1920x1080 → 960x540。画像と注記は xdr:grpSp 1 つにまとまり、アンカーは col=1 / row=7 の
  // colOff / rowOff = 0。注記はグループ内の a:off (画像左上が原点) で重なる。
  const ANNOTATIONS: readonly Annotation[] = [
    {
      type: 'callout',
      text: 'ログインボタン',
      box: { x: 0.5, y: 0.6, w: 0.3, h: 0.1 },
      anchor: { x: 0.25, y: 0.5 },
    },
    { type: 'highlight', box: { x: 0.1, y: 0.2, w: 0.2, h: 0.15 } },
    { type: 'arrow', from: { x: 0.4, y: 0.6 }, to: { x: 0.25, y: 0.5 } },
  ]

  it('注記付きの画像は、画像と注記を 1 つの grpSp にまとめ、id をグループ、画像、注記の順に振る', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。`callout`、`highlight`、`arrow` を持つ画像を渡した場合に、画像と 3 つの注記を 1 つの `grpSp` にまとめ、図形の XML が想定どおりに一致することを確認します。')
    expect(buildDrawingXml(singleImageLayout(ANNOTATIONS).placements)).toBe(
      `${DECL}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_REL}">`
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="9144000" cy="5143500"/>`
      + `<xdr:grpSp>`
      + `<xdr:nvGrpSpPr><xdr:cNvPr id="2" name="Group 1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>`
      + `<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/>`
      + `<a:chOff x="0" y="0"/><a:chExt cx="9144000" cy="5143500"/></a:xfrm></xdr:grpSpPr>`
      + `<xdr:pic>`
      + `<xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 1"/>`
      + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      + `<a:ln w="19050"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:pic>`
      // callout: box (480,324) 288x54 px。白地 + 2.25pt 赤枠、文言は中央寄せ。
      + `<xdr:sp>`
      // macro / textlink 属性なし・cNvSpPr は空要素 (実機確認済みの最小構成)。
      + `<xdr:nvSpPr><xdr:cNvPr id="4" name="Callout 4"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm><a:off x="4572000" y="3086100"/><a:ext cx="2743200" cy="514350"/></a:xfrm>`
      + `<a:prstGeom prst="wedgeRectCallout"><a:avLst>`
      + `<a:gd name="adj1" fmla="val -133333"/><a:gd name="adj2" fmla="val -150000"/>`
      + `</a:avLst></a:prstGeom>`
      + `<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>`
      + `<a:ln w="28575"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>`
      + `</xdr:spPr>`
      + `<xdr:txBody><a:bodyPr wrap="square" anchor="ctr"/>`
      + `<a:p><a:pPr algn="ctr"/><a:r>`
      + `<a:rPr lang="ja-JP" sz="1100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>`
      + `<a:latin typeface="Yu Gothic"/><a:ea typeface="Yu Gothic"/></a:rPr>`
      + `<a:t>ログインボタン</a:t>`
      + `</a:r></a:p></xdr:txBody>`
      + `</xdr:sp>`
      // highlight: 塗りなし + 2.25pt 赤枠。txBody は持たない。
      + `<xdr:sp>`
      + `<xdr:nvSpPr><xdr:cNvPr id="5" name="Highlight 5"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm><a:off x="914400" y="1028700"/><a:ext cx="1828800" cy="771525"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      + `<a:noFill/>`
      + `<a:ln w="28575"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:sp>`
      // arrow: 左上向きなので flipH / flipV の両方が立つ。矢尻は tailEnd。
      + `<xdr:sp>`
      + `<xdr:nvSpPr><xdr:cNvPr id="6" name="Arrow 6"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm flipH="1" flipV="1"><a:off x="2286000" y="2571750"/><a:ext cx="1371600" cy="514350"/></a:xfrm>`
      + `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
      + `<a:noFill/>`
      + `<a:ln w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`
      + `<a:tailEnd type="triangle" w="lg" len="lg"/></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:sp>`
      + `</xdr:grpSp>`
      + `<xdr:clientData/>`
      + `</xdr:oneCellAnchor>`
      + `</xdr:wsDr>`,
    )
  })

  it('注記付きの drawing では、どのアンカーの colOff も B 列の幅を超えず、rowOff も行の高さを超えない', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。注記付きの画像が 2 枚ある場合に、アンカーの `colOff` が B 列の幅以下で、`rowOff` が行の高さ以下になることを確認します。')
    const layout = buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [],
      images: [
        { item: { ...item('1 枚目'), annotations: ANNOTATIONS }, width: 1920, height: 1080 },
        { item: { ...item('2 枚目'), annotations: ANNOTATIONS }, width: 800, height: 600 },
      ],
    })
    const xml = buildDrawingXml(layout.placements)
    const colOffsets = xml.matchAll(/<xdr:colOff>(\d+)<\/xdr:colOff>/g).map(m => Number(m[1])).toArray()
    const rowOffsets = xml.matchAll(/<xdr:rowOff>(\d+)<\/xdr:rowOff>/g).map(m => Number(m[1])).toArray()

    expect(colOffsets).toHaveLength(2)
    expect(rowOffsets).toHaveLength(2)
    for (const offset of colOffsets) {
      expect(offset).toBeLessThanOrEqual(LABEL_COLUMN_WIDTH_PX * EMU_PER_PIXEL)
    }
    for (const offset of rowOffsets) {
      expect(offset).toBeLessThanOrEqual(ROW_HEIGHT_PX * EMU_PER_PIXEL)
    }
  })

  it('アンカーの ext、グループの ext と chExt、画像の ext が同じ大きさで、chOff が原点になる', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。注記付きの画像の場合に、アンカー、グループ、画像の大きさが同じで、子の座標系の原点 `chOff` が 0 になることを確認します。')
    const xml = buildDrawingXml(singleImageLayout(ANNOTATIONS).placements)
    const size = 'cx="9144000" cy="5143500"'

    expect(xml).toContain(`<xdr:ext ${size}/>`)
    expect(xml).toContain(`<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/>`
      + `<a:chOff x="0" y="0"/><a:chExt ${size}/></a:xfrm></xdr:grpSpPr>`)
    expect(xml).toContain(`<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/></a:xfrm>`)
  })

  it('注記の a:off は、レイアウトで求めた位置（offsetXEmu、offsetYEmu）と一致する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。各注記の `a:off` の値が、レイアウトで求めた `offsetXEmu`、`offsetYEmu` の値と一致することを確認します。')
    const { placements } = singleImageLayout(ANNOTATIONS)
    const xml = buildDrawingXml(placements)
    const offsets = xml.matchAll(/<xdr:sp>.*?<a:off x="(\d+)" y="(\d+)"\/>/g)
      .map(m => [Number(m[1]), Number(m[2])])
      .toArray()

    expect(offsets).toStrictEqual(
      placements[0]?.annotationShapes.map(shape => [shape.offsetXEmu, shape.offsetYEmu]),
    )
  })

  it('注記のない画像は、grpSp を持たず、pic だけをアンカーに配置する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。注記のない画像の場合に、`grpSp` を含まず、`oneCellAnchor` の中に `pic` だけを配置することを確認します。')
    const xml = buildDrawingXml(singleImageLayout([]).placements)

    expect(xml).not.toContain('grpSp')
    expect(xml).toContain('<xdr:oneCellAnchor>')
    expect(xml).toContain('<xdr:cNvPr id="2" name="Picture 1"/>')
  })

  it('theme を参照せず、すべての色を rgb で明示する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。XML に `schemeClr` と `xdr:style` を含まないことを確認します。')
    const xml = buildDrawingXml(singleImageLayout(ANNOTATIONS).placements)

    expect(xml).not.toContain('schemeClr')
    expect(xml).not.toContain('<xdr:style>')
  })

  it('向きが既定の arrow には、flip の属性を出力しない', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。左上から右下へ向かう `arrow` の場合に、`flipH` と `flipV` を出力しないことを確認します。')
    const xml = buildDrawingXml(singleImageLayout([
      { type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.6 } },
    ]).placements)

    expect(xml).toContain('<a:ext cx="3657600" cy="2057400"/></a:xfrm>')
    expect(xml).not.toContain('flip')
  })

  it('callout の文章は、制御文字の除去と、XML のエスケープを両方行う', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。`callout` の文章に `&`、`<`、`>`、`"`、`\'` と制御文字が含まれる場合に、制御文字を取り除き、特殊文字をエスケープして `a:t` に出力することを確認します。')
    const xml = buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: `A&B <tag> "q" 'a'\0`,
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)

    expect(xml).toContain(`<a:t>A&amp;B &lt;tag&gt; &quot;q&quot; &apos;a&apos;</a:t>`)
  })

  it('callout の文章に含まれるタブは、そのまま a:t に残す', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。`callout` の文章にタブが含まれる場合に、取り除かず、そのまま `a:t` に出力することを確認します。')
    const xml = buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: 'ログイン\tボタン',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)

    // タブは XML 1.0 で表現できるため除去対象にしない (spec-schema が弾くのは改行だけ)。
    expect(xml).toContain(`<a:t>ログイン\tボタン</a:t>`)
  })

  it('callout の文章の前後の空白は、xml:space="preserve" で保持する', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。文章の前後に空白がある場合に、`a:t` に `xml:space="preserve"` を付け、空白がない文章には付けないことを確認します。')
    const xml = buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: '  ログインボタン  ',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)

    // inline string の <t> と同じ扱い。付けないと前後の空白が落ちる。
    expect(xml).toContain(`<a:t xml:space="preserve">  ログインボタン  </a:t>`)
    // 空白を含まない文言には付けない。
    expect(buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: 'ログインボタン',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)).toContain(`<a:t>ログインボタン</a:t>`)
  })

  it('複数の画像に注記が付いている場合でも、cNvPr の id が drawing 全体で一意になる', async () => {
    await explains('drawing の XML を作成する `buildDrawingXml` の、注記図形のテストです。注記を持つ画像が 2 枚ある場合は、グループ、画像、注記の `cNvPr` の id が、drawing 全体で重複せず連番になることを確認します。')
    const layout = buildEvidenceLayout({
      title: 'T',
      createdDate: '2026-08-17',
      extraHeaders: [],
      images: [
        {
          item: {
            ...item('1 枚目'),
            annotations: [
              { type: 'highlight', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
              { type: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } },
            ],
          },
          width: 800,
          height: 600,
        },
        {
          item: {
            ...item('2 枚目'),
            annotations: [{
              type: 'callout',
              text: 'ここ',
              box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
              anchor: { x: 0.5, y: 0.5 },
            }],
          },
          width: 1920,
          height: 1080,
        },
      ],
    })
    const xml = buildDrawingXml(layout.placements)

    expect(xml.matchAll(/<xdr:cNvPr id="(\d+)" name="([^"]+)"\/>/g).map(m => [m[1], m[2]]).toArray())
      .toStrictEqual([
        ['2', 'Group 1'],
        ['3', 'Picture 1'],
        ['4', 'Highlight 4'],
        ['5', 'Arrow 5'],
        ['6', 'Group 2'],
        ['7', 'Picture 2'],
        ['8', 'Callout 8'],
      ])
  })
})

describe('mediaPartName', () => {
  it('画像パーツの拡張子は、形式の判定結果に従う', async () => {
    await explains('画像のパーツ名を作成する `mediaPartName` のテストです。番号と形式 `png` や `jpeg` を渡した場合に、`xl/media/image1.png` のように、形式に合った拡張子を付けた名前を返すことを確認します。')
    expect(mediaPartName(1, 'png')).toBe('xl/media/image1.png')
    expect(mediaPartName(2, 'jpeg')).toBe('xl/media/image2.jpeg')
  })
})
