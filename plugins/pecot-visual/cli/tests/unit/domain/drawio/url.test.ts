// domain/drawio/url.ts の純粋関数 generateDrawioViewerUrl に対する pin test。
// prepareDrawioXml 済みの XML を受け取る前提だが、icon:// とコメントのどちらも持たない XML は、そのまま渡せる。
// そのため前処理なしの最小 XML で、domain 単体を検証する。

import { describe, expect, it } from 'vitest'

import { generateDrawioViewerUrl } from '../../../../src/domain/drawio/url.js'

const MINIMAL_XML = `<mxfile><diagram><mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="2" parent="1" vertex="1" value="Hello">
    <mxGeometry x="40" y="40" width="120" height="40" as="geometry"/>
  </mxCell>
</root></mxGraphModel></diagram></mxfile>`

describe('generateDrawioViewerUrl', () => {
  it('lightbox プレフィックスで始まる', () => {
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    expect(url.startsWith('https://app.diagrams.net/?lightbox=1')).toBe(true)
  })

  it('editor UI 抑止のクエリ群を含む', () => {
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    expect(url).toContain('edit=_blank')
    expect(url).toContain('layers=1')
    expect(url).toContain('nav=1')
    expect(url).toContain('toolbar=0')
  })

  it('viewbox クエリは付与しない (lightbox の scale-to-fit に任せる)', () => {
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    const queryEnd = url.indexOf('#')
    const query = queryEnd === -1 ? url : url.slice(0, queryEnd)
    expect(query).not.toContain('viewbox=')
  })

  it('#R の後に base64 文字列が続く', () => {
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    const hashIndex = url.indexOf('#R')
    expect(hashIndex).toBeGreaterThan(0)
    const base64 = url.slice(hashIndex + 2)
    expect(base64.length).toBeGreaterThan(0)
    // base64 文字集合 (paddings 含む)
    expect(/^[\d+/a-z]+=*$/i.test(base64)).toBe(true)
  })

  it('同じ XML で複数回呼んで戻り値が一致する（決定論性）', () => {
    const a = generateDrawioViewerUrl(MINIMAL_XML)
    const b = generateDrawioViewerUrl(MINIMAL_XML)
    expect(a).toBe(b)
  })
})
