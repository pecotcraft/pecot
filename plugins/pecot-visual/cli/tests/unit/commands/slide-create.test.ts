// slide create のテーマの取得・宣言の失敗が、原因ごとの reason と文言で返ることを固定する（FR-013）。
// 取得は fetchTheme の port を差し替える（I/O 境界）。宣言の読み取りは一時ディレクトリの実ファイルを読む。
// 失敗した create が、生成先に何も残さず、既存の生成先（--force）を壊さないことも見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  errorToReason,
  executeSlideCreate,
} from '../../../src/commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../../src/commands/slidev-project/create.js'
import { ThemeFetchError, gitFailureAdvice } from '../../../src/domain/slidev-theme/store-layout.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { asStream, makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'
import { explains } from '../../_helpers/explains.js'

const temporaryRoot = useTemporaryDirectory('pecotv-slide-create-unit-')

const SPEC = 'git+https://example.com/org/theme.git#v1.0.0'
const GIT_SPEC = { url: 'https://example.com/org/theme.git', tag: 'v1.0.0' }

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

type FetchTheme = NonNullable<SlideCreateDependencies['fetchTheme']>

function dependenciesWith(
  fetchTheme: FetchTheme,
  stdout: CapturedStream = makeStream(),
  stderr: CapturedStream = makeStream(),
): SlideCreateDependencies {
  // 依存ルートの実体は、取得の前に確かめられる。
  const pluginRoot = temporaryRoot('plugin-root')
  seedDependencyRoot(pluginRoot)
  return {
    pluginRoot,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    fetchTheme,
    themeStoreRoot: () => temporaryRoot('store'),
  }
}

function rejecting(error: Readonly<Error>): FetchTheme {
  return vi.fn<FetchTheme>().mockRejectedValue(error)
}

/**
取得に成功したテーマの代わりに、宣言（pecot-theme.json）を指定の文字列で置いたディレクトリを返す port。
*/
function themeWithDeclaration(declaration: string): FetchTheme {
  const directory = temporaryRoot('fetched-theme')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'slidev-theme-unit' }))
  writeFileSync(path.join(directory, 'pecot-theme.json'), declaration)
  return vi.fn<FetchTheme>().mockResolvedValue({ name: 'slidev-theme-unit', directory, reused: false })
}

interface ErrorPayload {
  readonly reason: string
  readonly detail: string
}

/**
create を実行し、失敗の reason と文言を返す。成功したらテストを落とす。
*/
async function runFailing(
  projectDirectory: string,
  // port に関数を持つため readonly にできない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: Readonly<SlideCreateDependencies>,
  options: Readonly<{ theme?: string, force?: boolean }> = {},
): Promise<{ payload: ErrorPayload }> {
  const error = await rejectionOf(executeSlideCreate(
    projectDirectory,
    { theme: options.theme ?? SPEC, force: options.force ?? false },
    { ...dependencies },
  ))
  expect(error).toBeInstanceOf(Error)
  return { payload: { reason: errorToReason(error), detail: error instanceof Error ? error.message : '' } }
}

// git の失敗の種類、reason、対処の文言の一部。
const GIT_FAILURE_CASES: readonly (readonly ['connection' | 'auth' | 'tag' | 'unknown', string, string])[] = [
  ['connection', 'theme-connection', 'cannot connect to the theme source'],
  ['auth', 'theme-auth', 'set up git credentials, a credential helper or an SSH key'],
  ['tag', 'theme-tag', 'check the tag name'],
  ['unknown', 'theme-unknown', 'git could not fetch the theme source'],
]

