// domain/slidev-project/sync.ts の unit test。
// fs と取得を fake の port に差し替え、判定の 3 通り・移行の手順・失敗時に何も消えないことを確かめる。

import { describe, expect, it, vi } from 'vitest'

import { rejectionOf } from '../../../../tests/_helpers/rejection.js'
import { ThemeFetchError } from '../../slidev-theme/store-layout.js'
import type { TalkThemeKind } from '../../slidev-theme/talk-theme.js'
import { ThemeResolveError } from '../../slidev-theme/talk-theme.js'
import { SlideCreateRuntimeError } from '../errors.js'
import {
  SlideSyncRuntimeError,
  SlideSyncUsageError,
  assertTalkDirectory,
  runSlideSync,
} from '../sync.js'
import type {
  EnsureThemeLinkedPort,
  PreparedTheme,
  SlideSyncDependencies,
  SlideSyncFsAdapter,
} from '../sync.js'

interface FakeFsState {
  exists: boolean
  isDirectory: boolean
  hasSlidesMd: boolean
  slidesMd?: string
  removed?: readonly string[]
}

interface FakeFs {
  readonly adapter: SlideSyncFsAdapter
  /**
  副作用の呼び出しを、呼ばれた順に残す。
  */
  readonly events: string[]
  readonly written: { slidesMd: string | undefined, packageJson: string | undefined }
}

const DEFAULT_SLIDES_MD = '---\ntheme: none\ntitle: Demo\n---\n'

