// issue block / unblock の判断（付ける・変える・何もしない・外す）。I/O を持たない。

import { InvalidValueError } from './errors.js'
import { readWaitsForMerge, removeWaitsForMerge, upsertWaitsForMerge } from './prerequisites.js'
import type { Wait } from './readiness.js'
import { issueReferenceKey } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import type { RepositoryReference } from './repository-resolver.js'

export type BlockDecision
  = | { readonly kind: 'malformed', readonly reason: string }
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'add' | 'update', readonly body: string }

export interface BlockInput {
  readonly body: string
  /**
  待つ側の Issue のリポジトリ。本文の `#N` が指す先
  */
  readonly home: RepositoryReference
  readonly by: IssueReference
  readonly wait: Wait
  /**
  wait が merge のときの理由
  */
  readonly reason: string | undefined
  /**
  by が、すでに blocked by に付いている
  */
  readonly isLinked: boolean
}

function nextBody(input: Readonly<BlockInput>, hasLine: boolean, currentReason: string | undefined): string {
  const { body, home, by, wait, reason = '' } = input
  if (wait === 'stack') return hasLine ? removeWaitsForMerge(body, home, by) : body
  const trimmed = reason.trim()
  if (trimmed === '') throw new InvalidValueError('reason is required with wait: merge')
  return hasLine && currentReason === trimmed ? body : upsertWaitsForMerge(body, home, by, trimmed)
}

/**
付ける・種類を変える・何もしないのどれにするかと、書く本文を決める。
節が読めないときは本文を書き換えられないので malformed を返す
*/
export function decideBlock(input: Readonly<BlockInput>): BlockDecision {
  const section = readWaitsForMerge(input.body, input.home)
  if (section.kind === 'malformed') return { kind: 'malformed', reason: section.reason }
  const key = issueReferenceKey(input.by)
  const line = section.kind === 'ok' ? section.lines.find(candidate => issueReferenceKey(candidate.ref) === key) : undefined
  const body = nextBody(input, line !== undefined, line?.reason)
  if (!input.isLinked) return { kind: 'add', body }
  return body === input.body ? { kind: 'unchanged' } : { kind: 'update', body }
}

export type UnblockDecision
  = | { readonly kind: 'unchanged' }
    | {
      readonly kind: 'remove'
      readonly body: string
      /**
      節が読めないときの理由。このとき body は元のまま
      */
      readonly malformedReason: string | undefined
    }

export interface UnblockInput {
  readonly body: string
  readonly home: RepositoryReference
  readonly by: IssueReference
  readonly isLinked: boolean
}

/**
外すか何もしないかを決める。付いていなければ、節に古い行が残っていても本文は書き換えない
*/
export function decideUnblock(input: Readonly<UnblockInput>): UnblockDecision {
  if (!input.isLinked) return { kind: 'unchanged' }
  const section = readWaitsForMerge(input.body, input.home)
  return section.kind === 'malformed'
    ? { kind: 'remove', body: input.body, malformedReason: section.reason }
    : { kind: 'remove', body: removeWaitsForMerge(input.body, input.home, input.by), malformedReason: undefined }
}
