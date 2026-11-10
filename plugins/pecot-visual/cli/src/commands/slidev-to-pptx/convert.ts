// Phase 2 の `pecotv slide convert` 実装。
// Slidev プロジェクトディレクトリを `npx slidev build` でビルドする。
// in-process pipeline で、単スライド PPTX 群 (slides/<prefix><N>.pptx) を取得する。
// pipeline の実装は `infra/slidev-to-pptx/InProcessSlidevPptxPipeline`。
// cli 側の純粋ロジック `domain/pptx-ooxml/merge.ts` で結合して --out に書き出す。
// SlidevRunner / SlidevPptxPipeline は port 経由で DI される (tech-advisor B1)。

// 出力 path / 中間 mkdir 先は CLI 引数由来で、リテラルではない。
// 本コマンド自身が出力ディレクトリを生成する責務を持つ。
// そのため本ファイル全体で security/detect-non-literal-fs-filename を disable する。
/* eslint-disable security/detect-non-literal-fs-filename */
import { performance } from 'node:perf_hooks'
import { access, readFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { Command, Option } from 'commander'

import type {
  PptxArchive,
  SlidevPptxPipeline,
  SlidevRunner,
  XmlEngine,
} from '../../domain/_shared/ports.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import {
  PipelineRuntimeError,
  PipelineTimeoutError,
} from '../../domain/slidev-to-pptx/errors.js'
import {
  ANIMATION_POLICY_SCHEMA_VERSION,
  DEFAULT_SLIDE_PREFIX,
  parseSlideFilename,
} from '../../domain/slidev-to-pptx/config.js'
import type { PipelineCacheSummary, PipelineError, PipelineTiming } from '../../domain/slidev-to-pptx/types.js'
import { mergePptxFiles, type MergeInput } from '../../domain/pptx-ooxml/merge.js'
import {
  applyHyperlinkFix,
  applyJapaneseFontFix,
  applyTransition,
  removeAnimationTiming,
  sanitizeCssOnlyTypefaces,
  type LetterSpacingEntry,
} from '../../domain/pptx-ooxml/post-process.js'
import {
  applyPrerenderImageReplace,
  findPrerenderImages,
} from '../../domain/pptx-ooxml/prerender-replace.js'
import type { FontPolicy } from '../../domain/pptx-ooxml/font-policy.js'
import { readThemeDeclaration } from '../../domain/slidev-theme/declaration.js'
import type { ResolvedThemeDeclaration, ThemeDeclarationResult } from '../../domain/slidev-theme/declaration.js'
import { sanitizeFilename } from '../../domain/slidev-to-pptx/slides-title.js'
import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import { readSlidesTitleFromFile } from '../../infra/slidev-to-pptx/slides-title-reader.js'
import { ChildProcessSlidevRunner } from '../../infra/slidev-to-pptx/runner.js'
import { InProcessSlidevPptxPipeline } from '../../infra/slidev-to-pptx/index.js'
import { XmldomXmlEngine } from '../../infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../infra/pptx-ooxml/archive.js'
import { pluginDependencyRoot } from '../../infra/_shared/dependency-root.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { readVersion } from '../../version.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from '../slidev-project/linked-theme.js'
import type { ThemeLinkContext } from '../slidev-project/linked-theme.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import { SlideCreateRuntimeError } from '../../domain/slidev-project/errors.js'
import { EAST_ASIAN_FONT_OMITTED_WARNING, LINK_COLOR_OMITTED_WARNING } from '../../domain/slidev-project/warnings.js'
import { NS_PACKAGE_RELATIONSHIPS } from '../../domain/_shared/ooxml-uris.js'

type TransitionType = 'fade' | 'morph'
type MorphOption = 'byObject' | 'byWord' | 'byChar'

const TRANSITION_TYPES: readonly TransitionType[] = ['fade', 'morph']
const MORPH_OPTIONS: readonly MorphOption[] = ['byObject', 'byWord', 'byChar']

export interface SlideConvertOptions {
  readonly out: string
  readonly theme?: string
  readonly json?: boolean
  /**
  差分キャッシュを読むか。commander の `--no-cache` は既定 true / 指定時 false を入れる。
  省略時は true 相当（キャッシュ利用）。false でも変換完了時のキャッシュ再構築は行う。
  */
  readonly cache?: boolean
  /**
  1 パスのルートを使うか。commander の `--no-single-pass` は既定 true / 指定時 false を入れる。
  false のときだけ現行ルートを強制し、それ以外は env `PECOTV_SINGLE_PASS` に従う（既定 on）。
  */
  readonly singlePass?: boolean
  readonly spacingJson?: string
  readonly hrefJson?: string
  readonly transitionType?: TransitionType
  readonly transitionDurationMs?: number
  readonly morphOption?: MorphOption
  /**
  進捗の詳しさ。省略時は infra の既定 (normal)。verbose・debug は進捗を stderr に note: で出す
  */
  readonly logLevel?: 'normal' | 'verbose' | 'debug'
}

interface ChainOptions {
  readonly fontPolicy: FontPolicy
  readonly spacingMap: ReadonlyMap<string, LetterSpacingEntry>
  readonly hrefMap: ReadonlyMap<string, string>
  /**
  `p:timing` を残す stepIndex の集合（#1070）。ここに載らないスライドは後処理で
  `p:timing` を落とし、装飾 CSS animation 由来のクリック待ちを消す。
  */
  readonly keepTimingSteps: ReadonlySet<number>
  readonly transitionType: TransitionType
  readonly transitionDurationMs: number
  readonly morphOption?: MorphOption
}

export interface SlideConvertDependencies {
  readonly slidevRunner: SlidevRunner
  readonly pptxConverter: SlidevPptxPipeline
  readonly archive: PptxArchive
  readonly engine: XmlEngine
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly now: () => number
  /**
  差分キャッシュの envHash 材料になるプラグイン版数。plugin.json 由来の実値を注入することで、
  テストからは固定値を渡してキャッシュ判定を版数非依存にできる。
  */
  readonly pluginVersion: () => string
  /**
  テーマが node_modules に今の値で張られていることを保証する port。変換の冒頭で呼ぶ。
  失敗（取得・宣言・指定・未参照）はそのまま投げる。古い node_modules で変換を続けない。
  */
  readonly ensureThemeLinked: (
    talkDirectory: string,
    // context に AbortSignal を持つため readonly にできない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    context: ThemeLinkContext,
  ) => Promise<{ readonly theme: { readonly directory: string } | undefined }>
  /**
  テーマの宣言（pecot-theme.json）を読む port。PPTX の書体とリンク色を取る。
  */
  readonly readThemeDeclaration: (themeDirectory: string) => Promise<ThemeDeclarationResult>
  /**
  工程と進み具合を利用者向けの一文で受け取る (省略可)。MCP の slide_convert が progress 通知の
  文言に流す。変換工程はステップ単位の件数と割合を載せる。
  */
  readonly onProgress?: (message: string) => void
  /**
  abort すると slidev build と pipeline を止め、PPTX を書き出さずに失敗する（MCP のキャンセル）。
  */
  readonly signal?: AbortSignal
}

/**
変換工程の進捗文言。割合は切り捨て (完了前に 100% と出さない)。
*/
export function formatConvertProgress(completed: number, total: number): string {
  const percent = total === 0 ? 0 : Math.floor((completed / total) * 100)
  return `converting ${String(completed)}/${String(total)} (${String(percent)}%)`
}

