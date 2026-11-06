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

import { isRecord, parseJsonRecord } from '../../_helpers/records.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import {
  createSlideSyncCommand,
  runSlideSyncFromCli,
} from '../../../src/commands/slidev-project/sync.js'
import type { SlideSyncDependencies } from '../../../src/commands/slidev-project/sync.js'
import { runSlideCreate } from '../../../src/commands/slidev-project/create.js'
import { ThemeFetchError, themeStoreDirectory } from '../../../src/domain/slidev-theme/store-layout.js'
import { ensureTalkThemeLinked, linkedThemeDefaultDependencies } from '../../../src/commands/slidev-project/linked-theme.js'
import { createLegacyTalkDirectory } from '../../_helpers/talk-directory.js'
import { copyFixtureTheme } from '../../_helpers/theme-fixtures.js'
import { FIXTURE_THEME_NAME } from '../../_helpers/theme-repository.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { themeErrorReason } from '../../../src/domain/slidev-theme/error-reason.js'

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const DEPENDENCY_NODE_MODULES = path.resolve(PLUGIN_ROOT, '..', '..', 'node_modules')

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

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

// 移行の取得先。実 git には出ず、置き場は一時 dir にする。
function migrateDependencies(stdout: CapturedStream = makeStream()): SlideSyncDependencies {
  return {
    pluginRoot: PLUGIN_ROOT,
    stdout: asStream(stdout),
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

// 移行前の talk-dir（テンプレートのコピーを持つ形）。`slide create` はコピーしないため、helper で写す。
async function setupTalkDirectory(): Promise<string> {
  return await createLegacyTalkDirectory(state.temporaryRoot)
}

describe('runSlideSyncFromCli (smoke)', () => {
  it('移行前の talk-dir に --theme を付けると、テンプレート由来の名前を消してテーマを参照する形へ移し、作品と生成物と .gitignore を残す', async () => {
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
    const gitignore = readFileSync(path.join(talk, '.gitignore'), 'utf8')
    const namesBefore = new Set(readdirSync(talk))
    const slidesBefore = readFileSync(path.join(talk, 'slides.md'), 'utf8')

    const summary = await runSlideSyncFromCli(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())

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
    expect(readFileSync(path.join(talk, '.gitignore'), 'utf8')).toBe(gitignore)
    // slides.md は theme: の行だけが変わる
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toBe(
      slidesBefore.replace('theme: none', () => `theme: ${THEME_NAME}`),
    )
    // package.json は talk-dir の名前と、テーマ 1 つだけの依存
    const migratedPackage: unknown = JSON.parse(readFileSync(path.join(talk, 'package.json'), 'utf8'))
    expect(migratedPackage).toStrictEqual({
      name: 'demo',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { [THEME_NAME]: `file:${path.relative(talk, state.themeDirectory)}` },
    })
    // 生成ファイルは、手直しがあっても本体の生成物で書き直される。/theme/ の配信を含む
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource({ themeName: THEME_NAME }))
    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)
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

  it('--theme が無い移行前の talk-dir は、theme-required で止まり、何も変えない', async () => {
    const talk = await setupTalkDirectory()
    const before = snapshotOutsideNodeModules(talk)
    const nodeModulesLinkBefore = readlinkSync(path.join(talk, 'node_modules', 'vue'))

    const thrown = await rejectionOf(runSlideSyncFromCli(talk, { nodeModulesOnly: false }, migrateDependencies()))

    expect(thrown).toMatchObject({ name: 'SlideSyncUsageError', reason: 'theme-required' })
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue'))).toBe(nodeModulesLinkBefore)
  })

  it('取得できないテーマを渡すと、何も消さずに止まる', async () => {
    const talk = await setupTalkDirectory()
    const before = snapshotOutsideNodeModules(talk)

    const thrown = await rejectionOf(runSlideSyncFromCli(
      talk,
      { nodeModulesOnly: false, theme: `file:${path.join(state.temporaryRoot, 'no-such-theme')}` },
      migrateDependencies(),
    ))

    expect(thrown).toBeInstanceOf(Error)
    expect(themeErrorReason(thrown)).toBeDefined()
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
  })

  it('--node-modules-only は ファイル系を一切触らずに node_modules のみ張り直す', async () => {
    const talk = await setupTalkDirectory()
    // 生成ファイルを改変して、書き直されないことを見る
    writeFileSync(path.join(talk, 'vite.config.ts'), '// USER PATCH')
    writeFileSync(path.join(talk, 'start.mjs'), '// USER START')
    const viteBefore = readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')
    const pagesBefore = readdirSync(path.join(talk, 'pages')).toSorted(compareStrings)
    // node_modules を消した状態で sync を呼ぶ
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })

    await runSlideSyncFromCli(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })

    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteBefore)
    expect(readdirSync(path.join(talk, 'pages')).toSorted(compareStrings)).toStrictEqual(pagesBefore)
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe('// USER PATCH')
    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe('// USER START')
    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(lstatSync(path.join(talk, 'node_modules', 'vue')).isSymbolicLink()).toBe(true)
  })

  it('旧形の symlink 1 本の node_modules を実ディレクトリに替え、依存ルートの項目を消さない', async () => {
    const talk = await setupTalkDirectory()
    const dependencyNodeModules = DEPENDENCY_NODE_MODULES
    const itemsBefore = readdirSync(dependencyNodeModules).length
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    symlinkSync(path.relative(talk, realpathSync(dependencyNodeModules)), path.join(talk, 'node_modules'), 'dir')
    expect(lstatSync(path.join(talk, 'node_modules')).isSymbolicLink()).toBe(true)

    for (let run = 0; run < 2; run += 1) {
      await runSlideSyncFromCli(talk, { nodeModulesOnly: true }, {
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

  it('再 sync は冪等で、同じ項目が同じ向きに張り直される', async () => {
    const talk = await setupTalkDirectory()
    await runSlideSyncFromCli(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    const target1 = readlinkSync(path.join(talk, 'node_modules', 'vue'))
    const items1 = readdirSync(path.join(talk, 'node_modules')).toSorted(compareStrings)
    await runSlideSyncFromCli(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    const target2 = readlinkSync(path.join(talk, 'node_modules', 'vue'))
    expect(target1).toBe(target2)
    expect(readdirSync(path.join(talk, 'node_modules')).toSorted(compareStrings)).toStrictEqual(items1)
  })

  it('移行の 2 回目は張り直しだけで、node_modules のほかは変わらず、使わなかった --theme を警告に出す', async () => {
    const talk = await setupTalkDirectory()
    writeFileSync(path.join(talk, 'pages', '_user.md'), 'USER MARKER')
    await runSlideSyncFromCli(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())
    const afterFirst = snapshotOutsideNodeModules(talk)
    const symlinkAfterFirst = readlinkSync(path.join(talk, 'node_modules', 'vue'))

    const second = await runSlideSyncFromCli(talk, { nodeModulesOnly: false, theme: themeSpec() }, migrateDependencies())

    expect(second.mode).toBe('relink')
    expect(second.removed).toStrictEqual([])
    expect(second.warnings).toHaveLength(1)
    expect(second.warnings[0]).toContain('--theme は使いませんでした')
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(afterFirst)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue'))).toBe(symlinkAfterFirst)
    const themeLink = path.join(talk, 'node_modules', ...THEME_NAME.split('/'))
    expect(realpathSync(themeLink)).toBe(realpathSync(state.themeDirectory))
  })

  it('破損した絶対 symlink は張り替える', async () => {
    const talk = await setupTalkDirectory()
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    symlinkSync('/abs/wrong', path.join(talk, 'node_modules'), 'dir')
    await runSlideSyncFromCli(talk, { nodeModulesOnly: true }, {
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
    })
    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(readlinkSync(path.join(talk, 'node_modules', 'vue')).startsWith('/')).toBe(false)
  })
})

describe('createSlideSyncCommand (smoke)', () => {
  it('--json 成功時は slide.sync.done を stdout に出す', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))
    await command.parseAsync(['--dir', talk, '--node-modules-only', '--json'], { from: 'user' })
    const lines = stdout.chunks.join('').trim().split('\n')
    expect(lines.length).toBe(1)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(lines[0] ?? '') as { event: string, dir: string, nodeModulesOnly: boolean }
    expect(parsed.event).toBe('slide.sync.done')
    expect(parsed.dir).toBe(talk)
    expect(parsed.nodeModulesOnly).toBe(true)
  })

  it('--json なしの移行は 1 行目に成否行を出し、消した名前を続ける', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => migrateDependencies(stdout))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', talk, '--theme', themeSpec()], { from: 'user' })
      const written = stdout.chunks.join('')
      // deck lint の出力量に関わらず先頭行で成否が読めることを固定する。
      expect(written.split('\n', 1)[0]).toBe(`slide sync: 成功 (${talk})`)
      expect(written).toContain(`テーマ: ${THEME_NAME} (file:${path.relative(talk, state.themeDirectory)})`)
      expect(written).toContain('node_modules →')
      expect(written).toContain('消した名前')
      expect(written).toContain('layouts')
      expect(process.exitCode).toBe(previousExitCode)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json なし --node-modules-only も 1 行目に成否行を出す', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))
    await command.parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })
    expect(stdout.chunks.join('').split('\n', 1)[0])
      .toBe(`slide sync (node_modules のみ): 成功 (${talk})`)
  })

  it('失敗時は stderr に成否語を出し exit code 1 になる', async () => {
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(makeStream()),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', path.join(state.temporaryRoot, 'never-exists')], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('pecotv slide sync 失敗:')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json の stdout は単一行 JSON で人間向け成否行が混在しない。移行後のレイアウトの一覧を返す', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => migrateDependencies(stdout))
    await command.parseAsync(['--dir', talk, '--theme', themeSpec(), '--json'], { from: 'user' })
    const lines = stdout.chunks.join('').trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = parseJsonRecord(lines[0] ?? '')
    expect(parsed).toMatchObject({ event: 'slide.sync.done', theme: { name: THEME_NAME } })
    const migration = parsed['migration']
    const removed = isRecord(migration) ? migration['removed'] : undefined
    expect(Array.isArray(removed) ? removed : []).toStrictEqual(expect.arrayContaining(['layouts', 'pages/_references']))
    // 移行後はテーマを引けるので、一覧は空ではない。
    expect(parsed['categories']).not.toHaveLength(0)
    expect(parsed['layouts']).toHaveLength(FIXTURE_LAYOUT_COUNT)
  })

  it('移行前の形のまま --node-modules-only を打つと、テーマを引けないため一覧は空で、stderr に理由を出す', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    await command.parseAsync(['--dir', talk, '--node-modules-only', '--json'], { from: 'user' })
    const parsed = parseJsonRecord(stdout.chunks.join('').trim())
    expect(parsed['categories']).toEqual([])
    expect(parsed['layouts']).toEqual([])
    expect(parsed['migration']).toBeNull()
    expect(stderr.chunks.join('')).toContain('layout catalog を読み取れませんでした')
    expect(stderr.chunks.join('')).toContain('テーマを参照していません')
  })
})

