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
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('正しい PNG の場合は、幅と高さを返す', async () => {
    await explains('PNG ファイルの幅と高さを取得する `getPngDimensions` の、成功のテストです。幅 640、高さ 480 の PNG を渡した場合に、その幅と高さを返すことを確認します。')
    expect(getPngDimensions(makePng(640, 480))).toStrictEqual({ width: 640, height: 480 })
  })

  it('PNG のシグネチャが一致しない場合は、undefined を返す', async () => {
    await explains('PNG ファイルの幅と高さを取得する `getPngDimensions` の、シグネチャのテストです。先頭が PNG のシグネチャと一致しないデータを渡した場合に、`undefined` を返すことを確認します。')
    expect(getPngDimensions(makeBrokenPng())).toBeUndefined()
  })

  it('24 バイト未満のデータの場合は、undefined を返す', async () => {
    await explains('PNG ファイルの幅と高さを取得する `getPngDimensions` の、データの長さのテストです。24 バイト未満のデータを渡した場合に、`undefined` を返すことを確認します。')
    expect(getPngDimensions(Buffer.alloc(20))).toBeUndefined()
  })

  it('IHDR のマーカーが存在しない場合は、シグネチャが一致しても undefined を返す', async () => {
    await explains('PNG ファイルの幅と高さを取得する `getPngDimensions` の、`IHDR` チャンクのテストです。シグネチャが正しく、`IHDR` のマーカーだけが一致しないデータを渡した場合に、`undefined` を返すことを確認します。')
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
  it('pic が 1 つの場合は、画像ファイルの幅と高さ、位置と大きさを取り出す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、成功のテストです。`p:pic` が 1 つあるスライドを渡した場合に、画像ファイルの場所と、位置・大きさ（EMU）、PNG の幅と高さを取り出すことを確認します。')
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

  it('pic が複数ある場合は、縦の位置、横の位置の順に並べ替える', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、並び順のテストです。`p:pic` が 3 つあり、位置がばらばらの場合に、`y` の昇順で並び、`y` が同じなら `x` の昇順になることを確認します。')
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

  it('rels が空の場合は、空の配列を返す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、`rels` が空の場合のテストです。`p:pic` があっても `Relationship` が存在しない場合に、空の配列を返すことを確認します。')
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

  it('blipFill や blip が存在しない pic の場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、対象外の `p:pic` のテストです。`p:blipFill` が存在しない `p:pic` を渡した場合に、空の配列を返すことを確認します。')
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

  it('blip に r:embed が存在しない pic の場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、対象外の `p:pic` のテストです。`a:blip` に `r:embed` が存在しない場合は、空の配列を返すことを確認します。')
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

  it('xfrm、off、ext のいずれかが不足している pic の場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、対象外の `p:pic` のテストです。`a:ext` が存在しない `p:pic` を渡した場合に、空の配列を返すことを確認します。')
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

  it('画像ファイルの PNG が不正な場合は、幅と高さを 0 として記録する', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、不正な PNG のテストです。`rels` が指す画像を PNG として読めない場合は、記録を残し、幅と高さを 0 にすることを確認します。')
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

  it('Target に ../media/ を含まない rel の場合は、対象から外す (グラフやリンクの除外)', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、画像以外の関連のテストです。`Target` が `../charts/chart1.xml` のように `../media/` を含まない場合に、空の配列を返すことを確認します。')
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

  it('rel に Target が存在しない場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、`Target` が存在しない `Relationship` のテストです。`Target` を持たない `Relationship` があっても、空の配列を返すことを確認します。')
    const slide = parseTestXml(`<p:sld ${SLIDE_NS_DECL}><p:cSld><p:spTree/></p:cSld></p:sld>`)
    const rels = parseTestXml(
      `<rel:Relationships ${RELS_NS_DECL}><rel:Relationship Id="rId1" Type="x"/></rel:Relationships>`,
    )
    expect(buildPicMediaMap(slide, rels, new Map())).toStrictEqual([])
  })

  it('rel に Id が存在しない場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、`Id` が存在しない `Relationship` のテストです。`Id` を持たない `Relationship` があっても、例外が発生せず、空の配列を返すことを確認します。')
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

  it('off の x が数値として読めない場合は、0 として記録する', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、数値でない属性のテストです。`a:off` の `x` が `not-a-number` の場合に、`xEmu` を 0 とし、`yEmu` は指定した値のままにすることを確認します。')
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

  it('off と ext の属性が存在しない場合は、0 として記録する', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、属性が存在しない場合のテストです。`a:off` と `a:ext` に属性が存在しない場合に、位置と大きさをすべて 0 として記録することを確認します。')
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

  it('rId に対応する画像が rels に存在しない pic の場合は、対象から外す', async () => {
    await explains('スライドの画像と、その位置・大きさを対応付ける `buildPicMediaMap` の、対応する関連が存在しない場合のテストです。`r:embed` の `rId` が `rels` に存在しない場合は、空の配列を返すことを確認します。')
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
  it('候補が 1 つで、距離と大きさが許容範囲内の場合は、その mediaPart を返す', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、成功のテストです。位置と大きさがほぼ同じ候補を 1 つ渡した場合は、その `mediaPart` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 5, top: 5 },
      map,
      new Set(),
    )
    expect(result).toBe('ppt/media/a.png')
  })

  it('候補が複数ある場合は、最も近い候補を選ぶ (遠い後ろの候補では更新しない)', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、候補が複数ある場合のテストです。近い順に並んだ 3 つの候補では、先頭の最も近い候補を選ぶことを確認します。')
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

  it('候補が複数あり、後ろの候補のほうが近い場合は、その候補に更新する', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、候補が複数ある場合のテストです。遠い候補の後ろに近い候補がある場合に、近いほうの `mediaPart` を返すことを確認します。')
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

  it('距離が許容範囲を超える場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、距離のテストです。候補の位置が許容範囲より遠い場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 9525 * 200, 9525 * 200, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBeUndefined()
  })

  it('大きさの相対誤差が 15% を超える場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、大きさのテストです。幅の相対誤差が 15% を超える候補だけがある場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 1000, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(),
    )
    expect(result).toBeUndefined()
  })

  it('meta に left が存在しない場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、位置が存在しない場合のテストです。`left` を持たない情報を渡した場合に、位置による対応付けができず、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(matchPrerenderToMedia({ width: 800, height: 600 }, map, new Set())).toBeUndefined()
  })

  it('meta に top が存在しない場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、位置が存在しない場合のテストです。`top` を持たない情報を渡した場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(matchPrerenderToMedia({ width: 800, height: 600, left: 0 }, map, new Set())).toBeUndefined()
  })

  it('すでに対応付けた候補の場合は、除外する', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、対応付け済みの候補のテストです。`matched` に含まれる `mediaPart` だけが候補の場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    const result = matchPrerenderToMedia(
      { width: 800, height: 600, left: 0, top: 0 },
      map,
      new Set(['ppt/media/a.png']),
    )
    expect(result).toBeUndefined()
  })

  it('pngWidth が 0 の候補の場合は、大きさの判定で除外する', async () => {
    await explains('事前に描画した画像を、位置と大きさで対応する画像に結び付ける `matchPrerenderToMedia` の、不正な画像のテストです。`pngWidth` が 0 の候補だけがある場合に、大きさの判定で除外し、`undefined` を返すことを確認します。')
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
  it('大きさの差が ±15% 以内の場合は、一致とみなす', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、成功のテストです。幅と高さが 800 × 600 に対して ±15% 以内の候補がある場合に、その `mediaPart` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 750, 580)]
    const result = fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())
    expect(result).toBe('ppt/media/a.png')
  })

  it('すべての候補が大きさの差を超える場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、大きさのテストです。すべての候補が 15% を超えて異なる場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 1000, 1000)]
    const result = fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())
    expect(result).toBeUndefined()
  })

  it('候補が空の場合は、undefined を返す', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、候補が空の場合のテストです。候補の配列が空の場合に、`undefined` を返すことを確認します。')
    expect(fallbackSizeMatch({ width: 800, height: 600 }, [], new Set())).toBeUndefined()
  })

  it('pngWidth が 0 の候補の場合は、飛ばして次の候補を調べる', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、不正な画像のテストです。`pngWidth` が 0 の候補の後ろに一致する候補がある場合に、一致する候補の `mediaPart` を返すことを確認します。')
    const map = [
      pic('ppt/media/zero.png', 0, 0, 0, 600),
      pic('ppt/media/match.png', 0, 0, 800, 600),
    ]
    expect(fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())).toBe('ppt/media/match.png')
  })

  it('すでに対応付けた候補の場合は、除外する', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、対応付け済みの候補のテストです。`matched` に含まれる `mediaPart` だけが候補の場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/a.png', 0, 0, 800, 600)]
    expect(
      fallbackSizeMatch({ width: 800, height: 600 }, map, new Set(['ppt/media/a.png'])),
    ).toBeUndefined()
  })

  it('pngHeight が 0 の候補の場合は、幅が 0 でなくても飛ばす', async () => {
    await explains('事前に描画した画像を、大きさだけで対応する画像に結び付ける `fallbackSizeMatch` の、不正な画像のテストです。`pngWidth` は一致するが `pngHeight` が 0 の候補だけがある場合に、`undefined` を返すことを確認します。')
    const map = [pic('ppt/media/zero-h.png', 0, 0, 800, 0)]
    expect(fallbackSizeMatch({ width: 800, height: 600 }, map, new Set())).toBeUndefined()
  })
})

