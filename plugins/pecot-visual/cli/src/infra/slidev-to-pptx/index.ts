// in-process Slidev → PPTX pipeline 実装。旧 ChildProcessPptxConverter を rename + 刷新し、
// Playwright 起動・dom-to-pptx 注入・slide 並列実行を本プロセス内で行う。
//
// timeout 制御は AbortController で行う。
// 上限は「進捗が無い時間」(idleTimeoutMs) で、pipeline.ts が deps.onProgress で進捗を報告するたびに計時をやり直す。
// 合計時間の上限は持たない (枚数が多いだけの正常な変換を打ち切らない)。
// pipeline.ts は signal を受け取り、要所で cooperative cancel を実施する。
// ただし Playwright 内部の `browser.close()` 完了待ちは、Playwright 側の接続解除に依存する。
// そのため、即座には終わらないことがある。

import path from 'node:path'
import { performance } from 'node:perf_hooks'

import type {
  SlidevPptxConvertArguments,
  SlidevPptxPipeline,
} from '../../domain/_shared/ports.js'
import { DEFAULT_SLIDE_PREFIX, type PipelineConfig } from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import {
  PipelineRuntimeError,
  PipelineTimeoutError,
} from '../../domain/slidev-to-pptx/errors.js'
import type { PipelineResult } from '../../domain/slidev-to-pptx/types.js'
import { createLogger, type LoggerSink } from './console-logger.js'
import { convertToPptx, type PipelineDependencies } from './pipeline.js'

export type { PipelineDependencies } from './pipeline.js'

// 0 = ephemeral port。OS が空きポートを採番するため、複数 worktree のテスト・変換が並行しても、
// dist 配信サーバ同士が衝突しない。
// 固定 3002 時代は、EADDRINUSE が握り潰されて無限ハングしていた。
const DEFAULT_PORT = 0
const DEFAULT_CONCURRENCY = 4
const DEFAULT_LOG_LEVEL = 'normal'

/**
`convertToPptx` を呼び出す関数の差し替え用 port。test では mock を渡し、
本番では default の `convertToPptx` 実装が使われる。
*/
export type ConvertToPptxRunner = (
  config: Readonly<PipelineConfig>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- signal は mutable 型
  dependencies: PipelineDependencies,
) => Promise<PipelineResult>

export interface InProcessSlidevPptxPipelineDependencies {
  readonly convertToPptxRunner?: ConvertToPptxRunner
}

/**
1 パス方式のグループ数を env の値から読む（#1141）。1 以上の整数だけを採り、未設定・不正値は
キーを置かない（pipeline が concurrency を使う）。
*/
function singlePassConcurrencyFromEnvironment(value: string | undefined): { singlePassConcurrency?: number } {
  if (value === undefined || !/^\d+$/.test(value)) return {}
  const parsed = Math.trunc(Number(value))
  return parsed >= 1 ? { singlePassConcurrency: parsed } : {}
}

export class InProcessSlidevPptxPipeline implements SlidevPptxPipeline {
  private readonly runner: ConvertToPptxRunner

