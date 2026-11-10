// slide create のテーマの取得・宣言の失敗が、原因ごとの reason と文言で返ることを固定する（FR-013）。
// 取得は fetchTheme の port を差し替える（I/O 境界）。宣言の読み取りは一時ディレクトリの実ファイルを読む。
// 失敗した create が、生成先に何も残さず、既存の生成先（--force）を壊さないことも見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSlideCreateCommand,
  executeSlideCreate,
} from '../../../src/commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../../src/commands/slidev-project/create.js'
import { ThemeFetchError, gitFailureAdvice } from '../../../src/domain/slidev-theme/store-layout.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { asStream, makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'

const temporaryRoot = useTemporaryDirectory('pecotv-slide-create-unit-')

const SPEC = 'git+https://example.com/org/theme.git#v1.0.0'
const GIT_SPEC = { url: 'https://example.com/org/theme.git', tag: 'v1.0.0' }

afterEach(() => {
  process.exitCode = undefined
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
  readonly event: string
  readonly reason: string
  readonly detail: string
}

/**
`--json` で create を実行し、stdout 最終行の error payload と exit code を返す。
*/
async function runJson(
  projectDirectory: string,
  // port に関数を持つため readonly にできない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: Readonly<SlideCreateDependencies>,
  extra: readonly string[] = [],
): Promise<{ payload: ErrorPayload, exitCode: typeof process.exitCode }> {
  const stdout = makeStream()
  const command = createSlideCreateCommand(() => ({ ...dependencies, stdout: asStream(stdout) }))
  await command.parseAsync([projectDirectory, '--theme', SPEC, ...extra, '--json'], { from: 'user' })
  return { payload: lastPayload(stdout), exitCode: process.exitCode }
}

/**
stdout 最終行の JSON を error payload として返す。
*/
// write を持つ stub
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function lastPayload(stdout: Readonly<CapturedStream>): ErrorPayload {
  const lastLine = stdout.chunks.join('').trim().split('\n').findLast(line => line.length > 0) ?? ''
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  return JSON.parse(lastLine) as ErrorPayload
}

// git の失敗の種類、reason、対処の文言の一部。
const GIT_FAILURE_CASES: readonly (readonly ['connection' | 'auth' | 'tag' | 'unknown', string, string])[] = [
  ['connection', 'theme-connection', 'cannot connect to the theme source'],
  ['auth', 'theme-auth', 'set up git credentials, a credential helper or an SSH key'],
  ['tag', 'theme-tag', 'check the tag name'],
  ['unknown', 'theme-unknown', 'git could not fetch the theme source'],
]

describe('slide create の失敗 (FR-013)', () => {
  it.each(GIT_FAILURE_CASES)('取得が %s で失敗すると reason %s と対処の文言を返す', async (kind, reason, advice) => {
    const projectDirectory = temporaryRoot('talk')
    const failure = new ThemeFetchError(`${gitFailureAdvice(kind, GIT_SPEC)}\nfatal: stderr`, kind)

    const { payload, exitCode } = await runJson(projectDirectory, dependenciesWith(rejecting(failure)))

    expect(payload.event).toBe('slide.create.error')
    expect(payload.reason).toBe(reason)
    expect(payload.detail).toContain(advice)
    expect(exitCode).toBe(1)
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('pnpm install などの失敗は theme-install で、取得側の文言をそのまま返す', async () => {
    const projectDirectory = temporaryRoot('talk')
    const failure = new ThemeFetchError('pnpm install が失敗しました\nERR_PNPM_FETCH', 'install')

    const { payload, exitCode } = await runJson(projectDirectory, dependenciesWith(rejecting(failure)))

    expect(payload.reason).toBe('theme-install')
    expect(payload.detail).toContain('pnpm install が失敗しました')
    expect(exitCode).toBe(1)
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('宣言の形の誤りは theme-invalid-shape で、誤った項目名を示す', async () => {
    const projectDirectory = temporaryRoot('talk')
    const declaration = JSON.stringify({ schema: 1, pptx: { linkColor: 'blue' } })

    const { payload, exitCode } = await runJson(projectDirectory, dependenciesWith(themeWithDeclaration(declaration)))

    expect(payload.reason).toBe('theme-invalid-shape')
    expect(payload.detail).toContain('pecot-theme.json')
    expect(payload.detail).toContain('pptx.linkColor')
    expect(exitCode).toBe(1)
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('宣言の知らない規則名は theme-unknown-rule で、規則名を示す', async () => {
    const projectDirectory = temporaryRoot('talk')
    const declaration = JSON.stringify({ schema: 1, lint: { rules: { 'no-such-plugin/no-such-rule': 'error' } } })

    const { payload, exitCode } = await runJson(projectDirectory, dependenciesWith(themeWithDeclaration(declaration)))

    expect(payload.reason).toBe('theme-unknown-rule')
    expect(payload.detail).toContain('lint.rules')
    expect(payload.detail).toContain('no-such-plugin/no-such-rule')
    expect(exitCode).toBe(1)
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('タグの無い git URL は取得に入らず、usage error (exit 2) で theme-tag-required を返す', async () => {
    const projectDirectory = temporaryRoot('talk')
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new Error('呼ばれない'))
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => ({
      ...dependenciesWith(fetchTheme),
      stdout: asStream(stdout),
    }))

    await command.parseAsync([projectDirectory, '--theme', 'git+https://example.com/org/theme.git', '--json'], { from: 'user' })

    const payload = lastPayload(stdout)
    expect(payload.reason).toBe('theme-tag-required')
    expect(process.exitCode).toBe(2)
    expect(fetchTheme).not.toHaveBeenCalled()
  })

  it('取得に失敗しても、--force で指した既存の生成先は消さない', async () => {
    const projectDirectory = temporaryRoot('talk')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# 既存\n')
    const failure = new ThemeFetchError(gitFailureAdvice('tag', GIT_SPEC), 'tag')

    const { payload } = await runJson(projectDirectory, dependenciesWith(rejecting(failure)), ['--force'])

    expect(payload.reason).toBe('theme-tag')
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')).toBe('# 既存\n')
  })

  it('依存ルートの実体が無ければ、取得と生成先のどちらにも触れず止まる (--force の既存を消さない)', async () => {
    const projectDirectory = temporaryRoot('talk')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# 既存\n')
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new Error('呼ばれない'))
    const dependencies: SlideCreateDependencies = {
      ...dependenciesWith(fetchTheme),
      pluginRoot: temporaryRoot('no-node-modules'),
    }
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    const { payload } = await runJson(projectDirectory, dependencies, ['--force'])

    expect(payload.reason).toBe('symlink-failed')
    expect(fetchTheme).not.toHaveBeenCalled()
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')).toBe('# 既存\n')
  })

  it('失敗したとき、失敗の前に出た取得中の警告を stderr に流す', async () => {
    const stderr = makeStream()
    const fetchTheme = vi.fn<FetchTheme>().mockImplementation((_spec, options) => {
      options.warn?.('取得中の警告')
      return Promise.reject(new ThemeFetchError('cannot connect to the theme source', 'connection'))
    })
    const dependencies = dependenciesWith(fetchTheme, makeStream(), stderr)

    await expect(executeSlideCreate(
      temporaryRoot('talk'),
      { theme: SPEC, force: false, emitCatalog: false },
      dependencies,
    )).rejects.toBeInstanceOf(ThemeFetchError)

    expect(stderr.chunks.join('')).toBe('warning: 取得中の警告\n')
  })

  it('テーマの置き場を決められなければ、取得に入らず theme-unknown で止まる', async () => {
    const projectDirectory = temporaryRoot('talk')
    const dependencies: SlideCreateDependencies = {
      ...dependenciesWith(rejecting(new Error('呼ばれない'))),
      themeStoreRoot: vi.fn<() => string | undefined>(),
    }

    const { payload, exitCode } = await runJson(projectDirectory, dependencies)

    expect(payload.reason).toBe('theme-unknown')
    expect(payload.detail).toContain('the data directory CLAUDE_PLUGIN_DATA')
    expect(exitCode).toBe(1)
  })

  it('executeSlideCreate は取得の失敗を例外のまま返す (警告が無ければ stderr は空)', async () => {
    const stderr = makeStream()
    const failure = new ThemeFetchError(gitFailureAdvice('connection', GIT_SPEC), 'connection')

    const dependencies = dependenciesWith(rejecting(failure), makeStream(), stderr)
    await expect(executeSlideCreate(
      temporaryRoot('talk'),
      { theme: SPEC, force: false, emitCatalog: false },
      dependencies,
    )).rejects.toBe(failure)
    expect(stderr.chunks).toEqual([])
  })
})
