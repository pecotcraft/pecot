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
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('XML コメントを取り除く', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。`a<!-- x -->b` のようにコメントを含む文字列を渡した場合に、コメントだけを取り除いた `ab` を返すことを確認します。')
    expect(stripComments('a<!-- x -->b')).toBe('ab')
  })

  it('複数行にわたるコメントも取り除く', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。改行を含む複数行のコメントを渡した場合でも、コメント全体を取り除くことを確認します。')
    expect(stripComments('a<!-- line1\nline2 -->b')).toBe('ab')
  })

  it('コメントを含まない文字列は、そのまま返す', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。コメントを含まない `<a/>` を渡した場合に、変更せずに返すことを確認します。')
    expect(stripComments('<a/>')).toBe('<a/>')
  })

  it('連続する複数のコメントを、すべて取り除く', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。コメントが続けて 2 つある場合に、どちらも取り除くことを確認します。')
    expect(stripComments('a<!--x--><!--y-->b')).toBe('ab')
  })

  it('コメントを取り除いた結果として新たに現れるコメントも、取り除く', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。コメントの中にコメントの一部が入り込んでいて、取り除くと新しいコメントができる場合に、その新しいコメントも取り除くことを確認します。')
    expect(stripComments('a<!-<!-- x -->- y -->b')).toBe('ab')
  })

  it('終わりの `-->` がないコメントは、取り除かず、そのまま返す', async () => {
    await explains('XML からコメントを取り除く `stripComments` のテストです。`a<!-- x` のように閉じられていないコメントを渡した場合に、変更せずに返すことを確認します。')
    expect(stripComments('a<!-- x')).toBe('a<!-- x')
  })
})

