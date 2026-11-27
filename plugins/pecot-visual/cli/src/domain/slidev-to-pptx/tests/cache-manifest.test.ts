// CacheManifest の検証・決定論的シリアライズ・prune 計算の純関数テスト。
// 破損 manifest を「manifest なし」と同義に扱う契約（FR-006）を、必須フィールドの
// 欠落と型不一致それぞれ 1 件ずつで固定する。
//
// clickStep の型は number | null。
// そのため fixture は、オブジェクトリテラルではなく JSON テキストを parseCacheManifest に通して構築する。
// domain では null リテラルを書けない。

import { describe, expect, it } from 'vitest'

import {
  CACHE_SCHEMA_VERSION,
  computePruneTargets,
  createCacheManifest,
  getCacheEntry,
  parseCacheManifest,
  removeEntries,
  serializeCacheManifest,
  type CacheManifest,
  type SlideCacheEntry,
} from '../cache-manifest.js'
import { compareStrings } from '../../_shared/compare-strings.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const ENV_HASH = 'a'.repeat(64)

const baseEntryFields: Readonly<Record<string, string>> = {
  slideHash: `"${'b'.repeat(64)}"`,
  slideNumber: '1',
  clickStep: 'null',
  pptxFile: '"slide-100.pptx"',
  prerenderFiles: '["prerender-slide100-0.meta.json","prerender-slide100-0.png"]',
  letterSpacingMap: '{"タイトル":{"letterSpacing":"-0.02em","fontSize":"32px"}}',
  hrefMap: JSON.stringify({ リンク: 'https://example.com' }),
  hasExplicitAnimation: 'false',
}

/**
entry フィールドを差し替え（undefined で欠落）した manifest JSON を組み立てる。
*/
function manifestJson(overrides: Readonly<Record<string, string | undefined>> = {}): string {
  const fields = Object.entries({ ...baseEntryFields, ...overrides })
    .filter(([, value]) => value !== undefined)
    .map(([key, value = '']) => `"${key}":${value}`)
  return `{"schemaVersion":2,"envHash":"${ENV_HASH}","entries":{"100":{${fields.join(',')}}}}`
}

function parsedManifest(text: string): CacheManifest {
  const manifest = parseCacheManifest(text)
  if (manifest === undefined) throw new TypeError('fixture は正常な manifest であること')
  return manifest
}

