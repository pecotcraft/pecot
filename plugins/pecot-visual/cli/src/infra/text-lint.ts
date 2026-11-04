// 文章規則の既定の判定器。
//
// 判定器の読み込みは辞書の初期化を伴うので、使うときまで遅らせる。
// 他のコマンドの起動に、その初期化を負わせないため。読み込みの指定はこの 1 か所だけに置く。
// 配布ツリーは、この import 式を同梱した実体へ書き換える。

import type { LintText } from '../domain/_shared/text-check.js'

export const defaultLintText: LintText = async (text) => {
  const { lintText } = await import('@pecot/text-rules')
  return lintText(text, 'fragment')
}
