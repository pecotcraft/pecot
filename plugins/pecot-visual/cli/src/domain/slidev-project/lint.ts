// `pecotv slide lint` の domain ロジック。talk-dir 全体 (`pages/**/*.md` + `slides.md`) を
// 本体の assets/slidev の eslint で lint し、結果を集計する。
//
// PostToolUse hook (`hooks/lib/post-tool-use/eslint-check.sh`) は、編集された 1 ファイルしか見ない。
// そのため、既存 talk-dir に蓄積した違反は検出できない。
// 本 domain は、その抜けを埋めるデッキ全体 lint を担う。
//
// 役割は次の 3 つ。
// - `assertTalkDirectory`: 絶対パスチェック + dir 存在 + slides.md 存在を、usage / runtime error に振り分ける。
//   振り分け方針は domain/slidev-project/sync.ts と同じ。
// - `EslintRunner` port が返す SpawnResult を、「違反」と「実行失敗」に分岐する。
// - eslint の `--format json` 出力を `SlideLintSummary` へ整形する。

import path from 'node:path'

import type { SpawnResult } from '../_shared/spawn-result.js'
import type { DeckLintInput } from '../slidev-theme/deck-lint-input.js'

export type SlideLintUsageReason = 'missing-option' | 'relative-dir'

export type SlideLintRuntimeReason
  = 'dir-not-found'
    | 'not-a-directory'
    | 'not-talk-dir'
    | 'eslint-not-launched'
    | 'eslint-timeout'
    | 'eslint-failed'
    | 'invalid-report'
    | 'unknown'

export class SlideLintUsageError extends Error {
  constructor(message: string, readonly reason: SlideLintUsageReason) {
    super(message)
    this.name = 'SlideLintUsageError'
  }
}

export class SlideLintRuntimeError extends Error {
  constructor(message: string, readonly reason: SlideLintRuntimeReason) {
    super(message)
    this.name = 'SlideLintRuntimeError'
  }
}

export interface SlideLintFsAdapter {
  readonly talkDirectoryExists: (directory: string) => Promise<{ readonly exists: boolean, readonly isDirectory: boolean }>
  readonly doesSlidesMdExist: (directory: string) => Promise<boolean>
  readonly listSkippedSymlinkPageDirectories: (directory: string) => Promise<readonly string[]>
}

export interface EslintRunArguments {
  readonly talkDirectory: string
  /**
  eslint 本体を持つ `assets/slidev` の絶対パス。
  */
  readonly assetsDirectory: string
  /**
  `--config` に渡す deck lint の設定（`assets/slidev/deck-lint.env.config.js`）の絶対パス。
  */
  readonly deckLintConfig: string
  /**
  テーマの宣言の解釈結果（`slide theme` の lint）。環境変数 PECOTV_DECK_LINT に JSON で渡る。
  */
  readonly lint: DeckLintInput
}

/**
本体の `assets/slidev` の eslint を子プロセスで起動する port。

eslint・flat config・プラグインは `assets/slidev` の node_modules から解決され、
CLI 自身の依存ツリーとは別にある。同じ 10 系でも別のインスタンスなので、
Node.js API (`new ESLint()`) ではなく必ず子プロセス起動で実装する。
*/
export interface EslintRunner {
  run(arguments_: Readonly<EslintRunArguments>): Promise<SpawnResult>
}

export interface SlideLintViolation {
  /**
  talk-dir 相対パス（talk-dir 外を指す場合のみ絶対パス）。
  */
  readonly file: string
  readonly line: number
  readonly column: number
  readonly rule: string
  readonly message: string
}

/**
- `clean`: lint 対象があり違反 0 件。
- `violations`: 違反あり。
- `no-target`: lint 対象が 1 件も無い。違反 0 件とは区別して報告する。
*/
export type SlideLintOutcome = 'clean' | 'violations' | 'no-target'

export interface SlideLintSummary {
  readonly directory: string
  readonly lintedFileCount: number
  readonly errorCount: number
  readonly warningCount: number
  readonly violations: readonly SlideLintViolation[]
  readonly outcome: SlideLintOutcome
  /**
  eslint の走査から漏れた `pages/` 配下の symlink ディレクトリ（talk-dir 相対）。
  「lint されていない領域がある」ことの通知専用で、outcome / exit code には影響しない。
  */
  readonly skippedSymlinkDirectories: readonly string[]
}

export interface SlideLintDomainOptions {
  readonly directory: string
}

export interface SlideLintDependencies {
  readonly assetsDirectory: string
  readonly deckLintConfig: string
  /**
  talk-dir が参照するテーマの宣言を解釈して、lint の入力にする port。
  talk-dir の検証の後に呼ぶ。失敗（theme-unlinked など）は例外のまま伝える。
  */
  readonly readLint: (directory: string) => Promise<DeckLintInput>
  readonly fs: SlideLintFsAdapter
  readonly eslint: EslintRunner
}

