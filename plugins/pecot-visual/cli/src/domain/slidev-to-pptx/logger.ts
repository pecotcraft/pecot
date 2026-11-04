// Slidev → PPTX pipeline 内部で使う Logger interface。
// 実装 (createLogger) は Step 2 で infra/slidev-to-pptx/console-logger.ts に置く。

/* eslint-disable unicorn/name-replacements -- args は console.log と同じ可変長引数の慣習名を維持 */
export interface Logger {
  readonly info: (...args: readonly unknown[]) => void
  readonly verbose: (...args: readonly unknown[]) => void
  readonly debug: (...args: readonly unknown[]) => void
  readonly warn: (...args: readonly unknown[]) => void
  readonly error: (...args: readonly unknown[]) => void
}
/* eslint-enable unicorn/name-replacements */
