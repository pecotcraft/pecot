// 一括投稿の前提の確認と、進め方の表（specs/024 の contracts/cli-commands.md の `pecot issue create`）。I/O を持たない。

import { displayReference, planProgression, stackChains } from './readiness.js'
import type { Progression, Wait } from './readiness.js'
import { createIssueReference, issueReferenceKey, issueReferenceToCliReference } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { createRepositoryReference } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

// `owner/repo/N`。これに当たらない値は、一括の中のファイルのキーとして探す
const EXISTING_PATTERN = /^(?<owner>[\w.-]+)\/(?<repository>[\w.-]+)\/(?<number>\d+)$/u

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

function existingReference(raw: string): IssueReference | undefined {
  const groups = EXISTING_PATTERN.exec(raw)?.groups
  const number = Number(groups?.['number'])
  return groups === undefined || !Number.isSafeInteger(number) || number <= 0
    ? undefined
    : createIssueReference(createRepositoryReference(groups['owner'] ?? '', groups['repository'] ?? ''), number)
}

function targetKey(files: readonly BatchFile[], target: PrerequisiteTarget): string {
  return target.kind === 'file' ? files[target.index]?.key ?? '' : issueReferenceKey(target.reference)
}

// 前提を書いたキーの表記。ファイルは代表のキー、既存の Issue は `owner/repo/N`
function targetLabel(files: readonly BatchFile[], target: PrerequisiteTarget): string {
  return target.kind === 'file' ? targetKey(files, target) : issueReferenceToCliReference(target.reference)
}

function unknownKey(files: readonly BatchFile[]): { readonly message: string } | { readonly prerequisites: readonly (readonly ResolvedPrerequisite[])[] } {
  const owners = new Map(files.flatMap((file, index) => file.keys.map((key): [string, number] => [key, index])))
  const prerequisites: ResolvedPrerequisite[][] = []
  for (const file of files) {
    const resolved: ResolvedPrerequisite[] = []
    for (const entry of file.blockedBy) {
      const reference = existingReference(entry.issue)
      const index = owners.get(entry.issue)
      if (reference !== undefined) resolved.push({ target: { kind: 'existing', reference }, wait: entry.wait, reason: entry.reason })
      else if (index === undefined) return { message: `blocked_by in ${file.name} refers to unknown key ${entry.issue}` }
      else resolved.push({ target: { kind: 'file', index }, wait: entry.wait, reason: entry.reason })
    }
    prerequisites.push(resolved)
  }
  return { prerequisites }
}

/**
前提を解決して確かめる。順は、知らないキー → 輪 → 後ろのファイル → 同じ相手を 2 回指す前提。
輪はファイルどうしの前提だけで探す（新しい Issue を前提に持つ既存の Issue は無い）
*/
export function resolveBatch(files: readonly BatchFile[]): BatchResolution {
  const resolved = unknownKey(files)
  if ('message' in resolved) return { kind: 'error', message: resolved.message }
  const { prerequisites } = resolved

  const plan = planProgression(files.map((file, index) => ({
    key: file.key,
    prerequisites: (prerequisites.at(index) ?? []).map(({ target, wait }) => ({ key: targetKey(files, target), wait })),
  })))
  if (plan.kind === 'cycle') return { kind: 'error', message: `blocked_by forms a cycle: ${plan.cycle.join(' -> ')}` }

  for (const [index, file] of files.entries()) {
    const own = prerequisites.at(index) ?? []
    const later = own.find(({ target }) => target.kind === 'file' && target.index > index)
    if (later !== undefined) return { kind: 'error', message: `blocked_by in ${file.name} refers to ${targetLabel(files, later.target)}, which comes later` }

    const seen = new Set<string>()
    for (const { target } of own) {
      const key = targetKey(files, target)
      if (seen.has(key)) return { kind: 'error', message: `blocked_by in ${file.name} refers to ${targetLabel(files, target)} more than once` }
      seen.add(key)
    }
  }
  return { kind: 'ok', prerequisites, progressions: plan.progressions }
}

/**
進め方の表に出すキーの表記。ファイルは代表のキー、既存の Issue は home と同じリポジトリなら `#N`、別なら `owner/repo#N`
*/
export function displayTarget(files: readonly BatchFile[], target: PrerequisiteTarget, home: RepositoryReference): string {
  return target.kind === 'file' ? targetKey(files, target) : displayReference(target.reference, home)
}

export interface PlanRow {
  readonly file: string
  /**
  親 Epic の無いファイルは undefined
  */
  readonly order: number | undefined
  readonly prerequisites: readonly ResolvedPrerequisite[]
  readonly progression: Progression | undefined
  readonly home: RepositoryReference
}

function approachOf(files: readonly BatchFile[], row: Readonly<PlanRow>, labelOf: (target: PrerequisiteTarget) => string): string {
  const { progression } = row
  switch (progression?.kind) {
    case undefined:
    case 'alone': {
      return 'alone'
    }
    case 'wait-merge': {
      return `wait for merge of ${row.prerequisites.filter(({ wait }) => wait === 'merge').map(({ target }) => labelOf(target)).join(', ')}`
    }
    case 'join': {
      return `join (wait for ${row.prerequisites.map(({ target }) => labelOf(target)).join(', ')})`
    }
    case 'stack': {
      const on = row.prerequisites.find(({ target }) => targetKey(files, target) === progression.on)
      return `stack on ${on === undefined ? progression.on : labelOf(on.target)}`
    }
  }
}

/**
`--plan` の表。列は File・Number・Blocked by・Approach
*/
export function formatPlanTable(files: readonly BatchFile[], rows: readonly PlanRow[]): string {
  const lines = ['| File | Number | Blocked by | Approach |', '|---|---|---|---|']
  for (const row of rows) {
    const labelOf = (target: PrerequisiteTarget): string => displayTarget(files, target, row.home)
    const blockedBy = row.prerequisites.length === 0
      ? '-'
      : row.prerequisites.map(({ target, wait }) => `${labelOf(target)}${wait === 'merge' ? ' (merge)' : ''}`).join(', ')
    lines.push(`| ${row.file} | ${row.order === undefined ? '-' : String(row.order)} | ${blockedBy} | ${approachOf(files, row, labelOf)} |`)
  }
  return lines.join('\n')
}

/**
積める並び。キーを label で表記に直し、並びが無ければ undefined。並びは `Stackable chains:` の見出しと `- a -> b` の行にする
*/
export function formatStackableChains(progressions: ReadonlyMap<string, Progression>, label: (key: string) => string): string | undefined {
  const chains = stackChains(progressions).filter(chain => chain.length >= 2)
  return chains.length === 0 ? undefined : ['Stackable chains:', ...chains.map(chain => `- ${chain.map(key => label(key)).join(' -> ')}`)].join('\n')
}
