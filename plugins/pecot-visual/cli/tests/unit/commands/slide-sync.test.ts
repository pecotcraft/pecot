// commands/slidev-project/sync.ts の unit test。
// 入力エラーの reason と、結果の data・テーマの扱い・default deps factory を見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SlideSyncRuntimeError,
  SlideSyncUsageError,
  errorToReason,
  executeSlideSync,
  runSlideSyncDirectly,
  slideSyncDefaultDependencies,
} from '../../../src/commands/slidev-project/sync.js'
import type { SlideSyncDependencies, SlideSyncOptions } from '../../../src/commands/slidev-project/sync.js'
import type { EnsureThemeLinkedPort } from '../../../src/domain/slidev-project/sync.js'
import { viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import { ThemeSpecError } from '../../../src/domain/slidev-theme/theme-spec.js'
import { resolvePluginRoot } from '../../../src/infra/_shared/plugin-root.js'
import {
  SlideCreateRuntimeError,
} from '../../../src/domain/slidev-project/errors.js'
import { rejectionOf } from '../../_helpers/rejection.js'
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

// template 解決前にエラーするので pluginRoot はダミーで足りる。
function dependencies(): { pluginRoot: string, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream } {
  return { pluginRoot: temporaryRoot(), stdout: asStream(makeStream()), stderr: asStream(makeStream()) }
}

describe('executeSlideSync の入力エラー', () => {
  it('相対パスの dir は relative-dir になる', async () => {
    const error = await rejectionOf(executeSlideSync({ dir: 'relative/path', nodeModulesOnly: false }, dependencies()))

    expect(errorToReason(error)).toBe('relative-dir')
  })

  it('存在しない絶対パスは dir-not-found になる', async () => {
    const error = await rejectionOf(executeSlideSync({ dir: temporaryRoot('never-exists'), nodeModulesOnly: false }, dependencies()))

    expect(errorToReason(error)).toBe('dir-not-found')
  })

  it('slides.md 無しの dir は not-talk-dir になる', async () => {
    const empty = temporaryRoot('empty')
    mkdirSync(empty)

    const error = await rejectionOf(executeSlideSync({ dir: empty, nodeModulesOnly: false }, dependencies()))

    expect(errorToReason(error)).toBe('not-talk-dir')
  })

  it('ファイルの指定は not-a-directory になる', async () => {
    const filePath = temporaryRoot('a-file')
    writeFileSync(filePath, '')

    const error = await rejectionOf(executeSlideSync({ dir: filePath, nodeModulesOnly: false }, dependencies()))

    expect(errorToReason(error)).toBe('not-a-directory')
  })
})

function createLegacyTalk(): string {
  const talk = temporaryRoot('legacy')
  mkdirSync(talk)
  writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n')
  return talk
}

const withoutTheme: EnsureThemeLinkedPort = () => Promise.resolve({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })

describe('executeSlideSync の結果とテーマ', () => {
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

  function buildDependencies(ensureThemeLinked: EnsureThemeLinkedPort): SlideSyncDependencies {
    return {
      pluginRoot: temporaryRoot('plugin'),
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      ensureThemeLinked,
    }
  }

  it('移行済みの talk-dir の通常 sync は、data に theme を { name, spec, directory } で載せ、移行はしない', async () => {
    const talk = createMigratedTalk()

    const { data } = await executeSlideSync({ dir: talk, nodeModulesOnly: false }, buildDependencies(relinkedTheme))

    expect(data['event']).toBe('slide.sync.done')
    expect(data['theme']).toStrictEqual({ name: THEME_NAME, spec: THEME_SPEC, directory: THEME_DIRECTORY })
    expect(data['nodeModulesTarget']).toBe('/runtime/current/node_modules')
    expect(data['nodeModulesOnly']).toBe(false)
    expect(data['migration']).toBeNull()
  })

  it('nodeModulesOnly は、data に nodeModulesOnly と theme を載せる', async () => {
    const talk = createMigratedTalk()

    const { data } = await executeSlideSync({ dir: talk, nodeModulesOnly: true }, buildDependencies(relinkedTheme))

    expect(data['nodeModulesOnly']).toBe(true)
    expect(data['theme']).toMatchObject({ name: THEME_NAME, spec: THEME_SPEC })
  })

  it('nodeModulesOnly でテーマ無しの talk-dir は、theme を null にして依存ルートの node_modules を指す', async () => {
    const talk = createLegacyTalk()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)

    const { data } = await executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      { ...buildDependencies(withoutTheme), pluginRoot },
    )

    expect(data['theme']).toBeNull()
    expect(data['nodeModulesTarget']).toBe(path.join(pluginRoot, 'node_modules'))
  })

  it('package.json が読めない移行済みの talk-dir は、複写に進まず theme-unlinked で止まる', async () => {
    const talk = createMigratedTalk()
    writeFileSync(path.join(talk, 'package.json'), '{ "dependencies": { ')
    const ensureThemeLinked = vi.fn<EnsureThemeLinkedPort>()

    const error = await rejectionOf(executeSlideSync(
      { dir: talk, nodeModulesOnly: false },
      buildDependencies(ensureThemeLinked),
    ))

    expect(errorToReason(error)).toBe('theme-unlinked')
    expect(ensureThemeLinked).not.toHaveBeenCalled()
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(readFileSync(path.join(talk, 'package.json'), 'utf8')).toBe('{ "dependencies": { ')
  })
})

