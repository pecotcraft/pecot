// domain/drawio/url.ts の validateWhitespaceWrap に対する境界値テスト。
// box 系判定 (isBoxShape) と折り返し必須判定 (WRAP_REQUIRED_REGEX) の組み合わせを網羅する。
// preview 整形 (surrogate pair / CRLF エスケープ / 20 文字超 ellipsis) も網羅する。
//
// 注: XML attribute value 内に literal `<br/>` を書くと XML 仕様違反になる (`<` は entity 必須)。
// drawio HTML mode でも、attribute 越境で到達するのは entity 化された形だけ。
// そのため生 `<br/>` パターンのテストは entity 経由 (`&lt;br/&gt;`) のみで担保する。

import { describe, expect, it } from 'vitest'

import { validateWhitespaceWrap } from '../../../../src/domain/drawio/url.js'
import { explains } from '../../../_helpers/explains.js'

function wrap(cellAttributes: string, value: string): string {
  const valueAttribute = value === '' ? '' : ` value="${value}"`
  return `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="x" ${cellAttributes}${valueAttribute}>
      <mxGeometry x="0" y="0" width="100" height="40" as="geometry"/>
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`
}

// 半角カナの fixture。リテラルで持つと文面の規則に掛かるため、コードポイントから組み立てる
const HANKAKU_KANA = String.fromCodePoint(0xFF_71, 0xFF_72, 0xFF_73)

