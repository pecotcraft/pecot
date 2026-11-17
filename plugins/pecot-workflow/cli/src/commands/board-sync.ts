/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// board sync。ボードの Ready・Blocked・Active・In Review の Issue を判定に合わせて、列と札を直す。
import { z } from 'zod'

import { homeRepositoryOf } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GraphqlRateLimit } from '../infra/github/repos.js'
import { applyJudgedMoves, judgeBoard, SYNCED_COLUMNS } from './board-judgment.js'
import type { BoardContext } from './board-judgment.js'
import { BOARD_MOVE_JSON, moveJson } from './issue-board.js'
import type { BoardMoveLine } from './issue-board.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { requireBoardConfig } from './command-stop.js'
import { makeClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Output } from './output.js'
import { pruneArchivedItems, readBoard } from './board-view.js'
import type { BoardRead } from './board-view.js'
import { failApi } from './project-sync.js'

const BOARD_SYNC_OUTPUT = z.strictObject({
  moves: z.array(BOARD_MOVE_JSON).describe('Issues whose column or Status was written (on dry_run, would be written)'),
  deletedArchived: z.int().describe('Number of Archived items deleted from the board (on dry_run, to be deleted)'),
  dryRun: DRY_RUN_FIELD,
})

function unsupportedWarning(out: Readonly<Output>): void {
  out.warning('this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved')
}

/**
対象の Issue の前提と着手の跡を読み、判定に合わせて列と札を直す。dryRun は同じ文を予定の行で出し、書かない。
書き込みの失敗は warning にして続け、失敗した Issue の数と、書いた（dry-run は書く予定の）列と札を返す
*/
async function syncBoard(context: Readonly<BoardContext>, read: Readonly<BoardRead>, isDryRun: boolean): Promise<{ readonly failures: number, readonly moves: readonly BoardMoveLine[] }> {
  const { out, client, config } = context
  // 着手の跡は一覧に無いので、info と違い、一覧の値だけでは判定しない。Ready で前提 0 件なら動かさないと決まるので読まない
  const judged = await judgeBoard(client, config, read.items, read.progress, {
    columns: SYNCED_COLUMNS,
    withoutRead: (target, known) => (target.item.workflow === 'Ready' && known?.blockedBy === 0 ? 'skip' : undefined),
  })
  if (judged === undefined) {
    unsupportedWarning(out)
    return { failures: 0, moves: [] }
  }
  return await applyJudgedMoves(context, judged, isDryRun)
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
  output: BOARD_SYNC_OUTPUT,
  positional: [],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof BOARD_SYNC_OUTPUT>>(input.dry_run, io)
    const config = requireBoardConfig(out, input.project, ['board', 'sync'])
    const client = await makeClient(out, config)
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
    const { failures, moves } = read.isLegacy ? { failures: 0, moves: [] } : await syncBoard({ out, client, config, home: homeRepositoryOf(config) }, read, input.dry_run)
    const pruned = await pruneArchivedItems(out, client, config, read.allItems, input.dry_run)
    const pruneFailures = pruned.failed
    out.result({ moves: moves.map(move => moveJson(move)), deletedArchived: pruned.deleted })
    reportPoints(out, before, await client.getGraphqlRateLimit())
    if (failures === 0 && pruneFailures === 0) return 0
    if (failures > 0) out.error(failureMessage(failures))
    if (pruneFailures > 0) out.error(deleteFailureMessage(pruneFailures))
    throw new CommandExit(1, 'partial-failure')
  },
})

export const BOARD_SYNC_COMMANDS: readonly CommandDefinition[] = [boardSyncCommand]
