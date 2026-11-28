// MCP ツール定義のうち slide 系 4 件 (slide_create / slide_convert / slide_sync / slide_lint)。
// deps はハンドラ内で組み立てる。

import path from 'node:path'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  errorToReason as slideCreateErrorToReason,
  executeSlideCreate,
  slideCreateDefaultDependencies,
} from '../../commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../commands/slidev-project/create.js'
import {
  errorToReason as slideLintErrorToReason,
  executeSlideLint,
  slideLintDefaultDependencies,
} from '../../commands/slidev-project/lint.js'
import type { SlideLintDependencies } from '../../commands/slidev-project/lint.js'
import {
  errorToReason as slideSyncErrorToReason,
  executeSlideSync,
  slideSyncDefaultDependencies,
} from '../../commands/slidev-project/sync.js'
import type { SlideSyncDependencies, SlideSyncResultSummary } from '../../commands/slidev-project/sync.js'
import {
  convertErrorDiagnostics,
  errorToReason as slideConvertErrorToReason,
  executeSlideConvert,
  resolveDefaultOut,
  slideConvertDefaultDependencies,
} from '../../commands/slidev-to-pptx/convert.js'
import type {
  SlideConvertDependencies,
  SlideConvertOptions,
} from '../../commands/slidev-to-pptx/convert.js'
import { failureKindOf, type FailureReason } from '../../domain/_shared/failure-kind.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { FailedToolResult } from '../result.js'
import type { ToolContext, ToolDefinition, ToolCallContext } from '../server.js'
import {
  captureCommandOutput,
  chromiumDefaultDependencies,
  ensureChromium,
  ensureRuntimeDependencies,
  formatError,
  MISSING_RUNTIME_OUTPUT_SHAPE,
  normalizeThemeArgument,
  optionalFields,
  PATH_REJECTION_OUTPUT_SHAPE,
  runtimeDefaultDependencies,
  toolOutputFields,
  WINDOWS_PATH_NOTE,
  withPresence,
  type RuntimeDependencies,
} from './_shared.js'

/**
失敗時の ToolResult。
*/
function failureResult(
  event: string,
  reason: FailureReason,
  error: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): FailedToolResult {
  return {
    ok: false,
    kind: failureKindOf(reason),
    detail: formatError(error),
    data: { event, ...extra },
  }
}

/**
見せ方の分類とレイアウトの一覧。slide_create・slide_sync・slide_page・slide_theme が返す。
*/
export const LAYOUT_CATALOG_OUTPUT_SHAPE = {
  categories: z.array(z.strictObject({
    id: z.string().describe('Category ID that layouts[].category refers to'),
    label: z.string().describe('Display name of the category'),
    question: z.string().describe('Question that tells when to choose the category'),
  })).describe('Presentation categories declared by the theme'),
  layouts: z.array(z.strictObject({
    layout: z.string().describe('Layout name'),
    description: z.string().describe('What the layout is for'),
    category: z.string().describe('Category ID (uncategorized when unset or unknown)'),
    deprecated: z.boolean().describe('Whether the layout is deprecated (not to be chosen)'),
    filename: z.string().describe('File name of the reference yaml'),
  })).describe('Selectable layouts (hidden layouts are excluded)'),
}

const slideLintViolationsOutput = z.array(z.strictObject({
  file: z.string().describe('Path relative to the talk-dir (absolute when outside it)'),
  line: z.number(),
  column: z.number(),
  rule: z.string().describe('Rule ID'),
  message: z.string(),
}))

/**
lint の集計。slide_lint では成功のとき必ず入り、slide_create・slide_sync の lint では実行できたときだけ入る。
*/
const slideLintSummaryShape = {
  outcome: z.enum(['clean', 'violations', 'no-target']).describe(
    'clean (no violations), violations (some found), no-target (no file to lint)',
  ),
  lintedFileCount: z.number().describe('Number of files linted'),
  errorCount: z.number().describe('Number of errors'),
  warningCount: z.number().describe('Number of warnings'),
  violations: slideLintViolationsOutput.describe('Violations found'),
  skippedSymlinkDirectories: z.array(z.string()).describe(
    'Symlinked directories under pages/ that were not linted (relative to the talk-dir)',
  ),
}

