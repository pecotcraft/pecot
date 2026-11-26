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
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('talk-dir の指定が絶対パスでない場合は、理由 relative-dir の使い方エラーを返す', async () => {
    await explains('talk-dir を検証する `assertTalkDirectory` のテストです。`relative/p` のような相対パスを渡した場合に、`SlideSyncUsageError` が発生し、理由が `relative-dir` になることを確認します。')
    const { adapter } = buildFs(FS_OK)
    await expect(assertTalkDirectory('relative/p', adapter)).rejects.toBeInstanceOf(SlideSyncUsageError)
    await expect(assertTalkDirectory('relative/p', adapter)).rejects.toMatchObject({ reason: 'relative-dir' })
  })

  it('指定した dir が存在しない場合は、理由 dir-not-found の実行エラーを返す', async () => {
    await explains('talk-dir を検証する `assertTalkDirectory` のテストです。指定したディレクトリが存在しない場合に、`SlideSyncRuntimeError` が発生し、理由が `dir-not-found` になることを確認します。')
    const { adapter } = buildFs({ exists: false, isDirectory: false, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/missing', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/missing', adapter)).rejects.toMatchObject({ reason: 'dir-not-found' })
  })

  it('指定したパスがファイルの場合は、理由 not-a-directory の実行エラーを返す', async () => {
    await explains('talk-dir を検証する `assertTalkDirectory` のテストです。指定したパスがディレクトリでなくファイルの場合に、`SlideSyncRuntimeError` が発生し、理由が `not-a-directory` になることを確認します。')
    const { adapter } = buildFs({ exists: true, isDirectory: false, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/file', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/file', adapter)).rejects.toMatchObject({ reason: 'not-a-directory' })
  })

  it('dir に slides.md が存在しない場合は、理由 not-talk-dir の実行エラーを返す', async () => {
    await explains('talk-dir を検証する `assertTalkDirectory` のテストです。`slides.md` が存在しないディレクトリを渡した場合に、`SlideSyncRuntimeError` が発生し、理由が `not-talk-dir` になることを確認します。')
    const { adapter } = buildFs({ exists: true, isDirectory: true, hasSlidesMd: false })
    await expect(assertTalkDirectory('/abs/d', adapter)).rejects.toBeInstanceOf(SlideSyncRuntimeError)
    await expect(assertTalkDirectory('/abs/d', adapter)).rejects.toMatchObject({ reason: 'not-talk-dir' })
  })

  it('絶対パスのディレクトリに slides.md が存在する場合は、エラーなく完了する', async () => {
    await explains('talk-dir を検証する `assertTalkDirectory` のテストです。絶対パスで、ディレクトリが存在し、`slides.md` もある場合に、例外が発生せず `undefined` で完了することを確認します。')
    const { adapter } = buildFs(FS_OK)
    await expect(assertTalkDirectory('/abs/d', adapter)).resolves.toBeUndefined()
  })
})

