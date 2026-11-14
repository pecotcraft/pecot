// commands/slidev-project/sync.ts の unit test。
// commander parseAsync を使う。
// commander のオプションパース挙動 / json error / usage error マッピング / default deps factory を網羅する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SlideSyncRuntimeError,
  SlideSyncUsageError,
  createSlideSyncCommand,
  errorToReason,
  isUsageError,
  runSlideSyncFromCli,
  slideSyncDefaultDependencies,
} from '../../../src/commands/slidev-project/sync.js'
import type { EnsureThemeLinkedPort } from '../../../src/domain/slidev-project/sync.js'
import { viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import { ThemeSpecError } from '../../../src/domain/slidev-theme/theme-spec.js'
import {
  SlideCreateRuntimeError,
  SlideCreateUsageError,
} from '../../../src/domain/slidev-project/errors.js'
import { parseJsonRecord } from '../../_helpers/records.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { verifies } from '../../_helpers/verifies.js'

// 実テンプレートが必要なテストは integration 側で実行するため、unit ではコマンドの
// パース / エラーマッピング / default deps factory に絞る。

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

const temporaryRoot = useTemporaryDirectory('pecotv-slide-sync-unit-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('SlideSyncUsageError / SlideSyncRuntimeError re-export', () => {
  it('command module から例外型が再エクスポートされる', () => {
    expect(new SlideSyncUsageError('x', 'relative-dir').reason).toBe('relative-dir')
    expect(new SlideSyncRuntimeError('y', 'unknown').reason).toBe('unknown')
  })
})

