import { describe, expect, it, vi } from 'vitest'

import {
  applyPrerenderImageReplace,
  buildPicMediaMap,
  fallbackSizeMatch,
  findPrerenderImages,
  getPngDimensions,
  matchPrerenderToMedia,
  type PicRecord,
  type PrerenderEntry,
} from '../prerender-replace.js'
import { parseTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'

const SLIDE_NS_DECL = [
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(' ')

const RELS_NS_DECL = 'xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"'

// 最小 PNG (8 byte signature + 16 byte IHDR チャンク領域)。
// CRC は省略してよい。
// getPngDimensions は、magic と IHDR marker、W/H 4 byte ずつのみ参照する。
function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  // signature
  buffer.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0)
  // chunk length (4 byte) - 値は読まれないので 0
  buffer.writeUInt32BE(13, 8)
  // IHDR marker
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeBrokenPng(): Buffer {
  // PNG magic 不一致 (24 byte 以上だが先頭が PNG ではない)
  return Buffer.alloc(32, 0x00)
}

describe('getPngDimensions', () => {
  it('正常 PNG の W/H を返す', () => {
    expect(getPngDimensions(makePng(640, 480))).toStrictEqual({ width: 640, height: 480 })
  })

  it('PNG signature 不一致なら undefined を返す', () => {
    expect(getPngDimensions(makeBrokenPng())).toBeUndefined()
  })

  it('24 byte 未満の buffer は undefined を返す', () => {
    expect(getPngDimensions(Buffer.alloc(20))).toBeUndefined()
  })

  it('IHDR marker が無い PNG は undefined を返す (signature 一致のみ)', () => {
    const buffer = makePng(100, 100)
    // IHDR を書き換えて IHDR marker 不一致を作る
    buffer.write('XXXX', 12, 'ascii')
    expect(getPngDimensions(buffer)).toBeUndefined()
  })
})

function emptyRels(): ReturnType<typeof parseTestXml> {
  return parseTestXml(`<rel:Relationships ${RELS_NS_DECL}/>`)
}

function relsWith(targets: readonly { readonly id: string, readonly target: string }[]): ReturnType<typeof parseTestXml> {
  const inner = targets
    .map(t => `<rel:Relationship Id="${t.id}" Type="x" Target="${t.target}"/>`)
    .join('')
  return parseTestXml(`<rel:Relationships ${RELS_NS_DECL}>${inner}</rel:Relationships>`)
}

describe('buildPicMediaMap', () => {
  it('単一 pic で W/H と座標を抽出する', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId5"/></p:blipFill>
            <p:spPr><a:xfrm>
              <a:off x="100000" y="200000"/>
              <a:ext cx="300000" cy="400000"/>
            </a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([{ id: 'rId5', target: '../media/image1.png' }])
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])

    const result = buildPicMediaMap(slide, rels, partMap)

    expect(result).toHaveLength(1)
    expect(result[0]).toStrictEqual<PicRecord>({
      mediaPart: 'ppt/media/image1.png',
      xEmu: 100_000,
      yEmu: 200_000,
      cxEmu: 300_000,
      cyEmu: 400_000,
      pngWidth: 800,
      pngHeight: 600,
    })
  })

  it('複数 pic を (yEmu, xEmu) 順にソートする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="500" y="500"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>
          </p:pic>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="200" y="100"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>
          </p:pic>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId3"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="100" y="500"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([
      { id: 'rId1', target: '../media/a.png' },
      { id: 'rId2', target: '../media/b.png' },
      { id: 'rId3', target: '../media/c.png' },
    ])
    const partMap = new Map<string, Buffer>()

    const result = buildPicMediaMap(slide, rels, partMap)

    expect(result.map(r => r.mediaPart)).toStrictEqual([
      'ppt/media/b.png', // y=100
      'ppt/media/c.png', // y=500, x=100
      'ppt/media/a.png', // y=500, x=500
    ])
  })

  it('rels が空なら空配列を返す', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    expect(buildPicMediaMap(slide, emptyRels(), new Map())).toStrictEqual([])
  })

  it('blipFill/blip が無い pic はスキップする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    expect(buildPicMediaMap(slide, emptyRels(), new Map())).toStrictEqual([])
  })

  it('blip に r:embed が無い pic はスキップする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    expect(buildPicMediaMap(slide, emptyRels(), new Map())).toStrictEqual([])
  })

  it('xfrm/off/ext が欠損する pic はスキップする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([{ id: 'rId1', target: '../media/x.png' }])
    expect(buildPicMediaMap(slide, rels, new Map())).toStrictEqual([])
  })

  it('media file の PNG が不正なら pngWidth/Height = 0 で記録する', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([{ id: 'rId1', target: '../media/broken.png' }])
    const partMap = new Map<string, Buffer>([['ppt/media/broken.png', makeBrokenPng()]])

    const result = buildPicMediaMap(slide, rels, partMap)

    expect(result).toHaveLength(1)
    expect(result[0]?.pngWidth).toBe(0)
    expect(result[0]?.pngHeight).toBe(0)
  })

  it('Target が ../media/ を含まない rel はスキップする (chart/hyperlink 除外)', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([
      { id: 'rId1', target: '../charts/chart1.xml' },
    ])
    expect(buildPicMediaMap(slide, rels, new Map())).toStrictEqual([])
  })

  it('rel に Target が無いケースはスキップする', () => {
    const slide = parseTestXml(`<p:sld ${SLIDE_NS_DECL}><p:cSld><p:spTree/></p:cSld></p:sld>`)
    const rels = parseTestXml(
      `<rel:Relationships ${RELS_NS_DECL}><rel:Relationship Id="rId1" Type="x"/></rel:Relationships>`,
    )
    expect(buildPicMediaMap(slide, rels, new Map())).toStrictEqual([])
  })

  it('rel に Id が無いケースはスキップする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree/></p:cSld>
      </p:sld>
    `)
    // Id 無し relationship は warning 無くスキップされる (build 結果に影響しない)
    const rels = parseTestXml(
      `<rel:Relationships ${RELS_NS_DECL}><rel:Relationship Type="x" Target="../media/y.png"/></rel:Relationships>`,
    )
    expect(buildPicMediaMap(slide, rels, new Map())).toStrictEqual([])
  })

  it('off/ext の x/y が parseInt 失敗 (NaN) なら 0 として記録する', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm>
              <a:off x="not-a-number" y="200000"/>
              <a:ext cx="300000" cy="400000"/>
            </a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([{ id: 'rId1', target: '../media/x.png' }])
    const result = buildPicMediaMap(slide, rels, new Map())
    expect(result[0]?.xEmu).toBe(0)
    expect(result[0]?.yEmu).toBe(200_000)
  })

  it('off/ext の x/y/cx/cy が欠損する場合は 0 として記録する', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off/><a:ext/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = relsWith([{ id: 'rId1', target: '../media/x.png' }])
    const result = buildPicMediaMap(slide, rels, new Map())
    expect(result[0]).toMatchObject({ xEmu: 0, yEmu: 0, cxEmu: 0, cyEmu: 0 })
  })

  it('rid と対応する media が rels に無い pic はスキップする', () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rIdMissing"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    expect(buildPicMediaMap(slide, emptyRels(), new Map())).toStrictEqual([])
  })
})

function pic(
  mediaPart: string,
  xEmu: number,
  yEmu: number,
  pngWidth: number,
  pngHeight: number,
): PicRecord {
  return { mediaPart, xEmu, yEmu, cxEmu: 0, cyEmu: 0, pngWidth, pngHeight }
}

describe('matchPrerenderToMedia', () => {
  it('単一候補の距離 / サイズ合致時にその mediaPart を返す', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 5, top: 5 },
      map,
      new Set(),
    )
    expect(result).toBe('ppt/media/a.png')
  })

  it('複数候補から最近傍を選ぶ (前候補より遠い後候補は更新しない)', () => {
    // 順番は、一番近い、中間、一番遠い。
    // 最初で bestDistance が確定する。
    // 2/3 番目では、if (distance < bestDistance) が false になる分岐を通す。
    const map = [
      pic('ppt/media/near.png', 9525 * 5, 9525 * 5, 800, 600), // 距離 ~7
      pic('ppt/media/mid.png', 9525 * 20, 9525 * 20, 800, 600), // 距離 ~28
      pic('ppt/media/far.png', 9525 * 30, 9525 * 30, 800, 600), // 距離 ~42
    ]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBe('ppt/media/near.png')
  })

  it('複数候補で後ろの候補が距離小なら更新する', () => {
    const map = [
      pic('ppt/media/far.png', 9525 * 30, 9525 * 30, 800, 600),
      pic('ppt/media/near.png', 9525 * 5, 9525 * 5, 800, 600),
    ]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBe('ppt/media/near.png')
  })

  it('距離が tolerance 超過なら undefined を返す', () => {
    const map = [pic('ppt/media/a.png', 9525 * 200, 9525 * 200, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBeUndefined()
  })

  it('サイズ相対誤差が 15% 超過なら undefined を返す', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 1000, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBeUndefined()
  })

  it('meta.left が undefined なら undefined を返す (1 段目スキップ)', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(matchPrerenderToMedia({ width: 800, height: 600 }, map, new Set())).toBeUndefined()
  })

  it('meta.top が undefined なら undefined を返す', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(matchPrerenderToMedia({ width: 800, height: 600, left: 0 }, map, new Set())).toBeUndefined()
  })

  it('matched に含まれる候補は除外する', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(['ppt/media/a.png']),
    )
    expect(result).toBeUndefined()
  })

  it('pngWidth=0 の候補はサイズ判定で除外される', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 0, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBeUndefined()
  })
})

describe('fallbackSizeMatch', () => {
  it('サイズが ±15% 内ならヒット', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 750, 580)]
    const result = fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())
    expect(result).toBe('ppt/media/a.png')
  })

  it('全候補がサイズ超過なら undefined', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 1000, 1000)]
    const result = fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())
    expect(result).toBeUndefined()
  })

  it('candidates が空なら undefined', () => {
    expect(fallbackSizeMatch({ width: 800, height: 600 }, [], new Set())).toBeUndefined()
  })

  it('pngWidth=0 の候補は continue する', () => {
    const map = [
      pic('ppt/media/zero.png', 0, 0, 0, 600),
      pic('ppt/media/match.png', 0, 0, 800, 600),
    ]
    expect(fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())).toBe('ppt/media/match.png')
  })

  it('matched に含まれる候補は除外する', () => {
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(
      fallbackSizeMatch({ width: 800, height: 600 }, map, new Set(['ppt/media/a.png'])),
    ).toBeUndefined()
  })

  it('pngHeight=0 の候補は continue する (W のみ 0 ではないケース)', () => {
    const map = [pic('ppt/media/zero-h.png', 0, 0, 800, 0)]
    expect(fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())).toBeUndefined()
  })
})

describe('findPrerenderImages', () => {
  it('該当ファイルが無ければ空配列', async () => {
    const result = await findPrerenderImages('/tmp/slides', 1, {
      exists: () => Promise.resolve(false),
    })
    expect(result).toStrictEqual([])
  })

  it('連番ヒットで全 entry を返す (i=0,1,2 まで存在し i=3 で停止)', async () => {
    const existing = new Set([
      '/tmp/slides/prerender-slide1-0.png',
      '/tmp/slides/prerender-slide1-1.png',
      '/tmp/slides/prerender-slide1-2.png',
    ])
    const result = await findPrerenderImages('/tmp/slides', 1, {
      exists: path => Promise.resolve(existing.has(path)),
    })

    expect(result).toStrictEqual<readonly PrerenderEntry[]>([
      {
        imagePath: '/tmp/slides/prerender-slide1-0.png',
        metaPath: '/tmp/slides/prerender-slide1-0.meta.json',
      },
      {
        imagePath: '/tmp/slides/prerender-slide1-1.png',
        metaPath: '/tmp/slides/prerender-slide1-1.meta.json',
      },
      {
        imagePath: '/tmp/slides/prerender-slide1-2.png',
        metaPath: '/tmp/slides/prerender-slide1-2.meta.json',
      },
    ])
  })

  it('欠番が出たら以降は走査しない (i=0 のみ存在 → 1 件)', async () => {
    const existing = new Set(['/tmp/x/prerender-slide5-0.png'])
    const result = await findPrerenderImages('/tmp/x', 5, {
      exists: path => Promise.resolve(existing.has(path)),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.imagePath).toBe('/tmp/x/prerender-slide5-0.png')
  })
})

function slide1Pic(): ReturnType<typeof parseTestXml> {
  return parseTestXml(`
    <p:sld ${SLIDE_NS_DECL}>
      <p:cSld><p:spTree>
        <p:pic>
          <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
          <p:spPr><a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="0" cy="0"/>
          </a:xfrm></p:spPr>
        </p:pic>
      </p:spTree></p:cSld>
    </p:sld>
  `)
}

function slideEmpty(): ReturnType<typeof parseTestXml> {
  return parseTestXml(`<p:sld ${SLIDE_NS_DECL}><p:cSld><p:spTree/></p:cSld></p:sld>`)
}

function rels1(): ReturnType<typeof parseTestXml> {
  return parseTestXml(
    `<rel:Relationships ${RELS_NS_DECL}>`
    + `<rel:Relationship Id="rId1" Type="x" Target="../media/image1.png"/>`
    + '</rel:Relationships>',
  )
}

function relsEmpty(): ReturnType<typeof parseTestXml> {
  return parseTestXml(`<rel:Relationships ${RELS_NS_DECL}/>`)
}

function ioStub(
  files: ReadonlyMap<string, Buffer>,
): { readonly readFile: (path: string) => Promise<Buffer>, readonly warn: (message: string) => void } {
  return {
    warn: () => { /* 警告の検証が要るテストは自前の io を使う */ },
    readFile: (path: string) => {
      const data = files.get(path)
      return data === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(data)
    },
  }
}

describe('applyPrerenderImageReplace', () => {
  it('1 段目ヒットで partMap が高解像度版に差し替わる', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const original = makePng(800, 600)
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', original]])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    const io = ioStub(new Map([
      ['/tmp/prerender-slide1-0.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/prerender-slide1-0.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{
        imagePath: '/tmp/prerender-slide1-0.png',
        metaPath: '/tmp/prerender-slide1-0.meta.json',
      }],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
    expect(partMap.get('ppt/media/image1.png')).toStrictEqual(hires)
  })

  it('2 段目: meta.left/top 無しなら 1 段目スキップしてサイズのみで差し替え', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/p.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/p.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/p.png', metaPath: '/tmp/p.meta.json' }],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
    expect(partMap.get('ppt/media/image1.png')).toStrictEqual(hires)
  })

  it('3 段目: pic_media_map 空 (rels なし) なら ppt/media/*.png を全件走査して絶対差 50px 以内を差し替え', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const partMap = new Map<string, Buffer>([
      ['ppt/media/image1.png', makePng(810, 595)], // 800/600 と ±50px 以内
      ['ppt/media/image2.png', makePng(1000, 1000)], // tolerance 外
    ])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/p.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/p.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/p.png', metaPath: '/tmp/p.meta.json' }],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
    expect(partMap.get('ppt/media/image1.png')).toStrictEqual(hires)
    expect(partMap.get('ppt/media/image2.png')).not.toStrictEqual(hires)
  })

  it('3 段目: PNG magic 不正な media file は無視する', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const partMap = new Map<string, Buffer>([
      ['ppt/media/broken.png', makeBrokenPng()],
      ['ppt/media/ok.png', makePng(810, 600)],
    ])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/p.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/p.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/p.png', metaPath: '/tmp/p.meta.json' }],
      io,
    )

    expect(result.replaced).toBe(1)
    expect(partMap.get('ppt/media/broken.png')).toStrictEqual(makeBrokenPng())
    expect(partMap.get('ppt/media/ok.png')).toStrictEqual(hires)
  })

  it('3 段目: ppt/media/*.png 以外のパス (theme1.xml 等) は走査しない', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const partMap = new Map<string, Buffer>([
      ['ppt/theme/theme1.xml', Buffer.from('<theme/>', 'utf8')],
      ['ppt/media/notes.svg', makePng(810, 600)], // .svg なので skip
      ['ppt/media/img.png', makePng(810, 600)],
    ])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/p.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/p.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/p.png', metaPath: '/tmp/p.meta.json' }],
      io,
    )

    expect(result.replaced).toBe(1)
    expect(partMap.get('ppt/media/img.png')).toStrictEqual(hires)
  })

  it('entries 空なら no-op で replaced=0', async () => {
    const result = await applyPrerenderImageReplace(
      slideEmpty(),
      relsEmpty(),
      new Map(),
      [],
      { readFile: () => { throw new Error('should not be called') }, warn: () => { /* noop */ } },
    )
    expect(result).toStrictEqual({ replaced: 0 })
  })

  it('meta.json が JSON parse 失敗なら entry をスキップして継続する', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const hires = makePng(1600, 1200)
    const goodMeta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    const io = ioStub(new Map([
      ['/tmp/bad.meta.json', Buffer.from('not json', 'utf8')],
      ['/tmp/bad.png', hires],
      ['/tmp/good.meta.json', Buffer.from(goodMeta, 'utf8')],
      ['/tmp/good.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [
        { imagePath: '/tmp/bad.png', metaPath: '/tmp/bad.meta.json' },
        { imagePath: '/tmp/good.png', metaPath: '/tmp/good.meta.json' },
      ],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
  })

  it('meta.json が読み込めない (readFile reject) ならスキップする', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/missing.png', metaPath: '/tmp/missing.meta.json' }],
      { readFile: () => Promise.reject(new Error('ENOENT')), warn: () => { /* noop */ } },
    )

    expect(result).toStrictEqual({ replaced: 0 })
  })

  it('meta は読めるが image readFile が reject する場合は warn して entry を skip する (existence-after-stat レース対策)', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const goodMeta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    // meta path のみ resolve、image path は reject
    const warnSpy = vi.fn()
    const io = {
      warn: warnSpy,
      readFile: (filePath: string) => {
        return filePath.endsWith('.meta.json') ? Promise.resolve(Buffer.from(goodMeta, 'utf8')) : Promise.reject(new Error('ENOENT (race)'))
      },
    }
    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/race.png', metaPath: '/tmp/race.meta.json' }],
      io,
    )
    expect(result).toStrictEqual({ replaced: 0 })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prerender image read failed'))
  })

  it('meta が array (object だが record で無い扱い) ならスキップする', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const partMap = new Map<string, Buffer>()
    // 配列も typeof が object で null でもないが、width/height が数値でないため undefined を返す
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from('[1,2,3]', 'utf8')],
      ['/tmp/a.png', makePng(0, 0)],
    ]))
    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' }],
      io,
    )
    expect(result.replaced).toBe(0)
  })

  it('meta が JSON object でない (null) ならスキップする', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from('null', 'utf8')],
      ['/tmp/a.png', makePng(0, 0)],
    ]))
    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      new Map(),
      [{ imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' }],
      io,
    )
    expect(result.replaced).toBe(0)
  })

  it('meta に width が string で型不正ならスキップする', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const meta = Buffer.from(JSON.stringify({ width: 'big', height: 600 }), 'utf8')
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', meta],
      ['/tmp/a.png', makePng(0, 0)],
    ]))
    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      new Map(),
      [{ imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' }],
      io,
    )
    expect(result.replaced).toBe(0)
  })

  it('matched に既出の mediaPart は 1 段目で再選択されない (二重マッチ防止)', async () => {
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const hires1 = makePng(1600, 1200)
    const hires2 = makePng(1700, 1300)
    const meta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/a.png', hires1],
      ['/tmp/b.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/b.png', hires2],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [
        { imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' },
        { imagePath: '/tmp/b.png', metaPath: '/tmp/b.meta.json' },
      ],
      io,
    )

    // 1 件目は 1 段目ヒットで採用する。
    // 2 件目は、唯一の候補が matched 入りなので 1 段目が undefined になる。
    // 2 段目も同じ候補のため undefined になり、pic_media_map.length>0 でも 3 段目は発動しない。
    expect(result).toStrictEqual({ replaced: 1 })
    expect(partMap.get('ppt/media/image1.png')).toStrictEqual(hires1)
  })

  it('1 段目で同 mediaPart の既マッチ警告分岐: 別 entry が同 part を 1 段目で返した場合は、2 段目へ進まず replaced は増えない', async () => {
    // matchPrerenderToMedia 内で matched を確認している。
    // matched に既存の媒体は、1 段目の候補から最初に除外される。
    // その動作は、上記「二重マッチ防止」テストで確認済み。
    // ここでは、1 段目が undefined を返した後に、2 段目で matched 判定を通る分岐を別途検証する。
    const slide = parseTestXml(`
      <p:sld ${SLIDE_NS_DECL}>
        <p:cSld><p:spTree>
          <p:pic>
            <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>
    `)
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const hires1 = makePng(1600, 1200)
    const hires2 = makePng(1700, 1300)
    // 1 件目 (left/top あり) が 1 段目で matched 入り、2 件目は left/top 無しで 2 段目に行くが matched 除外されて undefined
    const metaA = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    const metaB = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from(metaA, 'utf8')],
      ['/tmp/a.png', hires1],
      ['/tmp/b.meta.json', Buffer.from(metaB, 'utf8')],
      ['/tmp/b.png', hires2],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [
        { imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' },
        { imagePath: '/tmp/b.png', metaPath: '/tmp/b.meta.json' },
      ],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
  })

  it('3 段目: 複数 entries で同一 mediaPart が matched 入りした後の entry は再選択しない', async () => {
    const slide = slideEmpty()
    const rels = relsEmpty()
    const partMap = new Map<string, Buffer>([
      ['ppt/media/img.png', makePng(800, 600)],
    ])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600 })
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/a.png', hires],
      ['/tmp/b.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/b.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [
        { imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' },
        { imagePath: '/tmp/b.png', metaPath: '/tmp/b.meta.json' },
      ],
      io,
    )

    // 1 件目で 3 段目発動・matched に img.png 追加、2 件目では同 img.png が matched 済で skip
    expect(result.replaced).toBe(1)
  })

  it('meta.json の selector フィールドは PrerenderMeta に保持される (1 段目の分岐は変わらない)', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    const partMap = new Map<string, Buffer>([['ppt/media/image1.png', makePng(800, 600)]])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0, selector: '.mermaid' })
    const io = ioStub(new Map([
      ['/tmp/a.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/a.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/a.png', metaPath: '/tmp/a.meta.json' }],
      io,
    )

    expect(result).toStrictEqual({ replaced: 1 })
  })

  it('3 段目: pic_media_map が非空なら 1/2 段目「全敗」でも発動しない', async () => {
    const slide = slide1Pic()
    const rels = rels1()
    // pic_media_map に 1 件あるが、pngWidth=0 (不正な PNG) で 1 段目と 2 段目のどちらも matched できない
    const partMap = new Map<string, Buffer>([
      ['ppt/media/image1.png', makeBrokenPng()],
      ['ppt/media/other.png', makePng(810, 600)], // 3 段目があれば差し替わってしまうサイズ
    ])
    const hires = makePng(1600, 1200)
    const meta = JSON.stringify({ width: 800, height: 600, left: 0, top: 0 })
    const io = ioStub(new Map([
      ['/tmp/p.meta.json', Buffer.from(meta, 'utf8')],
      ['/tmp/p.png', hires],
    ]))

    const result = await applyPrerenderImageReplace(
      slide,
      rels,
      partMap,
      [{ imagePath: '/tmp/p.png', metaPath: '/tmp/p.meta.json' }],
      io,
    )

    expect(result.replaced).toBe(0)
    expect(partMap.get('ppt/media/other.png')).not.toStrictEqual(hires)
  })
})
