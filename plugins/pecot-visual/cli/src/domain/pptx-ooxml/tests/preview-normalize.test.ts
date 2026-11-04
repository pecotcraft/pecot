import { describe, expect, it } from 'vitest'

import { NAMESPACES } from '../post-process.js'
import {
  applyPreviewNormalization,
  detectPreviewDivergence,
} from '../preview-normalize.js'
import { parseTestXml, serializeTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'

const SLIDE_NS_DECL = [
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
].join(' ')

/**
`wrap="none"` + `<a:spAutoFit/>` を持つ bodyPr を name 付き shape 内に配置した slide。
`algn="l"` を併記し、本来は左揃え想定のテキストであることを示す。
*/
function slideWithDivergentBodyPr(options: {
  readonly shapeName?: string
  readonly extraBodyPrAttrs?: string
} = {}): string {
  const nvSpPr = options.shapeName === undefined
    ? `<p:nvSpPr><p:cNvPr id="2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    : `<p:nvSpPr><p:cNvPr id="2" name="${options.shapeName}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
  const extra = options.extraBodyPrAttrs ?? ''
  return `
    <p:sld ${SLIDE_NS_DECL}>
      <p:cSld><p:spTree>
        <p:sp>
          ${nvSpPr}
          <p:txBody>
            <a:bodyPr wrap="none"${extra === '' ? '' : ' ' + extra}><a:spAutoFit/></a:bodyPr>
            <a:p><a:pPr algn="l"/><a:r><a:t>footer</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
    </p:sld>`
}

describe('detectPreviewDivergence', () => {
  it('wrap=none + spAutoFit の組み合わせを検知し shapeName を解決する', () => {
    const slide = parseTestXml(slideWithDivergentBodyPr({ shapeName: 'footer-copyright' }))
    const findings = detectPreviewDivergence(slide)
    expect(findings).toStrictEqual([
      { rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
  })

  it('shape name が無ければ shapeName を undefined で degrade する', () => {
    const slide = parseTestXml(slideWithDivergentBodyPr())
    const findings = detectPreviewDivergence(slide)
    expect(findings).toStrictEqual([{ rule: 'spautofit-wrap-none' }])
    expect(findings[0]?.shapeName).toBeUndefined()
  })

  it('wrap=none だけ (spAutoFit 無し) は検知しない', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:bodyPr wrap="none"/>
            <a:p><a:r><a:t>x</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`)
    expect(detectPreviewDivergence(slide)).toStrictEqual([])
  })

  it('spAutoFit だけ (wrap=none 無し) は検知しない', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>
            <a:p><a:r><a:t>x</a:t></a:r></a:p>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`)
    expect(detectPreviewDivergence(slide)).toStrictEqual([])
  })

  it('複数の divergent bodyPr を全件列挙する', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="2" name="a"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:txBody><a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr><a:p/></p:txBody>
          </p:sp>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:txBody><a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr><a:p/></p:txBody>
          </p:sp>
        </p:spTree></p:cSld>
      </p:sld>`)
    expect(detectPreviewDivergence(slide)).toStrictEqual([
      { rule: 'spautofit-wrap-none', shapeName: 'a' },
      { rule: 'spautofit-wrap-none', shapeName: 'b' },
    ])
  })
})

describe('applyPreviewNormalization', () => {
  it('wrap を square に書き換え spAutoFit を noAutofit に置換する', () => {
    const slide = parseTestXml(slideWithDivergentBodyPr({ shapeName: 's' }))
    const result = applyPreviewNormalization(slide)
    expect(result).toStrictEqual({ normalized: 1 })

    const [bodyPr] = slide.selectNodes('//a:bodyPr[@wrap=\'square\']', NAMESPACES)
    expect(bodyPr).toBeDefined()
    expect(slide.selectNodes('//a:noAutofit', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('//a:spAutoFit', NAMESPACES)).toHaveLength(0)
  })

  it('wrap=none / spAutoFit 単独出現は置換しない', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:sp><p:txBody>
            <a:bodyPr wrap="none"/>
            <a:p/>
          </p:txBody></p:sp>
          <p:sp><p:txBody>
            <a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>
            <a:p/>
          </p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`)
    const result = applyPreviewNormalization(slide)
    expect(result).toStrictEqual({ normalized: 0 })
    // wrap=none の単独 bodyPr は touch されていない
    expect(slide.selectNodes('//a:bodyPr[@wrap=\'none\']', NAMESPACES)).toHaveLength(1)
    // spAutoFit 単独はそのまま残る
    expect(slide.selectNodes('//a:spAutoFit', NAMESPACES)).toHaveLength(1)
    expect(slide.selectNodes('//a:noAutofit', NAMESPACES)).toHaveLength(0)
  })

  it('bodyPr の他属性 (lIns 等) は保存される', () => {
    const slide = parseTestXml(
      slideWithDivergentBodyPr({ extraBodyPrAttrs: 'lIns="91440" rtlCol="0"' }),
    )
    applyPreviewNormalization(slide)
    const [bodyPr] = slide.selectNodes('//a:bodyPr[@wrap=\'square\']', NAMESPACES)
    expect(bodyPr?.getAttr('lIns')).toBe('91440')
    expect(bodyPr?.getAttr('rtlCol')).toBe('0')
  })

  it('冪等 — 正規化済み slide を再適用しても 0 件で変化しない', () => {
    const slide = parseTestXml(slideWithDivergentBodyPr({ shapeName: 's' }))
    applyPreviewNormalization(slide)
    const after1 = serializeTestXml(slide)

    const second = applyPreviewNormalization(slide)
    expect(second).toStrictEqual({ normalized: 0 })
    expect(serializeTestXml(slide)).toBe(after1)
  })

  it('正規化後は detectPreviewDivergence が 0 件になる', () => {
    const slide = parseTestXml(slideWithDivergentBodyPr({ shapeName: 's' }))
    applyPreviewNormalization(slide)
    expect(detectPreviewDivergence(slide)).toStrictEqual([])
  })
})
