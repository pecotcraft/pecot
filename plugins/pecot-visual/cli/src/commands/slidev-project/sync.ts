// `pecotv slide sync` コマンドのファサード。
// テンプレートのコピーを持つ移行前の talk-dir を、`--theme` でテーマを参照する形へ移す。
// 移行済みの talk-dir は、package.json の依存の版でテーマを取得して node_modules を張り直す。
//
// commander DI / exitOverride / configureOutput.writeErr / 二段例外型は、
// slidev-project/create.ts を踏襲する。
// 実体ロジックは domain/slidev-project/sync.ts、fs 操作は infra/slidev-project/fs.ts に分離している。

/* eslint-disable security/detect-non-literal-fs-filename */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'

import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import type { LayoutCatalog } from '../../domain/slidev-theme/references.js'
import { classifyTalkTheme } from '../../domain/slidev-theme/talk-theme.js'
import { readThemeDeclaration } from '../../domain/slidev-theme/declaration.js'
import { ThemeSpecError, parseThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { fetchTheme } from '../../infra/slidev-theme/store.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from './linked-theme.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import { executeSlideTheme } from './theme.js'
import {
  autoDeckLintJsonField,
  runAutoDeckLint,
  writeAutoDeckLintReport,
} from './lint.js'
import type { AutoDeckLintReport } from './lint.js'
import { absoluteSpec, packageSpec } from './theme-source.js'
import {
  SlideSyncRuntimeError,
  SlideSyncUsageError,
  runSlideSync,
} from '../../domain/slidev-project/sync.js'
import type {
  EnsureThemeLinkedPort,
  PreparedTheme,
  SlideSyncFsAdapter,
  SlideSyncSummary,
} from '../../domain/slidev-project/sync.js'
import {
  SlideCreateRuntimeError,
  SlideCreateUsageError,
} from '../../domain/slidev-project/errors.js'
import { pluginDependencyRoot, themeStoreRoot } from '../../infra/_shared/dependency-root.js'
import {
  assertDependencyRootAvailable,
  hasSlidesMd,
  linkNodeModules,
  removeTemplateEntries,
  talkDirectoryExists,
  syncGeneratedFiles,
} from '../../infra/slidev-project/fs.js'

export { SlideSyncRuntimeError, SlideSyncUsageError } from '../../domain/slidev-project/sync.js'

export interface SlideSyncOptions {
  readonly dir: string
  readonly nodeModulesOnly: boolean
  /**
  移行先のテーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<path>`）。
  `file:` の相対パスは、`currentDirectory` を基準に絶対化する。
  */
  readonly theme?: string | undefined
}

export interface SlideSyncDependencies {
  /**
  同梱アセットの起点。CLAUDE_PLUGIN_ROOT。
  */
  readonly pluginRoot: string
  /**
  デッキの node_modules に張る項目の元になる依存ルート。省略時は pluginRoot。
  */
  readonly dependencyRoot?: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  /**
  `--node-modules-only` と、移行済みの talk-dir の通常の sync が、テーマの取得と張り直しを任せる port。
  省略時は実装（git・pnpm・実ファイル）。
  */
  readonly ensureThemeLinked?: EnsureThemeLinkedPort
  /**
  移行先のテーマの package.json・宣言を読む port。省略時は実ファイルを読む。
  */
  readonly files?: ThemeFiles
  /**
  移行先のテーマを取得する port。省略時は infra の実装。
  */
  readonly fetchTheme?: typeof fetchTheme
  /**
  テーマの置き場を返す port。省略時はデータ置き場の `themes/`。
  */
  readonly themeStoreRoot?: () => string | undefined
  /**
  `file:` の相対パスを絶対化する基準。省略時はカレント。
  */
  readonly currentDirectory?: string
}

export type SlideSyncResultSummary = SlideSyncSummary

function buildFsAdapter(): SlideSyncFsAdapter {
  return {
    talkDirectoryExists,
    doesSlidesMdExist: hasSlidesMd,
    readSlidesMd: async (talkDirectory: string) => {
      return await readFile(path.join(talkDirectory, 'slides.md'), 'utf8')
    },
    writeSlidesMd: async (talkDirectory: string, content: string) => {
      await writeFile(path.join(talkDirectory, 'slides.md'), content, 'utf8')
    },
    removeTemplateEntries,
    syncGeneratedFiles,
    linkNodeModules,
    writePackageJson: async (talkDirectory: string, content: string) => {
      await writeFile(path.join(talkDirectory, 'package.json'), content, 'utf8')
    },
  }
}

/**
commander コマンドファクトリ。コマンド名は `sync`、`slide` グループ配下に登録する想定。

受け付ける options を次に示す。
- `--dir <path>` (必須): talk-dir 絶対パス。
- `--theme <spec>`: 移行前の talk-dir を、このテーマを参照する形へ移す。
- `--node-modules-only`: node_modules の張り直しのみ実行。
- `--json`: machine-readable な JSON を stdout に出す。
*/
export function createSlideSyncCommand(
  buildDependencies: () => SlideSyncDependencies,
): Command {
  const command = new Command('sync')
    .description(
      'sync a talk-dir; a pre-migration talk-dir that holds a template copy is moved to reference the theme given by --theme'
      + ' (template-derived files are removed; slides.md, pages/*.md and public/slides/ are kept); '
      + 'a migrated talk-dir fetches the theme at the version in package.json dependencies and rebuilds node_modules; '
      + 'generated files (vite.config.ts, start.mjs) are aligned with the current plugin output; nothing else changes',
    )
    .requiredOption('--dir <path>', 'absolute path of the talk-dir to sync')
    .option('--theme <spec>', 'theme referenced by a pre-migration talk-dir (git+https://<host>/<owner>/<repo>.git#<tag> or file:<path>)')
    .option('--node-modules-only', 'rebuild node_modules only (a normal sync of a migrated talk-dir does the same)', false)
    .option('--json', 'print machine-readable JSON to stdout', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.sync.error',
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
      const options: SlideSyncOptions = {
        dir: requireString(raw, 'dir'),
        nodeModulesOnly: raw['nodeModulesOnly'] === true,
        theme: typeof raw['theme'] === 'string' ? raw['theme'] : undefined,
      }

      try {
        const execution = await executeSlideSync(options, dependencies, (summary) => {
          // 人間向けの成否行は lint より先に出す。deck lint の違反一覧が後続で流れても
          // sync 自体の成否が先頭行に残る。
          if (isWantsJson) return
          writeSyncSummary(summary, dependencies.stdout)
        })
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify(execution.data))
        }
        else {
          writeAutoDeckLintReport(execution.lint, execution.summary.directory, dependencies)
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.sync.error',
            reason,
            detail,
          }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(`slide sync failed: ${detail}`)
        }
        process.exitCode = toExitCode(error)
      }
    })
  return command
}