describe('validateHtml', () => {
  it('XML として解釈できない場合は、空の配列を返す', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。XML として解釈できない文字列を渡した場合に、警告を返さず、空の配列を返すことを確認します。')
    expect(validateHtml('not xml <<')).toEqual([])
  })

  it('value 属性に < を含まないセルは、検出の対象にしない', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`value` 属性が HTML を含まない文章のセルを渡した場合に、警告を返さないことを確認します。')
    const xml = '<root><mxCell id="x" value="plain"/></root>'
    expect(validateHtml(xml)).toEqual([])
  })

  it('属性値がシングルクォートで囲まれている場合は、警告を検出する', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。属性値をシングルクォートで囲んだ HTML を渡した場合に、`single-quoted attribute value` の警告を返すことを確認します。')
    const xml = `<root><mxCell id="a" value="&lt;font color='red'&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('single-quoted attribute value'))).toBe(true)
  })

  it('font タグに対応していない属性がある場合は、警告を検出する', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`font` タグに `weight` のような対応していない属性がある場合に、重大度が `warning` の `unsupported <font> attribute` を返すことを確認します。')
    const xml = `<root><mxCell id="b" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'warning' && w.message.includes('unsupported <font> attribute'))).toBe(true)
  })

  it('font の color と style の fontColor が同じ値の場合は、重大度 note の通知を返す', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`font` タグの `color` と `style` の `fontColor` が同じ色の場合に、同じ値を 2 回指定していることを示す、重大度 `note` の通知を返すことを確認します。')
    const xml = `<root><mxCell id="c" value="&lt;font color=&quot;#ff0000&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('specify the same value twice'))).toBe(true)
  })

  it('font の color と style の fontColor が異なる値の場合は、note の通知を返さない', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`font` タグの `color` と `style` の `fontColor` が異なる色の場合に、同じ値を 2 回指定していることを示す通知を返さないことを確認します。')
    const xml = `<root><mxCell id="d" value="&lt;font color=&quot;#00ff00&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('specify the same value twice'))).toBe(false)
  })

  it('id 属性がない mxCell は、メッセージの中で id の代わりに疑問符を表示する', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`id` 属性がない `mxCell` の場合に、メッセージの中で `mxCell id=?` と表し、`[warn]` や `[info]` のような接頭辞を含めないことを確認します。')
    const xml = `<root><mxCell value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('mxCell id=?'))).toBe(true)
    expect(warnings.every(w => !w.message.includes('[warn]') && !w.message.includes('[info]'))).toBe(true)
  })

  it('style の fontColor があっても、font タグに color 属性がない場合は、note の通知を返さない', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。`style` に `fontColor` があっても、`font` タグに `color` 属性がない場合に、同じ値を 2 回指定していることを示す通知を返さないことを確認します。')
    const xml = `<root><mxCell id="e" value="&lt;font face=&quot;Inter&quot;&gt;X&lt;/font&gt;" style="fontColor=#FF0000;"/></root>`
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.severity === 'note' && w.message.includes('specify the same value twice'))).toBe(false)
  })

  it('ルート要素がない XML を渡した場合は、例外が発生せず、空の配列を返す', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。XML 宣言だけでルート要素がない文字列を渡した場合に、例外が発生せず、空の配列を返すことを確認します。')
    expect(validateHtml('<?xml version="1.0"?>')).toEqual([])
  })

  it('先頭に BOM がある XML でも、解釈に成功し、警告を検出する', async () => {
    await explains('セルのラベルに含まれる HTML の問題を検出する `validateHtml` のテストです。先頭に BOM（U+FEFF）がある XML を渡した場合でも、解釈に成功し、`unsupported <font> attribute` の警告を検出することを確認します。')
    const xml = '\u{FEFF}<root><mxCell id="a" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>'
    const warnings = validateHtml(xml)
    expect(warnings.some(w => w.message.includes('unsupported <font> attribute'))).toBe(true)
  })
})

describe('resolveIconsInStyle', () => {
  it('色の指定がある icon を、解決関数の戻り値に置き換える', async () => {
    await explains('`style` 属性の `icon://` を data URI へ置き換える `resolveIconsInStyle` のテストです。`icon://AI/foo#4f46e5` のように色の指定がある参照を、解決関数が返した data URI に置き換えることを確認します。')
    const input = '<mxCell style="image=icon://AI/foo#4f46e5;"/>'
    const result = resolveIconsInStyle(input, () => 'data:image/svg+xml,XYZ')
    expect(result).toContain('image=data:image/svg+xml,XYZ')
  })

  it('色の指定がない icon も、解決関数の戻り値に置き換える', async () => {
    await explains('`style` 属性の `icon://` を data URI へ置き換える `resolveIconsInStyle` のテストです。`icon://AI/foo` のように色の指定がない参照も、解決関数が返した data URI に置き換えることを確認します。')
    const input = '<mxCell style="image=icon://AI/foo;"/>'
    const result = resolveIconsInStyle(input, () => 'data:image/svg+xml,XYZ')
    expect(result).toContain('image=data:image/svg+xml,XYZ')
  })

  it('解決関数が undefined を返した場合は、icon:// の参照を残す', async () => {
    await explains('`style` 属性の `icon://` を data URI へ置き換える `resolveIconsInStyle` のテストです。解決関数が `undefined` を返した場合に、置き換えず、`icon://` の参照を残すことを確認します。')
    const input = '<mxCell style="image=icon://X/Y#abc;"/>'
    const result = resolveIconsInStyle(input, RESOLVER_NULL)
    expect(result).toContain('image=icon://X/Y')
  })

  it('style 属性の外にある icon:// は、置き換えの対象にしない', async () => {
    await explains('`style` 属性の `icon://` を data URI へ置き換える `resolveIconsInStyle` のテストです。`value` 属性や要素の内容に `icon://` が書かれていても、置き換えずに残すことを確認します。')
    const input = '<mxCell value="icon://AI/foo">x</mxCell>'
    const result = resolveIconsInStyle(input, () => 'DATA')
    expect(result).toContain('value="icon://AI/foo"')
  })
})

