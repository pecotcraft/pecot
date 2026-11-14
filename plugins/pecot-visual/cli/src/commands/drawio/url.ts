// `pecotv drawio url <input.drawio> [--mode view|edit] [--theme <spec>] [--json]` の実装。
// slidev-project/create.ts と同形の DI / 二段例外 / writeErr フックを採用する。
//
// exit code 規約:
//   0 = success (warnings なし)。
//   1 = RuntimeError (input/output IO failure、文面の違反、文章規則の判定の失敗、解けないテーマ)。
//   2 = UsageError (invalid option / -o の拡張子が .html でない / テーマの指定の誤り)。
//   3 = warnings present (validateHtml の warning or icon resolver warn が 1 件以上)。

/* eslint-disable security/detect-non-literal-fs-filename -- input は CLI 引数として受理する想定。信頼境界外だが open API 仕様 */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { performance } from 'node:perf_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'

import { collectTextViolations, formatTextViolations } from '../../domain/_shared/text-check.js'
import type { LintText, TextViolation } from '../../domain/_shared/text-check.js'
import { siblingPath } from '../../domain/drawio/export.js'
import { labelTexts } from '../../domain/drawio/label-text.js'
import type { DrawioFinding } from '../../domain/drawio/url.js'
import { generateDrawioUrl, generateDrawioViewerUrl, prepareDrawioXml, renderRedirectHtml, validateHtml, validateSlideFonts, validateSlideFontSizes, validateWhitespaceWrap } from '../../domain/drawio/url.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import { ThemeSpecError } from '../../domain/slidev-theme/theme-spec.js'
import { pluginDependencyRoot } from '../../infra/_shared/dependency-root.js'
import { createIconResolver, defaultIconRoot } from '../../infra/drawio/icons.js'
import { capturePng } from '../../infra/drawio/screenshot.js'
import type { fetchTheme } from '../../infra/slidev-theme/store.js'
import { defaultLintText } from '../../infra/text-lint.js'
import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import { DrawioUrlRuntimeError, DrawioUrlUsageError } from './errors.js'
import { resolveDrawioTheme, themeData, themeFontNames } from './theme.js'
import type { DrawioTheme } from './theme.js'

export { DrawioUrlRuntimeError, DrawioUrlUsageError } from './errors.js'

const VALID_MODES: ReadonlySet<string> = new Set(['view', 'edit'])

export interface DrawioUrlOptions {
  readonly mode: 'view' | 'edit'
  readonly png: boolean
  /**
  書体・文字サイズを確かめるテーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>`・`file:<path>`・
  talk-dir かテーマ root のパス）。省略時は図の祖先の talk-dir、無ければ本体の既定値。
  */
  readonly theme?: string | undefined
  /**
  `-o/--output` の指定値。省略時は URL をファイルに書き出さない。
  */
  readonly output?: string | undefined
  /**
  `--json` を選んだか。出力表現の分岐にしか使わず、実行内容には影響しない。
  */
  readonly json?: boolean
}