/**
talk-dir マーカー検証。振り分けは domain/slidev-project/sync.ts の
`assertTalkDirectory` と同一方針（例外型のみ Lint 系）。
- 絶対パスでない: `relative-dir` (usage error / exit 2)。
- 存在しない: `dir-not-found` (runtime error / exit 1)。
- ディレクトリでない: `not-a-directory` (runtime error / exit 1)。
- `slides.md` を含まない: `not-talk-dir` (runtime error / exit 1)。
*/
export async function assertTalkDirectory(
  directory: string,
  fs: Readonly<SlideLintFsAdapter>,
): Promise<void> {
  if (!path.isAbsolute(directory)) {
    throw new SlideLintUsageError(
      `--dir には絶対パスを指定してください (受け取った値: '${directory}')`,
      'relative-dir',
    )
  }

  const info = await fs.talkDirectoryExists(directory)
  if (!info.exists) {
    throw new SlideLintRuntimeError(
      `'${directory}' はディレクトリとして存在しません`,
      'dir-not-found',
    )
  }
  if (!info.isDirectory) {
    throw new SlideLintRuntimeError(
      `'${directory}' はディレクトリではありません`,
      'not-a-directory',
    )
  }

  const hasSlidesMd = await fs.doesSlidesMdExist(directory)
  if (!hasSlidesMd) {
    throw new SlideLintRuntimeError(
      `'${directory}' に slides.md が無いため talk-dir として扱えません。`
      + ' pecotv slide create で作成された talk-dir を指定してください。',
      'not-talk-dir',
    )
  }
}

/**
talk-dir 全体を lint し、集計結果を返す。

eslint の exit code は 0=違反なし / 1=違反あり / 2=設定エラー・内部エラー。
2 は CLI の usage error (exit 2) と衝突させないため `SlideLintRuntimeError` に変換する。
起動失敗 (`exitCode: null`) と timeout (`timedOut: true`) は SpawnResult の契約上
reject されないので、ここで明示的に分岐する。
*/
export async function runSlideLint(
  options: Readonly<SlideLintDomainOptions>,
  dependencies: Readonly<SlideLintDependencies>,
): Promise<SlideLintSummary> {
  await assertTalkDirectory(options.directory, dependencies.fs)

  const lint = await dependencies.readLint(options.directory)
  const result = await dependencies.eslint.run({
    talkDirectory: options.directory,
    assetsDirectory: dependencies.assetsDirectory,
    deckLintConfig: dependencies.deckLintConfig,
    lint,
  })

  // timedOut 時も SIGTERM で exitCode は null になるため、起動失敗より先に判定する。
  if (result.timedOut) {
    throw new SlideLintRuntimeError(
      `eslint が時間内に終了しませんでした: ${summarizeStderr(result.stderr)}`,
      'eslint-timeout',
    )
  }
  if (result.exitCode === null) {
    throw new SlideLintRuntimeError(
      `eslint の起動に失敗しました: ${summarizeStderr(result.stderr)}`,
      'eslint-not-launched',
    )
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new SlideLintRuntimeError(
      `eslint が異常終了しました (exit ${String(result.exitCode)}): ${summarizeStderr(result.stderr)}`,
      'eslint-failed',
    )
  }

  // eslint が辿れなかった symlink dir の検出は lint 結果と独立。走査失敗以外で
  // outcome / exit code を動かさないため、集計の外側で合流させる。
  const skippedSymlinkDirectories = await dependencies.fs.listSkippedSymlinkPageDirectories(options.directory)

  return summarizeReport(
    options.directory,
    parseEslintReport(result.stdout),
    skippedSymlinkDirectories,
  )
}

interface EslintJsonMessage {
  readonly ruleId?: string | null
  readonly message?: string
  readonly line?: number
  readonly column?: number
}

interface EslintJsonFileReport {
  readonly filePath?: string
  readonly errorCount?: number
  readonly warningCount?: number
  readonly messages?: readonly EslintJsonMessage[]
}

function parseEslintReport(stdout: string): readonly EslintJsonFileReport[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  }
  catch (error: unknown) {
    throw new SlideLintRuntimeError(
      `eslint の JSON 出力を解析できませんでした: ${formatError(error)}`,
      'invalid-report',
    )
  }
  if (!Array.isArray(parsed)) {
    throw new SlideLintRuntimeError(
      'eslint の JSON 出力が配列ではありません',
      'invalid-report',
    )
  }
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻り値の narrowing
  return parsed as readonly EslintJsonFileReport[]
}

function summarizeReport(
  directory: string,
  report: readonly EslintJsonFileReport[],
  skippedSymlinkDirectories: readonly string[],
): SlideLintSummary {
  const violations: SlideLintViolation[] = []
  let errorCount = 0
  let warningCount = 0

  for (const file of report) {
    errorCount += file.errorCount ?? 0
    warningCount += file.warningCount ?? 0
    const relative = toRelativePath(directory, file.filePath ?? '')
    const messages = file.messages ?? []
    for (const message of messages) {
      violations.push({
        file: relative,
        line: message.line ?? 0,
        column: message.column ?? 0,
        rule: message.ruleId ?? '(unknown rule)',
        message: message.message ?? '',
      })
    }
  }

  return {
    directory,
    lintedFileCount: report.length,
    errorCount,
    warningCount,
    violations,
    outcome: resolveOutcome(report.length, violations.length),
    skippedSymlinkDirectories,
  }
}

function resolveOutcome(lintedFileCount: number, violationCount: number): SlideLintOutcome {
  if (lintedFileCount === 0) return 'no-target'
  return violationCount > 0 ? 'violations' : 'clean'
}

/**
eslint が返す `filePath` は realpath 解決済みのため、bind mount / symlink 経由では
talk-dir の論理パスからの相対化が `../` に化ける。talk-dir 外を指す結果になった場合は
絶対パスのまま返し、誤解を招く相対パスを出さない。
*/
export function toRelativePath(directory: string, filePath: string): string {
  if (filePath === '') return ''
  const relative = path.relative(directory, filePath)
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? filePath : relative
}

const STDERR_EXCERPT_LIMIT = 400

function summarizeStderr(stderr: string): string {
  const trimmed = stderr.trim()
  if (trimmed === '') return '(stderr なし)'
  if (trimmed.length <= STDERR_EXCERPT_LIMIT) return trimmed
  return `${trimmed.slice(0, STDERR_EXCERPT_LIMIT)}...`
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */
