// Slidev PPTX pipeline 用の Logger 実装。出力はすべて stderr の診断行（note / warning / error）にする。
// sink 未指定時は process.stderr を使う。

import { format } from 'node:util'

import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { createDiagnostics, type DiagnosticStream } from '../../diagnostics.js'

// 区切りのための先頭の改行は、空の note の行になるので落とす。
// eslint-disable-next-line unicorn/name-replacements -- args は console.log と同じ可変長引数の慣習名を維持
function text(...args: readonly unknown[]): string {
  return format(...args).replace(/^\n+/, '')
}

const LOG_LEVELS: Readonly<Record<string, number>> = { normal: 0, verbose: 1, debug: 2 }

export interface LoggerSink {
  readonly stderr: DiagnosticStream
}

/**
指定 level の Logger を生成する。sink 未指定時は process.stderr を使う。

@param level 'normal' (warn / error のみ) / 'verbose' (info + verbose も note) / 'debug' (全 level)。
  未知の level は 'normal' 扱い。
@param sink 注入する stderr。省略時は process.stderr。
*/
export function createLogger(
  level = 'normal',
  sink?: LoggerSink,
): Logger {
  const diagnostics = createDiagnostics((sink ?? { stderr: process.stderr }).stderr)
  // LOG_LEVELS の lookup に失敗したときは、`?? 0` で normal にフォールバックする。
  // eslint-disable-next-line security/detect-object-injection -- level は CLI flag 経由の限定値
  const threshold = LOG_LEVELS[level] ?? 0

  /* eslint-disable unicorn/name-replacements -- args は console.log と同じ可変長引数の慣習名を維持 */
  return {
    info: (...args) => { if (threshold >= 1) diagnostics.note(text(...args)) },
    verbose: (...args) => { if (threshold >= 1) diagnostics.note(text(...args)) },
    debug: (...args) => { if (threshold >= 2) diagnostics.note(text(...args)) },
    warn: (...args) => { diagnostics.warning(text(...args)) },
    error: (...args) => { diagnostics.error(text(...args)) },
  }
  /* eslint-enable unicorn/name-replacements */
}
