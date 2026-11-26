// domain/drawio/url.ts の純粋関数 generateDrawioViewerUrl に対する pin test。
// prepareDrawioXml 済みの XML を受け取る前提だが、icon:// とコメントのどちらも持たない XML は、そのまま渡せる。
// そのため前処理なしの最小 XML で、domain 単体を検証する。

import { describe, expect, it } from 'vitest'

import { generateDrawioViewerUrl } from '../../../../src/domain/drawio/url.js'
import { explains } from '../../../_helpers/explains.js'

const MINIMAL_XML = `<mxfile><diagram><mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="2" parent="1" vertex="1" value="Hello">
    <mxGeometry x="40" y="40" width="120" height="40" as="geometry"/>
  </mxCell>
</root></mxGraphModel></diagram></mxfile>`

describe('generateDrawioViewerUrl', () => {
  it('生成した URL は、lightbox を有効にした draw.io のアドレスで始まる', async () => {
    await explains('`generateDrawioViewerUrl` が作る閲覧用 URL のテストです。最小の XML を渡した場合に、`https://app.diagrams.net/?lightbox=1` で始まる URL を返すことを確認します。')
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    expect(url.startsWith('https://app.diagrams.net/?lightbox=1')).toBe(true)
  })

  it('生成した URL は、編集画面の表示を抑えるクエリを含む', async () => {
    await explains('`generateDrawioViewerUrl` が作る閲覧用 URL のテストです。`edit=_blank`・`layers=1`・`nav=1`・`toolbar=0` のクエリがすべて含まれることを確認します。')
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    expect(url).toContain('edit=_blank')
    expect(url).toContain('layers=1')
    expect(url).toContain('nav=1')
    expect(url).toContain('toolbar=0')
  })

  it('生成した URL には viewbox のクエリを含めず、lightbox の自動縮小に任せる', async () => {
    await explains('`generateDrawioViewerUrl` が作る閲覧用 URL のテストです。`#` より前のクエリ部分に `viewbox=` が含まれないことを確認します。')
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    const queryEnd = url.indexOf('#')
    const query = queryEnd === -1 ? url : url.slice(0, queryEnd)
    expect(query).not.toContain('viewbox=')
  })

  it('生成した URL は、#R の後ろに base64 の文字列を持つ', async () => {
    await explains('`generateDrawioViewerUrl` が作る閲覧用 URL のテストです。`#R` が存在し、その後ろに空でない base64 の文字列が続くことを確認します。')
    const url = generateDrawioViewerUrl(MINIMAL_XML)
    const hashIndex = url.indexOf('#R')
    expect(hashIndex).toBeGreaterThan(0)
    const base64 = url.slice(hashIndex + 2)
    expect(base64.length).toBeGreaterThan(0)
    // base64 文字集合 (paddings 含む)
    expect(/^[\d+/a-z]+=*$/i.test(base64)).toBe(true)
  })

  it('同じ XML で複数回呼び出しても、同じ URL を返す', async () => {
    await explains('`generateDrawioViewerUrl` に同じ XML を 2 回渡した場合のテストです。どちらの呼び出しでも、まったく同じ URL を返すことを確認します。')
    const a = generateDrawioViewerUrl(MINIMAL_XML)
    const b = generateDrawioViewerUrl(MINIMAL_XML)
    expect(a).toBe(b)
  })
})
