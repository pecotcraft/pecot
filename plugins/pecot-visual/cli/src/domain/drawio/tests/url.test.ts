// domain/drawio/url.ts の単体テスト。
// CUJ 1 の合格基準を pin する。
// 合格基準は、viewbox クエリの文字列が一致することと、`#R<base64>` の復号後 XML が一致すること。
// Python リファレンス版で事前に生成した golden ファイル（コミット済み）と比較する。
// そのためテスト実行時に Python を起動しない（acceptance (a) との自己矛盾を避ける）。

/* eslint-disable security/detect-non-literal-fs-filename */
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  calcViewbox,
  encodeData,
  generateDrawioUrl,
  prepareDrawioXml,
  renderRedirectHtml,
  resolveIconsInStyle,
  stripComments,
  validateHtml,
} from '../url.js'
import type { IconResolver } from '../types.js'
import { createIconResolver } from '../../../infra/drawio/icons.js'

// eslint-disable-next-line unicorn/no-useless-undefined -- 戻り値型が undefined を含む
const RESOLVER_NULL: IconResolver = () => undefined

const HERE = import.meta.dirname
const FIXTURES = path.resolve(HERE, '..', '..', '..', '..', 'tests', 'fixtures', 'drawio')
const GOLDEN_DIR = path.join(FIXTURES, 'golden-urls')
const ICON_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', 'assets', 'drawio-icons')

interface SplitUrl {
  readonly viewboxPart: string
  readonly base64: string
}

function split(url: string): SplitUrl {
  const hashIndex = url.indexOf('#R')
  return {
    viewboxPart: url.slice(0, hashIndex),
    base64: url.slice(hashIndex + 2),
  }
}

function decodeXml(base64: string): string {
  const inflated = inflateRawSync(Buffer.from(base64, 'base64')).toString('utf8')
  return decodeURIComponent(inflated)
}

function generateForFixture(name: string, mode: 'view' | 'edit' = 'view'): string {
  const xml = readFileSync(path.join(FIXTURES, `${name}.drawio`), 'utf8').trim()
  return generateDrawioUrl(prepareDrawioXml(xml, createIconResolver(ICON_ROOT)), { mode })
}

function readGolden(name: string): string {
  return readFileSync(path.join(GOLDEN_DIR, `${name}.url.txt`), 'utf8').trim()
}

describe('stripComments', () => {
  it('XML コメントを除去する', () => {
    expect(stripComments('a<!-- x -->b')).toBe('ab')
  })

  it('複数行コメントも除去する', () => {
    expect(stripComments('a<!-- line1\nline2 -->b')).toBe('ab')
  })

  it('コメント無しはそのまま', () => {
    expect(stripComments('<a/>')).toBe('<a/>')
  })

  it('連続するコメントを全て除去する', () => {
    expect(stripComments('a<!--x--><!--y-->b')).toBe('ab')
  })

  it('除去の跡で新しくできるコメントも除去する', () => {
    expect(stripComments('a<!-<!-- x -->- y -->b')).toBe('ab')
  })

  it('終端のないコメントはそのまま返す', () => {
    expect(stripComments('a<!-- x')).toBe('a<!-- x')
  })
})

describe('validateHtml', () => {
  it('XML パース失敗時は空配列を返す', () => {
    expect(validateHtml('not xml <<')).toEqual([])
  })

  it('value 属性に < が無いセルは対象外', () => {
    const xml = '<root><mxCell id="x" value="plain"/></root>'
    expect(validateHtml(xml)).toEqual([])
  })

  it('シングルクォート属性値を検出する', () => {
    const xml = `<root><mxCell id="a" value="&lt;font color='red'&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('シングルクォート属性値'))).toBe(true)
  })

  it('font の不正属性を検出する', () => {
    const xml = `<root><mxCell id="b" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'warning' && w.message.includes('非対応属性'))).toBe(true)
  })

  it('font color と style fontColor の二重指定を info で出す', () => {
    const xml = `<root><mxCell id="c" value="&lt;font color=&quot;#ff0000&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('二重指定'))).toBe(true)
  })

  it('font color と style fontColor が異なる時は info を出さない', () => {
    const xml = `<root><mxCell id="d" value="&lt;font color=&quot;#00ff00&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('二重指定'))).toBe(false)
  })

  it('id 属性が無い mxCell は cellId のフォールバックに疑問符を使う', () => {
    const xml = `<root><mxCell value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('mxCell id=?'))).toBe(true)
    expect(warnings.every(w => !w.message.includes('[warn]') && !w.message.includes('[info]'))).toBe(true)
  })

  it('style fontColor 指定があっても <font> に color 属性が無い場合は info を出さない', () => {
    const xml = `<root><mxCell id="e" value="&lt;font face=&quot;Inter&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('二重指定'))).toBe(false)
  })

  it('rootless でも throw しない', () => {
    expect(validateHtml('<?xml version="1.0"?>')).toEqual([])
  })

  it('先頭に BOM (U+FEFF) があっても parse に成功し警告を検出する（0 件で済ませない）', () => {
    const xml = '\u{FEFF}<root><mxCell id="a" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>'
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('非対応属性'))).toBe(true)
  })
})

