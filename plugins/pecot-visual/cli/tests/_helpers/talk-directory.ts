// fixture テーマ (tests/fixtures/themes/with-declaration) を参照する talk-dir を作る helper。
// slide lint / sync 系のテストへ渡す。
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは呼び出し側が渡した一時ディレクトリ配下だけ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runSlideCreate } from '../../src/commands/slidev-project/create.js'
import { writeGeneratedFiles, linkNodeModules } from '../../src/infra/slidev-project/fs.js'
import { copyFixtureTheme, type CopiedTheme } from './theme-fixtures.js'

// tests/_helpers → tests → cli → plugins/pecot-visual
export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
// deck-lint.config.js が import する plugin の dist。1 つでも欠けると lint は設定エラー
// (eslint exit 2) になるため、build 忘れを判別可能なメッセージで落とす。
const REQUIRED_PLUGIN_DISTS: readonly string[] = [
  '_shared',
  'slidev-pages-lint',
  'text-constraints',
].map(name => path.join(PLUGIN_ROOT, 'assets', 'slidev', 'scripts', 'eslint', name, 'dist', 'index.js'))

export interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

export function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
export function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

/**
テンプレート側 eslint plugin が build 済みであることを確かめる。`beforeAll` から呼ぶ。
*/
export function assertTemplatePluginsBuilt(): void {
  const missing = REQUIRED_PLUGIN_DISTS.filter(distribution => !existsSync(distribution))
  if (missing.length > 0) {
    throw new Error(
      `テンプレート側 eslint plugin が未 build です (${missing.join(', ')} が存在しません)。`
      + ' plugins/pecot-visual/scripts/ci/run-tests.sh --scope=slidev などで build してから再実行してください。',
    )
  }
}

/**
fixture テーマを `<root>/<name>` へ写し、`file:` の指定を返す。
*/
export function copyThemeForTalk(root: string, name = 'theme'): CopiedTheme {
  return copyFixtureTheme('with-declaration', path.join(root, name))
}

/**
`slide create --theme file:<fixture の写し>` で `<root>/<name>` に talk-dir を作って、そのパスを返す。
テーマの写しは `<root>/<name>-theme` に置く。
`extraLintRules` を渡すと、写しの pecot-theme.json の `lint.rules` に足す（fixture 自体は変えない）。
*/
export async function createTalkDirectory(
  root: string,
  name = 'demo',
  extraLintRules: Readonly<Record<string, string>> = {},
): Promise<string> {
  const projectDirectory = path.join(root, name)
  const theme = copyThemeForTalk(root, `${name}-theme`)
  if (Object.keys(extraLintRules).length > 0) {
    const declarationPath = path.join(theme.directory, 'pecot-theme.json')
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const declaration = JSON.parse(readFileSync(declarationPath, 'utf8')) as { lint: { rules: Record<string, string> } }
    declaration.lint.rules = { ...declaration.lint.rules, ...extraLintRules }
    writeFileSync(declarationPath, JSON.stringify(declaration, undefined, 2))
  }
  await runSlideCreate(
    projectDirectory,
    { theme: theme.spec, force: false, emitCatalog: false },
    {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      now: () => 0,
    },
  )
  return projectDirectory
}

// 移行前の talk-dir が持っていた、テンプレート由来のディレクトリ。`removeTemplateEntries` の対象名と揃える。
const LEGACY_DIRECTORIES: readonly string[] = [
  'components', 'composables', 'layouts', 'setup', 'styles', 'utils', 'scripts', 'patches', 'html-base',
  'pages/_references', 'public/assets',
]
// 同じく、テンプレート由来のファイル。
const LEGACY_FILES: readonly string[] = [
  'global-bottom.vue', 'eslint.config.js', 'deck-lint.config.js', '.npmrc',
  '.prettierrc.json', '.prettierignore', 'package-lock.json', 'pnpm-lock.yaml',
]

/**
移行前の talk-dir の中身を、`removeTemplateEntries` の対象名で小さく作る。
`slide create` はテンプレートをコピーしない。`slide sync` が消す対象は、ここで用意する。
`slides.md` は `theme: none`、`pages/` は初期の 3 ページ、`public/slides` は作品領域とする。
*/
export async function createLegacyTalkDirectory(root: string, name = 'demo'): Promise<string> {
  const projectDirectory = path.join(root, name)
  for (const directory of LEGACY_DIRECTORIES) {
    mkdirSync(path.join(projectDirectory, directory), { recursive: true })
    writeFileSync(path.join(projectDirectory, directory, '.legacy'), 'legacy\n')
  }
  for (const file of LEGACY_FILES) writeFileSync(path.join(projectDirectory, file), '// legacy\n')
  mkdirSync(path.join(projectDirectory, '.vite'), { recursive: true })
  writeFileSync(path.join(projectDirectory, '.vite', 'cache'), 'legacy\n')
  writeFileSync(path.join(projectDirectory, '.gitignore'), 'node_modules\ndist\npptx\n')
  writeFileSync(path.join(projectDirectory, 'slides.md'), '---\ntheme: none\ntitle: Sample\nsrc: ./pages/cover.md\n---\n')
  for (const page of ['cover', 'section', 'end']) {
    writeFileSync(path.join(projectDirectory, 'pages', `${page}.md`), `---\nlayout: ${page}\n---\n`)
  }
  for (const directory of ['images', 'diagrams', 'html']) {
    mkdirSync(path.join(projectDirectory, 'public', 'slides', directory), { recursive: true })
  }
  await writeGeneratedFiles(projectDirectory, {})
  await linkNodeModules(projectDirectory, PLUGIN_ROOT, [])
  return projectDirectory
}
