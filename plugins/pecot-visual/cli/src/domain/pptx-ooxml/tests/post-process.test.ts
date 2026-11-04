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
  it('日本語テキストの rPr に既存の a:ea があれば typeface を上書きする', () => {
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

  it('日本語テキストで a:ea が無ければ新規追加する', () => {
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

  it('英数字のみのテキストは変更しない', () => {
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

  it('letter-spacing マッチで rPr に spc 属性が付与される', () => {
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

  it('endParaRPr: 段落内に日本語があり末尾プロパティに a:ea が無ければ新規追加する', () => {
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

  it('endParaRPr: 段落内に日本語があれば末尾プロパティの ea を更新する', () => {
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

  it('a:t が空文字列の run はスキップする', () => {
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

  it('a:rPr が無い run はスキップする (font fix)', () => {
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

  it('endParaRPr: 段落内が英数字のみなら ea を変更しない', () => {
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

  it('a:r 内に a:t が無いケースはスキップする (例外で fail しない)', () => {
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

  it('a:rPr 直下に a:latin がある場合、a:ea は a:latin の直後 sibling として挿入される', () => {
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

  it('a:rPr 直下に a:latin が無い場合は従来どおり末尾 append で a:ea が rPr の最後の子として現れる', () => {
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

  it('endParaRPr: a:latin が直下にあれば a:ea は a:latin の直後 sibling として挿入される', () => {
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
  it('CSS-only typeface (-apple-system / system-ui / sans-serif 等) の latin/ea/cs を削除する', () => {
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

  it('cursive / fantasy / inherit / initial / unset も削除対象', () => {
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

  it('実フォント名 (Inter / Noto Sans JP / Display Extended 等) は削除しない', () => {
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

  it('typeface 属性が無い latin/ea/cs は削除しない', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree><p:sp><p:txBody><a:p>
          <a:r><a:rPr><a:latin/><a:ea/><a:cs/></a:rPr><a:t>x</a:t></a:r>
        </a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `)
    expect(sanitizeCssOnlyTypefaces(slide).removed).toBe(0)
  })

  it('sanitize で latin/ea/cs を全削除して空 rPr になっても再 parse 可能 (theme font fallback)', () => {
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
  it('リンク色 + URL テキストを hyperlink 化する', () => {
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

  it('hrefMap マッチでテキストと URL が異なるケースも変換する', () => {
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

  it('リンク色不一致のテキストは無視する', () => {
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

  it('既に hlinkClick がある run は冪等に skip する', () => {
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

  it('a:t が無い run はスキップする', () => {
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

  it('空文字列の a:t を持つ run はスキップする', () => {
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

  it('a:rPr が無い run はスキップする', () => {
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

  it('solidFill/srgbClr が無い run はスキップする', () => {
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

  it('srgbClr に val 属性が無いケースは色不一致扱い', () => {
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

  it('テキストが URL でも hrefMap でもないケースはスキップする', () => {
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

  it('rId 採番は Id 属性を持たない既存 Relationship を無視する', () => {
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

  it('rId 採番は rId プレフィックスを持たない既存 Id を無視する', () => {
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

  it('rId は既存 Relationship 群の最大値+1 から採番する', () => {
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
  it('fade を root に追加する', () => {
    const slide = emptySlide()

    const result = applyTransition(slide, 'fade', 500)

    expect(result.added).toBe(1)
    const xml = serializeTestXml(slide)
    expect(xml).toContain('mc:AlternateContent')
    expect(xml).toContain('p:fade')
    expect(xml).toContain('p14:dur="500"')
  })

  it('morph を root に追加する', () => {
    const slide = emptySlide()

    applyTransition(slide, 'morph', 800)

    const xml = serializeTestXml(slide)
    expect(xml).toContain('p159:morph')
    expect(xml).toContain('option="byObject"')
    expect(xml).toContain('p14:dur="800"')
  })

  it('既存 transition を削除した上で新しいものを追加する (冪等性)', () => {
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

  it('AlternateContent 内に transition があれば AC 自体を削除して再追加する', () => {
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

  it('AlternateContent 内に transition が無ければ既存 AC は維持される', () => {
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

  it('options.morphOption を反映する', () => {
    const slide = emptySlide()

    applyTransition(slide, 'morph', 600, { morphOption: 'byChar' })

    expect(serializeTestXml(slide)).toContain('option="byChar"')
  })

  it('p:timing を持つ slide では transition を clrMapOvr の後・timing の前に挿入する', () => {
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

  it('2.1.1 が出す p:timing を持つ slide でも timing を残したまま transition を差し替える', () => {
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

  it('clrMapOvr が無ければ cSld の直後に挿入する', () => {
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

  it('cSld / clrMapOvr を欠く slide では root 末尾へ追加する', () => {
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

  it('p:timing とその配下のアニメーション状態をまとめて削除する', () => {
    const slide = slideWithTiming()

    expect(removeAnimationTiming(slide)).toStrictEqual({ removed: 1 })

    expect(slide.selectNodes('/p:sld/p:timing', NAMESPACES)).toHaveLength(0)
    // bldLst / animEffect / set / seq / cTn はすべて timing の内側にあり、外側には残らない。
    for (const xpath of ['//p:bldLst', '//p:animEffect', '//p:set', '//p:seq', '//p:cTn']) {
      expect(slide.selectNodes(xpath, NAMESPACES), `${xpath} が timing の外に残っている`).toHaveLength(0)
    }
  })

  it('他の子要素と要素順序を壊さない', () => {
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

  it('timing を持たないスライドでは no-op', () => {
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

  it('p:extLst 配下の p:timing は残す', () => {
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

  it('除去後に applyTransition を通しても transition は 1 件だけ入る', () => {
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

  it('ea が無ければ東アジア書体を書かず、既存の ea も変えない', () => {
    const slide = parseTestXml(JAPANESE_RUN_SLIDE)

    const result = applyJapaneseFontFix(slide, {}, new Map())

    expect(result).toStrictEqual({ fontFixed: 0, spacingFixed: 0 })
    const eaNodes = slide.selectNodes('//a:ea', NAMESPACES)
    expect(eaNodes).toHaveLength(1)
    expect(eaNodes[0]?.getAttr('typeface')).toBe('Original JP')
    expect(slide.selectNodes('//a:endParaRPr/a:ea', NAMESPACES)).toHaveLength(0)
  })

  it('ea が無くても letterSpacingMap の spc は書き込む', () => {
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

  it('linkColor が無ければ hyperlink に置換せず、slide と rels は変えない', () => {
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