export interface SlideConvertResultSummary {
  readonly inputAbs: string
  readonly outputAbs: string
  readonly durationMs: number
  /**
  Phase 1 pipeline timing (in-process pipeline 経由で取得)。test fake では undefined になり得る。
  */
  readonly pipelineTiming?: Readonly<PipelineTiming>
  /**
  コマンド全体の区間別所要（ms）。pipeline の外側（build と merge）を含む
  */
  readonly outerTiming: OuterTiming
  /**
  差分キャッシュの判定結果。キャッシュを扱わなかった run / test fake では undefined。
  */
  readonly cache?: PipelineCacheSummary
  /**
  pipeline が積んだ警告（manifest 破損・キャッシュ再利用による要素診断のスキップ等）。
  警告なしの run では空配列。`--json` の done payload へ常時載せる（#929）。
  */
  readonly warnings: readonly string[]
  /**
  pipeline が積んだ変換エラー（スライド単位・要素単位）。warnings と同型で、
  エラーなしの run では空配列。`--json` の done payload へ常時載せる（#949）。
  level=element のエラーは success を落とさないため、成功完走した run にも載る。
  キャッシュヒットしたステップの要素診断は再実行されないため、`errors: []` は
  デッキに要素エラーが無いことを意味しない（その旨は pipeline の警告として
  warnings 側に出る）。
  */
  readonly errors: readonly PipelineError[]
  /**
  装飾 CSS animation 由来の `p:timing` を落としたスライド数（#1070）。明示指定のある
  スライドと、元から `p:timing` を持たないスライドは数えない。
  件数が 0 でも `--json` の done payload へ常時載せる。
  warnings / errors と同じ理由で、tooling 側が「フィールドが無い＝旧版」と「除去なしの run」を区別できるようにする。
  */
  readonly animationTimingRemovedSlides: number
}

/**
`slide convert` の区間別所要（ms）。`--json` の `timings.outer` に載る。
*/
export interface OuterTiming {
  readonly cleanBuild: number
  readonly slidevBuild: number
  readonly pipeline: number
  readonly mergeAndPostprocess: number
}

export class SlideConvertUsageError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'SlideConvertUsageError'
  }
}

export class SlideConvertRuntimeError extends Error {
  /**
  pipeline が積んだ警告。throw の時点では未取得なこともあるため後付けで代入する
  （新インスタンスに作り直すと、実際に失敗した位置の stack を失う）。
  */
  warnings?: readonly string[]

  /**
  pipeline が積んだ変換エラー（スライド単位・要素単位）。warnings と同じく後付けで代入する。
  */
  pipelineErrors?: readonly PipelineError[]

  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'SlideConvertRuntimeError'
  }
}

// slidev build は子プロセスで進捗を観測できないため合計時間で打ち切る。harness 側 (e2e の
// spawnSync timeout / vitest testTimeout) はこの値以上に設定する。
// 階層: vitest.testTimeout ≥ spawnSync timeout ≥ SLIDEV_BUILD_TIMEOUT_MS。詳細は
// vitest.e2e.config.ts / tests/e2e/golden-path-create-convert.test.ts のコメント参照 (#506)。
const SLIDEV_BUILD_TIMEOUT_MS = 600_000
// pptx convert (in-process pipeline) は「進捗が無い時間」で打ち切る (#1097)。合計時間の上限は
// 持たないため、スライド枚数が多いだけの正常な変換は打ち切られない。
// 1 操作のハングは pipeline 内部の操作別 timeout (domain/slidev-to-pptx/config.ts) が先に検出する。
// この値は pipeline 全体が進まなくなった場合の最終防波堤。
const PPTX_CONVERT_IDLE_TIMEOUT_MS = 600_000
const THEME_PATTERN = /^[\w@/.-]+$/

export function validateTheme(theme: string): void {
  if (!THEME_PATTERN.test(theme)) {
    throw new SlideConvertUsageError(
      `--theme accepts only [a-zA-Z0-9@/_.-]: ${theme}`,
      'invalid-theme',
    )
  }
}

/**
キャンセル済みなら、以降の工程（pipeline・PPTX の書き出し）へ進まず失敗にする。
*/
function throwIfCancelled(signal: Readonly<AbortSignal> | undefined): void {
  if (signal?.aborted === true) {
    throw new SlideConvertRuntimeError('cancelled', 'cancelled')
  }
}

async function ensureProjectDirectory(projectDirectory: string): Promise<void> {
  let stats
  try {
    stats = await stat(projectDirectory)
  }
  catch {
    throw new SlideConvertRuntimeError(
      `directory not found: ${projectDirectory}`,
      'project-not-found',
    )
  }
  if (!stats.isDirectory()) {
    throw new SlideConvertRuntimeError(
      `not a directory: ${projectDirectory}`,
      'project-not-found',
    )
  }
  const slidesMd = path.join(projectDirectory, 'slides.md')
  try {
    await stat(slidesMd)
  }
  catch {
    throw new SlideConvertRuntimeError(
      `slides.md not found: ${slidesMd}`,
      'project-not-found',
    )
  }
}

async function cleanBuildArtifacts(projectDirectory: string): Promise<void> {
  await rm(path.join(projectDirectory, 'dist'), { recursive: true, force: true })
  await rm(path.join(projectDirectory, 'index.html'), { force: true })
}

function formatStderrTail(stderr: string): string {
  // 末尾 1KB を抜き出す (tech-advisor B2 reason `*-failed` 時のみ detail に含める)
  return stderr.length <= 1024 ? stderr : stderr.slice(-1024)
}

function didExitNonZero(result: Readonly<SpawnResult>): boolean {
  return result.exitCode !== 0
}

function formatPipelineErrors(errors: readonly PipelineError[]): string {
  /* c8 ignore next -- pipelineResult.success が false のルートは、呼び出し側で errors が 1 件以上と保証される。防御網。 */
  if (errors.length === 0) return '(no error detail)'
  const head = errors.slice(0, 3).map((entry) => {
    const slidePart = entry.slideNumber === undefined ? '' : ` slide=${String(entry.slideNumber)}`
    return `[${entry.level}]${slidePart} ${entry.message}`
  })
  const prefix = errors.length > head.length ? `(showing first ${String(head.length)} of ${String(errors.length)}) ` : ''
  return `${prefix}${head.join(' / ')}`
}

/**
宣言の `pptx` から PPTX の後処理に渡す値を組む。省いた項目は渡さない（書体を書かない、リンクを変換しない）。
*/
function fontPolicyOf(pptx: Readonly<ResolvedThemeDeclaration['pptx']>): FontPolicy {
  return {
    ...(pptx.eastAsianFont !== undefined && { ea: pptx.eastAsianFont }),
    ...(pptx.linkColor !== undefined && { linkColor: pptx.linkColor }),
  }
}

/**
テーマを今の値で張り、宣言の PPTX の値から後処理に渡す書体とリンク色を得る。
*/
async function resolveFontPolicy(
  projectAbs: string,
  // port メソッドが mutable と判定されるため interface readonly fields で担保。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideConvertDependencies,
): Promise<FontPolicy> {
  const diagnostics = createDiagnostics(dependencies.stderr)
  const { theme } = await dependencies.ensureThemeLinked(projectAbs, {
    signal: dependencies.signal,
    warn: (message) => { diagnostics.warning(message) },
  })
  if (theme === undefined) return {}
  const { declaration, warnings } = await dependencies.readThemeDeclaration(theme.directory)
  for (const warning of warnings) diagnostics.warning(warning)
  // 書体とリンク色を宣言から取るため、省いた deck は書き込みが無くなる。変化に気付けるよう知らせる。
  if (declaration.pptx.linkColor === undefined) diagnostics.warning(LINK_COLOR_OMITTED_WARNING)
  if (declaration.pptx.eastAsianFont === undefined) diagnostics.warning(EAST_ASIAN_FONT_OMITTED_WARNING)
  return fontPolicyOf(declaration.pptx)
}

