/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// board-sync。ボードの Ready・Blocked・Active・In Review の Issue を判定に合わせて、列と札を直す。
import { z } from 'zod'

import { homeRepositoryOf } from '@pecot/workflow-core/domain/config.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import type { GraphqlRateLimit } from '@pecot/workflow-core/infra/github/repos.js'
import { applyJudgedMoves, judgeBoard, SYNCED_COLUMNS } from '@pecot/workflow-core/commands-shared/board-judgment.js'
import type { BoardContext } from '@pecot/workflow-core/commands-shared/board-judgment.js'
import type { BoardMoveLine } from '@pecot/workflow-core/commands-shared/issue-board.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { requireBoardConfig } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { pruneArchivedItems, readBoard, warnOldFieldName } from '@pecot/workflow-core/commands-shared/board-view.js'
import type { BoardRead } from '@pecot/workflow-core/commands-shared/board-view.js'
import { failApi } from '@pecot/workflow-core/commands-shared/project-sync.js'

export const BOARD_SYNC_INPUT = z.strictObject({
  dry_run: z.boolean().default(false),
  project: z.string().optional(),
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

/**
列と札を判定に合わせ、更新の新しい 20 件を超える Archived の項目をボードから消す。書き込みか削除に失敗した分があれば 1 を返す
*/
export async function runBoardSync(input: Readonly<z.output<typeof BOARD_SYNC_INPUT>>, io: CommandIo): Promise<number> {
  const out = createOutput(input.dry_run, io)
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
  warnOldFieldName(out, config, read)
  if (read.isLegacy) unsupportedWarning(out)
  const { failures } = read.isLegacy ? { failures: 0 } : await syncBoard({ out, client, config, home: homeRepositoryOf(config) }, read, input.dry_run)
  const pruned = await pruneArchivedItems(out, client, config, read.allItems, input.dry_run)
  reportPoints(out, before, await client.getGraphqlRateLimit())
  if (failures === 0 && pruned.failed === 0) return 0
  if (failures > 0) out.error(failureMessage(failures))
  if (pruned.failed > 0) out.error(deleteFailureMessage(pruned.failed))
  return 1
}
