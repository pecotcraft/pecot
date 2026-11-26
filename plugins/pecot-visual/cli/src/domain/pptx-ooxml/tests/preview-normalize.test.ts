import { describe, expect, it } from 'vitest'

import { detectPreviewDivergence } from '../preview-normalize.js'
import { parseTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('wrap が none で spAutoFit もある場合は、検出し、図形の名前を取得する', async () => {
    await explains('スライドの表示の差を検出する `detectPreviewDivergence` のテストです。`wrap="none"` と `spAutoFit` を両方持つ図形がある場合に、規則 `spautofit-wrap-none` と図形の名前を含む結果を返すことを確認します。')
    const slide = parseTestXml(slideWithDivergentBodyPr({ shapeName: 'footer-copyright' }))
    const findings = detectPreviewDivergence(slide)
    expect(findings).toStrictEqual([
      { rule: 'spautofit-wrap-none', shapeName: 'footer-copyright' },
    ])
  })

  it('図形に名前がない場合は、shapeName を持たない結果を返す', async () => {
    await explains('スライドの表示の差を検出する `detectPreviewDivergence` のテストです。`wrap="none"` と `spAutoFit` を持つ図形に名前がない場合に、`shapeName` を含まない結果を返すことを確認します。')
    const slide = parseTestXml(slideWithDivergentBodyPr())
    const findings = detectPreviewDivergence(slide)
    expect(findings).toStrictEqual([{ rule: 'spautofit-wrap-none' }])
    expect(findings[0]?.shapeName).toBeUndefined()
  })

  it('wrap が none だけで spAutoFit がない場合は、検出しない', async () => {
    await explains('スライドの表示の差を検出する `detectPreviewDivergence` のテストです。`wrap="none"` だけで `spAutoFit` がない図形を渡した場合に、空の配列を返すことを確認します。')
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

  it('spAutoFit だけで wrap が none でない場合は、検出しない', async () => {
    await explains('スライドの表示の差を検出する `detectPreviewDivergence` のテストです。`spAutoFit` だけで `wrap="none"` でない図形を渡した場合に、空の配列を返すことを確認します。')
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

  it('条件に当てはまる図形が複数ある場合は、すべて列挙する', async () => {
    await explains('スライドの表示の差を検出する `detectPreviewDivergence` のテストです。`wrap="none"` と `spAutoFit` を持つ図形が 2 つある場合に、どちらも結果に含め、図形の名前を `a`、`b` の順に返すことを確認します。')
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