const deckLintOutput = z.strictObject({
  skipped: z.boolean().describe('Whether the lint could not run (the generation or sync still succeeds)'),
  detail: z.string().optional().describe('Why the lint could not run (only when skipped)'),
  ...optionalFields(slideLintSummaryShape),
}).describe('Lint result of the whole deck (success only)')

const slideCreateShape = {
  event: z.string().describe(
    'slide.create.done on success; slide.create.error or runtime-dependencies.unavailable on failure (omitted when a path argument is rejected)',
  ),
  projectDir: z.string().describe('Absolute path of the generated talk-dir (success only)'),
  theme: z.strictObject({
    name: z.string().describe('Package name of the theme'),
    spec: z.string().describe('Theme specification written to the dependencies of package.json'),
  }).describe('Theme the talk-dir references (success only)'),
  ...withPresence(LAYOUT_CATALOG_OUTPUT_SHAPE, 'success only'),
  lint: deckLintOutput,
}
const slideCreateOutput = toolOutputFields(slideCreateShape, MISSING_RUNTIME_OUTPUT_SHAPE, PATH_REJECTION_OUTPUT_SHAPE)

const pipelineErrorsOutput = z.array(z.strictObject({
  level: z.string().describe('slide or element'),
  slideNumber: z.number().optional(),
  selector: z.string().optional().describe('CSS selector of the element (element level only)'),
  message: z.string(),
}))

const perSlideTimingOutput = z.strictObject({
  key: z.string().describe('Step, as <slide> or <slide>/<click>'),
  elapsedMs: z.number(),
  cache: z.enum(['hit', 'miss']).optional(),
  phases: z.record(z.string(), z.number()).optional().describe('Time per phase in milliseconds (converted steps only)'),
})

const slideConvertShape = {
  event: z.string().describe(
    'slide.convert.done on success; slide.convert.error, runtime-dependencies.unavailable or chromium.unavailable on failure '
    + '(omitted when a path argument is rejected)',
  ),
  input: z.string().describe('Absolute path of the converted Slidev project (success only)'),
  output: z.string().describe('Absolute path of the written .pptx (success only)'),
  durationMs: z.number().describe('Time the conversion took in milliseconds (success only)'),
  errors: pipelineErrorsOutput.describe(
    'Conversion errors per slide or element (empty when none). Element-level errors do not fail the call. '
    + 'Returned on success and on slide.convert.error',
  ),
  animationTimingRemovedSlides: z.number().describe(
    'Number of slides whose p:timing from decorative CSS animations was removed (success only)',
  ),
  timings: z.strictObject({
    scan: z.number(),
    phase1: z.number(),
    phase2: z.number(),
    perSlide: z.array(perSlideTimingOutput),
    outer: z.strictObject({
      cleanBuild: z.number(),
      slidevBuild: z.number(),
      pipeline: z.number(),
      mergeAndPostprocess: z.number(),
    }),
    singlePass: z.looseObject({}).optional().describe('Timing of the single-pass route (only when it was tried)'),
  }).optional().describe('Time spent per stage in milliseconds (success only, when measured)'),
  cache: z.strictObject({
    enabled: z.boolean().describe('Whether the diff cache was used'),
    hits: z.number(),
    misses: z.number(),
    invalidated: z.enum(['none', 'all:env', 'all:manifest', 'all:key', 'all:error', 'partial']).describe('How existing cache entries were invalidated'),
  }).optional().describe('Diff cache result (success only, when the cache was handled)'),
}
const slideConvertOutput = toolOutputFields(slideConvertShape, MISSING_RUNTIME_OUTPUT_SHAPE, PATH_REJECTION_OUTPUT_SHAPE)

