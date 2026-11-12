import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from './environment.js'
import { installFakeExecutable, installFakeGh, installFakeNx, prependToPath, readFakeCalls } from './fake-executables.js'
import { makeTemporaryDirectory } from './temporary.js'

// 外の環境に隔離対象の値がある状態を作ってから、隔離の補助を通す。
// 補助の beforeEach より先に登録した beforeEach が、先に動く。
// afterEach は逆順で動く。stub の解除を補助の復元より後にするため、補助より先に登録する。
// nx の入力を確かめる pytest が代入と数えるのは、変数名を文字列で書いた stubEnv の呼び出しだけ。
const OUTSIDE_NAMES = [
  'CLAUDE_PROJECT_DIR',
  'PECOT_SESSION_PROJECT_DIR',
  'CLAUDE_PLUGIN_DATA',
  'PLUGIN_DATA',
  'XDG_DATA_HOME',
  'HOME',
  'PECOT_GITHUB_API_URL',
  'GITHUB_GHES_TOKEN',
  'GITHUB_COM_TOKEN',
  'PECOT_GITHUB_COM_TOKEN',
  'PECOT_GITHUB_GHES_TOKEN',
  'PECOT_GITHUB_EXAMPLE_ORG_TOKEN',
]

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv('CLAUDE_PROJECT_DIR', '/outside/project')
  vi.stubEnv('PECOT_SESSION_PROJECT_DIR', '/outside/session')
  vi.stubEnv('CLAUDE_PLUGIN_DATA', '/outside/data')
  vi.stubEnv('PLUGIN_DATA', '/outside/plugin-data')
  vi.stubEnv('XDG_DATA_HOME', '/outside/xdg')
  vi.stubEnv('HOME', '/outside/home')
  vi.stubEnv('PECOT_GITHUB_API_URL', 'http://127.0.0.1:1')
  vi.stubEnv('GITHUB_GHES_TOKEN', 'outside-ghes')
  vi.stubEnv('GITHUB_COM_TOKEN', 'outside-com')
  vi.stubEnv('PECOT_GITHUB_COM_TOKEN', 'outside-pecot-com')
  vi.stubEnv('PECOT_GITHUB_GHES_TOKEN', 'outside-pecot-ghes')
  vi.stubEnv('PECOT_GITHUB_EXAMPLE_ORG_TOKEN', 'outside-pecot-example')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0')
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/outside/gitconfig')
})

useIsolatedEnvironment()

function run(command: string, arguments_: readonly string[]): { readonly stdout: string, readonly stderr: string, readonly status: number | null } {
  const result = spawnSync(command, [...arguments_], { encoding: 'utf8' })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('偽の実行ファイル', () => {
  it('gh auth token は token を出し、それ以外は exit 1', () => {
    const bin = makeTemporaryDirectory()
    installFakeGh(bin, { token: 'ghp_x' })
    prependToPath(bin)
    expect(run('gh', ['auth', 'token'])).toEqual({ stdout: 'ghp_x\n', stderr: '', status: 0 })
    expect(run('gh', ['api', 'x']).status).toBe(1)
  })

  it('token 省略の gh は常に exit 1', () => {
    const bin = makeTemporaryDirectory()
    installFakeGh(bin)
    prependToPath(bin)
    expect(run('gh', ['auth', 'token']).status).toBe(1)
  })

  it('nx は指定した出力と終了コード', () => {
    const bin = makeTemporaryDirectory()
    installFakeNx(bin, { stdout: '{"projects":[]}', stderr: 'warn', exitCode: 3 })
    prependToPath(bin)
    expect(run('nx', ['show', 'projects'])).toEqual({ stdout: '{"projects":[]}', stderr: 'warn', status: 3 })
  })

  it('呼び出しの引数を記録する。空白・引用符・バックスラッシュを含んでも崩れない', () => {
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'tool', 'exit 0\n')
    prependToPath(bin)
    run('tool', ['a b', 'say "hi"', String.raw`back\slash`])
    run('tool', [])
    expect(readFakeCalls(bin, 'tool')).toEqual([['a b', 'say "hi"', String.raw`back\slash`], []])
  })

  it('呼ばれていなければ空', () => {
    expect(readFakeCalls(makeTemporaryDirectory(), 'gh')).toEqual([])
  })

  it('PATH の先頭に足す。元に戻るのは useIsolatedEnvironment の afterEach', () => {
    const bin = makeTemporaryDirectory()
    prependToPath(bin)
    expect(process.env['PATH']?.startsWith(`${bin}${path.delimiter}`)).toBe(true)
  })
})

describe('env の隔離', () => {
  it('外の環境にあった対象の変数は、各テストの前に外れている', () => {
    for (const name of OUTSIDE_NAMES) {
      expect(Object.keys(process.env)).not.toContain(name)
    }
  })

  it('製品が標準で使う PECOT_GITHUB_<ホスト>_TOKEN も外れている', () => {
    expect(process.env['PECOT_GITHUB_COM_TOKEN']).toBeUndefined()
    expect(process.env['PECOT_GITHUB_GHES_TOKEN']).toBeUndefined()
    expect(process.env['PECOT_GITHUB_EXAMPLE_ORG_TOKEN']).toBeUndefined()
  })

  it('隔離の後に、git がシステムと利用者の設定を読まない値が置かれる', () => {
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
    expect(process.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null')
  })

  it('setEnvironment で設定した値は次のテストに残らない（1 つ目）', () => {
    setEnvironment({ HOME: '/leak', GITHUB_COM_TOKEN: 'secret' })
    expect(process.env['HOME']).toBe('/leak')
  })

  it('setEnvironment で設定した値は次のテストに残らない（2 つ目）', () => {
    expect(process.env['HOME']).toBeUndefined()
    expect(process.env['GITHUB_COM_TOKEN']).toBeUndefined()
  })

  it('undefined を渡すと外す', () => {
    setEnvironment({ HOME: '/x' })
    setEnvironment({ HOME: undefined })
    expect(process.env['HOME']).toBeUndefined()
  })
})
