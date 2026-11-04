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
import { buildEvidenceLayout, DISPLAY_WIDTH_PX, LABEL_COLUMN_WIDTH_PX, VALUE_COLUMN_WIDTH_PX } from '../layout.js'
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

  it('png のみでは png の Default だけを宣言する', () => {
    expect(buildContentTypesXml(['png', 'png'])).toBe(
      `${HEAD}<Default Extension="png" ContentType="image/png"/>${OVERRIDES}`,
    )
  })

  it('jpeg のみでは jpeg の Default だけを宣言する', () => {
    expect(buildContentTypesXml(['jpeg'])).toBe(
      `${HEAD}<Default Extension="jpeg" ContentType="image/jpeg"/>${OVERRIDES}`,
    )
  })

  it('混在では png → jpeg の固定順で両方宣言する', () => {
    expect(buildContentTypesXml(['jpeg', 'png'])).toBe(
      `${HEAD}<Default Extension="png" ContentType="image/png"/>`
      + `<Default Extension="jpeg" ContentType="image/jpeg"/>${OVERRIDES}`,
    )
  })
})

describe('rels パーツ', () => {
  it('_rels/.rels は workbook を officeDocument として指す', () => {
    expect(buildRootRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`,
    )
  })

  it('workbook.xml.rels は worksheet と styles を持つ (theme は持たない)', () => {
    expect(buildWorkbookRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_OFFICE_REL}/styles" Target="styles.xml"/>`
      + `</Relationships>`,
    )
  })

  it('sheet1.xml.rels は drawing を相対パスで指す', () => {
    expect(buildSheetRelsXml()).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/drawing" Target="../drawings/drawing1.xml"/>`
      + `</Relationships>`,
    )
  })

  it('drawing1.xml.rels は media を ../media/ 参照で並び順どおり張る', () => {
    expect(buildDrawingRelsXml(['xl/media/image1.png', 'xl/media/image2.jpeg'])).toBe(
      `${DECL}<Relationships xmlns="${NS_PACKAGE_REL}">`
      + `<Relationship Id="rId1" Type="${NS_OFFICE_REL}/image" Target="../media/image1.png"/>`
      + `<Relationship Id="rId2" Type="${NS_OFFICE_REL}/image" Target="../media/image2.jpeg"/>`
      + `</Relationships>`,
    )
  })
})

describe('buildWorkbookXml', () => {
  it('シートは 1 枚だけで name はレイアウトのシート名', () => {
    expect(buildWorkbookXml('Evidence')).toBe(
      `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_OFFICE_REL}">`
      + `<sheets><sheet name="Evidence" sheetId="1" r:id="rId1"/></sheets>`
      + `</workbook>`,
    )
  })
})

