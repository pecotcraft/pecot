// commands/slidev-project/sync.ts の integration test。
// 移行前の talk-dir（テンプレートのコピーを持つ形）を tmp 配下に用意し、実ファイル・実 symlink で sync を実行する。
//
// pnpm install 済みでないと、plugin/node_modules 物理パスが realpath で解決できない。
// そのため cli/package.json の install 経由で、plugin root の node_modules が存在する前提。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfigFromFile } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isRecord } from '../../_helpers/records.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import {
  errorToReason,
  executeSlideSync,
  runSlideSyncDirectly,
} from '../../../src/commands/slidev-project/sync.js'
import type { SlideSyncDependencies } from '../../../src/commands/slidev-project/sync.js'
import { runSlideCreate } from '../../../src/commands/slidev-project/create.js'
import { ThemeFetchError, themeStoreDirectory } from '../../../src/domain/slidev-theme/store-layout.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from '../../../src/commands/slidev-project/linked-theme.js'
import { createLegacyTalkDirectory, makeStream } from '../../_helpers/talk-directory.js'
import { copyFixtureTheme } from '../../_helpers/theme-fixtures.js'
import { FIXTURE_THEME_NAME } from '../../_helpers/theme-repository.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { verifies } from '../../_helpers/verifies.js'
import { themeErrorReason } from '../../../src/domain/slidev-theme/error-reason.js'
import { readOutput } from '../../_helpers/attach.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'
import { explains } from '../../_helpers/explains.js'

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const DEPENDENCY_NODE_MODULES = path.resolve(PLUGIN_ROOT, '..', '..', 'node_modules')

// write を持つ stub をそのまま使う。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

// themeDirectory は、各テストの一時ディレクトリに写した fixture テーマ。
const state = { temporaryRoot: '', themeDirectory: '' }

beforeEach(() => {
  state.temporaryRoot = mkdtempSync(path.join(tmpdir(), 'pecotv-slide-sync-'))
  state.themeDirectory = copyFixtureTheme('with-declaration', path.join(state.temporaryRoot, 'theme-src')).directory
})

afterEach(() => {
  rmSync(state.temporaryRoot, { recursive: true, force: true })
})

// 移行先に使うテーマ。`file:` の絶対パスで指す。
const THEME_NAME = FIXTURE_THEME_NAME
// fixture テーマの layout のうち、hidden を除いた数。
// 内訳は cover / end / link / section / legacy-panel / marked / panel / plain。
const FIXTURE_LAYOUT_COUNT = 8
function themeSpec(): string {
  return `file:${state.themeDirectory}`
}

function plainDependencies(): SlideSyncDependencies {
  return { pluginRoot: PLUGIN_ROOT, stdout: asStream(makeStream()), stderr: asStream(makeStream()) }
}

// 移行の取得先。実 git には出ず、置き場は一時 dir にする。
function migrateDependencies(): SlideSyncDependencies {
  return {
    pluginRoot: PLUGIN_ROOT,
    stdout: asStream(makeStream()),
    stderr: asStream(makeStream()),
    themeStoreRoot: () => path.join(state.temporaryRoot, 'store'),
  }
}

/**
node_modules を除く全ファイルの相対パスと内容（symlink は向き先）。
*/
function snapshotOutsideNodeModules(directory: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (current: string): void => {
    const children = readdirSync(current, { withFileTypes: true })
    for (const entry of children) {
      const target = path.join(current, entry.name)
      const relative = path.relative(directory, target)
      if (relative === 'node_modules') continue
      if (entry.isSymbolicLink()) entries.set(relative, `-> ${readlinkSync(target)}`)
      else if (entry.isDirectory()) {
        entries.set(relative, '<dir>')
        walk(target)
      }
      else entries.set(relative, readFileSync(target, 'utf8'))
    }
  }
  walk(directory)
  return entries
}

function withoutGeneratedFiles(snapshot: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...snapshot].filter(([name]) => name !== 'vite.config.ts' && name !== 'start.mjs'))
}

