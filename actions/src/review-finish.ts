// review-finish の action が起動する関数。inputs を読み、本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { REVIEW_FINISH_INPUT, runReviewFinish } from './commands/review-finish.js'
import { optionalInput, rawInput, referenceInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: REVIEW_FINISH_INPUT, run: runReviewFinish }, {
    pr_ref: referenceInput('pr'),
    job_status: optionalInput('job-status'),
    execution_file: optionalInput('execution-file'),
    since: optionalInput('since'),
    review_outcome: optionalInput('review-outcome'),
    review_conclusion: rawInput('review-conclusion'),
    review_has_token: optionalInput('review-has-token'),
  }, io)
}
