/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// board sync。ボードの Ready・Blocked・Active・In Review の Issue を判定に合わせて、列と札を直す。
import path from 'node:path'
import { z } from 'zod'

import { decideBoardMove } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { compareStrings } from '../domain/python-format.js'
import { cycleThrough, describeReadiness, hasStarted, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import { loadActiveConfig, listProjectConfigNames, loadConfig, projectsDirectory } from '../infra/config-store.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { GraphqlRateLimit } from '../infra/github/repos.js'
import { MAX_BLOCKED_BY } from '../infra/github/issues.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { NO_ACTIVE_PROJECT, stopWith } from './command-stop.js'
import { makeClient } from './github-client.js'
import { applyBoardMove, planBoardMove } from './issue-board.js'
import { createReadinessCache, judgeSnapshot, prerequisiteKeys, readIssueSnapshot } from './issue-readiness.js'
import type { IssueReadiness, IssueSnapshot } from './issue-readiness.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { mapWithLimit, readBoard } from './project-info.js'
import { homeOf } from './project-readiness.js'
import { failApi } from './project-sync.js'
import type { MissingValue } from '../domain/board-move.js'

const READ_MAX_WORKERS = 8
// 一覧を読んでから足された前提も取りこぼさない件数の下限
const MIN_BLOCKED_BY_READ = 8
const SYNCED_COLUMNS: ReadonlySet<string> = new Set(['Ready', 'Blocked', 'Active', 'In Review'])
const CONFIG_NAME_PATTERN = /^[\w.-]+$/u

export interface SyncOptions {
  readonly dryRun: boolean
}

export interface SyncResult {
  /**
  Issue の依存関係に対応しない GHES で、何も読まずに終えた
  */
  readonly isUnsupported: boolean
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
  const url = typeof item.content.url === 'string' ? item.content.url : ''
  const title = typeof item.title === 'string' ? item.title : ''
  const isTarget = key !== undefined && split !== undefined && typeof number === 'number' && !url.includes('/pull/') && !title.startsWith(TRACKER_TITLE_PREFIX) && typeof item.workflow === 'string' && SYNCED_COLUMNS.has(item.workflow)
  return isTarget ? { item, key, ref: createIssueReference(createRepositoryReference(split.owner, split.repository), number) } : undefined
}

// Ready の列にある前提 0 件の Issue は、一覧の値だけで「動かさない」と決まる
function isSkippable(target: Target, progress: BoardProgress | undefined): boolean {
  return target.item.workflow === 'Ready' && progress?.blockedBy === 0
}

function unsupportedWarning(out: Readonly<Output>): void {
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved')
}

function missingWarning(missing: ReadonlySet<MissingValue>): string {
  const names = [...missing].toSorted(compareStrings)
  return `the board has no option ${names.join(', ')}; add ${names.length === 1 ? 'it' : 'them'} with pecot project init`
}

type Snapshot = IssueSnapshot | Extract<IssueReadiness, { kind: 'unreadable' }>

async function readSnapshot(client: GitHubClient, config: ProjectConfig, target: Target, progress: BoardProgress | undefined): Promise<Snapshot> {
  const count = progress?.blockedBy
  const first = count === undefined ? undefined : Math.min(Math.max(count, MIN_BLOCKED_BY_READ), MAX_BLOCKED_BY)
  return await readIssueSnapshot(client, config, target.ref, first)
}

/**
対象の Issue の前提と着手の跡を読み、判定に合わせて列と札を直す。dryRun は同じ文を予定の行で出し、書かない。
書き込みの失敗は warning にして続ける
*/
export async function syncBoard(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], progress: ReadonlyMap<string, BoardProgress>, options: Readonly<SyncOptions>): Promise<SyncResult> {
  const targets = items.flatMap(item => toTarget(item) ?? []).filter(target => !isSkippable(target, progress.get(target.key)))
  const home = homeOf(config)
  const cache = createReadinessCache()

  const state = { isUnsupported: false }
  const snapshots = await mapWithLimit(targets, READ_MAX_WORKERS, async (target): Promise<Snapshot | undefined> => {
    if (state.isUnsupported) return undefined
    try {
      return await readSnapshot(client, config, target, progress.get(target.key))
    }
    catch (error: unknown) {
      if (!(error instanceof DependenciesUnsupportedError)) throw error
      state.isUnsupported = true
      return undefined
    }
  })
  if (state.isUnsupported) {
    unsupportedWarning(out)
    return { isUnsupported: true }
  }

  const edges = new Map<string, readonly string[]>()
  for (const [index, snapshot] of snapshots.entries()) {
    const target = targets.at(index)
    if (target !== undefined && snapshot?.kind === 'snapshot') edges.set(issueReferenceKey(target.ref), prerequisiteKeys(snapshot))
  }

  const judged = await mapWithLimit(targets.map((target, index) => ({ target, index })), READ_MAX_WORKERS, async ({ target, index }): Promise<IssueReadiness> => {
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

  const missing = new Set<MissingValue>()
  const available = {
    blocked: getOptionId(config, 'workflow', 'blocked') !== undefined,
    needsAttention: getOptionId(config, 'status', 'needs_attention') !== undefined,
    todo: getOptionId(config, 'status', 'todo') !== undefined,
  }
  for (const [index, target] of targets.entries()) {
    const result = judged.at(index)
    if (result === undefined || result.kind === 'unreadable' || result.readiness === undefined) continue
    const { readiness } = result
    const move = decideBoardMove({
      eligible: true,
      column: target.item.workflow ?? undefined,
      label: result.target.label,
      hasStarted: hasStarted(result.target),
      hasPrerequisites: result.prerequisites.length > 0,
      readiness,
      labelWrittenByAutomation: false,
      available,
    })
    if (move === undefined) continue
    for (const value of move.missing) missing.add(value)
    const text = describeReadiness(readiness, result.prerequisites, target.ref.repository)
    const destination = { ref: target.ref, home }
    if (options.dryRun) {
      planBoardMove(out, destination, move, text)
      continue
    }
    const itemId = target.item.id
    if (typeof itemId === 'string') await applyBoardMove(out, client, config, itemId, destination, move, text)
  }
  if (missing.size > 0) out.warning(missingWarning(missing))
  return { isUnsupported: false }
}

function availableNames(): string {
  return listProjectConfigNames().join(', ')
}

// --project、次にアクティブ設定。どちらも無く設定が 1 つだけなら、それを使う
function resolveConfig(out: Readonly<Output>, project: string | undefined): ProjectConfig {
  if (project !== undefined) {
    const name = project.endsWith('.json') ? project.slice(0, -'.json'.length) : project
    const isKnown = CONFIG_NAME_PATTERN.test(name) && listProjectConfigNames().includes(name)
    return isKnown ? loadConfig(path.join(projectsDirectory(), `${name}.json`)) : stopWith(out, `project config not found: ${project}\navailable: ${availableNames()}`)
  }
  const active = loadActiveConfig()
  if (active !== undefined) return active
  const names = listProjectConfigNames()
  const [only] = names
  if (only === undefined) return stopWith(out, NO_ACTIVE_PROJECT)
  if (names.length === 1) return loadConfig(path.join(projectsDirectory(), `${only}.json`))
  return stopWith(out, `no active project, and ${String(names.length)} project configs exist\nrun: pecot board sync --project <NAME>\navailable: ${names.join(', ')}`)
}

function reportPoints(out: Readonly<Output>, before: GraphqlRateLimit | undefined, after: GraphqlRateLimit | undefined): void {
  if (before === undefined || after === undefined) return
  const used = after.used - before.used
  if (used >= 0) out.count('GraphQL points used', used)
  out.count('GraphQL points remaining', after.remaining)
}

const syncCommand = defineCommand({
  path: ['board', 'sync'],
  description: 'Move the Issues in Ready, Blocked, Active and In Review to the columns and Status values their judgment calls for',
  input: z.strictObject({
    dry_run: z.boolean().default(false).describe('Show the planned moves without writing to the board'),
    project: z.string().optional().describe('Name of the project config under .pecot/config/projects (without .json). Without it, the active project; when none is active and only one config exists, that one'),
  }),
  positional: [],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(input.dry_run, io)
    const config = resolveConfig(out, input.project)
    const client = makeClient(out, config)
    if (client === undefined) return 1
    try {
      const before = await client.getGraphqlRateLimit()
      const { items, progress, isLegacy } = await readBoard(client, config, undefined)
      if (isLegacy) unsupportedWarning(out)
      else await syncBoard(out, client, config, items, progress, { dryRun: input.dry_run })
      reportPoints(out, before, await client.getGraphqlRateLimit())
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return failApi(out, 'read project board', error)
      throw error
    }
    return 0
  },
})

export const BOARD_COMMANDS: readonly CommandDefinition[] = [syncCommand]