describe('runSlideSync (移行前の talk-dir に --theme を付ける)', () => {
  it('テーマを取得してから、テンプレートの削除・slides.md・package.json・生成ファイル・node_modules の順に処理する', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。処理の呼び出し順が、取得・読み込み・削除・書き込み・生成ファイル・`node_modules` の順になり、結果が `migrate` になることを確認します。')
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
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。`slides.md` の `theme:` がテーマ名に変わり、`package.json` の `dependencies` がそのテーマ 1 つだけになることを確認します。')
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

  it('生成ファイルの同期にテーマ名を渡し、テーマを指定して node_modules にリンクを張る', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。生成ファイルの同期に `themeName` が渡され、`node_modules` のリンクにテーマ名とテーマの dir が渡されることを確認します。')
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

  it('slides.md の theme: がパス形式の talk-dir も、移行前として同じ手順で移行する', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。`theme: ./theme` のようにパス形式の場合に、まとめの `mode` が `migrate` になり、`slides.md` がテーマ名に書き換わることを確認します。')
    const fs = buildFs({ ...FS_OK, slidesMd: '---\ntheme: ./theme\n---\n' })

    const summary = await runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter, { kind: 'legacy' }),
    )

    expect(summary.mode).toBe('migrate')
    expect(fs.written.slidesMd).toBe('---\ntheme: slidev-theme-sample\n---\n')
  })

  it('取得の失敗は原因の文言のまま返し、削除と書き込みを行わない', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。テーマの取得が `ThemeFetchError` で失敗した場合に、同じ例外がそのまま発生し、削除と書き込みが 1 つも呼ばれないことを確認します。')
    const fs = buildFs(FS_OK)
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'git+https://example.com/org/theme.git#v9' },
      buildDependencies(fs.adapter, { prepareTheme: () => Promise.reject(failure) }),
    ))

    expect(thrown).toBe(failure)
    expect(fs.events).toStrictEqual([])
  })

  it('slides.md を読み込めない場合は、削除の前に理由 migrate-failed で処理を止める', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。`slides.md` の読み込みが失敗した場合に、理由 `migrate-failed` の `SlideSyncRuntimeError` が発生し、削除などの処理が呼ばれないことを確認します。')
    const fs = buildFs(FS_OK, { readSlidesMd: () => Promise.reject(new Error('EACCES')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ name: 'SlideSyncRuntimeError', reason: 'migrate-failed' })
    expect(fs.events).toStrictEqual([])
  })

  it('テンプレートの削除に失敗した場合は、migrate-failed のエラーに包み、node_modules にリンクを張らない', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。削除が失敗した場合に、元のメッセージを含む理由 `migrate-failed` の `SlideSyncRuntimeError` が発生し、後続の書き込みとリンクが呼ばれないことを確認します。')
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

  it('生成ファイルの書き込みに失敗した場合も、migrate-failed のエラーに包む', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。生成ファイルの同期が失敗した場合に、理由 `migrate-failed` のエラーが発生することを確認します。')
    const fs = buildFs(FS_OK, { syncGeneratedFiles: () => Promise.reject(new Error('disk full')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ reason: 'migrate-failed' })
  })

  it('--theme を指定しない場合は、理由 theme-required の使い方エラーを返し、取得と削除をしない', async () => {
    await explains('移行前の talk-dir に `--theme` を指定しないときの、`runSlideSync` のテストです。理由 `theme-required` の `SlideSyncUsageError` が発生し、メッセージにコマンドの書き方が含まれ、取得と削除が呼ばれないことを確認します。')
    const fs = buildFs(FS_OK)
    const prepareTheme = vi.fn<SlideSyncDependencies['prepareTheme']>()

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { prepareTheme }),
    ))

    expect(thrown).toBeInstanceOf(SlideSyncUsageError)
    expect(thrown).toMatchObject({ reason: 'theme-required' })
    const message = thrown instanceof Error ? thrown.message : ''
    expect(message).toContain('slide_sync with dir: /abs/my-talk, theme: <theme-spec>')
    expect(message).toContain('slide_sync')
    expect(prepareTheme).not.toHaveBeenCalled()
    expect(fs.events).toStrictEqual([])
  })

  it('node_modules のリンクで想定外の例外が発生した場合は、symlink-failed のエラーに包む', async () => {
    await explains('移行前の talk-dir に `--theme` を指定して同期する `runSlideSync` のテストです。`linkNodeModules` が通常の `Error` を投げた場合に、`SlideSyncRuntimeError` に包まれ、理由が `symlink-failed` になることを確認します。')
    const fs = buildFs(FS_OK, { linkNodeModules: () => Promise.reject(new Error('symlink boom')) })

    await expect(runSlideSync(
      { directory: '/abs/my-talk', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ name: 'SlideSyncRuntimeError', reason: 'symlink-failed' })
  })
})