/**
人向けの成否行。形は 3 つ。
- `--node-modules-only`: 「node_modules のみ」の行。テーマを張ったときは name と spec を添える。
- 張り直しだけの通常の sync（移行済み）: テーマの name と spec、置き場、node_modules のほかは変えていないこと。
- 移行: テーマの name と spec、消した名前の一覧、作品を残したこと。
*/
function writeSyncSummary(
  summary: Readonly<SlideSyncResultSummary>,
  // WritableStream の write は mutate。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stdout: NodeJS.WritableStream,
): void {
  const { theme } = summary
  const themeLine = theme === undefined ? undefined : `  theme: ${theme.name} (${theme.spec})`
  if (summary.nodeModulesOnly) {
    writeData(stdout, `slide sync (node_modules only): success (${summary.directory})`)
    if (themeLine !== undefined) writeData(stdout, themeLine)
    writeData(stdout, `  node_modules → ${summary.nodeModulesTarget}`)
    return
  }
  writeData(stdout, `slide sync: success (${summary.directory})`)
  if (themeLine !== undefined) writeData(stdout, themeLine)
  if (summary.mode === 'relink') {
    if (theme !== undefined) writeData(stdout, `  location: ${theme.directory}`)
    writeData(stdout, `  node_modules → ${summary.nodeModulesTarget}`)
    writeData(stdout, '  nothing changed except node_modules')
    return
  }
  writeData(stdout, `  node_modules → ${summary.nodeModulesTarget}`)
  writeData(stdout, `  removed (${String(summary.removed.length)}): ${summary.removed.join(', ')}`)
  writeData(stdout, '  kept slides.md, pages/*.md and public/slides/; rewrote theme: in slides.md and the dependency in package.json')
}