// 移行前の talk-dir（テンプレートのコピーを持つ形）。`slide create` はコピーしないため、helper で写す。
async function setupTalkDirectory(): Promise<string> {
  return await createLegacyTalkDirectory(state.temporaryRoot)
}

describe('runSlideSyncDirectly (smoke)', () => {
  it('移行前の talk-dir に --theme を指定すると、テーマを参照する形へ移し、作品と生成物と .gitignore は残す', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-02')
    await explains('`slide sync --theme` による移行のテストです。テンプレートのコピーを持つ talk-dir を移行した場合に、コピーした名前が削除され、`slides.md` の `theme:` の行だけが変わることを確認します。')
    const talk = await setupTalkDirectory()
    // 作品と生成物
    writeFileSync(path.join(talk, 'pages', '_user.md'), 'USER MARKER')
    await mkdir(path.join(talk, 'pages', '_custom'), { recursive: true })
    writeFileSync(path.join(talk, 'pages', '_custom', 'mine.md'), 'MINE')
    await mkdir(path.join(talk, 'public', 'slides', 'images'), { recursive: true })
    writeFileSync(path.join(talk, 'public', 'slides', 'images', '_user.png'), 'PNG')
    await mkdir(path.join(talk, 'pptx', 'cache'), { recursive: true })
    writeFileSync(path.join(talk, 'pptx', 'cache', 'manifest.json'), '{"envHash":"DECK"}')
    // 移行前の写しに残っている名前
    writeFileSync(path.join(talk, 'eslint.config.js'), '// legacy')
    writeFileSync(path.join(talk, 'deck-lint.config.js'), '// legacy')
    writeFileSync(path.join(talk, 'package-lock.json'), '{}')
    // 生成ファイルの手直し
    writeFileSync(path.join(talk, 'vite.config.ts'), '// USER PATCH')
    writeFileSync(path.join(talk, 'start.mjs'), '// USER PATCH')
    const gitignore = readOutput(path.join(talk, '.gitignore'))
    const namesBefore = new Set(readdirSync(talk))
    const slidesBefore = readOutput(path.join(talk, 'slides.md'))

    const summary = await runSlideSyncDirectly(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())

    expect(summary.mode).toBe('migrate')
    // 消した名前は、移行前の写しにあった名前と一致する
    const expectedRemoved = [
      'components', 'composables', 'layouts', 'setup', 'styles', 'utils', 'scripts', 'patches', 'html-base', '.vite',
      'global-bottom.vue', 'eslint.config.js', 'deck-lint.config.js', '.npmrc',
      '.prettierrc.json', '.prettierignore', 'package-lock.json', 'pnpm-lock.yaml', 'pages/_references', 'public/assets',
    ].filter(name => name.includes('/') || namesBefore.has(name))
    expect([...summary.removed].toSorted(compareStrings)).toStrictEqual(expectedRemoved.toSorted(compareStrings))
    for (const name of summary.removed) {
      expect(existsSync(path.join(talk, name)), `${name} が残っている`).toBe(false)
    }
    // 残るのは作品・生成物・.gitignore・本体が書いたファイル・node_modules だけ
    expect(readdirSync(talk).toSorted(compareStrings)).toStrictEqual(
      ['.gitignore', 'node_modules', 'package.json', 'pages', 'pptx', 'public', 'slides.md', 'start.mjs', 'vite.config.ts'],
    )
    expect(readFileSync(path.join(talk, 'pages', '_user.md'), 'utf8')).toBe('USER MARKER')
    expect(readFileSync(path.join(talk, 'pages', '_custom', 'mine.md'), 'utf8')).toBe('MINE')
    expect(readdirSync(path.join(talk, 'pages')).toSorted(compareStrings)).toStrictEqual(
      ['_custom', '_user.md', 'cover.md', 'end.md', 'section.md'],
    )
    expect(readdirSync(path.join(talk, 'public'))).toStrictEqual(['slides'])
    expect(readFileSync(path.join(talk, 'public', 'slides', 'images', '_user.png'), 'utf8')).toBe('PNG')
    expect(readFileSync(path.join(talk, 'pptx', 'cache', 'manifest.json'), 'utf8')).toBe('{"envHash":"DECK"}')
    expect(readOutput(path.join(talk, '.gitignore'))).toBe(gitignore)
    // slides.md は theme: の行だけが変わる
    expect(readOutput(path.join(talk, 'slides.md'))).toBe(
      slidesBefore.replace('theme: none', () => `theme: ${THEME_NAME}`),
    )
    // package.json は talk-dir の名前と、テーマ 1 つだけの依存
    const migratedPackage: unknown = JSON.parse(readOutput(path.join(talk, 'package.json')))
    expect(migratedPackage).toStrictEqual({
      name: 'demo',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { [THEME_NAME]: `file:${path.relative(talk, state.themeDirectory)}` },
    })
    // 生成ファイルは、手直しがあっても本体の生成物で書き直される。/theme/ の配信を含む
    expect(readOutput(path.join(talk, 'vite.config.ts'))).toBe(viteConfigSource({ themeName: THEME_NAME }))
    expect(readOutput(path.join(talk, 'start.mjs'))).toBe(START_SCRIPT_SOURCE)
    // node_modules が実ディレクトリで、項目ごとの相対 symlink が依存ルートとテーマを指す
    const nodeModules = path.join(talk, 'node_modules')
    expect(lstatSync(nodeModules).isDirectory()).toBe(true)
    expect(lstatSync(nodeModules).isSymbolicLink()).toBe(false)
    const linkPath = path.join(nodeModules, 'vue')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath).startsWith('/')).toBe(false)
    expect(realpathSync(linkPath)).toBe(realpathSync(path.join(DEPENDENCY_NODE_MODULES, 'vue')))
    const themeLink = path.join(nodeModules, ...THEME_NAME.split('/'))
    expect(realpathSync(themeLink)).toBe(realpathSync(state.themeDirectory))
  })

  it('移行前の talk-dir に --theme を指定しないと、theme-required のエラーで止まり、何も変更しない', async () => {
    await explains('`--theme` を指定しない移行のテストです。移行前の talk-dir を同期した場合に、`SlideSyncUsageError`（理由 `theme-required`）が発生し、`node_modules` 以外が変更されないことを確認します。')
    const talk = await setupTalkDirectory()
    const before = snapshotOutsideNodeModules(talk)
    const nodeModulesLinkBefore = readlinkSync(path.join(talk, 'node_modules', 'vue'))

    const thrown = await rejectionOf(runSlideSyncDirectly(talk, { nodeModulesOnly: false }, migrateDependencies()))

    expect(thrown).toMatchObject({ name: 'SlideSyncUsageError', reason: 'theme-required' })
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue'))).toBe(nodeModulesLinkBefore)
  })

  it('取得できないテーマを指定すると、何も削除せずに止まる', async () => {
    await explains('存在しないテーマを指定した移行のテストです。取得できない `file:` のテーマを渡した場合に、テーマの取得エラーが発生し、talk-dir のファイルが何も変更されないことを確認します。')
    const talk = await setupTalkDirectory()
    const before = snapshotOutsideNodeModules(talk)

    const thrown = await rejectionOf(runSlideSyncDirectly(
      talk,
      { nodeModulesOnly: false, theme: `file:${path.join(state.temporaryRoot, 'no-such-theme')}` },
      migrateDependencies(),
    ))

    expect(thrown).toBeInstanceOf(Error)
    expect(themeErrorReason(thrown)).toBeDefined()
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
  })

  it('--node-modules-only を指定すると、ファイルには触れず、node_modules だけを作り直す', async () => {
    await explains('`--node-modules-only` の同期のテストです。`node_modules` を削除して同期した場合に、`node_modules` が作り直され、手を加えた `vite.config.ts`・`start.mjs`・`pages` は変更されないことを確認します。')
    const talk = await setupTalkDirectory()
    // 生成ファイルを改変して、書き直されないことを見る
    writeFileSync(path.join(talk, 'vite.config.ts'), '// USER PATCH')
    writeFileSync(path.join(talk, 'start.mjs'), '// USER START')
    const viteBefore = readOutput(path.join(talk, 'vite.config.ts'))
    const pagesBefore = readdirSync(path.join(talk, 'pages')).toSorted(compareStrings)
    // node_modules を消した状態で sync を呼ぶ
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })

    await runSlideSyncDirectly(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })

    expect(readOutput(path.join(talk, 'vite.config.ts'))).toBe(viteBefore)
    expect(readdirSync(path.join(talk, 'pages')).toSorted(compareStrings)).toStrictEqual(pagesBefore)
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe('// USER PATCH')
    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe('// USER START')
    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(lstatSync(path.join(talk, 'node_modules', 'vue')).isSymbolicLink()).toBe(true)
  })

  it('旧形式の node_modules（symlink 1 本）は、実ディレクトリに置き換え、依存ルートの項目は削除しない', async () => {
    await explains('依存ルートへの symlink 1 本だった `node_modules` を同期する、テストです。2 回同期した場合に、`node_modules` が実ディレクトリになり、依存ルートの項目の数が変わらず、依存ルートの項目ごとのリンクが並ぶことを確認します。')
    const talk = await setupTalkDirectory()
    const dependencyNodeModules = DEPENDENCY_NODE_MODULES
    const itemsBefore = readdirSync(dependencyNodeModules).length
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    symlinkSync(path.relative(talk, realpathSync(dependencyNodeModules)), path.join(talk, 'node_modules'), 'dir')
    expect(lstatSync(path.join(talk, 'node_modules')).isSymbolicLink()).toBe(true)

    for (let run = 0; run < 2; run += 1) {
      await runSlideSyncDirectly(talk, { nodeModulesOnly: true }, {
        pluginRoot: PLUGIN_ROOT,
        stdout: asStream(makeStream()),
        stderr: asStream(makeStream()),
      })
      expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
      expect(lstatSync(path.join(talk, 'node_modules')).isSymbolicLink()).toBe(false)
    }

    expect(readdirSync(dependencyNodeModules).length).toBe(itemsBefore)
    const linked = readdirSync(path.join(talk, 'node_modules')).filter(name => name !== '.pecotv-link.json')
    const expected = [...readdirSync(dependencyNodeModules).filter(name => !name.startsWith('.')), '.bin']
    expect(linked.toSorted(compareStrings)).toStrictEqual(expected.toSorted(compareStrings))
  })

  it('同期を 2 回続けて実行しても、同じ項目が同じ向きにリンクされる', async () => {
    await explains('同期を繰り返した場合の、`node_modules` のテストです。`--node-modules-only` を 2 回実行した場合に、`vue` のリンク先と `node_modules` の項目の一覧が、1 回目と変わらないことを確認します。')
    const talk = await setupTalkDirectory()
    await runSlideSyncDirectly(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    const target1 = readlinkSync(path.join(talk, 'node_modules', 'vue'))
    const items1 = readdirSync(path.join(talk, 'node_modules')).toSorted(compareStrings)
    await runSlideSyncDirectly(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    const target2 = readlinkSync(path.join(talk, 'node_modules', 'vue'))
    expect(target1).toBe(target2)
    expect(readdirSync(path.join(talk, 'node_modules')).toSorted(compareStrings)).toStrictEqual(items1)
  })

  it('移行を 2 回実行すると、2 回目はリンクの作り直しだけを行い、使わなかった --theme を警告に表示する', async () => {
    await explains('移行済みの talk-dir に、もう一度 `--theme` を指定する場合のテストです。2 回目の結果が `relink` になり、削除した名前が空で、`--theme was not used` の警告が 1 件表示され、`node_modules` 以外が変わらないことを確認します。')
    const talk = await setupTalkDirectory()
    writeFileSync(path.join(talk, 'pages', '_user.md'), 'USER MARKER')
    await runSlideSyncDirectly(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())
    const afterFirst = snapshotOutsideNodeModules(talk)
    const symlinkAfterFirst = readlinkSync(path.join(talk, 'node_modules', 'vue'))

    const second = await runSlideSyncDirectly(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())

    expect(second.mode).toBe('relink')
    expect(second.removed).toStrictEqual([])
    expect(second.warnings).toHaveLength(1)
    expect(second.warnings[0]).toContain('theme was not used')
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(afterFirst)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue'))).toBe(symlinkAfterFirst)
    const themeLink = path.join(talk, 'node_modules', ...THEME_NAME.split('/'))
    expect(realpathSync(themeLink)).toBe(realpathSync(state.themeDirectory))
  })

  it('node_modules が不正な絶対パスの symlink でも、実ディレクトリとして作り直す', async () => {
    await explains('不正な `node_modules` の同期のテストです。存在しない絶対パス `/abs/wrong` を指す symlink があった場合に、`--node-modules-only` で実ディレクトリに作り直され、項目が相対パスのリンクになることを確認します。')
    const talk = await setupTalkDirectory()
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    symlinkSync('/abs/wrong', path.join(talk, 'node_modules'), 'dir')
    await runSlideSyncDirectly(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue')).startsWith('/')).toBe(false)
  })
})

describe('executeSlideSync (smoke)', () => {
  it('nodeModulesOnly の成功は slide.sync.done に dir と nodeModulesOnly を載せる', async () => {
    await explains('`executeSlideSync` の成功時の結果のテストです。`nodeModulesOnly` を指定して同期が成功した場合は、`slide.sync.done` のイベントへ `dir` と `nodeModulesOnly` が含まれることを確認します。')
    const talk = await setupTalkDirectory()

    const { data } = await executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      plainDependencies(),
    )

    expect(data).toMatchObject({ event: 'slide.sync.done', dir: talk, nodeModulesOnly: true })
  })

  it('存在しない dir は dir-not-found の失敗になる', async () => {
    await explains('`executeSlideSync` の `dir` の検証のテストです。存在しない `dir` を指定した場合に、例外が発生し、理由が `dir-not-found` になることを確認します。')
    const error = await rejectionOf(executeSlideSync(
      { dir: path.join(state.temporaryRoot, 'never-exists'), nodeModulesOnly: false },
      plainDependencies(),
    ))

    expect(errorToReason(error)).toBe('dir-not-found')
  })

  it('移行すると、data に移行後のレイアウトの一覧と移行の情報を載せる', async () => {
    await explains('`executeSlideSync` の移行のテストです。移行前の talk-dir を `theme` つきで同期した場合に、結果へ移行後のレイアウトの一覧と、削除したファイルを含む移行の情報が含まれることを確認します。')
    const talk = await setupTalkDirectory()

    const { data } = await executeSlideSync({ dir: talk, theme: themeSpec(), nodeModulesOnly: false }, migrateDependencies())

    expect(data).toMatchObject({ event: 'slide.sync.done', theme: { name: THEME_NAME } })
    const migration = data['migration']
    const removed = isRecord(migration) ? migration['removed'] : undefined
    expect(Array.isArray(removed) ? removed : []).toStrictEqual(expect.arrayContaining(['layouts', 'pages/_references']))
    // 移行後はテーマを引けるので、一覧は空ではない。
    expect(data['categories']).not.toHaveLength(0)
    expect(data['layouts']).toHaveLength(FIXTURE_LAYOUT_COUNT)
  })

  it('移行前の形のまま nodeModulesOnly を指すと、テーマを引けないため一覧は空で、stderr に理由を出す', async () => {
    await explains('`executeSlideSync` の移行前の talk-dir のテストです。テーマを参照していない talk-dir へ `nodeModulesOnly` を指定した場合に、レイアウトの一覧が空になり、標準エラー出力へ理由を表示することを確認します。')
    const talk = await setupTalkDirectory()
    const stderr = makeStream('stderr')

    const { data } = await executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      { ...plainDependencies(), stderr: asStream(stderr) },
    )

    expect(data['categories']).toEqual([])
    expect(data['layouts']).toEqual([])
    expect(data['migration']).toBeNull()
    expect(stderr.chunks.join('')).toContain('cannot read layout catalog')
    expect(stderr.chunks.join('')).toContain('does not reference a theme')
  })
})