describe('parseCacheManifest', () => {
  it('正常な manifest は、型の付いた値として読み取る', async () => {
    await explains('キャッシュの manifest を読み込む `parseCacheManifest` のテストです。正しい内容の JSON を渡した場合に、`schemaVersion`・`envHash` とエントリの各項目が、期待した値と型で返ることを確認します。')
    const manifest = parsedManifest(manifestJson())
    expect(manifest.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(manifest.envHash).toBe(ENV_HASH)
    const entry = getCacheEntry(manifest, 100)
    // clickStep のみ null リテラルを書けないため個別に確認する。
    expect(Object.keys(entry ?? {}).toSorted(compareStrings)).toStrictEqual([
      'clickStep', 'hasExplicitAnimation', 'hrefMap', 'letterSpacingMap', 'pptxFile',
      'prerenderFiles', 'slideHash', 'slideNumber',
    ])
    expect(entry).toMatchObject({
      slideHash: 'b'.repeat(64),
      slideNumber: 1,
      pptxFile: 'slide-100.pptx',
      prerenderFiles: ['prerender-slide100-0.meta.json', 'prerender-slide100-0.png'],
      letterSpacingMap: { タイトル: { letterSpacing: '-0.02em', fontSize: '32px' } },
      hrefMap: { リンク: 'https://example.com' },
      hasExplicitAnimation: false,
    })
    expect(entry?.clickStep).toBeNull()
  })

  it('clickStep が数値のエントリも、読み取れる', async () => {
    await explains('キャッシュの manifest を読み込む `parseCacheManifest` のテストです。`clickStep` が `2` のエントリを渡した場合に、数値の `2` として返ることを確認します。')
    const manifest = parsedManifest(manifestJson({ clickStep: '2' }))
    expect(getCacheEntry(manifest, 100)?.clickStep).toBe(2)
  })

  it.each([
    ['JSON として不正', '{ not json'],
    ['JSON オブジェクトでない（配列）', '[]'],
    ['JSON オブジェクトでない（文字列）', '"manifest"'],
    ['JSON オブジェクトでない（null）', 'null'],
    ['schemaVersion 不一致（旧 v1）', `{"schemaVersion":1,"envHash":"${ENV_HASH}","entries":{}}`],
    ['schemaVersion 欠落', `{"envHash":"${ENV_HASH}","entries":{}}`],
    ['schemaVersion 型不一致', `{"schemaVersion":"2","envHash":"${ENV_HASH}","entries":{}}`],
    ['envHash 欠落', '{"schemaVersion":2,"entries":{}}'],
    ['envHash 型不一致', '{"schemaVersion":2,"envHash":1,"entries":{}}'],
    ['envHash 空文字', '{"schemaVersion":2,"envHash":"","entries":{}}'],
    ['entries 欠落', `{"schemaVersion":2,"envHash":"${ENV_HASH}"}`],
    ['entries 型不一致', `{"schemaVersion":2,"envHash":"${ENV_HASH}","entries":[]}`],
    ['エントリがオブジェクトでない', `{"schemaVersion":2,"envHash":"${ENV_HASH}","entries":{"100":"x"}}`],
  ])('manifest が「%s」の場合は、undefined を返す', async (_name, text) => {
    await explains(`キャッシュの manifest を読み込む \`parseCacheManifest\` のテストです。内容が「${_name}」の場合に、破損した manifest として \`undefined\` を返すことを確認します。`)
    expect(parseCacheManifest(text)).toBeUndefined()
  })

  it.each([
    ['slideHash 欠落', { slideHash: undefined }],
    ['slideHash 型不一致', { slideHash: '42' }],
    ['slideNumber 欠落', { slideNumber: undefined }],
    ['slideNumber 型不一致', { slideNumber: '"1"' }],
    ['clickStep 欠落', { clickStep: undefined }],
    ['clickStep 型不一致', { clickStep: '"0"' }],
    ['pptxFile 欠落', { pptxFile: undefined }],
    ['pptxFile 型不一致', { pptxFile: '10' }],
    ['prerenderFiles 欠落', { prerenderFiles: undefined }],
    ['prerenderFiles 型不一致', { prerenderFiles: '"a.png"' }],
    ['prerenderFiles の要素が文字列でない', { prerenderFiles: '["a.png",3]' }],
    ['letterSpacingMap 欠落', { letterSpacingMap: undefined }],
    ['letterSpacingMap 型不一致', { letterSpacingMap: '[]' }],
    ['letterSpacingMap の値がオブジェクトでない', { letterSpacingMap: '{"タイトル":"-0.02em"}' }],
    ['letterSpacingMap の letterSpacing 型不一致', { letterSpacingMap: '{"タイトル":{"letterSpacing":1,"fontSize":"32px"}}' }],
    ['letterSpacingMap の fontSize 欠落', { letterSpacingMap: '{"タイトル":{"letterSpacing":"-0.02em"}}' }],
    ['hrefMap 欠落', { hrefMap: undefined }],
    ['hrefMap 型不一致', { hrefMap: '[]' }],
    ['hrefMap の値が文字列でない', { hrefMap: '{"リンク":3}' }],
    ['hasExplicitAnimation 欠落', { hasExplicitAnimation: undefined }],
    ['hasExplicitAnimation 型不一致', { hasExplicitAnimation: '"true"' }],
  ])('エントリが「%s」の場合は、undefined を返す', async (_name, overrides) => {
    await explains(`キャッシュの manifest を読み込む \`parseCacheManifest\` のテストです。エントリが「${_name}」の場合に、破損した manifest として \`undefined\` を返すことを確認します。`)
    expect(parseCacheManifest(manifestJson(overrides))).toBeUndefined()
  })
})

describe('serializeCacheManifest', () => {
  it('キーの挿入順が違っても、同じ文字列を出力する', async () => {
    await explains('manifest を文字列にする `serializeCacheManifest` のテストです。`letterSpacingMap`・`hrefMap`・`prerenderFiles` の並び順だけが違う 2 つの manifest が、同じ文字列になることを確認します。')
    // stepIndex キーは JS の数値キー順序で正規化されるため、実効的な検証対象は
    // letterSpacingMap / hrefMap のような任意文字列キーの並びになる。
    const forward = parsedManifest(manifestJson({
      letterSpacingMap: JSON.stringify({
        アルファ: { letterSpacing: '-0.01em', fontSize: '20px' },
        ゼータ: { letterSpacing: '-0.02em', fontSize: '32px' },
      }),
      hrefMap: '{"A":"https://a.example.com","Z":"https://z.example.com"}',
      prerenderFiles: '["prerender-slide100-0.png","prerender-slide100-1.png"]',
    }))
    const reversed = parsedManifest(manifestJson({
      letterSpacingMap: JSON.stringify({
        ゼータ: { letterSpacing: '-0.02em', fontSize: '32px' },
        アルファ: { letterSpacing: '-0.01em', fontSize: '20px' },
      }),
      hrefMap: '{"Z":"https://z.example.com","A":"https://a.example.com"}',
      prerenderFiles: '["prerender-slide100-1.png","prerender-slide100-0.png"]',
    }))
    expect(serializeCacheManifest(reversed)).toBe(serializeCacheManifest(forward))
  })

  it('複数のエントリの並びが違っても、同じ文字列を出力する', async () => {
    await explains('manifest を文字列にする `serializeCacheManifest` のテストです。2 つのエントリを昇順と降順で追加した場合に、同じ文字列が出力されることを確認します。')
    const entryA = parsedManifest(manifestJson()).entries['100']
    const entryB = parsedManifest(manifestJson({ pptxFile: '"slide-201.pptx"', slideNumber: '2', clickStep: '1' })).entries['100']
    if (entryA === undefined || entryB === undefined) throw new TypeError('fixture 不正')
    const ascending = createCacheManifest(ENV_HASH, new Map([[100, entryA], [201, entryB]]))
    const descending = createCacheManifest(ENV_HASH, new Map([[201, entryB], [100, entryA]]))
    expect(serializeCacheManifest(descending)).toBe(serializeCacheManifest(ascending))
  })

  it('文字列にしてから読み込み直しても、内容が変わらない', async () => {
    await explains('manifest の文字列化と読み込みのテストです。`serializeCacheManifest` の出力を `parseCacheManifest` で読み込み直した場合に、元の manifest と一致し、再度の出力も同じ文字列になることを確認します。')
    const manifest = parsedManifest(manifestJson())
    const text = serializeCacheManifest(manifest)
    expect(parsedManifest(text)).toStrictEqual(manifest)
    expect(serializeCacheManifest(parsedManifest(text))).toBe(text)
  })
})

describe('createCacheManifest / getCacheEntry', () => {
  const entry: SlideCacheEntry = {
    slideHash: 'c'.repeat(64),
    slideNumber: 3,
    clickStep: 1,
    pptxFile: 'slide-301.pptx',
    prerenderFiles: [],
    letterSpacingMap: {},
    hrefMap: {},
    hasExplicitAnimation: false,
  }

  it('stepIndex とエントリの Map から、manifest を作成する', async () => {
    await explains('manifest を作成する `createCacheManifest` のテストです。エントリを 1 件持つ Map を渡した場合に、`schemaVersion` と `envHash` が設定され、`getCacheEntry` で同じエントリを取得できることを確認します。')
    const manifest = createCacheManifest(ENV_HASH, new Map([[301, entry]]))
    expect(manifest.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(manifest.envHash).toBe(ENV_HASH)
    expect(getCacheEntry(manifest, 301)).toStrictEqual(entry)
  })

  it('manifest に存在しない stepIndex を指定した場合は、undefined を返す', async () => {
    await explains('エントリを取得する `getCacheEntry` のテストです。manifest に存在しない `stepIndex` を指定した場合に、`undefined` を返すことを確認します。')
    const manifest = createCacheManifest(ENV_HASH, new Map([[301, entry]]))
    expect(getCacheEntry(manifest, 300)).toBeUndefined()
  })
})

describe('computePruneTargets / removeEntries', () => {
  const manifest = createCacheManifest(ENV_HASH, new Map([
    [100, {
      slideHash: 'x'.repeat(64),
      slideNumber: 1,
      clickStep: 0,
      pptxFile: 'slide-100.pptx',
      prerenderFiles: ['prerender-slide100-0.png'],
      letterSpacingMap: {},
      hrefMap: {},
      hasExplicitAnimation: false,
    }],
    [200, {
      slideHash: 'y'.repeat(64),
      slideNumber: 2,
      clickStep: 0,
      pptxFile: 'slide-200.pptx',
      prerenderFiles: ['prerender-slide200-0.png', 'prerender-slide200-0.meta.json'],
      letterSpacingMap: {},
      hrefMap: {},
      hasExplicitAnimation: true,
    }],
  ]))

  it('スキャン結果に存在しない stepIndex のエントリと成果物を、削除対象にする', async () => {
    await explains('削除対象を求める `computePruneTargets` のテストです。生存している `stepIndex` に含まれないエントリがある場合に、そのキーと、pptx と prerender のファイルが削除対象として返ることを確認します。')
    expect(computePruneTargets(manifest, [100])).toStrictEqual({
      stepKeys: ['200'],
      files: ['prerender-slide200-0.meta.json', 'prerender-slide200-0.png', 'slide-200.pptx'],
    })
  })

  it('すべての stepIndex が生存している場合は、削除対象が空になる', async () => {
    await explains('削除対象を求める `computePruneTargets` のテストです。manifest の `stepIndex` がすべて生存している場合に、キーとファイルのどちらも空で返ることを確認します。')
    expect(computePruneTargets(manifest, [100, 200])).toStrictEqual({ stepKeys: [], files: [] })
  })

  it('指定したキーのエントリを除いた manifest を返す', async () => {
    await explains('エントリを取り除く `removeEntries` のテストです。キー `200` を指定した場合に、残りのエントリが `100` だけになり、`envHash` と `schemaVersion` が変わらないことを確認します。')
    const pruned = removeEntries(manifest, ['200'])
    expect(Object.keys(pruned.entries)).toStrictEqual(['100'])
    expect(pruned.envHash).toBe(ENV_HASH)
    expect(pruned.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
  })
})