function buildFs(
  state: Readonly<FakeFsState>,
  hooks?: Readonly<Partial<SlideSyncFsAdapter>>,
): FakeFs {
  const events: string[] = []
  const written: { slidesMd: string | undefined, packageJson: string | undefined } = { slidesMd: undefined, packageJson: undefined }
  const adapter: SlideSyncFsAdapter = {
    // eslint-disable-next-line @typescript-eslint/require-await -- fake adapter は同期実装で十分
    talkDirectoryExists: async () => ({ exists: state.exists, isDirectory: state.isDirectory }),
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    doesSlidesMdExist: async () => state.hasSlidesMd,
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    readSlidesMd: async () => {
      events.push('readSlidesMd')
      return state.slidesMd ?? DEFAULT_SLIDES_MD
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    writeSlidesMd: async (_directory: string, content: string) => {
      events.push('writeSlidesMd')
      written.slidesMd = content
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    removeTemplateEntries: async () => {
      events.push('remove')
      return state.removed ?? ['layouts', 'components']
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    writePackageJson: async (_directory: string, content: string) => {
      events.push('writePackageJson')
      written.packageJson = content
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    syncGeneratedFiles: async () => {
      events.push('generated')
      return []
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- 同上
    linkNodeModules: async () => {
      events.push('link')
      return { nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }
    },
    ...hooks,
  }
  return { adapter, events, written }
}

const PREPARED: PreparedTheme = {
  name: 'slidev-theme-sample',
  directory: '/store/abc/v1.0.0/package',
  spec: 'git+https://example.com/org/theme.git#v1.0.0',
  warnings: ['宣言の警告'],
}

const NO_THEME: EnsureThemeLinkedPort = () => Promise.resolve({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })

function buildDependencies(
  fs: Readonly<SlideSyncFsAdapter>,
  options?: Readonly<{
    kind?: TalkThemeKind
    ensureThemeLinked?: EnsureThemeLinkedPort
    prepareTheme?: SlideSyncDependencies['prepareTheme']
  }>,
): SlideSyncDependencies {
  return {
    dependencyRoot: '/abs/plugin',
    fs,
    classifyTalk: () => Promise.resolve(options?.kind ?? 'legacy'),
    prepareTheme: options?.prepareTheme ?? (() => Promise.resolve(PREPARED)),
    ensureThemeLinked: options?.ensureThemeLinked ?? NO_THEME,
  }
}

const FS_OK: FakeFsState = { exists: true, isDirectory: true, hasSlidesMd: true }

describe('assertTalkDirectory', () => {
  it('絶対パスでない場合は SlideSyncUsageError(relative-dir)', async () => {
    const { adapter } = buildFs(FS_OK)
    await expect(assertTalkDirectory('relative/p', adapter)).rejects.toBeInstanceOf(SlideSyncUsageError)
    await expect(assertTalkDirectory('relative/p', adapter)).rejects.toMatchObject({ reason: 'relative-dir' })
  })

  it('dir 不在は dir-not-found', async () => {
    const { adapter } = buildFs({ exists: false, isDirectory: false, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/missing', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/missing', adapter)).rejects.toMatchObject({ reason: 'dir-not-found' })
  })

  it('ファイルなら not-a-directory', async () => {
    const { adapter } = buildFs({ exists: true, isDirectory: false, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/file', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/file', adapter)).rejects.toMatchObject({ reason: 'not-a-directory' })
  })

  it('slides.md 無しは not-talk-dir', async () => {
    const { adapter } = buildFs({ exists: true, isDirectory: true, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/d', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/d', adapter)).rejects.toMatchObject({ reason: 'not-talk-dir' })
  })

  it('全条件 OK なら resolve する', async () => {
    const { adapter } = buildFs(FS_OK)
    await expect(assertTalkDirectory('/abs/d', adapter)).resolves.toBeUndefined()
  })
})

describe('runSlideSync (移行前の talk-dir に --theme を付ける)', () => {
  it('取得してから、消す・slides.md・package.json・生成ファイル・node_modules の順に行う', async () => {
    const fs = buildFs(FS_OK)
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>(() => {
      fs.events.push('prepare')
      return Promise.resolve(PREPARED)
    })

    const summary = await runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'git+https://example.com/org/theme.git#v1.0.0' },
      buildDependencies(fs.adapter, { prepareTheme }),
    )

    expect(prepareTheme).toHaveBeenCalledExactlyOnceWith('git+https://example.com/org/theme.git#v1.0.0', '/abs/my-talk')
    expect(fs.events).toStrictEqual([
      'prepare', 'readSlidesMd', 'remove', 'writeSlidesMd', 'writePackageJson', 'generated', 'link',
    ])
    expect(summary).toStrictEqual({
      directory: '/abs/my-talk',
      nodeModulesTarget: '/abs/plugin/node_modules',
      nodeModulesOnly: false,
      mode: 'migrate',
      theme: { name: PREPARED.name, spec: PREPARED.spec, directory: PREPARED.directory },
      removed: ['layouts', 'components'],
      warnings: ['宣言の警告'],
    })
  })

  it('slides.md の theme: をテーマ名に書き換え、package.json の依存をテーマ 1 つにする', async () => {
    const fs = buildFs(FS_OK)

    await runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'git+https://example.com/org/theme.git#v1.0.0' },
      buildDependencies(fs.adapter),
    )

    expect(fs.written.slidesMd).toBe('---\ntheme: slidev-theme-sample\ntitle: Demo\n---\n')
    expect(JSON.parse(fs.written.packageJson ?? '')).toStrictEqual({
      name: 'my-talk',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { 'slidev-theme-sample': PREPARED.spec },
    })
  })

  it('生成ファイルに、テーマ名を渡し、テーマ付きで node_modules を張る', async () => {
    const syncGeneratedFiles = vi.fn(() => Promise.resolve([]))
    const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }))
    const fs = buildFs(FS_OK, { syncGeneratedFiles, linkNodeModules })

    await runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'git+https://example.com/org/theme.git#v1.0.0' },
      buildDependencies(fs.adapter),
    )

    expect(syncGeneratedFiles).toHaveBeenCalledExactlyOnceWith('/abs/my-talk', { themeName: 'slidev-theme-sample' })
    expect(linkNodeModules).toHaveBeenCalledExactlyOnceWith(
      '/abs/my-talk',
      '/abs/plugin',
      [{ name: 'slidev-theme-sample', directory: '/store/abc/v1.0.0/package' }],
    )
  })

  it('パス形式の theme: の talk-dir も、同じ移行になる', async () => {
    const fs = buildFs({ ...FS_OK, slidesMd: '---\ntheme: ./theme\n---\n' })

    const summary = await runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter, { kind: 'legacy' }),
    )

    expect(summary.mode).toBe('migrate')
    expect(fs.written.slidesMd).toBe('---\ntheme: slidev-theme-sample\n---\n')
  })

  it('取得の失敗は原因の文言のまま返し、削除と書き込みを行わない', async () => {
    const fs = buildFs(FS_OK)
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'git+https://example.com/org/theme.git#v9' },
      buildDependencies(fs.adapter, { prepareTheme: () => Promise.reject(failure) }),
    ))

    expect(thrown).toBe(failure)
    expect(fs.events).toStrictEqual([])
  })

  it('slides.md を読めなければ、削除の前に migrate-failed で止まる', async () => {
    const fs = buildFs(FS_OK, { readSlidesMd: () => Promise.reject(new Error('EACCES')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ name: 'SlideSyncRuntimeError', reason: 'migrate-failed' })
    expect(fs.events).toStrictEqual([])
  })

  it('消す・書くの失敗は migrate-failed に包み、node_modules は張らない', async () => {
    const fs = buildFs(FS_OK, { removeTemplateEntries: () => Promise.reject(new Error('rm boom')) })

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    ))

    expect(thrown).toBeInstanceOf(SlideSyncRuntimeError)
    expect(thrown).toMatchObject({ reason: 'migrate-failed' })
    expect(thrown instanceof Error ? thrown.message : '').toContain('rm boom')
    expect(fs.events).toStrictEqual(['readSlidesMd'])
  })

  it('書き込みの失敗も migrate-failed に包む', async () => {
    const fs = buildFs(FS_OK, { syncGeneratedFiles: () => Promise.reject(new Error('disk full')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ reason: 'migrate-failed' })
  })

  it('--theme が無ければ theme-required の usage error になり、取得せず、何も消さない', async () => {
    const fs = buildFs(FS_OK)
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { prepareTheme }),
    ))

    expect(thrown).toBeInstanceOf(SlideSyncUsageError)
    expect(thrown).toMatchObject({ reason: 'theme-required' })
    const message = thrown instanceof Error ? thrown.message : ''
    expect(message).toContain('slide sync --dir /abs/my-talk --theme <theme-spec>')
    expect(message).toContain('slide_sync')
    expect(prepareTheme).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
  })

  it('linkNodeModules が未知例外を投げると symlink-failed に包む', async () => {
    const fs = buildFs(FS_OK, { linkNodeModules: () => Promise.reject(new Error('symlink boom')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ name: 'SlideSyncRuntimeError', reason: 'symlink-failed' })
  })
})