export async function runSlideConvert(
  projectDirectory: string,
  options: Readonly<SlideConvertOptions>,
  // port メソッドが mutable と判定されるため interface readonly fields で担保。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideConvertDependencies,
): Promise<SlideConvertResultSummary> {
  if (options.theme !== undefined) {
    validateTheme(options.theme)
  }

  // キャンセル済みなら、dist / index.html の削除などの前処理にも入らない。
  throwIfCancelled(dependencies.signal)

  const projectAbs = path.resolve(projectDirectory)
  const outputAbs = path.resolve(options.out)
  await ensureProjectDirectory(projectAbs)

  // テーマを今の値で張ってから、宣言の PPTX の値を取る。以降の build はこの node_modules で動く。
  const fontPolicy = await resolveFontPolicy(projectAbs, dependencies)

  // 出力 PPTX 配置先 (--out) のディレクトリは存在保証する。in-process pipeline は
  // outputDir 配下の slides/<prefix><N>.pptx 群を生成するため、cli 側で merge して outputAbs に書き出す。
  await mkdir(path.dirname(outputAbs), { recursive: true })

  const start = dependencies.now()

  await cleanBuildArtifacts(projectAbs)
  const cleanBuildMs = dependencies.now() - start

  // capture/relay 切替: slidev build 子プロセスの stdout/stderr は --json 時に破棄する
  // (tech-advisor B2)。--json でないときは、どちらも stderr へ中継する (stdout はデータだけ)。
  // in-process pipeline の人間可読ログは、常に stderr の診断行 (note / warning / error) で出る。
  const isRelayEnabled = options.json !== true
  const buildOptions: {
    theme?: string
    timeoutMs: number
    stdout?: NodeJS.WritableStream
    stderr?: NodeJS.WritableStream
    signal?: AbortSignal
  } = { timeoutMs: SLIDEV_BUILD_TIMEOUT_MS }
  if (options.theme !== undefined) buildOptions.theme = options.theme
  if (dependencies.signal !== undefined) buildOptions.signal = dependencies.signal
  if (isRelayEnabled) {
    buildOptions.stdout = dependencies.stderr
    buildOptions.stderr = dependencies.stderr
  }
  const buildStart = dependencies.now()
  dependencies.onProgress?.('running slidev build')
  const buildResult = await dependencies.slidevRunner.build(projectAbs, buildOptions)
  const slidevBuildMs = dependencies.now() - buildStart
  throwIfCancelled(dependencies.signal)
  if (buildResult.timedOut) {
    throw new SlideConvertRuntimeError(
      `slidev build timed out after ${String(SLIDEV_BUILD_TIMEOUT_MS)}ms: ${formatStderrTail(buildResult.stderr)}`,
      'slidev-build-timeout',
    )
  }
  if (didExitNonZero(buildResult)) {
    throw new SlideConvertRuntimeError(
      `slidev build failed (exit ${String(buildResult.exitCode)}): ${formatStderrTail(buildResult.stderr)}`,
      'slidev-build-failed',
    )
  }

  // in-process pipeline は skipPostprocess 指定時、staging/slides/<prefix><N>.pptx のみを出力する。
  // Phase 2+3 は skip する。
  // 本コマンドは TS 側で merge を行う。
  // そのため staging ディレクトリを作って単スライド PPTX を受け取り、--out に書き出す。
  const stagingDirectory = path.join(projectAbs, 'pptx')
  await mkdir(stagingDirectory, { recursive: true })

  const convertOptions: {
    presDirectory: string
    targetDirectory: string
    outputDirectory: string
    idleTimeoutMs: number
    skipPostprocess: boolean
    cachePluginVersion: string
    cacheSkipRead: boolean
    logLevel?: string
    singlePass?: false
    theme?: string
    signal?: AbortSignal
    stderr?: NodeJS.WritableStream
    onStepProgress?: (completed: number, total: number) => void
  } = {
    presDirectory: projectAbs,
    targetDirectory: path.join(projectAbs, 'dist'),
    outputDirectory: stagingDirectory,
    idleTimeoutMs: PPTX_CONVERT_IDLE_TIMEOUT_MS,
    skipPostprocess: true,
    // 差分キャッシュは標準で有効。読み書き先は staging 配下の pptx/cache/。
    cachePluginVersion: dependencies.pluginVersion(),
    // --no-cache は読み取りだけを止める。保存は動くので次回以降は再びヒットする。
    cacheSkipRead: options.cache === false,
  }
  // --theme は envHash の材料にもなる (F-01)。テーマ切替後に旧描画のキャッシュが
  // 通知なしにヒットしないよう、slidev build に渡した値をそのまま pptxConverter にも渡す。
  if (options.theme !== undefined) convertOptions.theme = options.theme
  if (options.logLevel !== undefined) convertOptions.logLevel = options.logLevel
  if (dependencies.signal !== undefined) convertOptions.signal = dependencies.signal
  // --no-single-pass は現行ルートを強制する。未指定はキーを置かず、pipeline 側が env に従う。
  if (options.singlePass === false) convertOptions.singlePass = false
  convertOptions.stderr = dependencies.stderr
  const report = dependencies.onProgress
  if (report !== undefined) {
    convertOptions.onStepProgress = (completed, total) => {
      report(formatConvertProgress(completed, total))
    }
  }
  // スキャンが終わるまでステップ総数は決まらないため、それまでは工程名だけを出す。
  report?.('scanning slides')
  let pipelineResult
  const pipelineStart = dependencies.now()
  try {
    pipelineResult = await dependencies.pptxConverter.convert(convertOptions)
  }
  catch (error: unknown) {
    throwIfCancelled(dependencies.signal)
    if (error instanceof PipelineTimeoutError) {
      throw withPipelineDiagnostics(
        new SlideConvertRuntimeError(
          `pptx convert timed out: ${error.message}`,
          'pptx-convert-timeout',
        ),
        { warnings: error.warnings, errors: error.errors },
      )
    }
    // InProcessSlidevPptxPipeline.convert() が throw するのは、PipelineTimeoutError か PipelineRuntimeError のみ。
    // これは二重 wrap 防止と、内部例外の wrap 済を前提にした契約。
    // それ以外のルートは無いため、ここでは PipelineRuntimeError として処理する。
    if (error instanceof PipelineRuntimeError) {
      throw withPipelineDiagnostics(
        new SlideConvertRuntimeError(
          `pptx convert failed: ${error.message}`,
          'pptx-convert-failed',
        ),
        { warnings: error.warnings, errors: error.errors },
      )
    }
    /* c8 ignore start -- defensive: SlidevPptxPipeline 契約上、上 2 例外型以外は到達不能。test fake が直 throw した場合の最終 net。 */
    throw new SlideConvertRuntimeError(
      `pptx convert failed: ${formatError(error)}`,
      'pptx-convert-failed',
    )
    /* c8 ignore stop */
  }
  // pipeline がキャンセルに間に合わず完走した場合も、PPTX は書き出さない。
  throwIfCancelled(dependencies.signal)
  const mergeStart = dependencies.now()
  const pipelineMs = mergeStart - pipelineStart
  report?.('merging PPTX')
  // pipeline が完走している以降の失敗でも、pipeline が積んだ警告・エラーは失われないよう
  // catch で error へ引き継ぐ。
  try {
    if (!pipelineResult.success) {
      throw new SlideConvertRuntimeError(
        `pptx convert failed: ${formatPipelineErrors(pipelineResult.errors)}`,
        'pptx-convert-failed',
      )
    }

    // staging/slides/<prefix><N>.pptx 群を読み込み、TS 側 merge ロジックで結合する。
    // staging から letter-spacing.json / href-map.json を auto-detect (priority: flag > staging > empty)。
    const slidesDirectory = path.join(stagingDirectory, 'slides')
    const spacingMap = await resolveLetterSpacingMap(
      options.spacingJson,
      path.join(slidesDirectory, 'letter-spacing.json'),
    )
    const hrefMap = await resolveHrefMap(
      options.hrefJson,
      path.join(slidesDirectory, 'href-map.json'),
    )
    const keepTimingSteps = await resolveKeepTimingSteps(
      path.join(slidesDirectory, 'animation-policy.json'),
    )

    const chainOptions: ChainOptions = {
      fontPolicy,
      spacingMap,
      hrefMap,
      keepTimingSteps,
      transitionType: options.transitionType ?? 'fade',
      transitionDurationMs: options.transitionDurationMs ?? 500,
      ...(options.morphOption !== undefined && { morphOption: options.morphOption }),
    }

    // staging の json 読み込み中にキャンセルされた場合も、結合と PPTX の書き出しへ進まない。
    throwIfCancelled(dependencies.signal)
    const merge = await mergeSingleSlidePptxesTo(stagingDirectory, outputAbs, chainOptions, dependencies)

    const end = dependencies.now()
    const durationMs = end - start
    const summary: SlideConvertResultSummary = {
      inputAbs: projectAbs,
      outputAbs,
      durationMs,
      pipelineTiming: pipelineResult.timing,
      outerTiming: {
        cleanBuild: cleanBuildMs,
        slidevBuild: slidevBuildMs,
        pipeline: pipelineMs,
        mergeAndPostprocess: end - mergeStart,
      },
      warnings: [...pipelineResult.warnings, ...merge.warnings],
      errors: pipelineResult.errors,
      animationTimingRemovedSlides: merge.animationTimingRemovedSlides,
      ...(pipelineResult.cache !== undefined && { cache: pipelineResult.cache }),
    }
    return summary
  }
  catch (error: unknown) {
    // merge / 出力書き出しは生の Error（例: --out がディレクトリのときの EISDIR）を投げる。
    // wrap しないと reason が unknown になり、利用者が原因を特定できない。
    const converted = error instanceof SlideConvertRuntimeError
      ? error
      : new SlideConvertRuntimeError(
          `PPTX generation failed: ${formatError(error)}`,
          'merge-failed',
        )
    throw withPipelineDiagnostics(converted, {
      warnings: pipelineResult.warnings,
      errors: pipelineResult.errors,
    })
  }
}

