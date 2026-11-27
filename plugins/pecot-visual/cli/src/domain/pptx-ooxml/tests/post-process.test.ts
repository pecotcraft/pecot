import { describe, expect, it } from 'vitest'

import type { FontPolicy } from '../font-policy.js'
import {
  NAMESPACES,
  applyHyperlinkFix,
  applyJapaneseFontFix,
  applyTransition,
  removeAnimationTiming,
  sanitizeCssOnlyTypefaces,
} from '../post-process.js'
import { parseTestXml, serializeTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const NS_PACKAGE_RELATIONSHIPS = { rel: 'http://schemas.openxmlformats.org/package/2006/relationships' }

// XML の断片は文章として読まれる。構造と日本語の語を分け、語は 1 語ずつ独立した文字列として持つ。
const TEXT = {
  greeting: 'こんにちは',
  city: '東京',
  kana: 'あ',
  text: 'テキスト',
  link: '公式サイト',
  body: '本文',
}

// テーマの宣言から組む値のテスト用の代表。テーマの固有値は本体に持たない。
const POLICY: FontPolicy = { ea: 'Noto Sans JP', linkColor: '4F46E5' }

const SLIDE_NS_DECL = [
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"',
  'xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main"',
].join(' ')

describe('applyJapaneseFontFix', () => {
  it('日本語テキストの rPr に既存の a:ea があれば typeface を上書きする', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、既存の `a:ea` を更新するテストです。日本語のテキストの `a:rPr` に `a:ea` がある場合に、`typeface` が `Noto Sans JP` に上書きされ、補正の件数が 1 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:ea typeface="OldFont"/></a:rPr>
                <a:t>${TEXT.greeting}</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyJapaneseFontFix(slide, POLICY, new Map())

    expect(result).toStrictEqual({ fontFixed: 1, spacingFixed: 0 })
    const [ea] = slide.selectNodes('//a:ea', NAMESPACES)
    expect(ea?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('日本語のテキストに a:ea が存在しない場合は、新しく追加する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:ea` を追加するテストです。日本語のテキストの `a:rPr` に `a:ea` が存在しない場合は、`Noto Sans JP` を指定した `a:ea` が 1 つだけ追加されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:latin typeface="Inter"/></a:rPr>
                <a:t>${TEXT.city}</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyJapaneseFontFix(slide, POLICY, new Map())

    expect(result.fontFixed).toBe(1)
    const eaNodes = slide.selectNodes('//a:ea', NAMESPACES)
    expect(eaNodes).toHaveLength(1)
    expect(eaNodes[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('英数字だけのテキストの場合は、変更しない', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、対象外のテキストのテストです。`Hello World` のように英数字だけのテキストの場合に、補正の件数が 0 になり、`a:ea` が追加されないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:latin typeface="Inter"/></a:rPr>
                <a:t>Hello World</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyJapaneseFontFix(slide, POLICY, new Map())

    expect(result).toStrictEqual({ fontFixed: 0, spacingFixed: 0 })
    expect(slide.selectNodes('//a:ea', NAMESPACES)).toHaveLength(0)
  })

  it('letter-spacing に一致するテキストの場合は、rPr に spc 属性を付ける', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、字間のテストです。`letter-spacing` が `1.4px` のテキストを渡した場合に、`a:rPr` の `spc` が `105` になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr/>
                <a:t>WIDE</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyJapaneseFontFix(
      slide,
      POLICY,
      new Map([['WIDE', { letterSpacing: '1.4px', fontSize: '7px' }]]),
    )

    expect(result.spacingFixed).toBe(1)
    const [rpr] = slide.selectNodes('//a:rPr', NAMESPACES)
    expect(rpr?.getAttr('spc')).toBe('105')
  })

  it('endParaRPr: 段落に日本語があり、a:ea が存在しない場合は、新しく追加する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、段落末尾の `a:endParaRPr` のテストです。段落に日本語のテキストがあり、`a:endParaRPr` に `a:ea` が存在しない場合は、`Noto Sans JP` を指定した `a:ea` が追加されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr/>
                <a:t>${TEXT.kana}</a:t>
              </a:r>
              <a:endParaRPr/>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    applyJapaneseFontFix(slide, POLICY, new Map())

    const eaNodes = slide.selectNodes('//a:endParaRPr/a:ea', NAMESPACES)
    expect(eaNodes).toHaveLength(1)
    expect(eaNodes[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('endParaRPr: 段落に日本語がある場合は、既存の a:ea を更新する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、段落末尾の `a:endParaRPr` のテストです。段落に日本語のテキストがあり、`a:endParaRPr` に `a:ea` がある場合に、`typeface` が `Noto Sans JP` に更新され、`a:ea` が 1 つのままであることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:ea typeface="OldFont"/></a:rPr>
                <a:t>${TEXT.kana}</a:t>
              </a:r>
              <a:endParaRPr><a:ea typeface="OldEndFont"/></a:endParaRPr>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    applyJapaneseFontFix(slide, POLICY, new Map())

    const eaNodes = slide.selectNodes('//a:endParaRPr/a:ea', NAMESPACES)
    expect(eaNodes).toHaveLength(1)
    expect(eaNodes[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('a:t が空文字列の run の場合は、補正せず、例外も発生しない', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、空のテキストのテストです。`a:t` が空文字列の `a:r` を渡した場合に、例外が発生しないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr/><a:t></a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    expect(() => applyJapaneseFontFix(slide, POLICY, new Map())).not.toThrow()
  })

  it('a:rPr が存在しない run の場合は、補正しない (書体の補正)', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:rPr` が存在しないテキストのテストです。日本語のテキストを持ち、`a:rPr` を持たない `a:r` を渡した場合に、補正の件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:t>${TEXT.greeting}</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyJapaneseFontFix(slide, POLICY, new Map())
    expect(result.fontFixed).toBe(0)
  })

  it('endParaRPr: 段落が英数字だけの場合は、既存の ea を変更しない', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、段落末尾の `a:endParaRPr` のテストです。段落のテキストが英数字だけの場合に、`a:endParaRPr` の `a:ea` が元の `Original` のまま残ることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r><a:rPr/><a:t>Hello</a:t></a:r>
              <a:endParaRPr><a:ea typeface="Original"/></a:endParaRPr>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    applyJapaneseFontFix(slide, POLICY, new Map())
    const ea = slide.selectNodes('//a:endParaRPr/a:ea', NAMESPACES)[0]
    expect(ea?.getAttr('typeface')).toBe('Original')
  })

  it('a:r の中に a:t が存在しない場合は、補正せず、例外も発生しない', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:t` が存在しない `a:r` のテストです。`a:rPr` だけを持つ `a:r` を渡した場合に、例外が発生しないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr/></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    expect(() => applyJapaneseFontFix(slide, POLICY, new Map()))
      .not.toThrow()
  })

  it('a:rPr の直下に a:latin がある場合は、a:ea を a:latin の直後に挿入する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:ea` を挿入する位置のテストです。`a:rPr` の直下に `a:latin` がある場合に、`a:ea` が `a:latin` の直後の要素として挿入され、旧版の Python の実装と同じ順序になることを確認します。')
    // Python 旧版の `rpr.insert(latin_index + 1, ea_elem)` と等価な sibling 順序を pin。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:latin typeface="Inter"/>
                </a:rPr>
                <a:t>${TEXT.city}</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    applyJapaneseFontFix(slide, POLICY, new Map())

    const siblings = slide.selectNodes(
      '//a:rPr/a:latin/following-sibling::*[1][self::a:ea]',
      NAMESPACES,
    )
    expect(siblings).toHaveLength(1)
    expect(siblings[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('a:rPr の直下に a:latin が存在しない場合は、a:ea を a:rPr の最後の子として追加する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:ea` を挿入する位置のテストです。`a:rPr` の直下に `a:latin` が存在しない場合は、`a:ea` が最後の子要素として追加されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr/>
                <a:t>${TEXT.city}</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    applyJapaneseFontFix(slide, POLICY, new Map())

    // rPr の最後の子要素が a:ea
    const lastChildEa = slide.selectNodes(
      '//a:rPr/*[last()][self::a:ea]',
      NAMESPACES,
    )
    expect(lastChildEa).toHaveLength(1)
    expect(lastChildEa[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })

  it('endParaRPr: 直下に a:latin がある場合は、a:ea を a:latin の直後に挿入する', async () => {
    await explains('スライドの日本語の書体を補正する `applyJapaneseFontFix` の、`a:endParaRPr` での `a:ea` を挿入する位置のテストです。`a:endParaRPr` の直下に `a:latin` がある場合に、`a:ea` が `a:latin` の直後の要素として挿入されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r><a:rPr/><a:t>${TEXT.kana}</a:t></a:r>
              <a:endParaRPr>
                <a:latin typeface="Inter"/>
              </a:endParaRPr>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    applyJapaneseFontFix(slide, POLICY, new Map())

    const siblings = slide.selectNodes(
      '//a:endParaRPr/a:latin/following-sibling::*[1][self::a:ea]',
      NAMESPACES,
    )
    expect(siblings).toHaveLength(1)
    expect(siblings[0]?.getAttr('typeface')).toBe('Noto Sans JP')
  })
})

function freshRels(): ReturnType<typeof parseTestXml> {
  return parseTestXml(
    '<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  )
}

describe('sanitizeCssOnlyTypefaces', () => {
  it('-apple-system や sans-serif などの CSS 専用の書体名の場合は、latin、ea、cs を削除する', async () => {
    await explains('未対応のフォントを取り除く `sanitizeCssOnlyTypefaces` の、削除のテストです。`-apple-system` や `sans-serif` など、CSS 専用の書体名を指定した `a:latin`、`a:ea`、`a:cs` を渡した場合に、すべてが削除され、件数が 6 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr>
              <a:latin typeface="-apple-system"/>
              <a:ea typeface="BlinkMacSystemFont"/>
              <a:cs typeface="system-ui"/>
            </a:rPr><a:t>x</a:t></a:r></a:p>
            <a:p><a:r><a:rPr>
              <a:latin typeface="sans-serif"/>
              <a:ea typeface="serif"/>
              <a:cs typeface="monospace"/>
            </a:rPr><a:t>y</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = sanitizeCssOnlyTypefaces(slide)
    expect(result.removed).toBe(6)
    const xml = serializeTestXml(slide)
    expect(xml).not.toContain('-apple-system')
    expect(xml).not.toContain('BlinkMacSystemFont')
    expect(xml).not.toContain('system-ui')
    expect(xml).not.toContain('sans-serif')
    expect(xml).not.toMatch(/typeface="serif"/)
    expect(xml).not.toContain('monospace')
  })

  it('cursive、fantasy、inherit、initial、unset も、削除する', async () => {
    await explains('未対応のフォントを取り除く `sanitizeCssOnlyTypefaces` の、削除対象のテストです。`cursive`、`fantasy`、`inherit`、`initial`、`unset` を書体名に指定した場合も、5 件を削除することを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p>
          <a:r><a:rPr><a:latin typeface="cursive"/></a:rPr><a:t>a</a:t></a:r>
          <a:r><a:rPr><a:latin typeface="fantasy"/></a:rPr><a:t>b</a:t></a:r>
          <a:r><a:rPr><a:latin typeface="inherit"/></a:rPr><a:t>c</a:t></a:r>
          <a:r><a:rPr><a:latin typeface="initial"/></a:rPr><a:t>d</a:t></a:r>
          <a:r><a:rPr><a:latin typeface="unset"/></a:rPr><a:t>e</a:t></a:r>
        </a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `)
    expect(sanitizeCssOnlyTypefaces(slide).removed).toBe(5)
  })

  it('Inter や Noto Sans JP などの実在する書体名の場合は、削除しない', async () => {
    await explains('未対応のフォントを取り除く `sanitizeCssOnlyTypefaces` の、削除対象外のテストです。`Inter`、`Noto Sans JP`、`Display Extended` のように、実在する書体名を指定した場合に、削除した件数が 0 になり、書体名がそのまま残ることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p>
          <a:r><a:rPr>
            <a:latin typeface="Inter"/>
            <a:ea typeface="Noto Sans JP"/>
            <a:cs typeface="Display Extended"/>
          </a:rPr><a:t>${TEXT.text}</a:t></a:r>
        </a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `)
    const result = sanitizeCssOnlyTypefaces(slide)
    expect(result.removed).toBe(0)
    const xml = serializeTestXml(slide)
    expect(xml).toContain('typeface="Inter"')
    expect(xml).toContain('typeface="Noto Sans JP"')
    expect(xml).toContain('typeface="Display Extended"')
  })

  it('typeface 属性が存在しない latin、ea、cs の場合は、削除しない', async () => {
    await explains('未対応のフォントを取り除く `sanitizeCssOnlyTypefaces` の、削除対象外のテストです。`typeface` 属性を持たない `a:latin`、`a:ea`、`a:cs` を渡した場合に、削除した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p>
          <a:r><a:rPr><a:latin/><a:ea/><a:cs/></a:rPr><a:t>x</a:t></a:r>
        </a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `)
    expect(sanitizeCssOnlyTypefaces(slide).removed).toBe(0)
  })

  it('書体をすべて削除して rPr が空になった場合も、再び解析できる', async () => {
    await explains('未対応のフォントを取り除く `sanitizeCssOnlyTypefaces` の、削除後の XML のテストです。3 つの書体をすべて削除した後の XML を再び解析でき、`a:rPr` と `lang` 属性が残り、`a:latin`・`a:ea`・`a:cs` が存在しないことを確認します。')
    // 全 typeface が CSS-only で sanitize 後 a:rPr が空属性のみになるケース。
    // serialize して再 parse し、structure が保たれることを確認する。
    // これにより、PowerPoint が theme1.xml の +mn-lt / +mn-ea にフォールバックする場合の健全性を担保する。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p>
          <a:r><a:rPr lang="en-US">
            <a:latin typeface="-apple-system"/>
            <a:ea typeface="system-ui"/>
            <a:cs typeface="sans-serif"/>
          </a:rPr><a:t>x</a:t></a:r>
        </a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `)
    expect(sanitizeCssOnlyTypefaces(slide).removed).toBe(3)
    const xml = serializeTestXml(slide)
    // 再 parse できる (XML 構造が保たれている)
    expect(() => parseTestXml(xml)).not.toThrow()
    // a:rPr 自体は残っており lang 属性も保持される
    expect(xml).toContain('<a:rPr')
    expect(xml).toContain('lang="en-US"')
    // a:latin / a:ea / a:cs は完全消滅
    expect(xml).not.toMatch(/<a:latin/)
    expect(xml).not.toMatch(/<a:ea/)
    expect(xml).not.toMatch(/<a:cs/)
  })
})

describe('applyHyperlinkFix', () => {
  it('リンクの色と URL のテキストの場合は、ハイパーリンクに変換する', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、変換のテストです。リンクの色（`4F46E5`）で `https://example.com/` と書かれたテキストを渡した場合に、`a:hlinkClick` が追加されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>
                </a:rPr>
                <a:t>https://example.com/</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = freshRels()

    const result = applyHyperlinkFix(slide, rels, new Map(), '4F46E5')

    expect(result.converted).toBe(1)

    const [hlink] = slide.selectNodes('//a:hlinkClick', NAMESPACES)
    expect(hlink).toBeDefined()
    expect(hlink?.getAttr('r:id')).toBe('rId1')

    const [relationship] = rels.selectNodes('//rel:Relationship', NS_PACKAGE_RELATIONSHIPS)
    expect(relationship?.getAttr('Id')).toBe('rId1')
    expect(relationship?.getAttr('Target')).toBe('https://example.com/')
    expect(relationship?.getAttr('TargetMode')).toBe('External')
  })

  it('テキストと URL が異なる場合も、hrefMap に一致するなら、ハイパーリンクに変換する', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`hrefMap` のテストです。リンクの色のテキストが URL ではなく `公式サイト` で、`hrefMap` に対応する URL がある場合に、その URL を `Target` とするリンクへ変換することを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>
                </a:rPr>
                <a:t>${TEXT.link}</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = freshRels()

    const result = applyHyperlinkFix(
      slide,
      rels,
      new Map([['公式サイト', 'https://example.org/ja']]),
      '4F46E5',
    )

    expect(result.converted).toBe(1)
    const [relationship] = rels.selectNodes('//rel:Relationship', NS_PACKAGE_RELATIONSHIPS)
    expect(relationship?.getAttr('Target')).toBe('https://example.org/ja')
  })

  it('リンクの色に一致しないテキストの場合は、変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、対象外のテキストのテストです。リンクの色（`4F46E5`）と異なる色の URL のテキストを渡した場合に、変換した件数が 0 になり、`a:hlinkClick` が存在しないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
                </a:rPr>
                <a:t>https://example.com/</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')

    expect(result.converted).toBe(0)
    expect(slide.selectNodes('//a:hlinkClick', NAMESPACES)).toHaveLength(0)
  })

  it('すでに hlinkClick がある run の場合は、再び変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、再実行のテストです。すでに `a:hlinkClick` を持つ `a:r` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>
                  <a:hlinkClick r:id="rIdX"/>
                </a:rPr>
                <a:t>https://example.com/</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)

    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')

    expect(result.converted).toBe(0)
  })

  it('a:t が存在しない run の場合は、変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`a:t` が存在しない `a:r` のテストです。`a:t` を持たない `a:r` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr/></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('a:t が空文字列の run の場合は、変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、空のテキストのテストです。`a:t` が空文字列の `a:r` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></a:rPr><a:t>   </a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('a:rPr が存在しない run の場合は、変換しない (ハイパーリンクの変換)', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`a:rPr` が存在しない `a:r` のテストです。`a:rPr` を持たない `a:r` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:t>https://example.com/</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('solidFill や srgbClr が存在しない run の場合は、変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、色の指定が存在しない `a:r` のテストです。`a:solidFill` や `a:srgbClr` を持たない `a:r` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r><a:rPr/><a:t>https://example.com/</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('srgbClr に val 属性が存在しない場合は、リンクの色と一致しないものとして変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`val` 属性が存在しない `a:srgbClr` のテストです。`val` 属性を持たない `a:srgbClr` の場合は、リンクの色と一致しないものとして扱い、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r>
              <a:rPr><a:solidFill><a:srgbClr/></a:solidFill></a:rPr>
              <a:t>https://example.com/</a:t>
            </a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('URL でも hrefMap に一致するものでもないテキストの場合は、変換しない', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、対象外のテキストのテストです。リンクの色で、URL でも `hrefMap` に一致するものでもない `plain text` を渡した場合に、変換した件数が 0 になることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r>
              <a:rPr><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></a:rPr>
              <a:t>plain text</a:t>
            </a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const result = applyHyperlinkFix(slide, freshRels(), new Map(), '4F46E5')
    expect(result.converted).toBe(0)
  })

  it('rId を採番するときに、Id 属性が存在しない既存の Relationship を無視する', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`rId` の採番のテストです。既存の `Relationship` に `Id` 属性が存在しない場合に、無視して `rId1` を割り当てることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r>
              <a:rPr><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></a:rPr>
              <a:t>https://example.com/</a:t>
            </a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = parseTestXml(
      '<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<rel:Relationship Type="x" Target="y"/>'
      + '</rel:Relationships>',
    )

    applyHyperlinkFix(slide, rels, new Map(), '4F46E5')

    const ids = rels.selectNodes('//rel:Relationship', NS_PACKAGE_RELATIONSHIPS).map(n => n.getAttr('Id'))
    expect(ids).toContain('rId1')
  })

  it('rId を採番するときに、rId で始まらない既存の Id を無視する', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`rId` の採番のテストです。既存の `Id` が `customId` や `rIdNotANumber` のように、`rId` と数字の組み合わせではない場合に、無視して `rId1` を割り当てることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p><a:r>
              <a:rPr><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></a:rPr>
              <a:t>https://example.com/</a:t>
            </a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = parseTestXml(
      '<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<rel:Relationship Id="customId" Type="x" Target="y"/>'
      + '<rel:Relationship Id="rIdNotANumber" Type="x" Target="y"/>'
      + '</rel:Relationships>',
    )

    applyHyperlinkFix(slide, rels, new Map(), '4F46E5')

    const ids = rels.selectNodes('//rel:Relationship', NS_PACKAGE_RELATIONSHIPS).map(n => n.getAttr('Id'))
    expect(ids).toContain('rId1')
  })

  it('rId を採番するときに、既存の Relationship の最大の番号に 1 を足した番号を割り当てる', async () => {
    await explains('URL のテキストをハイパーリンクに変換する `applyHyperlinkFix` の、`rId` の採番のテストです。既存の `Id` が `rId7` と `rId3` の場合に、最大の番号 7 に 1 を加算した `rId8` を割り当てることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr>
                  <a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>
                </a:rPr>
                <a:t>https://example.com/</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = parseTestXml(
      '<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<rel:Relationship Id="rId7" Type="x" Target="y"/>'
      + '<rel:Relationship Id="rId3" Type="x" Target="y"/>'
      + '</rel:Relationships>',
    )

    applyHyperlinkFix(slide, rels, new Map(), '4F46E5')

    const ids = rels.selectNodes('//rel:Relationship', NS_PACKAGE_RELATIONSHIPS).map(n => n.getAttr('Id'))
    expect(ids).toContain('rId8')
  })
})

function emptySlide(): ReturnType<typeof parseTestXml> {
  return parseTestXml(`<p:sld ${SLIDE_NS_DECL}><p:cSld><p:spTree/></p:cSld></p:sld>`)
}

describe('applyTransition', () => {
  it('fade の場合は、スライドの直下に切り替え効果を追加する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、`fade` のテストです。500 ミリ秒を指定した場合に、`mc:AlternateContent` と `p:fade` が追加され、`p14:dur` が `500` になることを確認します。')
    const slide = emptySlide()

    const result = applyTransition(slide, 'fade', 500)

    expect(result.added).toBe(1)
    const xml = serializeTestXml(slide)
    expect(xml).toContain('mc:AlternateContent')
    expect(xml).toContain('p:fade')
    expect(xml).toContain('p14:dur="500"')
  })

  it('morph の場合は、スライドの直下に切り替え効果を追加する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、`morph` のテストです。800 ミリ秒を指定した場合に、`p159:morph` が追加され、`option` が `byObject`、`p14:dur` が `800` になることを確認します。')
    const slide = emptySlide()

    applyTransition(slide, 'morph', 800)

    const xml = serializeTestXml(slide)
    expect(xml).toContain('p159:morph')
    expect(xml).toContain('option="byObject"')
    expect(xml).toContain('p14:dur="800"')
  })

  it('既存の transition がある場合は、削除した上で新しいものを追加する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、再実行のテストです。すでに `p:transition` がある場合に、それを削除した上で新しい切り替え効果を 1 つだけ追加することを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:transition><p:fade/></p:transition>
      </p:sld>
    `)

    applyTransition(slide, 'fade', 500)

    expect(slide.selectNodes('/p:sld/p:transition', NAMESPACES)).toHaveLength(0)
    expect(slide.selectNodes('//mc:AlternateContent', NAMESPACES)).toHaveLength(1)
  })

  it('AlternateContent の中に transition がある場合は、AlternateContent ごと削除して追加し直す', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、置き換えのテストです。`transition` を含む `mc:AlternateContent` がある場合に、全体を削除して新しいものを 1 つ追加し、古い `p14:dur` が存在しないことを確認します。')
    // fixture は、dom-to-pptx の applySlideTransitions がライブラリとして出し得る形にする。
    // AC 自身に xmlns:mc / xmlns:p、Choice に xmlns:p14、Fallback の transition に spd が付く。
    // pecotv は `_slideTransitions` を渡さないため、実出力には現れない。
    // 属性の付き方が pecotv の buildFadeTransitionXml と違っても、AC ごと除去できることを固定する。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">
            <p:transition spd="slow" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" p14:dur="300"><p14:vortex dir="l"/></p:transition>
          </mc:Choice>
          <mc:Fallback>
            <p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="slow">
              <p:fade/>
            </p:transition>
          </mc:Fallback>
        </mc:AlternateContent>
      </p:sld>
    `)

    applyTransition(slide, 'fade', 500)

    const altContents = slide.selectNodes('//mc:AlternateContent', NAMESPACES)
    expect(altContents).toHaveLength(1)
    const xml = serializeTestXml(slide)
    expect(xml).toContain('p14:dur="500"')
    expect(xml).not.toContain('p14:dur="300"')
    expect(xml).not.toContain('p14:vortex')
  })

  it('AlternateContent の中に transition が存在しない場合は、既存の AlternateContent を残す', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、既存の要素を維持するテストです。`transition` を含まない `mc:AlternateContent` がある場合に、それを残したまま新しい `mc:AlternateContent` を追加し、合計が 2 つになることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">
            <p:other/>
          </mc:Choice>
        </mc:AlternateContent>
      </p:sld>
    `)

    applyTransition(slide, 'fade', 500)

    expect(slide.selectNodes('//mc:AlternateContent', NAMESPACES)).toHaveLength(2)
  })

  it('morphOption を指定した場合は、option 属性に反映する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、オプションのテストです。`morphOption` に `byChar` を指定した場合に、`option` 属性が `byChar` になることを確認します。')
    const slide = emptySlide()

    applyTransition(slide, 'morph', 600, { morphOption: 'byChar' })

    expect(serializeTestXml(slide)).toContain('option="byChar"')
  })

  it('p:timing がある場合は、transition を clrMapOvr の後、timing の前に挿入する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、挿入する位置のテストです。`p:timing` を持つスライドの場合に、要素が `cSld`、`clrMapOvr`、切り替え効果、`timing` の順に並び、ECMA-376 の `CT_Slide` の順序に従うことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:clrMapOvr/>
        <p:timing/>
      </p:sld>
    `)

    applyTransition(slide, 'fade', 500)

    // ECMA-376 (CT_Slide) の要素順序 cSld → clrMapOvr → transition → timing。
    // XmlNode ポートに要素名の取得 API が無いため、直列化後の出現位置で順序を検証する。
    const xml = serializeTestXml(slide)
    const cSldIndex = xml.indexOf('<p:cSld')
    const clrMapOvrIndex = xml.indexOf('<p:clrMapOvr')
    const transitionIndex = xml.indexOf('<mc:AlternateContent')
    const timingIndex = xml.indexOf('<p:timing')
    expect(transitionIndex).toBeGreaterThan(-1)
    expect(timingIndex).toBeGreaterThan(-1)
    expect(cSldIndex).toBeLessThan(clrMapOvrIndex)
    expect(clrMapOvrIndex).toBeLessThan(transitionIndex)
    expect(transitionIndex).toBeLessThan(timingIndex)
  })

  it('dom-to-pptx 2.1.1 が出力する p:timing がある場合も、timing を残して transition を差し替える', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、差し替えのテストです。`dom-to-pptx` 2.1.1 のアニメーションに由来する `p:timing` がある場合に、`p:timing` の中身を変えずに切り替え効果だけを差し替え、要素の順序も保つことを確認します。')
    // fixture は、明示指定（`data-pptx-animation`）が出す形の p:timing を最小化したもの。
    // dom-to-pptx 2.1.1 は CSS animation を PowerPoint のアニメーションへ変換するため、
    // 出現エフェクトのある slide には p:timing が付く。ここを取りこぼすと、transition の挿入で
    // 要素順序が cSld → clrMapOvr → transition → timing から崩れるか、timing 自体が落ちる。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
        <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">
            <p:transition spd="med" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" p14:dur="300"><p:fade/></p:transition>
          </mc:Choice>
          <mc:Fallback>
            <p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="med"><p:fade/></p:transition>
          </mc:Fallback>
        </mc:AlternateContent>
        <p:timing>
          <p:tnLst>
            <p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
              <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
                <p:par><p:cTn id="5" presetID="10" presetClass="entr" fill="hold" grpId="0" nodeType="clickEffect"><p:childTnLst>
                  <p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="600"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:animEffect>
                </p:childTnLst></p:cTn></p:par>
              </p:childTnLst></p:cTn></p:seq>
            </p:childTnLst></p:cTn></p:par>
          </p:tnLst>
          <p:bldLst><p:bldP spid="5" grpId="0" animBg="1"/></p:bldLst>
        </p:timing>
      </p:sld>
    `)

    applyTransition(slide, 'fade', 500)

    // fixture 側の AC は除去され、pecotv の AC 1 個だけが残る。
    expect(slide.selectNodes('/p:sld/mc:AlternateContent', NAMESPACES)).toHaveLength(1)
    // timing の中身（アニメーション本体と bldLst）は触らない。
    expect(slide.selectNodes('/p:sld/p:timing//p:animEffect', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('/p:sld/p:timing//p:bldP', NAMESPACES)).toHaveLength(1)

    const xml = serializeTestXml(slide)
    expect(xml).toContain('p14:dur="500"')
    expect(xml).not.toContain('p14:dur="300"')
    const cSldIndex = xml.indexOf('<p:cSld')
    const clrMapOvrIndex = xml.indexOf('<p:clrMapOvr')
    const transitionIndex = xml.indexOf('<mc:AlternateContent')
    const timingIndex = xml.indexOf('<p:timing')
    expect(cSldIndex).toBeLessThan(clrMapOvrIndex)
    expect(clrMapOvrIndex).toBeLessThan(transitionIndex)
    expect(transitionIndex).toBeLessThan(timingIndex)
  })

  it('clrMapOvr が存在しない場合は、cSld の直後に挿入する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、挿入する位置のテストです。`p:clrMapOvr` が存在しないスライドの場合に、切り替え効果が `p:cSld` の直後で、`p:timing` の前に挿入されることを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:timing/>
      </p:sld>
    `)

    applyTransition(slide, 'morph', 800)

    const xml = serializeTestXml(slide)
    const transitionIndex = xml.indexOf('<mc:AlternateContent')
    const timingIndex = xml.indexOf('<p:timing')
    expect(transitionIndex).toBeGreaterThan(-1)
    expect(timingIndex).toBeGreaterThan(-1)
    expect(xml.indexOf('<p:cSld')).toBeLessThan(transitionIndex)
    expect(transitionIndex).toBeLessThan(timingIndex)
  })

  it('cSld と clrMapOvr が存在しない場合は、スライドの末尾に追加する', async () => {
    await explains('スライドへ切り替え効果を追加する `applyTransition` の、挿入する位置のテストです。`p:cSld` と `p:clrMapOvr` が存在しないスライドの場合に、切り替え効果が `p:timing` の後に追加されることを確認します。')
    const slide = parseTestXml(`<p:sld ${SLIDE_NS_DECL}><p:timing/></p:sld>`)

    applyTransition(slide, 'fade', 500)

    expect(slide.selectNodes('/p:sld/mc:AlternateContent', NAMESPACES)).toHaveLength(1)
    const xml = serializeTestXml(slide)
    expect(xml.indexOf('<p:timing')).toBeLessThan(xml.indexOf('<mc:AlternateContent'))
  })
})

