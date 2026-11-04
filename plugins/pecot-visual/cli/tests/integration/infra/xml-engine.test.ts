// @xmldom/xmldom + xpath を本物として動作させる integration test。モック禁止。

import { describe, expect, it } from 'vitest'

import { XmldomXmlEngine } from '../../../src/infra/pptx-ooxml/xml-engine.js'
import { NS_DRAWINGML, NS_MARKUP_COMPATIBILITY, NS_OFFICE_RELATIONSHIPS, NS_POWERPOINT_2010, NS_POWERPOINT_2015_09, NS_PRESENTATIONML } from '../../../src/domain/_shared/ooxml-uris.js'

const SAMPLE_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">',
  '  <p:cSld>',
  '    <p:spTree>',
  '      <a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r>',
  '      <a:r><a:rPr lang="en-US"/><a:t>こんにちは</a:t></a:r>',
  '    </p:spTree>',
  '  </p:cSld>',
  '  <mc:AlternateContent><mc:Choice/></mc:AlternateContent>',
  '</p:sld>',
].join('\n')

const NS_MAP: Readonly<Record<string, string>> = {
  a: NS_DRAWINGML,
  p: NS_PRESENTATIONML,
  mc: NS_MARKUP_COMPATIBILITY,
  p14: NS_POWERPOINT_2010,
  p159: NS_POWERPOINT_2015_09,
}