/**
pipeline 由来の警告・エラーを error に載せる。undefined（pipeline 未到達）の側は何もしない。
*/
function withPipelineDiagnostics(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 診断情報を後付け代入する対象
  error: SlideConvertRuntimeError,
  diagnostics: Readonly<{
    warnings: readonly string[] | undefined
    errors: readonly PipelineError[] | undefined
  }>,
): SlideConvertRuntimeError {
  if (diagnostics.warnings !== undefined) error.warnings = diagnostics.warnings
  if (diagnostics.errors !== undefined) error.pipelineErrors = diagnostics.errors
  return error
}

/**
`--json` の error payload に載せる警告。pipeline 未到達の失敗では空配列。
*/
function warningsOf(error: unknown): readonly string[] {
  return (error instanceof SlideConvertRuntimeError) ? error.warnings ?? [] : []
}

/**
`--json` の error payload に載せる変換エラー。pipeline 未到達の失敗では空配列。
*/
function pipelineErrorsOf(error: unknown): readonly PipelineError[] {
  return (error instanceof SlideConvertRuntimeError) ? error.pipelineErrors ?? [] : []
}

/**
sidecar JSON を読んで plain object として返す。読み取り失敗・parse 失敗・plain object
でない場合は `invalid-staging-json` で throw する。

`label` はエラー文言に出す sidecar 名（`letter-spacing JSON` / `href JSON` 等）。3 つの
sidecar は形が違うだけで読み方は同じなので、骨格をここに置き、各 resolver は固有の形の
検証だけを持つ。文言から sidecar 名が落ちると利用者がどのファイルを直せばよいか分からない。
*/
async function readSidecarObject(
  sourcePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(sourcePath, 'utf8')
  }
  catch (error: unknown) {
    throw new SlideConvertRuntimeError(
      `cannot read ${label}: ${sourcePath}: ${formatError(error)}`,
      'invalid-staging-json',
    )
  }
  let raw: unknown
  try {
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻り値を unknown として narrowing
    raw = JSON.parse(text) as unknown
  }
  catch (error: unknown) {
    throw new SlideConvertRuntimeError(
      `cannot parse ${label}: ${sourcePath}: ${formatError(error)}`,
      'invalid-staging-json',
    )
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SlideConvertRuntimeError(
      `${label} must be a plain object: ${sourcePath}`,
      'invalid-staging-json',
    )
  }
  // eslint-disable-next-line no-restricted-syntax -- 直前の type guard 後の narrowing
  return raw as Record<string, unknown>
}

/**
staging または CLI flag から letter-spacing.json を読み込んで Map 化する。
priority: `flag > staging > empty`。
*/
async function resolveLetterSpacingMap(
  flagPath: string | undefined,
  stagingPath: string,
): Promise<ReadonlyMap<string, LetterSpacingEntry>> {
  const sourcePath = await resolveJsonSource(flagPath, stagingPath)
  if (sourcePath === undefined) return new Map()
  const raw = await readSidecarObject(sourcePath, 'letter-spacing JSON')
  const map = new Map<string, LetterSpacingEntry>()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SlideConvertRuntimeError(
        `letter-spacing JSON entry must be an object: ${key}`,
        'invalid-staging-json',
      )
    }
    // eslint-disable-next-line no-restricted-syntax -- entry value narrowing
    const entry = value as Record<string, unknown>
    const letterSpacing = entry['letterSpacing']
    const fontSize = entry['fontSize']
    if (typeof letterSpacing !== 'string' || typeof fontSize !== 'string') {
      throw new SlideConvertRuntimeError(
        `letter-spacing JSON entry must be { letterSpacing: string, fontSize: string }: ${key}`,
        'invalid-staging-json',
      )
    }
    map.set(key, { letterSpacing, fontSize })
  }
  return map
}

/**
staging または CLI flag から href-map.json を読み込んで Map 化する。
priority: `flag > staging > empty`。
*/
async function resolveHrefMap(
  flagPath: string | undefined,
  stagingPath: string,
): Promise<ReadonlyMap<string, string>> {
  const sourcePath = await resolveJsonSource(flagPath, stagingPath)
  if (sourcePath === undefined) return new Map()
  const raw = await readSidecarObject(sourcePath, 'href JSON')
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new SlideConvertRuntimeError(
        `href JSON entry must be a string: ${key}`,
        'invalid-staging-json',
      )
    }
    map.set(key, value)
  }
  return map
}

