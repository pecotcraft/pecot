// drawio 系 MCP ツール (drawio_create / drawio_export)。
// deps はハンドラ内で組み立てる。

import { z } from 'zod'

import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  assertOutputExtension as assertDrawioExportOutputExtension,
  type DrawioExportExecution,
  drawioExportDefaultDependencies,
  errorToReason as drawioExportErrorToReason,
  executeDrawioExport,
} from '../../commands/drawio/export.js'
import {
  drawioUrlDefaultDependencies,
  errorData as drawioUrlErrorData,
  errorToReason as drawioUrlErrorToReason,
  executeDrawioUrl,
  type DrawioUrlExecution,
} from '../../commands/drawio/url.js'
import { createDiagnostics } from '../../diagnostics.js'
import { failureKindOf } from '../../domain/_shared/failure-kind.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { defaultIconRoot } from '../../infra/drawio/icons.js'
import { parsePathArguments, toCallToolResult, withoutCommonFailureFields, type FailedToolResult, type SucceededToolResult } from '../result.js'
import type { ToolDefinition, ToolCallContext } from '../server.js'
import {
  captureCommandOutput,
  chromiumDefaultDependencies,
  ensureChromium,
  failureDetailOf,
  formatError,
  MISSING_RUNTIME_OUTPUT_SHAPE,
  normalizeThemeArgument,
  PATH_REJECTION_OUTPUT_SHAPE,
  TEXT_VIOLATION_OUTPUT_SHAPE,
  toolOutputFields,
  WINDOWS_PATH_NOTE,
} from './_shared.js'

const drawioCreateInput = z.object({
  input_path: z.string().describe('Absolute path of the input .drawio file. ' + WINDOWS_PATH_NOTE),
  mode: z.enum(['view', 'edit']).describe('Purpose of the generated URL (view / edit). The generated URL is the same for both').default('view'),
  out_path: z.string().describe('Absolute path of the .html file to write the viewer HTML to (opening it redirects to draw.io). If omitted, only the URL is returned in url. ' + WINDOWS_PATH_NOTE).optional(),
  theme: z.string()
    .describe('Theme used to check the font and font size: `git+https://<host>/<owner>/<repo>.git#<tag>`, `file:<absolute path>`, '
      + 'or the absolute path of a talk-dir or a theme root. If omitted, the theme of the talk-dir is used when the diagram is under its `public/`; '
      + 'otherwise the built-in default (sans-serif) is used. When the diagram for a slide is placed outside the talk-dir, pass the absolute path of the talk-dir. '
      + WINDOWS_PATH_NOTE)
    .optional(),
  png: z.boolean().describe('Whether to also write a PNG as a sibling file (<out_path with the extension replaced by .png>) when out_path is given').default(true),
})

const drawioExportInput = z.object({
  input_path: z.string().describe('Absolute path of the input .drawio file. ' + WINDOWS_PATH_NOTE),
  icons_dir: z.string().describe('Absolute path of the root directory that resolves icon:// references. If omitted, <plugin-root>/assets/drawio-icons (the catalog bundled with the plugin) is used. Always specify it for diagrams that use a project-specific icon catalog (omitting it does not raise an error). ' + WINDOWS_PATH_NOTE).optional(),
  out_path: z.string().describe('Absolute path of the output SVG. If omitted, it is written to <input_path>.svg. The PDF is written to a sibling file (<out_path with the extension replaced by .pdf>). ' + WINDOWS_PATH_NOTE).optional(),
  print_hash: z.boolean().describe('Compute only the composite hash used for staleness checks, without exporting').default(false),
  pdf: z.boolean().describe('Whether to also write a PDF as a sibling file (<out_path with the extension replaced by .pdf>) alongside the SVG').default(true),
})

const drawioThemeFontsOutput = z.strictObject({
  body: z.array(z.string()).describe('Body fonts the labels are checked against'),
  eastAsian: z.string().optional().describe('East Asian font (omitted when the theme does not declare one)'),
})

const drawioThemeOutput = z.strictObject({
  source: z.enum(['talk-dir', 'option', 'default']).describe(
    'Where the theme came from: talk-dir (ancestor talk-dir of the diagram), option (theme argument), default (built-in default)',
  ),
  name: z.string().optional().describe('Package name of the theme (omitted for the built-in default)'),
  fonts: drawioThemeFontsOutput.describe('Fonts the labels are checked against'),
  fontSizes: z.strictObject({
    heading: z.number(),
    headingSm: z.number(),
    body: z.number(),
    bodySm: z.number(),
    label: z.number(),
  }).optional().describe('Font sizes (px) the labels are checked against (only when the theme came from a talk-dir or the theme argument)'),
})

