// MCP ツール定義のうち slide 系 4 件 (slide_create / slide_convert / slide_sync / slide_lint)。
//
// 各ハンドラは対応する CLI コマンドの execute<Cmd>() を呼ぶだけで、実処理と `--json` の
// data 組み立ては commands/ 側の単一実装を共有する。CLI と MCP で結果が食い違わないようにする
// ための構造で、ハンドラ側には「引数の写像」と「ToolResult への正規化」しか置かない。
//
// deps は必ずハンドラ内で組み立てる。
// 既定 deps ファクトリは CLAUDE_PLUGIN_ROOT 未設定で throw する。
// モジュール top-level や allTools() 評価時に組み立てると tools/list ごと落ちる。
// stdout / stderr は MCP のプロセス stdout が JSON-RPC 専有なので、必ず捕捉先へ差し替える。

import path from 'node:path'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  errorToReason as slideCreateErrorToReason,
  executeSlideCreate,
  slideCreateDefaultDependencies,
  toExitCode as slideCreateExitCode,
} from '../../commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../commands/slidev-project/create.js'
import {
  errorToReason as slideLintErrorToReason,
  executeSlideLint,
  slideLintDefaultDependencies,
  toExitCode as slideLintExitCode,
} from '../../commands/slidev-project/lint.js'
import type { SlideLintDependencies } from '../../commands/slidev-project/lint.js'
import {
  errorToReason as slideSyncErrorToReason,
  executeSlideSync,
  slideSyncDefaultDependencies,
  toExitCode as slideSyncExitCode,
} from '../../commands/slidev-project/sync.js'
import type { SlideSyncDependencies, SlideSyncResultSummary } from '../../commands/slidev-project/sync.js'
import {
  convertErrorDiagnostics,
  errorToReason as slideConvertErrorToReason,
  executeSlideConvert,
  resolveDefaultOut,
  slideConvertDefaultDependencies,
  toExitCode as slideConvertExitCode,
} from '../../commands/slidev-to-pptx/convert.js'
import type {
  SlideConvertDependencies,
  SlideConvertOptions,
} from '../../commands/slidev-to-pptx/convert.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { ToolResult } from '../result.js'
import type { ToolContext, ToolDefinition, ToolCallContext } from '../server.js'
import {
  captureCommandOutput,
  chromiumDefaultDependencies,
  ensureChromium,
  ensureRuntimeDependencies,
  formatError,
  normalizeThemeArgument,
  runtimeDefaultDependencies,
  TOOL_OUTPUT_SCHEMA,
  WINDOWS_PATH_NOTE,
  type RuntimeDependencies,
} from './_shared.js'