describe('createSlideSyncCommand エラーマッピング', () => {
  it('--dir 相対パス + --json で slide.sync.error(relative-dir) + exit 2', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(), // template 解決前にエラーするのでダミーで OK
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', 'relative/path', '--json'], { from: 'user' })
      const lastLine = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastLine) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('relative-dir')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('存在しない絶対パス + --json で slide.sync.error(dir-not-found) + exit 1', async () => {
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))
    const previousExitCode = process.exitCode
    const fakeAbsolute = temporaryRoot('never-exists')
    try {
      await command.parseAsync(['--dir', fakeAbsolute, '--json'], { from: 'user' })
      const lines = stdout.chunks.join('').trim().split('\n')
      expect(lines.length).toBe(1)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lines[0] ?? '') as { event: string, reason: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('dir-not-found')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('slides.md 無し dir + --json で slide.sync.error(not-talk-dir)', async () => {
    const empty = temporaryRoot('empty')
    mkdirSync(empty)
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', empty, '--json'], { from: 'user' })
      const lastLine = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastLine) as { event: string, reason: string }
      expect(parsed.reason).toBe('not-talk-dir')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('ファイル指定 (not-a-directory) + --json で reason="not-a-directory"', async () => {
    const filePath = temporaryRoot('a-file')
    writeFileSync(filePath, '')
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', filePath, '--json'], { from: 'user' })
      const lastLine = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastLine) as { event: string, reason: string }
      expect(parsed.reason).toBe('not-a-directory')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--dir 未指定 + --json で commander writeErr が slide.sync.error(invalid-option) を吐く', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'sync', '--json']
    try {
      await expect(
        command.parseAsync(['--json'], { from: 'user' }),
      ).rejects.toThrow()
      const written = stdout.chunks.join('').trim()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(written) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('invalid-option')
      expect(stderr.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('--dir 未指定 + --json なしは commander が stderr に英文を出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'sync']
    try {
      await expect(
        command.parseAsync([], { from: 'user' }),
      ).rejects.toThrow()
      expect(stderr.chunks.join('')).toContain('--dir')
      expect(stdout.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('相対パス + --json なしは stderr に "error: slide sync 失敗:" が出る', async () => {
    const stderr = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot(),
      stdout: asStream(makeStream()),
      stderr: asStream(stderr),
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', 'relative/p'], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('error: slide sync failed:')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })
})

function createLegacyTalk(): string {
  const talk = temporaryRoot('legacy')
  mkdirSync(talk)
  writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n')
  return talk
}

const withoutTheme: EnsureThemeLinkedPort = () => Promise.resolve({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })

describe('createSlideSyncCommand 成否行とテーマ', () => {
  const THEME_NAME = 'slidev-theme-sample'
  const THEME_SPEC = 'git+https://example.com/org/theme.git#v1.0.1'
  const THEME_DIRECTORY = '/store/abc/v1.0.1/package'

  // 移行済みの talk-dir（theme: が package.json の依存のテーマを指す）。
  function createMigratedTalk(): string {
    const talk = temporaryRoot('migrated')
    mkdirSync(talk)
    writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${THEME_NAME}\n---\n`)
    writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'migrated', dependencies: { [THEME_NAME]: THEME_SPEC } }))
    return talk
  }

  const relinkedTheme: EnsureThemeLinkedPort = () => Promise.resolve({
    relinked: true, regenerated: false,
    theme: { name: THEME_NAME, spec: THEME_SPEC, directory: THEME_DIRECTORY },
    nodeModulesTarget: '/runtime/current/node_modules',
  })

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  function buildCommand(stdout: CapturedStream, ensureThemeLinked: EnsureThemeLinkedPort): ReturnType<typeof createSlideSyncCommand> {
    return createSlideSyncCommand(() => ({
      pluginRoot: temporaryRoot('plugin'),
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      ensureThemeLinked,
    }))
  }

  it('移行済みの talk-dir の通常 sync は、テーマの name と spec・置き場・変えていない旨を出す', async () => {
    const talk = createMigratedTalk()
    const stdout = makeStream()

    await buildCommand(stdout, relinkedTheme).parseAsync(['--dir', talk], { from: 'user' })

    const lines = stdout.chunks.join('').split('\n')
    expect(lines.slice(0, 5)).toStrictEqual([
      `slide sync: success (${talk})`,
      `  theme: ${THEME_NAME} (${THEME_SPEC})`,
      `  location: ${THEME_DIRECTORY}`,
      '  node_modules → /runtime/current/node_modules',
      '  nothing changed except node_modules',
    ])
  })

  it('--node-modules-only は、今の行にテーマの name と spec を添える', async () => {
    const talk = createMigratedTalk()
    const stdout = makeStream()

    await buildCommand(stdout, relinkedTheme).parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })

    expect(stdout.chunks.join('').split('\n').slice(0, 3)).toStrictEqual([
      `slide sync (node_modules only): success (${talk})`,
      `  theme: ${THEME_NAME} (${THEME_SPEC})`,
      '  node_modules → /runtime/current/node_modules',
    ])
  })

  it('--node-modules-only でテーマ無しの talk-dir は、今の行のままでテーマの行を出さない', async () => {
    const talk = createLegacyTalk()
    const stdout = makeStream()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)
    const command = createSlideSyncCommand(() => ({
      pluginRoot,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      ensureThemeLinked: withoutTheme,
    }))

    await command.parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })

    const lines = stdout.chunks.join('').split('\n')
    expect(lines[0]).toBe(`slide sync (node_modules only): success (${talk})`)
    expect(lines[1]).toBe(`  node_modules → ${path.join(pluginRoot, 'node_modules')}`)
    expect(stdout.chunks.join('')).not.toContain('theme:')
  })

  it('--json の slide.sync.done は theme を { name, spec, directory } で載せる', async () => {
    const talk = createMigratedTalk()
    const stdout = makeStream()

    await buildCommand(stdout, relinkedTheme).parseAsync(['--dir', talk, '--json'], { from: 'user' })

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(stdout.chunks.join('').trim()) as Record<string, unknown>
    expect(parsed['event']).toBe('slide.sync.done')
    expect(parsed['theme']).toStrictEqual({ name: THEME_NAME, spec: THEME_SPEC, directory: THEME_DIRECTORY })
    expect(parsed['nodeModulesTarget']).toBe('/runtime/current/node_modules')
  })

  it('package.json が読めない移行済みの talk-dir は、複写に進まず theme-unlinked で止まる', async () => {
    const talk = createMigratedTalk()
    writeFileSync(path.join(talk, 'package.json'), '{ "dependencies": { ')
    const stdout = makeStream()
    const ensureThemeLinked = vi.fn<EnsureThemeLinkedPort>()
    const previousExitCode = process.exitCode
    try {
      await buildCommand(stdout, ensureThemeLinked).parseAsync(['--dir', talk, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.sync.error')
      expect(parsed.reason).toBe('theme-unlinked')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
    expect(ensureThemeLinked).not.toHaveBeenCalled()
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(readFileSync(path.join(talk, 'package.json'), 'utf8')).toBe('{ "dependencies": { ')
  })
})

const NO_STORE_ROOT = (): string | undefined => undefined

describe('slide sync --theme (移行前の talk-dir)', () => {
  const THEME_FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'themes', 'with-declaration')
  const THEME_NAME = 'slidev-theme-pecotv-test-declared'

  // 移行前の talk-dir。テンプレートのコピーに当たる名前と、作品を持つ。
  function createLegacyTalkWithWork(): string {
    const talk = temporaryRoot('legacy-work')
    mkdirSync(path.join(talk, 'layouts'), { recursive: true })
    mkdirSync(path.join(talk, 'pages', '_references'), { recursive: true })
    mkdirSync(path.join(talk, 'public', 'assets'), { recursive: true })
    mkdirSync(path.join(talk, 'public', 'slides'), { recursive: true })
    writeFileSync(path.join(talk, 'layouts', 'cover.vue'), '<template />')
    writeFileSync(path.join(talk, 'pages', '_references', 'cover.yaml'), 'x: 1\n')
    writeFileSync(path.join(talk, 'pages', 'cover.md'), 'COVER')
    writeFileSync(path.join(talk, 'public', 'slides', 'a.txt'), 'A')
    writeFileSync(path.join(talk, '.gitignore'), 'node_modules\n')
    writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'legacy-work', dependencies: { vue: '1' } }))
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\ntitle: Legacy\n---\n# 表紙\n')
    return talk
  }

  function buildCommand(pluginRoot: string): { command: ReturnType<typeof createSlideSyncCommand>, stdout: CapturedStream } {
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      themeStoreRoot: () => temporaryRoot('store'),
      fetchTheme: () => Promise.resolve({ name: THEME_NAME, directory: THEME_FIXTURE, reused: false }),
    }))
    return { command, stdout }
  }

  async function failureOf(arguments_: readonly string[]): Promise<{ parsed: Record<string, unknown>, exitCode: typeof process.exitCode }> {
    const { command, stdout } = buildCommand(temporaryRoot('plugin'))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync([...arguments_, '--json'], { from: 'user' })
      return { parsed: parseJsonRecord(stdout.chunks.join('').trim()), exitCode: process.exitCode }
    }
    finally {
      process.exitCode = previousExitCode
    }
  }

  it('--theme が無ければ theme-required (exit 2) で、CLI と MCP の打ち方を示し、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()

    const { parsed, exitCode } = await failureOf(['--dir', talk])

    expect(parsed['event']).toBe('slide.sync.error')
    expect(parsed['reason']).toBe('theme-required')
    expect(String(parsed['detail'])).toContain(`slide sync --dir ${talk} --theme <theme-spec>`)
    expect(String(parsed['detail'])).toContain('slide_sync')
    expect(exitCode).toBe(2)
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('--node-modules-only との同時指定は theme-with-node-modules-only (exit 2)', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-08')
    const talk = createLegacyTalkWithWork()

    const { parsed, exitCode } = await failureOf(['--dir', talk, '--theme', 'file:/abs/theme', '--node-modules-only'])

    expect(parsed['reason']).toBe('theme-with-node-modules-only')
    expect(exitCode).toBe(2)
  })

  it('解釈できない --theme は usage error (exit 2) で、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()

    const { parsed, exitCode } = await failureOf(['--dir', talk, '--theme', 'git+https://example.com/org/theme.git'])

    expect(parsed['reason']).toBe('theme-tag-required')
    expect(exitCode).toBe(2)
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toContain('theme: none')
  })

  it('依存ルートの実体が無ければ、取得の前に止まり、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()
    const fetchTheme = vi.fn()
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      await createSlideSyncCommand(() => ({
        pluginRoot: temporaryRoot('no-runtime'),
        stdout: asStream(stdout),
        stderr: asStream(makeStream()),
        themeStoreRoot: () => temporaryRoot('store'),
        fetchTheme,
      })).parseAsync(['--dir', talk, '--theme', 'file:/abs/theme', '--json'], { from: 'user' })
      const parsed = parseJsonRecord(stdout.chunks.join('').trim())
      expect(parsed['reason']).toBe('symlink-failed')
    }
    finally {
      process.exitCode = previousExitCode
    }
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('テーマの置き場を決められなければ theme-unknown で止まり、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => ({
      pluginRoot,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      themeStoreRoot: NO_STORE_ROOT,
    }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync(['--dir', talk, '--theme', 'file:/abs/theme', '--json'], { from: 'user' })
      const parsed = parseJsonRecord(stdout.chunks.join('').trim())
      expect(parsed['reason']).toBe('theme-unknown')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('移行すると、消した名前・テーマ・移行の情報を人向けの行と JSON に出す', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)
    const { command, stdout: human } = buildCommand(pluginRoot)
    await command.parseAsync(['--dir', talk, '--theme', `file:${THEME_FIXTURE}`], { from: 'user' })
    const lines = human.chunks.join('').split('\n')
    expect(lines[0]).toBe(`slide sync: success (${talk})`)
    expect(lines[1]).toBe(`  theme: ${THEME_NAME} (file:${path.relative(talk, THEME_FIXTURE)})`)
    expect(lines).toContain('  removed (3): layouts, pages/_references, public/assets')
  })

  it('--json の slide.sync.done は migration.removed と warnings を載せる', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)
    const { command, stdout } = buildCommand(pluginRoot)

    await command.parseAsync(['--dir', talk, '--theme', `file:${THEME_FIXTURE}`, '--json'], { from: 'user' })

    const parsed = parseJsonRecord(stdout.chunks.join('').trim())
    expect(parsed['event']).toBe('slide.sync.done')
    expect(parsed['migration']).toStrictEqual({ removed: ['layouts', 'pages/_references', 'public/assets'] })
    expect(parsed['theme']).toStrictEqual({
      name: THEME_NAME,
      spec: `file:${path.relative(talk, THEME_FIXTURE)}`,
      directory: THEME_FIXTURE,
    })
    expect(parsed['warnings']).toStrictEqual([])
  })

  it('runSlideSyncFromCli で移行し、作品と .gitignore を残して、テーマ付きの生成物を書く', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)

    const summary = await runSlideSyncFromCli(talk, { nodeModulesOnly: false, theme: `file:${THEME_FIXTURE}` }, {
      pluginRoot,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      themeStoreRoot: () => temporaryRoot('store'),
      fetchTheme: () => Promise.resolve({ name: THEME_NAME, directory: THEME_FIXTURE, reused: false }),
    })

    expect(summary.mode).toBe('migrate')
    expect(summary.removed).toStrictEqual(['layouts', 'pages/_references', 'public/assets'])
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toBe(`---\ntheme: ${THEME_NAME}\ntitle: Legacy\n---\n# 表紙\n`)
    const migratedPackage: unknown = JSON.parse(readFileSync(path.join(talk, 'package.json'), 'utf8'))
    expect(migratedPackage).toStrictEqual({
      name: 'legacy-work',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { [THEME_NAME]: `file:${path.relative(talk, THEME_FIXTURE)}` },
    })
    expect(readFileSync(path.join(talk, 'pages', 'cover.md'), 'utf8')).toBe('COVER')
    expect(readFileSync(path.join(talk, 'public', 'slides', 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(path.join(talk, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource({ themeName: THEME_NAME }))
    expect(existsSync(path.join(talk, 'node_modules', THEME_NAME))).toBe(true)
  })

  it('取得の警告は stderr に流す', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)
    const stderr = makeStream()

    await runSlideSyncFromCli(talk, { nodeModulesOnly: false, theme: `file:${THEME_FIXTURE}` }, {
      pluginRoot,
      stdout: asStream(makeStream()),
      stderr: asStream(stderr),
      themeStoreRoot: () => temporaryRoot('store'),
      fetchTheme: (_spec, options) => {
        options.warn?.('取得の警告')
        return Promise.resolve({ name: THEME_NAME, directory: THEME_FIXTURE, reused: false })
      },
    })

    expect(stderr.chunks.join('')).toContain('warning: 取得の警告')
  })
})

describe('runSlideSyncFromCli helper', () => {
  it('relative-dir を assertTalkDirectory が SlideSyncUsageError として上げる', async () => {
    const stdout = asStream(makeStream())
    const stderr = asStream(makeStream())
    await expect(
      runSlideSyncFromCli('relative/p', { nodeModulesOnly: false }, {
        pluginRoot: temporaryRoot(),
        stdout,
        stderr,
      }),
    ).rejects.toThrow(SlideSyncUsageError)
  })
})

describe('errorToReason', () => {
  it('SlideSyncUsageError は reason をそのまま返す', () => {
    expect(errorToReason(new SlideSyncUsageError('m', 'relative-dir'))).toBe('relative-dir')
  })

  it('SlideSyncRuntimeError は reason をそのまま返す', () => {
    expect(errorToReason(new SlideSyncRuntimeError('m', 'symlink-failed'))).toBe('symlink-failed')
  })

  it('SlideCreateRuntimeError も reason を伝播する（infra 層からの想定ルート）', () => {
    expect(errorToReason(new SlideCreateRuntimeError('m', 'copy-failed'))).toBe('copy-failed')
  })

  it('テーマの指定の誤りは theme-<reason>', () => {
    expect(errorToReason(new ThemeSpecError('m', 'tag-required'))).toBe('theme-tag-required')
  })

  it('未知の Error は "unknown" にまとめる', () => {
    expect(errorToReason(new Error('m'))).toBe('unknown')
  })
})

describe('isUsageError', () => {
  it('SlideSyncUsageError は usage error', () => {
    expect(isUsageError(new SlideSyncUsageError('m', 'relative-dir'))).toBe(true)
  })

  it('SlideCreateUsageError も usage error 扱い', () => {
    expect(isUsageError(new SlideCreateUsageError('m', 'missing-option'))).toBe(true)
  })

  it('テーマの指定の誤り (ThemeSpecError) も usage error', () => {
    expect(isUsageError(new ThemeSpecError('m', 'tag-required'))).toBe(true)
  })

  it('SlideSyncRuntimeError は runtime error', () => {
    expect(isUsageError(new SlideSyncRuntimeError('m', 'unknown'))).toBe(false)
  })

  it('SlideCreateRuntimeError は runtime error', () => {
    expect(isUsageError(new SlideCreateRuntimeError('m', 'copy-failed'))).toBe(false)
  })
})

describe('slideSyncDefaultDependencies', () => {
  it('CLAUDE_PLUGIN_ROOT を読んで pluginRoot を構築する', () => {
    const previous = process.env['CLAUDE_PLUGIN_ROOT']
    process.env['CLAUDE_PLUGIN_ROOT'] = '/tmp/x'
    try {
      const dependencies = slideSyncDefaultDependencies()
      expect(dependencies.pluginRoot).toBe('/tmp/x')
      expect(dependencies.stdout).toBe(process.stdout)
      expect(dependencies.stderr).toBe(process.stderr)
    }
    finally {
      if (previous === undefined) delete process.env['CLAUDE_PLUGIN_ROOT']
      else process.env['CLAUDE_PLUGIN_ROOT'] = previous
    }
  })
})