describe('calcViewbox', () => {
  it('mxGeometry がない XML の場合は、空文字を返す', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。`mxGeometry` を含まない XML を渡した場合に、空文字を返すことを確認します。')
    expect(calcViewbox('<root/>')).toBe('')
  })

  it('XML として解釈できない場合は、空文字を返す', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。XML として解釈できない文字列を渡した場合に、空文字を返すことを確認します。')
    expect(calcViewbox('not xml <<')).toBe('')
  })

  it('ルート要素がない XML の場合は、空文字を返す', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。XML 宣言だけでルート要素がない文字列を渡した場合に、空文字を返すことを確認します。')
    expect(calcViewbox('<?xml version="1.0"?>')).toBe('')
  })

  it('幅と高さがどちらも 0 の geometry は、無視する', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。`width` と `height` がどちらも `0` の `mxGeometry` だけを渡した場合に、空文字を返すことを確認します。')
    const xml = '<root><mxGeometry x="0" y="0" width="0" height="0" as="geometry"/></root>'
    expect(calcViewbox(xml)).toBe('')
  })

  it('as 属性が geometry でない mxGeometry は、無視する', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。`as="sourcePoint"` のように、`as` 属性が `geometry` でない `mxGeometry` だけを渡した場合に、空文字を返すことを確認します。')
    const xml = '<root><mxGeometry x="0" y="0" width="100" height="100" as="sourcePoint"/></root>'
    expect(calcViewbox(xml)).toBe('')
  })

  it('属性が存在しない場合は、0 として扱う', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。`x` と `y` がない `mxGeometry` を渡した場合に、0 として扱い、`viewbox=` を含むクエリを返すことを確認します。')
    const xml = '<root><mxGeometry width="50" height="40" as="geometry"/></root>'
    expect(calcViewbox(xml)).toContain('viewbox=')
  })

  it('属性の値が数値でない場合は、0 として扱う', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。`x="abc"` のように数値でない属性を持つ `mxGeometry` を渡した場合に、0 として扱い、`viewbox=` を含むクエリを返すことを確認します。')
    const xml = '<root><mxGeometry x="abc" width="50" height="40" as="geometry"/></root>'
    expect(calcViewbox(xml)).toContain('viewbox=')
  })

  it('Python の json.dumps と同じ、区切りに空白を含む JSON 形式で出力する', async () => {
    await explains('図の表示範囲のクエリを作成する `calcViewbox` のテストです。Python の `json.dumps` と同じく、`:` と `,` の後ろに空白を含む JSON を URL エンコードした形式（`%22x%22%3A%2020`）で出力することを確認します。')
    const xml = '<root><mxGeometry x="40" y="40" width="200" height="40" as="geometry"/></root>'
    const result = calcViewbox(xml)
    // ": " と ", " で区切られていること（pythonQuote 後の % エンコード値）
    expect(result).toContain('%22x%22%3A%2020')
  })
})

describe('encodeData', () => {
  it('XML を URL エンコードし、deflate で圧縮して、base64 に変換する', async () => {
    await explains('draw.io の XML を URL に埋め込む形式へ変換する `encodeData` のテストです。変換結果が base64 の文字列であり、base64 の復号、展開、URL デコードの順に戻すと、元の XML になることを確認します。')
    const result = encodeData('<a/>')
    expect(result).toMatch(/^[a-z0-9+/=]+$/i)
    const inflated = inflateRawSync(Buffer.from(result, 'base64')).toString('utf8')
    expect(decodeURIComponent(inflated)).toBe('<a/>')
  })
})

