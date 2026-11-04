// Slidev PPTX pipeline 用の Logger 実装。sink (stdout / stderr WritableStream) を注入できる。
// sink 未指定時は process.stdout / process.stderr を使う。

import { format } from 'node:util'

import type { Logger } from '../../domain/slidev-to-pptx/logger.js'

const LOG_LEVELS: Readonly<Record<string, number>> = { normal: 0, verbose: 1, debug: 2 }

export interface LoggerSink {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

/**
指定 level の Logger を生成する。sink 未指定時は process.stdout / process.stderr を使う。

@param level 'normal' (info のみ) / 'verbose' (info + verbose) / 'debug' (全 level)。
  未知の level は 'normal' 扱い。
@param sink 注入する WritableStream ペア。省略時は process.stdout / process.stderr。
*/
export function createLogger(
  level = 'normal',
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
  sink?: LoggerSink,
): Logger {
  const resolvedSink: LoggerSink = sink ?? { stdout: process.stdout, stderr: process.stderr }
  // LOG_LEVELS の lookup に失敗したときは、`?? 0` で normal にフォールバックする。
  // eslint-disable-next-line security/detect-object-injection -- level は CLI flag 経由の限定値
  const threshold = LOG_LEVELS[level] ?? 0

  /* eslint-disable unicorn/name-replacements -- args は console.log と同じ可変長引数の慣習名を維持 */
  const writeOut = (...args: readonly unknown[]): void => {
    resolvedSink.stdout.write(format(...args) + '\n')
  }
  const writeErr = (...args: readonly unknown[]): void => {
    resolvedSink.stderr.write(format(...args) + '\n')
  }

  return {
    info: (...args) => { writeOut(...args) },
    verbose: (...args) => { if (threshold >= 1) writeOut(...args) },
    debug: (...args) => { if (threshold >= 2) writeOut(...args) },
    warn: (...args) => { writeErr(...args) },
    error: (...args) => { writeErr(...args) },
  }
  /* eslint-enable unicorn/name-replacements */
}
