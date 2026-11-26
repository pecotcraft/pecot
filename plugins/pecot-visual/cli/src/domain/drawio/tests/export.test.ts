// domain/drawio/export.ts の単体テスト。
// 静的 SVG 公開で必要な 3 つの不変条件を pin する。
// 1 つ目は、icon:// が 1 件も残らず data URI に置き換わること（件数一致）。
// 2 つ目は、ルートの color-scheme が light 固定になること。<img> 経由のダークモード反転を防ぐ。
// 3 つ目は、元 XML の SHA-256 がルート属性に載ること。陳腐化検知の基準になる。

import { describe, expect, it } from 'vitest'

import {
  SOURCE_HASH_ATTRIBUTE,
  collectIconReferences,
  computeSourceHash,
  embedSourceHash,
  forceLightColorScheme,
  readSourceHash,
  readSvgPixelSize,
  resolveIconsForExport,
  siblingPath,
} from '../export.js'
import type { IconResolver } from '../types.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const SHA = 'a'.repeat(64)

const ICON_XML = [
  '<mxfile><diagram><mxGraphModel><root>',
  '<mxCell id="a" style="shape=image;image=icon://science/brain-circuit#4f46e5;"/>',
  '<mxCell id="b" style="shape=image;image=icon://weather/cloud;"/>',
  '<mxCell id="c" style="shape=image;image=icon://science/brain-circuit#4f46e5;"/>',
  '</root></mxGraphModel></diagram></mxfile>',
].join('')

const resolveAll: IconResolver = (relativePath, color = 'none') =>
  `data:image/svg+xml,${Buffer.from(`${relativePath}/${color}`, 'utf8').toString('base64')}`

// eslint-disable-next-line unicorn/no-useless-undefined -- 戻り値型が undefined を含む
const resolveNone: IconResolver = () => undefined

describe('collectIconReferences', () => {
  it('icon:// の参照が重複している場合は、重複を残したまま、出現順に返す', async () => {
    await explains('draw.io の XML から `icon://` の参照を集める `collectIconReferences` のテストです。同じ参照が複数回現れる XML を渡した場合に、重複を残したまま、出現した順に返すことを確認します。')
    expect(collectIconReferences(ICON_XML)).toEqual([
      'icon://science/brain-circuit#4f46e5',
      'icon://weather/cloud',
      'icon://science/brain-circuit#4f46e5',
    ])
  })

  it('icon:// を含まない XML では空配列を返す', async () => {
    await explains('draw.io の XML から `icon://` の参照を集める `collectIconReferences` のテストです。`icon://` を含まない XML を渡した場合に、空の配列を返すことを確認します。')
    expect(collectIconReferences('<mxfile><diagram/></mxfile>')).toEqual([])
  })

  it('style 属性の外に書かれた icon:// の文字列は、参照として集めない', async () => {
    await explains('draw.io の XML から `icon://` の参照を集める `collectIconReferences` のテストです。`value` 属性のラベルの文章に `icon://` が書かれていても、`style` 属性の外にあるため、参照として集めないことを確認します。')
    const xml = '<mxfile><mxCell value="書式は image=icon://science/brain-circuit#4f46e5 です" style="rounded=0;"/></mxfile>'

    expect(collectIconReferences(xml)).toEqual([])
  })
})

