// テーマの版の違う 2 つの talk-dir を、同じ端末で続けて build して確かめる（T026）。
//
// 見たいのは、テーマの版ごとに置き場が分かれ、talk-dir ごとに自分の版だけが描画に入ること。
// 実 git・実 pnpm・実 slidev build を通す。Chromium は使わない。
//
// 取得元は、fixture `with-declaration` から作るローカルの bare リポジトリ（`git+file://`、_helpers/theme-repository.ts）。
// 2 つのタグは、`plain.vue` の印だけが違う。
//
// timeout 階層は vitest.e2e.config.ts のコメントに合わせる。
// it は 660_000 で、2 回の build（各 300_000 まで）の合計がこれを超えない。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下と追跡ファイルだけ */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { parseThemeSpec } from '../../src/domain/slidev-theme/theme-spec.js'
import { themeStoreRoot } from '../../src/infra/_shared/dependency-root.js'
import { linkNodeModules, writeGeneratedFiles } from '../../src/infra/slidev-project/fs.js'
import { fetchTheme } from '../../src/infra/slidev-theme/store.js'
import { ChildProcessSlidevRunner } from '../../src/infra/slidev-to-pptx/runner.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { createThemeRepository, FIXTURE_THEME_NAME } from '../_helpers/theme-repository.js'

// tests/e2e → cli/ → plugins/pecot-visual
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const THEME_NAME = FIXTURE_THEME_NAME
const BUILD_TIMEOUT_MS = 300_000

const temporaryRoot = useTemporaryDirectory('pecotv-theme-versions-', { hook: 'all', resolveRealPath: true })

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

function markOf(tag: string): string {
  return `pecotv-theme-mark-${tag}`
}

/**
fixture から、2 つのタグを持つ bare リポジトリを作り、その url を返す。
タグごとに `plain.vue` の印だけを変える。
*/
function createRepository(tags: readonly string[]): string {
  return createThemeRepository({
    sourceDirectory: temporaryRoot('theme-src'),
    bareDirectory: temporaryRoot('theme.git'),
    tags,
    beforeCommit: (tag, source) => {
      const layoutPath = path.join(source, 'layouts', 'plain.vue')
      const original = readFileSync(layoutPath, 'utf8').replace(/<p class="version-mark">.*<\/p>\n?/u, '')
      writeFileSync(layoutPath, original.replace('<slot />', () => `<p class="version-mark">${markOf(tag)}</p>\n    <slot />`), 'utf8')
    },
  })
}

function createTalkDirectory(name: string): string {
  const talk = temporaryRoot(name)
  mkdirSync(path.join(talk, 'pages'), { recursive: true })
  writeFileSync(path.join(talk, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { [THEME_NAME]: '0.0.0' },
  }), 'utf8')
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${THEME_NAME}\ntitle: ${name}\n---\n\n---\nsrc: ./pages/01-plain.md\n---\n`, 'utf8')
  writeFileSync(path.join(talk, 'pages', '01-plain.md'), '---\nlayout: plain\nheading: PlainHeading\nbody: PlainBody\n---\n', 'utf8')
  return talk
}

/**
取得から build までを通し、dist の JS の本文を連結して返す。
*/
async function buildWithTheme(url: string, tag: string, talk: string): Promise<string> {
  const storeRoot = themeStoreRoot()
  if (storeRoot === undefined) throw new Error('テーマの置き場を決められません')
  const fetched = await fetchTheme(parseThemeSpec(`git+${url}#${tag}`), {
    storeRoot,
    baseDirectory: talk,
    dependencyRoot: PLUGIN_ROOT,
  })
  expect(fetched.name).toBe(THEME_NAME)

  await writeGeneratedFiles(talk, {})
  await linkNodeModules(talk, PLUGIN_ROOT, [{ name: fetched.name, directory: fetched.directory }])

  const result = await new ChildProcessSlidevRunner().build(talk, { timeoutMs: BUILD_TIMEOUT_MS })
  expect(result.exitCode, `${tag} の build が失敗しました\n${result.stderr}\n${result.stdout}`).toBe(0)

  const assets = path.join(talk, 'dist', 'assets')
  expect(existsSync(assets)).toBe(true)
  return javascriptSources(assets)
}

function javascriptSources(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string | readonly string[] => {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) return javascriptSources(target)
      return entry.name.endsWith('.js') ? readFileSync(target, 'utf8') : []
    })
    .join('\n')
}

describe('テーマの版の違う talk-dir を続けて描画する', () => {
  it('それぞれ自分の版の印だけが dist に入り、同じ版の再取得は置き場を再利用する', async () => {
    const url = createRepository(['v1.0.0', 'v1.0.1'])

    const first = await buildWithTheme(url, 'v1.0.0', createTalkDirectory('talk-first'))
    expect(first).toContain(markOf('v1.0.0'))
    expect(first).not.toContain(markOf('v1.0.1'))

    const secondTalk = createTalkDirectory('talk-second')
    const second = await buildWithTheme(url, 'v1.0.1', secondTalk)
    expect(second).toContain(markOf('v1.0.1'))
    expect(second).not.toContain(markOf('v1.0.0'))

    const storeRoot = themeStoreRoot()
    if (storeRoot === undefined) throw new Error('テーマの置き場を決められません')
    // 2 つ目の talk-dir のテーマは、置き場の v1.0.1 の package を指す。
    const themeLink = realpathSync(path.join(secondTalk, 'node_modules', THEME_NAME))
    expect(themeLink.startsWith(`${realpathSync(storeRoot)}${path.sep}`)).toBe(true)
    expect(themeLink.endsWith(path.join('v1.0.1', 'package'))).toBe(true)

    const again = await fetchTheme(parseThemeSpec(`git+${url}#v1.0.0`), {
      storeRoot,
      baseDirectory: temporaryRoot(),
      dependencyRoot: PLUGIN_ROOT,
    })
    expect(again.reused).toBe(true)
  }, 660_000)
})
