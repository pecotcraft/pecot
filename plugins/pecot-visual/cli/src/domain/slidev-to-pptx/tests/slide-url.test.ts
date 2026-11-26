/* eslint-disable unicorn/no-null -- SlideStep.clickStep は未指定を null で表すため、期待値も null で書く */
import { describe, expect, it } from 'vitest'

import { buildPrintUrl, buildSlideUrl, parseSlideUrl } from '../slide-url.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('buildSlideUrl', () => {
  it('history ルータの場合は、パスにスライド番号を置いた URL を作成する', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`hash: false` でスライド番号 5 を指定した場合に、`http://localhost:3002/5` が返ることを確認します。')
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: false })).toBe('http://localhost:3002/5')
  })

  it('history ルータの場合は、clicks をクエリに含めた URL を作成する', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`hash: false` で `clicks: 2` を指定した場合に、`?clicks=2` が付いた URL を返すことを確認します。')
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: false, clicks: 2 }))
      .toBe('http://localhost:3002/5?clicks=2')
  })

  it('hash ルータの場合は、フラグメントにスライド番号を置いた URL を作成する', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`hash: true` でスライド番号 5 を指定した場合に、`http://localhost:3002/#/5` が返ることを確認します。')
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: true })).toBe('http://localhost:3002/#/5')
  })

  it('hash ルータの場合は、clicks をフラグメント内のクエリに含めた URL を作成する', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`hash: true` で `clicks: 1` を指定した場合に、`#/4?clicks=1` の形の URL を返すことを確認します。')
    expect(buildSlideUrl('http://localhost:3002', 4, { hash: true, clicks: 1 }))
      .toBe('http://localhost:3002/#/4?clicks=1')
  })

  it('clicks が 0 の場合も、クエリに含める（省略するのは clicks を指定しない場合だけ）', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`clicks: 0` を指定した場合に、`?clicks=0` が省略されずに URL へ含まれることを確認します。')
    expect(buildSlideUrl('http://localhost:3002', 4, { hash: true, clicks: 0 }))
      .toBe('http://localhost:3002/#/4?clicks=0')
  })

  it('baseUrl の末尾にスラッシュがある場合も、スラッシュが重ならない URL を作成する', async () => {
    await explains('スライドの URL を作成する `buildSlideUrl` のテストです。`http://localhost:3002/` を渡した場合に、`hash` の有無にかかわらず、スラッシュが重ならない URL を返すことを確認します。')
    expect(buildSlideUrl('http://localhost:3002/', 5, { hash: true })).toBe('http://localhost:3002/#/5')
    expect(buildSlideUrl('http://localhost:3002/', 5, { hash: false })).toBe('http://localhost:3002/5')
  })
})

