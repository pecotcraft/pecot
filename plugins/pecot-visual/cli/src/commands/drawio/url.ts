// drawio_url ツールの実装。slidev-project/create.ts と同形の DI / 二段例外を採用する。
//
// 失敗の種類:
//   RuntimeError = input/output IO failure、文面の違反、文章規則の判定の失敗、解けないテーマ。
//   UsageError = 出力パスの拡張子が .html でない / テーマの指定の誤り。
// 警告 (validateHtml の warning or icon resolver warn) は warningCount に数える。

/* eslint-disable security/detect-non-literal-fs-filename -- input はツールの引数として受理する想定。信頼境界外だが open API 仕様 */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { performance } from 'node:perf_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { collectTextViolations, formatTextViolations } from '../../domain/_shared/text-check.js'
import type { LintText, TextViolation } from '../../domain/_shared/text-check.js'
import { siblingPath } from '../../domain/drawio/export.js'
import { labelTexts } from '../../domain/drawio/label-text.js'
import type { DrawioFinding } from '../../domain/drawio/url.js'
import { generateDrawioUrl, generateDrawioViewerUrl, prepareDrawioXml, renderRedirectHtml, validateHtml, validateSlideFonts, validateSlideFontSizes, validateWhitespaceWrap } from '../../domain/drawio/url.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import { pluginDependencyRoot } from '../../infra/_shared/dependency-root.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { createIconResolver, defaultIconRoot } from '../../infra/drawio/icons.js'
import { capturePng } from '../../infra/drawio/screenshot.js'
import type { fetchTheme } from '../../infra/slidev-theme/store.js'
import { defaultLintText } from '../../infra/text-lint.js'
import { createDiagnostics } from '../../diagnostics.js'
import { DrawioUrlRuntimeError, DrawioUrlUsageError } from './errors.js'
import { resolveDrawioTheme, themeData, themeFontNames } from './theme.js'
import type { DrawioTheme } from './theme.js'

export { DrawioUrlRuntimeError, DrawioUrlUsageError } from './errors.js'

export interface DrawioUrlOptions {
  readonly mode: 'view' | 'edit'
  readonly png: boolean
  /**
  書体・文字サイズを確かめるテーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>`・`file:<path>`・
  talk-dir かテーマ root のパス）。省略時は図の祖先の talk-dir、無ければ本体の既定値。
  */
  readonly theme?: string | undefined
  /**
  `output` の指定値。省略時は URL をファイルに書き出さない。
  */
  readonly output?: string | undefined
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
  テーマの相対パスを絶対化する基準。省略時はカレント。
  */
  readonly currentDirectory?: string
  /**
  テーマの取得を中断する signal（MCP のキャンセル）。
  */
  readonly signal?: AbortSignal
}

// runDrawioUrl の戻り型は action 内部の中継用で公開 API ではない。
// `viewerUrl` は結果の data には載せないが、ブラウザで直接開く URL として保持する。
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

  // 診断のうち、警告の件数に数えるのは warning だけ。
  // note (fontColor 二重指定など) は stderr に流すが、件数には数えない。
  // 書体は常に確かめる。5 段のサイズは、テーマが決まったとき（talk-dir の中か theme 指定）だけ確かめる。
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
executeDrawioUrl の結果。ツールの ToolResult 組み立ては
これだけを見る。
*/
export interface DrawioUrlExecution {
  /**
  ツールの structuredContent に載せる値。
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
  生成した URL。
  */
  readonly url: string
  /**
  `output` を解決した絶対パス。未指定なら undefined。
  */
  readonly outputFile: string | undefined
}

/**
URL 生成から出力ファイル・PNG の書き出しまでを実行し、ツールの結果に載せる data を組み立てる。

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
      `output accepts only the .html extension: ${outputFile}`,
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
        // eslint-disable-next-line unicorn/no-null -- 結果のスキーマで PNG 失敗時に `png: null` を pin したいため
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
失敗時にツールの data に載せる内容。
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

export function drawioUrlDefaultDependencies(): DrawioUrlDependencies {
  return {
    pluginRoot: resolvePluginRoot(),
    dependencyRoot: pluginDependencyRoot(),
    stdout: process.stdout,
    stderr: process.stderr,
    readFile: (filePath: string) => readFile(filePath, 'utf8'),
    // 出力先ディレクトリは利用検知 hook が作る。
    // hook が動かない環境でも書き込めるよう、capturePng (screenshot.ts) と同様に親ディレクトリを補う。
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