describe('runSlideSync (--node-modules-only)', () => {
  it('移行前の talk-dir でも、--node-modules-only ではテーマを指定せずにリンクを張り直すだけにする', async () => {
    await explains('`--node-modules-only` を指定して同期する `runSlideSync` のテストです。移行前の talk-dir でも、テーマを空にして `node_modules` のリンクだけが呼ばれ、まとめの `mode` が `relink` になることを確認します。')
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

  it('--node-modules-only と --theme を同時に指定した場合は、理由 theme-with-node-modules-only の使い方エラーを返す', async () => {
    await explains('`--node-modules-only` を指定して同期する `runSlideSync` のテストです。`--theme` も渡した場合に、理由 `theme-with-node-modules-only` の `SlideSyncUsageError` が発生し、書き込みなどが呼ばれないことを確認します。')
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

    it('テーマのリンクの張り直しが完了していた場合は、その結果を使い、リンクをもう一度張らない', async () => {
      await explains('移行済みのテーマを持つ talk-dir に、`--node-modules-only` を指定して同期する `runSlideSync` のテストです。`ensureThemeLinked` が張り直し済みの結果を返した場合に、まとめにその `node_modules` の場所とテーマが入り、`linkNodeModules` が呼ばれないことを確認します。')
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

    it('テーマの状態が前回と同じで張り直しが不要だった場合も、--node-modules-only ならテーマを指定してリンクを張り直す', async () => {
      await explains('移行済みのテーマを持つ talk-dir に、`--node-modules-only` を指定して同期する `runSlideSync` のテストです。`ensureThemeLinked` が張り直しをしなかった場合に、`linkNodeModules` がテーマ名とテーマの dir を指定して呼ばれることを確認します。')
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

    it('テーマの取得に失敗した場合は、原因ごとのエラーをそのまま返し、symlink-failed のエラーに包まない', async () => {
      await explains('移行済みのテーマを持つ talk-dir に、`--node-modules-only` を指定して同期する `runSlideSync` のテストです。`ensureThemeLinked` が `ThemeFetchError` で失敗した場合に、同じ例外がそのまま発生することを確認します。')
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

  it('移行済みの talk-dir に --theme を指定しない場合は、テーマの取得とリンクの張り直しだけを行い、削除と書き込みを行わない', async () => {
    await explains('移行済みの talk-dir を同期する `runSlideSync` のテストです。`--theme` を指定しない場合に、`ensureThemeLinked` が 1 回だけ呼ばれ、削除と書き込みは呼ばれず、まとめの `mode` が `relink` になることを確認します。')
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

  it('移行済みの talk-dir に --theme を指定しても、リンクの張り直しだけを行い、指定を使わなかったことを警告する', async () => {
    await explains('移行済みの talk-dir を同期する `runSlideSync` のテストです。`--theme` を指定した場合に、テーマの取得は呼ばれず、`was not used` と `package.json` の依存を編集する方法を含む警告が 1 件返ることを確認します。')
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
    expect(warning).toContain('theme was not used')
    expect(warning).toContain('was not used')
    expect(warning).toContain('edit the dependency in package.json')
  })

  it('テーマの状態が前回と同じで張り直しが不要だった場合も、テーマを指定してリンクを張り直す', async () => {
    await explains('移行済みの talk-dir を同期する `runSlideSync` のテストです。`ensureThemeLinked` が張り直しをしなかった場合に、`linkNodeModules` がテーマ名とテーマの dir を指定して呼ばれることを確認します。')
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
    await explains('移行済みの talk-dir を同期する `runSlideSync` のテストです。テーマの取得が `ThemeFetchError` で失敗した場合に、同じ例外がそのまま発生し、削除や書き込みが呼ばれないことを確認します。')
    const fs = buildFs(FS_OK)
    const failure = new ThemeFetchError('タグ名を確認してください', 'tag')

    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked: () => Promise.reject(failure) }),
    )).rejects.toBe(failure)
    expect(fs.events).toStrictEqual([])
  })

  it('テーマ名の不一致（theme-name-mismatch）のエラーは、symlink-failed のエラーに包まずそのまま返す', async () => {
    await explains('移行済みの talk-dir を同期する `runSlideSync` のテストです。`ensureThemeLinked` が理由 `theme-name-mismatch` のエラーで失敗した場合に、同じ例外がそのまま発生することを確認します。')
    const fs = buildFs(FS_OK)
    const failure = new SlideCreateRuntimeError('dependencies のキーをテーマの name に合わせてください', 'theme-name-mismatch')

    const thrown = await rejectionOf(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false },
      buildDependencies(fs.adapter, { kind: 'migrated', ensureThemeLinked: () => Promise.reject(failure) }),
    ))

    expect(thrown).toBe(failure)
  })

  it('talk-dir の種類の判定に失敗した場合は、その例外を返し、後続の処理を呼ばない', async () => {
    await explains('talk-dir の種類を判定する処理が失敗したときの、`runSlideSync` のテストです。`classifyTalk` が `ThemeResolveError` で失敗した場合に、同じ例外が発生し、`ensureThemeLinked` も削除などの処理も呼ばれないことを確認します。')
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
  ])('テーマ自体の dir を渡した場合は、%s でも理由 theme-root の使い方エラーで止め、何も書き換えない', async (_label, theme) => {
    await explains(`\`pecot-theme.json\` を持つテーマの dir を指定したときの、\`runSlideSync\` のテストです。\`${_label}\` の場合に、理由 \`theme-root\` の使い方エラーが発生し、取得や書き込みが呼ばれないことを確認します。`)
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
  it('talk-dir の検証で使い方エラーが発生した場合は、そのまま返す', async () => {
    await explains('`runSlideSync` のエラーの扱いのテストです。`assertTalkDirectory` が使い方エラーにする相対パスを渡した場合は、同じ `SlideSyncUsageError` が発生することを確認します。')
    const fs = buildFs(FS_OK)
    await expect(runSlideSync(
      { directory: 'relative', nodeModulesOnly: false },
      buildDependencies(fs.adapter),
    )).rejects.toBeInstanceOf(SlideSyncUsageError)
  })

  it('リンクの張り直しが理由つきの実行エラーで失敗した場合は、その理由を変えずに返す', async () => {
    await explains('`runSlideSync` のエラーの扱いのテストです。`linkNodeModules` が理由 `symlink-failed` の `SlideSyncRuntimeError` を投げた場合に、同じ理由のエラーが発生することを確認します。')
    const fs = buildFs(FS_OK, {
      linkNodeModules: vi.fn(() => Promise.reject(new SlideSyncRuntimeError('boom', 'symlink-failed'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: true },
      buildDependencies(fs.adapter),
    )).rejects.toMatchObject({ reason: 'symlink-failed' })
  })

  it('リンクの張り直しで想定外の例外が発生した場合は、symlink-failed の実行エラーに包み直す', async () => {
    await explains('`runSlideSync` のエラーの扱いのテストです。`linkNodeModules` が通常の `Error` を投げた場合に、理由が `symlink-failed` の `SlideSyncRuntimeError` に変わることを確認します。')
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

  it('移行中に使い方エラーが発生した場合は、別のエラーに包まずそのまま返す', async () => {
    await explains('`runSlideSync` のエラーの扱いのテストです。テンプレートの削除が `SlideSyncUsageError` を投げた場合に、`migrate-failed` に包まれず、同じ種類のエラーが発生することを確認します。')
    const fs = buildFs(FS_OK, {
      removeTemplateEntries: vi.fn(() => Promise.reject(new SlideSyncUsageError('rare', 'missing-option'))),
    })
    await expect(runSlideSync(
      { directory: '/abs/d', nodeModulesOnly: false, theme: 'file:/abs/theme' },
      buildDependencies(fs.adapter),
    )).rejects.toBeInstanceOf(SlideSyncUsageError)
  })

  it('リンクの張り直し中に使い方エラーが発生した場合は、別のエラーに包まずそのまま返す', async () => {
    await explains('`runSlideSync` のエラーの扱いのテストです。`linkNodeModules` が `SlideSyncUsageError` を投げた場合に、`symlink-failed` に包まれず、同じ種類のエラーが発生することを確認します。')
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
  it('エラーに渡した理由が、reason に設定され、name にはクラス名が入る', async () => {
    await explains('`SlideSyncUsageError` と `SlideSyncRuntimeError` のテストです。コンストラクタに渡した理由が `reason` にそのまま設定され、`name` がそれぞれのクラス名になることを確認します。')
    const usage = new SlideSyncUsageError('m', 'missing-option')
    expect(usage.reason).toBe('missing-option')
    expect(usage.name).toBe('SlideSyncUsageError')
    const runtime = new SlideSyncRuntimeError('m', 'unknown')
    expect(runtime.reason).toBe('unknown')
    expect(runtime.name).toBe('SlideSyncRuntimeError')
  })
})
