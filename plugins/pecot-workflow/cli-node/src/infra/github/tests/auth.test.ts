/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InvalidValueError } from '../../../domain/errors.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
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
  it('hosts.json からホスト設定を読む', () => {
    useProject({ 'github.com': PUBLIC_HOST })
    const config = loadHostsConfig()
    expect(config).toEqual({ hosts: { 'github.com': PUBLIC_HOST } })
  })

  it('hosts.json が無ければ空の設定', () => {
    useProject()
    expect(loadHostsConfig()).toEqual({ hosts: {} })
  })

  it('最上位がオブジェクトでない hosts.json は空の設定として扱う', () => {
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '[1]')
    expect(loadHostsConfig()).toEqual({})
    expect(getHostConfig('github.com')).toBeUndefined()
  })

  it('不正な JSON は InvalidValueError', () => {
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '{')
    expect(() => loadHostsConfig()).toThrow(InvalidValueError)
  })

  it('ホスト設定はキャッシュされ、クリアすると読み直す', () => {
    const { config } = useProject({ 'github.com': { env_var: 'TEST_TOKEN' } })
    const first = loadHostsConfig()
    rmSync(path.join(config, 'hosts.json'))
    expect(loadHostsConfig()).toBe(first)
    clearHostsConfigCache()
    expect(loadHostsConfig()).toEqual({ hosts: {} })
  })

  it('定義済みホストの設定を取る', () => {
    useProject({ 'ghes.example.com': { env_var: 'PECOT_GITHUB_GHES_TOKEN', token_url: 'https://ghes.example.com/settings/tokens' } })
    expect(getHostConfig('ghes.example.com')).toEqual({ env_var: 'PECOT_GITHUB_GHES_TOKEN', token_url: 'https://ghes.example.com/settings/tokens' })
  })

  it.each([
    ['未定義のホスト', { 'github.com': PUBLIC_HOST }, 'unknown.host.com'],
    ['値が空のオブジェクト', { 'github.com': {} }, 'github.com'],
    ['値がオブジェクトでない', { 'github.com': 'x' }, 'github.com'],
  ])('%s は undefined', (_name, hosts, host) => {
    useProject(hosts)
    expect(getHostConfig(host)).toBeUndefined()
  })

  it('hosts が無い設定は未定義として扱う', () => {
    const { config } = useProject()
    writeFileSync(path.join(config, 'hosts.json'), '{"hosts": []}')
    expect(getHostConfig('github.com')).toBeUndefined()
  })

  it('環境変数名は hosts.json の env_var を使う', () => {
    useProject({
      'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN' },
      'ghes.example.com': { env_var: 'PECOT_GITHUB_GHES_TOKEN' },
    })
    expect(getEnvironmentVariableName('github.com')).toBe('PECOT_GITHUB_COM_TOKEN')
    expect(getEnvironmentVariableName('ghes.example.com')).toBe('PECOT_GITHUB_GHES_TOKEN')
  })

  it('未定義ホストの環境変数名は、ドットをアンダースコアにしたフォールバック', () => {
    useProject({})
    expect(getEnvironmentVariableName('gitlab.example.com')).toBe('PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN')
  })

  it('hosts.json が無くても、github.com は PECOT_GITHUB_COM_TOKEN', () => {
    useProject()
    expect(getEnvironmentVariableName('github.com')).toBe('PECOT_GITHUB_COM_TOKEN')
  })

  it('hosts.json の定義は既定の対応より優先する', () => {
    useProject({ 'github.com': { env_var: 'MY_TOKEN' } })
    expect(getEnvironmentVariableName('github.com')).toBe('MY_TOKEN')
  })

  it('env_var の無い定義は KeyError と同じ文の InvalidValueError', () => {
    useProject({ 'github.com': { token_url: 'x' } })
    expect(() => getEnvironmentVariableName('github.com')).toThrow(new InvalidValueError('\'env_var\''))
  })

  it('取得先 URL と scopes。未定義ホストは設定画面の URL と空', () => {
    useProject({ 'ghes.example.com': ENTERPRISE_HOST })
    expect(tokenUrlFor('ghes.example.com')).toBe('https://ghes.example.com/settings/tokens')
    expect(scopesFor('ghes.example.com')).toEqual(['repo', 'read:org', 'project'])
    expect(tokenUrlFor('gitlab.example.com')).toBe('https://gitlab.example.com/settings/tokens')
    expect(scopesFor('gitlab.example.com')).toEqual([])
  })

  it('scopes が配列でなければ空', () => {
    useProject({ 'github.com': { ...PUBLIC_HOST, scopes: 'repo' } })
    expect(scopesFor('github.com')).toEqual([])
  })

  it('ルート .env の変数名は github.com だけ', () => {
    expect([...ROOT_ENV_VAR_MAP]).toEqual([['github.com', 'GITHUB_COM_TOKEN']])
  })
})