describe('runSlideSync (--node-modules-only)', () => {
  it('移行前の talk-dir でも、テーマ無しで張り直すだけにする', async () => {
    const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }))
    const fs = buildFs(FS_OK, { linkNodeModules })
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const summary = await runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true },
      buildDependencies(fs.adapter, { prepareTheme }),
    )

    expect(linkNodeModules).toHaveBeenCalledExactlyOnceWith('/abs/d', '/abs/plugin', [])
    expect(prepareTheme).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
    expect(summary).toStrictEqual({
      directory: '/abs/d',
      nodeModulesTarget: '/abs/plugin/node_modules',
      nodeModulesOnly: true,
      mode: 'relink',
      theme: undefined,
      removed: [],
      warnings: [],
    })
  })

  it('--theme との同時指定は theme-with-node-modules-only の usage error', async () => {
    const fs = buildFs(FS_OK)

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    ))

    expect(thrown).toBeInstanceOf(SlideSyncUsageError)
    expect(thrown).toMatchObject({ reason: 'theme-with-node-modules-only' })
    expect(fs.events).toStrictEqual([])
  })

  describe('テーマの張り直し', () => {
    const theme = { name: 'slidev-theme-sample', spec: 'git+https://example.com/org/theme.git#v1.0.0', directory: '/store/abc/v1.0.0/package' }

    it('張り直しが済んでいれば、その結果を使い、もう一度は張らない', async () => {
      const fs = buildFs(FS_OK)
      const ensureThemeLinked = vi.fn<EnsureThemeLinkedPort>(() => Promise.resolve({
        relinked: true,
        regenerated: false,
        theme,
        nodeModulesTarget: '/runtime/current/node_modules',
      }))

      const summary = await runSlideSync(
        { directory: '/abs/d', nodeModulesOnly: true },
        buildDependencies(fs.adapter, { ensureThemeLinked }),
      )

      expect(ensureThemeLinked).toHaveBeenCalledWith('/abs/d')
      expect(fs.events).toStrictEqual([])
      expect(summary.nodeModulesTarget).toBe('/runtime/current/node_modules')
      expect(summary.mode).toBe('relink')
      expect(summary.theme).toStrictEqual(theme)
    })

    it('印が今の値と同じで張り直さなかったときも、求められた張り直しをテーマ付きで行う', async () => {
      const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }))
      const fs = buildFs(FS_OK, { linkNodeModules })

      await runSlideSync(
        { directory: '/abs/d', nodeModulesOnly: true },
        buildDependencies(fs.adapter, {
          ensureThemeLinked: () => Promise.resolve({ relinked: false, regenerated: false, theme, nodeModulesTarget: undefined }),
        }),
      )

      expect(linkNodeModules).toHaveBeenCalledWith('/abs/d', '/abs/plugin', [{ name: theme.name, directory: theme.directory }])
    })

    it('取得の失敗は原因ごとの文言のまま伝播し、symlink-failed に包まない', async () => {
      const fs = buildFs(FS_OK)
      const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

      await expect(runSlideSync(
        { directory: '/abs/d', nodeModulesOnly: true },
        buildDependencies(fs.adapter, { ensureThemeLinked: () => Promise.reject(failure) }),
      )).rejects.toBe(failure)
    })
  })
})

