/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// board show の着手の判定。盤上の Ready・Blocked の Issue の前提を読んで表示する。列と札は動かさない。
import { homeRepositoryOf } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress, StackableChain } from '../domain/format.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import { describeReadiness, describeUnknown, displayReference, progressionsFromReadiness, stackChains } from '../domain/readiness.js'
import type { Readiness } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { GitHubClient } from '../infra/github/index.js'
import { boardMoveOf, judgeBoard } from './board-judgment.js'
import type { BoardTarget } from './board-judgment.js'
import { readinessJson, snapshotWithoutPrerequisites } from './issue-readiness.js'
import type { IssueSnapshot } from './issue-readiness.js'
import type { Output } from './output.js'

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
  /**
  board sync が列か札を動かしそうな Ready・Blocked の Issue の数
  */
  readonly mismatches: number
}

// 前提の無い Issue を、一覧の値だけで判定の入力にする。前提の件数が一覧に無ければ undefined
function localSnapshot(config: ProjectConfig, target: BoardTarget, progress: BoardProgress | undefined): IssueSnapshot | undefined {
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
      // 着手の跡は一覧に無いので、info の案内は「may be」と書く
      branches: [],
      pullRequests: [],
    },
  })
}

// 小文字のキーを、元の参照（無ければキーから作る）に戻して表記する
function displayKey(key: string, references: ReadonlyMap<string, IssueReference>, home: RepositoryReference | undefined): string {
  const known = references.get(key)
  const [repository = '', number = ''] = key.split('#', 2)
  const split = splitOwnerRepository(repository)
  return known === undefined && split === undefined ? key : displayReference(known ?? createIssueReference(createRepositoryReference(split?.owner ?? '', split?.repository ?? ''), Number(number)), home)
}

function unsupportedWarning(out: Readonly<Output>): void {
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted')
}

const PLAIN: BoardReadiness = { texts: undefined, json: undefined, chains: [], mismatches: 0 }

/**
判定を読まずに、依存関係に対応しない GHES と同じ扱いにする。warning を 1 回出す
*/
export function skipBoardReadiness(out: Readonly<Output>): BoardReadiness {
  unsupportedWarning(out)
  return PLAIN
}

/**
Ready・Blocked の Issue の前提を読んで判定する。items は表示するアイテム（--repo で絞った後）。列と札は動かさない
*/
export async function readBoardReadiness(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], repository: string | undefined, progress: ReadonlyMap<string, BoardProgress> = new Map()): Promise<BoardReadiness> {
  const judged = await judgeBoard(client, config, items, progress, {
    columns: JUDGED_STATUSES,
    withoutRead: (target, known) => localSnapshot(config, target, known),
  })
  if (judged === undefined) {
    unsupportedWarning(out)
    return PLAIN
  }
  const home = homeRepositoryOf(config, repository)

  const texts = new Map<string, string>()
  const json = new Map<string, JsonObject>()
  const readinessByKey = new Map<string, Readiness>()
  const parents = new Map<string, IssueReference>()
  const references = new Map<string, IssueReference>(judged.map(({ target }) => [target.key, target.ref]))
  let mismatches = 0

  for (const { target, result } of judged) {
    if (result.kind === 'unreadable') {
      const text = describeUnknown(result.reason.replaceAll(/\s+/gu, ' '))
      texts.set(target.key, text)
      json.set(target.key, { kind: 'unknown', stackOn: JSON_NULL, reason: JSON_NULL, text })
      continue
    }
    if (result.parent !== undefined) parents.set(target.key, result.parent)
    const { readiness } = result
    if (readiness === undefined) continue
    const text = describeReadiness(readiness, result.prerequisites, target.ref.repository)
    texts.set(target.key, text)
    json.set(target.key, readinessJson(readiness, text))
    readinessByKey.set(target.key, readiness)
    const move = boardMoveOf(config, target, result)
    if (move?.column !== undefined || move?.label !== undefined) mismatches += 1
    if (readiness.stackOn !== undefined) references.set(issueReferenceKey(readiness.stackOn.issue), readiness.stackOn.issue)
  }

  const chains = stackChains(progressionsFromReadiness(readinessByKey)).filter(chain => chain.length >= 2).map((chain): StackableChain => {
    const parentKey = chain.find(key => parents.has(key))
    const parent = parentKey === undefined ? undefined : parents.get(parentKey)
    return { epic: parent === undefined ? undefined : displayReference(parent, home), chain: chain.map(key => displayKey(key, references, home)) }
  })
  return { texts, json, chains, mismatches }
}

/**
アイテムのキーを引いて JSON の readiness を返す。判定が無ければ null
*/
export function readinessOf(readiness: BoardReadiness, item: BoardItem): JsonObject | typeof JSON_NULL {
  const key = boardItemKey(item)
  return (key === undefined ? undefined : readiness.json?.get(key)) ?? JSON_NULL
}