export interface SlideSyncExecution {
  readonly summary: SlideSyncResultSummary
  readonly lint: AutoDeckLintReport
  /**
  `--json` の `slide.sync.done` payload。MCP ツールの構造化データもこれをそのまま返す。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
`slide sync` の実処理と機械可読な結果組み立て。CLI action と MCP ツールの双方がここを通る。

@param onSynced 同期完了時点（deck lint より前）に呼ばれる。CLI は人間向けの成否行を
  ここで書き、違反一覧より先に出す。MCP ツールは渡さない。
*/
export async function executeSlideSync(
  options: Readonly<SlideSyncOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideSyncDependencies,
  onSynced?: (summary: Readonly<SlideSyncResultSummary>) => void,
): Promise<SlideSyncExecution> {
  const summary = await runSyncCore(options, dependencies)
  for (const warning of summary.warnings) createDiagnostics(dependencies.stderr).warning(warning)
  onSynced?.(summary)
  // 同期後のデッキ全体 lint。違反があっても sync の成否は変えない。
  const lint = await runAutoDeckLint(summary.directory, dependencies)
  const catalog = await layoutCatalogOrEmpty(summary.directory, dependencies.stderr)
  return {
    summary,
    lint,
    data: {
      event: 'slide.sync.done',
      dir: summary.directory,
      nodeModulesTarget: summary.nodeModulesTarget,
      nodeModulesOnly: summary.nodeModulesOnly,
      // JSON の契約: テーマ無しは null。移行しなかったときの migration も null。
      /* eslint-disable unicorn/no-null */
      theme: summary.theme === undefined
        ? null
        : { name: summary.theme.name, spec: summary.theme.spec, directory: summary.theme.directory },
      migration: summary.mode === 'migrate' ? { removed: summary.removed } : null,
      /* eslint-enable unicorn/no-null */
      warnings: summary.warnings,
      categories: catalog.categories,
      layouts: catalog.layouts,
      lint: autoDeckLintJsonField(lint),
    },
  }
}

/**
同期後の talk-dir から選択可能なレイアウトを集める。

収集の失敗で sync 自体を失敗させない。`node_modules_only` は `pages/_references` を
触らないため、参照が破損した talk-dir でも node_modules の張り直しは成立させる。
*/
async function layoutCatalogOrEmpty(
  directory: string,
  // WritableStream の write は mutate。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stderr: NodeJS.WritableStream,
): Promise<Pick<LayoutCatalog, 'categories' | 'layouts'>> {
  try {
    const { data } = await executeSlideTheme({ dir: directory }, { files: new NodeThemeFiles() })
    for (const warning of data.warnings) createDiagnostics(stderr).warning(warning)
    return { categories: data.categories, layouts: data.layouts }
  }
  catch (error: unknown) {
    // 移行前の形 (theme: none) もここに来る。一覧を空にして、同期の成否は変えない。
    createDiagnostics(stderr).warning(`cannot read layout catalog: ${directory}: ${formatError(error)}`)
    return { categories: [], layouts: [] }
  }
}

/**
domain sync に実装の port を渡す。deck lint を伴わない同期本体。
*/
async function runSyncCore(
  options: Readonly<SlideSyncOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideSyncDependencies,
): Promise<SlideSyncResultSummary> {
  const dependencyRoot = dependencies.dependencyRoot ?? dependencies.pluginRoot
  const files = dependencies.files ?? new NodeThemeFiles()
  return await runSlideSync(
    { directory: options.dir, nodeModulesOnly: options.nodeModulesOnly, theme: options.theme },
    {
      dependencyRoot,
      fs: buildFsAdapter(),
      classifyTalk: directory => classifyTalkTheme(files, directory),
      prepareTheme: (themeSpec, talkDirectory) => prepareMigrationTheme(themeSpec, talkDirectory, {
        files,
        fetch: dependencies.fetchTheme ?? fetchTheme,
        storeRoot: dependencies.themeStoreRoot ?? themeStoreRoot,
        currentDirectory: dependencies.currentDirectory ?? process.cwd(),
        dependencyRoot,
        warn: (message) => { createDiagnostics(dependencies.stderr).warning(message) },
      }),
      ensureThemeLinked: dependencies.ensureThemeLinked ?? (directory => ensureTalkThemeLinked(
        directory,
        linkedThemeDefaultDependencies(
          dependencyRoot,
          /* c8 ignore next -- 実 git の取得中に出る警告の出力先。テストは実 git に出ない */
          { warn: (message) => { createDiagnostics(dependencies.stderr).warning(message) } },
        ),
      )),
    },
  )
}

interface MigrationThemeContext {
  readonly files: ThemeFiles
  readonly fetch: typeof fetchTheme
  readonly storeRoot: () => string | undefined
  readonly currentDirectory: string
  readonly dependencyRoot: string
  readonly warn: (message: string) => void
}

/**
移行先のテーマを用意する。書き換えの前に済ませる工程で、何も書き換えない。
指定の解釈 → 依存ルートの実体の確認 → 取得 → 宣言の読み取り。
指定の誤りは ThemeSpecError（usage error）、取得と宣言の失敗は原因ごとの例外のまま返す。
*/
async function prepareMigrationTheme(
  themeOption: string,
  talkDirectory: string,
  context: Readonly<MigrationThemeContext>,
): Promise<PreparedTheme> {
  const { files, currentDirectory, dependencyRoot } = context
  const spec = absoluteSpec(parseThemeSpec(themeOption), currentDirectory)

  assertDependencyRootAvailable(dependencyRoot)
  const storeRoot = context.storeRoot()
  if (storeRoot === undefined) {
    throw new SlideCreateRuntimeError(
      'cannot determine the theme location (fix: check the data directory CLAUDE_PLUGIN_DATA)',
      'theme-unknown',
    )
  }
  const fetched = await context.fetch(spec, {
    storeRoot,
    baseDirectory: currentDirectory,
    dependencyRoot,
    warn: context.warn,
  })

  const { warnings } = await readThemeDeclaration(files, fetched.directory)
  return {
    name: fetched.name,
    directory: fetched.directory,
    spec: packageSpec(themeOption, spec, path.resolve(talkDirectory)),
    warnings,
  }
}

export function errorToReason(error: unknown): FailureReason {
  if (error instanceof SlideSyncUsageError) return error.reason
  if (error instanceof SlideSyncRuntimeError) return error.reason
  // infra/slidev-project/fs.ts は SlideCreate{Runtime,Usage}Error を投げる。
  // assertTalkDirectory のルートで、talkDirectoryExists / doesSlidesMdExist が EACCES 等を受けた場合。
  // SlideCreateRuntimeError を投げ、そのまま CLI に届く。
  // ENOENT のルートは SlideSyncRuntimeError に変換される。ここで拾う。
  if (error instanceof SlideCreateRuntimeError) return error.reason
  // テーマの取得・宣言・指定・未参照の失敗は theme-<reason>。
  const themeReason = themeErrorReason(error)
  if (themeReason !== undefined) return themeReason
  /* c8 ignore start -- SlideCreateUsageError は SlideSyncUsageError に置き換えて投げるため到達しない */
  if (error instanceof SlideCreateUsageError) return error.reason
  return 'unknown'
  /* c8 ignore stop */
}

export function isUsageError(error: unknown): boolean {
  return error instanceof SlideSyncUsageError || error instanceof SlideCreateUsageError || error instanceof ThemeSpecError
}

/**
失敗時の exit code。usage error = 2、それ以外の実行失敗 = 1。
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
    throw new SlideSyncUsageError(`option --${key} is required`, 'missing-option')
  }
  return value
}

export function slideSyncDefaultDependencies(): SlideSyncDependencies {
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
  /* c8 ignore next 3 -- bin/pecotv が CLAUDE_PLUGIN_ROOT を必ず export するため未設定ルートは実運用で発生しない */
  if (pluginRoot === undefined || pluginRoot === '') {
    throw new SlideSyncRuntimeError('CLAUDE_PLUGIN_ROOT is not set', 'unknown')
  }
  const dependencyRoot = pluginDependencyRoot()
  return {
    pluginRoot,
    ...(dependencyRoot !== undefined && { dependencyRoot }),
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

/**
commander を介さず同期本体だけを呼ぶ shortcut。deck lint を伴わないため、
同期そのものの結果を観測したいテストが使う（本番ルートは `executeSlideSync`）。
*/
export async function runSlideSyncFromCli(
  directory: string,
  options: Readonly<{ nodeModulesOnly: boolean, theme?: string | undefined }>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideSyncDependencies,
): Promise<SlideSyncResultSummary> {
  return await runSyncCore({ dir: directory, nodeModulesOnly: options.nodeModulesOnly, theme: options.theme }, dependencies)
}