export interface DrawioUrlDependencies {
  readonly pluginRoot: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly readFile: (filePath: string) => Promise<string>
  readonly writeFile: (filePath: string, content: string) => Promise<void>
  /**
  fonts は PNG のページが読み込む書体名（テーマの宣言の本文の書体と和文の書体）。
  */
  readonly capturePng: (xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>
  readonly lintText: LintText
  readonly now: () => number
  /**
  デッキの node_modules に張る項目の元になる依存ルート。テーマの取得に渡す。省略時は pluginRoot。
  */
  readonly dependencyRoot?: string
  /**
  テーマの package.json・宣言を読む port。省略時は実ファイルを読む。
  */
  readonly files?: ThemeFiles
  /**
  テーマを取得する port。省略時は infra の実装。
  */
  readonly fetchTheme?: typeof fetchTheme
  /**
  テーマの置き場を返す port。省略時はデータ置き場の `themes/`。
  */
  readonly themeStoreRoot?: () => string | undefined
  /**
  `--theme` の相対パスを絶対化する基準。省略時はカレント。
  */
  readonly currentDirectory?: string
  /**
  テーマの取得を中断する signal（MCP のキャンセル）。
  */
  readonly signal?: AbortSignal
}

// runDrawioUrl の戻り型は action 内部の中継用で公開 API ではない。
// `viewerUrl` は --json 等の対外出力には載せないが、ブラウザで直接開く URL として保持する。
// `resolvedXml` は prepareDrawioXml 済（コメント除去 + icon:// を data URI に変換）の XML。
// PNG 生成 (viewer.diagrams.net での描画) に渡すための internal field。URL 生成と
// 同一の XML を渡すことで、embed editor が pecotv 独自スキームを解決できなくても正しい
// アイコンが描画される。
interface DrawioUrlResultSummary {
  readonly url: string
  readonly viewerUrl: string
  readonly resolvedXml: string
  readonly inputFile: string
  readonly mode: 'view' | 'edit'
  readonly durationMs: number
  readonly warningCount: number
  readonly theme: DrawioTheme
}

export async function runDrawioUrl(
  inputFile: string,
  options: Readonly<DrawioUrlOptions>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write は可変。DI 経由の write は mutate メソッド
  dependencies: DrawioUrlDependencies,
): Promise<DrawioUrlResultSummary> {
  const start = dependencies.now()
  const diagnostics = createDiagnostics(dependencies.stderr)
  const absolute = path.resolve(inputFile)

  let xml: string
  try {
    xml = await dependencies.readFile(absolute)
  }
  catch (error: unknown) {
    throw new DrawioUrlRuntimeError(
      `cannot read input file: ${absolute}: ${formatError(error)}`,
      'input-not-found',
    )
  }

  const trimmed = xml.trim()

  // 書体・文字サイズを確かめる宣言を決める。解けないテーマは、成果物を作る前にここで止める。
  const theme = await resolveDrawioTheme(
    absolute,
    options.theme,
    dependencies,
    (message) => { diagnostics.note(message) },
  )

  // 文面の違反があれば、警告の確認や成果物の生成より前に止める
  await assertLabelsClean(trimmed, dependencies.lintText)

  let warningCount = 0

  // 診断のうち、exit code に反映するのは warning だけ。
  // note (fontColor 二重指定など) は stderr に流すが、exit code には影響させない。
  // 書体は常に確かめる。5 段のサイズは、テーマが決まったとき（talk-dir の中か --theme 指定）だけ確かめる。
  const { fontSizes } = theme
  const validators: readonly ((xml: string) => readonly DrawioFinding[])[] = [
    validateHtml,
    validateWhitespaceWrap,
    value => validateSlideFonts(value, theme.fonts, theme.name),
    ...(fontSizes === undefined ? [] : [(value: string) => validateSlideFontSizes(value, fontSizes)]),
  ]
  for (const validate of validators) {
    for (const finding of validate(trimmed)) {
      if (finding.severity === 'warning') {
        diagnostics.warning(finding.message)
        warningCount += 1
      }
      else {
        diagnostics.note(finding.message)
      }
    }
  }

  // pluginRoot は env 必須の deps のまま据え置く。
  // 既定の icons root を resolvePluginRoot() へ寄せたのは drawio_export だけで、これは意図した保留。
  // このため CLAUDE_PLUGIN_ROOT 無しで直接起動すると、drawio_export は動くが、
  // drawio_create は deps の構築時に失敗する。この差が残っている。
  const iconRoot = defaultIconRoot(dependencies.pluginRoot)
  // 同一メッセージ (= 未解決アイコン 1 種) は初回だけ報告する。色付き解決に失敗した
  // 参照が色を落としたフォールバック表記で色なし regex に再ヒットし、同じ警告が
  // 二重に届くため。
  const reportedIconWarnings = new Set<string>()
  const resolveIcon = createIconResolver(iconRoot, {
    warn: (message: string) => {
      if (reportedIconWarnings.has(message)) return
      reportedIconWarnings.add(message)
      diagnostics.warning(message)
      warningCount += 1
    },
  })

  const resolvedXml = prepareDrawioXml(trimmed, resolveIcon)
  const url = generateDrawioUrl(resolvedXml, { mode: options.mode })
  const viewerUrl = generateDrawioViewerUrl(resolvedXml)

  return {
    url,
    viewerUrl,
    resolvedXml,
    inputFile: absolute,
    mode: options.mode,
    durationMs: dependencies.now() - start,
    warningCount,
    theme,
  }
}

/**
図のラベルを文章規則で確認し、違反があれば全件を載せて投げる。
判定器の失敗は text-lint-failed にする。
*/
async function assertLabelsClean(xml: string, lintText: LintText): Promise<void> {
  let violations: readonly TextViolation[]
  try {
    violations = await collectTextViolations(labelTexts(xml), lintText)
  }
  catch (error: unknown) {
    throw new DrawioUrlRuntimeError(
      `text rules check failed: ${formatError(error)}`,
      'text-lint-failed',
    )
  }
  if (violations.length > 0) {
    throw new DrawioUrlRuntimeError(formatTextViolations(violations), 'text-violation', violations)
  }
}

/**
executeDrawioUrl の結果。CLI の表示分岐と MCP ツールの ToolResult 組み立ては
どちらもこれだけを見る（`data` の組み立てを両側に複製しないための共有点）。
*/
export interface DrawioUrlExecution {
  /**
  `--json` 成功時に stdout へ出す JSON と同形。
  */
  readonly data: Readonly<Record<string, unknown>>
  /**
  生成したファイルの絶対パス（表示用 HTML・PNG）。
  */
  readonly artifacts: readonly string[]
  /**
  検出した警告の件数。`data.warnings` と同値。
  */
  readonly warningCount: number
  /**
  exit code 規約に沿った値。警告が 1 件でもあれば 3、それ以外は 0。
  */
  readonly exitCode: number
  /**
  生成した URL。`--json` 無しで `-o` 無しのときに、stdout へ出す。
  */
  readonly url: string
  /**
  `-o` を解決した絶対パス。未指定なら undefined。
  */
  readonly outputFile: string | undefined
}

/**
URL 生成から出力ファイル・PNG の書き出しまでを実行し、`--json` の data 同形を組み立てる。

呼び出し元（commander action / MCP ツール）に残るのは「どう見せるか」だけで、
出力先の解決・PNG の兄弟ファイル命名・警告件数の集計はすべてここに閉じる。
*/
export async function executeDrawioUrl(
  inputFile: string,
  options: Readonly<DrawioUrlOptions>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write は可変。DI 経由の write は mutate メソッド
  dependencies: DrawioUrlDependencies,
): Promise<DrawioUrlExecution> {
  const outputFile = options.output === undefined || options.output === ''
    ? undefined
    : path.resolve(options.output)

  // 書き出すのは表示用 HTML だけなので、それ以外の拡張子は成果物を作る前に弾く。
  // 入力の読み込みより先に確認し、UsageError のときは成果物と警告を残さない。
  if (outputFile !== undefined && path.extname(outputFile).toLowerCase() !== '.html') {
    throw new DrawioUrlUsageError(
      `-o accepts only the .html extension: ${outputFile}`,
      'invalid-output-extension',
    )
  }

  const summary = await runDrawioUrl(inputFile, options, dependencies)
  const diagnostics = createDiagnostics(dependencies.stderr)
  let warningCount = summary.warningCount
  const artifacts: string[] = []

  let payload: Record<string, unknown>
  if (outputFile === undefined) {
    payload = { url: summary.url }
  }
  else {
    try {
      // 開くと draw.io URL へリダイレクトする表示用 HTML。OS を問わずダブルクリックで図が開く。
      await dependencies.writeFile(outputFile, renderRedirectHtml(summary.url))
    }
    catch (error: unknown) {
      throw new DrawioUrlRuntimeError(
        `cannot write output file: ${outputFile}: ${formatError(error)}`,
        'output-write-failed',
      )
    }
    artifacts.push(outputFile)

    if (options.png) {
      // PNG は表示用 HTML の拡張子を `.png` に置換した兄弟ファイルとして配置する。
      const pngPath = siblingPath(outputFile, '.png')
      let isPngFailed = false
      try {
        await dependencies.capturePng(summary.resolvedXml, pngPath, themeFontNames(summary.theme))
        artifacts.push(pngPath)
      }
      catch (error: unknown) {
        diagnostics.warning(`PNG export failed: ${formatError(error)}`)
        warningCount += 1
        isPngFailed = true
      }
      payload = {
        file: outputFile,
        // eslint-disable-next-line unicorn/no-null -- JSON スキーマで PNG 失敗時に `png: null` を pin したいため
        png: isPngFailed ? null : pngPath,
        pngFailed: isPngFailed,
      }
    }
    else {
      payload = { file: outputFile }
    }
  }

  return {
    data: { event: 'drawio.url.done', ...payload, warnings: warningCount, theme: themeData(summary.theme) },
    artifacts,
    warningCount,
    exitCode: warningCount > 0 ? 3 : 0,
    url: summary.url,
    outputFile,
  }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

/**
失敗の reason。テーマの解決・取得・宣言・指定の失敗は `theme-<reason>`（`themeErrorReason`）にする。
*/
export function errorToReason(error: unknown): FailureReason {
  if (error instanceof DrawioUrlUsageError) return error.reason
  if (error instanceof DrawioUrlRuntimeError) return error.reason
  return themeErrorReason(error) ?? 'unknown'
}

/**
`--json` のエラーイベントと MCP の data に載せる内容。CLI と MCP が同じ組み立てを使う。
*/
export function errorData(error: unknown): Readonly<Record<string, unknown>> {
  const violations = error instanceof DrawioUrlRuntimeError ? error.violations : undefined
  return {
    event: 'drawio.url.error',
    reason: errorToReason(error),
    detail: formatError(error),
    ...(violations !== undefined && { violations }),
  }
}

/**
例外を exit code 規約へ写す（2 = UsageError とテーマの指定の誤り、1 = それ以外）。

CLI の action と MCP ツールが同じ対応表を使うための共有点。
*/
export function toExitCode(error: unknown): number {
  // 呼び出し元に届くのは次のとおり。
  // runDrawioUrl / executeDrawioUrl 由来の RuntimeError と、テーマの解決・取得・宣言の失敗（exit 1）。
  // 出力拡張子の確認とテーマのパスの確認が投げる UsageError、テーマの指定の誤り（ThemeSpecError）は exit 2。
  // parseMode の UsageError だけは、呼び出し側 (action の options 組み立て) で処理済。
  return error instanceof DrawioUrlUsageError || error instanceof ThemeSpecError ? 2 : 1
}

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

function parseMode(raw: unknown): 'view' | 'edit' {
  if (typeof raw !== 'string' || !VALID_MODES.has(raw)) {
    throw new DrawioUrlUsageError(
      `option --mode accepts only view or edit: ${String(raw)}`,
      'invalid-mode',
    )
  }
  return raw === 'edit' ? 'edit' : 'view'
}

export function createDrawioUrlCommand(buildDependencies: () => DrawioUrlDependencies): Command {
  const command = new Command('url')
    .description('turn drawio XML into artifacts that open directly in a browser (viewer HTML / rendered PNG)')
    .argument('<input>', 'input .drawio file path')
    .option('--mode <mode>', 'view or edit (cli-surface §2.4; the generated URL is the same)', 'view')
    .option('-o, --output <path>', 'output path of the viewer HTML (.html only; when given, no URL is printed to stdout)')
    .option('--json', 'print machine-readable JSON to stdout', false)
    .option('--theme <spec>', 'theme used to check fonts and font sizes (git+https://<host>/<owner>/<repo>.git#<tag>, file:<path>, or a talk-dir or theme root path); default: the diagram\'s ancestor talk-dir, else the plugin default')
    .option('--no-png', 'do not write the PNG alongside -o (default: write the PNG)', true)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'drawio.url.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:[ \t]*/i, '').trim(),
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
      writeOut: (string_: string) => { writeData(buildDependencies().stdout, string_) },
    })
    .action(async (input: string, raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      let options: DrawioUrlOptions
      try {
        options = {
          mode: parseMode(raw['mode']),
          json: raw['json'] === true,
          png: raw['png'] !== false,
          theme: typeof raw['theme'] === 'string' ? raw['theme'] : undefined,
          output: typeof raw['output'] === 'string' ? raw['output'] : undefined,
        }
      }
      catch (error: unknown) {
        if (raw['json'] === true) {
          writeData(dependencies.stdout, JSON.stringify(errorData(error)))
        }
        else {
          createDiagnostics(dependencies.stderr).error(formatError(error))
        }
        process.exitCode = 2
        return
      }

      try {
        const execution = await executeDrawioUrl(input, options, dependencies)
        if (options.json) {
          writeData(dependencies.stdout, JSON.stringify(execution.data))
        }
        else if (execution.outputFile === undefined) {
          writeData(dependencies.stdout, execution.url)
        }
        else {
          createDiagnostics(dependencies.stderr).done({ verb: 'create', target: execution.outputFile })
        }
        if (execution.exitCode !== 0) {
          process.exitCode = execution.exitCode
        }
      }
      catch (error: unknown) {
        if (options.json) {
          writeData(dependencies.stdout, JSON.stringify(errorData(error)))
        }
        else {
          createDiagnostics(dependencies.stderr).error(formatError(error))
        }
        process.exitCode = toExitCode(error)
      }
    })
  return command
}