async function createThemedTalk(): Promise<string> {
  const talk = path.join(state.temporaryRoot, 'themed')
  await runSlideCreate(
    talk,
    { theme: themeSpec(), force: false },
    {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      now: () => 0,
      themeStoreRoot: () => path.join(state.temporaryRoot, 'store'),
    },
  )
  return talk
}

describe('slide_sync の node_modules_only (テーマを参照する talk-dir)', () => {
  it('node_modules を削除した talk-dir を同期すると、package.json の spec のテーマでリンクを作り直し、レイアウトの一覧を出力する', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-05')
    await explains('テーマを参照する talk-dir に対する、`slide sync --node-modules-only --json` のテストです。`node_modules` を削除した場合に、テーマのリンクが作り直され、レイアウト 8 件が出力され、`slides.md` は変更されないことを確認します。')
    const talk = await createThemedTalk()
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })

    const { data } = await executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      plainDependencies(),
    )

    expect(data).toMatchObject({ event: 'slide.sync.done', nodeModulesOnly: true })
    expect(data['layouts']).toHaveLength(FIXTURE_LAYOUT_COUNT)
    expect(realpathSync(path.join(talk, 'node_modules', FIXTURE_THEME_NAME))).toBe(realpathSync(state.themeDirectory))
    // 作品領域は触らない。
    expect(readOutput(path.join(talk, 'slides.md'))).toContain(`theme: ${THEME_NAME}`)
  })

  it('テーマの取得に失敗したら、theme-<reason> と文言で止まる', async () => {
    await explains('`executeSlideSync` のテーマの取得に失敗した場合のテストです。テーマの取得が失敗した場合に、例外が発生し、理由が `theme-tag` で、メッセージに原因の説明が含まれることを確認します。')
    const talk = await createThemedTalk()

    const error = await rejectionOf(executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      { ...plainDependencies(), ensureThemeLinked: () => Promise.reject(new ThemeFetchError('tag not found in the theme source: v9.9.9 (fix: check the tag name)', 'tag')) },
    ))

    expect(errorToReason(error)).toBe('theme-tag')
    expect(error instanceof Error ? error.message : '').toContain('check the tag name')
  })
})

