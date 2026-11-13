/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// project info の着手の判定。盤上の Issue の前提を読み、判定に合わせて列と札を直す。
import { decideBoardMove } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress, StackableChain } from '../domain/format.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import { compareStrings } from '../domain/python-format.js'
import { cycleThrough, describeReadiness, describeUnknown, hasStarted, progressionsFromReadiness, stackChains, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import type { IssueFacts, Readiness } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { applyBoardMove, issueLabel } from './issue-board.js'
import { createReadinessCache, judgeSnapshot, prerequisiteKeys, readinessJson, readIssueSnapshot, snapshotWithoutPrerequisites } from './issue-readiness.js'
import type { IssueReadiness, IssueSnapshot } from './issue-readiness.js'
import type { Output } from './output.js'
import { mapWithLimit } from './project-info.js'

/**
前提の読み取りを並列に行う数の上限
*/
const READINESS_MAX_WORKERS = 8

/**
前提を 1 回で読む件数の上限
*/
const MAX_BLOCKED_BY = 50

const JUDGED_STATUSES: ReadonlySet<string> = new Set(['Ready', 'Blocked', 'Active', 'In Review'])

export interface BoardReadiness {
  /**
  判定を出した場合の、直した後のアイテム。判定を出せなかった（対応しない GHES）ときは元のアイテム
  */
  readonly items: readonly BoardItem[]
  /**
  boardItemKey → 表の Readiness の列の文。undefined なら列を出さない
  */
  readonly texts: ReadonlyMap<string, string> | undefined
  /**
  boardItemKey → JSON の readiness。undefined なら JSON に足さない
  */
  readonly json: ReadonlyMap<string, JsonObject> | undefined
  readonly chains: readonly StackableChain[]
}

interface Target {
  readonly item: BoardItem
  readonly key: string
  readonly ref: IssueReference
}

function toTarget(item: BoardItem): Target | undefined {
  const key = boardItemKey(item)
  const split = splitOwnerRepository(item.content.repository ?? '')
  const { number } = item.content
  if (key === undefined || split === undefined || typeof number !== 'number') return undefined
  const url = typeof item.content.url === 'string' ? item.content.url : ''
  const title = typeof item.title === 'string' ? item.title : ''
  return url.includes('/pull/') || title.startsWith(TRACKER_TITLE_PREFIX) || item.workflow === null || item.workflow === undefined || !JUDGED_STATUSES.has(item.workflow) ? undefined : { item, key, ref: createIssueReference(createRepositoryReference(split.owner, split.repository), number) }
}

// 前提の無い Issue を、一覧の値だけで判定の入力にする。前提の件数か着手の跡の件数が一覧に無ければ undefined
function localSnapshot(config: ProjectConfig, target: Target, progress: BoardProgress | undefined): IssueSnapshot | undefined {
  if (progress?.blockedBy !== 0 || progress.hasTrace === undefined) return undefined
  const split = splitOwnerRepository(progress.parent?.repository ?? '')
  const parent = split === undefined || progress.parent === undefined ? undefined : createIssueReference(createRepositoryReference(split.owner, split.repository), progress.parent.number)
  const isEpic = isEpicIssue({ issue_type: progress.issueType, sub_issues_total: progress.subIssues })
  return snapshotWithoutPrerequisites(config, {
    title: typeof target.item.title === 'string' ? target.item.title : '',
    parent,
    target: {
      ref: target.ref,
      state: 'open',
      column: target.item.workflow ?? undefined,
      label: progress.label,
      kind: isEpic ? 'epic' : 'task',
      branches: [],
      pullRequests: [],
    },
  })
}

// 一覧の値だけで判定した Issue の着手の跡は、件数から決める。facts は PR とブランチを持たない
function isStarted(facts: IssueFacts, progress: BoardProgress | undefined): boolean {
  return progress?.blockedBy === 0 && progress.hasTrace !== undefined ? progress.hasTrace : hasStarted(facts)
}

function homeOf(config: ProjectConfig, repository = ''): RepositoryReference | undefined {
  const split = splitOwnerRepository(repository)
  if (split !== undefined) return split
  const [first] = config.repositories
  return first === undefined ? undefined : { owner: first.owner, repository: first.name }
}

function displayKey(key: string, home: RepositoryReference | undefined): string {
  const [repository = '', number = ''] = key.split('#', 2)
  const split = splitOwnerRepository(repository)
  const isHome = home !== undefined && repository === `${home.owner}/${home.repository}`.toLowerCase()
  return split === undefined || isHome || home === undefined ? `#${number}` : `${repository}#${number}`
}

function unsupportedWarning(out: Readonly<Output>): void {
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted and no column is moved')
}

function missingWarning(missing: ReadonlySet<string>): string {
  const names = [...missing].toSorted(compareStrings)
  return `the board has no option ${names.join(', ')}; add ${names.length === 1 ? 'it' : 'them'} with pecot project init`
}

/**
判定を読まずに、依存関係に対応しない GHES と同じ扱いにする。warning を 1 回出し、列は動かさない
*/
export function skipBoardReadiness(out: Readonly<Output>, items: readonly BoardItem[]): BoardReadiness {
  unsupportedWarning(out)
  return { items, texts: undefined, json: undefined, chains: [] }
}

/**
Ready・Blocked・Active・In Review の Issue の前提を読み、判定に合わせて列と札を直す。
items は表示するアイテム（--repo で絞った後）。書き込みの失敗は warning にして続ける
*/
export async function applyBoardReadiness(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], repository: string | undefined, progress: ReadonlyMap<string, BoardProgress> = new Map()): Promise<BoardReadiness> {
  type Snapshot = IssueSnapshot | Extract<IssueReadiness, { kind: 'unreadable' }>
  const plain: BoardReadiness = { items, texts: undefined, json: undefined, chains: [] }
  const targets = items.flatMap(item => toTarget(item) ?? [])
  const home = homeOf(config, repository)
  const cache = createReadinessCache()

  const state = { isUnsupported: false }
  const snapshots = await mapWithLimit(targets, READINESS_MAX_WORKERS, async (target): Promise<Snapshot | undefined> => {
    if (state.isUnsupported) return undefined
    const known = progress.get(target.key)
    const local = localSnapshot(config, target, known)
    if (local !== undefined) return local
    try {
      return await readIssueSnapshot(client, config, target.ref, known?.blockedBy === undefined ? undefined : Math.min(Math.max(known.blockedBy, 1), MAX_BLOCKED_BY))
    }
    catch (error: unknown) {
      if (!(error instanceof DependenciesUnsupportedError)) throw error
      state.isUnsupported = true
      return undefined
    }
  })
  if (state.isUnsupported) {
    unsupportedWarning(out)
    return plain
  }

  const edges = new Map<string, readonly string[]>()
  for (const [index, snapshot] of snapshots.entries()) {
    const target = targets.at(index)
    if (target !== undefined && snapshot?.kind === 'snapshot') edges.set(issueReferenceKey(target.ref), prerequisiteKeys(snapshot))
  }

  const judged = await mapWithLimit(targets.map((target, index) => ({ target, index })), READINESS_MAX_WORKERS, async ({ target, index }): Promise<IssueReadiness> => {
    const snapshot = snapshots.at(index)
    if (snapshot === undefined) return { kind: 'unreadable', reason: 'not read' }
    if (snapshot.kind === 'unreadable') return snapshot
    try {
      return await judgeSnapshot(client, snapshot, cache, cycleThrough(issueReferenceKey(target.ref), edges))
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return { kind: 'unreadable', reason: error.message }
      throw error
    }
  })

  const texts = new Map<string, string>()
  const json = new Map<string, JsonObject>()
  const readinessByKey = new Map<string, Readiness>()
  const parents = new Map<string, IssueReference>()
  const moved = new Map<string, string>()
  const missing = new Set<string>()
  const available = {
    blocked: getOptionId(config, 'workflow', 'blocked') !== undefined,
    needsAttention: getOptionId(config, 'status', 'needs_attention') !== undefined,
    todo: getOptionId(config, 'status', 'todo') !== undefined,
  }

  for (const [index, target] of targets.entries()) {
    const result = judged.at(index)
    if (result === undefined) continue
    if (result.kind === 'unreadable') {
      const text = describeUnknown(result.reason.replaceAll(/\s+/gu, ' '))
      texts.set(target.key, text)
      json.set(target.key, { kind: 'unknown', text })
      continue
    }
    if (result.parent !== undefined) parents.set(target.key, result.parent)
    const { readiness } = result
    if (readiness === undefined) continue
    const text = describeReadiness(readiness, result.prerequisites, target.ref.repository)
    texts.set(target.key, text)
    json.set(target.key, readinessJson(readiness, text))
    readinessByKey.set(target.key, readiness)

    const move = decideBoardMove({
      eligible: true,
      column: target.item.workflow ?? undefined,
      label: result.target.label,
      hasStarted: isStarted(result.target, progress.get(target.key)),
      hasPrerequisites: result.prerequisites.length > 0,
      readiness,
      labelWrittenByAutomation: false,
      available,
    })
    if (move === undefined) continue
    const itemId = target.item.id
    for (const value of move.missing) missing.add(value)
    if (typeof itemId !== 'string') continue

    const applied = await applyBoardMove(out, client, config, itemId, { ref: target.ref, home }, move, text)
    if (applied.column !== undefined) moved.set(target.key, applied.column)
  }
  if (missing.size > 0) out.warning(missingWarning(missing))

  const updated = items.map((item) => {
    const key = boardItemKey(item)
    const column = key === undefined ? undefined : moved.get(key)
    return column === undefined ? item : { ...item, workflow: column }
  })
  const chains = stackChains(progressionsFromReadiness(readinessByKey)).filter(chain => chain.length >= 2).map((chain): StackableChain => {
    const parentKey = chain.find(key => parents.has(key))
    const parent = parentKey === undefined ? undefined : parents.get(parentKey)
    return { epic: parent === undefined ? undefined : issueLabel(parent, home), chain: chain.map(key => displayKey(key, home)) }
  })
  return { items: updated, texts, json, chains }
}

/**
アイテムのキーを引いて JSON の readiness を返す。判定が無ければ null
*/
export function readinessOf(readiness: BoardReadiness, item: BoardItem): JsonObject | typeof JSON_NULL {
  const key = boardItemKey(item)
  return (key === undefined ? undefined : readiness.json?.get(key)) ?? JSON_NULL
}