describe('parseSlideUrl', () => {
  it('ルートのパスの URL は、スライド番号 1・clickStep が null として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`http://localhost:3002/` を渡した場合に、`slideNumber` が 1 で、`clickStep` が `null` になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/')).toStrictEqual({
      slideNumber: 1,
      clickStep: null,
      url: 'http://localhost:3002/',
    })
  })

  it('パスが数値の URL は、その数値をスライド番号として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`http://localhost:3002/5` を渡した場合に、`slideNumber` が 5 で、`clickStep` が `null` になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/5')).toStrictEqual({
      slideNumber: 5,
      clickStep: null,
      url: 'http://localhost:3002/5',
    })
  })

  it('クエリに clicks=N がある URL は、N を clickStep として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/5?clicks=3` を渡した場合に、`slideNumber` が 5 で、`clickStep` が 3 になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/5?clicks=3')).toStrictEqual({
      slideNumber: 5,
      clickStep: 3,
      url: 'http://localhost:3002/5?clicks=3',
    })
  })

  it('パスが数値でない URL は、スライド番号 1 として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/foo` のように数値でないパスを渡した場合に、`slideNumber` が 1 になることを確認します。')
    const result = parseSlideUrl('http://localhost:3002/foo')
    expect(result.slideNumber).toBe(1)
  })

  it('hash ルータの `#/N` は、N をスライド番号として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/#/5` を渡した場合に、`slideNumber` が 5 で、`clickStep` が `null` になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/#/5')).toStrictEqual({
      slideNumber: 5,
      clickStep: null,
      url: 'http://localhost:3002/#/5',
    })
  })

  it('hash ルータの clicks は、フラグメント内のクエリから取得する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/#/4?clicks=1` を渡した場合に、`slideNumber` が 4 で、`clickStep` が 1 になることを確認します。')
    // pathname / searchParams だけを見ると、slide=1 / click=null に潰れる。
    // すると全ステップの stepIndex が衝突する（#971 で起きた不具合）。
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=1')).toStrictEqual({
      slideNumber: 4,
      clickStep: 1,
      url: 'http://localhost:3002/#/4?clicks=1',
    })
  })

  it('hash ルータのルート（`#/`）は、スライド番号 1・clickStep が null として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/#/` を渡した場合に、`slideNumber` が 1 で、`clickStep` が `null` になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/#/')).toStrictEqual({
      slideNumber: 1,
      clickStep: null,
      url: 'http://localhost:3002/#/',
    })
  })

  it('clicks が数値でない場合は、未指定と同じ null として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`clicks=abc` を渡した場合に、`NaN` ではなく `clickStep` が `null` になることを確認します。')
    // NaN を通すと stepIndex が NaN になり `slide-NaN.pptx` を書き出す。
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=abc').clickStep).toBeNull()
  })

  it('clicks が空の場合も、null として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`clicks=` のように値が空の場合に、`clickStep` が `null` になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=').clickStep).toBeNull()
  })

  it('複数桁のスライド番号と clicks も、解析できる', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/#/12?clicks=3` を渡した場合に、`slideNumber` が 12 で、`clickStep` が 3 になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/#/12?clicks=3')).toStrictEqual({
      slideNumber: 12,
      clickStep: 3,
      url: 'http://localhost:3002/#/12?clicks=3',
    })
  })

  it('clicks が負の値の場合も、そのまま解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`clicks=-1` を渡した場合に、`clickStep` が -1 になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=-1').clickStep).toBe(-1)
  })

  it('`#/0` の URL は、スライド番号 1 として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。スライド番号が 0 の `/#/0` を渡した場合に、`slideNumber` が 1 になることを確認します。')
    // Slidev のスライド番号は 1 始まりで 0 は存在しない。パース結果 0 をそのまま通すと
    // stepIndex が 0 になり、ルート (`#/`) のステップと衝突する。
    expect(parseSlideUrl('http://localhost:3002/#/0').slideNumber).toBe(1)
  })

  it('`#/` で始まらないフラグメントは、history ルータの URL として解析する', async () => {
    await explains('スライドの URL を解析する `parseSlideUrl` のテストです。`/7?clicks=1#note` を渡した場合に、`slideNumber` が 7 で、`clickStep` が 1 になることを確認します。')
    expect(parseSlideUrl('http://localhost:3002/7?clicks=1#note')).toStrictEqual({
      slideNumber: 7,
      clickStep: 1,
      url: 'http://localhost:3002/7?clicks=1#note',
    })
  })
})

describe('buildPrintUrl', () => {
  it('history ルータの場合は、/print に print=clicks を付け、range は付けない', async () => {
    await explains('印刷用の URL を作成する `buildPrintUrl` のテストです。`hash: false` の場合に、`/print?print=clicks` が返り、`range` が含まれないことを確認します。')
    expect(buildPrintUrl('http://localhost:3002', { hash: false })).toBe('http://localhost:3002/print?print=clicks')
  })

  it('hash ルータの場合は、print=clicks をフラグメントの前に置く', async () => {
    await explains('印刷用の URL を作成する `buildPrintUrl` のテストです。`hash: true` の場合に、`/?print=clicks#/print` のようにクエリがフラグメントの前に置かれることを確認します。')
    expect(buildPrintUrl('http://localhost:3002', { hash: true })).toBe('http://localhost:3002/?print=clicks#/print')
  })

  it('baseUrl の末尾にスラッシュがある場合も、スラッシュが重ならない URL を作成する', async () => {
    await explains('印刷用の URL を作成する `buildPrintUrl` のテストです。末尾にスラッシュのある `baseUrl` を渡した場合に、`hash` の有無にかかわらず、スラッシュが重ならない URL を返すことを確認します。')
    expect(buildPrintUrl('http://localhost:3002/', { hash: false })).toBe('http://localhost:3002/print?print=clicks')
    expect(buildPrintUrl('http://localhost:3002//', { hash: true })).toBe('http://localhost:3002/?print=clicks#/print')
  })
})
