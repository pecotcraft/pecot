/* eslint-disable unicorn/no-null -- SlideStep.clickStep は未指定を null で表すため、期待値も null で書く */
import { describe, expect, it } from 'vitest'

import { buildPrintUrl, buildSlideUrl, parseSlideUrl } from '../slide-url.js'

describe('buildSlideUrl', () => {
  it('history ルータはパスにスライド番号を置く', () => {
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: false })).toBe('http://localhost:3002/5')
  })

  it('history ルータの clicks は query に載る', () => {
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: false, clicks: 2 }))
      .toBe('http://localhost:3002/5?clicks=2')
  })

  it('hash ルータはフラグメントにスライド番号を置く', () => {
    expect(buildSlideUrl('http://localhost:3002', 5, { hash: true })).toBe('http://localhost:3002/#/5')
  })

  it('hash ルータの clicks はフラグメント内の query に載る', () => {
    expect(buildSlideUrl('http://localhost:3002', 4, { hash: true, clicks: 1 }))
      .toBe('http://localhost:3002/#/4?clicks=1')
  })

  it('clicks を渡せば 0 でも query に載せる (省略は clicks 未指定のときだけ)', () => {
    expect(buildSlideUrl('http://localhost:3002', 4, { hash: true, clicks: 0 }))
      .toBe('http://localhost:3002/#/4?clicks=0')
  })

  it('baseUrl の末尾スラッシュを正規化して二重スラッシュを作らない', () => {
    expect(buildSlideUrl('http://localhost:3002/', 5, { hash: true })).toBe('http://localhost:3002/#/5')
    expect(buildSlideUrl('http://localhost:3002/', 5, { hash: false })).toBe('http://localhost:3002/5')
  })
})

describe('parseSlideUrl', () => {
  it('ルートパスは slide=1, click=null', () => {
    expect(parseSlideUrl('http://localhost:3002/')).toStrictEqual({
      slideNumber: 1,
      clickStep: null,
      url: 'http://localhost:3002/',
    })
  })

  it('数値パスを slideNumber に解釈する', () => {
    expect(parseSlideUrl('http://localhost:3002/5')).toStrictEqual({
      slideNumber: 5,
      clickStep: null,
      url: 'http://localhost:3002/5',
    })
  })

  it('クエリ clicks=N で clickStep を取得', () => {
    expect(parseSlideUrl('http://localhost:3002/5?clicks=3')).toStrictEqual({
      slideNumber: 5,
      clickStep: 3,
      url: 'http://localhost:3002/5?clicks=3',
    })
  })

  it('数値ではない pathname は slideNumber=1 にフォールバック', () => {
    const result = parseSlideUrl('http://localhost:3002/foo')
    expect(result.slideNumber).toBe(1)
  })

  it('hash ルータの `#/N` を slideNumber に解釈する', () => {
    expect(parseSlideUrl('http://localhost:3002/#/5')).toStrictEqual({
      slideNumber: 5,
      clickStep: null,
      url: 'http://localhost:3002/#/5',
    })
  })

  it('hash ルータの clicks はフラグメント内 query から取る', () => {
    // pathname / searchParams だけを見ると、slide=1 / click=null に潰れる。
    // すると全ステップの stepIndex が衝突する（#971 で起きた不具合）。
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=1')).toStrictEqual({
      slideNumber: 4,
      clickStep: 1,
      url: 'http://localhost:3002/#/4?clicks=1',
    })
  })

  it('hash ルータのルート (`#/`) は slide=1, click=null', () => {
    expect(parseSlideUrl('http://localhost:3002/#/')).toStrictEqual({
      slideNumber: 1,
      clickStep: null,
      url: 'http://localhost:3002/#/',
    })
  })

  it('数値でない clicks は未指定と同じ null に倒す', () => {
    // NaN を通すと stepIndex が NaN になり `slide-NaN.pptx` を書き出す。
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=abc').clickStep).toBeNull()
  })

  it('空の clicks も null に倒す', () => {
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=').clickStep).toBeNull()
  })

  it('複数桁のスライド番号と clicks を解析する', () => {
    expect(parseSlideUrl('http://localhost:3002/#/12?clicks=3')).toStrictEqual({
      slideNumber: 12,
      clickStep: 3,
      url: 'http://localhost:3002/#/12?clicks=3',
    })
  })

  it('負値の clicks はそのまま解析する (Slidev が書いた URL を信じる)', () => {
    expect(parseSlideUrl('http://localhost:3002/#/4?clicks=-1').clickStep).toBe(-1)
  })

  it('`#/0` は slideNumber=1 にフォールバックする', () => {
    // Slidev のスライド番号は 1 始まりで 0 は存在しない。パース結果 0 をそのまま通すと
    // stepIndex が 0 になり、ルート (`#/`) のステップと衝突する。
    expect(parseSlideUrl('http://localhost:3002/#/0').slideNumber).toBe(1)
  })

  it('`#/` 以外のフラグメントは history ルータとして扱う', () => {
    expect(parseSlideUrl('http://localhost:3002/7?clicks=1#note')).toStrictEqual({
      slideNumber: 7,
      clickStep: 1,
      url: 'http://localhost:3002/7?clicks=1#note',
    })
  })
})

describe('buildPrintUrl', () => {
  it('history ルータは /print に print=clicks を付け、range は付けない（build 済み SPA では反映されないため）', () => {
    expect(buildPrintUrl('http://localhost:3002', { hash: false })).toBe('http://localhost:3002/print?print=clicks')
  })

  it('hash ルータは print=clicks をフラグメントの前に置く（クエリをフラグメントの中に置くと、クリック段が展開されない）', () => {
    expect(buildPrintUrl('http://localhost:3002', { hash: true })).toBe('http://localhost:3002/?print=clicks#/print')
  })

  it('末尾スラッシュ付きの baseUrl でも二重スラッシュを作らない', () => {
    expect(buildPrintUrl('http://localhost:3002/', { hash: false })).toBe('http://localhost:3002/print?print=clicks')
    expect(buildPrintUrl('http://localhost:3002//', { hash: true })).toBe('http://localhost:3002/?print=clicks#/print')
  })
})
