// スライドステップの URL 形式。Slidev の routerMode（`history` / `hash`）で
// スライド番号と clicks の載る位置が変わるため、組み立てと解析をここに一本化する。
//
//   history: `http://localhost:3000/4?clicks=1`
//   hash:    `http://localhost:3000/#/4?clicks=1`
//
// hash では `?clicks=N` はフラグメント内の query であり、`URL.searchParams` からは引けない。
// この差を吸収しないと、全ステップが `{ slideNumber: 1, clickStep: null }` にまとめられる。
// すると stepIndex が衝突して、全スライドが同一 PPTX を上書きする。
//
// hash デッキではページを使い回した goto が same-document navigation になり、load 系の待機イベントが発火しない。
// そのため、ステップごとにページを新規作成する前提を変えないこと。

import type { SlideStep } from './types.js'

export interface SlideUrlFormat {
  /**
  routerMode が hash なら true。root へ goto した後の URL に `#/` が現れるかで判定する
  */
  readonly hash: boolean
}

/**
スライド 1 ステップの URL を組み立てる。`clicks` 未指定はクリック前の状態。
*/
export function buildSlideUrl(
  baseUrl: string,
  slide: number,
  options: Readonly<SlideUrlFormat & { readonly clicks?: number }>,
): string {
  // 末尾スラッシュ付きの baseUrl でも `//#/5` のような二重スラッシュを作らない。
  const root = baseUrl.replace(/\/+$/, '')
  const base = options.hash
    ? `${root}/#/${slide.toString()}`
    : `${root}/${slide.toString()}`
  return options.clicks === undefined ? base : `${base}?clicks=${options.clicks.toString()}`
}

/**
全スライドを 1 ページに並べる print ルートの URL（1 パス方式が開く）。`print=clicks` で各スライドの
クリック段もコンテナに展開される。

  history: `http://localhost:3000/print?print=clicks`
  hash:    `http://localhost:3000/?print=clicks#/print`

hash では `?print=clicks` を、フラグメントの前（document の query）に置く。
Slidev の `isPrintMode` は document の query を見るため、`/#/print?print=clicks` ではクリック段が展開されない（計測）。
`range` クエリは build 済み SPA では無視され、全スライドが描かれるため付けない。
新しいページへ 1 回 goto するだけなので、上記の same-document navigation の注意は当たらない。
*/
export function buildPrintUrl(baseUrl: string, options: Readonly<SlideUrlFormat>): string {
  const root = baseUrl.replace(/\/+$/, '')
  return options.hash ? `${root}/?print=clicks#/print` : `${root}/print?print=clicks`
}

/**
URL からスライド番号と clicks ステップを解析する。hash ルータの URL は
フラグメントを 1 本の URL とみなして再解析する。
*/
export function parseSlideUrl(url: string): SlideStep {
  const urlObject = new URL(url)
  const target = urlObject.hash.startsWith('#/')
    ? new URL(urlObject.hash.slice(1), urlObject.origin)
    : urlObject
  const parts = target.pathname.split('/').filter(Boolean)
  if (parts.length === 0) {
    // eslint-disable-next-line unicorn/no-null -- SlideStep.clickStep は未指定を null で表す
    return { slideNumber: 1, clickStep: null, url }
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- parts.length > 0 を上の if で保証している
  const slideNumber = Math.trunc(Number(parts[0]!)) || 1
  const clicksParameter = target.searchParams.get('clicks')
  // `?clicks=abc` / `?clicks=` は解析不能。
  // NaN を通すと stepIndex が NaN になり `slide-NaN.pptx` を書き出すため、clicks 未指定と同じ null に倒す。
  const clicks = clicksParameter === null || clicksParameter === '' ? NaN : Math.trunc(Number(clicksParameter))
  // eslint-disable-next-line unicorn/no-null -- 同上
  const clickStep = Number.isNaN(clicks) ? null : clicks
  return { slideNumber, clickStep, url }
}
