// release-check の action が起動する関数。inputs を読み、本体に渡す。log-file があれば、出力を同じ順でそのファイルにも書く。
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { RELEASE_CHECK_INPUT, runReleaseCheck } from '@pecot/workflow-core/commands-shared/release-check.js'

import { actionIo, optionalInput, runAction } from './entry.js'

/* eslint-disable security/detect-non-literal-fs-filename -- 書き先は input の log-file */
function teeToFile(io: CommandIo, file: string): CommandIo {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '')
  return {
    ...io,
    stdout: (text: string) => {
      appendFileSync(file, text)
      io.stdout(text)
    },
    stderr: (text: string) => {
      appendFileSync(file, text)
      io.stderr(text)
    },
  }
}
/* eslint-enable security/detect-non-literal-fs-filename */

export async function main(io?: CommandIo): Promise<number> {
  const logFile = optionalInput('log-file')
  const base = io ?? actionIo()
  return await runAction({ input: RELEASE_CHECK_INPUT, run: runReleaseCheck }, {
    version: optionalInput('version'),
    package: optionalInput('package'),
    project: optionalInput('project'),
  }, logFile === undefined ? base : teeToFile(base, logFile))
}
