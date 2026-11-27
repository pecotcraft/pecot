/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import { InvalidValueError } from '../../../domain/errors.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../tests/_helpers/temporary.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import { OsError } from '../../os-error.js'
import {
  clearHostsConfigCache,
  ensureEnvironmentFile,
  getEnvironmentVariableName,
  getHostConfig,
  loadEnvironmentFile,
  loadHostsConfig,
  pythonString,
  ROOT_ENV_VAR_MAP,
  scopesFor,
  tokenUrlFor,
} from '../auth.js'

useIsolatedEnvironment()

beforeEach(clearHostsConfigCache)
afterEach(clearHostsConfigCache)

const ENTERPRISE_HOST = {
  env_var: 'PECOT_GITHUB_GHES_TOKEN',
  token_url: 'https://ghes.example.com/settings/tokens',
  description: 'GitHub Enterprise Server',
  scopes: ['repo', 'read:org', 'project'],
}

const PUBLIC_HOST = {
  env_var: 'PECOT_GITHUB_COM_TOKEN',
  token_url: 'https://github.com/settings/tokens',
  description: 'GitHub.com',
}

/**
一時のプロジェクトルートを作り、CLAUDE_PROJECT_DIR に向ける。hosts を渡すと設定ディレクトリの hosts.json に書く
*/
function useProject(hosts?: JsonValue): { readonly root: string, readonly config: string } {
  const root = makeTemporaryDirectory()
  const config = path.join(root, '.pecot', 'config')
  mkdirSync(config, { recursive: true })
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  if (hosts !== undefined) writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({ hosts }))
  return { root, config }
}

