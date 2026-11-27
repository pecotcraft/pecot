// github-ops の action が起動する関数。inputs を文字列のまま本体に渡す。params の JSON は本体が読む。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { GITHUB_OPS_INPUT, runGithubOps } from './commands/github-ops.js'
import { rawInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: GITHUB_OPS_INPUT, run: runGithubOps }, {
    operation: rawInput('operation'),
    request_id: rawInput('request-id'),
    params: rawInput('params'),
  }, io)
}
