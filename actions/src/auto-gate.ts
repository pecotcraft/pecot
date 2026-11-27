// auto-gate の action が起動する関数。inputs とイベントを読み、本体に渡す。
import process from 'node:process'

import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { AUTO_GATE_INPUT, runAutoGate } from './commands/auto-gate.js'
import { integerInput, optionalInput, runAction } from './entry.js'

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: AUTO_GATE_INPUT, run: runAutoGate }, {
    event_name: process.env['GITHUB_EVENT_NAME'],
    event_path: process.env['GITHUB_EVENT_PATH'],
    max_ci_attempts: integerInput('max-ci-attempts'),
    project: optionalInput('project'),
  }, io)
}
