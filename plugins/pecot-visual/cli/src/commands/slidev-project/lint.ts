// `pecotv slide lint` コマンドのファサード。既存 talk-dir 全体（`pages/**/*.md` +
// `slides.md`）を、本体の assets/slidev の eslint で lint する。
// 規則と寸法は、talk-dir が参照するテーマの宣言を `slide theme` と同じ手順で解釈した結果を使う。
//
// commander DI / exitOverride / configureOutput.writeErr / 二段例外型は
// slidev-project/sync.ts のパターンを忠実に踏襲する。実体ロジックは
// domain/slidev-project/lint.ts、eslint 起動は infra/slidev-project/eslint-runner.ts。
//
// 本ファイルは、`slide create` / `slide sync` 末尾の自動 lint の供給元も兼ねる。
// 対象は `runAutoDeckLint` と `writeAutoDeckLintReport`。

import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import path from 'node:path'

import { Command } from 'commander'

import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import {
  SlideLintRuntimeError,
  SlideLintUsageError,
  runSlideLint,
} from '../../domain/slidev-project/lint.js'
import type { EslintRunner, SlideLintSummary } from '../../domain/slidev-project/lint.js'
import {
  SlideCreateRuntimeError,
  SlideCreateUsageError,
} from '../../domain/slidev-project/errors.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import { runningMirrorDirectory } from '../../infra/_shared/dependency-root.js'
import { ChildProcessEslintRunner } from '../../infra/slidev-project/eslint-runner.js'
import {
  listSkippedSymlinkPageDirectories,
  hasSlidesMd,
  talkDirectoryExists,
} from '../../infra/slidev-project/fs.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { executeSlideTheme } from './theme.js'

export interface SlideLintOptions {
  readonly dir: string
}

export interface SlideLintDependencies {
  /**
  同梱アセットの起点。CLAUDE_PLUGIN_ROOT。
  */
  readonly pluginRoot: string
  /**
  lint 用の設定（deck-lint.env.config.js）・eslint 本体・ルールの dist を取る実行用ミラー。
  PECOTV_RUNTIME_DIR（実行中の cli と同じ版のミラー）。省略時は pluginRoot（開発・テスト）。
  `runtime/current` は別セッションが切り替えた新版を指すので使わない。
  */
  readonly runtimeDirectory?: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  /**
  eslint 起動の port。省略時は assets/slidev の eslint の子プロセス起動を使う。
  子プロセスを起こさずに lint 結果の分岐を観測したいテストがここを差し替える。
  */
  readonly eslint?: EslintRunner
}

export type SlideLintResultSummary = SlideLintSummary

/**
commander コマンドファクトリ。コマンド名は `lint`、`slide` グループ配下に登録する想定。

受け付ける options:
- `--dir <path>` (必須): talk-dir 絶対パス
- `--json`: machine-readable な JSON を stdout に出す

exit code: 違反あり = 1 / 実行失敗 = 1 / usage error = 2（commander 専用）。
eslint 自身の exit 2（設定エラー）は domain で `SlideLintRuntimeError` に変換済みで、
ここで 2 に化けることはない。
*/
export function createSlideLintCommand(
  buildDependencies: () => SlideLintDependencies,
): Command {
  const command = new Command('lint')
    .description('lint the whole talk-dir (pages/**/*.md and slides.md)')
    .requiredOption('--dir <path>', 'absolute path of the talk-dir to lint')
    .option('--json', 'print machine-readable JSON to stdout', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.lint.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:[ \t]*/i, '').trim(),
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
    })
    .action(async (raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isWantsJson = raw['json'] === true
      const options: SlideLintOptions = { dir: requireString(raw, 'dir') }

      try {
        const { summary, data } = await executeSlideLint(options, dependencies)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify(data))
        }
        else {
          // 件数行を読まずに成否が分かるよう見出し行に結果を載せる（no-target は exit 0 側）。
          const outcomeLabel = summary.outcome === 'violations' ? 'violations' : 'success'
          writeData(dependencies.stdout, `slide lint: ${outcomeLabel} (${summary.directory})`)
          writeSummaryLines(summary, dependencies)
        }
        if (summary.outcome === 'violations') {
          process.exitCode = 1
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.lint.error',
            reason,
            detail,
          }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(`slide lint failed: ${detail}`)
        }
        process.exitCode = toExitCode(error)
      }
    })
  return command
}

