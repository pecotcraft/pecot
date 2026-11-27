// InProcessSlidevPptxPipeline の挙動 unit test。
// Step 3 part 2 で、旧 ChildProcessPptxConverter を置き換えた in-process pipeline を対象とする。
// convertToPptx を DI で stub し、success / runtime error / timeout abort の 3 つの結末を網羅する。

import { describe, expect, it, vi } from 'vitest'

import type { PipelineConfig } from '../../../domain/slidev-to-pptx/config.js'
import {
  PipelineRuntimeError,
  PipelineTimeoutError,
} from '../../../domain/slidev-to-pptx/errors.js'
import type { PipelineResult } from '../../../domain/slidev-to-pptx/types.js'
import { InProcessSlidevPptxPipeline, type ConvertToPptxRunner } from '../index.js'
import { rejectionOf } from '../../../../tests/_helpers/rejection.js'
import { explains } from '../../../../tests/_helpers/explains.js'

function makeResult(): PipelineResult {
  return {
    success: true,
    slideCount: 1,
    slidesDirectory: '/tmp/out/slides',
    errors: [],
    warnings: [],
    timing: { total: 0, scan: 0, phase1: 0, phase2: 0, perSlide: {} },
  }
}

const successRunner: ConvertToPptxRunner = () => Promise.resolve(makeResult())
const failingRunner: ConvertToPptxRunner = () => Promise.reject(new Error('chromium launch failed'))
interface CapturedStream {
  readonly chunks: string[]
  readonly stream: NodeJS.WritableStream
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  const stub = {
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
  return { chunks, stream: stub as unknown as NodeJS.WritableStream }
}

/**
logger.info（人間可読ログ）と logger.warn を 1 行ずつ書く runner。sink の振り分け先を観測する。
*/
const loggingRunner: ConvertToPptxRunner = (_config, dependencies) => {
  dependencies.logger?.info('info-line')
  dependencies.logger?.warn('warn-line')
  return Promise.resolve(makeResult())
}

const abortAwareRunner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
  dependencies.signal?.addEventListener('abort', () => {
    reject(new Error('aborted'))
  })
})