  public constructor(dependencies: Readonly<InProcessSlidevPptxPipelineDependencies> = {}) {
    this.runner = dependencies.convertToPptxRunner ?? convertToPptx
  }

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
  async convert(arguments_: Readonly<SlidevPptxConvertArguments>): Promise<PipelineResult> {
    const config: PipelineConfig = {
      presDir: path.resolve(arguments_.presDirectory),
      templatePath: path.resolve(arguments_.targetDirectory),
      outputDir: path.resolve(arguments_.outputDirectory),
      slidePrefix: DEFAULT_SLIDE_PREFIX,
      port: arguments_.port ?? DEFAULT_PORT,
      // eslint-disable-next-line unicorn/no-null -- PipelineConfig.onlySlide は null 既定 (旧 lib 仕様)
      onlySlide: null,
      concurrency: arguments_.concurrency ?? DEFAULT_CONCURRENCY,
      logLevel: arguments_.logLevel ?? DEFAULT_LOG_LEVEL,
      skipPostprocess: arguments_.skipPostprocess === true,
      // 1 パス方式（#1141 で試作、#1147 で既定 on）。
      // env の解釈の基準はここで、pipeline は config だけを見る。
      // `slide convert --no-single-pass`（arguments_.singlePass === false）なら off。
      // env `PECOTV_SINGLE_PASS=0` でも off。env が `0` 以外の値、または未設定なら on。
      singlePass: arguments_.singlePass !== false && process.env['PECOTV_SINGLE_PASS'] !== '0',
      ...singlePassConcurrencyFromEnvironment(process.env['PECOTV_SINGLE_PASS_CONCURRENCY']),
      // exactOptionalPropertyTypes: true のため、未指定は「キー自体を置かない」で伝搬する。
      ...(arguments_.cachePluginVersion !== undefined && {
        cache: {
          pluginVersion: arguments_.cachePluginVersion,
          // eslint-disable-next-line unicorn/no-null -- PipelineConfig.cache.theme は未指定 null 既定 (旧 lib 仕様踏襲)
          theme: arguments_.theme ?? null,
          skipRead: arguments_.cacheSkipRead === true,
        },
      }),
    }
    // stdout は呼び出し元が明示したときだけ使う。
    // `slide convert --json` は stdout を JSON 行だけにするため、stdout を渡さない。
    // そのため人間可読ログは stderr 側へ寄せる。process.stdout へフォールバックすると JSON イベントと混在する。
    const stderr = arguments_.stderr ?? process.stderr
    const sink: LoggerSink = {
      stdout: arguments_.stdout ?? stderr,
      stderr,
    }
    const logger = createLogger(config.logLevel, sink)

    const controller = new AbortController()
    const startedAt = performance.now()
    let lastProgress: string | undefined
    // abort 時刻そのもの (elapsedMs の基準)。catch 節に来るまでの間に Phase 1 の後始末
    // (browser.close 等) が挟まると観測時刻が遅れるため、abort 発火の瞬間に確定させる。
    let abortedAt: number | undefined
    const abort = (): void => {
      abortedAt = performance.now()
      controller.abort()
    }
    let timeoutHandle = setTimeout(abort, arguments_.idleTimeoutMs)
    // 進捗のたびに計時をやり直す。abort 後の遅れた報告でタイマーを蘇らせない。
    const onProgress = (label: string): void => {
      if (controller.signal.aborted) return
      lastProgress = label
      clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(abort, arguments_.idleTimeoutMs)
    }
    try {
      return await this.runner(config, {
        logger,
        // 外部のキャンセルは無進捗タイムアウトと合成する。タイムアウト判定は controller だけを見るため、
        // キャンセルで打ち切った run は PipelineTimeoutError ではなく通常の失敗として扱われる。
        signal: arguments_.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, arguments_.signal]),
        onProgress,
        ...(arguments_.onStepProgress !== undefined && { onStepProgress: arguments_.onStepProgress }),
      })
    }
    catch (error: unknown) {
      if (controller.signal.aborted) {
        // timeout で打ち切った run でも、pipeline が積んだ警告とエラーは commands 層まで届ける。
        const warnings = error instanceof PipelineRuntimeError ? error.warnings : undefined
        const errors = error instanceof PipelineRuntimeError ? error.errors : undefined
        throw new PipelineTimeoutError(
          arguments_.idleTimeoutMs,
          {
            elapsedMs: Math.round((abortedAt ?? performance.now()) - startedAt),
            ...(lastProgress !== undefined && { lastProgress }),
            ...(warnings !== undefined && { warnings }),
            ...(errors !== undefined && { errors }),
          },
        )
      }
      // 二重 wrap 防止: pipeline 内部で既に PipelineRuntimeError 化されたものはそのまま rethrow
      if (error instanceof PipelineRuntimeError) throw error
      throw new PipelineRuntimeError(errorMessage(error), { cause: error })
    }
    finally {
      clearTimeout(timeoutHandle)
    }
  }
}