/**
失敗時の ToolResult。data は対応する CLI コマンドの `--json` error payload と同形にする。
*/
function failureResult(
  event: string,
  reason: string,
  exitCode: number,
  error: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Omit<ToolResult, 'stdout' | 'stderr'> {
  const detail = formatError(error)
  return {
    ok: false,
    exitCode,
    artifacts: [],
    data: { event, reason, detail, ...extra },
    message: detail,
  }
}

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
`pecotv slide create` 相当。`theme` で指定したテーマを参照する Slidev プロジェクトを生成し、
生成直後のデッキ全体 lint 結果を data に載せて返す (lint 違反は成否に影響しない)。
*/
export function slideCreateTool(
  buildDependencies: () => SlideCreateDependencies = slideCreateDefaultDependencies,
  buildRuntimeDependencies: () => RuntimeDependencies = runtimeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_create',
    config: {
      title: 'Generate a Slidev project',
      description: 'Generates a new talk-dir that references the Slidev theme given by `theme`. '
        + 'The theme is specified by a git URL with a tag (`git+https://<host>/<owner>/<repo>.git#<tag>`) '
        + 'or a local path (`file:<path>`). '
        + 'Returns the presentation categories (data.categories) and the list of selectable layouts (data.layouts). '
        + 'Also returns the lint result of the whole deck right after generation (generation counts as successful even with lint violations).',
      inputSchema: slideCreateInput,
      outputSchema: TOOL_OUTPUT_SCHEMA,
      // git でテーマを取得するため、ネットワークに到達しうる。openWorldHint は明示しない（SDK の既定）。
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideCreateInput, arguments_, ['project_dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const input = validated.input

      const normalized = normalizeThemeArgument(input.theme)
      if (!normalized.ok) {
        return toCallToolResult({
          ...failureResult('slide.create.error', 'invalid-option', 2, new Error(normalized.detail)),
          stdout: '',
          stderr: '',
        })
      }

      // 生成の最後に行う node_modules の張り直しは依存ルートの実体を要る。実処理より前に見る。
      // 見ずに進むと、テーマの取得 (git) を終えた後で symlink-failed になり、setup の案内も出ない。
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
          // 同じ元データは data.layouts に構造化して載る。
          { theme: normalized.theme, force: input.force, emitCatalog: false },
          dependencies,
        )
        return toCallToolResult({
          ok: true,
          exitCode: 0,
          artifacts: [execution.summary.projectDirectory],
          data: execution.data,
          message: `slide create: succeeded (${execution.summary.projectDirectory})`,
          ...output.part(),
        })
      }
      catch (error: unknown) {
        return toCallToolResult({
          ...failureResult(
            'slide.create.error',
            slideCreateErrorToReason(error),
            slideCreateExitCode(error),
            error,
          ),
          ...output.part(),
        })
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
`pecotv slide convert` 相当。`slidev build` と in-process pipeline を起動するため、11 ツールの中で最も長時間かかる。
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
      outputSchema: TOOL_OUTPUT_SCHEMA,
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
      // 未取得なら `setup` を案内して実行前に返す。
      const missingRuntime = ensureRuntimeDependencies('slide_convert', buildRuntimeDependencies())
      if (missingRuntime !== undefined) return toCallToolResult(missingRuntime)

      // pipeline が chromium を起こすため、未取得なら実行前に返す。
      const unavailable = await ensureChromium('slide_convert', chromiumDefaultDependencies(), call.signal)
      if (unavailable !== undefined) return toCallToolResult(unavailable)

      const output = captureCommandOutput()
      try {
        // json: false 相当で呼び、output の stdout / stderr へ集める。
        // 進捗の人間可読ログは stderr の診断行 (note / warning / error) で出るので、ToolResult の stderr に入る。
        // stdout には変換結果の要約だけが入る。
        // MCP サーバの process.stdout は JSON-RPC 専有なので、実 stdout へは何も書かせない。
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
          json: false,
          cache: input.cache,
          ...(input.theme !== undefined && { theme: input.theme }),
          ...(input.spacing_json_path !== undefined && { spacingJson: input.spacing_json_path }),
          ...(input.href_json_path !== undefined && { hrefJson: input.href_json_path }),
          ...(input.transition_type !== undefined && { transitionType: input.transition_type }),
          ...(input.transition_duration_ms !== undefined && { transitionDurationMs: input.transition_duration_ms }),
          ...(input.morph_option !== undefined && { morphOption: input.morph_option }),
        }
        const execution = await executeSlideConvert(input.project_dir, options, dependencies)
        return toCallToolResult({
          ok: true,
          exitCode: 0,
          artifacts: [execution.summary.outputAbs],
          data: execution.data,
          message: `slide convert: ${execution.summary.inputAbs} -> ${execution.summary.outputAbs}`
            + ` (${String(Math.round(execution.summary.durationMs))}ms)`,
          ...output.part(),
        })
      }
      catch (error: unknown) {
        return toCallToolResult({
          ...failureResult(
            'slide.convert.error',
            slideConvertErrorToReason(error),
            slideConvertExitCode(error),
            error,
            convertErrorDiagnostics(error),
          ),
          ...output.part(),
        })
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
`pecotv slide sync` 相当。移行前の talk-dir は、`theme` で指定したテーマを参照する形へ移す。
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
      title: 'Sync a Slidev talk-dir',
      description: 'Syncs an existing talk-dir. '
        + 'A pre-migration talk-dir (one that holds a copy of the template; slide_dev and others stop with theme-none) '
        + 'is moved to a form that references the theme given by `theme`. Files that came from the template are deleted, '
        + 'and the work area (slides.md / pages/*.md / public/slides/) is kept. The deleted names are returned in data.migration.removed. '
        + 'A migrated talk-dir that references a theme (theme: in slides.md points to the theme in dependencies of package.json) '
        + 'fetches the theme at the version in the dependency and relinks node_modules, '
        + 'and aligns the generated files (vite.config.ts, start.mjs) with the current content of the plugin. Other files are left unchanged. '
        + 'To raise the theme version, rewrite the #<tag> of the dependency in package.json before calling. '
        + 'Returns the presentation categories (data.categories), the list of selectable layouts (data.layouts), '
        + 'and the lint result of the whole deck after the sync. A running slide_dev must be stopped with stop: true and started again.',
      inputSchema: slideSyncInput,
      outputSchema: TOOL_OUTPUT_SCHEMA,
      // theme を渡したときと、node_modules_only・移行済みの talk-dir の通常の sync は、テーマを git で取得しうるため、ネットワークに到達しうる。
      // openWorldHint は明示しない（SDK の既定）。
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
          return toCallToolResult({
            ...failureResult('slide.sync.error', 'invalid-option', 2, new Error(normalized.detail)),
            stdout: '',
            stderr: '',
          })
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
        return toCallToolResult({
          ok: true,
          exitCode: 0,
          artifacts: [execution.summary.directory],
          data: execution.data,
          message: syncSuccessMessage(execution.summary),
          ...output.part(),
        })
      }
      catch (error: unknown) {
        return toCallToolResult({
          ...failureResult(
            'slide.sync.error',
            slideSyncErrorToReason(error),
            slideSyncExitCode(error),
            error,
          ),
          ...output.part(),
        })
      }
    },
  }
}

function syncSuccessMessage(summary: Readonly<SlideSyncResultSummary>): string {
  const base = `slide sync: succeeded (${summary.directory})`
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
`pecotv slide lint` 相当。違反の検出は「報告が成果」なので ok: true / exitCode 1 で返す
(CLI の exit code 規約は exitCode 側に載せ、ok は目的の実行を完了できたかだけを表す)。
*/
export function slideLintTool(
  buildDependencies: () => SlideLintDependencies = slideLintDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_lint',
    config: {
      title: 'Lint a Slidev deck',
      description: 'Lints the whole talk-dir (pages/**/*.md and slides.md) '
        + 'and returns the list of violations. The call itself succeeds (exitCode 1) even with violations.',
      inputSchema: slideLintInput,
      outputSchema: TOOL_OUTPUT_SCHEMA,
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
        return toCallToolResult({
          ok: true,
          exitCode: hasViolations ? 1 : 0,
          artifacts: [],
          data,
          message: hasViolations
            ? `slide lint: violations found (${summary.directory}); ${String(summary.errorCount)} errors`
            + `; ${String(summary.warningCount)} warnings`
            : `slide lint: succeeded (${summary.directory}); ${String(summary.lintedFileCount)} files linted`,
          ...output.part(),
        })
      }
      catch (error: unknown) {
        return toCallToolResult({
          ...failureResult(
            'slide.lint.error',
            slideLintErrorToReason(error),
            slideLintExitCode(error),
            error,
          ),
          ...output.part(),
        })
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