async function createThemedTalk(): Promise<string> {
  const talk = path.join(state.temporaryRoot, 'themed')
  await runSlideCreate(
    talk,
    { theme: themeSpec(), force: false, emitCatalog: false },
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

describe('slide sync --node-modules-only (テーマを参照する talk-dir)', () => {
  it('消えた node_modules を、package.json の spec のテーマ付きで張り直し、レイアウトの一覧を返す', async () => {
    const talk = await createThemedTalk()
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))

    await command.parseAsync(['--dir', talk, '--node-modules-only', '--json'], { from: 'user' })

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, layouts: unknown[], nodeModulesOnly: boolean }
    expect(parsed.event).toBe('slide.sync.done')
    expect(parsed.nodeModulesOnly).toBe(true)
    expect(parsed.layouts).toHaveLength(FIXTURE_LAYOUT_COUNT)
    expect(realpathSync(path.join(talk, 'node_modules', FIXTURE_THEME_NAME))).toBe(realpathSync(state.themeDirectory))
    // 作品領域は触らない。
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toContain(`theme: ${THEME_NAME}`)
  })

  it('テーマの取得に失敗したら、theme-<reason> と文言で止まり、exit code 1 になる', async () => {
    const talk = await createThemedTalk()
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      ensureThemeLinked: () => Promise.reject(new ThemeFetchError('テーマの取得元にタグ \'v9.9.9\' がありません。タグ名を確認してください。', 'tag')),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', talk, '--node-modules-only', '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, reason: string, detail: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('theme-tag')
      expect(parsed.detail).toContain('タグ名を確認してください')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
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
      { theme: `git+${url}#v1.0.0`, force: false, emitCatalog: false },
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

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  function buildCommand(stdout: CapturedStream): ReturnType<typeof createSlideSyncCommand> {
    return createSlideSyncCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      // 取得の置き場を create と揃える。
      ensureThemeLinked: directory => ensureTalkThemeLinked(directory, { ...linkedThemeDefaultDependencies(PLUGIN_ROOT), storeRoot }),
    }))
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

  it('版を上げて sync すると、vite.config.ts は変わらず、テーマが足した peer が次の読み込みで dedupe に入る', async () => {
    const url = createThemeRepository()
    const talk = await createTalk(url)
    expect(await loadDedupe(talk)).toStrictEqual(['@slidev/client', 'vue'])
    const configPath = path.join(talk, 'vite.config.ts')
    const configBefore = readFileSync(configPath)
    const packagePath = path.join(talk, 'package.json')
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8').replace('#v1.0.0', '#v1.0.1'), 'utf8')
    const before = snapshotOutsideNodeModules(talk)

    await buildCommand(makeStream()).parseAsync(['--dir', talk, '--json'], { from: 'user' })

    expect(readFileSync(configPath).equals(configBefore)).toBe(true)
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    expect(await loadDedupe(talk)).toStrictEqual(['@slidev/client', 'vue', '@vueuse/core'])
  }, 120_000)

  it.each([
    ['通常の sync', ['--json']],
    ['--node-modules-only', ['--node-modules-only', '--json']],
  ])('旧内容の生成ファイルを置いた移行済みの talk-dir は、%s で本体の今の内容に書き直す', async (_name, flags) => {
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const configPath = path.join(talk, 'vite.config.ts')
    const startPath = path.join(talk, 'start.mjs')
    const expectedConfig = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, 'export default {} // OLD', 'utf8')
    writeFileSync(startPath, 'OLD-START', { mode: 0o644 })

    await buildCommand(makeStream()).parseAsync(['--dir', talk, ...flags], { from: 'user' })

    expect(readFileSync(configPath, 'utf8')).toBe(expectedConfig)
    expect(readFileSync(startPath, 'utf8')).toBe(START_SCRIPT_SOURCE)
    expect(statSync(startPath).mode & 0o777).toBe(0o755)
  }, 120_000)

  it('依存の版を書き換えて sync すると、新しい版のテーマで張り直し、node_modules のほかは変えない', async () => {
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const packagePath = path.join(talk, 'package.json')
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8').replace('#v1.0.0', '#v1.0.1'), 'utf8')
    const before = snapshotOutsideNodeModules(talk)
    const stdout = makeStream()

    await buildCommand(stdout).parseAsync(['--dir', talk, '--json'], { from: 'user' })

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(stdout.chunks.join('').trim()) as {
      event: string
      nodeModulesOnly: boolean
      theme: { name: string, spec: string, directory: string }
    }
    expect(parsed.event).toBe('slide.sync.done')
    expect(parsed.nodeModulesOnly).toBe(false)
    expect(parsed.theme.name).toBe(FIXTURE_THEME_NAME)
    expect(parsed.theme.spec.endsWith('#v1.0.1')).toBe(true)
    const expectedDirectory = path.join(themeStoreDirectory(storeRoot(), { url, tag: 'v1.0.1' }), 'package')
    expect(parsed.theme.directory).toBe(expectedDirectory)
    expect(realpathSync(path.join(talk, 'node_modules', FIXTURE_THEME_NAME))).toBe(realpathSync(expectedDirectory))

    // node_modules のほかは、内容と一覧が変わらない（自動 lint と一覧の読み取りを含む）。
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
    for (const copied of ['layouts', 'components', 'styles', 'setup', 'public/assets']) {
      expect(existsSync(path.join(talk, copied)), `${copied} が複写されている`).toBe(false)
    }
  }, 120_000)

  it('package.json が JSON として読めない移行済みの talk-dir は、theme-unlinked で止まり、何も書き換えない', async () => {
    const url = createThemeRepository()
    const talk = await createTalk(url)
    const packagePath = path.join(talk, 'package.json')
    const broken = '{ "dependencies": { "x": "1" '
    writeFileSync(packagePath, broken, 'utf8')
    const before = snapshotOutsideNodeModules(talk)
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      await buildCommand(stdout).parseAsync(['--dir', talk, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('theme-unlinked')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
    expect(readFileSync(packagePath, 'utf8')).toBe(broken)
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(snapshotOutsideNodeModules(talk)).toStrictEqual(before)
  }, 120_000)
})