describe('resolveIconsForExport', () => {
  it('すべての icon:// を data URI に置き換え、置き換えた件数が元の XML の参照の件数と一致する', async () => {
    await explains('書き出し用に `icon://` を data URI へ置き換える `resolveIconsForExport` のテストです。すべての参照を解決できる場合に、`icon://` が 1 件も残らず、置き換えた件数が元の XML の参照の件数と一致することを確認します。')
    const iconCount = collectIconReferences(ICON_XML).length
    const { xml, unresolved } = resolveIconsForExport(ICON_XML, resolveAll)

    expect(unresolved).toEqual([])
    expect(xml).not.toContain('icon://')
    expect(xml.match(/data:image\/svg\+xml,/g)).toHaveLength(iconCount)
  })

  it('解決できない参照は、色の指定を含めたまま、重複を除いて返す', async () => {
    await explains('書き出し用に `icon://` を data URI へ置き換える `resolveIconsForExport` のテストです。どの参照も解決できない場合に、XML に `icon://` が残り、未解決の参照が色の指定付きで、重複なしに返ることを確認します。')
    const { xml, unresolved } = resolveIconsForExport(ICON_XML, resolveNone)

    expect(xml).toContain('icon://')
    expect(unresolved).toEqual(['icon://science/brain-circuit#4f46e5', 'icon://weather/cloud'])
  })

  it('ラベルの文章に書かれた icon:// は、未解決の参照として扱わず、書き出しを止めない', async () => {
    await explains('書き出し用に `icon://` を data URI へ置き換える `resolveIconsForExport` のテストです。図の書式の説明として `value` 属性に `icon://` と書かれていても、未解決の参照に含まれないことを確認します。')
    // 図の書式説明として value 属性に icon:// と書いたテンプレ同梱図が、
    // 未解決 icon 扱いで公開ビルドを止めていた（誤検知の回帰防止）。
    const xml = '<mxfile><mxCell value="image=icon://weather/name#FFF と書く" style="rounded=0;"/></mxfile>'

    expect(resolveIconsForExport(xml, resolveNone).unresolved).toEqual([])
  })

  it('解決済みの参照が、別の参照の先頭部分と同じ場合は、未解決の参照として扱わない', async () => {
    await explains('書き出し用に `icon://` を data URI へ置き換える `resolveIconsForExport` のテストです。`icon://weather/cloud` と `icon://weather/cloud-sun` のように、一方が他方の先頭部分である参照を両方解決できる場合に、未解決の参照が空になることを確認します。')
    // 部分文字列で判定すると、icon://weather/cloud が icon://weather/cloud-sun に誤ヒットする。
    // すると、解決済みの参照まで未解決になる。
    const xml = [
      '<mxfile>',
      '<mxCell style="image=icon://weather/cloud;"/>',
      '<mxCell style="image=icon://weather/cloud-sun;"/>',
      '</mxfile>',
    ].join('')

    expect(resolveIconsForExport(xml, resolveAll).unresolved).toEqual([])
  })
})

describe('computeSourceHash', () => {
  it('同じ XML と同じ icon の内容からは、同じハッシュ値を返す', async () => {
    await explains('書き出し元のハッシュ値を求める `computeSourceHash` のテストです。同じ XML と同じ icon の内容を渡した場合に、同じハッシュ値を返すことを確認します。')
    expect(computeSourceHash(ICON_XML, resolveAll)).toBe(computeSourceHash(ICON_XML, resolveAll))
  })

  it('XML が変わった場合は、ハッシュ値が変わる', async () => {
    await explains('書き出し元のハッシュ値を求める `computeSourceHash` のテストです。XML の末尾にコメントを追加した場合に、元の XML とは異なるハッシュ値を返すことを確認します。')
    expect(computeSourceHash(ICON_XML, resolveAll)).not.toBe(
      computeSourceHash(`${ICON_XML}<!-- edit -->`, resolveAll),
    )
  })

  it('XML が同じでも icon の内容が変わった場合は、ハッシュ値が変わる', async () => {
    await explains('書き出し元のハッシュ値を求める `computeSourceHash` のテストです。XML が同じで、icon の解決結果だけが異なる場合に、異なるハッシュ値を返すことを確認します。')
    const changedCatalog: IconResolver = (relativePath, color) =>
      `${resolveAll(relativePath, color) ?? ''}-v2`

    expect(computeSourceHash(ICON_XML, resolveAll)).not.toBe(
      computeSourceHash(ICON_XML, changedCatalog),
    )
  })

  it('icon を解決できない場合でも、ハッシュ値を返す', async () => {
    await explains('書き出し元のハッシュ値を求める `computeSourceHash` のテストです。icon を 1 つも解決できない場合でも、例外を発生させず、64 桁の 16 進数のハッシュ値を返すことを確認します。')
    expect(computeSourceHash(ICON_XML, resolveNone)).toMatch(/^[\da-f]{64}$/)
  })
})

