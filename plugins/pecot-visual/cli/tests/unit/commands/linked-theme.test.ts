// ensureTalkThemeLinked の検証。
// 取得・印の比較・張り直しは port を差し替える（I/O 境界）。talk-dir の読み取りはメモリ上の ThemeFiles。

import { describe, expect, it, vi } from 'vitest'

import { ensureTalkThemeLinked } from '../../../src/commands/slidev-project/linked-theme.js'
import type { LinkedThemeDependencies } from '../../../src/commands/slidev-project/linked-theme.js'
import type { ThemeFiles } from '../../../src/domain/slidev-theme/ports.js'
import { SlideCreateRuntimeError } from '../../../src/domain/slidev-project/errors.js'
import { ThemeFetchError } from '../../../src/domain/slidev-theme/store-layout.js'
import { ThemeSpecError } from '../../../src/domain/slidev-theme/theme-spec.js'
import { rejectionOf } from '../../_helpers/rejection.js'

const TALK = '/work/talk'
const THEME_NAME = 'slidev-theme-sample'
const THEME_DIRECTORY = '/store/abc/v1.0.0/package'
const SPEC = 'git+https://example.com/org/theme.git#v1.0.0'

function memoryFiles(texts: Readonly<Record<string, string>>): ThemeFiles {
  const stored = new Map(Object.entries(texts))
  return {
    readText: path => Promise.resolve(stored.get(path)),
    listFiles: () => Promise.resolve([]),
  }
}

function themedTalk(spec = SPEC): ThemeFiles {
  return memoryFiles({
    [`${TALK}/slides.md`]: `---\ntheme: ${THEME_NAME}\ntitle: t\n---\n`,
    [`${TALK}/package.json`]: JSON.stringify({ name: 'talk', dependencies: { [THEME_NAME]: spec } }),
  })
}