describe('ホスト設定', () => {
  it('hosts.json が存在する場合は、ホスト設定を読み込む', async () => {
    await explains('ホスト設定を読み込む関数のテストです。`hosts.json` が存在する場合に、その内容をホスト設定として読み込むことを確認します。')
    useProject({ 'github.com': PUBLIC_HOST })
    const config = loadHostsConfig()
    expect(config).toEqual({ hosts: { 'github.com': PUBLIC_HOST } })
  })

  it('hosts.json が存在しない場合は、空の設定を返す', async () => {
    await explains('ホスト設定を読み込む関数のテストです。`hosts.json` が存在しない場合に、空のホスト設定（`{ hosts: {} }`）を返すことを確認します。')
    useProject()
    expect(loadHostsConfig()).toEqual({ hosts: {} })
  })

  it('最上位がオブジェクトでない hosts.json は空の設定として扱う', async () => {
    await explains('ホスト設定を読み込む関数のテストです。最上位がオブジェクトでない `hosts.json`（`[1]`）の場合に、空の設定として扱い、ホストの設定が `undefined` になることを確認します。')
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '[1]')
    expect(loadHostsConfig()).toEqual({})
    expect(getHostConfig('github.com')).toBeUndefined()
  })

  it('hosts.json が不正な JSON の場合は、InvalidValueError が発生する', async () => {
    await explains('ホスト設定を読み込む関数のテストです。`hosts.json` が不正な JSON の場合に、`InvalidValueError` が発生することを確認します。')
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '{')
    expect(() => loadHostsConfig()).toThrow(InvalidValueError)
  })

  it('ホスト設定はキャッシュされ、クリアすると読み直す', async () => {
    await explains('ホスト設定のキャッシュのテストです。`hosts.json` を削除しても同じ設定を返し、キャッシュをクリアすると読み直して空の設定になることを確認します。')
    const { config } = useProject({ 'github.com': { env_var: 'TEST_TOKEN' } })
    const first = loadHostsConfig()
    rmSync(path.join(config, 'hosts.json'))
    expect(loadHostsConfig()).toBe(first)
    clearHostsConfigCache()
    expect(loadHostsConfig()).toEqual({ hosts: {} })
  })

  it('定義済みのホストを指定すると、そのホストの設定を返す', async () => {
    await explains('ホストの設定を取得する関数のテストです。定義済みのホストを指定した場合に、そのホストの設定を返すことを確認します。')
    useProject({ 'ghes.example.com': { env_var: 'PECOT_GITHUB_GHES_TOKEN', token_url: 'https://ghes.example.com/settings/tokens' } })
    expect(getHostConfig('ghes.example.com')).toEqual({ env_var: 'PECOT_GITHUB_GHES_TOKEN', token_url: 'https://ghes.example.com/settings/tokens' })
  })

  it.each([
    ['未定義のホスト', { 'github.com': PUBLIC_HOST }, 'unknown.host.com'],
    ['値が空のオブジェクト', { 'github.com': {} }, 'github.com'],
    ['値がオブジェクトでない', { 'github.com': 'x' }, 'github.com'],
  ])('%s の場合は、undefined を返す', async (_name, hosts, host) => {
    await explains('ホストの設定を取得する関数のテストです。未定義のホストや、値が空のオブジェクト・オブジェクトでない定義の場合に、`undefined` を返すことを確認します。')
    useProject(hosts)
    expect(getHostConfig(host)).toBeUndefined()
  })

  it('hosts が配列の設定は、未定義として扱う', async () => {
    await explains('ホストの設定を取得する関数のテストです。`hosts` が配列（`[]`）の設定の場合に、ホストの設定を未定義として扱うことを確認します。')
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '{"hosts": []}')
    expect(getHostConfig('github.com')).toBeUndefined()
  })

  it('環境変数名は hosts.json の env_var を使う', async () => {
    await explains('環境変数名を求める関数のテストです。`hosts.json` の `env_var` に書いた名前を、ホストごとに返すことを確認します。')
    useProject({
      'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN' },
      'ghes.example.com': { env_var: 'PECOT_GITHUB_GHES_TOKEN' },
    })
    expect(getEnvironmentVariableName('github.com')).toBe('PECOT_GITHUB_COM_TOKEN')
    expect(getEnvironmentVariableName('ghes.example.com')).toBe('PECOT_GITHUB_GHES_TOKEN')
  })

  it('未定義のホストの環境変数名は、ドットをアンダースコアに置き換えたフォールバックの名前にする', async () => {
    await explains('環境変数名を求める関数のテストです。未定義のホストの場合に、ドットをアンダースコアに置き換えたフォールバックの名前（`PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN`）を返すことを確認します。')
    useProject({})
    expect(getEnvironmentVariableName('gitlab.example.com')).toBe('PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN')
  })

  it('hosts.json が存在しなくても、github.com は PECOT_GITHUB_COM_TOKEN を返す', async () => {
    await explains('環境変数名を求める関数のテストです。`hosts.json` が存在しなくても、`github.com` は `PECOT_GITHUB_COM_TOKEN` を返すことを確認します。')
    useProject()
    expect(getEnvironmentVariableName('github.com')).toBe('PECOT_GITHUB_COM_TOKEN')
  })

  it('hosts.json の定義は既定の対応より優先する', async () => {
    await explains('環境変数名を求める関数のテストです。`hosts.json` の定義が、既定の対応より優先されることを確認します。')
    useProject({ 'github.com': { env_var: 'MY_TOKEN' } })
    expect(getEnvironmentVariableName('github.com')).toBe('MY_TOKEN')
  })

  it('env_var を持たない定義は、KeyError と同じ文の InvalidValueError が発生する', async () => {
    await explains('環境変数名を求める関数のテストです。`env_var` を持たない定義の場合に、Python の `KeyError` と同じ文の `InvalidValueError` が発生することを確認します。')
    useProject({ 'github.com': { token_url: 'x' } })
    expect(() => getEnvironmentVariableName('github.com')).toThrow(new InvalidValueError('\'env_var\''))
  })

  it('取得先 URL と scopes を返し、未定義のホストは設定画面の URL と空の scopes を返す', async () => {
    await explains('トークンの取得先 URL とスコープを求める関数のテストです。定義済みのホストはその値を返し、未定義のホストは設定画面の URL と空のスコープを返すことを確認します。')
    useProject({ 'ghes.example.com': ENTERPRISE_HOST })
    expect(tokenUrlFor('ghes.example.com')).toBe('https://ghes.example.com/settings/tokens')
    expect(scopesFor('ghes.example.com')).toEqual(['repo', 'read:org', 'project'])
    expect(tokenUrlFor('gitlab.example.com')).toBe('https://gitlab.example.com/settings/tokens')
    expect(scopesFor('gitlab.example.com')).toEqual([])
  })

  it('scopes が配列でない場合は、空の配列を返す', async () => {
    await explains('トークンのスコープを求める関数のテストです。`scopes` が配列でない場合に、空のスコープを返すことを確認します。')
    useProject({ 'github.com': { ...PUBLIC_HOST, scopes: 'repo' } })
    expect(scopesFor('github.com')).toEqual([])
  })

  it('ルートの .env の変数名は、github.com の GITHUB_COM_TOKEN だけを持つ', async () => {
    await explains('ルートの `.env` の変数名のテストです。`ROOT_ENV_VAR_MAP` が、`github.com` に対する `GITHUB_COM_TOKEN` だけを持つことを確認します。')
    expect([...ROOT_ENV_VAR_MAP]).toEqual([['github.com', 'GITHUB_COM_TOKEN']])
  })
})