function git(cwd: string, ...arguments_: readonly string[]): void {
  const environment = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) Reflect.deleteProperty(environment, name)
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...arguments_],
    { cwd, env: environment, stdio: 'pipe' },
  )
}

describe('slide sync (移行済みの talk-dir で、依存の版を替えて通常の sync を打つ)', () => {
  const FIXTURE_THEME_NAME = 'slidev-theme-pecotv-test-declared'
  const THEMES = path.join(HERE, '..', '..', 'fixtures', 'themes')

  /**
  fixture `with-declaration` から、v1.0.0 / v1.0.1 の注釈付きタグを持つ bare リポジトリを作り、その url を返す。
  タグ間で変わるのは `layouts/plain.vue` の 1 行と、v1.0.1 の `peerDependencies` に足した `@vueuse/core` だけ。
  */
  function createThemeRepository(): string {
    const source = path.join(state.temporaryRoot, 'theme-src')
    cpSync(path.join(THEMES, 'with-declaration'), source, { recursive: true })
    const manifestPath = path.join(source, 'package.json')
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace('file:../theme-only-dep', () => `file:${path.join(THEMES, 'theme-only-dep')}`),
      'utf8',
    )
    git(source, 'init', '-q')
    for (const tag of ['v1.0.0', 'v1.0.1']) {
      const layoutPath = path.join(source, 'layouts', 'plain.vue')
      const original = readFileSync(layoutPath, 'utf8').replace(/<p class="version-mark">.*<\/p>\n?/u, '')
      writeFileSync(layoutPath, original.replace('<slot />', () => `<p class="version-mark">mark-${tag}</p>\n    <slot />`), 'utf8')
      if (tag === 'v1.0.1') {
        const manifest = readFileSync(manifestPath, 'utf8')
        writeFileSync(manifestPath, manifest.replace('"vue": "^3.5.44"', () => '"vue": "^3.5.44",\n    "@vueuse/core": "^10.0.0"'), 'utf8')
      }
      git(source, 'add', '-A')
      git(source, 'commit', '-q', '-m', tag)
      git(source, 'tag', '-a', tag, '-m', tag)
    }
    const bare = path.join(state.temporaryRoot, 'theme.git')
    git(state.temporaryRoot, 'clone', '-q', '--bare', source, bare)
    return `file://${bare}`
  }

  const storeRoot = (): string => path.join(state.temporaryRoot, 'store')

  async function createTalk(url: string): Promise<string> {
    const talk = path.join(state.temporaryRoot, 'versioned')
    await runSlideCreate(
      talk,
      { theme: `git+${url}#v1.0.0`, force: false },
      {
        pluginRoot: PLUGIN_ROOT,
        stdout: asStream(makeStream()),
        stderr: asStream(makeStream()),
        now: () => 0,
        themeStoreRoot: storeRoot,
      },
    )
    return talk
  }

  function buildDependencies(): SlideSyncDependencies {
    return {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      // 取得の置き場を create と揃える。
      ensureThemeLinked: directory => ensureTalkThemeLinked(directory, { ...linkedThemeDefaultDependencies(PLUGIN_ROOT), storeRoot }),
    }
  }

  /**
  node_modules を除く全ファイルの相対パスと内容（symlink は向き先）。
  */
  function snapshotOutsideNodeModules(directory: string): Map<string, string> {
    const entries = new Map<string, string>()
    const walk = (current: string): void => {
      const children = readdirSync(current, { withFileTypes: true })
      for (const entry of children) {
        const target = path.join(current, entry.name)
        const relative = path.relative(directory, target)
        if (relative === 'node_modules') continue
        if (entry.isSymbolicLink()) entries.set(relative, `-> ${readlinkSync(target)}`)
        else if (entry.isDirectory()) {
          entries.set(relative, '<dir>')
          walk(target)
        }
        else entries.set(relative, readFileSync(target, 'utf8'))
      }
    }
    walk(directory)
    return entries
  }

  /**
  生成した設定を vite が設定を読むときと同じ関数で評価し、`resolve.dedupe` を取り出す。
  設定の読み込みは一時ファイルを作るため、スナップショットの比較の後に呼ぶ。
  */
  async function loadDedupe(talk: string): Promise<unknown> {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(talk, 'vite.config.ts'), talk)
    const resolve: unknown = loaded === null ? undefined : Reflect.get(loaded.config, 'resolve')
    return isRecord(resolve) ? resolve['dedupe'] : undefined
  }

  it('テーマの版を上げて同期すると、vite.config.ts は変わらず、テーマが追加した peer が次の読み込みで dedupe に入る', async () => {
    await explains('テーマの版を `v1.0.0` から `v1.0.1` へ上げた場合の、`slide sync` のテストです。`vite.config.ts` と `node_modules` 以外のファイルが変わらず、`v1.0.1` が追加した `@vueuse/core` が `resolve.dedupe` に加わることを確認します。')
    const url = createThemeRepository()
    const talk = await createTalk(url)
    expect(await loadDedupe(talk)).toStrictEqual(['@slidev/client', 'vue'])
    const configPath = path.join(talk, 'vite.config.ts')
    const configBefore = readFileSync(configPath)
    const packagePath = path.join(talk, 'package.json')
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8').replace('#v1.0.0', '#v1.0.1'), 'utf8')
    const before = snapshotOutsideNodeModules(talk)

    await executeSlideSync({ dir: talk, nodeModulesOnly: false }, buildDependencies())

    expect(readFileSync(configPath).equals(configBefore)).toBe(true)
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    expect(await loadDedupe(talk)).toStrictEqual(['@slidev/client', 'vue', '@vueuse/core'])
  }, 120_000)

  const REWRITE_CASES: readonly { name: string, nodeModulesOnly: boolean, id: string }[] = [
    { name: '通常の sync', nodeModulesOnly: false, id: 'PV-SLIDE-SYNC-04' },
    { name: '--node-modules-only', nodeModulesOnly: true, id: 'PV-SLIDE-SYNC-05' },
  ]
  it.for(REWRITE_CASES)('旧内容の生成ファイルがある移行済みの talk-dir は、$name で本体の今の内容に書き直す', { timeout: 120_000 }, async (row, context) => {
    await verifies(context, row.id)
    await explains(`生成ファイルが旧い内容の、移行済みの talk-dir に対する、\`slide sync\`（${row.name}）のテストです。\`vite.config.ts\` と \`start.mjs\` が本体の現在の内容に書き直され、\`start.mjs\` に実行権限が付き、ほかのファイルは変更されないことを確認します。`)
    const { nodeModulesOnly } = row
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const configPath = path.join(talk, 'vite.config.ts')
    const startPath = path.join(talk, 'start.mjs')
    const expectedConfig = readOutput(configPath)
    writeFileSync(configPath, 'export default {} // OLD', 'utf8')
    writeFileSync(startPath, 'OLD-START', { mode: 0o644 })
    const before = snapshotOutsideNodeModules(talk)

    await executeSlideSync({ dir: talk, nodeModulesOnly }, buildDependencies())

    expect(readOutput(configPath)).toBe(expectedConfig)
    expect(readOutput(startPath)).toBe(START_SCRIPT_SOURCE)
    expect(statSync(startPath).mode & 0o777).toBe(0o755)
    expect(withoutGeneratedFiles(snapshotOutsideNodeModules(talk))).toStrictEqual(withoutGeneratedFiles(before))
  })

  it('依存の版を書き換えて同期すると、新しい版のテーマでリンクを作り直し、node_modules 以外は変更しない', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-03')
    await explains('`package.json` の依存の版を `v1.0.0` から `v1.0.1` へ書き換えた場合の、`slide sync --json` のテストです。`v1.0.1` のテーマの置き場へリンクされ、結果のイベントに新しい版が含まれ、`node_modules` 以外は変わらないことを確認します。')
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const packagePath = path.join(talk, 'package.json')
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8').replace('#v1.0.0', '#v1.0.1'), 'utf8')
    const before = snapshotOutsideNodeModules(talk)
    const { data } = await executeSlideSync({ dir: talk, nodeModulesOnly: false }, buildDependencies())

    // eslint-disable-next-line no-restricted-syntax -- data の theme を検証用に narrowing
    const theme = data['theme'] as { name: string, spec: string, directory: string }
    expect(data).toMatchObject({ event: 'slide.sync.done', nodeModulesOnly: false })
    expect(theme.name).toBe(FIXTURE_THEME_NAME)
    expect(theme.spec.endsWith('#v1.0.1')).toBe(true)
    const expectedDirectory = path.join(themeStoreDirectory(storeRoot(), { url, tag: 'v1.0.1' }), 'package')
    expect(theme.directory).toBe(expectedDirectory)
    expect(realpathSync(path.join(talk, 'node_modules', FIXTURE_THEME_NAME))).toBe(realpathSync(expectedDirectory))

    // node_modules のほかは、内容と一覧が変わらない（自動 lint と一覧の読み取りを含む）。
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    for (const copied of ['layouts', 'components', 'styles', 'setup', 'public/assets']) {
      expect(existsSync(path.join(talk, copied)), `${copied} が複写されている`).toBe(false)
    }
  }, 120_000)

  it('package.json が JSON として読めない移行済みの talk-dir は、theme-unlinked のエラーで止まり、何も書き換えない', async () => {
    await explains('`package.json` が不正な talk-dir に対する、`slide sync --json` のテストです。`slide.sync.error` のイベントに理由 `theme-unlinked` が含まれ、終了コードが 1 になり、ファイルが書き換わらないことを確認します。')
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const packagePath = path.join(talk, 'package.json')
    const broken = '{ "dependencies": { "x": "1" '
    writeFileSync(packagePath, broken, 'utf8')
    const before = snapshotOutsideNodeModules(talk)
    const error = await rejectionOf(executeSlideSync({ dir: talk, nodeModulesOnly: false }, buildDependencies()))

    expect(errorToReason(error)).toBe('theme-unlinked')
    expect(readFileSync(packagePath, 'utf8')).toBe(broken)
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
  }, 120_000)
})
