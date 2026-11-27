// auto-start の action が起動する関数。inputs を読み、本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { AUTO_START_INPUT, runAutoStart } from './commands/auto-start.js'
import { optionalInput, referenceInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: AUTO_START_INPUT, run: runAutoStart }, {
    issue_ref: referenceInput('issue'),
    project: optionalInput('project'),
  }, io)
}