describe('runSlideSync (移行済みの talk-dir)', () => {
  const theme = { name: 'slidev-theme-sample', spec: 'git+https://example.com/org/theme.git#v1.0.1', directory: '/store/abc/v1.0.1/package' }
  const relinkedTheme: EnsureThemeLinkedPort = () => Promise.resolve({
    relinked: true,
    regenerated: false,
    theme,
    nodeModulesTarget: '/runtime/current/node_modules',
  })

  it('--theme が無ければ、取得と張り直しだけを行い、消す・書くは 1 つも呼ばない', async () => {
    const fs = buildFs(FS_OK)
    const ensureThemeLinked = vi.fn<EnsureThemeLinkedPort>(relinkedTheme)
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const summary = await runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked, prepareTheme }),
    )

    expect(ensureThemeLinked).toHaveBeenCalledExactlyOnceWith('/abs/d')
    expect(prepareTheme).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
    expect(summary).toStrictEqual({
      directory: '/abs/d',
      nodeModulesTarget: '/runtime/current/node_modules',
      nodeModulesOnly: false,
      mode: 'relink',
      theme,
      removed: [],
      warnings: [],
    })
  })

  it('--theme を付けても張り直しだけを行い、使わなかったことと替え方を警告に出す', async () => {
    const fs = buildFs(FS_OK)
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const summary = await runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false, theme: 'git+https://example.com/org/other.git#v2.0.0' },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked: relinkedTheme, prepareTheme }),
    )

    expect(prepareTheme).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
    expect(summary.mode).toBe('relink')
    expect(summary.warnings).toHaveLength(1)
    const [warning] = summary.warnings
    expect(warning).toContain('--theme')
    expect(warning).toContain('was not used')
    expect(warning).toContain('edit the dependency in package.json')
  })

  it('印が今の値と同じでも、求められた張り直しをテーマ付きで行う', async () => {
    const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }))
    const fs = buildFs(FS_OK, { linkNodeModules })

    await runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, {
        kind: 'migrated',
        ensureThemeLinked: () => Promise.resolve({ relinked: false, regenerated: false, theme, nodeModulesTarget: undefined }),
      }),
    )

    expect(linkNodeModules).toHaveBeenCalledWith('/abs/d', '/abs/plugin', [{ name: theme.name, directory: theme.directory }])
  })

  it('テーマの取得の失敗は原因の文言のまま返す', async () => {
    const fs = buildFs(FS_OK)
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked: () => Promise.reject(failure) }),
    )).rejects.toBe(failure)
    expect(fs.events).toStrictEqual([])
  })

  it('theme-name-mismatch は symlink-failed に包まない', async () => {
    const fs = buildFs(FS_OK)
    const failure = new SlideCreateRuntimeError('dependencies のキーをテーマの name に合わせてください', 'theme-name-mismatch')

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked: () => Promise.reject(failure) }),
    ))

    expect(thrown).toBe(failure)
  })

  it('判定が失敗したら、その例外を返し、何も呼ばない', async () => {
    const fs = buildFs(FS_OK)
    const failure = new ThemeResolveError('package.json を読めません', 'theme-unlinked')
    const ensureThemeLinked = vi.fn<EnsureThemeLinkedPort>()

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      { ...buildDependencies(fs.adapter, { ensureThemeLinked }), classifyTalk: () => Promise.reject(failure) },
    ))

    expect(thrown).toBe(failure)
    expect(ensureThemeLinked).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
  })
})