interface Probes {
  readonly dependencies: LinkedThemeDependencies
  readonly fetchTheme: ReturnType<typeof vi.fn>
  readonly isLinkCurrent: ReturnType<typeof vi.fn>
  readonly linkNodeModules: ReturnType<typeof vi.fn>
  readonly syncGeneratedFiles: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

function probes(overrides: Partial<{ current: boolean, storeRoot: string | undefined, files: ThemeFiles, fetchedName: string, written: readonly string[] }> = {}): Probes {
  const fetchTheme = vi.fn(() => Promise.resolve({
    name: overrides.fetchedName ?? THEME_NAME,
    directory: THEME_DIRECTORY,
    reused: true,
  }))
  const isLinkCurrent = vi.fn(() => Promise.resolve(overrides.current ?? false))
  const linkNodeModules = vi.fn(() => Promise.resolve({ nodeModulesTarget: '/runtime/current/node_modules', entries: 3 }))
  const syncGeneratedFiles = vi.fn(() => Promise.resolve(overrides.written ?? []))
  const warn = vi.fn()
  const dependencies: LinkedThemeDependencies = {
    files: overrides.files ?? themedTalk(),
    dependencyRoot: '/runtime/current',
    storeRoot: () => ('storeRoot' in overrides ? overrides.storeRoot : '/store'),
    fetchTheme,
    isLinkCurrent,
    linkNodeModules,
    syncGeneratedFiles,
    warn,
  }
  return { dependencies, fetchTheme, isLinkCurrent, linkNodeModules, syncGeneratedFiles, warn }
}

describe('ensureTalkThemeLinked', () => {
  it('印が違えば張り直し、取得した名前と directory をテーマとして渡す', async () => {
    const { dependencies, fetchTheme, isLinkCurrent, linkNodeModules } = probes({ current: false })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({
      relinked: true,
      regenerated: false,
      theme: { name: THEME_NAME, spec: SPEC, directory: THEME_DIRECTORY },
      nodeModulesTarget: '/runtime/current/node_modules',
    })
    expect(fetchTheme).toHaveBeenCalledWith(
      { kind: 'git', url: 'https://example.com/org/theme.git', tag: 'v1.0.0' },
      expect.objectContaining({ storeRoot: '/store', baseDirectory: TALK, dependencyRoot: '/runtime/current' }),
    )
    const links = [{ name: THEME_NAME, directory: THEME_DIRECTORY }]
    expect(isLinkCurrent).toHaveBeenCalledWith(TALK, '/runtime/current', links)
    expect(linkNodeModules).toHaveBeenCalledWith(TALK, '/runtime/current', links)
  })

  it('印が今の値と同じなら張り直さない', async () => {
    const { dependencies, linkNodeModules } = probes({ current: true })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({
      relinked: false,
      regenerated: false,
      theme: { name: THEME_NAME, spec: SPEC, directory: THEME_DIRECTORY },
      nodeModulesTarget: undefined,
    })
    expect(linkNodeModules).not.toHaveBeenCalled()
  })

  it('印が今の値と同じでも、生成ファイルを書き直したら regenerated を真にし、警告で知らせる', async () => {
    const { dependencies, linkNodeModules, syncGeneratedFiles, warn } = probes({ current: true, written: ['vite.config.ts', 'start.mjs'] })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({
      relinked: false,
      regenerated: true,
      theme: { name: THEME_NAME, spec: SPEC, directory: THEME_DIRECTORY },
      nodeModulesTarget: undefined,
    })
    expect(syncGeneratedFiles).toHaveBeenCalledWith(TALK, { themeName: THEME_NAME })
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vite.config.ts・start.mjs'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('setup/vite-plugins.ts'))
  })

  it('生成ファイルが今の内容と同じなら、regenerated は偽で警告も出さない', async () => {
    const { dependencies, warn } = probes({ current: true, written: [] })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result.regenerated).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('張り直しと書き直しが重なれば、どちらも真にする', async () => {
    const { dependencies } = probes({ current: false, written: ['start.mjs'] })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toMatchObject({ relinked: true, regenerated: true })
  })

  it('file: の spec は talk-dir を基準に取得へ渡す', async () => {
    const { dependencies, fetchTheme } = probes({ files: themedTalk('file:../theme') })

    await ensureTalkThemeLinked(TALK, dependencies)

    expect(fetchTheme).toHaveBeenCalledWith({ kind: 'file', path: '../theme' }, expect.objectContaining({ baseDirectory: TALK }))
  })

  it('theme: none の talk-dir（移行前の形）は何も取得せず、張り直さない', async () => {
    const files = memoryFiles({
      [`${TALK}/slides.md`]: '---\ntheme: none\ntitle: t\n---\n',
      [`${TALK}/package.json`]: JSON.stringify({ name: 'talk', dependencies: {} }),
    })
    const { dependencies, fetchTheme, linkNodeModules, syncGeneratedFiles } = probes({ files })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(syncGeneratedFiles).not.toHaveBeenCalled()
  })

  it('requireTheme: theme: none の talk-dir は theme-none で止まる', async () => {
    const files = memoryFiles({
      [`${TALK}/slides.md`]: '---\ntheme: none\ntitle: t\n---\n',
      [`${TALK}/package.json`]: JSON.stringify({ name: 'talk', dependencies: {} }),
    })
    const { dependencies } = probes({ files })

    await expect(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true })).rejects.toMatchObject({
      reason: 'theme-none',
    })
  })

  it('requireTheme: pecot-theme.json を持つ dir はテーマとして読まず、テーマの dir だと伝えて theme-none で止まる', async () => {
    const files = memoryFiles({
      [`${TALK}/slides.md`]: '---\ntheme: none\ntitle: t\n---\n',
      [`${TALK}/package.json`]: JSON.stringify({ name: 'theme-package' }),
      [`${TALK}/pecot-theme.json`]: '{}',
    })
    const { dependencies, fetchTheme, linkNodeModules, syncGeneratedFiles } = probes({ files })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true }))