/**
staging から animation-policy.json を読み込み、`p:timing` を残す stepIndex の集合を
返す（#1070）。CLI flag は持たない。

不在時は空集合で進む（= 全スライドの `p:timing` を除去する）。sidecar が「残す側」を
列挙する形なのは、この既定を「全除去」に倒すため。「全保持」を既定にすると、読めなかった
run が通知なしに #1062 の状態（装飾が PowerPoint アニメーションとして残る）へ戻る。

ファイルがある場合は `schemaVersion` の一致を要求する。不在時の既定（全除去）に倒れるのは
「sidecar が無い」ときだけで、想定外の形の sidecar を通知なしに空集合と解釈すると、
明示指定したアニメーションが理由の分からないまま消える。
*/
async function resolveKeepTimingSteps(stagingPath: string): Promise<ReadonlySet<number>> {
  const sourcePath = await resolveJsonSource(undefined, stagingPath)
  if (sourcePath === undefined) return new Set()
  const raw = await readSidecarObject(sourcePath, 'animation-policy JSON')
  const schemaVersion = raw['schemaVersion']
  if (schemaVersion !== ANIMATION_POLICY_SCHEMA_VERSION) {
    const mismatch = `expected ${String(ANIMATION_POLICY_SCHEMA_VERSION)}, got ${String(schemaVersion)}, path ${sourcePath}`
    throw new SlideConvertRuntimeError(
      `animation-policy JSON schemaVersion mismatch: ${mismatch}`,
      'invalid-staging-json',
    )
  }
  const steps = raw['keepTimingSteps']
  if (!Array.isArray(steps)) {
    throw new SlideConvertRuntimeError(
      `animation-policy JSON keepTimingSteps must be an array: ${sourcePath}`,
      'invalid-staging-json',
    )
  }
  const result = new Set<number>()
  for (const step of steps) {
    if (typeof step !== 'number' || !Number.isSafeInteger(step)) {
      throw new SlideConvertRuntimeError(
        `animation-policy JSON keepTimingSteps must be an array of integers: ${sourcePath}`,
        'invalid-staging-json',
      )
    }
    result.add(step)
  }
  return result
}

/**
priority: `flag > staging > empty` で JSON ソース path を解決する。
flag 指定時は flag 側を返し (staging を無視)、未指定時のみ staging path を `stat` で確認する。
*/
async function resolveJsonSource(
  flagPath: string | undefined,
  stagingPath: string,
): Promise<string | undefined> {
  if (flagPath !== undefined) return flagPath
  try {
    const stats = await stat(stagingPath)
    if (stats.isFile()) return stagingPath
  }
  catch {
    // staging に file が無いケース。空 Map で進める。
  }
  return undefined
}

/**
merge 後処理の結果。警告と、観測用の除去件数を返す。
*/
interface MergeOutcome {
  /**
  mergePptxFiles が積んだ警告（埋め込みフォントの実体不一致）。異常なしなら空配列。
  */
  readonly warnings: readonly string[]
  /**
  `p:timing` を実際に落としたスライド数（#1070）。
  */
  readonly animationTimingRemovedSlides: number
}

/**
staging/slides/ 配下の単スライド PPTX 群を集めて、mergePptxFiles で 1 つに統合する。
続いて、各 slide と rels へ post-process chain を適用する。
chain は timing 除去 → sanitize → font fix → hyperlink fix → transition の順。
適用後は outputAbs へ書き出す。

`chainOptions.spacingMap` / `hrefMap` / `keepTimingSteps` は呼び出し側で解決済みの値を
渡すこと。
spacingMap / hrefMap は staging auto-detect と CLI flag から得る (priority: flag > staging > empty)。
keepTimingSteps は staging の animation-policy.json から得る (不在なら空集合 = 全スライドの timing を除去)。
*/
async function mergeSingleSlidePptxesTo(
  stagingDirectory: string,
  outputAbs: string,
  chainOptions: Readonly<ChainOptions>,
  // deps の port メソッドが mutable 扱い。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideConvertDependencies,
): Promise<MergeOutcome> {
  const slidesDirectory = path.join(stagingDirectory, 'slides')
  const { inputs, originalSlideNumbers } = await loadSingleSlidePptxes(slidesDirectory, dependencies.archive)
  if (inputs.length === 0) {
    throw new SlideConvertRuntimeError(
      `pptx convert reported success but no slide-<N>.pptx exists in ${slidesDirectory}`,
      'pptx-convert-failed',
    )
  }
  let merged
  try {
    merged = mergePptxFiles(inputs, dependencies.engine)
  }
  /* c8 ignore start -- mergePptxFiles 内部の throw は事前に inputs.length>0 で防御済 */
  catch (error: unknown) {
    throw new SlideConvertRuntimeError(
      `PPTX merge failed: ${formatError(error)}`,
      'merge-failed',
    )
  }
  /* c8 ignore stop */

  // mergePptxFiles の戻り値は、フラットな配列 (slide / rels / その他)。
  // Map<part, buffer> に詰め直し、slide -> 対応 rels の pair で post-process する。
  // chain 順は次で固定する。
  // removeAnimationTiming → sanitizeCssOnlyTypefaces → applyJapaneseFontFix。
  // 続けて applyHyperlinkFix → applyTransition。
  // transition は常時挿入。
  // 除去を先頭に置くことで、後続の transform は timing の有無を気にせず済む。
  const partMap = new Map<string, Buffer>()
  for (const file of merged.files) {
    partMap.set(file.part, file.buffer)
  }

  // 除去は「明示指定の無いスライド」に対して通知なしに働くため、何枚に働いたかを集計して
  // 呼び出し側へ返す。判定側 (dom-converter) のログは明示指定を見つけたときしか出ないので、
  // 意図せず消えた利用者はここでしか手掛かりを得られない。
  let animationTimingRemovedSlides = 0

  const initialParts = partMap.entries().toArray()
  for (const [slidePart, slideBuffer] of initialParts) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(slidePart)) continue
    const relsPart = `ppt/slides/_rels/${path.basename(slidePart)}.rels`
    const relsBufferRaw = partMap.get(relsPart) ?? createEmptyRelsBuffer()
    const slideDocument = dependencies.engine.parse(slideBuffer)
    const relsDocument = dependencies.engine.parse(relsBufferRaw)

    // mergePptxFiles で 1..N に再番号付けしている。
    // そのため prerender ファイル名と animation-policy 用の元 slideNumber (= stepIndex) は、
    // originalSlideNumbers から逆引きする。
    const mergedIndex = parseSlideNumber(slidePart)
    // originalSlideNumbers の長さは inputs と同じ。
    // loadSingleSlidePptxes の同一ループ内で保証される。
    // mergedIndex は 1..inputs.length の範囲で必ず取れる。
    // 右辺の -1 は防御網。フォールバックを mergedIndex にすると旧バグを silent に再現してしまう。
    // -1 なら findPrerenderImages が確実に空配列を返す。
    /* c8 ignore next */
    const originalSlideNumber = originalSlideNumbers[mergedIndex - 1] ?? -1

    // アニメーション方針（#1070。#1062 の暫定判断「アニメーションをそのまま残す」を差し替えたもの）。
    //
    // 何を消すか: 明示指定を持たないスライドの `p:timing` を要素ごと落とす。
    // 配下の `p:tnLst`（効果の時間木）と `p:bldLst`（段階表示の宣言）も一緒に消える。
    // アニメーション状態はすべて `p:timing` の内側にあり、図形側に残る痕跡は無い。
    //
    // なぜ消すか: dom-to-pptx 2.1.1 は、animation-name が none でない要素を PowerPoint の出現アニメーションへ変換する。
    // 既定はクリック発火。
    // 装飾目的の CSS animation を持つだけのスライドでも、
    // スライドショーで初期非表示の要素が出る。
    // タイトル・アクセント線・説明文が隠れ、表示にクリックが要る。
    // ライブラリ側に無効化オプションが無いため、pptx 側で消す。
    //
    // 何を残すか: 明示指定のあるスライドだけ `p:timing` をそのまま残す。
    // 明示指定の判定は、変換時に infra/slidev-to-pptx/dom-converter.ts が行う。
    // 判定は `slides/animation-policy.json` 経由でここへ届く。
    // 判定チャネルは同ファイルのコメントを参照。
    //
    // 粒度: スライド単位。明示指定が 1 件でもあるスライドは timing をまるごと残すため、
    // 同じスライドに同居した装飾側の効果もクリック待ちのまま残る。利用者側の回避策は、
    // 装飾と明示指定を同一スライドに混ぜないこと。
    //
    // 要素単位にしない理由: 効果と shape の対応は、`p:cNvPr` の `descr` / `name` に埋まる `__z_<z>__dom_<N>` を介している。
    // この `N` は dom-to-pptx 内部の走査カウンタで、pecotv 側から観測する手段が無い。
    // 要素単位で消すには、走査順の再現か、ライブラリ側への API 追加が要る。
    if (!chainOptions.keepTimingSteps.has(originalSlideNumber)) {
      const { removed } = removeAnimationTiming(slideDocument)
      if (removed > 0) animationTimingRemovedSlides += 1
    }

    sanitizeCssOnlyTypefaces(slideDocument)
    applyJapaneseFontFix(slideDocument, chainOptions.fontPolicy, chainOptions.spacingMap)
    applyHyperlinkFix(
      slideDocument,
      relsDocument,
      chainOptions.hrefMap,
      chainOptions.fontPolicy.linkColor,
    )
    applyTransition(
      slideDocument,
      chainOptions.transitionType,
      chainOptions.transitionDurationMs,
      chainOptions.morphOption === undefined ? {} : { morphOption: chainOptions.morphOption },
    )

    // prerender 高解像度差し替え。partMap の `ppt/media/*.png` を mutate する点に注意。
    // 外側ループは `^ppt/slides/slide\d+\.xml$` で gate されるため、media part の追加 set は
    // ループ進行を撹乱しない。
    const entries = await findPrerenderImages(
      slidesDirectory,
      originalSlideNumber,
      { exists: doesPathExist },
    )
    await applyPrerenderImageReplace(
      slideDocument,
      relsDocument,
      partMap,
      entries,
      { readFile, warn: createDiagnostics(dependencies.stderr).warning },
    )

    partMap.set(slidePart, dependencies.engine.serialize(slideDocument))
    partMap.set(relsPart, dependencies.engine.serialize(relsDocument))
  }

  const writer = dependencies.archive.write()
  for (const [part, buffer] of partMap) {
    writer.addBuffer(part, buffer)
  }
  await writer.finish(outputAbs)
  return { warnings: merged.warnings, animationTimingRemovedSlides }
}