describe('resolveIconsInStyle', () => {
  it('color 付き icon を resolveIcon の戻り値で置換する', () => {
    const input = '<mxCell style="image=icon://AI/foo#4f46e5;"/>'
    const result = resolveIconsInStyle(input, () => 'data:image/svg+xml,XYZ')
    expect(result).toContain('image=data:image/svg+xml,XYZ')
  })

  it('color なし icon も置換する', () => {
    const input = '<mxCell style="image=icon://AI/foo;"/>'
    const result = resolveIconsInStyle(input, () => 'data:image/svg+xml,XYZ')
    expect(result).toContain('image=data:image/svg+xml,XYZ')
  })

  it('resolveIcon が undefined を返したら icon:// を温存する', () => {
    const input = '<mxCell style="image=icon://X/Y#abc;"/>'
    const result = resolveIconsInStyle(input, RESOLVER_NULL)
    expect(result).toContain('image=icon://X/Y')
  })

  it('style 属性外の icon:// は対象外', () => {
    const input = '<mxCell value="icon://AI/foo">x</mxCell>'
    const result = resolveIconsInStyle(input, () => 'DATA')
    expect(result).toContain('value="icon://AI/foo"')
  })
})

describe('calcViewbox', () => {
  it('mxGeometry が無い XML では空文字を返す', () => {
    expect(calcViewbox('<root/>')).toBe('')
  })

  it('XML パース失敗時は空文字を返す', () => {
    expect(calcViewbox('not xml <<')).toBe('')
  })

  it('rootless XML でも空文字を返す', () => {
    expect(calcViewbox('<?xml version="1.0"?>')).toBe('')
  })

  it('w=0 h=0 の geometry は無視する', () => {
    const xml = '<root><mxGeometry x="0" y="0" width="0" height="0" as="geometry"/></root>'
    expect(calcViewbox(xml)).toBe('')
  })

  it('as が geometry でない mxGeometry は無視する', () => {
    const xml = '<root><mxGeometry x="0" y="0" width="100" height="100" as="sourcePoint"/></root>'
    expect(calcViewbox(xml)).toBe('')
  })

  it('属性欠落は 0 として扱う', () => {
    const xml = '<root><mxGeometry width="50" height="40" as="geometry"/></root>'
    expect(calcViewbox(xml)).toContain('viewbox=')
  })

  it('数値以外の属性は 0 として扱う', () => {
    const xml = '<root><mxGeometry x="abc" width="50" height="40" as="geometry"/></root>'
    expect(calcViewbox(xml)).toContain('viewbox=')
  })

  it('Python json.dumps と同形のスペース付き JSON を出す', () => {
    const xml = '<root><mxGeometry x="40" y="40" width="200" height="40" as="geometry"/></root>'
    const result = calcViewbox(xml)
    // ": " と ", " で区切られていること（pythonQuote 後の % エンコード値）
    expect(result).toContain('%22x%22%3A%2020')
  })
})

describe('encodeData', () => {
  it('XML を encodeURIComponent → deflateRaw → base64 で返す', () => {
    const result = encodeData('<a/>')
    expect(result).toMatch(/^[a-z0-9+/=]+$/i)
    const inflated = inflateRawSync(Buffer.from(result, 'base64')).toString('utf8')
    expect(decodeURIComponent(inflated)).toBe('<a/>')
  })
})

describe('generateDrawioUrl', () => {
  it('viewbox なしの XML では `?` も省略する', () => {
    const url = generateDrawioUrl('<a/>', { mode: 'view' })
    expect(url.startsWith('https://app.diagrams.net/#R')).toBe(true)
  })

  it('view と edit は同一 URL を返す（mode は no-op）', () => {
    const viewUrl = generateForFixture('minimal', 'view')
    const editUrl = generateForFixture('minimal', 'edit')
    expect(viewUrl).toBe(editUrl)
  })

  it('minimal fixture: viewbox 部が golden と完全一致', () => {
    const tsUrl = generateForFixture('minimal')
    const goldenUrl = readGolden('minimal')
    expect(split(tsUrl).viewboxPart).toBe(split(goldenUrl).viewboxPart)
  })

  it('minimal fixture: 復号後 XML が golden と一致', () => {
    const tsUrl = generateForFixture('minimal')
    const goldenUrl = readGolden('minimal')
    expect(decodeXml(split(tsUrl).base64)).toBe(decodeXml(split(goldenUrl).base64))
  })

  it('icon-included fixture: viewbox 部が golden と完全一致', () => {
    const tsUrl = generateForFixture('icon-included')
    const goldenUrl = readGolden('icon-included')
    expect(split(tsUrl).viewboxPart).toBe(split(goldenUrl).viewboxPart)
  })

  it('icon-included fixture: 復号後 XML（icon:// data URI 解決済）が golden と一致', () => {
    const tsUrl = generateForFixture('icon-included')
    const goldenUrl = readGolden('icon-included')
    expect(decodeXml(split(tsUrl).base64)).toBe(decodeXml(split(goldenUrl).base64))
  })
})

