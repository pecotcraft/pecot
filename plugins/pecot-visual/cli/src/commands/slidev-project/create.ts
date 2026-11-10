// `pecotv slide create --theme <theme-spec>` の実装。テンプレートはコピーしない。
// 次の順に実行する。
// テーマの指定の解釈 → テーマの取得 → 宣言の読み取り → レイアウトの参照と分類の読み取り。
// 続けて、生成先の確認 → slides.md と package.json の生成 → 初期ページ → public/slides。
// その後、vite.config.ts と start.mjs の生成 → node_modules の組み立て（実ディレクトリと項目ごとの相対 symlink）。
// 組み立ては同じ親の下の一時 dir で行い、最後に入れ替える。失敗したら一時 dir を消す。

/* eslint-disable security/detect-non-literal-fs-filename */
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'

import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import { SlideCreateRuntimeError, SlideCreateUsageError } from '../../domain/slidev-project/errors.js'
import { buildInitialPages, nameToTitle } from '../../domain/slidev-project/initial-pages.js'
import { talkPackageJsonSource } from '../../domain/slidev-project/package-json.js'
import { slidesMdSource } from '../../domain/slidev-project/slides-md.js'
import { LINK_COLOR_OMITTED_WARNING } from '../../domain/slidev-project/warnings.js'
import { readThemeDeclaration } from '../../domain/slidev-theme/declaration.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import {
  buildLayoutCatalog,
  readLayoutCategories,
  resolveLayoutReferences,
} from '../../domain/slidev-theme/references.js'
import type { LayoutCatalog } from '../../domain/slidev-theme/references.js'
import { ThemeSpecError, parseThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import { pluginDependencyRoot, themeStoreRoot } from '../../infra/_shared/dependency-root.js'
import {
  assertDependencyRootAvailable,
  linkNodeModules,
  setupPublicSlides,
  talkDirectoryExists,
  writeGeneratedFiles,
} from '../../infra/slidev-project/fs.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { fetchTheme } from '../../infra/slidev-theme/store.js'
import {
  autoDeckLintJsonField,
  runAutoDeckLint,
  writeAutoDeckLintReport,
} from './lint.js'
import type { AutoDeckLintReport } from './lint.js'
import { absoluteSpec, packageSpec } from './theme-source.js'

export interface SlideCreateOptions {
  /**
  テーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<path>`）。
  `file:` の相対パスは、`currentDirectory` を基準に絶対化する。
  */
  readonly theme: string
  readonly force: boolean
  /**
  レイアウトの一覧を stdout に書き出すか。

  人間向け出力専用の副作用なので、判定材料を `--json` フラグから独立させている。
  CLI は `--json` 無しのときだけ true にし、MCP ツールルートは常に false で呼ぶ
  （結果として捕捉する stdout にカタログを混在させないため）。

  読むのは `executeSlideCreate` だけで、`runSlideCreate` は一覧に触れない。
  */
  readonly emitCatalog: boolean
}

export interface SlideCreateDependencies {
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
  readonly now: () => number
  /**
  テーマの package.json・宣言・参照を読む port。省略時は実ファイルを読む。
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
  `file:` の相対パスを絶対化する基準。省略時はカレント。
  */
  readonly currentDirectory?: string
}

export interface SlideCreateResultSummary {
  readonly projectDirectory: string
  readonly theme: { readonly name: string, readonly spec: string }
  readonly durationMs: number
}

/**
runSlideCreate が返す、生成した talk-dir とテーマの情報。
*/
export interface SlideCreateRun extends SlideCreateResultSummary {
  readonly catalog: LayoutCatalog
  /**
  宣言・分類・参照・初期ページの警告。
  */
  readonly warnings: readonly string[]
}

export { SlideCreateUsageError } from '../../domain/slidev-project/errors.js'

/**
テーマを取得し、talk-dir を生成する。

生成は生成先と同じ親の下の一時 dir で組み立て、最後に入れ替える。
`--force` で既存の生成先があっても、取得・生成のどこで失敗しても、既存は消えない。
失敗したら一時 dir を消す。取得中の警告は、失敗の前に出たものも stderr へ流す。
*/
export async function runSlideCreate(
  projectDirectory: string,
  options: Readonly<SlideCreateOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideCreateDependencies,
): Promise<SlideCreateRun> {
  const warnings: string[] = []
  try {
    return await generateTalk(projectDirectory, options, dependencies, warnings)
  }
  catch (error: unknown) {
    // 成功したときの警告は executeSlideCreate が流す。失敗したときは、ここで流さないと捨てられる。
    for (const warning of warnings) createDiagnostics(dependencies.stderr).warning(warning)
    throw error
  }
}

async function generateTalk(
  projectDirectory: string,
  options: Readonly<SlideCreateOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideCreateDependencies,
  // 警告の蓄積先。呼び出し元の配列へ積む。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  warnings: string[],
): Promise<SlideCreateRun> {
  const projectAbsolute = path.resolve(projectDirectory)
  const start = dependencies.now()
  const files = dependencies.files ?? new NodeThemeFiles()
  const currentDirectory = dependencies.currentDirectory ?? process.cwd()

  const spec = absoluteSpec(parseThemeSpec(options.theme), currentDirectory)

  // 生成先には、取得の後まで触れない。生成先の存在と依存ルートの実体は、取得の前に確かめる。
  const destination = await talkDirectoryExists(projectAbsolute)
  if (!options.force && destination.exists) {
    throw new SlideCreateUsageError(
      `dest dir '${projectAbsolute}' は既に存在します (--force 未指定)`,
      'dest-exists',
    )
  }
  const dependencyRoot = dependencies.dependencyRoot ?? dependencies.pluginRoot
  assertDependencyRootAvailable(dependencyRoot)
  const storeRoot = (dependencies.themeStoreRoot ?? themeStoreRoot)()
  if (storeRoot === undefined) {
    throw new SlideCreateRuntimeError(
      'テーマの置き場を決められません。データ置き場（CLAUDE_PLUGIN_DATA）を確認してください',
      'theme-unknown',
    )
  }
  const fetched = await (dependencies.fetchTheme ?? fetchTheme)(spec, {
    storeRoot,
    baseDirectory: currentDirectory,
    dependencyRoot,
    warn: (message) => { warnings.push(message) },
  })

  const { declaration, warnings: declarationWarnings } = await readThemeDeclaration(files, fetched.directory)
  const references = await resolveLayoutReferences(files, {
    themeRoot: fetched.directory,
    talkDirectory: projectAbsolute,
    referencesDirectory: declaration.layouts.references,
  })
  const vocabulary = await readLayoutCategories(files, references.directories)
  const catalog = buildLayoutCatalog(references, vocabulary.categories)
  const initial = await buildInitialPages(references.entries, files)
  warnings.push(...declarationWarnings, ...vocabulary.warnings, ...catalog.warnings, ...initial.warnings)
  if (declaration.pptx.linkColor === undefined) warnings.push(LINK_COLOR_OMITTED_WARNING)

  const specInPackage = packageSpec(options.theme, spec, projectAbsolute)
  const pageNames = initial.pages.map(page => page.filename.replace(/\.md$/u, ''))
  const title = nameToTitle(path.basename(projectAbsolute))
  const parent = path.dirname(projectAbsolute)
  const staging = path.join(parent, `.${path.basename(projectAbsolute)}.creating-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(staging, { recursive: true })
    await writeFile(
      path.join(staging, 'slides.md'),
      slidesMdSource({ title, theme: fetched.name, pages: pageNames }),
      'utf8',
    )
    await writeFile(
      path.join(staging, 'package.json'),
      talkPackageJsonSource({ name: path.basename(projectAbsolute), themeName: fetched.name, themeSpec: specInPackage }),
      'utf8',
    )
    const pagesDirectory = path.join(staging, 'pages')
    await mkdir(pagesDirectory, { recursive: true })
    for (const page of initial.pages) {
      await writeFile(path.join(pagesDirectory, page.filename), page.content, 'utf8')
    }
    await setupPublicSlides(staging)
    await writeGeneratedFiles(staging, { themeName: fetched.name })
    // node_modules の相対 symlink は親ごと同じ位置に入れ替わるため、入れ替え後も同じ先を指す。
    await linkNodeModules(staging, dependencyRoot, [{ name: fetched.name, directory: fetched.directory }])
    // 組み立てが済んでから、既存の生成先 (--force) を外して入れ替える。
    if (destination.exists) await rm(projectAbsolute, { recursive: true, force: true })
    await rename(staging, projectAbsolute)
  }
  catch (error: unknown) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  return {
    projectDirectory: projectAbsolute,
    theme: { name: fetched.name, spec: specInPackage },
    durationMs: dependencies.now() - start,
    catalog,
    warnings,
  }
}

export interface SlideCreateExecution {
  readonly summary: SlideCreateResultSummary
  readonly lint: AutoDeckLintReport
  /**
  `--json` の `slide.create.done` payload。MCP ツールの構造化データもこれをそのまま返す。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
`slide create` の実処理と機械可読な結果組み立て。CLI action と MCP ツールの双方がここを通る。

@param onCreated 生成完了時点（deck lint より前）に呼ばれる。CLI は人間向けの成否行を
  ここで書き、違反一覧より先に出す。MCP ツールは渡さない。
*/
export async function executeSlideCreate(
  projectDirectory: string,
  options: Readonly<SlideCreateOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideCreateDependencies,
  onCreated?: (summary: Readonly<SlideCreateResultSummary>) => void,
): Promise<SlideCreateExecution> {
  const { catalog, warnings, ...summary } = await runSlideCreate(projectDirectory, options, dependencies)
  for (const warning of warnings) createDiagnostics(dependencies.stderr).warning(warning)
  if (options.emitCatalog) emitLayoutCatalog(catalog, dependencies.stdout)
  onCreated?.(summary)
  // 生成直後のデッキ全体 lint。違反があっても create の成否は変えない。
  const lint = await runAutoDeckLint(summary.projectDirectory, dependencies)
  return {
    summary,
    lint,
    data: {
      event: 'slide.create.done',
      projectDir: summary.projectDirectory,
      theme: summary.theme,
      categories: catalog.categories,
      layouts: catalog.layouts,
      warnings,
      lint: autoDeckLintJsonField(lint),
    },
  }
}

/**
収集済みのレイアウトの一覧を人間向けに stdout へ書き出す。分類ごとに群化し、deprecated は群内で
`[deprecated]` 接頭辞を付ける（選ばない対象だが、分類から外して別枠にすると、その分類に
何が属するかが読めなくなる）。レイアウトが 0 件の分類も見出しを出して不足を見せる。
*/
export function emitLayoutCatalog(
  catalog: Readonly<Pick<LayoutCatalog, 'categories' | 'layouts'>>,
  // WritableStream の write は mutate。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stdout: NodeJS.WritableStream,
): void {
  const { categories, layouts } = catalog

  writeData(stdout, '='.repeat(60))
  writeData(stdout, 'Layout Catalog (Step 2 のプランモード前に必ず読み切ること)')
  writeData(stdout, `${'='.repeat(60)}\n\n`)

  for (const category of categories) {
    writeData(stdout, `--- ${category.label}: ${category.question} ---\n\n`)
    const members = layouts.filter(entry => entry.category === category.id)
    if (members.length === 0) {
      writeData(stdout, '(該当レイアウトなし)\n\n')
      continue
    }
    for (const { layout, description, deprecated } of members) {
      writeData(stdout, `- ${deprecated ? '[deprecated] ' : ''}${layout}: ${description}`)
    }
    writeData(stdout, '')
  }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

/**
失敗の reason。テーマの取得・宣言・指定の失敗は `theme-<reason>`（`themeErrorReason`）にする。
*/
export function errorToReason(error: unknown): string {
  if (error instanceof SlideCreateUsageError) return error.reason
  if (error instanceof SlideCreateRuntimeError) return error.reason
  return themeErrorReason(error) ?? 'unknown'
}

/**
失敗時の exit code。usage error（引数の誤り、テーマの指定の誤り）= 2、それ以外の実行失敗 = 1。
*/
export function toExitCode(error: unknown): number {
  return error instanceof SlideCreateUsageError || error instanceof ThemeSpecError ? 2 : 1
}

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

export function createSlideCreateCommand(
  buildDependencies: () => SlideCreateDependencies,
): Command {
  const command = new Command('create')
    .description('テーマを参照する Slidev プレゼンテーションを生成する')
    .argument('<project-dir>', '生成先ディレクトリ')
    .requiredOption('--theme <spec>', 'テーマの指定 (git+https://<host>/<owner>/<repo>.git#<tag> か file:<path>)')
    .option('--force', '既存ディレクトリを上書きする', false)
    .option('--json', 'machine-readable な JSON を stdout に出す', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.create.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:[ \t]*/i, '').trim(),
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
    })
    .action(async (projectDirectory: string, raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isWantsJson = raw['json'] === true
      const options: SlideCreateOptions = {
        theme: requireString(raw, 'theme'),
        force: raw['force'] === true,
        emitCatalog: !isWantsJson,
      }

      try {
        const execution = await executeSlideCreate(projectDirectory, options, dependencies, (summary) => {
          if (isWantsJson) return
          writeData(dependencies.stdout, `slide create: 成功 (${summary.projectDirectory})`)
          writeData(dependencies.stdout, `  theme=${summary.theme.name}, ${String(Math.round(summary.durationMs))}ms`)
        })
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify(execution.data))
        }
        else {
          writeAutoDeckLintReport(execution.lint, execution.summary.projectDirectory, dependencies)
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.create.error',
            reason,
            detail,
          }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(`slide create 失敗: ${detail}`)
        }
        process.exitCode = toExitCode(error)
      }
    })
  return command
}

function requireString(raw: Readonly<Record<string, unknown>>, key: string): string {
  // eslint-disable-next-line security/detect-object-injection -- key は本ファイル内固定文字列
  const value = raw[key]
  /* c8 ignore next 3 -- commander の requiredOption で必ず string が入るため到達不能 */
  if (typeof value !== 'string') {
    throw new SlideCreateUsageError(`option --${key} is required`, 'missing-option')
  }
  return value
}

export function slideCreateDefaultDependencies(): SlideCreateDependencies {
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
  /* c8 ignore next 3 -- bin/pecotv が CLAUDE_PLUGIN_ROOT を必ず export するため未設定ルートは実運用で発生しない */
  if (pluginRoot === undefined || pluginRoot === '') {
    throw new SlideCreateRuntimeError('CLAUDE_PLUGIN_ROOT が未設定です', 'unknown')
  }
  const dependencyRoot = pluginDependencyRoot()
  return {
    pluginRoot,
    ...(dependencyRoot !== undefined && { dependencyRoot }),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => performance.now(),
  }
}