describe('runSlideSync (pecot-theme.json を持つテーマの dir)', () => {
  it.each([
    ['--theme なし', undefined],
    ['--theme あり', 'file:/abs/theme'],
  ])('%s でも theme-root の usage error で止め、何も書き換えない', async (_label, theme) => {
    const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/abs/plugin/node_modules', entries: 3 }))
    const fs = buildFs(FS_OK, { linkNodeModules })
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false, ...(theme !== undefined && { theme }) },
      buildDependencies(fs.adapter, { kind: 'theme-root', prepareTheme }),
    ))

    expect(thrown).toBeInstanceOf(SlideSyncUsageError)
    expect(thrown).toMatchObject({ reason: 'theme-root' })
    expect(String(thrown), 'テーマの dir だと伝えていない').toContain('pecot-theme.json')
    expect(prepareTheme).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
  })
})

describe('runSlideSync エラー伝播', () => {
  it('assertTalkDirectory の usage error を伝播する', async () => {
    const fs = buildFs(FS_OK)
    await expect(runSlideSync(
      { directory: 'relative', nodeModulesOnly: false },
      buildDependencies(fs.adapter),
    )).rejects.toBeInstanceOf(SlideSyncUsageError)
  })

  it('張り直しの失敗時 infra 側の reason を尊重する', async () => {
    const fs = buildFs(FS_OK, {
      linkNodeModules: vi.fn(() => Promise.reject(new SlideSyncRuntimeError('boom', 'symlink-failed'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ reason: 'symlink-failed' })
  })

  it('linkNodeModules が未知例外を投げると symlink-failed に再ラップされる', async () => {
    const fs = buildFs(FS_OK, {
      linkNodeModules: vi.fn(() => Promise.reject(new Error('symlink boom'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({
      name: 'SlideSyncRuntimeError',
      reason: 'symlink-failed',
    })
  })

  it('移行中に SlideSyncUsageError が投げられても、そのまま上位に渡す', async () => {
    const fs = buildFs(FS_OK, {
      removeTemplateEntries: vi.fn(() => Promise.reject(new SlideSyncUsageError('rare', 'missing-option'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toBeInstanceOf(SlideSyncUsageError)
  })

  it('張り直しで SlideSyncUsageError が投げられても、そのまま上位に渡す', async () => {
    const fs = buildFs(FS_OK, {
      linkNodeModules: vi.fn(() => Promise.reject(new SlideSyncUsageError('rare', 'missing-option'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true },
      buildDependencies(fs.adapter),
    )).rejects.toBeInstanceOf(SlideSyncUsageError)
  })
})

describe('SlideSyncUsageError / SlideSyncRuntimeError', () => {
  it('reason フィールドがそのまま乗る', () => {
    const usage = new SlideSyncUsageError('m', 'missing-option')
    expect(usage.reason).toBe('missing-option')
    expect(usage.name).toBe('SlideSyncUsageError')
    const runtime = new SlideSyncRuntimeError('m', 'unknown')
    expect(runtime.reason).toBe('unknown')
    expect(runtime.name).toBe('SlideSyncRuntimeError')
  })
})