const slideSyncShape = {
  event: z.string().describe(
    'slide.sync.done on success; slide.sync.error or runtime-dependencies.unavailable on failure (omitted when a path argument is rejected)',
  ),
  dir: z.string().describe('Absolute path of the synced talk-dir (success only)'),
  nodeModulesTarget: z.string().describe('Where node_modules of the talk-dir links to (success only)'),
  nodeModulesOnly: z.boolean().describe('Whether only node_modules was relinked (success only)'),
  theme: z.strictObject({
    name: z.string().describe('Package name of the theme'),
    spec: z.string().describe('Theme specification in the dependencies of package.json'),
    directory: z.string().describe('Absolute path of the theme root'),
  }).nullable().describe('Theme the talk-dir references, or null when it references none (success only)'),
  migration: z.strictObject({
    removed: z.array(z.string()).describe('Names of the files from the template that were deleted'),
  }).nullable().describe('Result of moving a pre-migration talk-dir onto the theme, or null when it was not moved (success only)'),
  ...withPresence(LAYOUT_CATALOG_OUTPUT_SHAPE, 'success only'),
  lint: deckLintOutput,
}
const slideSyncOutput = toolOutputFields(slideSyncShape, MISSING_RUNTIME_OUTPUT_SHAPE, PATH_REJECTION_OUTPUT_SHAPE)

const slideLintShape = {
  event: z.string().describe(
    'slide.lint.done or slide.lint.violations on success, slide.lint.error on failure (omitted when a path argument is rejected)',
  ),
  dir: z.string().describe('Absolute path of the linted talk-dir (success only)'),
  ...withPresence(slideLintSummaryShape, 'success only'),
}
const slideLintOutput = toolOutputFields(slideLintShape, PATH_REJECTION_OUTPUT_SHAPE)

const slideCreateInput = z.object({
  project_dir: z.string()
    .describe('Absolute path of the destination directory. Specify a place where the calling agent has write permission for later edits'
      + ' (e.g. under the working directory). Relative paths are not accepted. ' + WINDOWS_PATH_NOTE),
  theme: z.string()
    .describe('Theme to reference (required): `git+https://<host>/<owner>/<repo>.git#<tag>` or `file:<absolute path>`. '
      + 'A git URL without a tag is not accepted.'),
  force: z.boolean()
    .default(false)
    .describe('Delete and overwrite when the destination already exists'),
})

/**
`theme` で指定したテーマを参照する Slidev プロジェクトを生成し、
生成直後のデッキ全体 lint 結果を data に載せて返す (lint 違反は成否に影響しない)。
*/
export function slideCreateTool(
  buildDependencies: () => SlideCreateDependencies = slideCreateDefaultDependencies,
  buildRuntimeDependencies: () => RuntimeDependencies = runtimeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_create',
    config: {
      title: 'Create Slidev deck',
      description: 'Generates a new talk-dir that references the Slidev theme given by `theme`. '
        + 'The theme is specified by a git URL with a tag (`git+https://<host>/<owner>/<repo>.git#<tag>`) '
        + 'or a local path (`file:<path>`). '
        + 'Returns the presentation categories (categories) and the list of selectable layouts (layouts). '
        + 'Also returns the lint result of the whole deck right after generation (generation counts as successful even with lint violations).',
      inputSchema: slideCreateInput,
      outputSchema: slideCreateOutput,
      // git でテーマを取得するため openWorldHint は SDK 既定 (true) のまま。
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideCreateInput, arguments_, ['project_dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const input = validated.input

      const normalized = normalizeThemeArgument(input.theme)
      if (!normalized.ok) {
        return toCallToolResult(failureResult('slide.create.error', 'invalid-option', new Error(normalized.detail)))
      }

      // 生成の最後に行う node_modules の張り直しは依存ルートの実体を要る。実処理より前に見る。
      // 見ずに進むと、テーマの取得 (git) を終えた後で symlink-failed になり、runtime_setup の案内も出ない。
      // 失敗した生成は一時 dir を消すため、途中まで作った talk-dir は残らない。
      const missingRuntime = ensureRuntimeDependencies('slide_create', buildRuntimeDependencies())
      if (missingRuntime !== undefined) return toCallToolResult(missingRuntime)

      const output = captureCommandOutput()
      try {
        const dependencies: SlideCreateDependencies = {
          ...buildDependencies(),
          stdout: output.stdout,
          stderr: output.stderr,
        }
        const execution = await executeSlideCreate(
          input.project_dir,
          // 人間向けの catalog 整形出力は stdout を汚すので出さない。
          // 同じ元データは layouts に構造化して載る。
          { theme: normalized.theme, force: input.force },
          dependencies,
        )
        return output.finish({
          ok: true,
          data: execution.data,
          message: `slide_create: succeeded (${execution.summary.projectDirectory})`,
        })
      }
      catch (error: unknown) {
        return output.finish(failureResult(
          'slide.create.error',
          slideCreateErrorToReason(error),
          error,
        ))
      }
    },
  }
}

