// session-finish の action が起動する関数。inputs を読み、本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { runSessionFinish, SESSION_FINISH_INPUT } from './commands/session-finish.js'
import { booleanInput, optionalInput, referenceInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: SESSION_FINISH_INPUT, run: runSessionFinish }, {
    pr_ref: referenceInput('pr'),
    project: optionalInput('project'),
    dry_run: booleanInput('dry-run'),
  }, io)
}