const drawioCreateShape = {
  event: z.string().describe('drawio.url.done on success, drawio.url.error on failure (omitted when a path argument is rejected)'),
  url: z.string().optional().describe('Generated draw.io URL (success only, when out_path is omitted)'),
  file: z.string().optional().describe('Absolute path of the written viewer HTML (success only, when out_path is given)'),
  png: z.string().nullable().optional().describe(
    'Absolute path of the written PNG, or null when writing it failed (success only, when out_path is given and png is true)',
  ),
  pngFailed: z.boolean().optional().describe('Whether writing the PNG failed (success only, when out_path is given and png is true)'),
  theme: drawioThemeOutput.describe('Theme the font and font size were checked against (success only)'),
}
const drawioCreateOutput = toolOutputFields(drawioCreateShape, TEXT_VIOLATION_OUTPUT_SHAPE, PATH_REJECTION_OUTPUT_SHAPE)

const drawioExportShape = {
  event: z.string().describe(
    'drawio.export.done after exporting, drawio.export.hash with print_hash, drawio.export.error or chromium.unavailable on failure '
    + '(omitted when a path argument is rejected)',
  ),
  file: z.string().describe('Absolute path of the written SVG; with print_hash, the absolute path of the input (success only)'),
  sourceSha256: z.string().describe('Composite hash of the input and the referenced icons, used for staleness checks (success only)'),
  icons: z.number().describe('Number of icon:// references resolved (success only)'),
  pdf: z.string().nullable().optional().describe(
    'Absolute path of the written PDF, or null when no PDF was written (pdf is false or writing it failed; success only, not with print_hash)',
  ),
  pdfFailed: z.boolean().optional().describe('Whether writing the PDF failed (success only, not with print_hash)'),
}
const drawioExportOutput = toolOutputFields(drawioExportShape, MISSING_RUNTIME_OUTPUT_SHAPE, PATH_REJECTION_OUTPUT_SHAPE)

/**
message 末尾の警告件数サフィックス。drawio_create / drawio_export で表記を揃える。
*/
function warningSuffix(warningCount: number): string {
  return warningCount > 0 ? ` (${String(warningCount)} warnings; see warnings)` : ''
}

/**
実行層の `warnings` は件数。ツールでは warnings を捕捉した文の配列にするため、件数を外す。
*/
function withoutWarningCount(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { warnings: _count, ...rest } = data
  return rest
}

function drawioCreateMessage(outputFile: string | undefined, warningCount: number): string {
  const warnings = warningSuffix(warningCount)
  return outputFile === undefined
    ? `generated drawio URL${warnings}`
    : `wrote drawio viewer HTML to ${outputFile}${warnings}`
}

/**
chromium 不在で PNG を諦めたときの結果。PNG 生成の失敗は warning に格下げし、表示用 HTML は書く。

degrade できる条件はこれだけ。drawio_export と slide_convert は、chromium が無いと成果物を 1 つも作れない。
`png: null` / `pngFailed: true` / warning 1 件を返し、`runtime_setup` の誘導は message へ載せる。
*/
function degradeToPngSkipped(
  execution: Readonly<DrawioUrlExecution>,
  unavailable: Readonly<FailedToolResult>,
  warningCount: number,
): Pick<SucceededToolResult, 'data' | 'message'> {
  return {
    data: {
      ...withoutWarningCount(execution.data),
      // eslint-disable-next-line unicorn/no-null -- PNG 失敗時は png: null を返す契約
      png: null,
      pngFailed: true,
    },
    message: `${drawioCreateMessage(execution.outputFile, warningCount)}: ${unavailable.detail}`,
  }
}

const handleDrawioCreate = async (
  arguments_: Readonly<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は可変。EventTarget で addEventListener を呼ぶため readonly 化できない
  call: ToolCallContext,
): Promise<CallToolResult> => {
  const validated = parsePathArguments(drawioCreateInput, arguments_, ['input_path', 'out_path'])
  if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
  const input = validated.input

  // theme の file: とパスは、MCP サーバが読める絶対パスにそろえる。解釈できない値は実処理の前に弾く。
  const normalized = input.theme === undefined ? undefined : normalizeThemeArgument(input.theme, { allowPath: true })
  if (normalized?.ok === false) {
    const detail = normalized.detail
    return toCallToolResult({
      ok: false,
      kind: 'invalid-option',
      detail: `drawio_create: ${detail}`,
      data: { event: 'drawio.url.error' },
    })
  }

  // PNG を書くときだけ chromium が要る。out_path 省略時と png: false は URL 生成だけで完結する。
  const unavailable = input.out_path !== undefined && input.png
    ? await ensureChromium('drawio_create PNG output', chromiumDefaultDependencies(), call.signal)
    : undefined

  const output = captureCommandOutput()
  // PNG の失敗は warning の行に書き、warnings に入れる。
  if (unavailable !== undefined) createDiagnostics(output.stderr).warning(`PNG export failed: ${unavailable.detail}`)
  try {
    const execution = await executeDrawioUrl(
      input.input_path,
      // chromium が無いときは PNG を要求せずに実行する (表示用 HTML の生成は成立する)。
      { mode: input.mode, png: input.png && unavailable === undefined, theme: normalized?.theme, output: input.out_path },
      { ...drawioUrlDefaultDependencies(), stdout: output.stdout, stderr: output.stderr, signal: call.signal },
    )
    // 警告ありでも URL の生成そのものは完了しているので成功で返す。
    return output.finish({
      ok: true,
      data: withoutWarningCount(execution.data),
      message: drawioCreateMessage(execution.outputFile, output.warnings().length),
      ...(unavailable !== undefined && degradeToPngSkipped(execution, unavailable, output.warnings().length)),
    })
  }
  catch (error: unknown) {
    const data = drawioUrlErrorData(error)
    return output.finish({
      ok: false,
      kind: failureKindOf(drawioUrlErrorToReason(error)),
      detail: `drawio_create: ${failureDetailOf(error, data)}`,
      data: withoutCommonFailureFields(data),
    })
  }
}

