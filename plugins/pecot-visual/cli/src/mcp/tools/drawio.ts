// drawio 系 MCP ツール (drawio_create / drawio_export)。
//
// ハンドラは対応する CLI コマンドから抽出した execute<Cmd>() をそのまま呼ぶ。
// `--json` の data 組み立ては commands 側に一本化してある。
// そのため、ここに残るのは「MCP の引数 → CLI のオプション」と「実行結果 → ToolResult」の写像だけになる。
//
// deps はハンドラ内で毎回組み立てる。既定 deps ファクトリは CLAUDE_PLUGIN_ROOT 未設定で throw する。
// module top-level で評価すると、サーバ起動と tools/list がまとめて落ちる。

import { z } from 'zod'

import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  assertOutputExtension as assertDrawioExportOutputExtension,
  type DrawioExportExecution,
  drawioExportDefaultDependencies,
  errorToReason as drawioExportErrorToReason,
  executeDrawioExport,
  toExitCode as drawioExportToExitCode,
} from '../../commands/drawio/export.js'
import {
  drawioUrlDefaultDependencies,
  errorData as drawioUrlErrorData,
  executeDrawioUrl,
  toExitCode as drawioUrlToExitCode,
  type DrawioUrlExecution,
} from '../../commands/drawio/url.js'
import { createDiagnostics } from '../../diagnostics.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { defaultIconRoot } from '../../infra/drawio/icons.js'
import { parsePathArguments, toCallToolResult, type ToolResult } from '../result.js'
import type { ToolDefinition, ToolCallContext } from '../server.js'
import {
  captureCommandOutput,
  chromiumDefaultDependencies,
  ensureChromium,
  formatError,
  textViolationMessage,
  violationCountOf,
  normalizeThemeArgument,
  TOOL_OUTPUT_SCHEMA,
  WINDOWS_PATH_NOTE,
} from './_shared.js'

const drawioCreateInput = z.object({
  input_path: z.string().describe('入力 .drawio ファイルの絶対パス。' + WINDOWS_PATH_NOTE),
  mode: z.enum(['view', 'edit']).describe('生成する URL の用途 (view / edit)。生成される URL は同一').default('view'),
  out_path: z.string().describe('表示用 HTML を書き出す .html ファイル (開くと draw.io へリダイレクトする) の絶対パス。省略すると data.url で URL だけを返す。' + WINDOWS_PATH_NOTE).optional(),
  theme: z.string()
    .describe('書体と文字サイズを確かめるテーマの指定。`git+https://<host>/<owner>/<repo>.git#<tag>`・`file:<絶対パス>`・'
      + 'talk-dir かテーマ root の絶対パスのどれか。省略すると、図が talk-dir の `public/` の下にあればその talk-dir のテーマ、'
      + '無ければ本体の既定値（sans-serif）で確かめる。スライドに載せる図を talk-dir の外に置くときは、talk-dir の絶対パスを渡す。'
      + WINDOWS_PATH_NOTE)
    .optional(),
  png: z.boolean().describe('out_path 指定時に PNG を兄弟ファイル (<out_path の拡張子を .png に置換>) として同時出力するか').default(true),
})

const drawioExportInput = z.object({
  input_path: z.string().describe('入力 .drawio ファイルの絶対パス。' + WINDOWS_PATH_NOTE),
  icons_dir: z.string().describe('icon:// 参照を解決する root ディレクトリの絶対パス。省略時は <plugin-root>/assets/drawio-icons (プラグイン同梱カタログ) を使う。プロジェクト固有のアイコンカタログを使う図では必ず指定する (指定抜けはエラーにならない)。' + WINDOWS_PATH_NOTE).optional(),
  out_path: z.string().describe('出力 SVG の絶対パス。省略すると <input_path>.svg に書き出す。PDF は <out_path の拡張子を .pdf に置換> の兄弟ファイルへ書き出す。' + WINDOWS_PATH_NOTE).optional(),
  print_hash: z.boolean().describe('export せず、陳腐化判定用の合成ハッシュだけを算出する').default(false),
  pdf: z.boolean().describe('SVG と同時に PDF を兄弟ファイル (<out_path の拡張子を .pdf に置換>) として出力するか').default(true),
})

/**
PNG を出せなかったときの exit code。CLI の「警告あり」と同じ 3 に揃える。
*/
const PNG_SKIPPED_EXIT_CODE = 3

/**
message 末尾の警告件数サフィックス。drawio_create / drawio_export で表記を揃える。
*/
function warningSuffix(warningCount: number): string {
  return warningCount > 0 ? ` (警告 ${String(warningCount)} 件、詳細は stderr)` : ''
}

function drawioCreateMessage(outputFile: string | undefined, warningCount: number): string {
  const warnings = warningSuffix(warningCount)
  return outputFile === undefined
    ? `drawio URL を生成しました${warnings}`
    : `drawio の表示用 HTML を ${outputFile} に書き出しました${warnings}`
}