describe('forceLightColorScheme', () => {
  it('ルート要素の color-scheme が light dark の場合は、light に置き換える', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。ルート要素の `color-scheme` が `light dark` の場合に、`light` へ置き換え、ほかのスタイルを残すことを確認します。')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; color-scheme: light dark;" width="10px"><g/></svg>'

    const result = forceLightColorScheme(svg)

    expect(result).toContain('color-scheme: light;')
    expect(result).not.toContain('light dark')
    expect(result).toContain('background: transparent;')
  })

  it('style 属性があり、color-scheme がない場合は、color-scheme を追加する', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。ルート要素に `style` 属性があり、`color-scheme` がない場合に、既存のスタイルを残して `color-scheme: light` を追加することを確認します。')
    const result = forceLightColorScheme('<svg style="background: transparent;"><g/></svg>')

    expect(result).toContain('color-scheme: light;')
    expect(result).toContain('background: transparent;')
  })

  it('style 属性がない場合は、style 属性ごと追加する', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。ルート要素に `style` 属性がない場合に、`style="color-scheme: light;"` を属性ごと追加することを確認します。')
    const result = forceLightColorScheme('<svg width="10px"><g/></svg>')

    expect(result).toBe('<svg width="10px" style="color-scheme: light;"><g/></svg>')
  })

  it('ルート要素以外の color-scheme は変更しない', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。子の `g` 要素にも `color-scheme: light dark` がある場合に、ルート要素だけを `light` に変更し、子の要素は変更しないことを確認します。')
    const svg = '<svg style="color-scheme: light dark;"><g style="color-scheme: light dark;"/></svg>'

    expect(forceLightColorScheme(svg)).toBe(
      '<svg style="color-scheme: light;"><g style="color-scheme: light dark;"/></svg>',
    )
  })

  it('SVG のルート要素が存在しない場合は、例外が発生する', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。SVG のルート要素を含まない内容を渡した場合に、`no SVG root element in the exported content` の例外が発生することを確認します。')
    expect(() => forceLightColorScheme('<html><body/></html>')).toThrow(/no SVG root element in the exported content/)
  })

  it('自己終了タグのルート要素でも、/> を保ったまま style 属性を追加する', async () => {
    await explains('SVG のルート要素の `color-scheme` を `light` に固定する `forceLightColorScheme` のテストです。ルート要素が `<svg width="10px"/>` のような自己終了タグの場合に、`/>` を保ったまま `style` 属性を追加することを確認します。')
    expect(forceLightColorScheme('<svg width="10px"/>')).toBe(
      '<svg width="10px" style="color-scheme: light;"/>',
    )
  })
})

describe('embedSourceHash / readSourceHash', () => {
  it('ルート要素に SHA-256 の属性を追加し、同じ値を読み取れる', async () => {
    await explains('ルート要素へ書き出し元の SHA-256 を埋め込む `embedSourceHash` と、読み取る `readSourceHash` のテストです。ルート要素に属性を追加した場合に、属性が付き、`readSourceHash` で同じ値を読み取れることを確認します。')
    const result = embedSourceHash('<svg width="10px"><g/></svg>', SHA)

    expect(result).toContain(`${SOURCE_HASH_ATTRIBUTE}="${SHA}"`)
    expect(readSourceHash(result)).toBe(SHA)
  })

  it('SHA-256 の属性が既にある場合は、重複させず、新しい値に置き換える', async () => {
    await explains('ルート要素へ書き出し元の SHA-256 を埋め込む `embedSourceHash` のテストです。埋め込み済みの SVG に別の値を埋め込んだ場合に、属性は 1 つだけになり、新しい値を読み取れることを確認します。')
    const once = embedSourceHash('<svg width="10px"><g/></svg>', SHA)
    const twice = embedSourceHash(once, 'b'.repeat(64))

    expect(twice.split(SOURCE_HASH_ATTRIBUTE)).toHaveLength(2)
    expect(readSourceHash(twice)).toBe('b'.repeat(64))
  })

  it('SHA-256 の属性がない SVG からは、undefined を返す', async () => {
    await explains('SVG のルート要素から書き出し元の SHA-256 を読み取る `readSourceHash` のテストです。属性を持たない SVG を渡した場合に、`undefined` を返すことを確認します。')
    expect(readSourceHash('<svg><g/></svg>')).toBeUndefined()
  })

  it('自己終了タグのルート要素でも、/> を保ったまま SHA-256 の属性を埋め込む', async () => {
    await explains('ルート要素へ書き出し元の SHA-256 を埋め込む `embedSourceHash` のテストです。ルート要素が自己終了タグの場合に、`/>` を保ったまま属性を追加し、同じ値を読み取れることを確認します。')
    const result = embedSourceHash('<svg width="10px"/>', SHA)

    expect(result).toBe(`<svg width="10px" ${SOURCE_HASH_ATTRIBUTE}="${SHA}"/>`)
    expect(readSourceHash(result)).toBe(SHA)
  })

  it('color-scheme の固定と SHA-256 の埋め込みを続けて行っても、両方の属性がルート要素に残る', async () => {
    await explains('`forceLightColorScheme` と `embedSourceHash` を続けて呼び出すテストです。`color-scheme: light` の固定と SHA-256 の埋め込みを両方行った場合に、どちらの内容もルート要素に残ることを確認します。')
    const svg = '<svg style="color-scheme: light dark;"><g/></svg>'

    const baked = embedSourceHash(forceLightColorScheme(svg), SHA)

    expect(baked).toContain('color-scheme: light;')
    expect(readSourceHash(baked)).toBe(SHA)
  })
})