describe('validateWhitespaceWrap', () => {
  it('半角英数字だけの value には、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`Hello world` のような半角英数字だけの `value` を持つセルを渡した場合に、警告を返さないことを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'Hello world')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('改行を含み、角丸で折り返し指定のないセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` に改行を含み、`whiteSpace=wrap` を持たないセルを渡した場合に、警告が 1 件だけ返り、エスケープした文字列が含まれることを確認します。')
    // XML attribute では生の `\n` は normalize で空白に潰れるため、数値文字参照で渡す
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'line1&#10;line2')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.severity).toBe('warning')
    expect(warnings[0]?.message).toContain('mxCell id=x')
    expect(warnings[0]?.message).toContain('whiteSpace=wrap')
    expect(warnings[0]?.message).toContain(String.raw`line1\nline2`)
  })

  it('br タグを含み、楕円で折り返し指定のないセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` に `<br/>` を含む楕円のセルで、`whiteSpace=wrap` がない場合に、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="ellipse;fillColor=#fff;"', 'a&lt;br/&gt;b')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('mxCell id=x')
  })

  it('和文を含んでいても、折り返しを指定したセルには、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が和文で、style に `whiteSpace=wrap` を持つセルを渡した場合に、警告を返さないことを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;whiteSpace=wrap;fillColor=#fff;"', '日本語テキスト')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('和文を含み、shape が楕円で折り返し指定のないセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が和文で `shape=ellipse` のセルに、`whiteSpace=wrap` がない場合に、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="shape=ellipse;fillColor=#fff;"', '円のラベル')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('円のラベル')
  })

  it('和文を含み、AWS の図形で折り返し指定のないセルにも、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が和文で `shape=mxgraph.aws4.lambda` のセルに、`whiteSpace=wrap` がない場合に、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="sketch=0;points=[[0,0,0]];shape=mxgraph.aws4.lambda;"', 'AWS ラムダ')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('AWS ラムダ')
  })

  it('和文を含んでいても、線（edgeStyle を指定したセル）には、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が和文で、style が `edgeStyle=orthogonalEdgeStyle` のセルを渡した場合に、図形ではなく線として扱い、警告を返さないことを確認します。')
    const xml = wrap('vertex="1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;"', 'エッジラベル')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('和文を含んでいても、style の後ろの項目に whiteSpace=wrap があれば、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`text;rounded=1;whiteSpace=wrap;` のように、`whiteSpace=wrap` が末尾の style でも、折り返し指定として扱い、警告を返さないことを確認します。')
    const xml = wrap('vertex="1" style="text;rounded=1;whiteSpace=wrap;"', '順序違いテスト')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('和文を含んでいても、vertex 属性のないセルには、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が和文で、`vertex` 属性を持たないセルを渡した場合に、頂点ではないセルとして扱い、警告を返さないことを確認します。')
    const xml = wrap('style="rounded=1;fillColor=#fff;"', '頂点でない')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('XML として読み取れない文字列を渡した場合は、例外を発生させず、警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`<root><unclosed>` のように閉じていない XML を渡した場合に、例外が発生せず、警告を返さないことを確認します。')
    expect(validateWhitespaceWrap('<root><unclosed>')).toEqual([])
  })

  it('全角記号だけの value で、折り返し指定のない角丸のセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が `※注意` の角丸のセルに、`whiteSpace=wrap` がない場合に、非 ASCII の文字として扱い、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '※注意')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('※注意')
  })

  it('半角カナの value で、折り返し指定のない角丸のセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が半角カナの角丸のセルに、`whiteSpace=wrap` がない場合に、非 ASCII の文字として扱い、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', HANKAKU_KANA)
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain(HANKAKU_KANA)
  })

  it('記号の `✓` を含む value で、折り返し指定のない角丸のセルには、警告を 1 件返す', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が `✓done` の角丸のセルに、`whiteSpace=wrap` がない場合に、非 ASCII の記号として扱い、警告を 1 件だけ返すことを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '✓done')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('✓done')
  })

  it('メッセージに載せる文字列は 20 文字で切って末尾に … を付け、サロゲートペアの文字も 1 文字として数える', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` が `🚀` を 25 個並べた文字列の場合に、メッセージには先頭の 20 個と `…` だけを含め、サロゲートペアの途中で切らないことを確認します。')
    // 🚀 (U+1F680) は surrogate pair (UTF-16 で 2 code unit) だが、code point 1 文字として扱う。
    // value は 🚀×25 で 25 code point。preview は先頭 20 code point + …。
    const rocket = '🚀'.repeat(25)
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', rocket)
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain('…')
    // preview 部分に 🚀 が 20 個含まれること (surrogate pair の中途切断が起きていない)
    const expectedPreview = '🚀'.repeat(20)
    expect(warnings[0]?.message).toContain(`"${expectedPreview}…"`)
  })

  it('CRLF の改行を含み、折り返し指定のないセルには、警告を 1 件返し、メッセージの改行をエスケープして表示する', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`value` に CRLF を含み、`whiteSpace=wrap` を持たないセルを渡した場合に、警告が 1 件だけ返り、メッセージにエスケープした文字列 `a\\r\\nb` が含まれることを確認します。')
    // &#13;&#10; で CRLF を attribute 値に埋め込む (normalize 回避)
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'a&#13;&#10;b')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toContain(String.raw`a\r\nb`)
  })
})

describe('XML 名前空間を含む drawio XML の扱い', () => {
  it('宣言されていない名前空間の接頭辞を含む XML は、読み取りに失敗したものとして警告を返さない', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`<x:extra/>` のように、名前空間が宣言されていない接頭辞を含む XML を渡した場合に、警告を返さないことを確認します。')
    const xml = '<root><mxCell id="a" value="日本語" vertex="1" style="rounded=0;"/><x:extra/></root>'
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('既定の名前空間を宣言した XML でも、mxCell の折り返し指定を判定する', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。`<mxGraphModel xmlns="urn:mx">` のように既定の名前空間を宣言した XML で、折り返し指定のない和文のセルを渡した場合に、警告が 1 件返ることを確認します。')
    const xml = '<mxGraphModel xmlns="urn:mx"><root>'
      + '<mxCell id="b" value="日本語" vertex="1" style="rounded=0;"/></root></mxGraphModel>'
    expect(validateWhitespaceWrap(xml)).toHaveLength(1)
  })

  it('警告のメッセージに、style へ whiteSpace=wrap を追加する直し方を含める', async () => {
    await explains('図のセルの折り返し指定を判定する `validateWhitespaceWrap` のテストです。折り返し指定のない和文のセルを渡した場合に、メッセージに `add whiteSpace=wrap to style` が含まれる警告が返ることを確認します。')
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '日本語テキスト')
    expect(validateWhitespaceWrap(xml)[0]?.message).toContain('add whiteSpace=wrap to style')
  })
})