export function drawioUrlDefaultDependencies(): DrawioUrlDependencies {
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
  /* c8 ignore next 3 -- bin/pecotv が CLAUDE_PLUGIN_ROOT を必ず export する。未設定は実運用で発生しない */
  if (pluginRoot === undefined || pluginRoot === '') {
    throw new DrawioUrlRuntimeError('CLAUDE_PLUGIN_ROOT is not set', 'unknown')
  }
  const dependencyRoot = pluginDependencyRoot()
  return {
    pluginRoot,
    ...(dependencyRoot !== undefined && { dependencyRoot }),
    stdout: process.stdout,
    stderr: process.stderr,
    readFile: (filePath: string) => readFile(filePath, 'utf8'),
    // 出力先ディレクトリは pecotv 利用検知 hook が作る。
    // hook が動かない環境（旧プラグイン・CLAUDE_PROJECT_DIR 未設定）でも書き込めるよう、
    // capturePng (screenshot.ts) と同様に親ディレクトリを補う。
    // mkdir / writeFile のどちらが失敗しても、呼び出し元で output-write-failed に包まれる。
    writeFile: async (filePath: string, content: string) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
    },
    capturePng: (xmlString: string, outputPath: string, fonts: readonly string[]) => capturePng(xmlString, outputPath, fonts),
    lintText: defaultLintText,
    now: () => performance.now(),
  }
}