const slideConvertInput = z.object({
  project_dir: z.string()
    .describe('Absolute path of the Slidev project directory. Relative paths are not accepted. ' + WINDOWS_PATH_NOTE),
  out_path: z.string().optional()
    .describe('Absolute path of the output .pptx. If omitted, <project_dir>/pptx/<title of slides.md | basename>.pptx. '
      + WINDOWS_PATH_NOTE),
  theme: z.string().optional()
    .describe('Name passed to slidev --theme (allowed characters: [a-zA-Z0-9@/_.-])'),
  spacing_json_path: z.string().optional()
    .describe('Absolute path of the letter-spacing JSON. If omitted, staging/slides/letter-spacing.json is auto-detected. '
      + WINDOWS_PATH_NOTE),
  href_json_path: z.string().optional()
    .describe('Absolute path of the hyperlink JSON. If omitted, staging/slides/href-map.json is auto-detected. '
      + WINDOWS_PATH_NOTE),
  transition_type: z.enum(['fade', 'morph']).optional()
    .describe('Slide transition type (default: fade)'),
  transition_duration_ms: z.number().int().positive().optional()
    .describe('Slide transition duration, as a positive integer in milliseconds (default: 500)'),
  morph_option: z.enum(['byObject', 'byWord', 'byChar']).optional()
    .describe('Granularity of the morph transition. Only meaningful when transition_type=morph'),
  cache: z.boolean().default(true)
    .describe('Whether to read the diff cache. Even with false, the cache is rebuilt when the conversion completes'),
})

/**
`slidev build` と in-process pipeline を起動するため、11 ツールの中で最も長時間かかる。
progress ハートビートは server.ts 側が一律で送り、文言は工程と変換の件数・割合に差し替える。
*/
export function slideConvertTool(
  buildDependencies: () => SlideConvertDependencies = slideConvertDefaultDependencies,
  buildRuntimeDependencies: () => RuntimeDependencies = runtimeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_convert',
    config: {
      title: 'Convert Slidev to PPTX',
      description: 'Converts a Slidev project to PPTX. The duration is proportional to the number of slides (just under 30 seconds for 55 slides).',
      inputSchema: slideConvertInput,
      outputSchema: slideConvertOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async (
      arguments_: Readonly<Record<string, unknown>>,
      // ToolCallContext.signal (AbortSignal は EventTarget で addEventListener を呼ぶため readonly 化できない)。
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      call: ToolCallContext,
      context?: ToolContext,
    ): Promise<CallToolResult> => {
      const validated = parsePathArguments(
        slideConvertInput,
        arguments_,
        ['project_dir', 'out_path', 'spacing_json_path', 'href_json_path'],
      )
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const input = validated.input

      // pipeline (infra/slidev-to-pptx) は @slidev/cli / dom-to-pptx / @slidev/parser を
      // 起動時ではなく実行時に解決する。単体配布ルートではこれらが永続層にしか無いため、
      // 未取得なら `runtime_setup` を案内して実行前に返す。
      const missingRuntime = ensureRuntimeDependencies('slide_convert', buildRuntimeDependencies())
      if (missingRuntime !== undefined) return toCallToolResult(missingRuntime)

      // pipeline が chromium を起こすため、未取得なら実行前に返す。
      const unavailable = await ensureChromium('slide_convert', chromiumDefaultDependencies(), call.signal)
      if (unavailable !== undefined) return toCallToolResult(unavailable)

      const output = captureCommandOutput()
      try {
        // 出力を捕捉する。warning の行は warnings、失敗のときの出力は log に入る。
        const dependencies: SlideConvertDependencies = {
          ...buildDependencies(),
          stdout: output.stdout,
          stderr: output.stderr,
          // 工程と変換の件数・割合を progress 通知の文言に流す。
          ...(context !== undefined && { onProgress: context.reportProgress }),
          // クライアントのキャンセルで slidev build と pipeline を止める。
          signal: call.signal,
        }
        const out = input.out_path
          ?? await resolveDefaultOut(path.resolve(input.project_dir), output.stderr)
        const options: SlideConvertOptions = {
          out,
          cache: input.cache,
          ...(input.theme !== undefined && { theme: input.theme }),
          ...(input.spacing_json_path !== undefined && { spacingJson: input.spacing_json_path }),
          ...(input.href_json_path !== undefined && { hrefJson: input.href_json_path }),
          ...(input.transition_type !== undefined && { transitionType: input.transition_type }),
          ...(input.transition_duration_ms !== undefined && { transitionDurationMs: input.transition_duration_ms }),
          ...(input.morph_option !== undefined && { morphOption: input.morph_option }),
        }
        const execution = await executeSlideConvert(input.project_dir, options, dependencies)
        return output.finish({
          ok: true,
          data: execution.data,
          message: `slide_convert: ${execution.summary.inputAbs} -> ${execution.summary.outputAbs}`
            + ` (${String(Math.round(execution.summary.durationMs))}ms)`,
        })
      }
      catch (error: unknown) {
        return output.finish(failureResult(
          'slide.convert.error',
          slideConvertErrorToReason(error),
          error,
          convertErrorDiagnostics(error),
        ))
      }
    },
  }
}