describe('removeAnimationTiming', () => {
  // #1070: 明示指定を持たないスライドから出現アニメーションを落とす。削除対象は
  // /p:sld/p:timing の 1 要素だけで、アニメーション状態はすべてその内側にある。
  const TIMING_XML = `
        <p:timing>
          <p:tnLst>
            <p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
              <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
                <p:par><p:cTn id="5" presetID="10" presetClass="entr" fill="hold" grpId="0" nodeType="clickEffect"><p:childTnLst>
                  <p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="600"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:animEffect>
                  <p:set><p:cBhvr><p:cTn id="8" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>
                </p:childTnLst></p:cTn></p:par>
              </p:childTnLst></p:cTn></p:seq>
            </p:childTnLst></p:cTn></p:par>
          </p:tnLst>
          <p:bldLst><p:bldP spid="5" grpId="0" animBg="1"/></p:bldLst>
        </p:timing>`

  function slideWithTiming(): ReturnType<typeof parseTestXml> {
    return parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
        ${TIMING_XML}
      </p:sld>
    `)
  }

  it('p:timing がある場合は、p:timing とその配下のアニメーションの設定をまとめて削除する', async () => {
    await explains('アニメーションの設定を取り除く `removeAnimationTiming` の、削除のテストです。`p:timing` を持つスライドを渡した場合に、`p:timing` と、その配下の `p:bldLst` や `p:animEffect` などがすべて削除され、削除した件数が 1 になることを確認します。')
    const slide = slideWithTiming()

    expect(removeAnimationTiming(slide)).toStrictEqual({ removed: 1 })

    expect(slide.selectNodes('/p:sld/p:timing', NAMESPACES)).toHaveLength(0)
    // bldLst / animEffect / set / seq / cTn はすべて timing の内側にあり、外側には残らない。
    for (const xpath of ['//p:bldLst', '//p:animEffect', '//p:set', '//p:seq', '//p:cTn']) {
      expect(slide.selectNodes(xpath, NAMESPACES), `${xpath} が timing の外に残っている`).toHaveLength(0)
    }
  })

  it('p:timing を削除する場合は、ほかの子要素と要素の順序を変えない', async () => {
    await explains('アニメーションの設定を取り除く `removeAnimationTiming` の、周辺の要素のテストです。`p:timing` を削除した後も、`p:cSld` と `p:clrMapOvr` が 1 つずつ残り、本文のテキストと順序が変わらないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${TEXT.body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
        ${TIMING_XML}
      </p:sld>
    `)

    removeAnimationTiming(slide)

    const xml = serializeTestXml(slide)
    expect(xml).toContain('本文')
    expect(xml).not.toContain('<p:timing')
    expect(xml.indexOf('<p:cSld')).toBeLessThan(xml.indexOf('<p:clrMapOvr'))
    expect(slide.selectNodes('/p:sld/p:cSld', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('/p:sld/p:clrMapOvr', NAMESPACES)).toHaveLength(1)
  })

  it('p:timing がないスライドの場合は、何も変更しない', async () => {
    await explains('アニメーションの設定を取り除く `removeAnimationTiming` の、対象外のスライドのテストです。`p:timing` を持たないスライドを渡した場合に、削除した件数が 0 になり、XML が変わらないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
      </p:sld>
    `)
    const before = serializeTestXml(slide)

    expect(removeAnimationTiming(slide)).toStrictEqual({ removed: 0 })

    expect(serializeTestXml(slide)).toBe(before)
  })

  it('p:extLst の配下にある p:timing の場合は、削除せず残す', async () => {
    await explains('アニメーションの設定を取り除く `removeAnimationTiming` の、削除する範囲のテストです。スライド直下の `p:timing` だけを削除し、`p:extLst` の配下にある同名の `p:timing` は残ることを確認します。')
    // 削除対象はスライド直下の 1 要素だけ。xpath を `//p:timing` へ広げると拡張領域に
    // 同名要素を置いた出力まで壊すため、直下のみを消すことを固定する。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
        ${TIMING_XML}
        <p:extLst>
          <p:ext uri="{00000000-0000-0000-0000-000000000000}">
            <p:timing><p:tnLst/></p:timing>
          </p:ext>
        </p:extLst>
      </p:sld>
    `)

    expect(removeAnimationTiming(slide)).toStrictEqual({ removed: 1 })

    expect(slide.selectNodes('/p:sld/p:timing', NAMESPACES)).toHaveLength(0)
    expect(slide.selectNodes('//p:timing', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('/p:sld/p:extLst/p:ext/p:timing', NAMESPACES)).toHaveLength(1)
  })

  it('p:timing を削除した後に applyTransition を適用した場合は、transition が 1 つだけ追加される', async () => {
    await explains('アニメーションの設定を取り除く `removeAnimationTiming` の、`applyTransition` と組み合わせたテストです。`p:timing` を削除した後に `fade` を適用した場合に、`mc:AlternateContent` が 1 つだけ追加され、`p:clrMapOvr` の後に置かれることを確認します。')
    // chain 順は removeAnimationTiming → applyTransition。timing が消えた状態に
    // transition が入るため、装飾スライドでは順序問題そのものが起きない。
    const slide = slideWithTiming()

    removeAnimationTiming(slide)
    applyTransition(slide, 'fade', 500)

    expect(slide.selectNodes('/p:sld/mc:AlternateContent', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('/p:sld/p:timing', NAMESPACES)).toHaveLength(0)
    const xml = serializeTestXml(slide)
    expect(xml.indexOf('<p:clrMapOvr')).toBeLessThan(xml.indexOf('<mc:AlternateContent'))
  })
})

// 宣言に pptx の値が無いテーマ。FontPolicy の 2 項目はどちらも省略できる。
describe('FontPolicy の省略', () => {
  const JAPANESE_RUN_SLIDE = `
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:latin typeface="Inter"/><a:ea typeface="Original JP"/></a:rPr>
                <a:t>${TEXT.greeting}</a:t>
              </a:r>
              <a:endParaRPr><a:latin typeface="Inter"/></a:endParaRPr>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `

  it('ea を指定しない場合は、東アジアの書体を書き込まず、既存の ea も変更しない', async () => {
    await explains('`FontPolicy` の項目を省略した場合の、`ea` のテストです。`FontPolicy` に `ea` を指定しない場合に、補正の件数が 0 になり、既存の `a:ea` が `Original JP` のまま残ることを確認します。')
    const slide = parseTestXml(JAPANESE_RUN_SLIDE)

    const result = applyJapaneseFontFix(slide, {}, new Map())

    expect(result).toStrictEqual({ fontFixed: 0, spacingFixed: 0 })
    const eaNodes = slide.selectNodes('//a:ea', NAMESPACES)
    expect(eaNodes).toHaveLength(1)
    expect(eaNodes[0]?.getAttr('typeface')).toBe('Original JP')
    expect(slide.selectNodes('//a:endParaRPr/a:ea', NAMESPACES)).toHaveLength(0)
  })

  it('ea を指定しない場合も、letterSpacingMap の spc は書き込む', async () => {
    await explains('`FontPolicy` の項目を省略した場合の、`ea` のテストです。`ea` を指定せず、字間の設定がある場合に、書体の補正の件数が 0、字間の補正の件数が 1 になり、`spc` が `105` になることを確認します。')
    const slide = parseTestXml(JAPANESE_RUN_SLIDE)

    const result = applyJapaneseFontFix(
      slide,
      { linkColor: '4F46E5' },
      new Map([[TEXT.greeting, { letterSpacing: '1.4px', fontSize: '7px' }]]),
    )

    expect(result).toStrictEqual({ fontFixed: 0, spacingFixed: 1 })
    const [rpr] = slide.selectNodes('//a:r/a:rPr', NAMESPACES)
    expect(rpr?.getAttr('spc')).toBe('105')
  })

  it('linkColor を指定しない場合は、ハイパーリンクに変換せず、スライドと rels を変更しない', async () => {
    await explains('`FontPolicy` の項目を省略した場合の、`linkColor` のテストです。`linkColor` を指定しない場合に、変換した件数が 0 になり、`a:hlinkClick` が追加されず、`rels` の内容も変わらないことを確認します。')
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:p>
              <a:r>
                <a:rPr><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></a:rPr>
                <a:t>https://example.com/</a:t>
              </a:r>
            </a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = freshRels()
    const before = serializeTestXml(rels)

    const result = applyHyperlinkFix(slide, rels, new Map(), undefined)

    expect(result.converted).toBe(0)
    expect(slide.selectNodes('//a:hlinkClick', NAMESPACES)).toHaveLength(0)
    expect(serializeTestXml(rels)).toBe(before)
  })
})