describe('pythonString', () => {
  it('文字列はそのまま返し、それ以外は Python の repr と同じ形式にする', async () => {
    await explains('Python の文字列表現に変換する関数のテストです。文字列はそのまま返し、オブジェクトや数値は Python の `repr` と同じ形式の文字列にすることを確認します。')
    expect(pythonString('a\'b')).toBe('a\'b')
    expect(pythonString({ a: [true, JSON_NULL] })).toBe('{\'a\': [True, None]}')
    expect(pythonString(5)).toBe('5')
  })
})

function environmentFile(content: string): string {
  const file = path.join(makeTemporaryDirectory(), '.env')
  writeFileSync(file, content)
  return file
}

describe('loadEnvironmentFile', () => {
  beforeEach(() => {
    vi.stubEnv('TEST_KEY', undefined)
    vi.stubEnv('ANOTHER_KEY', undefined)
    vi.stubEnv('VALID_KEY', undefined)
    vi.stubEnv('SPACED_KEY', undefined)
    vi.stubEnv('NO_EQUALS_LINE', undefined)
    vi.stubEnv('EMPTY_VALUE', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('KEY=VALUE を process.env に設定する', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。`KEY=VALUE` の行が、`process.env` に設定されることを確認します。')
    loadEnvironmentFile(environmentFile('TEST_KEY=test_value\nANOTHER_KEY=another_value\n'))
    expect(process.env['TEST_KEY']).toBe('test_value')
    expect(process.env['ANOTHER_KEY']).toBe('another_value')
  })

  it('コメント行と空行は無視する', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。コメント行と空行を無視し、通常の行だけを設定することを確認します。')
    loadEnvironmentFile(environmentFile('# This is a comment\n\n\nVALID_KEY=valid_value\n   # indented comment\n'))
    expect(process.env['VALID_KEY']).toBe('valid_value')
    expect(process.env['# This is a comment']).toBeUndefined()
  })

  it('既存の環境変数は上書きしない（空文字の値も既存として扱う）', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。すでに設定されている環境変数（空文字の値も含む）を、上書きしないことを確認します。')
    vi.stubEnv('EXISTING_KEY', 'original_value')
    vi.stubEnv('EMPTY_KEY', '')
    loadEnvironmentFile(environmentFile('EXISTING_KEY=new_value\nEMPTY_KEY=new_value\n'))
    expect(process.env['EXISTING_KEY']).toBe('original_value')
    expect(process.env['EMPTY_KEY']).toBe('')
  })

  it('ファイルが存在しない場合は、何もしない', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。ファイルが存在しない場合に、例外が発生せずに何もしないことを確認します。')
    expect(() => {
      loadEnvironmentFile(path.join(makeTemporaryDirectory(), 'nonexistent.env'))
    }).not.toThrow()
  })

  it('キーと値の前後の空白を取り除き、値の中の = と引用符はそのまま残す', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。キーと値の前後の空白を取り除き、値の中の `=` と引用符は保持することを確認します。')
    loadEnvironmentFile(environmentFile('  SPACED_KEY  =  a=b "c"  \r\nNO_EQUALS_LINE\n=novalue\nEMPTY_VALUE=\n'))
    expect(process.env['SPACED_KEY']).toBe('a=b "c"')
    expect(process.env['NO_EQUALS_LINE']).toBeUndefined()
    expect(process.env['EMPTY_VALUE']).toBe('')
    expect(Object.hasOwn(process.env, '')).toBe(false)
  })

  it('読み取れない場合（ディレクトリ）は、Python の OSError と同じ文の OsError が発生する', async () => {
    await explains('環境変数ファイルを読み込む関数のテストです。読み取れない場合（ディレクトリを指定した場合）に、Python の `OSError` と同じ文の `OsError` が発生することを確認します。')
    const directory = makeTemporaryDirectory()
    expect(() => {
      loadEnvironmentFile(directory)
    }).toThrow(new OsError(`[Errno 21] Is a directory: '${directory}'`, 'EISDIR', directory))
  })
})