const handleDrawioExport = async (
  arguments_: Readonly<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は可変。EventTarget で addEventListener を呼ぶため readonly 化できない
  call: ToolCallContext,
): Promise<CallToolResult> => {
  const validated = parsePathArguments(
    drawioExportInput,
    arguments_,
    ['input_path', 'icons_dir', 'out_path'],
  )
  if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
  const input = validated.input

  // 不正な out_path は Chromium の有無に関係なく UsageError で返す。
  // Chromium の確認を先にすると、未取得環境では引数の誤りより先に chromium-not-installed が返ってしまう。
  try {
    assertDrawioExportOutputExtension(input.out_path, { printHash: input.print_hash })
  }
  catch (error: unknown) {
    return toCallToolResult(drawioExportFailure(error))
  }

  // print_hash はハッシュ算出だけで export しないため chromium に触れない。
  if (!input.print_hash) {
    const unavailable = await ensureChromium('drawio_export', chromiumDefaultDependencies(), call.signal)
    if (unavailable !== undefined) return toCallToolResult(unavailable)
  }

  // 既定は plugin-root 同梱のカタログ。単体配布では npx の展開先 hash が環境ごとに変わる。
  // 呼び出し側が絶対パスを組み立てられないため、既定を持たないと実質呼べない。
  const iconsRoot = input.icons_dir ?? defaultIconRoot(resolvePluginRoot())

  const output = captureCommandOutput()
  try {
    const execution = await executeDrawioExport(
      input.input_path,
      { icons: iconsRoot, output: input.out_path, printHash: input.print_hash, pdf: input.pdf },
      { ...drawioExportDefaultDependencies(), stdout: output.stdout, stderr: output.stderr },
    )
    // PDF 生成の失敗という警告ありでも SVG の書き出しは完了しているので成功で返す。
    return output.finish({
      ok: true,
      data: withoutWarningCount(execution.data),
      message: drawioExportMessage(execution, output.warnings().length),
    })
  }
  catch (error: unknown) {
    return output.finish(drawioExportFailure(error))
  }
}

/**
drawio_export の失敗を ToolResult に写す。
*/
function drawioExportFailure(error: unknown): FailedToolResult {
  return {
    ok: false,
    kind: failureKindOf(drawioExportErrorToReason(error)),
    detail: `drawio_export: ${formatError(error)}`,
    data: { event: 'drawio.export.error' },
  }
}

function drawioExportMessage(execution: Readonly<DrawioExportExecution>, warningCount: number): string {
  if (execution.outputFile === undefined) return `computed composite hash: ${execution.sourceSha256}`
  const pdf = execution.pdfFile === undefined ? '' : ` (PDF: ${execution.pdfFile})`
  return `wrote SVG to ${execution.outputFile}${pdf}${warningSuffix(warningCount)}`
}

// 定義書の effects (destructive) と idempotent のとおりに明示する。openWorldHint は SDK 既定 (true) のまま。
export const drawioCreateTool: ToolDefinition = {
  name: 'drawio_create',
  config: {
    title: 'Create draw.io diagram',
    description: 'Turns drawio XML into a deliverable that opens directly in a browser. Writes viewer HTML (.html; opening it redirects to draw.io) to out_path and, by default, also writes a rendered PNG (useful for checking the rendering). icon:// references are resolved to data URIs and embedded. Before generating, it checks the diagram labels against the text rules and generates nothing if there is a violation. The font and font size are checked against the theme declaration (theme, or the theme of the talk-dir that is an ancestor of the diagram), and the result is returned in theme.',
    inputSchema: drawioCreateInput,
    outputSchema: drawioCreateOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  handler: handleDrawioCreate,
}

export const drawioExportTool: ToolDefinition = {
  name: 'drawio_export',
  config: {
    title: 'Export draw.io diagram',
    description: 'Exports drawio XML to a static SVG and a sibling PDF. Set pdf: false to suppress the PDF. With print_hash, it exports nothing and returns only the composite hash used for staleness checks. It does not check the diagram text, so pass a .drawio that has gone through drawio_create.',
    inputSchema: drawioExportInput,
    outputSchema: drawioExportOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  handler: handleDrawioExport,
}
