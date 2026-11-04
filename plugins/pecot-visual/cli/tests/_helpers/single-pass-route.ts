// E2E が done payload で変換ルート（1 パスのルート / 現行ルート）を確認するための共通モジュール（#1147）。
//
// ルートは env `PECOTV_SINGLE_PASS` で決まる。`0` は現行ルート、それ以外（未設定を含む）は 1 パスのルート。
// env の解釈の基準は src/infra/slidev-to-pptx/index.ts（InProcessSlidevPptxPipeline.convert）。
// isSinglePassDisabledByEnvironment はその写し。解釈を変えるときは両方を揃える。
// `PECOTV_SINGLE_PASS=0 pnpm test:e2e` で同じ E2E を現行ルートでも回せるよう、期待値をこの env で
// 切り替える。キャッシュが全 hit の run は変換しないため `timings.singlePass` を持たない
// （miss のある run にだけ使う）。
import { expect } from 'vitest'

import { SINGLE_PASS_FALLBACK_PREFIX } from '../../src/infra/slidev-to-pptx/pipeline.js'

interface RouteEvent {
  readonly warnings?: readonly string[]
  readonly timings?: { readonly singlePass?: unknown }
}

/**
env が現行ルートを指定しているか（`PECOTV_SINGLE_PASS=0`）。基準は index.ts の env 解釈
*/
export function isSinglePassDisabledByEnvironment(): boolean {
  return process.env['PECOTV_SINGLE_PASS'] === '0'
}

/**
1 パスのルートを使わなかったことを示す warning。
*/
export function singlePassFallbackWarnings(done: Readonly<RouteEvent> | undefined): readonly string[] {
  return (done?.warnings ?? []).filter(warning => warning.startsWith(SINGLE_PASS_FALLBACK_PREFIX))
}

/**
miss のある run の done payload が、env が決めるルートで変換されたことを確認する。
標準（1 パスのルート）では、`timings.singlePass` にグループ別の所要があり、現行 worker へ回したステップが無い。
`PECOTV_SINGLE_PASS=0`（現行ルート）では、`timings.singlePass` が無い。
どちらも退避の warning は 0 件。
*/
export function expectConvertRouteFromEnvironment(done: Readonly<RouteEvent> | undefined): void {
  if (isSinglePassDisabledByEnvironment()) {
    expect(done?.timings).not.toHaveProperty('singlePass')
  }
  else {
    const singlePass = done?.timings?.singlePass
    expect(singlePass).toHaveProperty('kind', 'converted')
    expect(singlePass).toHaveProperty('groups')
    expect(singlePass).toHaveProperty('fallbackSteps', [])
  }
  expect(singlePassFallbackWarnings(done)).toStrictEqual([])
}