/**
chromium 不在で PNG を諦めたときの結果を、CLI の degrade と同形に寄せる (SC-002)。

CLI (`pecotv drawio url`) は PNG 生成の失敗を warning に格下げする。
表示用 HTML は書いたうえで、`png: null` / `pngFailed: true` / warnings +1 / exit 3 を返す。
MCP だけが実処理の前に hard-fail すると、CLI と結果が食い違う。
degrade できる条件はこれだけ。drawio_export と slide_convert は、chromium が無いと成果物を 1 つも作れない。
data は CLI の PNG 失敗時と同一にし、`setup` の誘導は message へ載せる。
*/
function degradeToPngSkipped(
  execution: Readonly<DrawioUrlExecution>,
  unavailable: Readonly<ToolResult>,
): Pick<ToolResult, 'exitCode' | 'data' | 'message'> {
  return {
    exitCode: PNG_SKIPPED_EXIT_CODE,
    data: {
      ...execution.data,
      // eslint-disable-next-line unicorn/no-null -- PNG 失敗時に png: null を返すことが CLI との契約
      png: null,
      pngFailed: true,
      warnings: execution.warningCount + 1,
    },
    message: `${drawioCreateMessage(execution.outputFile, execution.warningCount + 1)}: ${unavailable.message}`,
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
      exitCode: 2,
      artifacts: [],
      data: { event: 'drawio.url.error', reason: 'invalid-option', detail },
      message: `pecotv drawio url: ${detail}`,
    })
  }

  // PNG を書くときだけ chromium が要る。out_path 省略時と png: false は URL 生成だけで完結する。
  const unavailable = input.out_path !== undefined && input.png
    ? await ensureChromium('drawio_create の PNG 出力', chromiumDefaultDependencies(), call.signal)
    : undefined

  const output = captureCommandOutput()
  // CLI は capturePng の失敗を stderr へ書いてから warning に数える。
  // 同じ行を残して、「警告 N 件、詳細は stderr」という message を CLI と MCP で同じ意味にする。
  if (unavailable !== undefined) createDiagnostics(output.stderr).warning(`PNG 生成失敗: ${unavailable.message}`)
  try {
    const execution = await executeDrawioUrl(
      input.input_path,
      // chromium が無いときは PNG を要求せずに実行する (表示用 HTML の生成は成立する)。
      { mode: input.mode, png: input.png && unavailable === undefined, theme: normalized?.theme, output: input.out_path },
      { ...drawioUrlDefaultDependencies(), stdout: output.stdout, stderr: output.stderr, signal: call.signal },
    )
    // 警告あり (exitCode 3) でも URL の生成そのものは完了しているので ok: true。
    const result: ToolResult = {
      ok: true,
      exitCode: execution.exitCode,
      artifacts: execution.artifacts,
      data: execution.data,
      message: drawioCreateMessage(execution.outputFile, execution.warningCount),
      ...(unavailable !== undefined && degradeToPngSkipped(execution, unavailable)),
      ...output.part(),
    }
    return toCallToolResult(result)
  }
  catch (error: unknown) {
    const data = drawioUrlErrorData(error)
    const violationCount = violationCountOf(data)
    const result: ToolResult = {
      ok: false,
      exitCode: drawioUrlToExitCode(error),
      artifacts: [],
      data,
      message: violationCount === undefined ? `pecotv drawio url: ${formatError(error)}` : textViolationMessage(violationCount),
      ...output.part(),
    }
    return toCallToolResult(result)
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
    // 警告あり (exitCode 3。PDF 生成失敗) でも SVG の書き出しは完了しているので ok: true。
    const result: ToolResult = {
      ok: true,
      exitCode: execution.exitCode,
      artifacts: execution.artifacts,
      data: execution.data,
      message: drawioExportMessage(execution),
      ...output.part(),
    }
    return toCallToolResult(result)
  }
  catch (error: unknown) {
    return toCallToolResult({ ...drawioExportFailure(error), ...output.part() })
  }
}

/**
drawio_export の失敗を CLI の `--json` エラーと同形の ToolResult に写す。
*/
function drawioExportFailure(error: unknown): ToolResult {
  const detail = formatError(error)
  return {
    ok: false,
    exitCode: drawioExportToExitCode(error),
    artifacts: [],
    data: { event: 'drawio.export.error', reason: drawioExportErrorToReason(error), detail },
    message: `pecotv drawio export: ${detail}`,
  }
}

function drawioExportMessage(execution: Readonly<DrawioExportExecution>): string {
  if (execution.outputFile === undefined) return `合成ハッシュを算出しました: ${execution.sourceSha256}`
  const pdf = execution.pdfFile === undefined ? '' : ` (PDF: ${execution.pdfFile})`
  return `SVG を ${execution.outputFile} に書き出しました${pdf}${warningSuffix(execution.warningCount)}`
}

// annotations は SDK 既定 (readOnlyHint: false / openWorldHint: true) と一致するため付けない。
// どちらのツールもファイルを書き、PNG 生成では viewer.diagrams.net、SVG 生成では embed.diagrams.net へ到達する。
export const drawioCreateTool: ToolDefinition = {
  name: 'drawio_create',
  config: {
    title: 'drawio 図の成果物出力',
    description: 'drawio XML をブラウザでそのまま開ける成果物にする。out_path へ表示用 HTML (.html。開くと draw.io へリダイレクトする) を書き出し、標準で実描画 PNG も同時出力する (描画結果の確認に使える)。icon:// 参照は data URI に解決して埋め込む。生成前に図のラベルを文章規則で確認し、違反があれば生成しない。書体と文字サイズはテーマの宣言（theme、または図の祖先の talk-dir のテーマ）で確認し、結果を data.theme に返す。',
    inputSchema: drawioCreateInput,
    outputSchema: TOOL_OUTPUT_SCHEMA,
  },
  handler: handleDrawioCreate,
}

export const drawioExportTool: ToolDefinition = {
  name: 'drawio_export',
  config: {
    title: 'drawio SVG / PDF export',
    description: 'drawio XML を静的 SVG と兄弟の PDF に export する。pdf: false で PDF を抑止する。print_hash 指定時は export せず陳腐化判定用の合成ハッシュだけを返す。図の文言は確かめないので、drawio_create を通した .drawio を渡す。',
    inputSchema: drawioExportInput,
    outputSchema: TOOL_OUTPUT_SCHEMA,
  },
  handler: handleDrawioExport,
}