describe('readSvgPixelSize', () => {
  it('px 付きの width と height を、数値として返す', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。draw.io のエディタが出力する `201px` や `121.5px` のような単位付きの値を、数値の `width` と `height` として返すことを確認します。')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light;" width="201px" height="121.5px" viewBox="-0.5 -0.5 201 121"><g/></svg>'

    expect(readSvgPixelSize(svg)).toEqual({ width: 201, height: 121.5 })
  })

  it('単位がない値は、px として扱う', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。`width="40"` のように単位がない値を、px の数値として返すことを確認します。')
    expect(readSvgPixelSize('<svg width="40" height="30"/>')).toEqual({ width: 40, height: 30 })
  })

  it('ルート要素以外の width と height は、読み取らない', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。子の要素に `width` と `height` がある場合に、ルート要素の値だけを返すことを確認します。')
    const svg = '<svg width="10px" height="20px"><rect width="999" height="999"/></svg>'

    expect(readSvgPixelSize(svg)).toEqual({ width: 10, height: 20 })
  })

  it('width が存在しない場合は、既定の A4 の大きさにせず、例外が発生する', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。`width` がない場合に、既定の A4 の大きさで出力せず、`SVG root element has no width attribute` の例外が発生することを確認します。')
    expect(() => readSvgPixelSize('<svg stroke-width="2" height="30px"/>')).toThrow(/SVG root element has no width attribute/)
  })

  it('height が存在しない場合は、例外が発生する', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。`height` がない場合に、`SVG root element has no height attribute` の例外が発生することを確認します。')
    expect(() => readSvgPixelSize('<svg width="30px"/>')).toThrow(/SVG root element has no height attribute/)
  })

  it.each(['100%', '10pt', '5mm', '0px', 'auto', '1.2.3px'])('px 以外の単位や 0 の値（%s）の場合は、例外が発生する', async (value) => {
    await explains(`SVG のルート要素の大きさを読み取る \`readSvgPixelSize\` のテストです。\`width\` が \`${value}\` の場合に、正の px の値ではないとして、\`is not a positive px value\` の例外が発生することを確認します。`)
    expect(() => readSvgPixelSize(`<svg width="${value}" height="30px"/>`)).toThrow(/is not a positive px value/)
  })

  it('SVG のルート要素が存在しない場合は、例外が発生する', async () => {
    await explains('SVG のルート要素の大きさを読み取る `readSvgPixelSize` のテストです。SVG のルート要素を含まない内容を渡した場合に、`no SVG root element in the exported content` の例外が発生することを確認します。')
    expect(() => readSvgPixelSize('<html/>')).toThrow(/no SVG root element in the exported content/)
  })
})

describe('siblingPath', () => {
  it('拡張子がある場合は、最後の拡張子を置き換える', async () => {
    await explains('同じ場所に別の拡張子のパスを作成する `siblingPath` のテストです。`diagram.svg` のようなパスと `.pdf` を渡した場合に、最後の拡張子を置き換えたパスを返すことを確認します。')
    expect(siblingPath('/work/out/diagram.svg', '.pdf')).toBe('/work/out/diagram.pdf')
  })

  it('拡張子が複数ある場合は、末尾の拡張子だけを置き換える', async () => {
    await explains('同じ場所に別の拡張子のパスを作成する `siblingPath` のテストです。`diagram.drawio.svg` のように拡張子が複数ある場合に、末尾の拡張子だけを置き換えることを確認します。')
    expect(siblingPath('/work/out/diagram.drawio.svg', '.pdf')).toBe('/work/out/diagram.drawio.pdf')
    expect(siblingPath('/work/out/diagram.drawio.html', '.png')).toBe('/work/out/diagram.drawio.png')
  })

  it('ファイル名が拡張子だけの場合は、置き換えず、拡張子を追加する', async () => {
    await explains('同じ場所に別の拡張子のパスを作成する `siblingPath` のテストです。ファイル名が `.svg` だけの場合に、置き換えず、末尾に `.pdf` を追加することを確認します。')
    expect(siblingPath('/work/out/.svg', '.pdf')).toBe('/work/out/.svg.pdf')
  })

  it('ファイル名に拡張子がない場合は、拡張子を追加する', async () => {
    await explains('同じ場所に別の拡張子のパスを作成する `siblingPath` のテストです。ファイル名に拡張子がない場合に、末尾に `.pdf` を追加することを確認します。')
    expect(siblingPath('/work/out/diagram', '.pdf')).toBe('/work/out/diagram.pdf')
  })
})
