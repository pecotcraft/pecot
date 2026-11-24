// 自動処理（spec 023）の結果と、結果のコメントの目印。決まりは specs/023-label-triggered-autofix/data-model.md の「結果」「結果のコメント」。
import { NEEDS_ATTENTION_LABEL } from './readiness.js'
import type { IssueCommentReading } from './review-finish.js'

export type AutoResult = 'pr-created' | 'ci-passed' | 'ci-fix-pushed' | 'question' | 'out-of-scope' | 'failed' | 'limit' | 'setup-missing'

const AUTO_RESULTS: ReadonlySet<string> = new Set<AutoResult>(['pr-created', 'ci-passed', 'ci-fix-pushed', 'question', 'out-of-scope', 'failed', 'limit', 'setup-missing'])

// 人の対応を待って終わり、札に待ちの値（Needs Attention）を書く結果
const WAITING_RESULTS: ReadonlySet<AutoResult> = new Set<AutoResult>(['question', 'failed', 'limit'])

const MARKER_PATTERN = /^\s*<!-- pecot-auto: result=(\S+) run=\S+ attempt=\S+ branch=\S+ -->/u

function isAutoResult(value: string): value is AutoResult {
  return AUTO_RESULTS.has(value)
}

/**
本文の先頭の目印から結果を読む。目印が無いか、知らない結果なら undefined
*/
export function autoResultOf(body: string): AutoResult | undefined {
  const value = MARKER_PATTERN.exec(body)?.[1]
  return value !== undefined && isAutoResult(value) ? value : undefined
}

/**
今の札が、自動処理が書いた Needs Attention か。人が目印を書き込んで札を戻させないよう、Bot のコメントだけを見る。
comments は List issue comments の順（古い順）で渡す
*/
export function isLabelWrittenByAutomation(label: string | undefined, comments: readonly Readonly<IssueCommentReading>[]): boolean {
  if (label !== NEEDS_ATTENTION_LABEL) return false
  const results = comments.flatMap(comment => (comment.userType === 'Bot' ? autoResultOf(comment.body) ?? [] : []))
  const last = results.at(-1)
  return last !== undefined && WAITING_RESULTS.has(last)
}
