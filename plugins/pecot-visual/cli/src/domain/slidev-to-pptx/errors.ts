// pipeline orchestrator (Step 3 の InProcessSlidevPptxPipeline) が throw する例外。
// commands 層は instanceof で reason key (`pptx-convert-timeout` / `pptx-convert-failed`) に
// マッピングする。

import type { PipelineError } from './types.js'

export class PipelineTimeoutError extends Error {
  /**
  進捗が無いまま経過すると打ち切る時間 (ms)。
  */
  public readonly idleTimeoutMs: number

  /**
  pipeline 開始から打ち切りまでの経過時間 (ms)。
  */
  public readonly elapsedMs: number

  /**
  最後に報告された進捗。1 件も無ければ undefined (スキャン開始前に止まった)。
  */
  public readonly lastProgress?: string

  /**
  pipeline が中断までに積んだ警告。commands 層が `--json` の error payload へ載せる。
  */
  public readonly warnings?: readonly string[]

  /**
  pipeline が中断までに積んだエラー。commands 層が `--json` の error payload へ載せる。
  */
  public readonly errors?: readonly PipelineError[]

  public constructor(
    idleTimeoutMs: number,
    options: Readonly<{
      /**
      pipeline 開始から打ち切りまでの経過時間 (ms)。呼び出し側で計測した値を渡す必須項目。
      */
      elapsedMs: number
      lastProgress?: string
      warnings?: readonly string[]
      errors?: readonly PipelineError[]
    }>,
  ) {
    const { elapsedMs } = options
    const lastProgress = options.lastProgress ?? 'no progress (before the scan started)'
    super(
      `no progress for ${idleTimeoutMs.toString()}ms`
      + ` (elapsed ${elapsedMs.toString()}ms, last progress: ${lastProgress})`,
    )
    this.name = 'PipelineTimeoutError'
    this.idleTimeoutMs = idleTimeoutMs
    this.elapsedMs = elapsedMs
    if (options.lastProgress !== undefined) this.lastProgress = options.lastProgress
    if (options.warnings !== undefined) this.warnings = options.warnings
    if (options.errors !== undefined) this.errors = options.errors
  }
}

export class PipelineRuntimeError extends Error {
  /**
  pipeline が失敗までに積んだ警告。commands 層が `--json` の error payload へ載せる。
  */
  public readonly warnings?: readonly string[]

  /**
  pipeline が失敗までに積んだエラー。commands 層が `--json` の error payload へ載せる。
  */
  public readonly errors?: readonly PipelineError[]

  public constructor(
    message: string,
    options?: Readonly<{
      cause?: unknown
      warnings?: readonly string[]
      errors?: readonly PipelineError[]
    }>,
  ) {
    super(message, options)
    this.name = 'PipelineRuntimeError'
    if (options?.warnings !== undefined) this.warnings = options.warnings
    if (options?.errors !== undefined) this.errors = options.errors
  }
}