describe('XmldomXmlEngine', () => {
  it('parse → selectNodes → setAttr → serialize で属性が反映される', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const rPrNodes = document.selectNodes('//a:rPr', NS_MAP)
    expect(rPrNodes.length).toBe(2)
    for (const node of rPrNodes) {
      node.setAttr('lang', 'ja-JP')
    }
    const out = engine.serialize(document).toString('utf8')
    // 反映確認: lang="ja-JP" が 2 回出ている
    const matches = out.match(/lang="ja-JP"/g)
    expect(matches).not.toBeNull()
    expect(matches?.length).toBe(2)
  })

  it('selectNodes は名前空間付き XPath を解釈できる', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const tNodes = document.selectNodes('//a:t', NS_MAP)
    expect(tNodes.length).toBe(2)
    const altContent = document.selectNodes('//mc:AlternateContent', NS_MAP)
    expect(altContent.length).toBe(1)
  })

  it('selectNodes は nsMap 省略時にも動作する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><a/><b/></root>', 'utf8'))
    const aNodes = document.selectNodes('//a')
    expect(aNodes.length).toBe(2)
  })

  it('serialize 出力に xml-decl と standalone="yes" が含まれる', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true)
  })

  it('元 XML が standalone を欠いていても serialize で standalone="yes" が付与される', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true)
    expect(out).toContain('<root/>')
  })

  it('setText で要素テキストが書き換わる', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const tNodes = document.selectNodes('//a:t', NS_MAP)
    expect(tNodes.length).toBe(2)
    tNodes[0]?.setText('置換後')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('置換後')
    expect(out).not.toContain('Hello')
  })

  it('remove で要素が削除される', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const altContent = document.selectNodes('//mc:AlternateContent', NS_MAP)
    expect(altContent.length).toBe(1)
    altContent[0]?.remove()
    const out = engine.serialize(document).toString('utf8')
    expect(out).not.toContain('AlternateContent')
  })

  it('replaceWithXml で要素ツリーが置換される (XML として展開、テキストエスケープされない)', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const altContent = document.selectNodes('//mc:AlternateContent', NS_MAP)
    expect(altContent.length).toBe(1)
    const fragment = `<mc:AlternateContent xmlns:mc="${NS_MARKUP_COMPATIBILITY}">`
      + `<mc:Choice xmlns:p14="${NS_POWERPOINT_2010}" Requires="p14">`
      + `<p:transition xmlns:p="${NS_PRESENTATIONML}" p14:dur="500">`
      + '<p:fade/>'
      + '</p:transition>'
      + '</mc:Choice>'
      + '</mc:AlternateContent>'
    altContent[0]?.replaceWithXml(fragment)
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('p14:dur="500"')
    // エスケープされて &lt; になっていないこと
    expect(out).not.toContain('&lt;p:transition')
  })

  it('replaceWithXml は root を持たないフラグメントで失敗する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/></root>', 'utf8'))
    const aNodes = document.selectNodes('//a')
    expect(() => {
      aNodes[0]?.replaceWithXml('<!-- comment only -->')
    }).toThrow()
  })

  it('serialize は別エンジン由来の document を拒否する', () => {
    const engine = new XmldomXmlEngine()
    const fakeDocument = {
      selectNodes: (): readonly never[] => [],
      appendChildXml: (): void => undefined,
    }
    expect(() => engine.serialize(fakeDocument)).toThrow(TypeError)
  })

  it('selectNodes は要素以外のノード（属性ノードなど）を返さない', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root x="1"><a x="2"/></root>', 'utf8'))
    // 属性ノードを XPath で問い合わせると libxml は Attribute を返す。
    // 我々の selectNodes は Element だけを wrap するため空配列になる。
    const attributes = document.selectNodes('//@x')
    expect(attributes.length).toBe(0)
  })

  it('XmlNode#selectNodes はノード起点の相対 XPath を解釈する (nsMap 有/無)', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const [sld] = document.selectNodes('/p:sld', NS_MAP)
    expect(sld).toBeDefined()
    const rs = sld?.selectNodes('.//a:r', NS_MAP) ?? []
    expect(rs.length).toBe(2)
    const noNs = engine.parse(Buffer.from('<root><x><y/><y/></x></root>', 'utf8'))
    const [x] = noNs.selectNodes('/root/x')
    expect(x?.selectNodes('./y').length).toBe(2)
  })

  it('getAttr は名前空間なしの属性をローカル名で返し、未設定なら undefined を返す', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><foo id="42"/></root>', 'utf8'))
    const [foo] = document.selectNodes('//foo')
    expect(foo?.getAttr('id')).toBe('42')
    expect(foo?.getAttr('missing')).toBeUndefined()
  })

  it('getAttr は prefix:localName で名前空間付き属性を取得する', () => {
    const engine = new XmldomXmlEngine()
    const xml = `<root xmlns:r="${NS_OFFICE_RELATIONSHIPS}" xmlns:other="urn:other">`
      + '<foo r:id="rId1" other:id="other-id"/>'
      + '</root>'
    const document = engine.parse(Buffer.from(xml, 'utf8'))
    const [foo] = document.selectNodes('//foo')
    expect(foo?.getAttr('r:id')).toBe('rId1')
    expect(foo?.getAttr('other:id')).toBe('other-id')
    // localName が無い prefix
    expect(foo?.getAttr('xx:nope')).toBeUndefined()
    // prefix が一致しない localName
    expect(foo?.getAttr('xx:id')).toBeUndefined()
  })

  it('text / setText: 純テキスト要素に対して値の取り出しと書き換えができる', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a:t xmlns:a="urn:a">old</a:t></root>', 'utf8'))
    const [t] = document.selectNodes('//a:t', { a: 'urn:a' })
    expect(t?.text()).toBe('old')
    t?.setText('new')
    expect(t?.text()).toBe('new')
  })

  it('XmlNode#appendChildXml: 自ノードの子として末尾に新要素を追加する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><parent/></root>', 'utf8'))
    const [parent] = document.selectNodes('//parent')
    parent?.appendChildXml('<child id="1"/>')
    parent?.appendChildXml('<child id="2"/>')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<child id="1"/>')
    expect(out).toContain('<child id="2"/>')
  })

  it('XmlNode#appendChildXml は不正フラグメントで失敗する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/></root>', 'utf8'))
    const [a] = document.selectNodes('//a')
    expect(() => {
      a?.appendChildXml('<!-- only comment -->')
    }).toThrow()
  })

  it('XmlDocument#appendChildXml: ドキュメントルートの子として要素を追加する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(`<p:sld xmlns:p="${NS_PRESENTATIONML}"></p:sld>`, 'utf8'))
    const fragment = `<mc:AlternateContent xmlns:mc="${NS_MARKUP_COMPATIBILITY}"/>`
    document.appendChildXml(fragment)
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('mc:AlternateContent')
  })

  it('addNextSiblingXml は自ノードの直後に挿入し、最終子のときは末尾に追加する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><b/></root>', 'utf8'))
    const [a] = document.selectNodes('//a')
    a?.addNextSiblingXml('<a2/>')
    const [b] = document.selectNodes('//b')
    b?.addNextSiblingXml('<b2/>')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<root><a/><a2/><b/><b2/></root>')
  })

  it('getAttr の prefix 無し名は prefix 付き属性に一致しない', () => {
    const engine = new XmldomXmlEngine()
    const xml = `<root xmlns:r="${NS_OFFICE_RELATIONSHIPS}"><foo r:id="rId1" plain="p"/></root>`
    const document = engine.parse(Buffer.from(xml, 'utf8'))
    const [foo] = document.selectNodes('//foo')
    expect(foo?.getAttr('id')).toBeUndefined()
    expect(foo?.getAttr('r:id')).toBe('rId1')
    expect(foo?.getAttr('plain')).toBe('p')
  })

  it('テキスト中の CR は &#13; の文字参照で出力され、再パースしても保たれる', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><t>x&#13;y</t><u>z</u></root>', 'utf8'))
    document.selectNodes('//u')[0]?.setText('a\rb')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<t>x&#13;y</t>')
    expect(out).toContain('<u>a&#13;b</u>')
    const again = engine.parse(engine.serialize(document))
    expect(again.selectNodes('//t')[0]?.text()).toBe('x\ry')
  })

  it('serialize は decl〜root 間の空白を捨て、root の後に改行を 1 つ置く', () => {
    const engine = new XmldomXmlEngine()
    const withDeclaration = engine.parse(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n\t\t<root/>', 'utf8'))
    expect(engine.serialize(withDeclaration).toString('utf8'))
      .toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root/>\n')
    const withoutDeclaration = engine.parse(Buffer.from('<root/>', 'utf8'))
    expect(engine.serialize(withoutDeclaration).toString('utf8'))
      .toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root/>\n')
  })

  it('未宣言の名前空間 prefix を含むフラグメントは失敗する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><b/></root>', 'utf8'))
    const [a] = document.selectNodes('//a')
    const [b] = document.selectNodes('//b')
    expect(() => {
      a?.appendChildXml('<p:x/>')
    }).toThrow()
    expect(() => {
      a?.replaceWithXml('<p:x/>')
    }).toThrow()
    expect(() => {
      b?.addNextSiblingXml('<p:x/>')
    }).toThrow()
  })

  it('先頭に BOM (U+FEFF) があっても parse できる（libxmljs2 は許容していた）', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('\u{FEFF}<root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<root/>')
  })

  it('先頭が xml-stylesheet PI の宣言なし入力ではその PI を保持する', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(
      Buffer.from('<?xml-stylesheet type="text/xsl" href="x.xsl"?><root/>', 'utf8'),
    )
    const out = engine.serialize(document).toString('utf8')
    expect(out).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<?xml-stylesheet type="text/xsl" href="x.xsl"?><root/>\n',
    )
  })

  it('属性値の CR (&#13;) は往復し、CDATA 中の生 CR は parse 時に LF 化される', () => {
    const engine = new XmldomXmlEngine()
    // 属性値・テキストノードは文字参照 `&#13;` を使う（生の \r は改行正規化で LF に
    // 化けるため、CR を実際に保持させるには文字参照が要る）。CDATA は生の \r を直接置く
    // （CDATA 内で `&#13;` は entity としてデコードされずリテラル文字列のまま残るため）。
    const document = engine.parse(
      Buffer.from('<root a="x&#13;y"><![CDATA[c\rd]]><t>e&#13;f</t></root>', 'utf8'),
    )
    const out = engine.serialize(document).toString('utf8')
    // 属性値: xmldom が serialize 時点で既に &#13; を出力する。
    expect(out).toContain('a="x&#13;y"')
    // CDATA: 生の CR は parse 時の改行正規化で LF に化ける（&#13; 化は起きない）。
    expect(out).toContain('<![CDATA[c\nd]]>')
    // テキストノード: &#13; は CR にデコードされ、serialize で文字参照に戻される。
    expect(out).toContain('<t>e&#13;f</t>')
  })

  it('selectNodes はスカラを返す XPath (count(...) 等) で空配列を返す', () => {
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><a/></root>', 'utf8'))
    expect(document.selectNodes('count(//a)')).toEqual([])
  })
})