/**
`ppt/slides/slide<N>.xml` から N を抽出する。
外側ループの gate `^ppt/slides/slide\d+\.xml$` で守られているため、ここでの
mismatch は到達不能 (防御網)。
*/
function parseSlideNumber(slidePart: string): number {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(slidePart)
  /* c8 ignore next 2 -- 外側ループの正規表現で gate 済、到達不能 */
  return match?.[1] === undefined ? 0 : Math.trunc(Number(match[1]))
}

async function doesPathExist(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  }
  catch {
    return false
  }
}

function createEmptyRelsBuffer(): Buffer {
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}"/>`,
    'utf8',
  )
}

/**
staging/slides/ 内の slide-<N>.pptx を読み込む。
`mergePptxFiles` 用入力と、元 slideNumber (dom-to-pptx の 100/200/... 命名) の parallel array を返す。

@returns inputs[i] と originalSlideNumbers[i] は同じスライドを指す parallel array。
         loadSingleSlidePptxes 内の同一ループで対称に push されるため長さは一致する。
         再番号付け後の slideNumber (= i+1) と元 slideNumber (= originalSlideNumbers[i]) は異なる前提。
         そのため prerender ファイル名解決には originalSlideNumbers を使う。
*/
async function loadSingleSlidePptxes(
  slidesDirectory: string,
  archive: PptxArchive,
): Promise<{ readonly inputs: readonly MergeInput[], readonly originalSlideNumbers: readonly number[] }> {
  let entries: string[]
  try {
    entries = await readdir(slidesDirectory)
  }
  catch {
    return { inputs: [], originalSlideNumbers: [] }
  }
  const targets: { slideNumber: number, filePath: string }[] = []
  for (const name of entries) {
    const slideNumber = parseSlideFilename(name, DEFAULT_SLIDE_PREFIX)
    if (slideNumber === undefined) continue
    targets.push({ slideNumber, filePath: path.join(slidesDirectory, name) })
  }
  targets.sort((a, b) => a.slideNumber - b.slideNumber)
  // dom-to-pptx は slide-100.pptx / slide-200.pptx のように、100 刻みなど非連番の slideNumber を出す。
  // mergePptxFiles の連番 assert (tech-advisor B2) に合うよう、ここで 1..N に再番号付けする。
  // 元の slideNumber の昇順を維持しているため、PPTX の表示順序は不変。
  // 元 slideNumber は prerender ファイル名 (`prerender-slide<元N>-<i>.png`) の解決に必要。
  // そのため originalSlideNumbers として外に出す (再番号付け後の index N → originalSlideNumbers[N-1])。
  const inputs: MergeInput[] = []
  const originalSlideNumbers: number[] = []
  for (const [index, target] of targets.entries()) {
    const reader = await archive.read(target.filePath)
    try {
      const files = new Map<string, Buffer>()
      for await (const entry of reader.entries()) {
        files.set(entry.part, await entry.read())
      }
      inputs.push({ slideNumber: index + 1, files })
      originalSlideNumbers.push(target.slideNumber)
    }
    finally {
      await reader.close()
    }
  }
  return { inputs, originalSlideNumbers }
}

export function errorToReason(error: unknown): string {
  if (error instanceof SlideConvertUsageError) return error.reason
  if (error instanceof SlideConvertRuntimeError) return error.reason
  // テーマの張り直しの失敗 (テーマの名前の不一致など) は、原因ごとの reason を持つ。
  if (error instanceof SlideCreateRuntimeError) return error.reason
  // pipeline 到達後の生 Error（merge / 出力書き出し）は merge-failed へ wrap 済み。
  // 到達前の生 Error（--out 親の mkdir、cleanBuildArtifacts の rm、slidevRunner.build の spawn 失敗）は wrap されない。
  // それらはここへ届き、従来どおり unknown になる。
  // テーマの取得・宣言・指定・未参照の失敗は、theme-<reason> にする。
  return themeErrorReason(error) ?? 'unknown'
}

/**
失敗時の exit code。usage error = 2、それ以外の実行失敗 = 1。
*/
export function toExitCode(error: unknown): number {
  return error instanceof SlideConvertUsageError ? 2 : 1
}

