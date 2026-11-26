import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachOutput } from '../../../interface-spec/src/vitest/attach.js'
import { setEnvironment, useIsolatedEnvironment } from './environment.js'
import { installFakeExecutable, installFakeGh, installFakeNx, prependToPath, readFakeCalls } from './fake-executables.js'
import { makeTemporaryDirectory } from './temporary.js'
import { explains } from './explains.js'

// 外の環境に隔離対象の値がある状態を作ってから、隔離の補助を通す。
// 補助の beforeEach より先に登録した beforeEach が、先に動く。
// afterEach は逆順で動く。stub の解除を補助の復元より後にするため、補助より先に登録する。
// nx の入力を確かめる pytest が代入と数えるのは、変数名を文字列で書いた stubEnv の呼び出しだけ。
const OUTSIDE_NAMES = [
  'CLAUDE_PROJECT_DIR',
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
  attachOutput([command, ...arguments_].join(' '), result.status ?? result.signal ?? undefined, result.stdout, result.stderr)
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('偽の実行ファイル', () => {
  it('gh auth token は token を出力し、それ以外のコマンドは終了コード 1 になる', async () => {
    await explains('偽の `gh` を `installFakeGh` で用意するテストです。`gh auth token` は `token` を出力して終了コード 0 になり、`gh api x` は終了コード 1 になることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeGh(bin, { token: 'ghp_x' })
    prependToPath(bin)
    expect(run('gh', ['auth', 'token'])).toEqual({ stdout: 'ghp_x\n', stderr: '', status: 0 })
    expect(run('gh', ['api', 'x']).status).toBe(1)
  })

  it('token を指定しない gh は、常に終了コード 1 になる', async () => {
    await explains('`installFakeGh` を `token` なしで呼び出した場合に、`gh auth token` の終了コードが 1 になることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeGh(bin)
    prependToPath(bin)
    expect(run('gh', ['auth', 'token']).status).toBe(1)
  })

  it('nx は、指定した出力と終了コードを返す', async () => {
    await explains('偽の `nx` を `installFakeNx` で用意するテストです。標準出力・標準エラー・終了コードを指定した場合に、`nx show projects` の実行結果が指定した値と一致することを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeNx(bin, { stdout: '{"projects":[]}', stderr: 'warn', exitCode: 3 })
    prependToPath(bin)
    expect(run('nx', ['show', 'projects'])).toEqual({ stdout: '{"projects":[]}', stderr: 'warn', status: 3 })
  })

  it('呼び出しの引数を記録し、空白・引用符・バックスラッシュを含んでも崩れない', async () => {
    await explains('偽の実行ファイルの呼び出しの記録のテストです。空白・引用符・バックスラッシュを含む引数と、引数なしの呼び出しが、そのまま `readFakeCalls` で読み取れることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'tool', 'exit 0\n')
    prependToPath(bin)
    run('tool', ['a b', 'say "hi"', String.raw`back\slash`])
    run('tool', [])
    expect(readFakeCalls(bin, 'tool')).toEqual([['a b', 'say "hi"', String.raw`back\slash`], []])
  })

  it('呼び出されていない場合は、空の記録を返す', async () => {
    await explains('`readFakeCalls` のテストです。偽の実行ファイルが呼び出されていない場合に、空の配列を返すことを確認します。')
    expect(readFakeCalls(makeTemporaryDirectory(), 'gh')).toEqual([])
  })

  it('prependToPath は、PATH の先頭にディレクトリを追加する', async () => {
    await explains('`prependToPath` のテストです。指定したディレクトリが `PATH` の先頭に追加されることを確認します。')
    const bin = makeTemporaryDirectory()
    prependToPath(bin)
    expect(process.env['PATH']?.startsWith(`${bin}${path.delimiter}`)).toBe(true)
  })
})

describe('env の隔離', () => {
  it('隔離の対象の環境変数は、外の環境に値があっても、各テストの前に外れている', async () => {
    await explains('環境変数の隔離のテストです。外の環境に値がある隔離対象の環境変数（`HOME` や `GITHUB_COM_TOKEN` など）が、各テストの開始時に存在しないことを確認します。')
    for (const name of OUTSIDE_NAMES) {
      expect(Object.keys(process.env)).not.toContain(name)
    }
  })

  it('製品が標準で使う PECOT_GITHUB_<ホスト>_TOKEN も、各テストの前に外れている', async () => {
    await explains('環境変数の隔離のテストです。製品が標準で読む `PECOT_GITHUB_<ホスト>_TOKEN` 形式の環境変数が、各テストの開始時に存在しないことを確認します。')
    expect(process.env['PECOT_GITHUB_COM_TOKEN']).toBeUndefined()
    expect(process.env['PECOT_GITHUB_GHES_TOKEN']).toBeUndefined()
    expect(process.env['PECOT_GITHUB_EXAMPLE_ORG_TOKEN']).toBeUndefined()
  })

  it('隔離の後は、git がシステムと利用者の設定を読み込まない値になる', async () => {
    await explains('環境変数の隔離のテストです。`GIT_CONFIG_NOSYSTEM` が `1`、`GIT_CONFIG_GLOBAL` が `/dev/null` に設定されることを確認します。')
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
    expect(process.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null')
  })

  it('setEnvironment で設定した値は次のテストに残らない（1 つ目）', async () => {
    await explains('`setEnvironment` で設定した値の復元を調べる 2 つのテストのうち、1 つ目です。`HOME` と `GITHUB_COM_TOKEN` を設定した場合に、`HOME` に設定した値が読み取れることを確認します。')
    setEnvironment({ HOME: '/leak', GITHUB_COM_TOKEN: 'secret' })
    expect(process.env['HOME']).toBe('/leak')
  })

  it('setEnvironment で設定した値は次のテストに残らない（2 つ目）', async () => {
    await explains('`setEnvironment` で設定した値の復元を調べる 2 つのテストのうち、2 つ目です。前のテストで設定した `HOME` と `GITHUB_COM_TOKEN` が、このテストの開始時に存在しないことを確認します。')
    expect(process.env['HOME']).toBeUndefined()
    expect(process.env['GITHUB_COM_TOKEN']).toBeUndefined()
  })

  it('undefined を指定すると、設定済みの環境変数を外す', async () => {
    await explains('`setEnvironment` のテストです。値に `undefined` を指定した場合に、設定済みの環境変数が外れることを確認します。')
    setEnvironment({ HOME: '/x' })
    setEnvironment({ HOME: undefined })
    expect(process.env['HOME']).toBeUndefined()
  })
})