describe('buildSheetXml', () => {
  it('要素順・シート体裁・列幅・行高・inline string を具体値で pin する', () => {
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

  it('extraHeaders 0 件ではヘッダーが 2 行になり item 開始行が繰り上がる', () => {
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

  it('extraHeaders は宣言順に行 3・行 4 の B 列 (label) / C 列 (value) へ写る', () => {
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

  it('行は昇順・同一行のセルは列の昇順で並ぶ', () => {
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

  it('すべてのセルが s 属性を持つ (既定書式のままのセルを作らない)', () => {
    const xml = buildSheetXml(singleImageLayout())
    const cells = xml.matchAll(/<c r="[A-Z]\d+"([^>/]*)/g).map(match => match[1] ?? '').toArray()

    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(attributes => attributes.includes(' s="'))).toBe(true)
  })

  it('5 文字のエスケープと空値セルを扱う', () => {
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

  it('前後に空白を持つ値は xml:space="preserve" を付ける', () => {
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

  it('XML 1.0 で表現できない制御文字を除去する', () => {
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

  it('フォント・塗り・罫線・cellXfs を具体値で pin する', () => {
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

  it('count 属性を持つ全リストで count が実子要素数と一致する', () => {
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

  it('cellXfs は既定 xf 1 件ぶんだけ CellStyle より多い', () => {
    // index の対応が 1 つずれると、全セルの書式が隣へずれる。
    // CELL_STYLE_ORDER を増減したときに、cellXfs 側が追従していない状態をここで見つける。
    const count = /<cellXfs count="(\d+)">/.exec(buildStylesXml())?.[1]
    expect(Number(count)).toBe(CELL_STYLE_ORDER.length + 1)
  })

  it('CELL_STYLE_ORDER は cellXfs の並び契約そのもので、重複や欠落がない', () => {
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

  it('border は全辺を left → right → top → bottom → diagonal の順で持つ', () => {
    const borders = /<borders count="\d+">(.*?)<\/borders>/s.exec(buildStylesXml())?.[1] ?? ''
    for (const border of borders.matchAll(/<border>(.*?)<\/border>/gs)) {
      const sides = (border[1] ?? '').matchAll(/<(left|right|top|bottom|diagonal)[ />]/g)
        .map(match => match[1]).toArray()
      expect(sides).toStrictEqual(['left', 'right', 'top', 'bottom', 'diagonal'])
    }
  })

  it('帯の左右は塗りが同じで、内側に面する辺の罫線だけが落ちている', () => {
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
  it('ラベル列と値列の幅の和は 1 列 960px ぶんの幅と一致する', () => {
    // 帯の右端を画像の最大右端に揃える設計の前提。140 が 7 の倍数でないと丸め損失で
    // 和が縮み、帯が画像より狭く出る。
    expect(LABEL_COLUMN_WIDTH + VALUE_COLUMN_WIDTH).toBe(columnWidth(DISPLAY_WIDTH_PX))
    expect(LABEL_COLUMN_WIDTH_PX + VALUE_COLUMN_WIDTH_PX).toBe(DISPLAY_WIDTH_PX)
  })

  it('Excel の逆換算式で px へ戻すと、宣言どおりの px になる', () => {
    // 往復で元の px に戻らない幅を選ぶと、宣言値と実際の表示幅がずれる。
    expect(columnWidthToPixels(LABEL_COLUMN_WIDTH)).toBe(LABEL_COLUMN_WIDTH_PX)
    expect(columnWidthToPixels(VALUE_COLUMN_WIDTH)).toBe(VALUE_COLUMN_WIDTH_PX)
    expect(columnWidthToPixels(columnWidth(DISPLAY_WIDTH_PX))).toBe(DISPLAY_WIDTH_PX)
  })
})

describe('buildStylesXml — theme 非依存', () => {
  it('theme 参照を持たない (色は 8 桁 ARGB か indexed のみ)', () => {
    const xml = buildStylesXml()

    // theme1.xml を同梱しないので theme 参照は禁止。
    expect(xml).not.toContain('theme')
    for (const color of xml.matchAll(/<(?:fgColor|color) rgb="([^"]+)"\/>/g)) {
      expect(color[1]).toMatch(/^[0-9A-F]{8}$/)
    }
  })
})

describe('buildDrawingXml', () => {
  it('oneCellAnchor の子要素順と EMU を具体値で pin する', () => {
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

  it('複数画像では shape id と rId が並び順どおり一意に振られる', () => {
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

  it('画像の枠線は注記の枠線と別色で、画像ごとに 1 本ずつ引かれる', () => {
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

  it('画像 0 件では anchor を持たない wsDr になる', () => {
    expect(buildDrawingXml([])).toBe(
      `${DECL}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_REL}"></xdr:wsDr>`,
    )
  })
})

describe('buildDrawingXml — 注記図形', () => {
  // 1920x1080 → 960x540。picture の anchor は col=1 / row=7 で colOff / rowOff = 0 なので、
  // 注記は同じセルに画像左上からの EMU オフセットで重なる。
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

  const PICTURE_ANCHOR = `<xdr:oneCellAnchor>`
    + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>`
    + `<xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="9144000" cy="5143500"/>`
    + `<xdr:pic>`
    + `<xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/>`
    + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:ln w="19050"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln>`
    + `</xdr:spPr>`
    + `</xdr:pic>`
    + `<xdr:clientData/>`
    + `</xdr:oneCellAnchor>`

  it('sp の最小構成・既定スタイル・通し採番を具体値で pin する', () => {
    expect(buildDrawingXml(singleImageLayout(ANNOTATIONS).placements)).toBe(
      `${DECL}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_REL}">`
      + PICTURE_ANCHOR
      // callout: box (480,324) 288x54 px。白地 + 2.25pt 赤枠、文言は中央寄せ。
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>4572000</xdr:colOff>`
      + `<xdr:row>7</xdr:row><xdr:rowOff>3086100</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="2743200" cy="514350"/>`
      + `<xdr:sp>`
      // macro / textlink 属性なし・cNvSpPr は空要素 (実機確認済みの最小構成)。
      + `<xdr:nvSpPr><xdr:cNvPr id="3" name="Callout 3"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="514350"/></a:xfrm>`
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
      + `<xdr:clientData/>`
      + `</xdr:oneCellAnchor>`
      // highlight: 塗りなし + 2.25pt 赤枠。txBody は持たない。
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>914400</xdr:colOff>`
      + `<xdr:row>7</xdr:row><xdr:rowOff>1028700</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="1828800" cy="771525"/>`
      + `<xdr:sp>`
      + `<xdr:nvSpPr><xdr:cNvPr id="4" name="Highlight 4"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="771525"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      + `<a:noFill/>`
      + `<a:ln w="28575"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:sp>`
      + `<xdr:clientData/>`
      + `</xdr:oneCellAnchor>`
      // arrow: 左上向きなので flipH / flipV の両方が立つ。矢尻は tailEnd。
      + `<xdr:oneCellAnchor>`
      + `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>2286000</xdr:colOff>`
      + `<xdr:row>7</xdr:row><xdr:rowOff>2571750</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="1371600" cy="514350"/>`
      + `<xdr:sp>`
      + `<xdr:nvSpPr><xdr:cNvPr id="5" name="Arrow 5"/><xdr:cNvSpPr/></xdr:nvSpPr>`
      + `<xdr:spPr>`
      + `<a:xfrm flipH="1" flipV="1"><a:off x="0" y="0"/><a:ext cx="1371600" cy="514350"/></a:xfrm>`
      + `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
      + `<a:noFill/>`
      + `<a:ln w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`
      + `<a:tailEnd type="triangle" w="lg" len="lg"/></a:ln>`
      + `</xdr:spPr>`
      + `</xdr:sp>`
      + `<xdr:clientData/>`
      + `</xdr:oneCellAnchor>`
      + `</xdr:wsDr>`,
    )
  })

  it('theme 参照を持たない (色はすべて rgb 明示)', () => {
    const xml = buildDrawingXml(singleImageLayout(ANNOTATIONS).placements)

    expect(xml).not.toContain('schemeClr')
    expect(xml).not.toContain('<xdr:style>')
  })

  it('既定の向きの arrow では flip 属性そのものを出さない', () => {
    const xml = buildDrawingXml(singleImageLayout([
      { type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.6 } },
    ]).placements)

    expect(xml).toContain('<a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="2057400"/></a:xfrm>')
    expect(xml).not.toContain('flip')
  })

  it('callout の文言も制御文字除去とエスケープの 2 段を通る', () => {
    const xml = buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: `A&B <tag> "q" 'a'\0`,
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)

    expect(xml).toContain(`<a:t>A&amp;B &lt;tag&gt; &quot;q&quot; &apos;a&apos;</a:t>`)
  })

  it('callout の文言のタブは a:t に生のまま残る', () => {
    const xml = buildDrawingXml(singleImageLayout([{
      type: 'callout',
      text: 'ログイン\tボタン',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      anchor: { x: 0.5, y: 0.5 },
    }]).placements)

    // タブは XML 1.0 で表現できるため除去対象にしない (spec-schema が弾くのは改行だけ)。
    expect(xml).toContain(`<a:t>ログイン\tボタン</a:t>`)
  })

  it('callout の文言の前後の空白は xml:space="preserve" で保つ', () => {
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

  it('複数画像に注記が付いても cNvPr の id は drawing 全体で一意になる', () => {
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
        ['2', 'Picture 1'],
        ['3', 'Highlight 3'],
        ['4', 'Arrow 4'],
        ['5', 'Picture 2'],
        ['6', 'Callout 6'],
      ])
  })
})

describe('mediaPartName', () => {
  it('拡張子はシグネチャ判定結果に従う', () => {
    expect(mediaPartName(1, 'png')).toBe('xl/media/image1.png')
    expect(mediaPartName(2, 'jpeg')).toBe('xl/media/image2.jpeg')
  })
})
