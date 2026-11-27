// board-sync の action が起動する関数。inputs を読み、本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { BOARD_SYNC_INPUT, runBoardSync } from './commands/board-sync.js'
import { booleanInput, optionalInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: BOARD_SYNC_INPUT, run: runBoardSync }, {
    project: optionalInput('project'),
    dry_run: booleanInput('dry-run'),
  }, io)
}
