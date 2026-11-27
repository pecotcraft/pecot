// issue_check の一括の起票の前提の確認と、進め方の表。I/O を持たない。

import { planProgression } from './readiness.js'
import type { Progression, Wait } from './readiness.js'
import { issueReferenceKey, issueReferenceToCliReference, parseIssueReference, ReferenceParseError } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'

export interface BatchEntry {
  readonly issue: string
  readonly wait: Wait
  readonly reason: string | undefined
}

export interface BatchFile {
  readonly name: string
  /**
  代表のキー。suffix があれば suffix、無ければ幹
  */
  readonly key: string
  /**
  前提に書けるキーすべて（幹と suffix）
  */
  readonly keys: readonly string[]
  readonly blockedBy: readonly BatchEntry[]
}

export type PrerequisiteTarget
  = | { readonly kind: 'file', readonly index: number }
    | { readonly kind: 'existing', readonly reference: IssueReference }

export interface ResolvedPrerequisite {
  readonly target: PrerequisiteTarget
  /**
  進め方の判定に使うキー。ファイルは代表のキー、既存の Issue は issueReferenceKey
  */
  readonly key: string
  readonly wait: Wait
  readonly reason: string | undefined
}

export type BatchResolution
  = | {
    readonly kind: 'ok'
    /**
    ファイルごとの、書いた順の前提
    */
    readonly prerequisites: readonly (readonly ResolvedPrerequisite[])[]
    /**
    キー（ファイルの代表のキー、既存の Issue は issueReferenceKey）→ 進め方
    */
    readonly progressions: ReadonlyMap<string, Progression>
  }
  | { readonly kind: 'error', readonly message: string }

// `owner/repo/N` の形なら既存の Issue。これに当たらない値は、一括の中のファイルのキーとして探す
function existingReference(raw: string): IssueReference | undefined {
  try {
    return parseIssueReference(raw)
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return undefined
    throw error
  }
}

// 前提の書いたキーを、一括の中のファイルか既存の Issue に解く。どちらでもないキーがあれば、その message を返す
function resolveTargets(files: readonly BatchFile[]): { readonly message: string } | { readonly prerequisites: readonly (readonly ResolvedPrerequisite[])[] } {
  const owners = new Map(files.flatMap((file, index) => file.keys.map((key): [string, { readonly index: number, readonly key: string }] => [key, { index, key: file.key }])))
  const prerequisites: ResolvedPrerequisite[][] = []
  for (const file of files) {
    const resolved: ResolvedPrerequisite[] = []
    for (const entry of file.blockedBy) {
      const reference = existingReference(entry.issue)
      const owner = owners.get(entry.issue)
      if (reference !== undefined) resolved.push({ target: { kind: 'existing', reference }, key: issueReferenceKey(reference), wait: entry.wait, reason: entry.reason })
      else if (owner === undefined) return { message: `blocked_by in ${file.name} refers to unknown key ${entry.issue}` }
      else resolved.push({ target: { kind: 'file', index: owner.index }, key: owner.key, wait: entry.wait, reason: entry.reason })
    }
    prerequisites.push(resolved)
  }
  return { prerequisites }
}

// 前提を書いたキーの表記。ファイルは代表のキー、既存の Issue は `owner/repo/N`
function targetLabel({ target, key }: Readonly<ResolvedPrerequisite>): string {
  return target.kind === 'file' ? key : issueReferenceToCliReference(target.reference)
}

/**
前提を解決して確かめる。順は、知らないキー → 輪 → 後ろのファイル → 同じ相手を 2 回指す前提。
輪はファイルどうしの前提だけで探す（新しい Issue を前提に持つ既存の Issue は無い）
*/
export function resolveBatch(files: readonly BatchFile[]): BatchResolution {
  const resolved = resolveTargets(files)
  if ('message' in resolved) return { kind: 'error', message: resolved.message }
  const { prerequisites } = resolved

  const plan = planProgression(files.map((file, index) => ({
    key: file.key,
    prerequisites: (prerequisites.at(index) ?? []).map(({ key, wait }) => ({ key, wait })),
  })))
  if (plan.kind === 'cycle') return { kind: 'error', message: `blocked_by forms a cycle: ${plan.cycle.join(' -> ')}` }

  for (const [index, file] of files.entries()) {
    const own = prerequisites.at(index) ?? []
    const later = own.find(({ target }) => target.kind === 'file' && target.index > index)
    if (later !== undefined) return { kind: 'error', message: `blocked_by in ${file.name} refers to ${targetLabel(later)}, which comes later` }

    const seen = new Set<string>()
    for (const prerequisite of own) {
      if (seen.has(prerequisite.key)) return { kind: 'error', message: `blocked_by in ${file.name} refers to ${targetLabel(prerequisite)} more than once` }
      seen.add(prerequisite.key)
    }
  }
  return { kind: 'ok', prerequisites, progressions: plan.progressions }
}

export interface PlanRow {
  readonly file: string
  /**
  親 Epic の無いファイルは undefined
  */
  readonly order: number | undefined
  readonly prerequisites: readonly ResolvedPrerequisite[]
  readonly progression: Progression | undefined
}
