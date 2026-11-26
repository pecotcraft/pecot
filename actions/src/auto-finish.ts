// auto-finish の action が起動する関数。inputs を読み、本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { AUTO_FINISH_INPUT, runAutoFinish } from './commands/auto-finish.js'
import { optionalInput, referenceInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: AUTO_FINISH_INPUT, run: runAutoFinish }, {
    issue_ref: referenceInput('issue'),
    result: optionalInput('result'),
    body_file: optionalInput('body-file'),
    result_file: optionalInput('result-file'),
    job_status: optionalInput('job-status'),
    execution_file: optionalInput('execution-file'),
    start_outcome: optionalInput('start-outcome'),
    project: optionalInput('project'),
  }, io)
}
