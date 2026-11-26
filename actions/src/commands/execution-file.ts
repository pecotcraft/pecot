// claude-code-action の execution_file の読み取り。review-finish と auto-finish が使う。
import { readExecution } from '@pecot/workflow-core/domain/review-finish.js'
import type { ExecutionReading } from '@pecot/workflow-core/domain/review-finish.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'

/**
前後の空白を除いた値。空なら undefined
*/
export function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
execution_file を読む。無いか空なら absent、読めなければ unreadable
*/
export function readExecutionFile(path: string | undefined): ExecutionReading {
  const file = nonEmpty(path)
  if (file === undefined) return { kind: 'absent' }
  try {
    return readExecution(readTextFile(file))
  }
  catch (error: unknown) {
    return isFileNotFound(error) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}
