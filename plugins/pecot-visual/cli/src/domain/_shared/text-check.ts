// 文言を文章規則で確認して、違反を全件集める。規則そのものは持たず、判定する関数（lintText）を DI で受ける。
// 図のラベルとエビデンスの項目が、同じ確認・同じ違反の形を使う。

import type { TextItem } from './text-item.js'

/**
判定結果の指摘 1 件のうち、ここで使う分。
*/
export interface TextFindingLike {
  readonly ruleId: string
  readonly message: string
}

/**
文言 1 件を確認する関数。断片（見出し・ラベル）として扱う。
*/
export type LintText = (text: string) => Promise<readonly TextFindingLike[]>

/**
契約の `violations` の要素。item は文言の場所、text はその文言。
*/
export interface TextViolation {
  readonly item: string
  readonly ruleId: string
  readonly message: string
  readonly text: string
}

/**
全件を確認して違反を返す。1 件で打ち切らず、どれを直せば通るかを 1 回の実行で示す。
判定する関数の例外は握りつぶさずそのまま投げる。
*/
export async function collectTextViolations(
  items: readonly TextItem[],
  lintText: LintText,
): Promise<readonly TextViolation[]> {
  const violations: TextViolation[] = []
  for (const { item, text } of items) {
    const findings = await lintText(text)
    for (const finding of findings) {
      violations.push({ item, ruleId: finding.ruleId, message: finding.message, text })
    }
  }
  return violations
}

/**
違反を人が読む形に整える。
*/
export function formatTextViolations(violations: readonly TextViolation[]): string {
  const lines = violations.map(violation => `  - ${violation.item}: ${violation.message} (${violation.ruleId})`)
  return `${violations.length.toString()} text violation(s)\n${lines.join('\n')}`
}
