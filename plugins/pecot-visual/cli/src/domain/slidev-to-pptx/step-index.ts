// スライドステップの同定子。変換ワーカー（出力ファイル名）とパイプライン（キャッシュキー・
// timing の集計）が同じ値を使う必要があるため、算出式をここに一本化する。

import type { SlideStep } from './types.js'

/**
ステップの整数 ID。出力ファイル名（`slide-<stepIndex>.pptx` / `prerender-slide<stepIndex>-*`）と
キャッシュ manifest のキーがこの値で対応する。
*/
export function stepIndexOf(step: Readonly<SlideStep>): number {
  return step.clickStep === null
    ? step.slideNumber * 100
    : step.slideNumber * 100 + step.clickStep
}

/**
人間向け・JSON 双方で使うステップ表記（`"5"` / `"5/2"`）。clickStep の 0 と null は
別のステップなので、stepIndex からは復元できない（0 と null がどちらも `N*100` になる）。
*/
export function stepKeyOf(step: Readonly<SlideStep>): string {
  return step.clickStep === null
    ? step.slideNumber.toString()
    : `${step.slideNumber.toString()}/${step.clickStep.toString()}`
}
