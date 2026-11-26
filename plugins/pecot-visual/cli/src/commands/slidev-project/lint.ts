// slide_lint ツールのファサード。既存 talk-dir 全体（`pages/**/*.md` +
// `slides.md`）を、本体の assets/slidev の eslint で lint する。
// 規則と寸法は、talk-dir が参照するテーマの宣言を slide_theme と同じ手順で解釈した結果を使う。
//
// DI と二段例外型は slidev-project/sync.ts のパターンを踏襲する。実体ロジックは
// domain/slidev-project/lint.ts、eslint 起動は infra/slidev-project/eslint-runner.ts。
//
// 本ファイルは、`slide_create` / `slide_sync` 末尾の自動 lint の供給元も兼ねる。
// 対象は `runAutoDeckLint` と `autoDeckLintJsonField`。

import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import path from 'node:path'

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
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
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
  同梱アセットの起点（resolvePluginRoot）。
  */
  readonly pluginRoot: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  /**
  eslint 起動の port。省略時は assets/slidev の eslint の子プロセス起動を使う。
  子プロセスを起こさずに lint 結果の分岐を観測したいテストがここを差し替える。
  */
  readonly eslint?: EslintRunner
}

export type SlideLintResultSummary = SlideLintSummary

export interface SlideLintExecution {
  readonly summary: SlideLintResultSummary
  /**
  ツールの構造化データに載せる payload。
  event 名は outcome で変わる（違反ありは `slide.lint.violations`）。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
slide_lint の実処理と機械可読な結果組み立て。MCP ツールがここを通る。
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
  const assetsDirectory = path.join(dependencies.pluginRoot, 'assets', 'slidev')
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
slide_create / slide_sync 末尾で実行するデッキ全体 lint。

違反と実行失敗は、呼び出し元の成否に影響させない。
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
`slide.create.done` / `slide.sync.done` の data に載せる lint 要約フィールド。
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
  // テーマの解決・宣言・取得の失敗は `theme-<reason>` の形で載せる（slide_theme と同じ）
  const themeReason = themeErrorReason(error)
  if (themeReason !== undefined) return themeReason
  if (error instanceof SlideLintRuntimeError) return error.reason
  // infra/slidev-project/fs.ts は SlideCreate{Runtime,Usage}Error を投げる。
  // assertTalkDirectory のルートで、talkDirectoryExists / doesSlidesMdExist が EACCES 等を受けた場合。
  // SlideCreateRuntimeError を投げ、そのまま呼び出し元に届く。
  // ENOENT のルートは SlideLintRuntimeError に変換される。
  if (error instanceof SlideCreateRuntimeError) return error.reason
  /* c8 ignore start -- SlideCreateUsageError の到達ルートは resolveTemplate の DEFAULT 固定値の
     範囲では発生しない。runActionLint の再ラップで SlideLintUsageError に置き換えている。 */
  if (error instanceof SlideCreateUsageError) return error.reason
  return 'unknown'
  /* c8 ignore stop */
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

export function slideLintDefaultDependencies(): SlideLintDependencies {
  return {
    pluginRoot: resolvePluginRoot(),
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

/**
テスト用の薄いファサード。domain `runSlideLint` を
production と同じ infra 組み立てで呼ぶための shortcut。
*/
export async function runSlideLintDirectly(
  directory: string,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideLintDependencies,
): Promise<SlideLintResultSummary> {
  return await runActionLint(directory, dependencies)
}