/**
`--json` の error payload に載せる pipeline 診断。CLI と MCP ツールで同形にする。
*/
export function convertErrorDiagnostics(error: unknown): Readonly<{
  readonly warnings: readonly string[]
  readonly errors: readonly PipelineError[]
}> {
  return { warnings: warningsOf(error), errors: pipelineErrorsOf(error) }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

/**
人間向けのキャッシュ判定出力。どのステップを変換したかが SC-001 の確認手段になるため、
サマリ 1 行に続けてステップ別の判定も出す。

全ステップを列挙すると多スライドデッキ（例: 51 ステップ）で 500 文字を超えて可読性を
損なうため、miss（= 今回実際に変換したステップ）のみを列挙し、hit は件数集約する。
全 hit なら miss 列挙自体を出さず件数のみ。
*/
function formatCacheSummary(cache: Readonly<PipelineCacheSummary>): string {
  const summaryLine = `cache: ${String(cache.hits)} hits / ${String(cache.misses)} misses`
    + ` (enabled: ${String(cache.enabled)}, invalidated: ${cache.invalidated})\n`
  if (cache.perStep.length === 0) return summaryLine
  const missSteps = cache.perStep.filter(entry => entry.cache === 'miss')
  const hitCount = cache.perStep.length - missSteps.length
  if (missSteps.length === 0) {
    return `${summaryLine}cache steps: ${String(hitCount)} hit\n`
  }
  const missList = missSteps.map(entry => `#${entry.key}`).join(', ')
  const hitSuffix = hitCount === 0 ? '' : ` (${String(hitCount)} more hit)`
  return `${summaryLine}cache steps: miss ${missList}${hitSuffix}\n`
}

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

/**
--out 省略時の既定出力パスを解決する。
`slides.md` の frontmatter title があれば、
`<project-dir>/pptx/<sanitizeFilename(title)>.pptx` を返す。
title 不在 (frontmatter 無し / キー無し / 空値 / 読取失敗) なら、
`<project-dir>/pptx/<basename>.pptx` を返す。
slides.md 不在等の異常系は、ここでは basename fallback とする。
後段の ensureProjectDirectory が検証する。
*/
export async function resolveDefaultOut(
  resolvedProject: string,
  // NodeJS.WritableStream が mutable と判定されるため。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stderr: NodeJS.WritableStream,
): Promise<string> {
  const title = await readSlidesTitleForDefault(resolvedProject, stderr)
  const stem = title === undefined ? path.basename(resolvedProject) : sanitizeFilename(title)
  return path.join(resolvedProject, 'pptx', `${stem}.pptx`)
}

async function readSlidesTitleForDefault(
  resolvedProject: string,
  // NodeJS.WritableStream が mutable と判定されるため。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stderr: NodeJS.WritableStream,
): Promise<string | undefined> {
  const slidesPath = path.join(resolvedProject, 'slides.md')
  return readSlidesTitleFromFile(slidesPath, (error) => {
    // slides.md 不在 (ENOENT) は basename fallback の正常系のため警告しない。
    // それ以外の読取失敗 (permission 等) は診断を stderr に残す (stdout の JSON イベント契約を汚さない)。
    if (error.code !== 'ENOENT') {
      createDiagnostics(stderr).warning(
        `cannot read slides.md; deriving the default output name from the basename`
        + ` (${slidesPath}): ${error.message}`,
      )
    }
  })
}

export interface SlideConvertExecution {
  readonly summary: SlideConvertResultSummary
  /**
  `--json` の `slide.convert.done` payload。MCP ツールの構造化データもこれをそのまま返す。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
`slide convert` の実処理と機械可読な結果組み立て。CLI action と MCP ツールの双方がここを通る。

`options.out` は解決済みの出力パスを渡す（省略時の既定は `resolveDefaultOut`）。
`slide.convert.start` は進捗イベントで結果ではないため、ここでは扱わない。
*/
export async function executeSlideConvert(
  projectDirectory: string,
  options: Readonly<SlideConvertOptions>,
  // port メソッドが mutable と判定されるため interface readonly fields で担保。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideConvertDependencies,
): Promise<SlideConvertExecution> {
  const summary = await runSlideConvert(projectDirectory, options, dependencies)
  return { summary, data: buildConvertDoneData(summary) }
}

function buildConvertDoneData(
  summary: Readonly<SlideConvertResultSummary>,
): Readonly<Record<string, unknown>> {
  const donePayload: Record<string, unknown> = {
    event: 'slide.convert.done',
    input: summary.inputAbs,
    output: summary.outputAbs,
    durationMs: summary.durationMs,
    // 警告の有無を条件にしない。空配列を常時載せることで、tooling 側は
    // 「フィールドが無い＝旧版」と「警告なしの run」を区別できる（#929）。
    warnings: summary.warnings,
    // エラーの有無・run の成否を条件にしない。
    // level=element のエラーは success を落とさない。
    // 成功完走した run でも空配列を常時載せるため、tooling 側は「フィールドが無い＝旧版」と「エラーなしの run」を区別できる（#949）。
    errors: summary.errors,
    // 装飾 CSS animation 由来の p:timing を落としたスライド数（#1070）。0 件でも常時載せる。
    animationTimingRemovedSlides: summary.animationTimingRemovedSlides,
  }
  if (summary.pipelineTiming !== undefined) {
    const cacheOfKey = new Map(
      (summary.cache?.perStep ?? []).map(entry => [entry.key, entry.cache]),
    )
    const phasesOfKey = new Map(Object.entries(summary.pipelineTiming.perSlidePhases ?? {}))
    donePayload['timings'] = {
      scan: summary.pipelineTiming.scan,
      phase1: summary.pipelineTiming.phase1,
      phase2: summary.pipelineTiming.phase2,
      // 工程別の所要（#1141）は同じ key の要素に phases として載せる。キャッシュ hit の
      // ステップは変換していないため phases を持たない。
      perSlide: Object.entries(summary.pipelineTiming.perSlide).map(
        ([key, value]) => {
          const cache = cacheOfKey.get(key)
          const phases = phasesOfKey.get(key)
          return {
            key,
            elapsedMs: value,
            ...(cache !== undefined && { cache }),
            ...(phases !== undefined && { phases }),
          }
        },
      ),
      // コマンド全体の区間別所要。timings を出す run では常に載る
      outer: summary.outerTiming,
      // 1 パスのルートを試みた run だけ載る（現行ルートの run には無い）。print ルートが無く run 全体を
      // 現行ルートへ退避した run では `{ fallback, detectMs }` の形で載る
      ...(summary.pipelineTiming.singlePass !== undefined && { singlePass: summary.pipelineTiming.singlePass }),
    }
  }
  if (summary.cache !== undefined) {
    donePayload['cache'] = {
      enabled: summary.cache.enabled,
      hits: summary.cache.hits,
      misses: summary.cache.misses,
      invalidated: summary.cache.invalidated,
    }
  }
  return donePayload
}

export function createSlideConvertCommand(
  buildDependencies: () => SlideConvertDependencies,
): Command {
  const command = new Command('convert')
    .description('convert a Slidev project to PPTX')
    .argument('<project-dir>', 'Slidev project directory')
    .option('--out <path>', 'output .pptx path (default: <project-dir>/pptx/<slides.md title | basename>.pptx)')
    .option('--theme <name>', 'name passed to slidev --theme (allowed characters: [a-zA-Z0-9@/_.-])')
    .option('--spacing-json <path>', 'letter-spacing JSON path (default: auto-detect staging/slides/letter-spacing.json)')
    .option('--href-json <path>', 'hyperlink JSON path (default: auto-detect staging/slides/href-map.json)')
    .option('--transition-type <type>', 'transition type (fade|morph)')
    .option('--transition-duration-ms <ms>', 'transition duration (ms)')
    .option('--morph-option <option>', 'morph option (byObject|byWord|byChar)')
    .option('--no-cache', 'convert all slides without reading the cache (the cache is rebuilt on completion)')
    .option('--no-single-pass', 'convert with the per-step route that opens a page for each slide step, not the single-pass route')
    .addOption(new Option('--log-level <level>', 'progress detail (verbose and debug write progress to stderr)').choices(['normal', 'verbose', 'debug']))
    .option('--json', 'emit machine-readable progress on stdout', false)
    .exitOverride()
    .configureOutput({
      writeOut: (string_: string) => {
        writeData(buildDependencies().stdout, string_)
      },
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.convert.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:\s*/i, '').trim(),
            // done payload と同じく常時載せる。option 解析で落ちた run は pipeline 未到達のため空配列。
            warnings: [],
            errors: [],
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
    })
    .action(async (projectDirectory: string, raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isWantsJson = raw['json'] === true

      let options: SlideConvertOptions
      try {
        const theme = optionalString(raw, 'theme')
        const spacingJson = optionalString(raw, 'spacingJson')
        const hrefJson = optionalString(raw, 'hrefJson')
        const transitionType = optionalTransitionType(raw, 'transitionType')
        const transitionDurationMs = optionalPositiveInt(raw, 'transitionDurationMs', 'invalid-transition-duration-ms')
        const morphOption = optionalMorphOption(raw, 'morphOption')
        const logLevel = optionalLogLevel(raw, 'logLevel')
        const optionalsPart: {
          theme?: string
          spacingJson?: string
          hrefJson?: string
          transitionType?: TransitionType
          transitionDurationMs?: number
          morphOption?: MorphOption
          logLevel?: 'normal' | 'verbose' | 'debug'
        } = {}
        if (theme !== undefined) optionalsPart.theme = theme
        if (spacingJson !== undefined) optionalsPart.spacingJson = spacingJson
        if (hrefJson !== undefined) optionalsPart.hrefJson = hrefJson
        if (transitionType !== undefined) optionalsPart.transitionType = transitionType
        if (transitionDurationMs !== undefined) optionalsPart.transitionDurationMs = transitionDurationMs
        if (morphOption !== undefined) optionalsPart.morphOption = morphOption
        if (logLevel !== undefined) optionalsPart.logLevel = logLevel
        const outOption = optionalString(raw, 'out')
        const resolvedProject = path.resolve(projectDirectory)
        const out = outOption ?? await resolveDefaultOut(resolvedProject, dependencies.stderr)
        options = {
          out,
          json: isWantsJson,
          // commander は `--no-cache` の受け皿として raw['cache'] に既定 true を入れる。
          cache: raw['cache'] !== false,
          // `--no-single-pass` も同じく raw['singlePass'] に既定 true が入る。
          singlePass: raw['singlePass'] !== false,
          ...optionalsPart,
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.convert.error',
            reason,
            detail,
            warnings: [],
            errors: [],
          }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(detail)
        }
        process.exitCode = toExitCode(error)
        return
      }

      try {
        if (options.json === true) {
          // event 順序保証: start → done (失敗時は start → error)。tooling 側 stream parser
          // は start を進捗開始の signal として待つことができる。
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.convert.start',
            input: path.resolve(projectDirectory),
            output: path.resolve(options.out),
          }))
        }
        const { summary, data } = await executeSlideConvert(projectDirectory, options, dependencies)
        if (options.json === true) {
          writeData(dependencies.stdout, JSON.stringify(data))
        }
        else {
          writeData(
            dependencies.stdout,
            `slide convert: ${summary.inputAbs} -> ${summary.outputAbs}`
            + ` (${String(Math.round(summary.durationMs))}ms)`,
          )
          // 0 件のときは出さない（除去が起きなかった run で行数を増やさない）。
          if (summary.animationTimingRemovedSlides > 0) {
            writeData(
              dependencies.stdout,
              `animation: removed p:timing from ${String(summary.animationTimingRemovedSlides)} slides`
              + ` (slides with an explicit setting are kept)`,
            )
          }
          if (summary.cache !== undefined) {
            writeData(dependencies.stdout, formatCacheSummary(summary.cache))
          }
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (options.json === true) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.convert.error',
            reason,
            detail,
            // 失敗した run でも pipeline が積んだ警告・変換エラーを観測できるようにする。
            // pipeline 未到達なら空配列（done payload と同じく「不在＝旧版」と区別する）。
            // detail 側 (formatPipelineErrors) は先頭 3 件に丸めるが、機械可読側は全件載せる。
            ...convertErrorDiagnostics(error),
          }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(detail)
        }
        process.exitCode = toExitCode(error)
      }
    })
  return command
}