describe('generateDrawioUrl', () => {
  it('viewbox がない XML の場合は、URL に疑問符を含めない', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。表示範囲を求められない XML を渡した場合に、`https://app.diagrams.net/#R` で始まる、`?` を含まない URL を返すことを確認します。')
    const url = generateDrawioUrl('<a/>', { mode: 'view' })
    expect(url.startsWith('https://app.diagrams.net/#R')).toBe(true)
  })

  it('mode に view と edit のどちらを指定しても、同じ URL を返す', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。同じ図に対して `mode` を `view` と `edit` で指定した場合に、同じ URL を返すことを確認します。')
    const viewUrl = generateForFixture('minimal', 'view')
    const editUrl = generateForFixture('minimal', 'edit')
    expect(viewUrl).toBe(editUrl)
  })

  it('minimal の図は、viewbox の部分が golden ファイルと一致する', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。`minimal` の図から作成した URL の表示範囲の部分が、Python の参照実装で作成して保存した golden ファイルと一致することを確認します。')
    const tsUrl = generateForFixture('minimal')
    const goldenUrl = readGolden('minimal')
    expect(split(tsUrl).viewboxPart).toBe(split(goldenUrl).viewboxPart)
  })

  it('minimal の図は、復号した XML が golden ファイルと一致する', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。`minimal` の図から作成した URL を復号した XML が、Python の参照実装で作成して保存した golden ファイルと一致することを確認します。')
    const tsUrl = generateForFixture('minimal')
    const goldenUrl = readGolden('minimal')
    expect(decodeXml(split(tsUrl).base64)).toBe(decodeXml(split(goldenUrl).base64))
  })

  it('icon-included の図は、viewbox の部分が golden ファイルと一致する', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。icon を含む `icon-included` の図から作成した URL の表示範囲の部分が、golden ファイルと一致することを確認します。')
    const tsUrl = generateForFixture('icon-included')
    const goldenUrl = readGolden('icon-included')
    expect(split(tsUrl).viewboxPart).toBe(split(goldenUrl).viewboxPart)
  })

  it('icon-included の図は、icon:// を解決した後の復号した XML が golden ファイルと一致する', async () => {
    await explains('draw.io の URL を作成する `generateDrawioUrl` のテストです。icon を含む `icon-included` の図で、`icon://` を data URI へ置き換えた後に復号した XML が、golden ファイルと一致することを確認します。')
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

  it('URL は、meta refresh と表示用のリンクの 2 箇所だけに、同じエスケープ済みの文字列で出力する', async () => {
    await explains('リダイレクト用の HTML を作成する `renderRedirectHtml` のテストです。`&` や `"` などを含む URL を渡した場合に、エスケープした URL が meta refresh と表示用のリンクの 2 箇所だけに現れ、エスケープ前の URL は含まれないことを確認します。')
    const html = renderRedirectHtml(RAW_URL)
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${ESCAPED_URL}">`)
    expect(html).toContain(`<a id="target" href="${ESCAPED_URL}">`)
    expect(html.split(ESCAPED_URL)).toHaveLength(3)
    // 生の `&` `<` `>` と二重引用符が属性に残っていれば、HTML が不正になる。
    // 単引用符は属性の区切りでないため、そのまま残る。
    expect(html).not.toContain(RAW_URL)
  })

  it('JavaScript に URL を埋め込まず、表示用のリンクの href を読み取って遷移する', async () => {
    await explains('リダイレクト用の HTML を作成する `renderRedirectHtml` のテストです。`script` 要素が `location.replace` でリンクの `href` を参照し、URL そのものを含まないことを確認します。')
    const html = renderRedirectHtml(RAW_URL)
    expect(html).toContain(`<script>location.replace(document.getElementById('target').href)</script>`)
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'))
    expect(script).not.toContain('example.com')
  })

  it('非常に長い URL でも、charset の宣言を先頭の 1024 バイト以内に配置する', async () => {
    await explains('リダイレクト用の HTML を作成する `renderRedirectHtml` のテストです。20,000 文字の長い URL を渡した場合でも、先頭の 1024 バイト以内に `<meta charset="utf-8">` があることを確認します。')
    // file:// には Content-Type が無く、encoding sniffing の窓は先頭 1024 バイトしかない。
    // URL が charset より前に来ると日本語ラベルが化ける。
    const longUrl = `https://app.diagrams.net/?viewbox=x#R${'A'.repeat(20_000)}`
    const head = Buffer.from(renderRedirectHtml(longUrl), 'utf8').subarray(0, 1024).toString('utf8')
    expect(head).toContain('<meta charset="utf-8">')
  })

  it('同じ URL からは、常に同じバイト列の HTML を出力する', async () => {
    await explains('リダイレクト用の HTML を作成する `renderRedirectHtml` のテストです。同じ URL を 2 回渡した場合に、毎回同じ内容の HTML を返すことを確認します。')
    expect(renderRedirectHtml(RAW_URL)).toBe(renderRedirectHtml(RAW_URL))
  })

  it('BOM を付けず、改行を LF にし、末尾の改行を 1 つにする', async () => {
    await explains('リダイレクト用の HTML を作成する `renderRedirectHtml` のテストです。HTML が `<!doctype html>` で始まり、BOM と CR を含まず、`</html>` の後ろの改行が 1 つだけであることを確認します。')
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
  it('宣言されていない名前空間の接頭辞を含む XML は、解釈に失敗したものとして、空の結果を返す', async () => {
    await explains('`validateHtml` と `calcViewbox` のテストです。`x:extra` のように宣言されていない名前空間の接頭辞を含む XML を渡した場合に、どちらも解釈に失敗したものとして、空の結果を返すことを確認します。')
    const xml = '<root><mxCell id="a" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;">'
      + '<mxGeometry x="10" y="20" width="30" height="40" as="geometry"/></mxCell><x:extra/></root>'
    expect(validateHtml(xml)).toEqual([])
    expect(calcViewbox(xml)).toBe('')
  })

  // 要素の列挙は名前空間を見ない。
  // そのため default namespace 宣言があっても、mxCell / mxGeometry を対象にする。
  it('既定の名前空間を宣言した XML でも、mxCell と mxGeometry を対象にする', async () => {
    await explains('`validateHtml` と `calcViewbox` のテストです。`xmlns` で既定の名前空間を宣言した XML を渡した場合でも、`mxCell` と `mxGeometry` を対象にして、警告 1 件と `viewbox=` を含むクエリを返すことを確認します。')
    const xml = '<mxGraphModel xmlns="urn:mx"><root>'
      + '<mxCell id="b" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;">'
      + '<mxGeometry x="10" y="20" width="30" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
    expect(validateHtml(xml)).toHaveLength(1)
    expect(calcViewbox(xml)).toContain('viewbox=')
  })
})
