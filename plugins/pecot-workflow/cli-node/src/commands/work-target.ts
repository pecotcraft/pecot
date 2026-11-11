// 作業対象（.pecot-active）を記録して、結果の行を出す。cli/commands/_work_target.py の移植。
import { WORK_DIR } from '../infra/paths.js'
import { toOsError } from '../infra/os-error.js'
import { ensureWorkDirectory, writeWorkTarget } from '../infra/state-store.js'
import { FAILURE_EXIT_CODE } from './failure.js'
import type { Output } from './output.js'

export interface RecordWorkTargetOptions {
  /**
  真なら、失敗を warning ではなく error にして、終了コードを返す
  */
  readonly failWithExit: boolean
}

/**
.pecot-active を書き、`set: work target ...` の行を出す。
失敗は warning で、undefined を返す。failWithExit なら error の行を出して 1 を返す。
呼ぶ側は、数値が返ったらその値で run を終える
*/
export function recordWorkTarget(
  output: Output,
  owner: string,
  repository: string,
  issueNumber: number,
  title: string,
  options: Readonly<RecordWorkTargetOptions>,
): number | undefined {
  const reference = `${owner}/${repository}/${String(issueNumber)}`
  let target: string
  try {
    writeWorkTarget(reference, title)
    target = `work target ${reference}`
    if (ensureWorkDirectory(reference) !== undefined) target += ` (work directory ${WORK_DIR}/${String(issueNumber)}/)`
  }
  catch (error: unknown) {
    const reason = toOsError(error)
    const message = `could not record the work target: ${reason instanceof Error ? reason.message : String(reason)}`
    if (!options.failWithExit) {
      output.warning(message)
      return undefined
    }
    output.error(message)
    return FAILURE_EXIT_CODE
  }
  output.done({ verb: 'set', target })
  return undefined
}