    expect(failure).toMatchObject({ reason: 'theme-none' })
    expect(String(failure), 'テーマの dir だと伝えていない').toContain('テーマの dir')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(syncGeneratedFiles).not.toHaveBeenCalled()
  })

  it('置き場を決められなければ、取得の失敗として止まる', async () => {
    const { dependencies, fetchTheme } = probes({ storeRoot: undefined })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies))

    expect(failure).toBeInstanceOf(ThemeFetchError)
    expect(failure).toMatchObject({ reason: 'unknown' })
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('dependencies のキーと取得したテーマの name が違えば、張らずに止まる', async () => {
    const { dependencies, linkNodeModules } = probes({ fetchedName: 'slidev-theme-other' })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies))

    expect(failure).toBeInstanceOf(SlideCreateRuntimeError)
    expect(failure).toMatchObject({ reason: 'theme-name-mismatch' })
    expect(failure instanceof Error ? failure.message : '').toContain('slidev-theme-other')
    expect(linkNodeModules).not.toHaveBeenCalled()
  })

  it('registry の版など git でも file: でもない指定は、取得せず、張り直さない (依存の管理は利用者に任せる)', async () => {
    const { dependencies, fetchTheme, isLinkCurrent, linkNodeModules, syncGeneratedFiles } = probes({ files: themedTalk('^1.0.0') })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(isLinkCurrent).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(syncGeneratedFiles).not.toHaveBeenCalled()
  })

  it('取得しない指定でも、talk-dir の node_modules にテーマがあればその root を返す', async () => {
    const files = memoryFiles({
      [`${TALK}/slides.md`]: `---\ntheme: ${THEME_NAME}\n---\n`,
      [`${TALK}/package.json`]: JSON.stringify({ name: 'talk', dependencies: { [THEME_NAME]: '^0.25.0' } }),
      [`${TALK}/node_modules/${THEME_NAME}/package.json`]: '{}',
    })
    const { dependencies, fetchTheme } = probes({ files })

    const result = await ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true })

    expect(result.theme).toStrictEqual({ name: THEME_NAME, spec: '^0.25.0', directory: `${TALK}/node_modules/${THEME_NAME}` })
    expect(result.relinked).toBe(false)
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得しない指定のテーマが node_modules に無ければ、requireTheme のとき theme-unlinked で止まる', async () => {
    const { dependencies, fetchTheme } = probes({ files: themedTalk('^1.0.0') })

    await expect(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true })).rejects.toMatchObject({
      reason: 'theme-unlinked',
    })
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得しない指定のテーマの解決で想定外の読み取りエラーが出たら、握りつぶさずに投げる', async () => {
    const base = themedTalk('^0.25.0')
    const files: ThemeFiles = {
      listFiles: directory => base.listFiles(directory),
      readText: path => (path.includes('/node_modules/')
        ? Promise.reject(new Error('EACCES: permission denied'))
        : base.readText(path)),
    }
    const { dependencies } = probes({ files })

    await expect(ensureTalkThemeLinked(TALK, dependencies)).rejects.toThrow('EACCES')
  })

  it('タグの無い git の指定は、取得の指定の誤りとして ThemeSpecError で止まる', async () => {
    const { dependencies, fetchTheme } = probes({ files: themedTalk('git+https://example.com/org/theme.git') })

    await expect(ensureTalkThemeLinked(TALK, dependencies)).rejects.toBeInstanceOf(ThemeSpecError)
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得の失敗はそのまま投げ、張り直さない', async () => {
    const { dependencies, fetchTheme, linkNodeModules } = probes()
    fetchTheme.mockRejectedValueOnce(new ThemeFetchError('接続できません', 'connection'))

    await expect(ensureTalkThemeLinked(TALK, dependencies)).rejects.toMatchObject({ reason: 'connection' })
    expect(linkNodeModules).not.toHaveBeenCalled()
  })
})