describe('InProcessSlidevPptxPipeline', () => {
  it('runner が成功した場合は、その戻り値をそのまま返す', async () => {
    await explains('変換処理の runner が成功した場合の、`InProcessSlidevPptxPipeline.convert` のテストです。runner の戻り値（`success` と `slideCount`）が、そのまま返されることを確認します。')
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: successRunner })

    const result = await pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      skipPostprocess: true,
    })

    expect(result.success).toBe(true)
    expect(result.slideCount).toBe(1)
  })

  it('引数から PipelineConfig を組み立てて、runner に渡す', async () => {
    await explains('`convert` に渡した引数から、runner へ渡す設定（`PipelineConfig`）を作成する処理のテストです。`skipPostprocess`・`slidePrefix` と各ディレクトリのパスが、設定に反映されることを確認します。')
    let receivedConfig: PipelineConfig | undefined
    const captureRunner: ConvertToPptxRunner = (config) => {
      receivedConfig = config
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })

    await pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      skipPostprocess: true,
    })

    expect(receivedConfig?.skipPostprocess).toBe(true)
    expect(receivedConfig?.slidePrefix).toBe('slide-')
    // path.resolve 経由で絶対 path 化されることを確認
    expect(receivedConfig?.presDir).toBe('/tmp/pres')
    expect(receivedConfig?.templatePath).toBe('/tmp/dist')
    expect(receivedConfig?.outputDir).toBe('/tmp/out')
  })

  it('環境変数 PECOTV_SINGLE_PASS が 0 の場合だけ config.singlePass が false になり、それ以外は true になる', async () => {
    await explains('環境変数 `PECOTV_SINGLE_PASS` に応じた、`config.singlePass` の設定のテストです。未設定・`1`・空文字の場合は `true`、`0` の場合だけ `false` になることを確認します。')
    const received: (boolean | undefined)[] = []
    const captureRunner: ConvertToPptxRunner = (config) => {
      received.push(config.singlePass)
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })
    const arguments_ = {
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    }
    try {
      vi.stubEnv('PECOTV_SINGLE_PASS', undefined)
      await pipeline.convert(arguments_)
      vi.stubEnv('PECOTV_SINGLE_PASS', '1')
      await pipeline.convert(arguments_)
      vi.stubEnv('PECOTV_SINGLE_PASS', '')
      await pipeline.convert(arguments_)
      vi.stubEnv('PECOTV_SINGLE_PASS', '0')
      await pipeline.convert(arguments_)
    }
    finally {
      vi.unstubAllEnvs()
    }
    expect(received).toStrictEqual([true, true, true, false])
  })

  it('引数の singlePass が false の場合は、環境変数の値にかかわらず config.singlePass を false にする', async () => {
    await explains('引数で `singlePass` を `false`（`--no-single-pass`）にした場合のテストです。環境変数 `PECOTV_SINGLE_PASS` が `1` の場合も未設定の場合も、`config.singlePass` が `false` になることを確認します。')
    const received: (boolean | undefined)[] = []
    const captureRunner: ConvertToPptxRunner = (config) => {
      received.push(config.singlePass)
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })
    const arguments_ = {
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      singlePass: false as const,
    }
    try {
      vi.stubEnv('PECOTV_SINGLE_PASS', '1')
      await pipeline.convert(arguments_)

      vi.stubEnv('PECOTV_SINGLE_PASS', undefined)
      await pipeline.convert(arguments_)
    }
    finally {
      vi.unstubAllEnvs()
    }
    expect(received).toStrictEqual([false, false])
  })

  it('環境変数 PECOTV_SINGLE_PASS_CONCURRENCY が 1 以上の整数の場合だけ、config.singlePassConcurrency に反映する', async () => {
    await explains('環境変数 `PECOTV_SINGLE_PASS_CONCURRENCY` に応じた、`config.singlePassConcurrency` の設定のテストです。`3` や `1` の場合は設定に反映され、`0`・`abc`・`2.5`・空文字の場合は `undefined` になることを確認します。')
    const received: (number | undefined)[] = []
    const captureRunner: ConvertToPptxRunner = (config) => {
      received.push(config.singlePassConcurrency)
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })
    const arguments_ = {
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    }
    try {
      for (const value of ['3', '1', '0', 'abc', '2.5', '']) {
        vi.stubEnv('PECOTV_SINGLE_PASS_CONCURRENCY', value)
        await pipeline.convert(arguments_)
      }
    }
    finally {
      vi.unstubAllEnvs()
    }
    expect(received).toStrictEqual([3, 1, undefined, undefined, undefined, undefined])
  })

  it('skipPostprocess を指定しない場合は、false を runner に渡す', async () => {
    await explains('`skipPostprocess` を指定せずに `convert` を呼んだ場合に、runner へ渡す設定の `skipPostprocess` が `false` になることを確認します。')
    let receivedConfig: PipelineConfig | undefined
    const captureRunner: ConvertToPptxRunner = (config) => {
      receivedConfig = config
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })

    await pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    })

    expect(receivedConfig?.skipPostprocess).toBe(false)
  })

  it('runner が例外を発生させた場合は、PipelineRuntimeError に包んで失敗する', async () => {
    await explains('runner が通常のエラーで失敗した場合のテストです。`convert` が `PipelineRuntimeError` で失敗することを確認します。')
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: failingRunner })

    await expect(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    })).rejects.toBeInstanceOf(PipelineRuntimeError)
  })

  it('タイムアウトで中断された場合は、PipelineTimeoutError で失敗する', async () => {
    // 本実装の setTimeout(controller.abort, idleTimeoutMs) が発火した後を考える。
    // runner が signal.aborted を検知して reject する。
    // その reject を pipeline.convert が PipelineTimeoutError に wrap して再 throw する。
    // この流れを観測する。
    await explains('無通信の上限（`idleTimeoutMs`）を過ぎて中断された場合のテストです。runner が中断を検知して失敗したときに、`convert` が `PipelineTimeoutError` で失敗することを確認します。')
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: abortAwareRunner })

    await expect(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    })).rejects.toBeInstanceOf(PipelineTimeoutError)
  })

  it('呼び出し元の signal を中断した場合は、runner の signal も中断し、タイムアウトではなく通常の失敗にする', async () => {
    await explains('呼び出し元が渡した `signal` を中断した場合のテストです。runner の `signal` も中断され、`convert` がタイムアウトではなく `PipelineRuntimeError` で失敗することを確認します。')
    const external = new AbortController()
    let runnerSignal: AbortSignal | undefined
    const runner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
      runnerSignal = dependencies.signal
      dependencies.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
      external.abort()
    })
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      signal: external.signal,
    }))

    expect(runnerSignal?.aborted).toBe(true)
    expect(error).toBeInstanceOf(PipelineRuntimeError)
    expect(error).not.toBeInstanceOf(PipelineTimeoutError)
  })

  it('呼び出し元の signal が中断済みの場合は、中断済みの signal を runner に渡す', async () => {
    await explains('中断済みの `signal` を渡して `convert` を呼んだ場合に、runner が受け取る `signal` も中断済みになっていることを確認します。')
    let runnerSignal: AbortSignal | undefined
    const runner: ConvertToPptxRunner = (_config, dependencies) => {
      runnerSignal = dependencies.signal
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

    await pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      signal: AbortSignal.abort(),
    })

    expect(runnerSignal?.aborted).toBe(true)
  })

  it('進捗が上限時間内に報告され続ける間は中断せず、報告が止まった時点で中断する', async () => {
    // 合計時間は idle 上限 (200ms) を大きく超える (進捗 6 回 × 50ms = 300ms) が、進捗のたびに
    // 計時をやり直すため打ち切られない。進捗を止めた後は 200ms で abort される。
    // tick 間隔 (50ms) と idle 上限 (200ms) の間に 4 倍のマージンを取り、実タイマー依存の
    // スケジューリング遅延で早期 abort が誤発火しないようにする (F-09)。
    await explains('無通信の上限（`idleTimeoutMs`）を使った、中断の判定のテストです。進捗が上限内に報告され続ける間は中断せず、報告が止まって上限を過ぎた時点で `PipelineTimeoutError` で失敗することを確認します。')
    let isAborted = false
    let progressCount = 0
    const runner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
      dependencies.signal?.addEventListener('abort', () => {
        isAborted = true
        reject(new PipelineRuntimeError('aborted'))
      })
      const tick = (): void => {
        if (isAborted) return
        progressCount++
        dependencies.onProgress?.(`スライド #${progressCount.toString()} 変換完了`)
        if (progressCount < 6) setTimeout(tick, 50)
      }
      setTimeout(tick, 50)
    })
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 200,
    }))

    expect(progressCount).toBe(6)
    expect(error).toBeInstanceOf(PipelineTimeoutError)
    const timeoutError = error as PipelineTimeoutError
    expect(timeoutError.idleTimeoutMs).toBe(200)
    expect(timeoutError.lastProgress).toBe('スライド #6 変換完了')
    // 経過は「6 回の進捗 (約 300ms) + 最後の idle (200ms)」で、idle 上限単独より長い。
    expect(timeoutError.elapsedMs).toBeGreaterThan(200)
    expect(timeoutError.message).toContain('no progress for 200ms')
    expect(timeoutError.message).toContain('last progress: スライド #6 変換完了')
  })

  it('中断した後に届いた進捗の報告は無視し、タイマーを再設定しない', async () => {
    // index.ts の onProgress は、`if (controller.signal.aborted) return` で abort 後の遅延報告を無視する。
    // ガードが無いと、abort 後もタイマーが再武装され続け、setTimeout が残り続ける。
    // 実運用では、Phase 1 の実行中タスクが abort 後も最後まで動き、完了時に onProgress を呼ぶ。
    await explains('タイムアウトで中断した後に、runner が進捗を報告した場合のテストです。報告が無視され、タイマー（`setTimeout`）が再設定されないことを確認します。')
    vi.useFakeTimers()
    try {
      let onProgressReference: ((label: string) => void) | undefined
      const runner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
        onProgressReference = dependencies.onProgress
        dependencies.signal?.addEventListener('abort', () => {
          reject(new PipelineRuntimeError('aborted'))
        })
      })
      const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

      const promise = rejectionOf(pipeline.convert({
        presDirectory: '/tmp/pres',
        targetDirectory: '/tmp/dist',
        outputDirectory: '/tmp/out',
        idleTimeoutMs: 50,
      }))

      await vi.advanceTimersByTimeAsync(50)
      const error = await promise
      expect(error).toBeInstanceOf(PipelineTimeoutError)

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      onProgressReference?.('abort後に遅れて届いた進捗')
      // ガードが働いていれば、タイマーを再武装せず、setTimeout を呼ばない。
      expect(setTimeoutSpy).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('進捗が 1 件もない状態で中断された場合は、lastProgress が undefined になる', async () => {
    await explains('進捗が一度も報告されないまま、タイムアウトで中断された場合のテストです。`PipelineTimeoutError` の `lastProgress` が `undefined` になり、メッセージにスキャン開始前であることを示す文言が含まれることを確認します。')
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: abortAwareRunner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    }))

    expect(error).toBeInstanceOf(PipelineTimeoutError)
    expect((error as PipelineTimeoutError).lastProgress).toBeUndefined()
    expect((error as PipelineTimeoutError).message).toContain('before the scan started')
  })

  it('タイムアウトで中断した場合も、runner が記録した警告を PipelineTimeoutError に引き継ぐ', async () => {
    // pipeline は中断時 PipelineRuntimeError に warnings を載せて throw する。ここで捨てると
    // timeout した run だけ警告が観測できなくなる。
    await explains('runner が警告を持つ `PipelineRuntimeError` で失敗した状態で、タイムアウトによって中断された場合のテストです。`PipelineTimeoutError` の `warnings` に、runner の警告がそのまま引き継がれることを確認します。')
    const warnings = ['キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）']
    const runner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
      dependencies.signal?.addEventListener('abort', () => {
        reject(new PipelineRuntimeError('aborted', { warnings }))
      })
    })
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    }))

    expect(error).toBeInstanceOf(PipelineTimeoutError)
    expect((error as PipelineTimeoutError).warnings).toStrictEqual(warnings)
  })

  it('タイムアウトで中断した場合も、runner が記録した変換エラーを PipelineTimeoutError に引き継ぐ', async () => {
    // 変換エラーは失敗の原因そのもの。timeout した run で捨てると、どのスライド・要素が
    // 落ちていたのかが commands 層から観測できなくなる。
    await explains('runner が変換エラーを持つ `PipelineRuntimeError` で失敗した状態で、タイムアウトによって中断された場合のテストです。`PipelineTimeoutError` の `errors` に、runner の変換エラーがそのまま引き継がれることを確認します。')
    const errors = [
      { level: 'slide', slideNumber: 2, message: 'worker-failed' },
      { level: 'element', slideNumber: 1, selector: '.chart', message: 'pr-fail' },
    ]
    const runner: ConvertToPptxRunner = (_config, dependencies) => new Promise<PipelineResult>((_resolve, reject) => {
      dependencies.signal?.addEventListener('abort', () => {
        reject(new PipelineRuntimeError('aborted', { errors }))
      })
    })
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: runner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    }))

    expect(error).toBeInstanceOf(PipelineTimeoutError)
    expect((error as PipelineTimeoutError).errors).toStrictEqual(errors)
  })

  it('runner が PipelineRuntimeError で失敗した場合は、包み直さずにそのまま失敗する', async () => {
    await explains('runner が `PipelineRuntimeError` で失敗した場合のテストです。`convert` が同じエラーのインスタンスをそのまま発生させ、別のエラーで包み直さないことを確認します。')
    const original = new PipelineRuntimeError('inner already-wrapped error')
    const wrappingRunner: ConvertToPptxRunner = () => Promise.reject(original)
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: wrappingRunner })

    await expect(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    })).rejects.toBe(original)
  })

  it('port・concurrency・logLevel を指定した場合は、PipelineConfig に反映する', async () => {
    await explains('`convert` の引数に `port`・`concurrency`・`logLevel` を指定した場合のテストです。runner に渡す設定の同名の項目に、指定した値が反映されることを確認します。')
    let receivedConfig: PipelineConfig | undefined
    const captureRunner: ConvertToPptxRunner = (config) => {
      receivedConfig = config
      return Promise.resolve(makeResult())
    }
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: captureRunner })

    await pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
      port: 4002,
      concurrency: 2,
      logLevel: 'verbose',
    })

    expect(receivedConfig?.port).toBe(4002)
    expect(receivedConfig?.concurrency).toBe(2)
    expect(receivedConfig?.logLevel).toBe('verbose')
  })

  it('stderr を渡した場合は、警告を渡した stderr に warning: の行として出力し、process.stdout には出力しない', async () => {
    await explains('出力先の `stderr` を渡した場合の、警告の出力のテストです。runner が出した警告が `warning:` の行として渡した `stderr` にだけ出力され、標準出力には書き込まれないことを確認します。')
    const stderr = makeStream()
    const isProcessStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: loggingRunner })

      await pipeline.convert({
        presDirectory: '/tmp/pres',
        targetDirectory: '/tmp/dist',
        outputDirectory: '/tmp/out',
        idleTimeoutMs: 60_000,
        stderr: stderr.stream,
      })

      expect(stderr.chunks).toStrictEqual(['warning: warn-line\n'])
      expect(isProcessStdoutWrite).not.toHaveBeenCalled()
    }
    finally {
      isProcessStdoutWrite.mockRestore()
    }
  })

  it('stderr を渡さない場合は、警告を process.stderr に warning: の行として出力する', async () => {
    await explains('出力先の `stderr` を渡さない場合の、警告の出力のテストです。警告が `warning:` の行として `process.stderr` に出力され、`process.stdout` には書き込まれないことを確認します。')
    const isProcessStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const isProcessStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: loggingRunner })

      await pipeline.convert({
        presDirectory: '/tmp/pres',
        targetDirectory: '/tmp/dist',
        outputDirectory: '/tmp/out',
        idleTimeoutMs: 60_000,
      })

      expect(isProcessStderrWrite.mock.calls.map(call => call[0])).toStrictEqual(['warning: warn-line\n'])
      expect(isProcessStdoutWrite).not.toHaveBeenCalled()
    }
    finally {
      isProcessStdoutWrite.mockRestore()
      isProcessStderrWrite.mockRestore()
    }
  })
})
