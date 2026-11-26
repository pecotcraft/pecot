// slide_create ツールの実装。テンプレートはコピーしない。
// 次の順に実行する。
// テーマの指定の解釈 → テーマの取得 → 宣言の読み取り → レイアウトの参照と分類の読み取り。
// 続けて、生成先の確認 → slides.md と package.json の生成 → 初期ページ → public/slides。
// その後、vite.config.ts と start.mjs の生成 → node_modules の組み立て（実ディレクトリと項目ごとの相対 symlink）。
// 組み立ては同じ親の下の一時 dir で行い、最後に入れ替える。失敗したら一時 dir を消す。

/* eslint-disable security/detect-non-literal-fs-filename */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createDiagnostics } from '../../diagnostics.js'
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
import { parseThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import { pluginDependencyRoot, themeStoreRoot } from '../../infra/_shared/dependency-root.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
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
}

export interface SlideCreateDependencies {
  /**
  同梱アセットの起点（resolvePluginRoot）。
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
`force` で既存の生成先があっても、取得・生成のどこで失敗しても、既存は消えない。
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
      `destination already exists (pass force: true to overwrite): ${projectAbsolute}`,
      'dest-exists',
    )
  }
  const dependencyRoot = dependencies.dependencyRoot ?? dependencies.pluginRoot
  assertDependencyRootAvailable(dependencyRoot)
  const storeRoot = (dependencies.themeStoreRoot ?? themeStoreRoot)()
  if (storeRoot === undefined) {
    throw new SlideCreateRuntimeError(
      'cannot determine the theme location (fix: check the data directory CLAUDE_PLUGIN_DATA)',
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
    // 組み立てが済んでから、既存の生成先 (force) を外して入れ替える。
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
  `slide.create.done` の payload。MCP ツールの構造化データもこれをそのまま返す。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
slide_create の実処理と機械可読な結果組み立て。MCP ツールがここを通る。
*/
export async function executeSlideCreate(
  projectDirectory: string,
  options: Readonly<SlideCreateOptions>,
  // DI 経由の write は mutate メソッド。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideCreateDependencies,
): Promise<SlideCreateExecution> {
  const { catalog, warnings, ...summary } = await runSlideCreate(projectDirectory, options, dependencies)
  for (const warning of warnings) createDiagnostics(dependencies.stderr).warning(warning)
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
失敗の reason。テーマの取得・宣言・指定の失敗は `theme-<reason>`（`themeErrorReason`）にする。
*/
export function errorToReason(error: unknown): FailureReason {
  if (error instanceof SlideCreateUsageError) return error.reason
  if (error instanceof SlideCreateRuntimeError) return error.reason
  return themeErrorReason(error) ?? 'unknown'
}

export function slideCreateDefaultDependencies(): SlideCreateDependencies {
  return {
    pluginRoot: resolvePluginRoot(),
    dependencyRoot: pluginDependencyRoot(),
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => performance.now(),
  }
}
