/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// board sync。ボードの Ready・Blocked・Active・In Review の Issue を判定に合わせて、列と札を直す。
import path from 'node:path'
import { z } from 'zod'

import { homeRepositoryOf } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { loadActiveConfig, listProjectConfigNames, loadConfig, projectsDirectory } from '../infra/config-store.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GraphqlRateLimit } from '../infra/github/repos.js'
import { applyJudgedMoves, judgeBoard, SYNCED_COLUMNS } from './board-judgment.js'
import type { BoardContext } from './board-judgment.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, placeholder } from './command-hint.js'
import { NO_ACTIVE_PROJECT, stopWith } from './command-stop.js'
import { makeClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { pruneArchivedItems, readBoard } from './board-view.js'
import type { BoardRead } from './board-view.js'
import { failApi } from './project-sync.js'

function unsupportedWarning(out: Readonly<Output>): void {
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved')
}

/**
対象の Issue の前提と着手の跡を読み、判定に合わせて列と札を直す。dryRun は同じ文を予定の行で出し、書かない。
書き込みの失敗は warning にして続け、失敗した Issue の数を返す
*/
async function syncBoard(context: Readonly<BoardContext>, read: Readonly<BoardRead>, isDryRun: boolean): Promise<number> {
  const { out, client, config } = context
  // 着手の跡は一覧に無いので、info と違い、一覧の値だけでは判定しない。Ready で前提 0 件なら動かさないと決まるので読まない
  const judged = await judgeBoard(client, config, read.items, read.progress, {
    columns: SYNCED_COLUMNS,
    withoutRead: (target, known) => (target.item.workflow === 'Ready' && known?.blockedBy === 0 ? 'skip' : undefined),
  })
  if (judged === undefined) {
    unsupportedWarning(out)
    return 0
  }
  return await applyJudgedMoves(context, judged, isDryRun)
}

function availableNames(): string {
  return listProjectConfigNames().join(', ')
}

// --project、次にアクティブ設定。どちらも無く設定が 1 つだけなら、それを使う
function resolveConfig(out: Readonly<Output>, project: string | undefined): ProjectConfig {
  if (project !== undefined) {
    // 一覧は projects/ の *.json の名前なので、一致すれば ../ などの外のパスにならない
    const name = project.endsWith('.json') ? project.slice(0, -'.json'.length) : project
    return listProjectConfigNames().includes(name) ? loadConfig(path.join(projectsDirectory(), `${name}.json`)) : stopWith(out, `project config not found: ${project}\navailable: ${availableNames()}`)
  }
  const active = loadActiveConfig()
  if (active !== undefined) return active
  const names = listProjectConfigNames()
  const [only] = names
  if (only === undefined) return stopWith(out, NO_ACTIVE_PROJECT)
  if (names.length === 1) return loadConfig(path.join(projectsDirectory(), `${only}.json`))
  return stopWith(out, hinted`no active project, and ${String(names.length)} project configs exist\nrun: ${commandHint(['board', 'sync'], { project: placeholder('NAME') })}\navailable: ${names.join(', ')}`)
}

// 窓が途中で切り替わると前後の used を比べられないので、使用量の行を省く
function reportPoints(out: Readonly<Output>, before: GraphqlRateLimit | undefined, after: GraphqlRateLimit | undefined): void {
  if (before === undefined || after === undefined) return
  const used = after.used - before.used
  if (before.reset === after.reset && used >= 0) out.count('GraphQL points used', used)
  out.count('GraphQL points remaining', after.remaining)
}

function failureMessage(failures: number): string {
  return failures === 1 ? 'could not write 1 Issue to the board' : `could not write ${String(failures)} Issues to the board`
}

function deleteFailureMessage(failures: number): string {
  return failures === 1 ? 'could not delete 1 archived item from the board' : `could not delete ${String(failures)} archived items from the board`
}

const boardSyncCommand = defineCommand({
  path: ['board', 'sync'],
  description: 'Move the Issues in Ready, Blocked, Active and In Review to the columns and Status values their judgment calls for, and delete the Archived items beyond the latest 20 from the board',
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
    const before = await client.getGraphqlRateLimit()
    let read: BoardRead
    try {
      read = await readBoard(client, config, undefined)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      reportPoints(out, before, await client.getGraphqlRateLimit())
      return failApi(out, 'read project board', error)
    }
    if (read.isLegacy) unsupportedWarning(out)
    const failures = read.isLegacy ? 0 : await syncBoard({ out, client, config, home: homeRepositoryOf(config) }, read, input.dry_run)
    const pruneFailures = await pruneArchivedItems(out, client, config, read.allItems, input.dry_run)
    reportPoints(out, before, await client.getGraphqlRateLimit())
    if (failures === 0 && pruneFailures === 0) return 0
    if (failures > 0) out.error(failureMessage(failures))
    if (pruneFailures > 0) out.error(deleteFailureMessage(pruneFailures))
    return 1
  },
})

export const BOARD_SYNC_COMMANDS: readonly CommandDefinition[] = [boardSyncCommand]
