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
  it('convertToPptx の戻り値をそのまま返す (success)', async () => {
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

  it('PipelineConfig が args から組み立てられ runner に渡される', async () => {
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

  it('config.singlePass は既定 on で、env PECOTV_SINGLE_PASS=0 のときだけ false になる (#1147)', async () => {
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

  it('arguments_.singlePass === false（--no-single-pass）は env より優先して config.singlePass を false にする (#1147)', async () => {
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

  it('env PECOTV_SINGLE_PASS_CONCURRENCY は 1 以上の整数だけ config.singlePassConcurrency に写す (#1141)', async () => {
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

  it('skipPostprocess 未指定時は false で渡る', async () => {
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

  it('runner が例外を throw すると PipelineRuntimeError に wrap される', async () => {
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: failingRunner })

    await expect(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 60_000,
    })).rejects.toBeInstanceOf(PipelineRuntimeError)
  })

  it('controller.signal.aborted=true 観測時に PipelineTimeoutError を throw する', async () => {
    // 本実装の setTimeout(controller.abort, idleTimeoutMs) が発火した後を考える。
    // runner が signal.aborted を検知して reject する。
    // その reject を pipeline.convert が PipelineTimeoutError に wrap して再 throw する。
    // この流れを観測する。
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: abortAwareRunner })

    await expect(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    })).rejects.toBeInstanceOf(PipelineTimeoutError)
  })

  it('呼び出し元の signal を abort すると runner の signal も abort され、タイムアウトではなく通常の失敗になる (#1228)', async () => {
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

  it('呼び出し元の signal が abort 済みなら、runner は abort 済みの signal を受け取る (#1228)', async () => {
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

  it('deps.onProgress が idle 上限内に呼ばれ続ける間は abort されず、止まると abort される (#1097)', async () => {
    // 合計時間は idle 上限 (200ms) を大きく超える (進捗 6 回 × 50ms = 300ms) が、進捗のたびに
    // 計時をやり直すため打ち切られない。進捗を止めた後は 200ms で abort される。
    // tick 間隔 (50ms) と idle 上限 (200ms) の間に 4 倍のマージンを取り、実タイマー依存の
    // スケジューリング遅延で早期 abort が誤発火しないようにする (F-09)。
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
    expect(timeoutError.message).toContain('200ms 進捗なし')
    expect(timeoutError.message).toContain('最終進捗: スライド #6 変換完了')
  })

  it('abort 後に遅れて届く onProgress は無視され、タイマーが再武装されない (#1097 F-04)', async () => {
    // index.ts の onProgress は、`if (controller.signal.aborted) return` で abort 後の遅延報告を無視する。
    // ガードが無いと、abort 後もタイマーが再武装され続け、setTimeout が残り続ける。
    // 実運用では、Phase 1 の実行中タスクが abort 後も最後まで動き、完了時に onProgress を呼ぶ。
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

  it('進捗が 1 件も無いまま abort されると lastProgress は undefined (#1097)', async () => {
    const pipeline = new InProcessSlidevPptxPipeline({ convertToPptxRunner: abortAwareRunner })

    const error = await rejectionOf(pipeline.convert({
      presDirectory: '/tmp/pres',
      targetDirectory: '/tmp/dist',
      outputDirectory: '/tmp/out',
      idleTimeoutMs: 50,
    }))

    expect(error).toBeInstanceOf(PipelineTimeoutError)
    expect((error as PipelineTimeoutError).lastProgress).toBeUndefined()
    expect((error as PipelineTimeoutError).message).toContain('スキャン開始前')
  })

  it('timeout で打ち切っても pipeline が積んだ警告を PipelineTimeoutError に引き継ぐ (#931)', async () => {
    // pipeline は中断時 PipelineRuntimeError に warnings を載せて throw する。ここで捨てると
    // timeout した run だけ警告が観測できなくなる。
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

  it('timeout で打ち切っても pipeline が積んだ errors を PipelineTimeoutError に引き継ぐ (#945)', async () => {
    // 変換エラーは失敗の原因そのもの。timeout した run で捨てると、どのスライド・要素が
    // 落ちていたのかが commands 層から観測できなくなる。
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

  it('PipelineRuntimeError を throw する runner は二重 wrap されずそのまま再 throw される', async () => {
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

  it('SlidevPptxConvertArguments の port/concurrency/logLevel を PipelineConfig に反映する', async () => {
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

  it('警告を process.stdout ではなく stderr の warning: 行に出す (slide convert --json の stdout を JSON 行だけにする)', async () => {
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

  it('stderr を渡さないときは、警告を process.stderr の warning: 行に出す', async () => {
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