const NO_STORE_ROOT = (): string | undefined => undefined

describe('slide_sync の theme 指定 (移行前の talk-dir)', () => {
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

  function buildDependencies(pluginRoot: string): SlideSyncDependencies {
    return {
      pluginRoot,
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      themeStoreRoot: () => temporaryRoot('store'),
      fetchTheme: () => Promise.resolve({ name: THEME_NAME, directory: THEME_FIXTURE, reused: false }),
    }
  }

  async function failureOf(options: Readonly<SlideSyncOptions>): Promise<{ reason: string, detail: string }> {
    const pluginRoot = temporaryRoot('plugin')
    const error = await rejectionOf(executeSlideSync(options, buildDependencies(pluginRoot)))
    expect(error).toBeInstanceOf(Error)
    return { reason: errorToReason(error), detail: error instanceof Error ? error.message : '' }
  }

  it('theme が無ければ theme-required で、MCP の打ち方を示し、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()

    const { reason, detail } = await failureOf({ dir: talk, nodeModulesOnly: false })

    expect(reason).toBe('theme-required')
    expect(detail).toContain('slide_sync')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('nodeModulesOnly との同時指定は theme-with-node-modules-only', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-08')
    const talk = createLegacyTalkWithWork()

    const { reason } = await failureOf({ dir: talk, theme: 'file:/abs/theme', nodeModulesOnly: true })

    expect(reason).toBe('theme-with-node-modules-only')
  })

  it('解釈できない theme は usage error で、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()

    const { reason } = await failureOf({ dir: talk, theme: 'git+https://example.com/org/theme.git', nodeModulesOnly: false })

    expect(reason).toBe('theme-tag-required')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toContain('theme: none')
  })

  it('依存ルートの実体が無ければ、取得の前に止まり、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()
    const fetchTheme = vi.fn()
    const noRuntimeRoot = temporaryRoot('no-runtime')

    const error = await rejectionOf(executeSlideSync(
      { dir: talk, theme: 'file:/abs/theme', nodeModulesOnly: false },
      { ...buildDependencies(noRuntimeRoot), fetchTheme },
    ))

    expect(errorToReason(error)).toBe('symlink-failed')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('テーマの置き場を決められなければ theme-unknown で止まり、何も消さない', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)

    const error = await rejectionOf(executeSlideSync(
      { dir: talk, theme: 'file:/abs/theme', nodeModulesOnly: false },
      { ...buildDependencies(pluginRoot), themeStoreRoot: NO_STORE_ROOT },
    ))

    expect(errorToReason(error)).toBe('theme-unknown')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('移行すると、data に消した名前・テーマ・移行の情報を載せる', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)

    const { data } = await executeSlideSync(
      { dir: talk, theme: `file:${THEME_FIXTURE}`, nodeModulesOnly: false },
      buildDependencies(pluginRoot),
    )

    expect(data['event']).toBe('slide.sync.done')
    expect(data['migration']).toStrictEqual({ removed: ['layouts', 'pages/_references', 'public/assets'] })
    expect(data['theme']).toStrictEqual({
      name: THEME_NAME,
      spec: `file:${path.relative(talk, THEME_FIXTURE)}`,
      directory: THEME_FIXTURE,
    })
    expect(data['warnings']).toStrictEqual([])
  })

  it('runSlideSyncDirectly で移行し、作品と .gitignore を残して、テーマ付きの生成物を書く', async () => {
    const talk = createLegacyTalkWithWork()
    const pluginRoot = temporaryRoot('plugin')
    seedDependencyRoot(pluginRoot)

    const summary = await runSlideSyncDirectly(talk, { nodeModulesOnly: false, theme: `file:${THEME_FIXTURE}` }, {
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

    await runSlideSyncDirectly(talk, { nodeModulesOnly: false, theme: `file:${THEME_FIXTURE}` }, {
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

describe('runSlideSyncDirectly helper', () => {
  it('relative-dir を assertTalkDirectory が SlideSyncUsageError として上げる', async () => {
    const stdout = asStream(makeStream())
    const stderr = asStream(makeStream())
    await expect(
      runSlideSyncDirectly('relative/p', { nodeModulesOnly: false }, {
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

describe('slideSyncDefaultDependencies', () => {
  it('CLAUDE_PLUGIN_ROOT があっても読まず、pluginRoot をサーバ自身の置き場所から求める', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/installed/pecot-visual')
    try {
      const dependencies = slideSyncDefaultDependencies()
      expect(dependencies.pluginRoot).toBe(resolvePluginRoot())
      expect(dependencies.stdout).toBe(process.stdout)
      expect(dependencies.stderr).toBe(process.stderr)
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})
