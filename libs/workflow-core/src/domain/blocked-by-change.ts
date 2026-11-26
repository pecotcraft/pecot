// issue block / unblock の判断（付ける・変える・何もしない・外す）と、輪の探索。I/O は引数の関数で受ける。

import { InvalidValueError } from './errors.js'
import type { BlockedByReferences } from './issue-readout.js'
import { readWaitsForMerge, removeWaitsForMerge, upsertWaitsForMerge } from './prerequisites.js'
import type { Prerequisite, Wait } from './readiness.js'
import { displayReference } from './readiness.js'
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

export type ReadBlockedByLevel = (ids: readonly string[]) => Promise<ReadonlyMap<string, BlockedByReferences>>

export interface CycleSearchInput {
  readonly target: IssueReference
  readonly by: IssueReference
  readonly byId: string
  readonly read: ReadBlockedByLevel
  /**
  たどる Issue の数の上限（by を含む）
  */
  readonly limit: number
}

export type CycleSearchResult
  = | { readonly kind: 'cycle', readonly path: readonly IssueReference[] }
    | { readonly kind: 'none' }
    | { readonly kind: 'unverifiable', readonly reason: string }

interface Visited {
  readonly ref: IssueReference
  readonly parentKey: string | undefined
}

function pathTo(visited: ReadonlyMap<string, Visited>, key: string): readonly IssueReference[] {
  const chain: IssueReference[] = []
  for (let current = visited.get(key); current !== undefined; current = current.parentKey === undefined ? undefined : visited.get(current.parentKey)) {
    chain.unshift(current.ref)
  }
  return chain
}

/**
by から blocked by を 1 段ずつたどり、target に戻れば輪として道（target → by → … → target）を返す。
読めない Issue・件数の不足・上限は unverifiable。GitHub は 3 つ以上の輪を通すので、確かめずに付けない
*/
export async function searchCycle(input: Readonly<CycleSearchInput>): Promise<CycleSearchResult> {
  const { target, by, read, limit } = input
  const targetKey = issueReferenceKey(target)
  const byKey = issueReferenceKey(by)
  const visited = new Map<string, Visited>([[byKey, { ref: by, parentKey: undefined }]])
  let frontier: readonly { readonly id: string, readonly ref: IssueReference }[] = [{ id: input.byId, ref: by }]
  while (frontier.length > 0) {
    const results = await read(frontier.map(({ id }) => id))
    const next: { id: string, ref: IssueReference }[] = []
    for (const node of frontier) {
      const result = results.get(node.id)
      const label = displayReference(node.ref, target.repository)
      if (result === undefined || result.kind === 'read-failed') {
        return { kind: 'unverifiable', reason: `could not read blocked-by of ${label}: ${result?.reason ?? 'no result'}` }
      }
      if (result.total > result.issues.length) {
        return { kind: 'unverifiable', reason: `blocked-by of ${label} has ${String(result.total)} issues, more than can be read` }
      }
      const nodeKey = issueReferenceKey(node.ref)
      for (const issue of result.issues) {
        const reference: IssueReference = { repository: issue.repository, number: issue.number }
        const key = issueReferenceKey(reference)
        if (key === targetKey) return { kind: 'cycle', path: [target, ...pathTo(visited, nodeKey), target] }
        if (visited.has(key)) continue
        if (visited.size >= limit) return { kind: 'unverifiable', reason: `more than ${String(limit)} issues in the blocked-by chain` }
        visited.set(key, { ref: reference, parentKey: nodeKey })
        next.push({ id: issue.id, ref: reference })
      }
    }
    frontier = next
  }
  return { kind: 'none' }
}

export interface ExpectedPrerequisites {
  /**
  書いた後の前提のキー（issueReferenceKey）
  */
  readonly keys: ReadonlySet<string>
  readonly by: IssueReference
  /**
  by の種類と理由。外したときは undefined
  */
  readonly wait: { readonly wait: Wait, readonly reason: string | undefined } | undefined
}

/**
書いた後の読み直しが、書いた内容と一致するか。GitHub は書いた直後の読み取りの一致を保証しない
*/
export function hasExpectedPrerequisites(prerequisites: readonly Prerequisite[], expected: Readonly<ExpectedPrerequisites>): boolean {
  const keys = new Set(prerequisites.map(({ issue }) => issueReferenceKey(issue.ref)))
  if (keys.size !== expected.keys.size || [...keys].some(key => !expected.keys.has(key))) return false
  if (expected.wait === undefined) return true
  const byKey = issueReferenceKey(expected.by)
  const found = prerequisites.find(({ issue }) => issueReferenceKey(issue.ref) === byKey)
  return found?.wait === expected.wait.wait && (found.wait === 'stack' || found.reason === expected.wait.reason)
}