export interface SlideLintExecution {
  readonly summary: SlideLintResultSummary
  /**
  `--json` の payload。MCP ツールの構造化データもこれをそのまま返す。
  event 名は outcome で変わる（違反ありは `slide.lint.violations`）。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
`slide lint` の実処理と機械可読な結果組み立て。CLI action と MCP ツールの双方がここを通る。
*/
export async function executeSlideLint(
  options: Readonly<SlideLintOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): Promise<SlideLintExecution> {
  const summary = await runActionLint(options.dir, dependencies)
  return {
    summary,
    data: {
      event: summary.outcome === 'violations' ? 'slide.lint.violations' : 'slide.lint.done',
      dir: summary.directory,
      outcome: summary.outcome,
      lintedFileCount: summary.lintedFileCount,
      errorCount: summary.errorCount,
      warningCount: summary.warningCount,
      violations: summary.violations,
      skippedSymlinkDirectories: summary.skippedSymlinkDirectories,
    },
  }
}

async function runActionLint(
  directory: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): Promise<SlideLintResultSummary> {
  const root = dependencies.runtimeDirectory ?? dependencies.pluginRoot
  const assetsDirectory = path.join(root, 'assets', 'slidev')
  return await runSlideLint(
    { directory },
    {
      assetsDirectory,
      deckLintConfig: path.join(assetsDirectory, 'deck-lint.env.config.js'),
      readLint: async (talkDirectory) => {
        const { data } = await executeSlideTheme({ dir: talkDirectory }, { files: new NodeThemeFiles() })
        return data.lint
      },
      fs: { talkDirectoryExists, doesSlidesMdExist: hasSlidesMd, listSkippedSymlinkPageDirectories },
      eslint: dependencies.eslint ?? new ChildProcessEslintRunner(),
    },
  )
}

/**
人間向けの集計 + 違反一覧を書き出す。`slide lint` 単体と create / sync の自動 lint で
同じ体裁にするため共有する。
*/
function writeSummaryLines(
  summary: Readonly<SlideLintSummary>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies): void {
  // 走査抜けの警告は lint 対象 0 件でも出す必要があるため no-target の早期 return より前に置く。
  const diagnostics = createDiagnostics(dependencies.stderr)
  for (const skipped of summary.skippedSymlinkDirectories) {
    diagnostics.warning(
      `${skipped} is a symlink and is not scanned by eslint`
      + ' (files under it may not be linted)',
    )
  }
  if (summary.outcome === 'no-target') {
    writeData(dependencies.stdout, `  linted 0 files (no pages/**/*.md or slides.md found)`)
    return
  }
  writeData(
    dependencies.stdout,
    `  linted ${String(summary.lintedFileCount)} files / ${String(summary.errorCount)} errors`
    + ` / ${String(summary.warningCount)} warnings`,
  )
  for (const violation of summary.violations) {
    writeData(
      dependencies.stdout,
      `    ${violation.file}:${String(violation.line)}:${String(violation.column)}`
      + `  ${violation.rule}  ${violation.message}`,
    )
  }
}

export interface AutoDeckLintReport {
  /**
  lint が実行できた場合の集計。実行自体に失敗した場合は undefined。
  */
  readonly summary: SlideLintSummary | undefined
  /**
  lint 実行に失敗した場合の理由（テーマの未解決、eslint 未 install 等）。
  */
  readonly failure: string | undefined
}

/**
`slide create` / `slide sync` 末尾で実行するデッキ全体 lint。

違反と実行失敗は、呼び出し元の exit code に影響させない。
そのため例外は投げず、`AutoDeckLintReport` に畳んで返す。
*/
export async function runAutoDeckLint(
  talkDirectory: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): Promise<AutoDeckLintReport> {
  try {
    return { summary: await runActionLint(talkDirectory, dependencies), failure: undefined }
  }
  catch (error: unknown) {
    return { summary: undefined, failure: formatError(error) }
  }
}

/**
`runAutoDeckLint` の結果を人間向けに書き出す。違反は一覧表示のみで、呼び出し元の
成否には影響しない旨と再確認コマンドを添える。
*/
export function writeAutoDeckLintReport(
  report: Readonly<AutoDeckLintReport>,
  talkDirectory: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): void {
  const { summary } = report
  if (summary === undefined) {
    createDiagnostics(dependencies.stderr).warning(`deck lint skipped: ${report.failure ?? ''}`)
    return
  }
  writeData(dependencies.stdout, 'deck lint:')
  writeSummaryLines(summary, dependencies)
  if (summary.outcome === 'violations') {
    writeData(
      dependencies.stdout,
      `  the violations above do not affect this command's result; after fixing, run pecotv slide lint --dir ${talkDirectory} to recheck`,
    )
  }
}

/**
`--json` 出力の `slide.create.done` / `slide.sync.done` に載せる lint 要約フィールド。
*/
export function autoDeckLintJsonField(
  report: Readonly<AutoDeckLintReport>,
): Readonly<Record<string, unknown>> {
  const { summary } = report
  if (summary === undefined) {
    return { skipped: true, detail: report.failure ?? '' }
  }
  return {
    skipped: false,
    outcome: summary.outcome,
    lintedFileCount: summary.lintedFileCount,
    errorCount: summary.errorCount,
    warningCount: summary.warningCount,
    violations: summary.violations,
    skippedSymlinkDirectories: summary.skippedSymlinkDirectories,
  }
}

export function errorToReason(error: unknown): FailureReason {
  if (error instanceof SlideLintUsageError) return error.reason
  // テーマの解決・宣言・取得の失敗は `theme-<reason>` の形で載せる（slide theme と同じ）
  const themeReason = themeErrorReason(error)
  if (themeReason !== undefined) return themeReason
  if (error instanceof SlideLintRuntimeError) return error.reason
  // infra/slidev-project/fs.ts は SlideCreate{Runtime,Usage}Error を投げる。
  // assertTalkDirectory のルートで、talkDirectoryExists / doesSlidesMdExist が EACCES 等を受けた場合。
  // SlideCreateRuntimeError を投げ、そのまま CLI に届く。
  // ENOENT のルートは SlideLintRuntimeError に変換される。
  if (error instanceof SlideCreateRuntimeError) return error.reason
  /* c8 ignore start -- SlideCreateUsageError の到達ルートは resolveTemplate の DEFAULT 固定値の
     範囲では発生しない。runActionLint の再ラップで SlideLintUsageError に置き換えている。 */
  if (error instanceof SlideCreateUsageError) return error.reason
  return 'unknown'
  /* c8 ignore stop */
}

export function isUsageError(error: unknown): boolean {
  return error instanceof SlideLintUsageError || error instanceof SlideCreateUsageError
}

/**
失敗時の exit code。usage error = 2、それ以外の実行失敗 = 1（違反ありの 1 は成功ルート）。
*/
export function toExitCode(error: unknown): number {
  return isUsageError(error) ? 2 : 1
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

function requireString(raw: Readonly<Record<string, unknown>>, key: string): string {
  // eslint-disable-next-line security/detect-object-injection -- key は本ファイル内固定文字列
  const value = raw[key]
  /* c8 ignore next 3 -- commander の requiredOption で必ず string が入るため到達不能 */
  if (typeof value !== 'string') {
    throw new SlideLintUsageError(`option --${key} is required`, 'missing-option')
  }
  return value
}

export function slideLintDefaultDependencies(): SlideLintDependencies {
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
  /* c8 ignore next 3 -- bin/pecotv が CLAUDE_PLUGIN_ROOT を必ず export するため未設定ルートは実運用で発生しない */
  if (pluginRoot === undefined || pluginRoot === '') {
    throw new SlideLintRuntimeError('CLAUDE_PLUGIN_ROOT is not set', 'unknown')
  }
  const runtimeDirectory = runningMirrorDirectory()
  return {
    pluginRoot,
    ...(runtimeDirectory !== undefined && { runtimeDirectory }),
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

/**
テスト用の薄いファサード。commander を介さず domain `runSlideLint` を
production と同じ infra 組み立てで呼ぶための shortcut。
*/
export async function runSlideLintFromCli(
  directory: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): Promise<SlideLintResultSummary> {
  return await runActionLint(directory, dependencies)
}
