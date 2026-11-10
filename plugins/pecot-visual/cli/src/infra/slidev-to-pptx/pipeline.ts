/* eslint-disable unicorn/name-replacements, unicorn/import-style -- 旧 lib pipeline.ts 由来 */
/* eslint-disable unicorn/no-null, no-useless-assignment -- 旧 lib pipeline.ts 由来 */
/* eslint-disable no-restricted-syntax, security/detect-object-injection -- 旧 lib pipeline.ts 由来 */
/* eslint-disable security/detect-non-literal-fs-filename -- 旧 lib pipeline.ts 由来 */
// 旧 lib pipeline.ts 由来の orchestrator。Playwright + dom-to-pptx resolve を踏襲する。
import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { chromium, type Browser } from 'playwright'

import {
  CACHE_SCHEMA_VERSION,
  createCacheManifest,
  getCacheEntry,
  type CacheManifest,
  type SlideCacheEntry,
} from '../../domain/slidev-to-pptx/cache-manifest.js'
import {
  ANIMATION_POLICY_SCHEMA_VERSION,
  defaultExportToPptxOptions,
  slideViewport,
  timeouts,
  type ExportToPptxOptions,
  type PipelineConfig,
} from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import { PipelineRuntimeError } from '../../domain/slidev-to-pptx/errors.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { buildSlideUrl, type SlideUrlFormat } from '../../domain/slidev-to-pptx/slide-url.js'
import { sanitizeFilename } from '../../domain/slidev-to-pptx/slides-title.js'
import { stepIndexOf, stepKeyOf } from '../../domain/slidev-to-pptx/step-index.js'
import type {
  CacheInvalidation,
  PipelineCacheSummary,
  PipelineError,
  PipelineResult,
  SinglePassTiming,
  SlidePhases,
  SlideStep,
} from '../../domain/slidev-to-pptx/types.js'
import { slidevReadyFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import {
  cacheDirectoryOf,
  clearOrphanedCacheArtifacts,
  computeDeckCacheKeys,
  materializeCacheEntry,
  pruneCache,
  readCacheManifest,
  saveSlideToCache,
  writeCacheManifest,
  type DeckCacheKeyOptions,
  type DeckCacheKeys,
  type MaterializedSlide,
} from './cache-store.js'
import { createLogger } from './console-logger.js'
import { readSlidesTitle } from './dom-converter.js'
import { buildOnlySteps, scanSlideSteps } from './scanner.js'
import { DEPENDENCY_RECOVERY_HINT, resolveDependency } from '../_shared/dependency-root.js'
import { chromiumLaunchError } from '../playwright/launch.js'
import { LOOPBACK_HOST, resolveBoundPort, startServer } from './server.js'
import { runWithConcurrency } from './concurrency.js'
import { convertStepsSinglePass, removeStepArtifacts, type SinglePassRunner } from './single-pass-worker.js'
import { convertSingleSlideWithRetry, type SlideConvertResult, type SlideWorkerConfig, type SlideWorkerRunner } from './slide-worker.js'

/**
convertToPptx の依存注入。test 時に Browser / Server / dom-to-pptx の解決方法を差し替える。
既定値は本物の chromium / startServer / 依存ルート経由の dom-to-pptx 解決。
*/
export interface PipelineDependencies {
  readonly logger?: Logger
  readonly createBrowser?: () => Promise<Browser>
  readonly createServer?: (distDir: string, port: number, logger: Pick<Logger, 'error'>) => Promise<Server>
  /**
  dom-to-pptx.bundle.js の絶対パスを返す関数。省略時は依存ルート経由で解決
  */
  readonly resolveDomToPptx?: () => string
  /**
  convertSingleSlideWithRetry の差し替え (orchestration test 分離用)
  */
  readonly slideWorkerRunner?: SlideWorkerRunner
  /**
  1 パス変換（config.singlePass）の差し替え (orchestration test 分離用)
  */
  readonly singlePassRunner?: SinglePassRunner
  /**
  上位 (InProcessSlidevPptxPipeline) からの cooperative cancel signal。
  要所で `signal.aborted` を観測し、true なら早期 throw する。
  要所は Phase 1 scan の前後、Phase 1 worker の並列実行前、merge/output の直前。
  Playwright `browser.close()` 自体は try-finally で必ず呼ばれる。
  ただし内部の close 完了待ちは、Playwright の接続解除に依存する。
  */
  readonly signal?: AbortSignal
  /**
  進捗の報告先 (省略可)。
  スキャンで 1 ステップ検出するごとと、スライド 1 ステップの変換が終わる (成功・失敗とも) ごとに呼ぶ。
  上位 (InProcessSlidevPptxPipeline) はこれで idle timeout の計時をやり直す。
  label は打ち切り時のメッセージに「最終進捗」として載る。
  */
  readonly onProgress?: (label: string) => void
  /**
  ステップ単位の進み具合の報告先 (省略可)。
  スキャンでステップ総数が決まった時点で、completed=0 を 1 回呼ぶ。
  以降は、ステップが 1 つ終わる (キャッシュ復元・変換の成功/失敗) ごとに呼ぶ。
  completed は終わったステップの重複なしの数で、別の変換方式へ退避してやり直しても二重に数えない。
  */
  readonly onStepProgress?: (completed: number, total: number) => void
  /**
  cache-store 関数の差し替え (test 専用)。省略時は cache-store.js の実装をそのまま使う。

  実 fs I/O のエラー注入なしに、2 つの分岐を決定論的にテストするための DI 口。
  - `computeDeckCacheKeys` の予期しない throw は、SC-004 の最終防波堤になる。外側 catch で警告し、全変換にフォールバックする。
  - `materializeCacheEntry` の throw は、当該ステップを miss に降格する。
  */
  readonly cacheStore?: Readonly<{
    readonly computeDeckCacheKeys?: typeof computeDeckCacheKeys
    readonly materializeCacheEntry?: typeof materializeCacheEntry
  }>
}

/**
`deps.signal` の aborted を観測し、true なら AbortError を throw する helper。
Phase 1 ループの要所に挿入する。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal 用
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error('aborted')
  }
}

/**
Phase 1 task wrapper が、開始前に abort 済だったため runSlide を一切呼ばずに reject したことを示すマーカー。
runWithConcurrency のキューに並んだまま abort された task は、これを投げる。
集約ループはこれを、通常の変換失敗（errors[] への追加・警告ログ）と区別する。
*/
class Phase1TaskAbortedError extends Error {
  public constructor() {
    super('Phase 1 task aborted before start')
    this.name = 'Phase1TaskAbortedError'
  }
}

/**
キャッシュ判定の前提。キー算出に成功した run でのみ作られる。
`previous` は前回の manifest、`invalidated` はエントリ再利用前の初期状態
（`all:env` / `all:manifest` は再利用不可を意味する）。
*/
interface CacheSetup {
  readonly keys: DeckCacheKeys
  readonly previous: CacheManifest | undefined
  readonly invalidated: CacheInvalidation
  /**
  前回エントリを再利用してよいか（envHash 一致かつ manifest 正常）
  */
  readonly reusable: boolean
  /**
  `--no-cache`。hit 判定だけを飛ばす（保存・prune・manifest 更新は通常どおり）
  */
  readonly skipRead: boolean
}

/**
manifest 読み取りだけで決まる部分。`skipRead` の反映前の状態。
*/
type CacheReadState = Omit<CacheSetup, 'skipRead'>

/**
ステップ 1 件の判定と結果。集約・保存・結果報告がこの順序付き配列を共有する。
*/
interface StepPlan {
  readonly step: SlideStep
  readonly stepIndex: number
  readonly key: string
  cache: 'hit' | 'miss'
  /**
  キー算出済みなら当該スライドの slideHash。undefined は scan とパーサの不一致
  */
  slideHash?: string
  /**
  hit のとき、cache から復元したマップ断片
  */
  materialized?: MaterializedSlide
  /**
  hit のとき、新 manifest へ引き継ぐ既存エントリ
  */
  entry?: SlideCacheEntry
  /**
  hit の materialize 所要時間（miss は変換結果側の elapsed を使う）
  */
  elapsed: number
}

/**
判定箇所と末尾サマリーで同一文言を使うための定数。
*/
const CACHE_MANIFEST_INVALID_WARNING = 'キャッシュ manifest が読めません（既存の成果物を掃除して作り直します）'

/**
スキーマ版が合わない manifest の警告。
扱い（全変換 + 掃除）は破損と同じ。
ただしこちらは、プラグイン更新後の初回 run で必ず起きる正常な事象なので、破損を思わせる文言にしない。
*/
function cacheManifestOutdatedWarning(found: number): string {
  return `キャッシュ manifest のスキーマ版が異なるため使いません`
    + `（manifest v${found.toString()} / 現行 v${CACHE_SCHEMA_VERSION.toString()}）。`
    + `既存の成果物を掃除して作り直します`
}

/**
キャッシュ系の警告を stderr へ出す。
convertToPptx が成功した場合と、途中で throw した場合の双方から呼ぶ。
これにより、警告の出力を「run につき一度だけ」に保つ。
*/
function emitWarningSummary(logger: Logger, warnings: readonly string[]): void {
  if (warnings.length === 0) return
  logger.info(`警告: ${warnings.length.toString()}件`)
  for (const w of warnings) {
    logger.warn(`  ${w}`)
  }
}

/**
変換エラー（スライド単位・要素単位）を stderr へ出す。
emitWarningSummary と同じく、成功した場合と throw した場合の双方から呼ぶ。
これにより、出力を「run につき一度だけ」に保つ。

`=== 変換結果サマリー ===` ヘッダと `成功: Nスライド` は含めない。
throw する run では、slideCount が未確定のまま「成功: 0スライド」を出すことになる。
そのため、この 2 つは成功した場合の側に残す。
*/
function emitErrorSummary(logger: Logger, errors: readonly PipelineError[]): void {
  const slideErrors = errors.filter(e => e.level === 'slide')
  const elementErrors = errors.filter(e => e.level === 'element')
  if (slideErrors.length > 0) {
    logger.info(`失敗: ${slideErrors.length.toString()}スライド`)
    for (const error of slideErrors) {
      logger.warn(`  [slide] スライド${error.slideNumber?.toString() ?? '?'}: ${error.message}`)
    }
  }
  if (elementErrors.length === 0) {
    return
  }

  logger.info(`要素エラー: ${elementErrors.length.toString()}件`)
  for (const error of elementErrors) {
    logger.warn(`  [element] スライド${error.slideNumber?.toString() ?? '?'} ${error.selector ?? ''}: ${error.message}`)
  }
}

/**
新規スライドの miss では昇格させない（末尾追加は invalidated=none）。
*/
function escalateToPartial(current: CacheInvalidation): CacheInvalidation {
  return current === 'none' ? 'partial' : current
}

/**
キー算出と manifest 読み取りを行う。
キー算出に失敗した場合は、警告を積んで undefined を返す。
呼び出し側は、キャッシュ無しの全変換にフォールバックする（SC-004）。

`skipRead`（`--no-cache`）でも、manifest の読み取りと孤児掃除は通常どおり行う。
飛ばすのは hit 判定だけで、prune には前回の manifest が要る（FR-010）。
判定していない run で `all:env` 等を報告すると、「無効化を検知した」と読めてしまう。
そのため種別は none にする。

ただし none に倒すのは、本関数が正常に返った run だけ。
キャッシュ層が throw した run は、呼び出し側の外側 catch が `all:error` を報告する。
そこは `skipRead` を見ない。
`--no-cache` でも、「例外で退避した」ことは報告する。
*/
async function prepareCache(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 警告を書き込む accumulator
  warnings: string[],
  options: Readonly<{
    presDir: string
    libPath: string
    chromiumVersion: string
    pluginVersion: string
    theme: string | null
    exportOptions: Readonly<ExportToPptxOptions>
    route: DeckCacheKeyOptions['route']
    skipRead: boolean
    cacheDirectory: string
    computeDeckCacheKeys: typeof computeDeckCacheKeys
  }>,
): Promise<CacheSetup | undefined> {
  const keyResult = await options.computeDeckCacheKeys({
    projectDirectory: options.presDir,
    slidesPath: join(options.presDir, 'slides.md'),
    domToPptxBundlePath: options.libPath,
    chromiumVersion: options.chromiumVersion,
    pluginVersion: options.pluginVersion,
    buildOptions: { theme: options.theme },
    exportOptions: options.exportOptions,
    route: options.route,
  })
  if (!keyResult.ok) {
    warnings.push(`キャッシュキーを算出できないため全変換します: ${keyResult.message}`)
    return undefined
  }

  const state = await readCacheState(keyResult.keys, warnings, options)
  return options.skipRead
    ? { ...state, invalidated: 'none', skipRead: true }
    : { ...state, skipRead: false }
}

/**
前回 manifest を読み、再利用可否と無効化の種別を決める。
*/
async function readCacheState(
  keys: Readonly<DeckCacheKeys>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 警告を書き込む accumulator
  warnings: string[],
  options: Readonly<{ cacheDirectory: string }>,
): Promise<CacheReadState> {
  const read = await readCacheManifest(options.cacheDirectory)
  if (read.status === 'invalid' || read.status === 'outdated') {
    // 「全変換します」とは書かない。
    // --no-cache の run は、manifest の状態を問わず全変換する。
    // 書くと、manifest 破損が原因であるかのような報告になる。
    // 掃除より先に積む。
    // clearOrphanedCacheArtifacts が throw して、呼び出し側の外側 catch へ移る run でも、
    // manifest が使えなかった事実は警告として残す必要がある。
    warnings.push(read.status === 'outdated'
      ? cacheManifestOutdatedWarning(read.schemaVersion)
      : CACHE_MANIFEST_INVALID_WARNING)
    // manifest が読めないと、「前回どのエントリが生きていたか」を prune 側で判定できない。
    // すると、削除済みスライドの成果物が cache/ に恒久的に残る（FR-010）。
    // そこで既知パターンだけをここで一括掃除し、生存分は今回の run の保存で作り直す。
    await clearOrphanedCacheArtifacts(options.cacheDirectory)
    return { keys, previous: undefined, invalidated: 'all:manifest', reusable: false }
  }
  if (read.status === 'missing') {
    return { keys, previous: undefined, invalidated: 'none', reusable: false }
  }
  if (read.manifest.envHash !== keys.envHash) {
    return { keys, previous: read.manifest, invalidated: 'all:env', reusable: false }
  }
  return { keys, previous: read.manifest, invalidated: 'none', reusable: true }
}

/**
各ステップの hit / miss を決め、hit 分を staging へ復元する。
戻り値は、無効化の種別と、manifest を書き換えてよいか。
slideHash を引けないステップがあれば、後者は false になる。
*/
async function decideSteps(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 判定結果を書き込む accumulator
  plans: StepPlan[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 警告を書き込む accumulator
  warnings: string[],
  setup: Readonly<CacheSetup>,
  options: Readonly<{
    cacheDirectory: string
    slidesDir: string
    slidePrefix: string
    materializeCacheEntry: typeof materializeCacheEntry
    /**
    キャッシュ復元 (materializeCacheEntry の await) の完了ごとに呼ぶ (idle timeout 計時用)。
    */
    onProgress?: (label: string) => void
    /**
    キャッシュ復元に成功したステップを完了として数える。
    */
    onStepDone?: (key: string) => void
  }>,
): Promise<{ invalidated: CacheInvalidation, manifestWritable: boolean }> {
  let invalidated = setup.invalidated
  let isManifestWritable = true

  for (const plan of plans) {
    const slideHash = setup.keys.slideHashes.get(plan.step.slideNumber)
    if (slideHash === undefined) {
      // スキャン結果とパーサのスライド数が食い違っている。
      // 判定できないステップがある状態で prune や manifest の書き換えをすると、生きたエントリを消しかねない。
      // そのため、この run は書かない。
      isManifestWritable = false
      continue
    }
    plan.slideHash = slideHash
    // `--no-cache`。slideHash は保存側が使うため確保する。そのうえで hit 判定だけを飛ばす。
    if (setup.skipRead || !setup.reusable || setup.previous === undefined) continue

    const entry = getCacheEntry(setup.previous, plan.stepIndex)
    if (entry === undefined) continue
    if (entry.slideHash !== slideHash) {
      invalidated = escalateToPartial(invalidated)
      continue
    }

    const materializeStart = performance.now()
    let materialized: MaterializedSlide | undefined
    try {
      materialized = await options.materializeCacheEntry(
        { cacheDirectory: options.cacheDirectory, slidesDirectory: options.slidesDir, stepIndex: plan.stepIndex, slidePrefix: options.slidePrefix },
        entry,
      )
    }
    catch (error) {
      warnings.push(`キャッシュの復元に失敗しました (#${plan.key}): ${errorMessage(error)}`)
    }
    // 成否によらず、await 自体が idle timeout の計時対象になる時間を使う。そのためここで報告する。
    options.onProgress?.(`キャッシュ復元 #${plan.key}`)
    if (materialized === undefined) {
      invalidated = escalateToPartial(invalidated)
      continue
    }
    plan.cache = 'hit'
    options.onStepDone?.(plan.key)
    plan.materialized = materialized
    plan.entry = entry
    plan.elapsed = performance.now() - materializeStart
  }

  return { invalidated, manifestWritable: isManifestWritable }
}

/**
更新後のエントリ集合から参照されなくなった成果物を消す。
`computePruneTargets` は、生存 stepIndex のエントリを対象にしない。
そのため、prerender の枚数が減る変更を繰り返すと、旧ファイルが cache/ に残り続ける（FR-010）。
*/
async function removeUnreferencedArtifacts(
  cacheDirectory: string,
  previous: Readonly<CacheManifest>,
  stepIndexes: readonly number[],
  entries: ReadonlyMap<number, SlideCacheEntry>,
): Promise<void> {
  const referenced = new Set<string>()
  for (const entry of entries.values()) {
    referenced.add(entry.pptxFile)
    for (const name of entry.prerenderFiles) referenced.add(name)
  }
  for (const stepIndex of stepIndexes) {
    const old = getCacheEntry(previous, stepIndex)
    if (old === undefined) continue
    for (const name of [old.pptxFile, ...old.prerenderFiles]) {
      if (referenced.has(name)) continue
      await rm(join(cacheDirectory, name), { force: true })
    }
  }
}

/**
runSinglePassOrFallback の入力。
*/
interface SinglePassAttemptRequest {
  readonly config: Readonly<PipelineConfig>
  readonly deps: PipelineDependencies
  readonly browser: Browser
  readonly baseUrl: string
  /**
  デッキ全体を走査した run か（--only 等の部分実行は対象外）
  */
  readonly usedFullScan: boolean
  /**
  ルータ判定の結果。print ルートの URL の形を決める
  */
  readonly urlFormat: Readonly<SlideUrlFormat>
  readonly plans: readonly StepPlan[]
  readonly missPlans: readonly StepPlan[]
  readonly workerConfig: SlideWorkerConfig
  readonly runSlide: SlideWorkerRunner
  readonly slidesDir: string
  readonly slidePrefix: string
  readonly logger: Logger
  /**
  退避の理由を積む run 全体の警告
  */
  readonly warnings: string[]
  /**
  ステップが終わった（変換の成功・現行 worker での成否）ことを key で数える
  */
  readonly onStepDone: (key: string) => void
}

/**
1 パス変換の結果。results が無ければ、呼び出し側が現行方式で全 miss を変換する。
*/
interface SinglePassAttempt {
  /**
  missPlans と同じ順序の結果
  */
  readonly results?: readonly PromiseSettledResult<SlideConvertResult>[]
  readonly timing?: SinglePassTiming
}

/**
print ルートが無い deck の退避 warning に添える対処。
*/
const PRINT_ROUTE_REMEDY = '`slide_sync` で deck を同期すると print ルートが入ります'

/**
1 パス変換を使わなかった（一部を現行方式へ回した場合を含む）ときの warning の接頭辞。E2E も参照する
*/
export const SINGLE_PASS_FALLBACK_PREFIX = '1 パス変換を使わず現行方式で変換します'

/**
1 パス変換（#1141 で試作、#1147 で既定 on）を試す。
`config.singlePass` で miss があるときだけ動く。
前提が欠ける run（部分実行・print ルートの無い build）や、1 パス変換自体の失敗は、警告して現行方式（ステップ単位の並列）に任せる。
print ルートの無い build は、warning を 1 回だけ出す。
timing には、退避の理由と判定時間を載せる。
abort 後の失敗は、そのまま投げる。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 可変型
async function runSinglePassOrFallback(request: Readonly<SinglePassAttemptRequest>): Promise<SinglePassAttempt> {
  const { config, deps, logger, warnings, missPlans, slidesDir, slidePrefix } = request
  if (config.singlePass !== true || missPlans.length === 0) return {}
  const reportFallback = (reason: string): void => {
    const message = `${SINGLE_PASS_FALLBACK_PREFIX}: ${reason}`
    logger.warn(message)
    warnings.push(message)
  }
  if (!request.usedFullScan) {
    reportFallback('全走査でない run（--only 等）は対象外です')
    return {}
  }
  try {
    const outcome = await (deps.singlePassRunner ?? convertStepsSinglePass)({
      browser: request.browser,
      baseUrl: request.baseUrl,
      urlFormat: request.urlFormat,
      steps: missPlans.map(plan => plan.step),
      // print ページのコンテナ数と比べるのは、hit を含む全走査のステップ総数
      totalSteps: request.plans.length,
      workerConfig: request.workerConfig,
      slidesDir,
      logger,
      fallbackRunner: request.runSlide,
      concurrency: config.singlePassConcurrency ?? config.concurrency,
      ...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
      onStepDone: (step) => { request.onStepDone(stepKeyOf(step)) },
      ...(deps.signal !== undefined && { signal: deps.signal }),
    })
    if (outcome.kind === 'printRouteMissing') {
      // どのステップも変換していない。全 miss を、呼び出し側の現行方式（ステップ単位の並列）に任せる。
      // この kind は、`#page-root` が出て `#print-container` が無い build に限られる。
      // 判定の時間切れは、グループ単位の退避として下の fallbacks に来る。
      // そのため `slide_sync` の案内は、ここでだけ付ける
      reportFallback(`${outcome.timing.fallback}。${PRINT_ROUTE_REMEDY}`)
      return { timing: outcome.timing }
    }
    // グループ単位・ステップ単位の退避（それぞれ現行 worker で変換済み。案内は付けない）
    for (const reason of outcome.fallbacks) reportFallback(reason)
    return { results: outcome.results, timing: outcome.timing }
  }
  catch (error) {
    if (deps.signal?.aborted === true) throw error
    reportFallback(`1 パス変換が失敗しました: ${errorMessage(error)}`)
    // 途中まで書いた成果物を消してから、現行方式で変換し直す。
    // キャッシュ保存は staging を readdir で拾うため、残すと別方式の prerender が紛れ込む。
    await removeStepArtifacts(slidesDir, missPlans.map(plan => plan.stepIndex), slidePrefix)
    return {}
  }
}

/**
Slidev → PPTX 変換パイプライン (並列実行モード)。
Phase 2+3 (旧 Python pptx-postprocess による merge) は cli 側で実施する。
そのため本実装は、常に Phase 1 (DOM → 単スライド PPTX) のみを実行する。
*/
export async function convertToPptx(
  config: Readonly<PipelineConfig>,
  deps: PipelineDependencies = {},
): Promise<PipelineResult> {
  const logger = deps.logger ?? createLogger(config.logLevel || 'normal', { stderr: process.stderr })
  const { templatePath, outputDir, slidePrefix, port, presDir } = config

  if (!isAbsolute(presDir)) {
    throw new Error(`presDir must be an absolute path. Got: ${presDir}`)
  }
  const totalStart = performance.now()

  // exportToPptx オプションは全スライドで同一。
  // ここで 1 度だけ解決し、変換 (slide-worker) と envHash (cache-store) の双方へ同じ値を渡す。
  // 片側だけ既定に戻ると、設定を変えたのにキャッシュがヒットする、変えていないのに全ミスする、という食い違いになる。
  const exportOptions: Readonly<ExportToPptxOptions> = config.exportOptions ?? defaultExportToPptxOptions

  const distDir = isAbsolute(templatePath) ? templatePath : join(presDir, templatePath)
  const outDir = isAbsolute(outputDir) ? outputDir : join(presDir, outputDir)
  const slidesDir = join(outDir, 'slides')

  logger.info('Slidev → PPTX変換パイプライン開始...')
  logger.verbose(`  テンプレート: ${distDir} | 出力先: ${outDir} | プレフィックス: ${slidePrefix} | 並列度: ${config.concurrency.toString()}`)

  await mkdir(outDir, { recursive: true })
  await rm(slidesDir, { recursive: true, force: true })
  await mkdir(slidesDir, { recursive: true })

  logger.info('=== Phase 1: DOM → PPTX変換 ===')

  // chromium.launch が失敗すると server だけが残る。
  // これを防ぐため、両者を 1 つの try-finally でくくる。
  // chromium.launch の失敗時は、利用者誘導メッセージで wrap する。
  throwIfAborted(deps.signal)
  const server = await (deps.createServer ?? startServer)(distDir, port, logger)
  // baseUrl は、要求ポートでなく実際に bind されたポートで組む。
  // port=0 (ephemeral、既定) では OS が空きポートを採番する。
  // そのため、並行する別プロセスの convert と衝突しない。
  const baseUrl = `http://${LOOPBACK_HOST}:${resolveBoundPort(server, port).toString()}`
  logger.info(`HTTPサーバー起動: ${baseUrl}`)
  let browser: Browser
  try {
    browser = await (deps.createBrowser ?? (() => chromium.launch({ headless: true })))()
  }
  catch (error: unknown) {
    server.close()
    throw chromiumLaunchError(errorMessage(error), error) ?? error
  }
  let slideCount = 0
  let cacheSummary: PipelineCacheSummary | undefined
  const timing = {
    total: 0,
    scan: 0,
    phase1: 0,
    phase2: 0,
    perSlide: {} as Record<string, number>,
    perSlidePhases: {} as Record<string, SlidePhases>,
  }
  let singlePassTiming: SinglePassTiming | undefined
  const errors: PipelineError[] = []
  const warnings: string[] = []

  // 途中で throw する run でも、それまでに積んだ警告を出力して引き継げるよう、ここで包む。
  try {
    try {
      throwIfAborted(deps.signal)
      const scanStart = performance.now()
      let steps: SlideStep[]
      // キャッシュは、デッキ全体を走査した run でのみ有効。
      // 部分実行の結果で判定や prune をすると、走査対象外のエントリを消してしまう。
      let isUsedFullScan = false
      // ルータ判定の結果。1 パス変換の print ルートの URL にも使う
      let routerUrlFormat: SlideUrlFormat | undefined

      // routerMode の判定。
      // hash ルータのデッキは、root を goto するとフラグメント付き (`#/1`) にリダイレクトされる。
      // history ルータでは付かない。
      // 以降の URL 組み立てと解析は、この判定に従う。
      // 誤ると、全ステップが slide 1 に潰れて上書きされる。
      //
      // リダイレクトはクライアントサイドルータが動いてから起きる。
      // そのため `load` だけでは、まだ root URL のままのことがある。
      // 判定の前に Slidev の描画完了を待ち、onlySteps / onlySlide / full scan のどれでも同じ readiness を担保する。
      const routerPage = await browser.newPage()
      try {
        await routerPage.setViewportSize(slideViewport)
        await routerPage.goto(baseUrl, { waitUntil: 'load' })
        await routerPage.waitForFunction(`(${slidevReadyFunctionSource})()`, { timeout: timeouts.slidevReady })
        const urlFormat: SlideUrlFormat = { hash: new URL(routerPage.url()).hash.startsWith('#/') }
        routerUrlFormat = urlFormat
        logger.info(`ルータ判定: router=${urlFormat.hash ? 'hash' : 'history'}`)

        if (config.onlySteps && config.onlySteps.length > 0) {
          steps = config.onlySteps.map(slideNumber => ({
            slideNumber,
            clickStep: null,
            url: buildSlideUrl(baseUrl, slideNumber, urlFormat),
          }))
          logger.info(`onlySteps指定: ${steps.length.toString()}ステップを変換 (slides=${config.onlySteps.join(',')})`)
        }
        else if (config.onlySlide) {
          if (config.onlySlide.click === null) {
            const scanPage = await browser.newPage()
            await scanPage.setViewportSize(slideViewport)
            steps = await buildOnlySteps(config.onlySlide, baseUrl, urlFormat, scanPage, logger)
            await scanPage.close()
          }
          else {
            steps = await buildOnlySteps(config.onlySlide, baseUrl, urlFormat)
          }
          logger.info(`--only指定: ${steps.length.toString()}ステップを変換`)
        }
        else {
          // 判定用の goto がそのまま全走査の起点になるため、ページを使い回す。
          const MAX_STEPS = 200
          steps = await scanSlideSteps(routerPage, MAX_STEPS, logger, deps.onProgress)
          isUsedFullScan = true
        }
      }
      finally {
        await routerPage.close()
      }

      timing.scan = performance.now() - scanStart
      logger.verbose(`スキャン時間: ${(timing.scan / 1000).toFixed(1)}s`)
      throwIfAborted(deps.signal)

      const phase1Start = performance.now()
      const libPath = deps.resolveDomToPptx
        ? deps.resolveDomToPptx()
        : (() => {
            // 依存ルート越しに解決する。
            // プラグイン配布では同梱の実体が、単体配布では `setup` が置いた永続層の実体が引かれる。
            const entry = resolveDependency('dom-to-pptx', import.meta.url)
            if (entry === undefined) {
              throw new Error(
                'dom-to-pptx.bundle.js が解決できません: dom-to-pptx パッケージが見つかりません\n'
                + `  ${DEPENDENCY_RECOVERY_HINT}`,
              )
            }
            const resolved = join(dirname(entry), 'dom-to-pptx.bundle.js')
            if (!existsSync(resolved)) {
              throw new Error(
                `dom-to-pptx.bundle.js が解決できません: ${resolved}\n  ${DEPENDENCY_RECOVERY_HINT}`,
              )
            }
            return resolved
          })()
      const workerConfig = { slidePrefix, libPath, exportOptions }
      const runSlide = deps.slideWorkerRunner ?? convertSingleSlideWithRetry

      const cacheDirectory = cacheDirectoryOf(outDir)
      const isCacheAttempted = config.cache !== undefined && isUsedFullScan
      const computeDeckCacheKeysImpl = deps.cacheStore?.computeDeckCacheKeys ?? computeDeckCacheKeys
      const materializeCacheEntryImpl = deps.cacheStore?.materializeCacheEntry ?? materializeCacheEntry
      const plans: StepPlan[] = steps.map(step => ({
        step,
        stepIndex: stepIndexOf(step),
        key: stepKeyOf(step),
        cache: 'miss',
        elapsed: 0,
      }))
      // ステップ単位の進み具合。
      // 1 パス変換から現行方式へ退避すると、同じステップが再び終わる。
      // そのため、終わった key の集合で数える。
      const doneKeys = new Set<string>()
      const stepDone = (key: string): void => {
        if (doneKeys.has(key)) return
        doneKeys.add(key)
        deps.onStepProgress?.(doneKeys.size, plans.length)
      }
      deps.onStepProgress?.(0, plans.length)
      let setup: CacheSetup | undefined
      let invalidated: CacheInvalidation = 'none'
      let isManifestWritable = false

      if (isCacheAttempted) {
        // キャッシュ由来の失敗で、変換自体を失敗させない (SC-004)。
        // cache-store は mkdir / readdir を try の外で呼ぶ。
        // ここで包まないと、ENOSPC 等が変換の失敗として伝播する。
        try {
          setup = await prepareCache(warnings, {
            presDir,
            libPath,
            chromiumVersion: browser.version(),
            pluginVersion: config.cache.pluginVersion,
            theme: config.cache.theme,
            exportOptions,
            // 1 パス変換と現行方式は、成果物が細部で異なり得る。そのため方式ごとに envHash を分ける。
            // 1 パス run 内で現行 worker に回したステップや、run 全体を退避した run も、1 パス側で保存される。
            route: config.singlePass === true ? 'single-pass' : 'per-step',
            skipRead: config.cache.skipRead === true,
            cacheDirectory,
            computeDeckCacheKeys: computeDeckCacheKeysImpl,
          })
          if (setup === undefined) {
            // キー算出失敗（computeDeckCacheKeys の ok:false）。
            // enabled: false は維持する。
            // #898 の --no-cache は、同じく enabled: false だが invalidated: 'none' になる。
            // JSON 上で区別できるよう、all:key を報告する。
            invalidated = 'all:key'
          }
          else {
            const decided = await decideSteps(
              plans,
              warnings,
              setup,
              {
                cacheDirectory,
                slidesDir,
                slidePrefix,
                materializeCacheEntry: materializeCacheEntryImpl,
                ...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
                onStepDone: stepDone,
              },
            )
            invalidated = decided.invalidated
            isManifestWritable = decided.manifestWritable
          }
        }
        catch (error) {
          warnings.push(`キャッシュを利用できないため全変換します: ${errorMessage(error)}`)
          setup = undefined
          for (const plan of plans) plan.cache = 'miss'
          // 例外による退避であることを all:error で報告する。
          // --no-cache（enabled: false / invalidated: 'none'）と、JSON 上で区別できるようにする。
          // catch に入る run では、all:key / decided.invalidated の代入が実行されない。
          // そのため、ここに来た時点の invalidated は常に 'none'。
          // 判定済みの種別を上書きして消す代入ではない。
          // manifest 破損など catch 前に分かった事実は、warnings 側に残る。
          invalidated = 'all:error'
        }
      }

      const missPlans = plans.filter(plan => plan.cache === 'miss')
      // 結果は runWithConcurrency の末尾でまとめて返る。そのため進捗は task 内で報告する。
      // 失敗 (リトライ尽き) も pipeline が前へ進んだ事実なので、catch で報告する。
      //
      // 先頭の throwIfAborted は、idle timeout 発火後もキューに残る task を、即座に reject させるためのもの。
      // 対象は実行開始前の task。
      // これが無いと、abort 後も runWithConcurrency の並列度上限に従って、残タスクが全件最後まで実行される (F-01)。
      // 既に実行中の task は対象外。Playwright 内部の完了待ちには手を出さない。
      const tasks = missPlans.map(plan =>
        async () => {
          if (deps.signal?.aborted === true) throw new Phase1TaskAbortedError()
          try {
            const result = await runSlide(browser, plan.step, workerConfig, slidesDir, logger)
            deps.onProgress?.(`スライド #${plan.key} 変換完了`)
            stepDone(plan.key)
            return result
          }
          catch (error) {
            deps.onProgress?.(`スライド #${plan.key} 変換失敗`)
            stepDone(plan.key)
            throw error
          }
        },
      )

      // 1 パス変換（#1141 / #1147）。使わない・使えない run は現行方式で変換する。
      const singlePass = await runSinglePassOrFallback({
        config,
        deps,
        browser,
        baseUrl,
        usedFullScan: isUsedFullScan,
        urlFormat: routerUrlFormat,
        plans,
        missPlans,
        workerConfig,
        runSlide,
        slidesDir,
        slidePrefix,
        logger,
        warnings,
        onStepDone: stepDone,
      })
      singlePassTiming = singlePass.timing
      const results = singlePass.results ?? await runWithConcurrency<SlideConvertResult>(tasks, config.concurrency)
      timing.phase1 = performance.now() - phase1Start
      logger.verbose(`Phase 1変換結果: ${results.filter(r => r.status === 'fulfilled').length.toString()}/${results.length.toString()} 成功`)

      const resultOf = new Map(missPlans.map((plan, index) => [plan, results[index]]))
      const allLetterSpacingMap: Record<string, { letterSpacing: string, fontSize: string }> = {}
      const allHrefMap: Record<string, string> = {}
      // p:timing を残すステップの stepIndex（#1070）。
      // 明示指定のアニメーションを持つスライドだけが載る。
      // cli 側の後処理は、ここに載らないスライドの p:timing を落とす。
      const keepTimingSteps: number[] = []
      const newEntries = new Map<number, SlideCacheEntry>()
      let successCount = 0
      // hit / miss を分けず、ステップ順で集約する。
      // letterSpacingMap はテキスト内容がキーで、後勝ちになる。
      // 順序が変わると、全変換時と勝者が入れ替わる (SC-003)。
      for (const plan of plans) {
        if (plan.cache === 'hit' && plan.materialized !== undefined) {
          Object.assign(allLetterSpacingMap, plan.materialized.letterSpacingMap)
          Object.assign(allHrefMap, plan.materialized.hrefMap)
          if (plan.materialized.hasExplicitAnimation) keepTimingSteps.push(plan.stepIndex)
          timing.perSlide[plan.key] = plan.elapsed
          successCount++
          if (plan.entry !== undefined) newEntries.set(plan.stepIndex, plan.entry)
          continue
        }

        const result = resultOf.get(plan)
        /* c8 ignore next -- miss の plan は missPlans に必ず含まれる。undefined は防御網 */
        if (result === undefined) continue
        if (result.status === 'fulfilled') {
          Object.assign(allLetterSpacingMap, result.value.letterSpacingMap)
          Object.assign(allHrefMap, result.value.hrefMap)
          if (result.value.hasExplicitAnimation) keepTimingSteps.push(plan.stepIndex)
          timing.perSlide[plan.key] = result.value.elapsed
          if (result.value.phases !== undefined) timing.perSlidePhases[plan.key] = result.value.phases
          successCount++

          for (const pr of result.value.prerenderResults) {
            if (!pr.success) {
              errors.push({ level: 'element', slideNumber: pr.slideNumber, selector: pr.selector, message: pr.error ?? 'unknown error' })
            }
          }

          // manifest を書かない run で保存しても、どのエントリからも参照されない成果物が cache/ に残るだけになる。
          // 未知ファイルの削除は v1 の責務外。
          if (setup !== undefined && isManifestWritable && plan.slideHash !== undefined) {
            // 並列タスク内ではなく、ここで直列に保存する (毎回 staging 全体を readdir するため)。
            try {
              const entry = await saveSlideToCache({
                cacheDirectory,
                slidesDirectory: slidesDir,
                stepIndex: plan.stepIndex,
                slidePrefix,
                slideHash: plan.slideHash,
                slideNumber: plan.step.slideNumber,
                clickStep: plan.step.clickStep,
                letterSpacingMap: result.value.letterSpacingMap,
                hrefMap: result.value.hrefMap,
                hasExplicitAnimation: result.value.hasExplicitAnimation,
              })
              if (entry !== undefined) newEntries.set(plan.stepIndex, entry)
            }
            catch (error) {
              warnings.push(`キャッシュへの保存に失敗しました (#${plan.key}): ${errorMessage(error)}`)
            }
            // 成否によらず、await 自体が idle timeout の計時対象になる時間を使う。そのためここで報告する。
            deps.onProgress?.(`キャッシュ保存 #${plan.key}`)
          }
        }
        else {
          // abort 起因でキューのまま reject した task (Phase1TaskAbortedError) は、runSlide を一度も呼んでいない。
          // そのため、通常の変換失敗として errors[] に積んだり、警告ログを出したりしない (F-01)。
          // この run は、後段の throwIfAborted(deps.signal) で最終的に PipelineRuntimeError として打ち切られる。
          if (!(result.reason instanceof Phase1TaskAbortedError)) {
            const message = errorMessage(result.reason)
            logger.warn(`スライド変換失敗: ${message}`)
            errors.push({ level: 'slide', slideNumber: plan.step.slideNumber, message })
          }
          // 変換に失敗した (または abort で未実行の) ステップは、新エントリを作らない。
          // 旧エントリは生存 stepIndex のため prune 対象外で、成果物も残っている。
          // 次回のヒット候補として引き継ぐ。
          if (setup?.reusable === true && setup.previous !== undefined) {
            const old = getCacheEntry(setup.previous, plan.stepIndex)
            if (old !== undefined) newEntries.set(plan.stepIndex, old)
          }
        }
      }

      slideCount = successCount

      if (setup !== undefined && isManifestWritable) {
        // prune と manifest 書き込みの区間は、複数の fs I/O を直列に伴う。そのため前後 1 回ずつ報告する。
        deps.onProgress?.('キャッシュ整理: prune/manifest 開始')
        try {
          const stepIndexes = plans.map(plan => plan.stepIndex)
          if (setup.previous !== undefined) {
            // 戻り値の prune 済み manifest は使わない。
            // 目的はファイル削除の副作用のみで、manifest は直後の writeCacheManifest が newEntries から組み直す。
            await pruneCache(cacheDirectory, setup.previous, { fullScan: true, stepIndexes })
            await removeUnreferencedArtifacts(cacheDirectory, setup.previous, stepIndexes, newEntries)
          }
          await writeCacheManifest(cacheDirectory, createCacheManifest(setup.keys.envHash, newEntries))
        }
        catch (error) {
          warnings.push(`キャッシュの更新に失敗しました: ${errorMessage(error)}`)
        }
        finally {
          deps.onProgress?.('キャッシュ整理: prune/manifest 完了')
        }
      }

      if (isCacheAttempted) {
        const hits = plans.filter(plan => plan.cache === 'hit').length
        cacheSummary = {
          // `--no-cache` は保存側が動いていても「今回キャッシュを使っていない」と報告する。
          enabled: setup !== undefined && !setup.skipRead,
          hits,
          misses: plans.length - hits,
          invalidated,
          perStep: plans.map(plan => ({ stepIndex: plan.stepIndex, key: plan.key, cache: plan.cache })),
        }
        logger.verbose(`キャッシュ: ${hits.toString()} hit / ${(plans.length - hits).toString()} miss (invalidated: ${invalidated})`)
        // hit したステップは prerender / worker を再実行しない。そのため要素エラーが再検出されない。
        // 何も出さないと、再実行のたびに「エラー・警告なし」と誤認させる。1 行で明示する。
        if (hits > 0) {
          warnings.push(`${hits.toString()}ステップはキャッシュ再利用のため要素診断を再実行していません`)
        }
      }

      const letterSpacingPath = join(slidesDir, 'letter-spacing.json')
      await writeFile(letterSpacingPath, JSON.stringify(allLetterSpacingMap, null, 2))
      logger.verbose(`letter-spacing.json: ${Object.keys(allLetterSpacingMap).length.toString()}エントリ`)

      const hrefMapPath = join(slidesDir, 'href-map.json')
      await writeFile(hrefMapPath, JSON.stringify(allHrefMap, null, 2))
      logger.verbose(`href-map.json: ${Object.keys(allHrefMap).length.toString()}エントリ`)

      // #1070: p:timing を残すステップだけを cli 側へ渡す。
      // ここに載らないスライドは、後処理で p:timing を落とし、装飾 CSS animation 由来のクリック待ちを消す。
      // 「残す側」を列挙するのは、ファイルが読めなかったときの既定を「全除去」にするため。
      // 「全保持」を既定にすると、読めなかった run が #1062 の状態へ戻り、気づけない。
      // letter-spacing.json / href-map.json と同じく、0 件でも毎回書き出す。
      // 前回 run の staging が残っている場合に、古い内容を読ませないため。
      // schemaVersion は、読み手（cli 側 convert）が想定外の形を拒否するための版宣言。
      // 同一 run 内で書いて読む。
      // ただし letter-spacing.json / href-map.json と違い、中身が「残す側の列挙」という反転した意味を持つ。
      // そのため、形の取り違えを通さない。
      const animationPolicyPath = join(slidesDir, 'animation-policy.json')
      await writeFile(
        animationPolicyPath,
        JSON.stringify({
          schemaVersion: ANIMATION_POLICY_SCHEMA_VERSION,
          keepTimingSteps: keepTimingSteps.toSorted((a, b) => a - b),
        }, null, 2),
      )
      logger.verbose(`animation-policy.json: timing を残すステップ ${keepTimingSteps.length.toString()}件`)

      logger.info(`\nPhase 1完了: ${slideCount.toString()}枚のPPTX生成 → slides/`)
    }
    finally {
      await browser.close()
      server.close()
    }

    // Phase 2+3 は cli 側 (domain/pptx-ooxml/merge.ts + post-process.ts) に委譲する。
    // そのため本パイプラインでは、常に skip 相当で動作する。
    // `slidesDirectory` には slides/ パスを返す。
    // 旧来の title-derived 候補名は実体ファイルではないため、本フィールドには載せない。
    throwIfAborted(deps.signal)
    const phase2Start = performance.now()
    // title は log には残す (debug 目的)
    const title = await readSlidesTitle(distDir, logger)
    if (title) {
      logger.verbose(`Phase 2 候補出力名 (debug, cli 側 merge では使用しない): ${sanitizeFilename(title)}.pptx`)
    }

    logger.info('\nPhase 2+3 を skip: slides/<prefix><N>.pptx のみ生成')

    timing.phase2 = performance.now() - phase2Start
    timing.total = performance.now() - totalStart

    const hasSlideFailures = errors.some(e => e.level === 'slide')

    logger.info('\n=== タイミングサマリー ===')
    logger.info(`スキャン: ${(timing.scan / 1000).toFixed(1)}s`)
    logger.info(`Phase 1 (DOM→PPTX): ${(timing.phase1 / 1000).toFixed(1)}s (並列度: ${config.concurrency.toString()})`)
    logger.info(`合計: ${(timing.total / 1000).toFixed(1)}s`)
    const perSlideEntries = Object.entries(timing.perSlide)
    if (perSlideEntries.length > 0) {
      const perSlideString = perSlideEntries.map(([k, v]) => `#${k}: ${(v / 1000).toFixed(1)}s`).join(', ')
      logger.verbose(`スライドごと: ${perSlideString}`)
    }

    logger.info('\n=== 変換結果サマリー ===')
    logger.info(`成功: ${slideCount.toString()}スライド`)
    emitErrorSummary(logger, errors)
    emitWarningSummary(logger, warnings)
    if (errors.length === 0 && warnings.length === 0) {
      logger.info('エラー・警告なし')
    }

    return {
      success: !hasSlideFailures,
      slideCount,
      slidesDirectory: slidesDir,
      errors,
      warnings,
      timing: {
        ...timing,
        ...(singlePassTiming !== undefined && { singlePass: singlePassTiming }),
      },
      ...(cacheSummary !== undefined && { cache: cacheSummary }),
    }
  }
  catch (error) {
    // 変換が失敗しても、それまでに積んだエラー・警告は、「一度だけ」の一元出力を維持したまま stderr に残す。
    // 加えて PipelineRuntimeError に載せ、commands 層の --json 出力へ引き継ぐ。
    // 成功した場合とは排他のため、順序を揃えておけば重複出力は起きない。
    //
    // この run は `=== 変換結果サマリー ===` まで到達していない。
    // そのため、内訳だけが見出しなしで現れる。
    // 読み手が直前の進捗ログと区別できるよう、内訳があるときだけ見出しを添える。
    // emitErrorSummary 内に置くと、成功した場合に見出しが二重になる。
    if (errors.length > 0) logger.info('\n=== 変換エラー ===')
    emitErrorSummary(logger, errors)
    emitWarningSummary(logger, warnings)
    throw new PipelineRuntimeError(errorMessage(error), { cause: error, warnings, errors })
  }
}
/* eslint-enable unicorn/name-replacements, unicorn/import-style, unicorn/no-null */
/* eslint-enable no-useless-assignment, no-restricted-syntax */
/* eslint-enable security/detect-non-literal-fs-filename, security/detect-object-injection */
