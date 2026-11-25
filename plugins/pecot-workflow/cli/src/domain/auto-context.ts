// 自動処理に渡す、Issue のコメントの文脈（計画・前回までの結果・答え）。決まりは specs/023-label-triggered-autofix/data-model.md の「計画のコメント」。
import { autoResultOf } from './auto-result.js'
import type { IssueCommentRecord } from './review-finish.js'

export interface AutoAnswer {
  readonly author: string
  readonly body: string
}

export interface AutoContext {
  /**
  最後の計画のコメントの本文。無ければ空
  */
  readonly plan: string
  readonly results: readonly string[]
  readonly answers: readonly AutoAnswer[]
  /**
  書き込み権限を確かめられず、本文を出さなかったコメントの数
  */
  readonly withheld: number
}

const PLAN_HEADING = /^## Plan[ \t]*(?:\r?\n|$)/u

function isBot(comment: Readonly<IssueCommentRecord>): boolean {
  return comment.userType === 'Bot'
}

function isPlan(comment: Readonly<IssueCommentRecord>): boolean {
  return PLAN_HEADING.test(comment.body.trimStart())
}

function isResult(comment: Readonly<IssueCommentRecord>): boolean {
  return isBot(comment) && autoResultOf(comment.body) !== undefined
}

function afterLastResult(comments: readonly Readonly<IssueCommentRecord>[]): readonly Readonly<IssueCommentRecord>[] {
  const last = comments.findLastIndex(comment => isResult(comment))
  return last === -1 ? [] : comments.slice(last + 1)
}

// 本文を出しうる人のコメント。計画と、最後の結果の後の答え
function humanCandidates(comments: readonly Readonly<IssueCommentRecord>[], scope: 'plan' | 'context'): readonly Readonly<IssueCommentRecord>[] {
  const plans = comments.filter(comment => !isBot(comment) && isPlan(comment))
  if (scope === 'plan') return plans
  const answers = afterLastResult(comments).filter(comment => !isBot(comment) && !isPlan(comment))
  return [...plans, ...answers]
}

/**
書き込み権限を読む人。scope が plan なら計画を書いた人だけ、context なら答えを書いた人も
*/
export function permissionCandidates(comments: readonly Readonly<IssueCommentRecord>[], scope: 'plan' | 'context'): readonly string[] {
  // author_association では絞らない。App のトークンには、組織の非公開のメンバーが CONTRIBUTOR で返る
  const logins = humanCandidates(comments, scope).map(comment => comment.login)
  return [...new Set(logins)]
}

/**
comments は List issue comments の順（古い順）。writers は、書き込み権限（admin・write）を確かめた人
*/
export function autoContextOf(comments: readonly Readonly<IssueCommentRecord>[], writers: ReadonlySet<string>): AutoContext {
  const isTrusted = (comment: Readonly<IssueCommentRecord>): boolean => isBot(comment) || writers.has(comment.login)
  const plans = comments.filter(comment => isPlan(comment) && isTrusted(comment))
  const answers = afterLastResult(comments).filter(comment => !isBot(comment) && !isPlan(comment) && isTrusted(comment))
  return {
    plan: plans.at(-1)?.body ?? '',
    results: comments.filter(comment => isResult(comment)).map(comment => comment.body),
    answers: answers.map(comment => ({ author: comment.login, body: comment.body })),
    withheld: humanCandidates(comments, 'context').filter(comment => !isTrusted(comment)).length,
  }
}