const slideSyncInput = z.object({
  dir: z.string()
    .describe('Absolute path of the talk-dir to sync. Relative paths are not accepted. ' + WINDOWS_PATH_NOTE),
  theme: z.string().optional()
    .describe('Theme the pre-migration talk-dir should reference: `git+https://<host>/<owner>/<repo>.git#<tag>` or `file:<absolute path>`. '
      + 'Required for a pre-migration talk-dir (one that holds a copy of the template). Not used for a migrated talk-dir'),
  node_modules_only: z.boolean().default(false)
    .describe('Only relink node_modules. The theme in package.json is fetched first, then linked (no network access if it is already fetched). '
      + 'A migrated talk-dir that references a theme behaves the same even when this is omitted. The generated files (vite.config.ts, start.mjs) are also aligned with the current content of the plugin. Cannot be specified together with theme'),
})

/**
移行前の talk-dir は、`theme` で指定したテーマを参照する形へ移す。
テンプレート由来のファイルを消し、作品領域 (slides.md / pages/*.md / public/slides/) は残す。
移行済みの talk-dir (`theme:` が依存のテーマを指す) は、package.json の依存の版でテーマを取得して node_modules を張り直す。
本体の生成ファイル (vite.config.ts・start.mjs) は本体の今の内容にそろえ、ほかのファイルは変えない。
*/
export function slideSyncTool(
  buildDependencies: () => SlideSyncDependencies = slideSyncDefaultDependencies,
  buildRuntimeDependencies: () => RuntimeDependencies = runtimeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_sync',
    config: {
      title: 'Sync Slidev deck',
      description: 'Syncs an existing talk-dir. '
        + 'A pre-migration talk-dir (one that holds a copy of the template; slide_dev and others stop with theme-none) '
        + 'is moved to a form that references the theme given by `theme`. Files that came from the template are deleted, '
        + 'and the work area (slides.md / pages/*.md / public/slides/) is kept. The deleted names are returned in migration.removed. '
        + 'A migrated talk-dir that references a theme (theme: in slides.md points to the theme in dependencies of package.json) '
        + 'fetches the theme at the version in the dependency and relinks node_modules, '
        + 'and aligns the generated files (vite.config.ts, start.mjs) with the current content of the plugin. Other files are left unchanged. '
        + 'To raise the theme version, rewrite the #<tag> of the dependency in package.json before calling. '
        + 'Returns the presentation categories (categories), the list of selectable layouts (layouts), '
        + 'and the lint result of the whole deck after the sync. A running slide_dev must be stopped with stop: true and started again.',
      inputSchema: slideSyncInput,
      outputSchema: slideSyncOutput,
      // テーマを git で取得しうるため openWorldHint は SDK 既定 (true) のまま。
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideSyncInput, arguments_, ['dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const input = validated.input

      // theme の file: の相対パスは、MCP プロセスのカレントを基準にしてしまうため、受け付けず絶対パスにそろえる。
      let theme: string | undefined
      if (input.theme !== undefined) {
        const normalized = normalizeThemeArgument(input.theme)
        if (!normalized.ok) {
          return toCallToolResult(failureResult('slide.sync.error', 'invalid-option', new Error(normalized.detail)))
        }
        theme = normalized.theme
      }

      // sync も node_modules を張り直すため、依存ルートの実体を要る。
      // 3 ツールで「未取得のときの失敗の型」を揃える (reason と event を同じにする)。
      const missingRuntime = ensureRuntimeDependencies('slide_sync', buildRuntimeDependencies())
      if (missingRuntime !== undefined) return toCallToolResult(missingRuntime)

      const output = captureCommandOutput()
      try {
        const dependencies: SlideSyncDependencies = {
          ...buildDependencies(),
          stdout: output.stdout,
          stderr: output.stderr,
        }
        const execution = await executeSlideSync(
          { dir: input.dir, nodeModulesOnly: input.node_modules_only, theme },
          dependencies,
        )
        return output.finish({
          ok: true,
          data: execution.data,
          message: syncSuccessMessage(execution.summary),
        })
      }
      catch (error: unknown) {
        return output.finish(failureResult(
          'slide.sync.error',
          slideSyncErrorToReason(error),
          error,
        ))
      }
    },
  }
}