describe('renderRedirectHtml', () => {
  // 実 draw.io URL に出る文字は、英数字と記号 `: / . = # % _ ~ - +` と疑問符だけ。
  // HTML 属性を傷つける文字は現れない。
  // エスケープの退行は、この合成 URL でしか観測できない。
  const RAW_URL = `https://example.com/?a=1&b=2&q="x"&lt=<&gt=>&apos='`
  const ESCAPED_URL = `https://example.com/?a=1&amp;b=2&amp;q=&quot;x&quot;&amp;lt=&lt;&amp;gt=&gt;&amp;apos='`

  it('URL は meta refresh と可視リンクの 2 箇所だけに同じエスケープ済文字列で現れる', () => {
    const html = renderRedirectHtml(RAW_URL)
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${ESCAPED_URL}">`)
    expect(html).toContain(`<a id="target" href="${ESCAPED_URL}">`)
    expect(html.split(ESCAPED_URL)).toHaveLength(3)
    // 生の `&` `<` `>` と二重引用符が属性に残っていれば、HTML が不正になる。
    // 単引用符は属性の区切りでないため、そのまま残る。
    expect(html).not.toContain(RAW_URL)
  })

  it('JS には URL を埋め込まず、可視リンクの href を読んで遷移する', () => {
    const html = renderRedirectHtml(RAW_URL)
    expect(html).toContain(`<script>location.replace(document.getElementById('target').href)</script>`)
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'))
    expect(script).not.toContain('example.com')
  })

  it('charset 宣言が先頭 1024 バイト以内にある（長大 URL でも）', () => {
    // file:// には Content-Type が無く、encoding sniffing の窓は先頭 1024 バイトしかない。
    // URL が charset より前に来ると日本語ラベルが化ける。
    const longUrl = `https://app.diagrams.net/?viewbox=x#R${'A'.repeat(20_000)}`
    const head = Buffer.from(renderRedirectHtml(longUrl), 'utf8').subarray(0, 1024).toString('utf8')
    expect(head).toContain('<meta charset="utf-8">')
  })

  it('同じ URL からは常に同じバイト列になる（非決定的要素を含まない）', () => {
    expect(renderRedirectHtml(RAW_URL)).toBe(renderRedirectHtml(RAW_URL))
  })

  it('BOM 無し・LF 改行で終端も改行 1 個', () => {
    const html = renderRedirectHtml(RAW_URL)
    expect(html.startsWith('<!doctype html>\n')).toBe(true)
    expect(html).not.toContain('\r')
    expect(html.endsWith('</html>\n')).toBe(true)
    expect(Buffer.from(html, 'utf8').subarray(0, 3).toString('hex')).not.toBe('efbbbf')
  })
})

describe('XML 名前空間を含む drawio XML の扱い', () => {
  // 未宣言の prefix は xmldom が NamespaceError にするため、parse 失敗として対象外になる。
  // draw.io (mxGraph) の XML は名前空間を使わないため、実運用では通常ここに来ない。
  it('未宣言の名前空間 prefix を含む XML は parse 失敗として空を返す', () => {
    const xml = '<root><mxCell id="a" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;">'
      + '<mxGeometry x="10" y="20" width="30" height="40" as="geometry"/></mxCell><x:extra/></root>'
    expect(validateHtml(xml)).toEqual([])
    expect(calcViewbox(xml)).toBe('')
  })

  // 要素の列挙は名前空間を見ない。
  // そのため default namespace 宣言があっても、mxCell / mxGeometry を対象にする。
  it('default namespace 宣言付きの XML でも mxCell / mxGeometry を対象にする', () => {
    const xml = '<mxGraphModel xmlns="urn:mx"><root>'
      + '<mxCell id="b" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;">'
      + '<mxGeometry x="10" y="20" width="30" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
    expect(validateHtml(xml)).toHaveLength(1)
    expect(calcViewbox(xml)).toContain('viewbox=')
  })
})
