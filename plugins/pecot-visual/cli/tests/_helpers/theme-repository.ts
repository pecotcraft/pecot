// build できる fixture テーマを、ローカルの bare リポジトリ（`git+file://`）として用意する helper。
//
// 素の `file:` の取得は依存を install しない（theme-fixtures.ts の copyFixtureTheme の注記）。
// そのため `dependencies` を持つ fixture テーマは、`file:` では layout の import が解決できず build できない。
// `git+file://` で取得すると、置き場が依存を install する。実利用の取得と同じ形になる。
//
// コミットでは `dependencies` の相対 `file:` を、fixture `theme-only-dep` の絶対パスに書き換える
// （置き場からは相対先が無い）。fixture 自体は変えない。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは呼び出し側が渡した一時ディレクトリ配下だけ */
import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { FIXTURE_THEMES } from './theme-fixtures.js'

/**
with-declaration の package.json の name。slides.md の `theme:` に書く値。
*/
export const FIXTURE_THEME_NAME = 'slidev-theme-pecotv-test-declared'

/**
bare リポジトリに付ける既定のタグ。
*/
export const FIXTURE_THEME_TAG = 'v1.0.0'

function git(cwd: string, ...arguments_: readonly string[]): void {
  const environment = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) Reflect.deleteProperty(environment, name)
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...arguments_],
    { cwd, env: environment, stdio: 'pipe' },
  )
}

export interface ThemeRepositoryOptions {
  /**
  fixture を写す作業ツリー。空か、存在しないパス。
  */
  readonly sourceDirectory: string
  /**
  作る bare リポジトリのパス。存在しないパス。
  */
  readonly bareDirectory: string
  /**
  付けるタグ。順にコミットし、注釈付きタグを付ける。
  */
  readonly tags: readonly string[]
  /**
  タグごとのコミットの前に、作業ツリーを書き換える。
  */
  readonly beforeCommit?: (tag: string, sourceDirectory: string) => void
}

/**
fixture `with-declaration` から、注釈付きタグを持つ bare リポジトリを作り、その url（`file://...`）を返す。
*/
export function createThemeRepository(options: Readonly<ThemeRepositoryOptions>): string {
  const { sourceDirectory, bareDirectory } = options
  cpSync(path.join(FIXTURE_THEMES, 'with-declaration'), sourceDirectory, { recursive: true })
  const manifestPath = path.join(sourceDirectory, 'package.json')
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace('file:../theme-only-dep', () => `file:${path.join(FIXTURE_THEMES, 'theme-only-dep')}`),
    'utf8',
  )
  git(sourceDirectory, 'init', '-q')
  for (const tag of options.tags) {
    options.beforeCommit?.(tag, sourceDirectory)
    git(sourceDirectory, 'add', '-A')
    git(sourceDirectory, 'commit', '-q', '-m', tag)
    git(sourceDirectory, 'tag', '-a', tag, '-m', tag)
  }
  git(path.dirname(bareDirectory), 'clone', '-q', '--bare', sourceDirectory, bareDirectory)
  return `file://${bareDirectory}`
}

/**
`slide create --theme` に渡す、build できる fixture テーマの指定（`git+file://<bare>#v1.0.0`）を返す。
作業ファイルは `workDirectory` 配下に作る（呼び出し側の一時ディレクトリ）。
*/
export function createFixtureThemeSpec(workDirectory: string): string {
  const url = createThemeRepository({
    sourceDirectory: path.join(workDirectory, 'theme-src'),
    bareDirectory: path.join(workDirectory, 'theme.git'),
    tags: [FIXTURE_THEME_TAG],
  })
  return `git+${url}#${FIXTURE_THEME_TAG}`
}
/* eslint-enable security/detect-non-literal-fs-filename */
