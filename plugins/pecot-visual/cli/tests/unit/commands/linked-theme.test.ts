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
import { explains } from '../../_helpers/explains.js'

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
  it('リンクが現在の状態と一致しない場合は、node_modules を張り直し、取得したテーマの名前と directory を返す', async () => {
    await explains('`ensureTalkThemeLinked` のリンクの更新のテストです。`isLinkCurrent` が偽の場合に、テーマを取得して `linkNodeModules` を呼び出し、`relinked` が真になり、取得したテーマの情報が返ることを確認します。')
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

  it('リンクが現在の状態と一致する場合は、node_modules を張り直さない', async () => {
    await explains('`ensureTalkThemeLinked` のリンクが最新の場合のテストです。`isLinkCurrent` が真の場合に、`linkNodeModules` が呼び出されず、`relinked` が偽になることを確認します。')
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

  it('リンクが一致していても生成ファイルを書き直した場合は、regenerated を真にし、警告で知らせる', async () => {
    await explains('生成ファイルの再生成のテストです。`vite.config.ts` と `start.mjs` を書き直した場合に、`regenerated` が真になり、書き直したファイル名を含む警告が 1 回だけ表示されることを確認します。')
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vite.config.ts, start.mjs'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('setup/vite-plugins.ts'))
  })

  it('生成ファイルが現在の内容と同じ場合は、regenerated を偽にし、警告も表示しない', async () => {
    await explains('生成ファイルを書き直さない場合のテストです。`syncGeneratedFiles` が空の一覧を返した場合に、`regenerated` が偽になり、`warn` が呼び出されないことを確認します。')
    const { dependencies, warn } = probes({ current: true, written: [] })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result.regenerated).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('張り直しと生成ファイルの書き直しが重なった場合は、relinked と regenerated をどちらも真にする', async () => {
    await explains('張り直しと再生成が同時に起きた場合のテストです。リンクが一致せず、生成ファイルも書き直した場合に、`relinked` と `regenerated` の両方が真になることを確認します。')
    const { dependencies } = probes({ current: false, written: ['start.mjs'] })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toMatchObject({ relinked: true, regenerated: true })
  })

  it('file: で始まる spec は、talk-dir を基準にして取得処理へ渡す', async () => {
    await explains('`file:` 形式のテーマの指定のテストです。`file:../theme` を指定した場合に、`fetchTheme` が `kind` が `file` の指定と、`talk-dir` の `baseDirectory` を受け取ることを確認します。')
    const { dependencies, fetchTheme } = probes({ files: themedTalk('file:../theme') })

    await ensureTalkThemeLinked(TALK, dependencies)

    expect(fetchTheme).toHaveBeenCalledWith({ kind: 'file', path: '../theme' }, expect.objectContaining({ baseDirectory: TALK }))
  })

  it('theme が none の talk-dir（移行前の形）は、テーマを取得せず、張り直さない', async () => {
    await explains('テーマを使わない `talk-dir` のテストです。`theme: none` の場合に、`undefined` のテーマと `relinked` が偽の結果が返り、取得・リンク・生成ファイルの同期が呼び出されないことを確認します。')
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

  it('requireTheme を指定した場合に theme が none の talk-dir は、theme-none の例外で終わる', async () => {
    await explains('`requireTheme` を指定したときのテストです。`theme: none` の `talk-dir` を渡した場合に、`reason` が `theme-none` の例外が発生することを確認します。')
    const files = memoryFiles({
      [`${TALK}/slides.md`]: '---\ntheme: none\ntitle: t\n---\n',
      [`${TALK}/package.json`]: JSON.stringify({ name: 'talk', dependencies: {} }),
    })
    const { dependencies } = probes({ files })

    await expect(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true })).rejects.toMatchObject({
      reason: 'theme-none',
    })
  })

  it('requireTheme を指定した場合に pecot-theme.json のある dir は、テーマの dir だと伝えて theme-none で終わる', async () => {
    await explains('テーマ自身の `dir` を渡した場合のテストです。`pecot-theme.json` を持つ `dir` を渡した場合に、`it is a theme dir` を含む `theme-none` の例外が発生し、取得とリンクが呼び出されないことを確認します。')
    const files = memoryFiles({
      [`${TALK}/slides.md`]: '---\ntheme: none\ntitle: t\n---\n',
      [`${TALK}/package.json`]: JSON.stringify({ name: 'theme-package' }),
      [`${TALK}/pecot-theme.json`]: '{}',
    })
    const { dependencies, fetchTheme, linkNodeModules, syncGeneratedFiles } = probes({ files })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true }))

    expect(failure).toMatchObject({ reason: 'theme-none' })
    expect(String(failure), 'テーマの dir だと伝えていない').toContain('it is a theme dir')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(syncGeneratedFiles).not.toHaveBeenCalled()
  })

  it('テーマの保管場所を決定できない場合は、取得の失敗として unknown の ThemeFetchError が発生する', async () => {
    await explains('テーマの保管場所の決定のテストです。`storeRoot` が `undefined` を返す場合に、`reason` が `unknown` の `ThemeFetchError` が発生し、`fetchTheme` が呼び出されないことを確認します。')
    const { dependencies, fetchTheme } = probes({ storeRoot: undefined })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies))

    expect(failure).toBeInstanceOf(ThemeFetchError)
    expect(failure).toMatchObject({ reason: 'unknown' })
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('dependencies のキーと取得したテーマの name が一致しない場合は、リンクせずに theme-name-mismatch で終わる', async () => {
    await explains('テーマの名前の整合のテストです。取得したテーマの名前が `dependencies` のキーと異なる場合に、`theme-name-mismatch` の例外が発生し、`linkNodeModules` が呼び出されないことを確認します。')
    const { dependencies, linkNodeModules } = probes({ fetchedName: 'slidev-theme-other' })

    const failure = await rejectionOf(ensureTalkThemeLinked(TALK, dependencies))

    expect(failure).toBeInstanceOf(SlideCreateRuntimeError)
    expect(failure).toMatchObject({ reason: 'theme-name-mismatch' })
    expect(failure instanceof Error ? failure.message : '').toContain('slidev-theme-other')
    expect(linkNodeModules).not.toHaveBeenCalled()
  })

  it('registry の版など git でも file: でもない指定は、テーマを取得せず、張り直さない（依存の管理は利用者に任せる）', async () => {
    await explains('取得の対象外の指定のテストです。`^1.0.0` を指定した場合に、`undefined` のテーマと `relinked` が偽の結果が返り、取得・リンクの確認・張り直しが呼び出されないことを確認します。')
    const { dependencies, fetchTheme, isLinkCurrent, linkNodeModules, syncGeneratedFiles } = probes({ files: themedTalk('^1.0.0') })

    const result = await ensureTalkThemeLinked(TALK, dependencies)

    expect(result).toStrictEqual({ relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined })
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(isLinkCurrent).not.toHaveBeenCalled()
    expect(linkNodeModules).not.toHaveBeenCalled()
    expect(syncGeneratedFiles).not.toHaveBeenCalled()
  })

  it('取得しない指定でも、talk-dir の node_modules にテーマが存在する場合は、その directory を返す', async () => {
    await explains('利用者が管理するテーマの解決のテストです。`^0.25.0` を指定し、`node_modules` にテーマが存在する場合に、そのパスを `directory` とするテーマが返り、`fetchTheme` が呼び出されないことを確認します。')
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

  it('取得しない指定のテーマが node_modules に存在しない場合は、requireTheme で theme-unlinked の例外が発生する', async () => {
    await explains('テーマが存在しない場合のテストです。`^1.0.0` を指定し、`node_modules` にテーマが存在しない状態で `requireTheme` を指定した場合に、`theme-unlinked` の例外が発生することを確認します。')
    const { dependencies, fetchTheme } = probes({ files: themedTalk('^1.0.0') })

    await expect(ensureTalkThemeLinked(TALK, dependencies, { requireTheme: true })).rejects.toMatchObject({
      reason: 'theme-unlinked',
    })
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得しない指定のテーマの解決で想定外の読み取りエラーが発生した場合は、握りつぶさずに送出する', async () => {
    await explains('想定外の読み取りエラーのテストです。`node_modules` 配下の読み取りが `EACCES` で失敗した場合に、`EACCES` を含む例外がそのまま発生することを確認します。')
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

  it('タグが指定されていない git の指定は、取得の指定の誤りとして ThemeSpecError で終わる', async () => {
    await explains('タグのない `git` の指定のテストです。`#` 以降のタグを含まない URL を指定した場合に、`ThemeSpecError` が発生し、`fetchTheme` が呼び出されないことを確認します。')
    const { dependencies, fetchTheme } = probes({ files: themedTalk('git+https://example.com/org/theme.git') })

    await expect(ensureTalkThemeLinked(TALK, dependencies)).rejects.toBeInstanceOf(ThemeSpecError)
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得に失敗した場合は、その例外をそのまま送出し、張り直さない', async () => {
    await explains('取得の失敗のテストです。`fetchTheme` が `ThemeFetchError` で失敗した場合に、同じ `reason` の例外が発生し、`linkNodeModules` が呼び出されないことを確認します。')
    const { dependencies, fetchTheme, linkNodeModules } = probes()
    fetchTheme.mockRejectedValueOnce(new ThemeFetchError('接続できません', 'connection'))

    await expect(ensureTalkThemeLinked(TALK, dependencies)).rejects.toMatchObject({ reason: 'connection' })
    expect(linkNodeModules).not.toHaveBeenCalled()
  })
})
