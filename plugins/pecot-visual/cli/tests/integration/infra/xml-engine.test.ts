// @xmldom/xmldom + xpath を本物として動作させる integration test。モック禁止。

import { describe, expect, it } from 'vitest'

import { XmldomXmlEngine } from '../../../src/infra/pptx-ooxml/xml-engine.js'
import { NS_DRAWINGML, NS_MARKUP_COMPATIBILITY, NS_OFFICE_RELATIONSHIPS, NS_POWERPOINT_2010, NS_POWERPOINT_2015_09, NS_PRESENTATIONML } from '../../../src/domain/_shared/ooxml-uris.js'
import { explains } from '../../_helpers/explains.js'

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
  it('parse・selectNodes・setAttr・serialize の順に呼ぶと、変更した属性が出力に反映される', async () => {
    await explains('`XmldomXmlEngine` の属性の更新のテストです。`a:rPr` の 2 件に `setAttr` で `lang="ja-JP"` を設定して `serialize` した場合に、出力に `lang="ja-JP"` がちょうど 2 回含まれることを確認します。')
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

  it('selectNodes は、名前空間付きの XPath を解釈して該当するノードを返す', async () => {
    await explains('`XmldomXmlEngine` の XPath のテストです。`//a:t` が 2 件、`//mc:AlternateContent` が 1 件のノードを返すことを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const tNodes = document.selectNodes('//a:t', NS_MAP)
    expect(tNodes.length).toBe(2)
    const altContent = document.selectNodes('//mc:AlternateContent', NS_MAP)
    expect(altContent.length).toBe(1)
  })

  it('nsMap を省略すると、名前空間なしの XPath で一致する 2 件のノードを返す', async () => {
    await explains('名前空間を指定しない XPath のテストです。`nsMap` を省略して `//a` を実行した場合に、一致する 2 件のノードが返ることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><a/><b/></root>', 'utf8'))
    const aNodes = document.selectNodes('//a')
    expect(aNodes.length).toBe(2)
  })

  it('serialize の出力は、XML 宣言と standalone="yes" から始まる', async () => {
    await explains('`XmldomXmlEngine` の `serialize` のテストです。宣言のない `<root/>` を出力した場合に、`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` から始まることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true)
  })

  it('元の XML に standalone がなくても、serialize の出力には standalone="yes" を付ける', async () => {
    await explains('`XmldomXmlEngine` の `serialize` のテストです。`standalone` のない XML 宣言を持つ入力を出力した場合に、`standalone="yes"` 付きの宣言になり、`<root/>` が保たれることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true)
    expect(out).toContain('<root/>')
  })

  it('setText を呼び出すと、要素のテキストを書き換える', async () => {
    await explains('`setText` のテストです。`a:t` の 1 件目のテキストを `置換後` へ書き換えた場合に、出力に `置換後` が含まれ、元の `Hello` が含まれないことを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const tNodes = document.selectNodes('//a:t', NS_MAP)
    expect(tNodes.length).toBe(2)
    tNodes[0]?.setText('置換後')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('置換後')
    expect(out).not.toContain('Hello')
  })

  it('remove を呼び出すと、要素を削除する', async () => {
    await explains('`remove` のテストです。`mc:AlternateContent` を `remove` した場合に、出力に `AlternateContent` が含まれないことを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(SAMPLE_XML, 'utf8'))
    const altContent = document.selectNodes('//mc:AlternateContent', NS_MAP)
    expect(altContent.length).toBe(1)
    altContent[0]?.remove()
    const out = engine.serialize(document).toString('utf8')
    expect(out).not.toContain('AlternateContent')
  })

  it('replaceWithXml は、要素を XML として展開して置き換え、テキストとしてエスケープしない', async () => {
    await explains('`replaceWithXml` のテストです。`mc:AlternateContent` を別の XML の断片へ置き換えた場合に、出力に `p14:dur="500"` が含まれ、`&lt;` のようなエスケープはされないことを確認します。')
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

  it('replaceWithXml に、ルート要素を持たない断片を渡すと、例外が発生する', async () => {
    await explains('`replaceWithXml` のテストです。コメントだけの断片 `<!-- comment only -->` を渡した場合に、例外が発生することを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/></root>', 'utf8'))
    const aNodes = document.selectNodes('//a')
    expect(() => {
      aNodes[0]?.replaceWithXml('<!-- comment only -->')
    }).toThrow()
  })

  it('serialize に、別のエンジンが作成した document を渡すと、TypeError が発生する', async () => {
    await explains('`serialize` の入力の検証のテストです。`XmldomXmlEngine` が作成していない document を渡した場合に、`TypeError` が発生することを確認します。')
    const engine = new XmldomXmlEngine()
    const fakeDocument = {
      selectNodes: (): readonly never[] => [],
      appendChildXml: (): void => undefined,
    }
    expect(() => engine.serialize(fakeDocument)).toThrow(TypeError)
  })

  it('selectNodes は、要素以外のノード（属性ノードなど）を返さない', async () => {
    await explains('`selectNodes` の戻り値のテストです。属性ノードを指す `//@x` を実行した場合に、要素だけを返す実装のため、空の配列が返ることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root x="1"><a x="2"/></root>', 'utf8'))
    // 属性ノードを XPath で問い合わせると libxml は Attribute を返す。
    // 我々の selectNodes は Element だけを wrap するため空配列になる。
    const attributes = document.selectNodes('//@x')
    expect(attributes.length).toBe(0)
  })

  it('ノードに対する selectNodes は、そのノードを起点にした相対パスの XPath を解釈する', async () => {
    await explains('`XmlNode` の `selectNodes` のテストです。`nsMap` を指定した場合と省略した場合のどちらでも、ノードを起点にした相対パスで、一致する 2 件のノードが返ることを確認します。')
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

  it('getAttr は、名前空間のない属性をローカル名で返し、設定されていなければ undefined を返す', async () => {
    await explains('`getAttr` のテストです。`id="42"` を持つ要素に対して `id` を指定した場合に `42` が返り、存在しない属性を指定した場合に `undefined` が返ることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><foo id="42"/></root>', 'utf8'))
    const [foo] = document.selectNodes('//foo')
    expect(foo?.getAttr('id')).toBe('42')
    expect(foo?.getAttr('missing')).toBeUndefined()
  })

  it('getAttr は、prefix:localName の形で名前空間付きの属性を取得する', async () => {
    await explains('`getAttr` のテストです。`r:id` と `other:id` を指定した場合にそれぞれの値が返り、存在しない prefix や一致しない prefix を指定した場合に `undefined` が返ることを確認します。')
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

  it('text と setText は、テキストだけの要素の値を取得し、書き換えられる', async () => {
    await explains('`text` と `setText` のテストです。`old` を持つ要素の `text` が `old` を返し、`setText` で `new` に書き換えた後の `text` が `new` を返すことを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a:t xmlns:a="urn:a">old</a:t></root>', 'utf8'))
    const [t] = document.selectNodes('//a:t', { a: 'urn:a' })
    expect(t?.text()).toBe('old')
    t?.setText('new')
    expect(t?.text()).toBe('new')
  })

  it('ノードに対する appendChildXml は、自身の子として末尾に新しい要素を追加する', async () => {
    await explains('`XmlNode` の `appendChildXml` のテストです。`parent` に 2 つの `child` を続けて追加した場合に、出力にどちらの要素も含まれることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><parent/></root>', 'utf8'))
    const [parent] = document.selectNodes('//parent')
    parent?.appendChildXml('<child id="1"/>')
    parent?.appendChildXml('<child id="2"/>')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<child id="1"/>')
    expect(out).toContain('<child id="2"/>')
  })

  it('ノードに対する appendChildXml に、不正な断片を渡すと、例外が発生する', async () => {
    await explains('`XmlNode` の `appendChildXml` のテストです。コメントだけの断片を渡した場合に、例外が発生することを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/></root>', 'utf8'))
    const [a] = document.selectNodes('//a')
    expect(() => {
      a?.appendChildXml('<!-- only comment -->')
    }).toThrow()
  })

  it('document に対する appendChildXml は、ドキュメントのルートの子として要素を追加する', async () => {
    await explains('`XmlDocument` の `appendChildXml` のテストです。`p:sld` のルートに `mc:AlternateContent` の断片を追加した場合に、出力に `mc:AlternateContent` が含まれることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from(`<p:sld xmlns:p="${NS_PRESENTATIONML}"></p:sld>`, 'utf8'))
    const fragment = `<mc:AlternateContent xmlns:mc="${NS_MARKUP_COMPATIBILITY}"/>`
    document.appendChildXml(fragment)
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('mc:AlternateContent')
  })

  it('addNextSiblingXml は、自身の直後に挿入し、最後の子の場合は末尾に追加する', async () => {
    await explains('`addNextSiblingXml` のテストです。`<root><a/><b/></root>` の `a` と `b` の後ろに `a2` と `b2` を追加した場合に、出力が `<root><a/><a2/><b/><b2/></root>` になることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><b/></root>', 'utf8'))
    const [a] = document.selectNodes('//a')
    a?.addNextSiblingXml('<a2/>')
    const [b] = document.selectNodes('//b')
    b?.addNextSiblingXml('<b2/>')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<root><a/><a2/><b/><b2/></root>')
  })

  it('getAttr に prefix のない名前を指定しても、prefix 付きの属性には一致しない', async () => {
    await explains('`getAttr` のテストです。`r:id` を持つ要素に `id` を指定した場合は `undefined` が返り、`r:id` と `plain` を指定した場合は値が返ることを確認します。')
    const engine = new XmldomXmlEngine()
    const xml = `<root xmlns:r="${NS_OFFICE_RELATIONSHIPS}"><foo r:id="rId1" plain="p"/></root>`
    const document = engine.parse(Buffer.from(xml, 'utf8'))
    const [foo] = document.selectNodes('//foo')
    expect(foo?.getAttr('id')).toBeUndefined()
    expect(foo?.getAttr('r:id')).toBe('rId1')
    expect(foo?.getAttr('plain')).toBe('p')
  })

  it('テキスト中の CR は、文字参照 &#13; として出力し、再び parse しても保つ', async () => {
    await explains('CR を含むテキストの出力のテストです。`&#13;` を含むテキストと `setText` で設定した CR が、`&#13;` として出力され、再度 `parse` した後も CR として取得できることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><t>x&#13;y</t><u>z</u></root>', 'utf8'))
    document.selectNodes('//u')[0]?.setText('a\rb')
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<t>x&#13;y</t>')
    expect(out).toContain('<u>a&#13;b</u>')
    const again = engine.parse(engine.serialize(document))
    expect(again.selectNodes('//t')[0]?.text()).toBe('x\ry')
  })

  it('serialize は、XML 宣言とルートの間の空白を取り除き、ルートの後に改行を 1 つ置く', async () => {
    await explains('`serialize` の整形のテストです。宣言の後に空白がある入力と、宣言のない入力のどちらの場合も、宣言の次の行に `<root/>` が続き、末尾が改行 1 つになることを確認します。')
    const engine = new XmldomXmlEngine()
    const withDeclaration = engine.parse(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n\t\t<root/>', 'utf8'))
    expect(engine.serialize(withDeclaration).toString('utf8'))
      .toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root/>\n')
    const withoutDeclaration = engine.parse(Buffer.from('<root/>', 'utf8'))
    expect(engine.serialize(withoutDeclaration).toString('utf8'))
      .toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root/>\n')
  })

  it('宣言されていない名前空間の prefix を含む断片を渡すと、例外が発生する', async () => {
    await explains('名前空間の検証のテストです。未宣言の `p:` を含む断片 `<p:x/>` を、`appendChildXml`・`replaceWithXml`・`addNextSiblingXml` へ渡した場合に、いずれも例外が発生することを確認します。')
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

  it('先頭に BOM（U+FEFF）がある入力も parse できる', async () => {
    await explains('BOM を含む入力の `parse` のテストです。先頭に `U+FEFF` がある XML を `parse` して `serialize` した場合に、出力に `<root/>` が含まれることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('\u{FEFF}<root/>', 'utf8'))
    const out = engine.serialize(document).toString('utf8')
    expect(out).toContain('<root/>')
  })

  it('XML 宣言がなく xml-stylesheet の処理命令で始まる入力は、その処理命令を保持する', async () => {
    await explains('処理命令を含む入力のテストです。宣言がなく `xml-stylesheet` で始まる XML を `serialize` した場合に、XML 宣言が付き、`xml-stylesheet` の処理命令がそのまま保たれることを確認します。')
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

  it('属性値の CR は文字参照のまま保ち、CDATA 中の CR は parse 時に LF へ正規化する', async () => {
    await explains('CR の扱いのテストです。属性値とテキストの `&#13;` は文字参照として出力され、CDATA の中の生の CR は `parse` の時点で LF になって出力されることを確認します。')
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

  it('selectNodes にスカラを返す XPath（count など）を渡すと、空の配列を返す', async () => {
    await explains('`selectNodes` の戻り値のテストです。`count(//a)` のように数値を返す XPath を実行した場合に、空の配列が返ることを確認します。')
    const engine = new XmldomXmlEngine()
    const document = engine.parse(Buffer.from('<root><a/><a/></root>', 'utf8'))
    expect(document.selectNodes('count(//a)')).toEqual([])
  })
})