describe('findPrerenderImages', () => {
  it('該当するファイルが存在しない場合は、空の配列を返す', async () => {
    await explains('事前に描画した画像のファイルを探す `findPrerenderImages` の、ファイルが存在しない場合のテストです。どのファイルも存在しない場合に、空の配列を返すことを確認します。')
    const result = await findPrerenderImages('/tmp/slides', 1, {
      exists: () => Promise.resolve(false),
    })
    expect(result).toStrictEqual([])
  })

  it('連番のファイルが存在する場合は、すべての entry を返す (0、1、2 が存在し、3 で止まる)', async () => {
    await explains('事前に描画した画像のファイルを探す `findPrerenderImages` の、連番のテストです。`prerender-slide1-0.png` から `-2.png` までが存在する場合に、3 件の画像のパスと `meta.json` のパスを返すことを確認します。')
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

  it('欠番が出た場合は、以降を調べない (0 だけが存在する場合は 1 件)', async () => {
    await explains('事前に描画した画像のファイルを探す `findPrerenderImages` の、欠番のテストです。連番の先頭の `-0.png` だけが存在する場合に、1 件だけを返すことを確認します。')
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
  it('位置と大きさで一致した場合は、partMap の画像を高解像度の画像に差し替える', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、位置と大きさによる差し替えのテストです。位置と大きさの一致する画像がある場合は、`partMap` の画像を高解像度の画像に差し替え、`replaced` を 1 にすることを確認します。')
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

  it('meta に left と top が存在しない場合は、大きさだけで対応付けて差し替える', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、大きさだけによる差し替えのテストです。位置を持たない情報の場合に、大きさが一致する画像を高解像度の画像に差し替えることを確認します。')
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

  it('スライドに画像が存在しない場合は、ppt/media の PNG をすべて調べ、差が 50px 以内のものを差し替える', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、画像の一覧が空の場合のテストです。スライドに画像がなく、`ppt/media` に PNG がある場合に、幅と高さの差が 50px 以内の PNG だけを差し替えることを確認します。')
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

  it('スライドに画像が存在しない場合、PNG として不正なファイルは差し替えの対象から外す', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、不正な PNG のテストです。`ppt/media` に PNG として不正なファイルと正しいファイルがある場合に、不正なファイルは変更せず、正しいファイルだけを差し替えることを確認します。')
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

  it('スライドに画像が存在しない場合、ppt/media の PNG 以外のパスは調べない', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、対象のパスのテストです。`ppt/theme/theme1.xml` や `.svg` のファイルがある場合に、`ppt/media` の PNG だけを差し替え、`replaced` が 1 になることを確認します。')
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

  it('entries が空の場合は、何も変更せず replaced を 0 にする', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、対象が存在しない場合のテストです。`entries` が空の場合に、ファイルを読み込まず、`replaced` が 0 になることを確認します。')
    const result = await applyPrerenderImageReplace(
      slideEmpty(),
      relsEmpty(),
      new Map(),
      [],
      { readFile: () => { throw new Error('should not be called') }, warn: () => { /* noop */ } },
    )
    expect(result).toStrictEqual({ replaced: 0 })
  })

  it('meta.json を JSON として読めない場合は、その entry を飛ばして続ける', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、不正な `meta.json` のテストです。1 つ目の `meta.json` が JSON として不正な場合に、その entry を飛ばし、2 つ目の entry だけを差し替えることを確認します。')
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

  it('meta.json を読み込めない場合は、その entry を飛ばす', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、読み込みの失敗のテストです。`meta.json` の読み込みが失敗する場合に、画像を差し替えず、`replaced` が 0 になることを確認します。')
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

  it('meta.json は読めて画像の読み込みが失敗する場合は、警告を出して entry を飛ばす (存在確認の後に消えた場合)', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、画像の読み込みの失敗のテストです。`meta.json` は読み込めて、画像の読み込みが失敗する場合に、`prerender image read failed` を含む警告を表示し、`replaced` が 0 になることを確認します。')
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

  it('meta が配列の場合は、その entry を飛ばす', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、不正な `meta.json` のテストです。`meta.json` の中身が配列（`[1,2,3]`）の場合に、`replaced` が 0 になることを確認します。')
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

  it('meta が null の場合は、その entry を飛ばす', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、不正な `meta.json` のテストです。`meta.json` の中身が `null` の場合に、`replaced` が 0 になることを確認します。')
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

  it('meta の width が文字列の場合は、その entry を飛ばす', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、不正な `meta.json` のテストです。`width` が文字列（`big`）の場合に、`replaced` が 0 になることを確認します。')
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

  it('すでに対応付けた mediaPart は、位置と大きさの対応付けで再び選ばない (二重の対応付けの防止)', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、二重の対応付けのテストです。画像が 1 つだけのスライドに同じ位置・大きさの entry が 2 つある場合に、1 つ目だけを差し替え、`replaced` が 1 になることを確認します。')
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

  it('位置と大きさで対応付けた後の entry は、大きさだけの対応付けでも同じ mediaPart を選ばない', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、二重の対応付けのテストです。1 つ目を位置と大きさで対応付け、2 つ目は大きさだけで対応付ける場合に、同じ画像は再び差し替えず、`replaced` が 1 になることを確認します。')
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

  it('スライドに画像が存在しない場合、複数の entry でも同じ mediaPart は 1 回だけ差し替える', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、二重の対応付けのテストです。画像の一覧が空で、同じ大きさの entry が 2 つある場合に、同じ PNG を 2 回差し替えず、`replaced` が 1 になることを確認します。')
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

  it('meta に selector がある場合も、位置と大きさによる対応付けの結果は変わらない', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、`selector` のテストです。`meta.json` に `selector`（`.mermaid`）がある場合も、位置と大きさで一致する画像を差し替え、`replaced` が 1 になることを確認します。')
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

  it('スライドに画像がある場合は、位置と大きさの対応付けと大きさだけの対応付けが失敗しても、PNG の全件の調査は行わない', async () => {
    await explains('事前に描画した高解像度の画像で、スライドの画像を差し替える `applyPrerenderImageReplace` の、調査の範囲のテストです。画像が PNG として不正で、2 段階の対応付けがどちらも失敗する場合に、`ppt/media` の別の PNG を差し替えず、`replaced` が 0 になることを確認します。')
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