describe('pythonString', () => {
  it('文字列はそのまま、それ以外は repr', () => {
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

  it('KEY=VALUE を process.env に設定する', () => {
    loadEnvironmentFile(environmentFile('TEST_KEY=test_value\nANOTHER_KEY=another_value\n'))
    expect(process.env['TEST_KEY']).toBe('test_value')
    expect(process.env['ANOTHER_KEY']).toBe('another_value')
  })

  it('コメント行と空行は飛ばす', () => {
    loadEnvironmentFile(environmentFile('# This is a comment\n\n\nVALID_KEY=valid_value\n   # indented comment\n'))
    expect(process.env['VALID_KEY']).toBe('valid_value')
    expect(process.env['# This is a comment']).toBeUndefined()
  })

  it('既存の環境変数は上書きしない。空文字の値も既存として扱う', () => {
    vi.stubEnv('EXISTING_KEY', 'original_value')
    vi.stubEnv('EMPTY_KEY', '')
    loadEnvironmentFile(environmentFile('EXISTING_KEY=new_value\nEMPTY_KEY=new_value\n'))
    expect(process.env['EXISTING_KEY']).toBe('original_value')
    expect(process.env['EMPTY_KEY']).toBe('')
  })

  it('ファイルが無ければ何もしない', () => {
    expect(() => {
      loadEnvironmentFile(path.join(makeTemporaryDirectory(), 'nonexistent.env'))
    }).not.toThrow()
  })

  it('キーと値の前後の空白を落とし、値の中の = と引用符はそのまま残す', () => {
    loadEnvironmentFile(environmentFile('  SPACED_KEY  =  a=b "c"  \r\nNO_EQUALS_LINE\n=novalue\nEMPTY_VALUE=\n'))
    expect(process.env['SPACED_KEY']).toBe('a=b "c"')
    expect(process.env['NO_EQUALS_LINE']).toBeUndefined()
    expect(process.env['EMPTY_VALUE']).toBe('')
    expect(Object.hasOwn(process.env, '')).toBe(false)
  })

  it('読めないとき（ディレクトリ）は Python の OSError と同じ文の OsError', () => {
    const directory = makeTemporaryDirectory()
    expect(() => {
      loadEnvironmentFile(directory)
    }).toThrow(new OsError(`[Errno 21] Is a directory: '${directory}'`, 'EISDIR', directory))
  })
})

describe('ensureEnvironmentFile', () => {
  const HEADER = '# pecot-cli 認証設定\n# 各トークンの値を設定してください\n#\n# トークン作成時は必要なスコープを付与してください\n'

  // 期待値は Python の ensure_env_file の出力
  it('新規作成: スコープ付きのホスト', () => {
    const { config } = useProject({ 'ghes.example.com': ENTERPRISE_HOST })
    const file = ensureEnvironmentFile('ghes.example.com')
    expect(file).toBe(path.join(config, '.env'))
    expect(readFileSync(file, 'utf8')).toBe(
      `${HEADER}\n# GitHub Enterprise Server\n# 取得先: https://ghes.example.com/settings/tokens\n# 必要なスコープ: repo, read:org, project\nPECOT_GITHUB_GHES_TOKEN=\n`,
    )
  })

  it('新規作成: スコープが無ければスコープ行は空行になる', () => {
    useProject({ 'github.com': PUBLIC_HOST })
    const content = readFileSync(ensureEnvironmentFile('github.com'), 'utf8')
    expect(content).toBe(`${HEADER}\n# GitHub.com\n# 取得先: https://github.com/settings/tokens\n\nPECOT_GITHUB_COM_TOKEN=\n`)
    expect(content).not.toContain('必要なスコープ:')
  })

  it('新規作成: 未定義ホストはフォールバックの命名で、description はホスト名', () => {
    useProject({})
    expect(readFileSync(ensureEnvironmentFile('gitlab.example.com'), 'utf8')).toBe(
      `${HEADER}\n# gitlab.example.com\n# 取得先: https://gitlab.example.com/settings/tokens\n\nPECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN=\n`,
    )
  })

  it('既存の .env には追記し、既存の内容を保つ。2 回目は追記しない', () => {
    const { config } = useProject({ 'github.com': PUBLIC_HOST })
    const file = path.join(config, '.env')
    writeFileSync(file, 'EXISTING_VAR=value\n')
    ensureEnvironmentFile('github.com')
    const expected = 'EXISTING_VAR=value\n\n# GitHub.com\n# 取得先: https://github.com/settings/tokens\n\nPECOT_GITHUB_COM_TOKEN=\n'
    expect(readFileSync(file, 'utf8')).toBe(expected)
    ensureEnvironmentFile('github.com')
    expect(readFileSync(file, 'utf8')).toBe(expected)
  })

  it('環境変数名が既にあれば追記しない', () => {
    const { config } = useProject({ 'github.com': PUBLIC_HOST })
    const file = path.join(config, '.env')
    writeFileSync(file, 'PECOT_GITHUB_COM_TOKEN=existing_token\n')
    ensureEnvironmentFile('github.com')
    expect(readFileSync(file, 'utf8')).toBe('PECOT_GITHUB_COM_TOKEN=existing_token\n')
  })

  it('設定ディレクトリが無いときは Python の OSError と同じ文', () => {
    const root = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: root })
    const file = path.join(root, '.pecot', 'config', '.env')
    expect(() => ensureEnvironmentFile('github.com')).toThrow(`[Errno 2] No such file or directory: '${file}'`)
    expect(existsSync(file)).toBe(false)
  })
})
