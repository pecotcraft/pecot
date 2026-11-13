/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// project info の着手の判定。盤上の Ready・Blocked の Issue の前提を読んで表示する。列と札は動かさない。
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress, StackableChain } from '../domain/format.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import { cycleThrough, describeReadiness, describeUnknown, progressionsFromReadiness, stackChains, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import type { Readiness } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { issueLabel } from './issue-board.js'
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

const JUDGED_STATUSES: ReadonlySet<string> = new Set(['Ready', 'Blocked'])

export interface BoardReadiness {
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

// 前提の無い Issue を、一覧の値だけで判定の入力にする。前提の件数が一覧に無ければ undefined
function localSnapshot(config: ProjectConfig, target: Target, progress: BoardProgress | undefined): IssueSnapshot | undefined {
  if (progress?.blockedBy !== 0) return undefined
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
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted')
}

/**
判定を読まずに、依存関係に対応しない GHES と同じ扱いにする。warning を 1 回出す
*/
export function skipBoardReadiness(out: Readonly<Output>): BoardReadiness {
  unsupportedWarning(out)
  return { texts: undefined, json: undefined, chains: [] }
}

/**
Ready・Blocked の Issue の前提を読んで判定する。items は表示するアイテム（--repo で絞った後）。列と札は動かさない
*/
export async function readBoardReadiness(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], repository: string | undefined, progress: ReadonlyMap<string, BoardProgress> = new Map()): Promise<BoardReadiness> {
  type Snapshot = IssueSnapshot | Extract<IssueReadiness, { kind: 'unreadable' }>
  const plain: BoardReadiness = { texts: undefined, json: undefined, chains: [] }
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
  }

  const chains = stackChains(progressionsFromReadiness(readinessByKey)).filter(chain => chain.length >= 2).map((chain): StackableChain => {
    const parentKey = chain.find(key => parents.has(key))
    const parent = parentKey === undefined ? undefined : parents.get(parentKey)
    return { epic: parent === undefined ? undefined : issueLabel(parent, home), chain: chain.map(key => displayKey(key, home)) }
  })
  return { texts, json, chains }
}

/**
アイテムのキーを引いて JSON の readiness を返す。判定が無ければ null
*/
export function readinessOf(readiness: BoardReadiness, item: BoardItem): JsonObject | typeof JSON_NULL {
  const key = boardItemKey(item)
  return (key === undefined ? undefined : readiness.json?.get(key)) ?? JSON_NULL
}
