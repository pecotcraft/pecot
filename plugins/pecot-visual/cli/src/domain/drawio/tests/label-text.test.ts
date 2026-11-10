// domain/drawio/label-text.ts の単体テスト。図のセルが表示する文言を、文章規則に渡す形で取り出す。
import { describe, expect, it } from 'vitest'

import { labelTexts } from '../label-text.js'
import { encodeData } from '../url.js'

function diagram(cells: string): string {
  return `<mxfile><diagram id="d" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`
}

function MODEL(cells: string): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`
}

function compressed(id: string, cells: string): string {
  return `<diagram id="${id}" name="p">${encodeData(MODEL(cells))}</diagram>`
}

describe('labelTexts', () => {
  it('value を item 付きで返す。item は mxCell id', () => {
    const xml = diagram('<mxCell id="n1" value="処理の流れ" style="rounded=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '処理の流れ' }])
  })

  it('object / UserObject の label を使い、item は包む要素の id にする', () => {
    const xml = diagram(
      '<object id="o1" label="包まれた文言"><mxCell style="rounded=1;" vertex="1" parent="1"/></object>'
      + '<UserObject id="u1" label="別の文言"><mxCell vertex="1" parent="1"/></UserObject>',
    )
    expect(labelTexts(xml)).toStrictEqual([
      { item: 'mxCell id="o1"', text: '包まれた文言' },
      { item: 'mxCell id="u1"', text: '別の文言' },
    ])
  })

  it('html=1 のセルは HTML として読み、実体を復号し、タグを除く', () => {
    const xml = diagram(
      '<mxCell id="n1" value="&lt;b&gt;太字&lt;/b&gt;と&amp;amp;と&amp;lt;記号&amp;gt;&amp;nbsp;末尾" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '太字と&と<記号> 末尾' }])
  })

  it('html=1 の <br> と div / p / li の境界は改行にする', () => {
    const xml = diagram(
      '<mxCell id="n1" value="一行目&lt;br&gt;二行目&lt;br/&gt;三行目" style="whiteSpace=wrap;html=1;" vertex="1" parent="1"/>'
      + '<mxCell id="n2" value="&lt;div&gt;段落一&lt;/div&gt;&lt;div&gt;段落二&lt;/div&gt;" style="html=1;" vertex="1" parent="1"/>'
      + '<mxCell id="n3" value="&lt;ul&gt;&lt;li&gt;項目一&lt;/li&gt;&lt;li&gt;項目二&lt;/li&gt;&lt;/ul&gt;" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml).map(label => label.text)).toStrictEqual([
      '一行目\n二行目\n三行目',
      '段落一\n段落二',
      '項目一\n項目二',
    ])
  })

  it('html=1 でない value は、タグに見える文字もそのまま返す', () => {
    const xml = diagram('<mxCell id="n1" value="a &lt;b&gt; c" style="rounded=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: 'a <b> c' }])
  })

  it('閉じていないタグを含む HTML は、タグだけを除いて返す', () => {
    const xml = diagram('<mxCell id="n1" value="&lt;b&gt;太字" style="html=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '太字' }])
  })

  it('HTML として読めないときの退避でも、主要な実体を復号する（二重には復号しない）', () => {
    const xml = diagram(
      '<mxCell id="n1" value="&lt;b&gt;A&amp;amp;B&amp;nbsp;C&amp;lt;D&amp;gt;E&amp;quot;F&amp;#39;G&amp;amp;nbsp;H" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: 'A&B C<D>E"F\'G&nbsp;H' }])
  })

  it('空の value と、タグだけで文字の無い HTML は含めない', () => {
    const xml = diagram(
      '<mxCell id="n1" value="" vertex="1" parent="1"/>'
      + '<mxCell id="n2" vertex="1" parent="1"/>'
      + '<mxCell id="n3" value="&lt;br&gt;" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([])
  })

  it('同じ文言の 2 セルは 2 件返す', () => {
    const xml = diagram(
      '<mxCell id="a" value="同じ文言" vertex="1" parent="1"/><mxCell id="b" value="同じ文言" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml).map(label => label.item)).toStrictEqual(['mxCell id="a"', 'mxCell id="b"'])
  })

  it('XML として読めない入力は空を返す', () => {
    expect(labelTexts('<mxfile><diagram>')).toStrictEqual([])
  })

  describe('圧縮形式の <diagram>', () => {
    it('展開してセルの文言を返す', () => {
      const xml = `<mxfile>${compressed('d1', '<mxCell id="n1" value="圧縮の文言" vertex="1" parent="1"/>')}</mxfile>`
      expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '圧縮の文言' }])
    })

    it('複数の diagram をすべて読む。直接の mxGraphModel と圧縮が並んでいてもよい', () => {
      const xml = '<mxfile>'
        + '<diagram id="a" name="a">' + MODEL('<mxCell id="n1" value="直接" vertex="1" parent="1"/>') + '</diagram>'
        + compressed('b', '<mxCell id="n2" value="圧縮一" vertex="1" parent="1"/>')
        + compressed('c', '<mxCell id="n3" value="圧縮二" vertex="1" parent="1"/>')
        + '</mxfile>'
      expect(labelTexts(xml).map(label => label.text)).toStrictEqual(['直接', '圧縮一', '圧縮二'])
    })

    it('展開できない中身は、通さずに投げる', () => {
      const xml = '<mxfile><diagram id="broken" name="p">%%%これは圧縮ではない%%%</diagram></mxfile>'
      expect(() => labelTexts(xml)).toThrow('cannot check the text: compressed diagram (id="broken") could not be expanded')
    })
  })
})