function createdEnvironmentFile(host: string): string {
  const file = ensureEnvironmentFile(host)
  if (file === undefined) throw new Error('ensureEnvironmentFile did not create .env')
  return file
}

describe('ensureEnvironmentFile', () => {
  const HEADER = '# pecot-cli 認証設定\n# 各トークンの値を設定してください\n#\n# トークン作成時は必要なスコープを付与してください\n'

  // 期待値は Python の ensure_env_file の出力
  it('スコープを持つホストでは、取得先とスコープを書いた .env を設定ディレクトリに新しく作成する', async () => {
    await explains('`.env` を用意する関数のテストです。スコープを持つホストの場合に、取得先とスコープを書いた `.env` を設定ディレクトリに新しく作成することを確認します。')
    const { config } = useProject({ 'ghes.example.com': ENTERPRISE_HOST })
    const file = createdEnvironmentFile('ghes.example.com')
    expect(file).toBe(path.join(config, '.env'))
    expect(readFileSync(file, 'utf8')).toBe(
      `${HEADER}\n# GitHub Enterprise Server\n# 取得先: https://ghes.example.com/settings/tokens\n# 必要なスコープ: repo, read:org, project\nPECOT_GITHUB_GHES_TOKEN=\n`,
    )
  })

  it('スコープを持たないホストの新規作成では、スコープの行が空行になる', async () => {
    await explains('`.env` を用意する関数のテストです。スコープを持たないホストの場合に、スコープの行が空行になり、`必要なスコープ:` を含まない `.env` を作成することを確認します。')
    useProject({ 'github.com': PUBLIC_HOST })
    const content = readFileSync(createdEnvironmentFile('github.com'), 'utf8')
    expect(content).toBe(`${HEADER}\n# GitHub.com\n# 取得先: https://github.com/settings/tokens\n\nPECOT_GITHUB_COM_TOKEN=\n`)
    expect(content).not.toContain('必要なスコープ:')
  })

  it('未定義のホストの新規作成では、フォールバックの環境変数名を使い、description にホスト名を書く', async () => {
    await explains('`.env` を用意する関数のテストです。未定義のホストの場合に、フォールバックの環境変数名を使い、説明にホスト名を書いた `.env` を作成することを確認します。')
    useProject({})
    expect(readFileSync(createdEnvironmentFile('gitlab.example.com'), 'utf8')).toBe(
      `${HEADER}\n# gitlab.example.com\n# 取得先: https://gitlab.example.com/settings/tokens\n\nPECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN=\n`,
    )
  })

  it('既存の .env には追記し、既存の内容を保つ。2 回目は追記しない', async () => {
    await explains('`.env` を用意する関数のテストです。既存の `.env` がある場合に、既存の内容を保ったまま追記し、2 回目の呼び出しでは追記しないことを確認します。')
    const { config } = useProject({ 'github.com': PUBLIC_HOST })
    const file = path.join(config, '.env')
    writeFileSync(file, 'EXISTING_VAR=value\n')
    ensureEnvironmentFile('github.com')
    const expected = 'EXISTING_VAR=value\n\n# GitHub.com\n# 取得先: https://github.com/settings/tokens\n\nPECOT_GITHUB_COM_TOKEN=\n'
    expect(readFileSync(file, 'utf8')).toBe(expected)
    ensureEnvironmentFile('github.com')
    expect(readFileSync(file, 'utf8')).toBe(expected)
  })

  it('環境変数名が既に存在する場合は、追記しない', async () => {
    await explains('`.env` を用意する関数のテストです。環境変数名がすでに `.env` に存在する場合は、追記しないことを確認します。')
    const { config } = useProject({ 'github.com': PUBLIC_HOST })
    const file = path.join(config, '.env')
    writeFileSync(file, 'PECOT_GITHUB_COM_TOKEN=existing_token\n')
    ensureEnvironmentFile('github.com')
    expect(readFileSync(file, 'utf8')).toBe('PECOT_GITHUB_COM_TOKEN=existing_token\n')
  })

  it('設定ディレクトリが存在しない場合は、何も作成せずに undefined を返す', async () => {
    await explains('`.env` を用意する関数のテストです。設定ディレクトリが存在しない場合に、何も作成せずに `undefined` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: root })
    expect(ensureEnvironmentFile('github.com')).toBeUndefined()
    expect(existsSync(path.join(root, '.pecot'))).toBe(false)
  })
})