describe('slide create の失敗 (FR-013)', () => {
  it.each(GIT_FAILURE_CASES)('取得が %s で失敗した場合は、reason %s と対処の文言を返し、生成先を作成しない', async (kind, reason, advice) => {
    await explains('テーマの取得の失敗のテストです。`connection`・`auth`・`tag`・`unknown` の各失敗の場合に、対応する `reason` と対処の文言が出力され、終了コードが 1 で、生成先が作成されないことを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const failure = new ThemeFetchError(`${gitFailureAdvice(kind, GIT_SPEC)}\nfatal: stderr`, kind)

    const { payload } = await runFailing(projectDirectory, dependenciesWith(rejecting(failure)))

    expect(payload.reason).toBe(reason)
    expect(payload.detail).toContain(advice)
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('pnpm install などの失敗は、theme-install として、取得側の文言をそのまま返す', async () => {
    await explains('依存のインストールの失敗のテストです。`install` の `ThemeFetchError` が発生した場合に、`reason` が `theme-install` で、`detail` に元の文言が含まれ、生成先が作成されないことを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const failure = new ThemeFetchError('pnpm install が失敗しました\nERR_PNPM_FETCH', 'install')

    const { payload } = await runFailing(projectDirectory, dependenciesWith(rejecting(failure)))

    expect(payload.reason).toBe('theme-install')
    expect(payload.detail).toContain('pnpm install が失敗しました')
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('宣言の形が誤っている場合は、theme-invalid-shape として、誤った項目名を示す', async () => {
    await explains('`pecot-theme.json` の形式の誤りのテストです。`pptx.linkColor` が不正な宣言の場合に、`reason` が `theme-invalid-shape` で、`detail` にファイル名と項目名が含まれることを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const declaration = JSON.stringify({ schema: 1, pptx: { linkColor: 'blue' } })

    const { payload } = await runFailing(projectDirectory, dependenciesWith(themeWithDeclaration(declaration)))

    expect(payload.reason).toBe('theme-invalid-shape')
    expect(payload.detail).toContain('pecot-theme.json')
    expect(payload.detail).toContain('pptx.linkColor')
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('宣言に未知の規則名がある場合は、theme-unknown-rule として、規則名を示す', async () => {
    await explains('`pecot-theme.json` の規則名の誤りのテストです。存在しない規則名を `lint.rules` へ書いた場合に、`reason` が `theme-unknown-rule` で、`detail` に規則名が含まれることを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const declaration = JSON.stringify({ schema: 1, lint: { rules: { 'no-such-plugin/no-such-rule': 'error' } } })

    const { payload } = await runFailing(projectDirectory, dependenciesWith(themeWithDeclaration(declaration)))

    expect(payload.reason).toBe('theme-unknown-rule')
    expect(payload.detail).toContain('lint.rules')
    expect(payload.detail).toContain('no-such-plugin/no-such-rule')
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('タグの無い git URL は取得に入らず、theme-tag-required を返す', async () => {
    await explains('`slide_create` のテーマの指定の検証のテストです。タグのない `git+` の URL を指定した場合に、テーマの取得を呼び出さず、理由が `theme-tag-required` になることを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new Error('呼ばれない'))

    const { payload } = await runFailing(
      projectDirectory,
      dependenciesWith(fetchTheme),
      { theme: 'git+https://example.com/org/theme.git' },
    )

    expect(payload.reason).toBe('theme-tag-required')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得に失敗した場合も、--force で指定した既存の生成先を削除しない', async () => {
    await explains('既存の生成先の保護のテストです。`--force` を指定して取得が失敗した場合に、`reason` が `theme-tag` で、既存の `slides.md` の内容が変わらないことを確認します。')
    const projectDirectory = temporaryRoot('talk')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# 既存\n')
    const failure = new ThemeFetchError(gitFailureAdvice('tag', GIT_SPEC), 'tag')

    const { payload } = await runFailing(projectDirectory, dependenciesWith(rejecting(failure)), { force: true })

    expect(payload.reason).toBe('theme-tag')
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')).toBe('# 既存\n')
  })

  it('依存ルートの実体が存在しない場合は、取得も生成先の変更もせず、symlink-failed で止まる', async () => {
    await explains('依存ルートの事前の確認のテストです。`node_modules` が存在しない状態で `--force` を指定した場合に、止まり、`fetchTheme` が呼び出されず、`slides.md` が残ることを確認します。')
    const projectDirectory = temporaryRoot('talk')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# 既存\n')
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new Error('呼ばれない'))
    const dependencies: SlideCreateDependencies = {
      ...dependenciesWith(fetchTheme),
      pluginRoot: temporaryRoot('no-node-modules'),
    }
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    const { payload } = await runFailing(projectDirectory, dependencies, { force: true })

    expect(payload.reason).toBe('symlink-failed')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')).toBe('# 既存\n')
  })

  it('取得に失敗した場合は、失敗の前に出た取得中の警告を標準エラーに出力する', async () => {
    await explains('取得中の警告の出力のテストです。`fetchTheme` が警告を出してから失敗した場合に、標準エラーが `warning:` で始まるその警告の 1 行になることを確認します。')
    const stderr = makeStream()
    const fetchTheme = vi.fn<FetchTheme>().mockImplementation((_spec, options) => {
      options.warn?.('取得中の警告')
      return Promise.reject(new ThemeFetchError('cannot connect to the theme source', 'connection'))
    })
    const dependencies = dependenciesWith(fetchTheme, makeStream(), stderr)

    await expect(executeSlideCreate(
      temporaryRoot('talk'),
      { theme: SPEC, force: false },
      dependencies,
    )).rejects.toBeInstanceOf(ThemeFetchError)

    expect(stderr.chunks.join('')).toBe('warning: 取得中の警告\n')
  })

  it('テーマの保管場所を決定できない場合は、取得を始めず、theme-unknown で止まる', async () => {
    await explains('テーマの保管場所の決定のテストです。`themeStoreRoot` が `undefined` を返す場合に、`theme-unknown` の `reason` が出力され、`CLAUDE_PLUGIN_DATA` が含まれることを確認します。')
    const projectDirectory = temporaryRoot('talk')
    const dependencies: SlideCreateDependencies = {
      ...dependenciesWith(rejecting(new Error('呼ばれない'))),
      themeStoreRoot: vi.fn<() => string | undefined>(),
    }

    const { payload } = await runFailing(projectDirectory, dependencies)

    expect(payload.reason).toBe('theme-unknown')
    expect(payload.detail).toContain('the data directory CLAUDE_PLUGIN_DATA')
  })

  it('executeSlideCreate は、取得に失敗した場合は、その例外をそのまま送出し、警告がなければ標準エラーが空になる', async () => {
    await explains('`executeSlideCreate` の例外の扱いのテストです。`ThemeFetchError` で失敗した場合に、同じ例外が発生し、標準エラーが空であることを確認します。')
    const stderr = makeStream()
    const failure = new ThemeFetchError(gitFailureAdvice('connection', GIT_SPEC), 'connection')

    const dependencies = dependenciesWith(rejecting(failure), makeStream(), stderr)
    await expect(executeSlideCreate(
      temporaryRoot('talk'),
      { theme: SPEC, force: false },
      dependencies,
    )).rejects.toBe(failure)
    expect(stderr.chunks).toEqual([])
  })
})
