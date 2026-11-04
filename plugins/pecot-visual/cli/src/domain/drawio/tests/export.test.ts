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
  it('重複を保持したまま出現順に icon:// 参照を返す', () => {
    expect(collectIconReferences(ICON_XML)).toEqual([
      'icon://science/brain-circuit#4f46e5',
      'icon://weather/cloud',
      'icon://science/brain-circuit#4f46e5',
    ])
  })

  it('icon:// を含まない XML では空配列を返す', () => {
    expect(collectIconReferences('<mxfile><diagram/></mxfile>')).toEqual([])
  })

  it('style 属性の外にある icon:// の字面は拾わない', () => {
    const xml = '<mxfile><mxCell value="書式は image=icon://science/brain-circuit#4f46e5 です" style="rounded=0;"/></mxfile>'

    expect(collectIconReferences(xml)).toEqual([])
  })
})

describe('resolveIconsForExport', () => {
  it('全 icon:// が data URI に置き換わり、件数が元 XML と一致する', () => {
    const iconCount = collectIconReferences(ICON_XML).length
    const { xml, unresolved } = resolveIconsForExport(ICON_XML, resolveAll)

    expect(unresolved).toEqual([])
    expect(xml).not.toContain('icon://')
    expect(xml.match(/data:image\/svg\+xml,/g)).toHaveLength(iconCount)
  })

  it('解決できない参照を、色指定を保ったまま重複なしで返す', () => {
    const { xml, unresolved } = resolveIconsForExport(ICON_XML, resolveNone)

    expect(xml).toContain('icon://')
    expect(unresolved).toEqual(['icon://science/brain-circuit#4f46e5', 'icon://weather/cloud'])
  })

  it('ラベル文言に書かれた icon:// の字面では export を止めない', () => {
    // 図の書式説明として value 属性に icon:// と書いたテンプレ同梱図が、
    // 未解決 icon 扱いで公開ビルドを止めていた（誤検知の回帰防止）。
    const xml = '<mxfile><mxCell value="image=icon://weather/name#FFF と書く" style="rounded=0;"/></mxfile>'

    expect(resolveIconsForExport(xml, resolveNone).unresolved).toEqual([])
  })

  it('解決済みの参照が別参照の接頭辞でも未解決扱いしない', () => {
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
  it('同じ XML・同じ icon 内容なら同じ値を返す', () => {
    expect(computeSourceHash(ICON_XML, resolveAll)).toBe(computeSourceHash(ICON_XML, resolveAll))
  })

  it('XML が変われば値が変わる', () => {
    expect(computeSourceHash(ICON_XML, resolveAll)).not.toBe(
      computeSourceHash(`${ICON_XML}<!-- edit -->`, resolveAll),
    )
  })

  it('XML が同じでも icon の内容が変われば値が変わる', () => {
    const changedCatalog: IconResolver = (relativePath, color) =>
      `${resolveAll(relativePath, color) ?? ''}-v2`

    expect(computeSourceHash(ICON_XML, resolveAll)).not.toBe(
      computeSourceHash(ICON_XML, changedCatalog),
    )
  })

  it('icon を解決できない場合も値を返す（判定は export 側で行う）', () => {
    expect(computeSourceHash(ICON_XML, resolveNone)).toMatch(/^[\da-f]{64}$/)
  })
})

describe('forceLightColorScheme', () => {
  it('ルートの color-scheme: light dark を light に置換する', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; color-scheme: light dark;" width="10px"><g/></svg>'

    const result = forceLightColorScheme(svg)

    expect(result).toContain('color-scheme: light;')
    expect(result).not.toContain('light dark')
    expect(result).toContain('background: transparent;')
  })

  it('style 属性はあるが color-scheme が無い場合は追記する', () => {
    const result = forceLightColorScheme('<svg style="background: transparent;"><g/></svg>')

    expect(result).toContain('color-scheme: light;')
    expect(result).toContain('background: transparent;')
  })

  it('style 属性が無い場合は style ごと付与する', () => {
    const result = forceLightColorScheme('<svg width="10px"><g/></svg>')

    expect(result).toBe('<svg width="10px" style="color-scheme: light;"><g/></svg>')
  })

  it('ルート要素以外の color-scheme には触れない', () => {
    const svg = '<svg style="color-scheme: light dark;"><g style="color-scheme: light dark;"/></svg>'

    expect(forceLightColorScheme(svg)).toBe(
      '<svg style="color-scheme: light;"><g style="color-scheme: light dark;"/></svg>',
    )
  })

  it('SVG ルート要素が無ければ明示エラーにする', () => {
    expect(() => forceLightColorScheme('<html><body/></html>')).toThrow(/SVG ルート要素がありません/)
  })

  it('自己終了タグでも /> を保ったまま属性を足す', () => {
    expect(forceLightColorScheme('<svg width="10px"/>')).toBe(
      '<svg width="10px" style="color-scheme: light;"/>',
    )
  })
})

describe('embedSourceHash / readSourceHash', () => {
  it('ルート要素に SHA-256 属性を付与し読み戻せる', () => {
    const result = embedSourceHash('<svg width="10px"><g/></svg>', SHA)

    expect(result).toContain(`${SOURCE_HASH_ATTRIBUTE}="${SHA}"`)
    expect(readSourceHash(result)).toBe(SHA)
  })

  it('既存の SHA-256 属性は重複させず置き換える', () => {
    const once = embedSourceHash('<svg width="10px"><g/></svg>', SHA)
    const twice = embedSourceHash(once, 'b'.repeat(64))

    expect(twice.split(SOURCE_HASH_ATTRIBUTE)).toHaveLength(2)
    expect(readSourceHash(twice)).toBe('b'.repeat(64))
  })

  it('属性が無い SVG からは undefined を返す', () => {
    expect(readSourceHash('<svg><g/></svg>')).toBeUndefined()
  })

  it('自己終了タグでも /> を壊さずに埋め込める', () => {
    const result = embedSourceHash('<svg width="10px"/>', SHA)

    expect(result).toBe(`<svg width="10px" ${SOURCE_HASH_ATTRIBUTE}="${SHA}"/>`)
    expect(readSourceHash(result)).toBe(SHA)
  })

  it('color-scheme 固定と併用してもルート属性が両立する', () => {
    const svg = '<svg style="color-scheme: light dark;"><g/></svg>'

    const baked = embedSourceHash(forceLightColorScheme(svg), SHA)

    expect(baked).toContain('color-scheme: light;')
    expect(readSourceHash(baked)).toBe(SHA)
  })
})

describe('readSvgPixelSize', () => {
  it('editor が返す px 付きの width / height を数値で返す', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light;" width="201px" height="121.5px" viewBox="-0.5 -0.5 201 121"><g/></svg>'

    expect(readSvgPixelSize(svg)).toEqual({ width: 201, height: 121.5 })
  })

  it('単位の無い値は user unit (px) として扱う', () => {
    expect(readSvgPixelSize('<svg width="40" height="30"/>')).toEqual({ width: 40, height: 30 })
  })

  it('ルート要素以外の width / height は見ない', () => {
    const svg = '<svg width="10px" height="20px"><rect width="999" height="999"/></svg>'

    expect(readSvgPixelSize(svg)).toEqual({ width: 10, height: 20 })
  })

  it('width が無ければエラーにする (既定の A4 で出力しない)', () => {
    expect(() => readSvgPixelSize('<svg stroke-width="2" height="30px"/>')).toThrow(/width 属性がありません/)
  })

  it('height が無ければエラーにする', () => {
    expect(() => readSvgPixelSize('<svg width="30px"/>')).toThrow(/height 属性がありません/)
  })

  it.each(['100%', '10pt', '5mm', '0px', 'auto', '1.2.3px'])('px 以外・0 の値 (%s) はエラーにする', (value) => {
    expect(() => readSvgPixelSize(`<svg width="${value}" height="30px"/>`)).toThrow(/px の正の値ではありません/)
  })

  it('SVG ルート要素が無ければエラーにする', () => {
    expect(() => readSvgPixelSize('<html/>')).toThrow(/SVG ルート要素がありません/)
  })
})

describe('siblingPath', () => {
  it('最後の拡張子を置換する', () => {
    expect(siblingPath('/work/out/diagram.svg', '.pdf')).toBe('/work/out/diagram.pdf')
  })

  it('多重拡張子では末尾の拡張子だけを置換する', () => {
    expect(siblingPath('/work/out/diagram.drawio.svg', '.pdf')).toBe('/work/out/diagram.drawio.pdf')
    expect(siblingPath('/work/out/diagram.drawio.html', '.png')).toBe('/work/out/diagram.drawio.png')
  })

  it('拡張子だけのファイル名は置換せず付加する', () => {
    expect(siblingPath('/work/out/.svg', '.pdf')).toBe('/work/out/.svg.pdf')
  })

  it('拡張子なしのファイル名には拡張子を付加する', () => {
    expect(siblingPath('/work/out/diagram', '.pdf')).toBe('/work/out/diagram.pdf')
  })
})
