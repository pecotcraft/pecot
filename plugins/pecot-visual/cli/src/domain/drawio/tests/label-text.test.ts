// domain/drawio/label-text.ts の単体テスト。図のセルが表示する文言を、文章規則に渡す形で取り出す。
import { describe, expect, it } from 'vitest'

import { labelTexts } from '../label-text.js'
import { encodeData } from '../url.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('セルの value を、セルの id を示す item と組にして返す', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`value` を持つセルが 1 つの場合に、セルの id を示す `item` と文章を組にした配列を返すことを確認します。')
    const xml = diagram('<mxCell id="n1" value="処理の流れ" style="rounded=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '処理の流れ' }])
  })

  it('object と UserObject の場合は、label を文章として使い、item を外側の要素の id にする', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`object` や `UserObject` がセルを包んでいる場合に、`label` を文章として返し、`item` が外側の要素の id になることを確認します。')
    const xml = diagram(
      '<object id="o1" label="包まれた文言"><mxCell style="rounded=1;" vertex="1" parent="1"/></object>'
      + '<UserObject id="u1" label="別の文言"><mxCell vertex="1" parent="1"/></UserObject>',
    )
    expect(labelTexts(xml)).toStrictEqual([
      { item: 'mxCell id="o1"', text: '包まれた文言' },
      { item: 'mxCell id="u1"', text: '別の文言' },
    ])
  })

  it('style に html=1 があるセルは、HTML として解釈し、文字参照を復号してタグを取り除く', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`html=1` のセルの `value` に、タグと `&amp;` や `&lt;` などの文字参照が含まれる場合に、タグを取り除き、文字参照を復号した文章を返すことを確認します。')
    const xml = diagram(
      '<mxCell id="n1" value="&lt;b&gt;太字&lt;/b&gt;と&amp;amp;と&amp;lt;記号&amp;gt;&amp;nbsp;末尾" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '太字と&と<記号> 末尾' }])
  })

  it('style に html=1 があるセルは、br タグと、div と li の区切りを改行にする', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`html=1` のセルの `value` に `br` タグや、`div`・`li` の要素が含まれる場合に、それぞれの区切りを改行にした文章を返すことを確認します。')
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

  it('style に html=1 がない value は、タグのように見える文字も、そのまま返す', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`html=1` がないセルの `value` に `<b>` のような文字が含まれる場合に、HTML として解釈せず、文字のまま返すことを確認します。')
    const xml = diagram('<mxCell id="n1" value="a &lt;b&gt; c" style="rounded=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: 'a <b> c' }])
  })

  it('閉じられていないタグを含む HTML は、タグだけを取り除いて返す', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`html=1` のセルの `value` が `<b>太字` のように閉じられていないタグを含む場合に、タグだけを取り除いた文章を返すことを確認します。')
    const xml = diagram('<mxCell id="n1" value="&lt;b&gt;太字" style="html=1;" vertex="1" parent="1"/>')
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '太字' }])
  })

  it('HTML として解釈できない場合の代替処理でも、主な文字参照を 1 回だけ復号する', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。HTML として解釈できない場合の代替処理でも、`&amp;` や `&lt;` などの主な文字参照を復号し、`&amp;nbsp;` を二重に復号しないことを確認します。')
    const xml = diagram(
      '<mxCell id="n1" value="&lt;b&gt;A&amp;amp;B&amp;nbsp;C&amp;lt;D&amp;gt;E&amp;quot;F&amp;#39;G&amp;amp;nbsp;H" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: 'A&B C<D>E"F\'G&nbsp;H' }])
  })

  it('空の value と、タグだけで文字のない HTML は、結果に含めない', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。`value` が空のセルと、`<br>` のようにタグだけで文字を含まない HTML のセルを渡した場合に、空の配列を返すことを確認します。')
    const xml = diagram(
      '<mxCell id="n1" value="" vertex="1" parent="1"/>'
      + '<mxCell id="n2" vertex="1" parent="1"/>'
      + '<mxCell id="n3" value="&lt;br&gt;" style="html=1;" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml)).toStrictEqual([])
  })

  it('同じ文章を持つセルが 2 つある場合は、2 件返す', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。同じ文章を持つセルが 2 つある場合に、まとめず、それぞれの `item` を持つ 2 件を返すことを確認します。')
    const xml = diagram(
      '<mxCell id="a" value="同じ文言" vertex="1" parent="1"/><mxCell id="b" value="同じ文言" vertex="1" parent="1"/>',
    )
    expect(labelTexts(xml).map(label => label.item)).toStrictEqual(['mxCell id="a"', 'mxCell id="b"'])
  })

  it('XML として解釈できない入力は、空の配列を返す', async () => {
    await explains('draw.io の図のセルが表示する文章を取り出す `labelTexts` のテストです。閉じられていない XML のように、XML として解釈できない入力を渡した場合に、空の配列を返すことを確認します。')
    expect(labelTexts('<mxfile><diagram>')).toStrictEqual([])
  })

  describe('圧縮形式の <diagram>', () => {
    it('圧縮された diagram は、展開してセルの文章を返す', async () => {
      await explains('圧縮された `diagram` からセルの文章を取り出す `labelTexts` のテストです。圧縮形式の `diagram` を渡した場合に、展開して、セルの文章を返すことを確認します。')
      const xml = `<mxfile>${compressed('d1', '<mxCell id="n1" value="圧縮の文言" vertex="1" parent="1"/>')}</mxfile>`
      expect(labelTexts(xml)).toStrictEqual([{ item: 'mxCell id="n1"', text: '圧縮の文言' }])
    })

    it('複数の diagram をすべて読み取り、圧縮されたものと、圧縮されていないものが混在していても対応する', async () => {
      await explains('圧縮された `diagram` からセルの文章を取り出す `labelTexts` のテストです。圧縮されていない `mxGraphModel` と、圧縮された `diagram` が混在した複数の `diagram` を渡した場合に、すべての文章を順番に返すことを確認します。')
      const xml = '<mxfile>'
        + '<diagram id="a" name="a">' + MODEL('<mxCell id="n1" value="直接" vertex="1" parent="1"/>') + '</diagram>'
        + compressed('b', '<mxCell id="n2" value="圧縮一" vertex="1" parent="1"/>')
        + compressed('c', '<mxCell id="n3" value="圧縮二" vertex="1" parent="1"/>')
        + '</mxfile>'
      expect(labelTexts(xml).map(label => label.text)).toStrictEqual(['直接', '圧縮一', '圧縮二'])
    })

    it('展開できない圧縮の内容の場合は、結果を返さず、例外が発生する', async () => {
      await explains('圧縮された `diagram` からセルの文章を取り出す `labelTexts` のテストです。圧縮として展開できない内容の場合に、文章の確認を通さず、`could not be expanded` を含む例外が発生することを確認します。')
      const xml = '<mxfile><diagram id="broken" name="p">%%%これは圧縮ではない%%%</diagram></mxfile>'
      expect(() => labelTexts(xml)).toThrow('cannot check the text: compressed diagram (id="broken") could not be expanded')
    })
  })
})
