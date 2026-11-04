// domain/drawio/url.ts の validateWhitespaceWrap に対する境界値テスト。
// box 系判定 (isBoxShape) と折り返し必須判定 (WRAP_REQUIRED_REGEX) の組み合わせを網羅する。
// preview 整形 (surrogate pair / CRLF エスケープ / 20 文字超 ellipsis) も網羅する。
//
// 注: XML attribute value 内に literal `<br/>` を書くと XML 仕様違反になる (`<` は entity 必須)。
// drawio HTML mode でも、attribute 越境で到達するのは entity 化された形だけ。
// そのため生 `<br/>` パターンのテストは entity 経由 (`&lt;br/&gt;`) のみで担保する。

import { describe, expect, it } from 'vitest'

import { validateWhitespaceWrap } from '../../../../src/domain/drawio/url.js'

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
  it('半角英数のみの value は警告 0', () => {
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'Hello world')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('改行のみ + rounded=1 + wrap 無し → 警告 1', () => {
    // XML attribute では生の `\n` は normalize で空白に潰れるため、数値文字参照で渡す
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'line1&#10;line2')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('mxCell id=x')
    expect(warnings[0]).toContain('whiteSpace=wrap')
    expect(warnings[0]).toContain(String.raw`line1\nline2`)
  })

  it('<br/> のみ + ellipse + wrap 無し → 警告 1', () => {
    const xml = wrap('vertex="1" style="ellipse;fillColor=#fff;"', 'a&lt;br/&gt;b')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('mxCell id=x')
  })

  it('日本語あり + whiteSpace=wrap あり → 警告 0', () => {
    const xml = wrap('vertex="1" style="rounded=1;whiteSpace=wrap;fillColor=#fff;"', '日本語テキスト')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('日本語あり + shape=ellipse + wrap 無し → 警告 1', () => {
    const xml = wrap('vertex="1" style="shape=ellipse;fillColor=#fff;"', '円のラベル')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('円のラベル')
  })

  it('日本語あり + shape=mxgraph.aws4.lambda + wrap 無し → 警告 1 (AWS shape を捕捉)', () => {
    const xml = wrap('vertex="1" style="sketch=0;points=[[0,0,0]];shape=mxgraph.aws4.lambda;"', 'AWS ラムダ')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('AWS ラムダ')
  })

  it('日本語あり + edgeStyle=orthogonalEdgeStyle (edge) → 警告 0', () => {
    const xml = wrap('vertex="1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;"', 'エッジラベル')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('日本語ありで、後方 segment の style に whiteSpace=wrap がある → 警告 0 (segment 検出の堅牢性)', () => {
    const xml = wrap('vertex="1" style="text;rounded=1;whiteSpace=wrap;"', '順序違いテスト')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('日本語あり + vertex 属性欠落 → 警告 0', () => {
    const xml = wrap('style="rounded=1;fillColor=#fff;"', '頂点でない')
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('パース不能 XML → 警告 0 (例外を投げない)', () => {
    expect(validateWhitespaceWrap('<root><unclosed>')).toEqual([])
  })

  it('全角記号のみ value + rounded=1 + wrap 無し → 警告 1 (非 ASCII 拡張カバレッジ)', () => {
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '※注意')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('※注意')
  })

  it('半角カナ value + rounded=1 + wrap 無し → 警告 1 (非 ASCII 拡張カバレッジ)', () => {
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', HANKAKU_KANA)
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(HANKAKU_KANA)
  })

  it('絵文字含む value + rounded=1 + wrap 無し → 警告 1 (非 ASCII 拡張カバレッジ)', () => {
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '✓done')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('✓done')
  })

  it('preview が 20 code point 超で … が付き、surrogate pair も文字単位で切れる', () => {
    // 🚀 (U+1F680) は surrogate pair (UTF-16 で 2 code unit) だが、code point 1 文字として扱う。
    // value は 🚀×25 で 25 code point。preview は先頭 20 code point + …。
    const rocket = '🚀'.repeat(25)
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', rocket)
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('…')
    // preview 部分に 🚀 が 20 個含まれること (surrogate pair の中途切断が起きていない)
    const expectedPreview = '🚀'.repeat(20)
    expect(warnings[0]).toContain(`"${expectedPreview}…"`)
  })

  it('CRLF 含む value + rounded=1 + wrap 無し → 警告 1 + preview に CRLF がエスケープされる', () => {
    // &#13;&#10; で CRLF を attribute 値に埋め込む (normalize 回避)
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', 'a&#13;&#10;b')
    const warnings = validateWhitespaceWrap(xml)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(String.raw`a\r\nb`)
  })
})

describe('XML 名前空間を含む drawio XML の扱い', () => {
  it('未宣言の名前空間 prefix を含む XML は parse 失敗として警告を返さない', () => {
    const xml = '<root><mxCell id="a" value="日本語" vertex="1" style="rounded=0;"/><x:extra/></root>'
    expect(validateWhitespaceWrap(xml)).toEqual([])
  })

  it('default namespace 宣言付きの XML でも mxCell を確かめる', () => {
    const xml = '<mxGraphModel xmlns="urn:mx"><root>'
      + '<mxCell id="b" value="日本語" vertex="1" style="rounded=0;"/></root></mxGraphModel>'
    expect(validateWhitespaceWrap(xml)).toHaveLength(1)
  })

  it('警告文に直し方（style に whiteSpace=wrap を付ける）が入っている (F-17)', () => {
    const xml = wrap('vertex="1" style="rounded=1;fillColor=#fff;"', '日本語テキスト')
    expect(validateWhitespaceWrap(xml)[0]).toContain('style に whiteSpace=wrap を付けてください')
  })
})