function syncSuccessMessage(summary: Readonly<SlideSyncResultSummary>): string {
  const base = `slide_sync: succeeded (${summary.directory})`
  if (summary.theme === undefined) return base
  const themeText = `${base}; theme: ${summary.theme.name} (${summary.theme.spec})`
  return summary.mode === 'migrate'
    ? `${themeText}; migration: removed ${String(summary.removed.length)} files from the template (${summary.removed.join(', ')})`
    : themeText
}

const slideLintInput = z.object({
  dir: z.string()
    .describe('Absolute path of the talk-dir to lint. Relative paths are not accepted. ' + WINDOWS_PATH_NOTE),
})

/**
違反の検出は「報告が成果」なので、違反があっても成功で返す。
違反の有無は outcome の項目で読む。
*/
export function slideLintTool(
  buildDependencies: () => SlideLintDependencies = slideLintDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_lint',
    config: {
      title: 'Lint Slidev deck',
      description: 'Lints the whole talk-dir (pages/**/*.md and slides.md) '
        + 'and returns the list of violations. The call itself succeeds even with violations; outcome is violations when any are found.',
      inputSchema: slideLintInput,
      outputSchema: slideLintOutput,
      // 読み取りのみで何も書き換えず、ネットワークにも到達しない。
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideLintInput, arguments_, ['dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const input = validated.input

      const output = captureCommandOutput()
      try {
        const dependencies: SlideLintDependencies = {
          ...buildDependencies(),
          stdout: output.stdout,
          stderr: output.stderr,
        }
        const { summary, data } = await executeSlideLint({ dir: input.dir }, dependencies)
        const hasViolations = summary.outcome === 'violations'
        return output.finish({
          ok: true,
          data,
          message: hasViolations
            ? `slide_lint: violations found (${summary.directory}); ${String(summary.errorCount)} errors`
            + `; ${String(summary.warningCount)} warnings`
            : `slide_lint: succeeded (${summary.directory}); ${String(summary.lintedFileCount)} files linted`,
        })
      }
      catch (error: unknown) {
        return output.finish(failureResult(
          'slide.lint.error',
          slideLintErrorToReason(error),
          error,
        ))
      }
    },
  }
}

/**
slide 系 4 ツール。既定 deps ファクトリで組み立てる (登録は tools/index.ts が行う)。
*/
export function slideTools(): readonly ToolDefinition[] {
  return [slideCreateTool(), slideConvertTool(), slideSyncTool(), slideLintTool()]
}