const LOG_LEVELS: readonly ('normal' | 'verbose' | 'debug')[] = ['normal', 'verbose', 'debug']

function optionalLogLevel(raw: Readonly<Record<string, unknown>>, key: string): 'normal' | 'verbose' | 'debug' | undefined {
  // eslint-disable-next-line security/detect-object-injection -- key は本ファイル内の固定文字列のみ
  const value = raw[key]
  return LOG_LEVELS.find(level => level === value)
}

function optionalString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- key は本ファイル内の固定文字列のみ
  const value = raw[key]
  if (value === undefined) return undefined
  /* c8 ignore next 3 -- commander が --opt <string> で先に validate するため到達不能 */
  if (typeof value !== 'string') {
    throw new SlideConvertUsageError(`option --${key} must be a string`, 'invalid-option')
  }
  return value
}

function optionalTransitionType(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): TransitionType | undefined {
  const value = optionalString(raw, key)
  if (value === undefined) return undefined
  if (!isTransitionType(value)) {
    throw new SlideConvertUsageError(
      `option --${kebab(key)} accepts only ${TRANSITION_TYPES.join('|')}: ${value}`,
      'invalid-transition-type',
    )
  }
  return value
}

function optionalMorphOption(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): MorphOption | undefined {
  const value = optionalString(raw, key)
  if (value === undefined) return undefined
  if (!isMorphOption(value)) {
    throw new SlideConvertUsageError(
      `option --${kebab(key)} accepts only ${MORPH_OPTIONS.join('|')}: ${value}`,
      'invalid-morph-option',
    )
  }
  return value
}

function optionalPositiveInt(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  reason: string,
): number | undefined {
  const value = optionalString(raw, key)
  if (value === undefined) return undefined
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new SlideConvertUsageError(
      `option --${kebab(key)} must be a positive integer: ${value}`,
      reason,
    )
  }
  return parsed
}

function isTransitionType(value: string): value is TransitionType {
  // readonly TransitionType[] は readonly string[] と互換だが、includes に渡すため string[] へ widening が必要。
  // eslint-disable-next-line no-restricted-syntax
  return (TRANSITION_TYPES as readonly string[]).includes(value)
}

function isMorphOption(value: string): value is MorphOption {
  // readonly MorphOption[] は readonly string[] と互換だが、includes に渡すため string[] へ widening が必要。
  // eslint-disable-next-line no-restricted-syntax
  return (MORPH_OPTIONS as readonly string[]).includes(value)
}

function kebab(camel: string): string {
  return camel.replaceAll(/[A-Z]/g, m => `-${m.toLowerCase()}`)
}

export function slideConvertDefaultDependencies(): SlideConvertDependencies {
  return {
    slidevRunner: new ChildProcessSlidevRunner(),
    pptxConverter: new InProcessSlidevPptxPipeline(),
    archive: new YauzlYazlPptxArchive(),
    engine: new XmldomXmlEngine(),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => performance.now(),
    pluginVersion: readVersion,
    ensureThemeLinked: (directory, context) => ensureTalkThemeLinked(
      directory,
      linkedThemeDefaultDependencies(pluginDependencyRoot() ?? resolvePluginRoot(), context),
      { requireTheme: true },
    ),
    readThemeDeclaration: themeDirectory => readThemeDeclaration(new NodeThemeFiles(), themeDirectory),
  }
}
