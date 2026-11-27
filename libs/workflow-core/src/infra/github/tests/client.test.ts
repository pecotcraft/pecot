/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- node:http の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// GitHubClientBase のテスト。GitHub は偽サーバ（tests/fake-github）、gh は PATH に置く偽の実行ファイルにする。
// 次の期待値は、Python の cli/core/github/client.py（gql 4.4.0・httpx 0.28.1）を実行して得た値。
// - GraphQL の失敗の文
// - URL の組み立てと Link ヘッダ
// - PECOT_GITHUB_API_URL の判定
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import { createOutput } from '../../../commands-shared/output.js'
import { isAvoidedPort, startFakeGithub } from '../../../../tests/_helpers/fake-github/server.js'
import type { FakeGithub, ResponseMatch, ResponseRule, ResponseSpec } from '../../../../tests/_helpers/fake-github/server.js'
import { CancelledError, InvalidValueError } from '../../../domain/errors.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../tests/_helpers/environment.js'
import { installFakeExecutable, installFakeGh, prependToPath, readFakeCalls } from '../../../../tests/_helpers/fake-executables.js'
import { makeTemporaryDirectory } from '../../../../tests/_helpers/temporary.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import { clearHostsConfigCache } from '../auth.js'
import { GitHubClientBase, resolveApiUrlOverride, RestResponse, TransportFailure } from '../client.js'
import type { GitHubClientOptions } from '../client.js'
import { GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../errors.js'
import { QUERY_GET_USER_NODE_ID } from '../queries.js'
import { ignoredDiagnostics, recordDiagnostics } from '../../../../tests/_helpers/recording-diagnostics.js'

useIsolatedEnvironment()

const servers: FakeGithub[] = []
const rawServers: Server[] = []

beforeEach(clearHostsConfigCache)
afterEach(async () => {
  clearHostsConfigCache()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(async server => server.close()))
  await Promise.all(rawServers.splice(0).map(async server => new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
    server.closeAllConnections()
  })))
})

interface Project {
  readonly root: string
  readonly config: string
}

/**
一時のプロジェクトルートを作り、CLAUDE_PROJECT_DIR に向ける。hosts を渡すと設定ディレクトリの hosts.json に書く
*/
function useProject(hosts: JsonValue = {}): Project {
  const root = makeTemporaryDirectory()
  const config = path.join(root, '.pecot', 'config')
  mkdirSync(config, { recursive: true })
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({ hosts }))
  return { root, config }
}

/**
偽の gh を PATH の先頭に置く。token を省くと gh auth token は失敗する。devcontainer の実際の gh を拾わないために必ず使う
*/
function useFakeGh(token?: string): string {
  const bin = makeTemporaryDirectory()
  installFakeGh(bin, token === undefined ? {} : { token })
  prependToPath(bin)
  return bin
}

/**
クライアントを作り、gh auth token までを読み終える
*/
async function ensured(options: Readonly<GitHubClientOptions>): Promise<GitHubClientBase> {
  const client = new GitHubClientBase(options)
  await client.ensureToken()
  return client
}

async function tokenOf(options: Readonly<GitHubClientOptions>): Promise<string> {
  const { token } = await ensured(options)
  return token
}

/**
偽サーバを起動し、PECOT_GITHUB_API_URL をそこへ向ける。suffix は URL の末尾に足す（GHE の /api/v3/ など）
*/
async function serve(rules: readonly ResponseRule[], suffix = ''): Promise<FakeGithub> {
  const server = await startFakeGithub(rules)
  servers.push(server)
  setEnvironment({ PECOT_GITHUB_API_URL: `${server.url}${suffix}` })
  return server
}

function rule(match: ResponseMatch, respond: ResponseSpec, times = 1): ResponseRule {
  return { match, respond, times }
}

const FALLBACK_WARNING = 'the token in the environment variable is invalid (401 Unauthorized); fell back to gh auth token\nupdate or remove the token in .env'

interface RawRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

async function startRawServer(handler: (request: RawRequest, response: ServerResponse) => void): Promise<{ readonly url: string, readonly requests: RawRequest[] }> {
  const requests: RawRequest[] = []
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const recorded = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(recorded)
      handler(recorded, response)
    })
  })
  rawServers.push(server)
  // GraphQL の失敗の分類は文言に 401 を含むかで決まるため、ポートに 401 を含まない値を選ぶ
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    if (!isAvoidedPort(port)) return { url: `http://127.0.0.1:${String(port)}`, requests }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
}

describe('resolveApiUrlOverride', () => {
  it.each([undefined, ''])('未設定・空文字（%j）は undefined', async (value) => {
    await explains('`PECOT_GITHUB_API_URL` を読み取る関数のテストです。未設定の場合と空文字の場合に、`undefined` を返すことを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: value })
    expect(resolveApiUrlOverride()).toBeUndefined()
  })

  // 期待値は Python の resolve_api_url_override の結果
  it.each<[string, string]>([
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://localhost', 'http://localhost'],
    ['HTTP://LOCALHOST:5/x/', 'HTTP://LOCALHOST:5/x'],
    ['http://127.0.0.1/api/v3/', 'http://127.0.0.1/api/v3'],
    ['http://127.0.0.1:1234/api/v3/', 'http://127.0.0.1:1234/api/v3'],
    ['http://127.0.0.1:8080//', 'http://127.0.0.1:8080'],
    ['http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
    ['http://LocalHost:00080', 'http://LocalHost:00080'],
    ['http://127.0.0.1?', 'http://127.0.0.1?'],
    ['http://127.0.0.1#', 'http://127.0.0.1#'],
    ['http://127.0.0.1:', 'http://127.0.0.1:'],
    ['http://127.0.0.1:80/x#', 'http://127.0.0.1:80/x#'],
    ['  http://127.0.0.1', '  http://127.0.0.1'],
    ['\thttp://127.0.0.1', '\thttp://127.0.0.1'],
    ['ht\ttp://127.0.0.1', 'ht\ttp://127.0.0.1'],
    ['http://127.0.0.1\n:80', 'http://127.0.0.1\n:80'],
  ])('%j を受け付け、末尾の / を取り除いて返す', async (value, expected) => {
    await explains('`PECOT_GITHUB_API_URL` を読み取る関数のテストです。`http://127.0.0.1` や `http://localhost` の URL を受け付け、末尾の `/` を取り除いて返すことを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: value })
    expect(resolveApiUrlOverride()).toBe(expected)
  })

  it.each<string>([
    'https://example.com',
    'https://127.0.0.1:8123',
    'https://localhost',
    'https://localhost.example.com',
    'http://127.0.0.1:notaport',
    'http://127.0.0.1:8123?a=1',
    'http://127.0.0.1:8123#frag',
    'http://user@127.0.0.1:8123',
    'ftp://127.0.0.1',
    'http://127.1:8080',
    'http://0x7f.0.0.1',
    'http:/127.0.0.1:80',
    'http:///127.0.0.1',
    '//127.0.0.1',
    '127.0.0.1:80',
    'https://127.0.0.1',
    'javascript:http://127.0.0.1',
    'http://127.0.0.1?a=1',
    'http://127.0.0.1#f',
    'http://127.0.0.1/a?b',
    'http://u@127.0.0.1',
    'http://@127.0.0.1',
    'http://127.0.0.1\\@evil',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:0x',
    'http://127.0.0.1:８０',
    'http://127.0.0.1:80:90',
    'http://[::1]:80',
    'http://localhost.',
    'http://evil.example',
    'http://127.0.0.1.evil.example',
  ])('%j を渡すと、ValueError と同じ文の InvalidValueError が発生する', async (value) => {
    await explains('`PECOT_GITHUB_API_URL` を読み取る関数のテストです。`http://127.0.0.1` と `http://localhost` 以外の URL の場合に、`InvalidValueError` が発生することを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: value })
    expect(() => resolveApiUrlOverride()).toThrow(new InvalidValueError(`PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: ${value}`))
  })

  it('不正な値を指定すると、クライアントの構築で InvalidValueError が発生する', async () => {
    await explains('`PECOT_GITHUB_API_URL` を読み取る関数のテストです。不正な値を指定した場合に、クライアントの構築で `InvalidValueError` が発生することを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.1:8080' })
    expect(() => new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })).toThrow(InvalidValueError)
  })
})

describe('初期化の URL', () => {
  it('host が github.com のとき、API と GraphQL の URL を github.com のものにする', async () => {
    await explains('GitHub クライアントの URL のテストです。host が `github.com` の場合に、API と GraphQL の URL が `github.com` のものになり、タイムアウトの既定値が 30 秒になることを確認します。')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com', token: 'test_token' })
    expect(client.host).toBe('github.com')
    expect(client.token).toBe('test_token')
    expect(client.apiUrl).toBe('https://api.github.com')
    expect(client.graphqlUrl).toBe('https://api.github.com/graphql')
    expect(client.timeoutMilliseconds).toBe(30_000)
  })

  it('host の既定は github.com', async () => {
    await explains('GitHub クライアントの URL のテストです。host を省略した場合に、既定の host が `github.com` になることを確認します。')
    expect(new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).host).toBe('github.com')
  })

  it('GitHub Enterprise Server は /api/v3 と /api/graphql', async () => {
    await explains('GitHub クライアントの URL のテストです。GitHub Enterprise Server の host の場合に、API の URL が `/api/v3`、GraphQL の URL が `/api/graphql` になることを確認します。')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com', token: 'test_token' })
    expect(client.apiUrl).toBe('https://ghes.example.com/api/v3')
    expect(client.graphqlUrl).toBe('https://ghes.example.com/api/graphql')
  })

  it.each(['127.0.0.1', 'localhost'])('PECOT_GITHUB_API_URL に %s を指定すると、host が GHE でも REST と GraphQL の URL を組み立てる', async (host) => {
    await explains('GitHub クライアントの URL のテストです。`PECOT_GITHUB_API_URL` に `localhost` などを指定した場合に、host の種類によらず、その URL が REST と GraphQL の基準になることを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: `http://${host}:8123` })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com', token: 't' })
    expect(client.apiUrl).toBe(`http://${host}:8123`)
    expect(client.graphqlUrl).toBe(`http://${host}:8123/graphql`)
    expect(client.host).toBe('ghes.example.com')
  })

  it('PECOT_GITHUB_API_URL の指定で、REST の base と GraphQL の URL を差し替える', async () => {
    await explains('GitHub クライアントの URL のテストです。`PECOT_GITHUB_API_URL` を指定した場合に、REST のベース URL と GraphQL の URL を差し替え、指定したタイムアウトを保持することを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.0.0.1:8080/api/v3/' })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com', token: 't', timeoutMilliseconds: 5 })
    expect(client.apiUrl).toBe('http://127.0.0.1:8080/api/v3')
    expect(client.graphqlUrl).toBe('http://127.0.0.1:8080/api/v3/graphql')
    expect(client.timeoutMilliseconds).toBe(5)
  })
})

describe('トークンの取得', () => {
  it('hosts.json の env_var が示す環境変数にトークンが存在する場合は、それを使い、gh を呼び出さない', async () => {
    await explains('トークンの取得のテストです。`hosts.json` の `env_var` が示す環境変数にトークンが存在する場合に、そのトークンを使い、`gh` を呼び出さないことを確認します。')
    useProject({ 'ghes.example.com': { env_var: 'PECOT_GITHUB_GHES_TOKEN', token_url: 'https://ghes.example.com/settings/tokens' } })
    setEnvironment({ PECOT_GITHUB_GHES_TOKEN: 'env_token_from_test' })
    const bin = useFakeGh('gh_token')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com' })).toBe('env_token_from_test')
    expect(readFakeCalls(bin, 'gh')).toEqual([])
  })

  it('config/.env のファイルからトークンを取得し、process.env にも設定する', async () => {
    await explains('トークンの取得のテストです。`config/.env` ファイルにトークンがある場合に、そのトークンを使い、`process.env` にも設定することを確認します。')
    const { config } = useProject({ 'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN', token_url: 'https://github.com/settings/tokens' } })
    vi.stubEnv('PECOT_GITHUB_COM_TOKEN', undefined)
    writeFileSync(path.join(config, '.env'), 'PECOT_GITHUB_COM_TOKEN=token_from_env_file\n')
    const bin = useFakeGh('gh_token')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('token_from_env_file')
    expect(process.env['PECOT_GITHUB_COM_TOKEN']).toBe('token_from_env_file')
    expect(readFakeCalls(bin, 'gh')).toEqual([])
  })

  it('config/.env にトークンが存在しない場合は、ルートの .env の GITHUB_COM_TOKEN を使う', async () => {
    await explains('トークンの取得のテストです。`config/.env` にトークンが存在しない場合に、ルートの `.env` の `GITHUB_COM_TOKEN` を使うことを確認します。')
    const { root } = useProject()
    writeFileSync(path.join(root, '.env'), 'GITHUB_COM_TOKEN=root_token\n')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('root_token')
  })

  it('config/.env のトークンがルート .env より優先される', async () => {
    await explains('トークンの取得のテストです。`config/.env` とルートの `.env` の両方にトークンがある場合に、`config/.env` のトークンを優先することを確認します。')
    const { root, config } = useProject({ 'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN', token_url: 'https://github.com/settings/tokens' } })
    writeFileSync(path.join(config, '.env'), 'PECOT_GITHUB_COM_TOKEN=config_token\n')
    writeFileSync(path.join(root, '.env'), 'GITHUB_COM_TOKEN=root_token\n')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('config_token')
  })

  it('ルート .env のトークンが gh auth token より優先される（gh は呼ばれない）', async () => {
    await explains('トークンの取得のテストです。ルートの `.env` にトークンがある場合に、`gh auth token` より優先し、`gh` を呼び出さないことを確認します。')
    const { root } = useProject({ 'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN', token_url: 'https://github.com/settings/tokens' } })
    writeFileSync(path.join(root, '.env'), 'GITHUB_COM_TOKEN=root_com_token\n')
    const bin = useFakeGh('gh_token_should_not_be_used')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('root_com_token')
    expect(readFakeCalls(bin, 'gh')).toEqual([])
  })

  it('ルート .env の値が空なら gh にフォールバックする', async () => {
    await explains('トークンの取得のテストです。ルートの `.env` のトークンの値が空の場合に、`gh auth token` の結果にフォールバックすることを確認します。')
    const { root } = useProject()
    writeFileSync(path.join(root, '.env'), 'GITHUB_COM_TOKEN=\n')
    useFakeGh('gh_token')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('gh_token')
  })

  it('ルート .env に対応しないホストは gh auth token -h <host> にフォールバックする', async () => {
    await explains('トークンの取得のテストです。ルートの `.env` に対応しないホストの場合に、`gh auth token -h <host>` にフォールバックすることを確認します。')
    const { root } = useProject()
    writeFileSync(path.join(root, '.env'), 'SOME_TOKEN=unused\n')
    const bin = useFakeGh('gh_fallback_token')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'gitlab.example.com' })).toBe('gh_fallback_token')
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token', '-h', 'gitlab.example.com']])
  })

  it('github.com は gh auth token（-h なし）', async () => {
    await explains('トークンの取得のテストです。host が `github.com` の場合に、`-h` を付けない `gh auth token` でトークンを取得することを確認します。')
    useProject()
    const bin = useFakeGh('gh_token_123')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com' })).toBe('gh_token_123')
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
  })

  it('GHES は gh auth token -h ghes.example.com', async () => {
    await explains('トークンの取得のテストです。host が GitHub Enterprise Server の場合に、`gh auth token -h ghes.example.com` でトークンを取得することを確認します。')
    useProject()
    const bin = useFakeGh('ghes_token_456')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com' })).toBe('ghes_token_456')
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token', '-h', 'ghes.example.com']])
  })

  it('token に空文字を渡したときは、指定なしと同じに取得する', async () => {
    await explains('トークンの取得のテストです。`token` に空文字を指定した場合に、指定しなかった場合と同じ方法でトークンを取得することを確認します。')
    useProject()
    useFakeGh('gh_token')
    expect(await tokenOf({ diagnostics: ignoredDiagnostics, host: 'github.com', token: '' })).toBe('gh_token')
  })

  // 期待値は Python の _build_auth_error_message の出力
  it('gh が失敗した場合は、手順を案内する GitHubAuthError が発生し、.env を生成する', async () => {
    await explains('トークンを取得できない場合のテストです。`gh` が失敗した場合に、手順を案内するメッセージの `GitHubAuthError` が発生し、`.env` を生成することを確認します。')
    const { root, config } = useProject({
      'ghes.example.com': {
        env_var: 'PECOT_GITHUB_GHES_TOKEN',
        token_url: 'https://ghes.example.com/settings/tokens',
        description: 'GitHub Enterprise Server',
        scopes: ['repo', 'read:org', 'project'],
      },
    })
    useFakeGh()
    const file = path.join(config, '.env')
    expect(file).toBe(path.join(root, '.pecot', 'config', '.env'))
    const thrown = ensured({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com' })
    await expect(thrown).rejects.toBeInstanceOf(GitHubAuthError)
    await expect(thrown).rejects.toHaveProperty('message',
      `authentication error: could not get a GitHub API token\n\n${file} was generated. Set the token as follows:\n\n`
      + `1. get a token: https://ghes.example.com/settings/tokens\n   required scopes: repo, read:org, project\n\n`
      + `2. edit ${file} and set the token in PECOT_GITHUB_GHES_TOKEN\n\nor authenticate with the GitHub CLI:\n   gh auth login -h ghes.example.com`,
    )
    expect(readFileSync(file, 'utf8')).toBe(
      '# pecot-cli 認証設定\n# 各トークンの値を設定してください\n#\n# トークン作成時は必要なスコープを付与してください\n\n'
      + '# GitHub Enterprise Server\n# 取得先: https://ghes.example.com/settings/tokens\n# 必要なスコープ: repo, read:org, project\nPECOT_GITHUB_GHES_TOKEN=\n',
    )
  })

  it('設定ディレクトリが存在しない場合は、.env を作成せずに gh auth login と起動前の環境変数を案内する', async () => {
    await explains('トークンを取得できない場合のテストです。設定ディレクトリが存在しない場合に、`.env` を作成せず、`gh auth login` と起動前に環境変数を設定する方法を案内することを確認します。')
    const root = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: root })
    useFakeGh()
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com' })).rejects.toThrow(new GitHubAuthError(
      'authentication error: could not get a GitHub API token\n\n'
      + 'authenticate with the GitHub CLI:\n   gh auth login -h github.com\n\n'
      + 'or set a token in an environment variable:\n'
      + '1. get a token: https://github.com/settings/tokens\n'
      + '2. set it in PECOT_GITHUB_COM_TOKEN before starting pecot (for the MCP server, before starting the session)',
    ))
    expect(existsSync(path.join(root, '.pecot'))).toBe(false)
  })

  it('スコープを持たないホストは、案内のスコープの行が空行になる', async () => {
    await explains('トークンを取得できない場合のテストです。スコープを持たないホストの場合に、案内するメッセージのスコープの行が空行になることを確認します。')
    const { config } = useProject()
    useFakeGh()
    const file = path.join(config, '.env')
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'gitlab.example.com' })).rejects.toThrow(
      `authentication error: could not get a GitHub API token\n\n${file} was generated. Set the token as follows:\n\n`
      + `1. get a token: https://gitlab.example.com/settings/tokens\n\n\n`
      + `2. edit ${file} and set the token in PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN\n\nor authenticate with the GitHub CLI:\n   gh auth login -h gitlab.example.com`,
    )
  })

  it('gh が見つからない場合も、手順を案内する GitHubAuthError が発生し、.env を生成する', async () => {
    await explains('トークンを取得できない場合のテストです。`gh` が見つからない場合にも、手順を案内するメッセージの `GitHubAuthError` が発生し、`.env` を生成することを確認します。')
    const { config } = useProject({ 'github.com': { env_var: 'PECOT_GITHUB_COM_TOKEN', token_url: 'https://github.com/settings/tokens', description: 'GitHub.com', scopes: ['repo'] } })
    // gh を含まない PATH にする
    setEnvironment({ PATH: makeTemporaryDirectory() })
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com' })).rejects.toThrow(GitHubAuthError)
    const content = readFileSync(path.join(config, '.env'), 'utf8')
    expect(content).toContain('PECOT_GITHUB_COM_TOKEN=')
    expect(content).toContain('# 必要なスコープ: repo')
  })

  it('gh が空のトークンを出力した場合は、gh が失敗した場合と同じ GitHubAuthError が発生し、.env を生成する', async () => {
    await explains('トークンを取得できない場合のテストです。`gh` が空のトークンを出力した場合に、`gh` が失敗した場合と同じメッセージの `GitHubAuthError` が発生し、`.env` を生成することを確認します。')
    const { config } = useProject()
    const bin = makeTemporaryDirectory()
    installFakeGh(bin, { token: '' })
    prependToPath(bin)
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com' })).rejects.toThrow(GitHubAuthError)
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com' })).rejects.toThrow('authentication error: could not get a GitHub API token')
    expect(existsSync(path.join(config, '.env'))).toBe(true)
  })

  it('gh が空白だけを出力した場合も、GitHubAuthError が発生する', async () => {
    await explains('トークンを取得できない場合のテストです。`gh` が空白だけを出力した場合にも、`GitHubAuthError` が発生することを確認します。')
    useProject()
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'gh', 'printf \'  \\n\'\n')
    prependToPath(bin)
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com' })).rejects.toThrow(GitHubAuthError)
  })

  it('gh が時間切れになった場合は、gh が失敗した場合と同じ GitHubAuthError が発生する', async () => {
    await explains('トークンを取得できない場合のテストです。`gh` が時間切れになった場合は、指定した時間で打ち切り、`gh` が失敗した場合と同じ `GitHubAuthError` が発生することを確認します。')
    useProject()
    const bin = makeTemporaryDirectory()
    // exec で sleep に置き換え、時間切れの kill で出力の管も閉じるようにする
    installFakeExecutable(bin, 'gh', 'exec sleep 5\n')
    prependToPath(bin)
    const started = Date.now()
    await expect(ensured({ diagnostics: ignoredDiagnostics, host: 'github.com', ghTimeoutMilliseconds: 100 })).rejects.toThrow(GitHubAuthError)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('環境にトークンが存在しなくても、構築では gh を呼び出さず、認証エラーも発生しない', async () => {
    await explains('クライアントの構築のテストです。環境にトークンが存在しない場合でも、構築の時点では `gh` を呼び出さず、認証エラーも発生しないことを確認します。')
    useProject()
    const bin = useFakeGh()
    expect(new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com' }).token).toBe('')
    expect(readFakeCalls(bin, 'gh')).toEqual([])
  })

  it('ensureToken を重ねて呼んでも、gh auth token は 1 回だけ読む', async () => {
    await explains('`ensureToken` のテストです。重ねて呼び出した場合でも、`gh auth token` の読み取りが 1 回だけになることを確認します。')
    useProject()
    const bin = useFakeGh('gh_token')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com' })
    await Promise.all([client.ensureToken(), client.ensureToken()])
    await client.ensureToken()
    expect(client.token).toBe('gh_token')
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
  })

  it('ensureToken を呼ばずに要求すると、要求の前に gh のトークンを読んでヘッダに付ける', async () => {
    await explains('REST の要求のテストです。`ensureToken` を呼ばないまま要求した場合は、要求の前に `gh` のトークンを取得し、`Authorization` ヘッダへ設定することを確認します。')
    useProject()
    useFakeGh('gh_token')
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    await new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com' }).restRequest('GET', '/user')
    expect(raw.requests.map(request => request.headers.authorization)).toEqual(['Bearer gh_token'])
  })

  it('gh を待つ間に取り消すと、GitHubAuthError でなく CancelledError が発生し、.env を作成しない', async () => {
    await explains('トークンの取得のテストです。`gh` の完了を待つ間の取り消しでは、`GitHubAuthError` ではなく `CancelledError` が発生し、`.env` を作成しないことを確認します。')
    const { config } = useProject()
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'gh', 'exec sleep 5\n')
    prependToPath(bin)
    const controller = new AbortController()
    const started = Date.now()
    const pending = ensured({ diagnostics: ignoredDiagnostics, host: 'github.com', signal: controller.signal })
    await vi.waitFor(() => {
      expect(readFakeCalls(bin, 'gh')).toHaveLength(1)
    })
    controller.abort('stopped by test')
    await expect(pending).rejects.toThrow(new CancelledError('stopped by test'))
    expect(Date.now() - started).toBeLessThan(3000)
    expect(existsSync(path.join(config, '.env'))).toBe(false)
  })
})

function responseOf(statusCode: number, text: string): RestResponse {
  return new RestResponse({ statusCode, statusText: '', url: 'https://api.github.com/repos/test/test', text, headers: new Map() })
}

describe('handleHttpError', () => {
  const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 'test_token' })

  function failure(target: RestResponse): unknown {
    try {
      client.handleHttpError(target)
    }
    catch (error: unknown) {
      return error
    }
    return undefined
  }

  it('401 は GitHubAuthError', async () => {
    await explains('HTTP エラーの変換のテストです。401 の場合に、`GitHubAuthError` に変換し、状態コードと本文を保持することを確認します。')
    const error = failure(responseOf(401, 'Unauthorized'))
    expect(error).toBeInstanceOf(GitHubAuthError)
    expect(error).toMatchObject({ message: 'authentication failed: check the token', statusCode: 401, responseBody: 'Unauthorized' })
  })

  it('404 は URL を含む GitHubNotFoundError', async () => {
    await explains('HTTP エラーの変換のテストです。404 の場合は、要求した URL をメッセージに含む `GitHubNotFoundError` へ変換することを確認します。')
    const error = failure(responseOf(404, 'Not Found'))
    expect(error).toBeInstanceOf(GitHubNotFoundError)
    expect(error).toMatchObject({ message: 'resource not found: https://api.github.com/repos/test/test', statusCode: 404, responseBody: 'Not Found' })
  })

  it('403 で本文に rate limit があれば GitHubRateLimitError。大文字小文字は区別しない', async () => {
    await explains('HTTP エラーの変換のテストです。403 で本文に `rate limit` を含む場合に、大文字と小文字を区別せず `GitHubRateLimitError` に変換することを確認します。')
    const error = failure(responseOf(403, 'API Rate Limit exceeded'))
    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect(error).toMatchObject({ message: 'API rate limit reached', statusCode: 403 })
  })

  it('429 は GitHubRateLimitError（本文は問わない）', async () => {
    await explains('HTTP エラーの変換のテストです。429 の場合は、本文の内容によらず `GitHubRateLimitError` へ変換することを確認します。')
    const error = failure(responseOf(429, 'Too Many Requests'))
    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect(error).toMatchObject({ message: 'API rate limit reached', statusCode: 429, responseBody: 'Too Many Requests' })
  })

  it('403 以外の状態で本文に rate limit があっても、レート制限にはしない', async () => {
    await explains('HTTP エラーの変換のテストです。403 以外の状態コードでは、本文に `rate limit` を含んでいても `GitHubRateLimitError` に変換しないことを確認します。')
    const error = failure(responseOf(500, 'rate limit'))
    expect(error).not.toBeInstanceOf(GitHubRateLimitError)
    expect(error).toMatchObject({ message: 'GitHub API error: 500' })
  })

  it('403 のそれ以外は GitHubAPIError（サブクラスではない）', async () => {
    await explains('HTTP エラーの変換のテストです。403 で本文にレート制限を含まない場合に、`GitHubRateLimitError` ではない `GitHubAPIError` に変換することを確認します。')
    const error = failure(responseOf(403, 'Forbidden'))
    expect(error).toBeInstanceOf(GitHubAPIError)
    expect(error).not.toBeInstanceOf(GitHubRateLimitError)
    expect(error).toMatchObject({ message: 'access denied', statusCode: 403, responseBody: 'Forbidden' })
  })

  it.each([500, 301, 422])('%i は GitHub API error: <status code>', async (statusCode) => {
    await explains('HTTP エラーの変換のテストです。500・301・422 の場合に、メッセージが `GitHub API error: <状態コード>` の `GitHubAPIError` に変換することを確認します。')
    const error = failure(responseOf(statusCode, 'x'))
    expect(error).toBeInstanceOf(GitHubAPIError)
    expect(error).toMatchObject({ message: `GitHub API error: ${String(statusCode)}`, statusCode, responseBody: 'x' })
  })
})

describe('REST の要求', () => {
  it('POST は JSON の本文を送信し、Bearer で認証する（github.com）', async () => {
    await explains('REST の要求のテストです。POST の場合に、JSON の本文を送信し、`Bearer` で認証する（github.com の場合）ことを確認します。')
    const server = await serve([rule({ method: 'POST', path: '/repos/owner/repo/issues' }, { status: 201, body: { number: 124 } })])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com', token: 't' })
    const response = await client.restRequest('POST', '/repos/owner/repo/issues', { json: { title: 'New Issue', body: 'Body', labels: ['bug'] } })
    expect(response.statusCode).toBe(201)
    expect(response.isSuccess).toBe(true)
    expect(response.json()).toEqual({ number: 124 })
    expect(server.requests()).toEqual([
      { type: 'rest', method: 'POST', path: '/repos/owner/repo/issues', query: {}, body: { title: 'New Issue', body: 'Body', labels: ['bug'] }, auth: 'Bearer' },
    ])
    expect(server.problems()).toEqual([])
  })

  it('GHE は token で認証し、base の /api/v3 を保ったまま path を連結する', async () => {
    await explains('REST の要求のテストです。GitHub Enterprise Server の場合に、`token` で認証し、ベース URL の `/api/v3` を保ったまま path を連結することを確認します。')
    const server = await serve([rule({ method: 'GET', path: '/api/v3/user' }, { status: 200, body: { login: 'u' } })], '/api/v3/')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com', token: 't' })
    expect(client.apiUrl).toBe(`${server.url}/api/v3`)
    expect(await client.getAuthenticatedUser()).toEqual({ login: 'u' })
    expect(server.requests()).toEqual([{ type: 'rest', method: 'GET', path: '/api/v3/user', query: {}, auth: 'token' }])
  })

  it('先頭の / が無い path も同じ URL になる', async () => {
    await explains('REST の要求のテストです。先頭の `/` がない path でも、同じ URL に要求することを確認します。')
    const server = await serve([rule({ path: '/api/v3/user' }, { status: 200, body: {} }, 2)], '/api/v3')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    await client.restRequest('GET', 'user')
    await client.restRequest('GET', '/user')
    expect(server.problems()).toEqual([])
    expect(server.requests()).toHaveLength(2)
  })

  // 期待値は httpx の build_request が作る URL
  it('params を httpx と同じ表記のクエリにする（真偽値は小文字、undefined と空白は httpx の表記、予約文字は %XX）', async () => {
    await explains('REST の要求のテストです。`params` から作成するクエリ文字列が、httpx と同じ表記（真偽値は小文字、予約文字は `%XX`）になることを確認します。')
    const server = await serve([rule({ method: 'GET', path: '/x' }, { status: 200, body: {} })])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    await client.restRequest('GET', '/x', { params: { 'a': true, 'b': false, 'c': undefined, 'd 1': 'é~*!x y&=', 'e': 1.5, 'f': 100 } })
    expect(server.requests()).toEqual([{
      type: 'rest',
      method: 'GET',
      path: '/x',
      query: { 'a': 'true', 'b': 'false', 'c': '', 'd 1': 'é~*!x y&=', 'e': '1.5', 'f': '100' },
      auth: 'Bearer',
    }])
  })

  it('params を指定すると、URL に書かれたクエリは置き換わる（httpx と同じ）。空の params は URL のクエリを消す', async () => {
    await explains('REST の要求のテストです。`params` を指定した場合に、URL に書いたクエリを置き換え、空の `params` では URL のクエリを消すことを確認します（httpx と同じ）。')
    const server = await serve([rule({ path: '/x' }, { status: 200, body: {} }, 2)])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    await client.restRequest('GET', '/x?y=1', { params: { z: 2 } })
    await client.restRequest('GET', '/x?y=1', { params: {} })
    expect(server.requests().map(request => request.type === 'rest' ? request.query : undefined)).toEqual([{ z: '2' }, {}])
  })

  it('絶対 URL は base を付けずにそのまま使う', async () => {
    await explains('REST の要求のテストです。絶対 URL を指定した場合に、ベース URL を付けずにそのまま使うことを確認します。')
    const server = await serve([rule({ path: '/other/page', query: { after: 'abc' } }, { status: 200, body: ['page2'] })], '/api/v3')
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    const response = await client.restRequest('GET', `${server.url}/other/page?after=abc`)
    expect(response.json()).toEqual(['page2'])
    expect(server.requests()).toHaveLength(1)
  })

  it.each([
    ['別のホスト', 'http://evil.example/x'],
    ['同じホストの別のポート', 'http://127.0.0.1:1/x'],
    ['同じホストの別のスキーム', 'https://127.0.0.1/x'],
  ])('絶対 URL が API と同じ origin でなければ（%s）、Authorization を送らず GitHubAPIError', async (_name, target) => {
    await explains('REST の要求のテストです。絶対 URL が API と同じ origin でない場合（別のホスト・別のポート・別のスキーム）に、`Authorization` を送信せず `GitHubAPIError` が発生することを確認します。')
    const server = await serve([])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    await expect(client.restRequest('GET', target)).rejects.toThrow(
      new GitHubAPIError(`refusing to follow a URL on a different host than the API: ${target}`),
    )
    expect(server.requests()).toEqual([])
  })

  // 期待値は httpx の Response.links
  it('Link ヘッダの next を、次の要求の絶対 URL に使える', async () => {
    await explains('ページ送りのテストです。`Link` ヘッダの `next` の URL を、次の要求の絶対 URL として使えることを確認します。')
    const server = await serve([
      rule({ path: '/repos/o/r/dependabot/alerts', query: { state: 'open', per_page: '100' } }, {
        status: 200,
        body: [{ number: 1 }],
        headers: { Link: '<{{GITHUB_API}}/repos/o/r/dependabot/alerts?after=abc>; rel="next", <{{GITHUB_API}}/last>; rel="last"' },
      }),
      rule({ path: '/repos/o/r/dependabot/alerts', query: { after: 'abc' } }, { status: 200, body: [{ number: 2 }] }),
    ])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    const first = await client.restRequest('GET', '/repos/o/r/dependabot/alerts', { params: { state: 'open', per_page: 100 } })
    const next = first.links.get('next')
    expect(next).toEqual({ url: `${server.url}/repos/o/r/dependabot/alerts?after=abc`, rel: 'next' })
    expect(Object.keys(Object.fromEntries(first.links))).toEqual(['next', 'last'])
    const second = await client.restRequest('GET', next?.url ?? '', { params: undefined })
    expect(second.json()).toEqual([{ number: 2 }])
    expect(second.links.size).toBe(0)
    expect(server.problems()).toEqual([])
  })

  it.each<[string, Record<string, { url: string, rel?: string }>]>([
    ['<https://x/a>; rel=next', { next: { url: 'https://x/a', rel: 'next' } }],
    ['<https://x/a>', { 'https://x/a': { url: 'https://x/a' } }],
    ['', {}],
    ['  ', {}],
    ['<https://x/a>; rel="next"; title="T"', { next: { url: 'https://x/a', rel: 'next' } }],
    ['<https://x/a>; foo', { 'https://x/a': { url: 'https://x/a' } }],
    ['<https://x/a>; rel="next";', { next: { url: 'https://x/a', rel: 'next' } }],
    ['garbage', { garbage: { url: 'garbage' } }],
    ['<https://x/a>;rel=next,<https://x/b>;rel=prev', { next: { url: 'https://x/a', rel: 'next' }, prev: { url: 'https://x/b', rel: 'prev' } }],
    ['<https://x/a>; rel="next", <https://x/b>; rel="next"', { next: { url: 'https://x/b', rel: 'next' } }],
    ['<https://x/a>; rel=""', { 'https://x/a': { url: 'https://x/a', rel: '' } }],
    ['<https://x/a>; a=b=c; rel=next', { 'https://x/a': { url: 'https://x/a' } }],
  ])('Link ヘッダ %j の読み方は httpx と同じ', async (header, expected) => {
    await explains('`Link` ヘッダを解析するテストです。`rel` の有無や引用符、複数の項目などのさまざまな書き方が、httpx と同じ読み取り結果になることを確認します。')
    const response = new RestResponse({ statusCode: 200, statusText: 'OK', url: 'u', text: '', headers: new Map([['link', header]]) })
    expect(Object.fromEntries(response.links)).toEqual(expected)
  })

  it('Link ヘッダが無ければ links は空。header() は大文字小文字を区別しない', async () => {
    await explains('`Link` ヘッダを解析するテストです。`Link` ヘッダが存在しない場合は `links` が空になり、`header()` が大文字小文字を区別しないことを確認します。')
    const response = new RestResponse({ statusCode: 200, statusText: 'OK', url: 'u', text: '', headers: new Map([['x-test', 'v']]) })
    expect(response.links.size).toBe(0)
    expect(response.header('X-Test')).toBe('v')
    expect(response.header('missing')).toBeUndefined()
  })

  it('リダイレクトは辿らず、そのまま返す。失敗として扱う', async () => {
    await explains('REST の要求のテストです。リダイレクトの応答を、辿らずにそのまま返し、失敗として扱うことを確認します。')
    const server = await serve([rule({ path: '/old' }, { status: 301, body: {}, headers: { Location: '/new' } })])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    const response = await client.restRequest('GET', '/old')
    expect(response.statusCode).toBe(301)
    expect(response.isSuccess).toBe(false)
    expect(response.header('location')).toBe('/new')
    expect(() => {
      client.handleHttpError(response)
    }).toThrow('GitHub API error: 301')
    expect(server.requests()).toHaveLength(1)
  })

  it.each([
    [401, GitHubAuthError, 'authentication failed: check the token'],
    [404, GitHubNotFoundError, 'resource not found: {{URL}}/repos/test/test'],
    [500, GitHubAPIError, 'GitHub API error: 500'],
  ])('%i の応答を handleHttpError に渡すと対応する例外になる', async (status, errorClass, message) => {
    await explains('REST の要求のテストです。401・404・500 の応答を `handleHttpError` に渡した場合は、対応する例外が発生することを確認します。')
    const server = await serve([rule({ path: '/repos/test/test' }, { status, text: 'body text' })])
    // 401 でも gh には切り替えない
    useFakeGh()
    useProject()
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    const response = await client.restRequest('GET', '/repos/test/test')
    expect(response.text).toBe('body text')
    let thrown: unknown
    try {
      client.handleHttpError(response)
    }
    catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(errorClass)
    expect(thrown).toMatchObject({ message: message.replace('{{URL}}', () => server.url), statusCode: status, responseBody: 'body text' })
  })

  it('JSON でない本文を json() で読むと InvalidValueError', async () => {
    await explains('REST の要求のテストです。JSON でない本文を `json()` で読み取った場合に、`InvalidValueError` が発生することを確認します。')
    await serve([rule({ path: '/x' }, { status: 200, text: 'not json' })])
    const response = await new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).restRequest('GET', '/x')
    expect(() => response.json()).toThrow(InvalidValueError)
  })

  it('認証ユーザーの情報を取得する', async () => {
    await explains('認証ユーザーの取得のテストです。ユーザーの情報（`login`・`id`・`name`・`email`）を返すことを確認します。')
    const server = await serve([rule({ method: 'GET', path: '/user' }, { status: 200, body: { login: 'test-user', id: 12_345, name: 'Test User', email: 'test@example.com' } })])
    const user = await new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).getAuthenticatedUser()
    expect(user).toEqual({ login: 'test-user', id: 12_345, name: 'Test User', email: 'test@example.com' })
    expect(server.requests()).toEqual([{ type: 'rest', method: 'GET', path: '/user', query: {}, auth: 'Bearer' }])
  })

  it('認証ユーザーの取得で 401 なら GitHubAuthError', async () => {
    await explains('認証ユーザーの取得のテストです。401 が返った場合に、`GitHubAuthError` が発生し、状態コードと本文を保持することを確認します。')
    useProject()
    useFakeGh()
    await serve([rule({ path: '/user' }, { status: 401, text: 'Unauthorized' })])
    await expect(new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).getAuthenticatedUser()).rejects.toMatchObject({
      name: 'GitHubAuthError',
      statusCode: 401,
      responseBody: 'Unauthorized',
    })
  })

  it('Authorization・Accept・X-GitHub-Api-Version を付け、JSON の本文は余分な空白を含まない形にして Content-Type を付ける', async () => {
    await explains('REST の要求のヘッダのテストです。`Authorization`・`Accept`・`X-GitHub-Api-Version` を付け、JSON の本文は余分な空白を含まない形で、`Content-Type` を付けて送信することを確認します。')
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'github.com', token: 'tok' })
    await client.restRequest('GET', '/user')
    await client.restRequest('PUT', '/x', { json: { a: ['日本語', 1, true], b: JSON_NULL } })
    const [get, put] = raw.requests
    expect(get?.headers).toMatchObject({ 'authorization': 'Bearer tok', 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' })
    expect(get?.headers['content-type']).toBeUndefined()
    expect(get?.body).toBe('')
    expect(put?.method).toBe('PUT')
    expect(put?.headers['content-type']).toBe('application/json')
    expect(put?.body).toBe('{"a":["日本語",1,true],"b":null}')
  })

  it.each(['ghes.example.com', 'ghe.example.org'])('GHE（%s）の認証ヘッダは token <値>', async (host) => {
    await explains('REST の要求のヘッダのテストです。GitHub Enterprise Server の host の場合に、認証ヘッダが `token <値>` の形になることを確認します。')
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200).end('{}')
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    await new GitHubClientBase({ diagnostics: ignoredDiagnostics, host, token: 'tok' }).restRequest('GET', '/user')
    expect(raw.requests[0]?.headers.authorization).toBe('token tok')
  })

  it('接続できないときは TransportFailure（Python の ConnectError の文）', async () => {
    await explains('REST の要求のテストです。接続できない場合に、Python の `ConnectError` と同じ文の `TransportFailure` が発生することを確認します。')
    const closed = await startFakeGithub([])
    await closed.close()
    setEnvironment({ PECOT_GITHUB_API_URL: closed.url })
    const request = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).restRequest('GET', '/user')
    await expect(request).rejects.toBeInstanceOf(TransportFailure)
    await expect(request).rejects.toThrow('[Errno 111] Connection refused')
  })

  it('時間切れは TransportFailure（Python の ReadTimeout の文）', async () => {
    await explains('REST の要求のテストです。時間切れの場合に、Python の `ReadTimeout` と同じ文の `TransportFailure` が発生することを確認します。')
    const raw = await startRawServer(() => {
      // 応答しない
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't', timeoutMilliseconds: 50 })
    await expect(client.restRequest('GET', '/user')).rejects.toThrow(new TransportFailure('timed out'))
  })
})

describe('401 のときの gh auth token への切り替え', () => {
  it('REST: 1 回だけ gh のトークンに切り替え、警告を診断の出力先に渡して再試行する', async () => {
    await explains('401 の応答のテストです。REST の要求が 401 の場合に、1 回だけ `gh` のトークンに切り替え、警告を出力して再試行することを確認します。')
    useProject()
    const bin = useFakeGh('gh_new_token')
    const recorded = recordDiagnostics()
    const server = await serve([
      rule({ path: '/user' }, { status: 401, text: 'Unauthorized' }),
      rule({ path: '/user' }, { status: 200, body: { login: 'u' } }),
    ])
    const client = new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'env_old_token' })
    expect(await client.getAuthenticatedUser()).toEqual({ login: 'u' })
    expect(client.token).toBe('gh_new_token')
    expect(recorded.lines).toEqual([`warning: ${FALLBACK_WARNING}`])
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
    expect(server.requests()).toHaveLength(2)
  })

  it('診断の出力先に createOutput を渡すと、stderr に変更前と同じ 2 行の警告を出力する', async () => {
    await explains('401 の応答のテストです。診断の出力先に `createOutput` を渡した場合に、stderr に変更前と同じ 2 行の警告を出力することを確認します。')
    useProject()
    useFakeGh('gh_new_token')
    const stderr: string[] = []
    const output = createOutput(false, {
      stdout: () => {
        // この確認では stdout を使わない
      },
      stderr: (text) => {
        stderr.push(text)
      },
    })
    await serve([
      rule({ path: '/user' }, { status: 401, text: 'Unauthorized' }),
      rule({ path: '/user' }, { status: 200, body: { login: 'u' } }),
    ])
    await new GitHubClientBase({ diagnostics: output, token: 'env_old_token' }).getAuthenticatedUser()
    expect(stderr.join('')).toBe('warning: the token in the environment variable is invalid (401 Unauthorized); fell back to gh auth token\n  update or remove the token in .env\n')
  })

  it('切り替えは 1 回だけ。再試行も 401 なら、そのまま 401 を返し、以後 gh は呼ばない', async () => {
    await explains('401 の応答のテストです。切り替えは 1 回だけであり、再試行も 401 の場合に、そのまま 401 を返し、以後 `gh` を呼び出さないことを確認します。')
    useProject()
    const bin = useFakeGh('gh_new_token')
    const recorded = recordDiagnostics()
    const server = await serve([rule({ path: '/user' }, { status: 401, text: 'Unauthorized' }, 3)])
    const client = new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'env_old_token' })
    const first = await client.restRequest('GET', '/user')
    const second = await client.restRequest('GET', '/user')
    expect([first.statusCode, second.statusCode]).toEqual([401, 401])
    expect(server.requests()).toHaveLength(3)
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
    expect(recorded.lines).toEqual([`warning: ${FALLBACK_WARNING}`])
  })

  it('gh のトークンが現在のトークンと同じ場合は、再試行せず、警告も出力しない', async () => {
    await explains('401 の応答のテストです。`gh` のトークンが現在のトークンと同じ場合に、再試行せず、警告も出力しないことを確認します。')
    useProject()
    const bin = useFakeGh('same_token')
    const recorded = recordDiagnostics()
    const server = await serve([rule({ path: '/user' }, { status: 401, text: 'Unauthorized' })])
    const response = await new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'same_token' }).restRequest('GET', '/user')
    expect(response.statusCode).toBe(401)
    expect(server.requests()).toHaveLength(1)
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
    expect(recorded.lines).toEqual([])
  })

  it('gh が使えない場合は、再試行せず、.env を作成せずに 401 を返す', async () => {
    await explains('401 の応答のテストです。`gh` が使えない場合に、再試行せず、`.env` を作成せずに 401 を返すことを確認します。')
    const { config } = useProject()
    useFakeGh()
    const recorded = recordDiagnostics()
    const server = await serve([rule({ path: '/user' }, { status: 401, text: 'Unauthorized' })])
    const response = await new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'old' }).restRequest('GET', '/user')
    expect(response.statusCode).toBe(401)
    expect(server.requests()).toHaveLength(1)
    expect(existsSync(path.join(config, '.env'))).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('GraphQL: 401 のあと gh のトークンで成功する', async () => {
    await explains('401 の応答のテストです。GraphQL の要求が 401 の場合に、`gh` のトークンに切り替えて再試行し、成功することを確認します。')
    useProject()
    const bin = useFakeGh('gh_new_token')
    const recorded = recordDiagnostics()
    const server = await serve([
      rule({ operation: 'GetUserNodeId' }, { status: 401, text: 'Unauthorized' }),
      rule({ operation: 'GetUserNodeId' }, { status: 200, body: { data: { user: { id: 'U_1' } } } }),
    ])
    const client = new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'old' })
    expect(await client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).toEqual({ user: { id: 'U_1' } })
    expect(client.token).toBe('gh_new_token')
    expect(recorded.lines).toEqual([`warning: ${FALLBACK_WARNING}`])
    expect(readFakeCalls(bin, 'gh')).toEqual([['auth', 'token']])
    expect(server.requests()).toEqual([
      { type: 'graphql', operation: 'GetUserNodeId', variables: { login: 'x' }, auth: 'Bearer' },
      { type: 'graphql', operation: 'GetUserNodeId', variables: { login: 'x' }, auth: 'Bearer' },
    ])
  })

  it.each([
    ['401 のまま', { status: 401, text: 'nope' }, GitHubAuthError, `GraphQL authentication error: ${statusSentence('Client error', 401, 'Unauthorized')}`],
    ['500', { status: 500, text: 'boom' }, GitHubAPIError, `GraphQL query error: ${statusSentence('Server error', 500, 'Internal Server Error')}`],
    ['rate limit', { status: 200, body: { errors: [{ message: 'API rate limit exceeded' }] } }, GitHubRateLimitError, 'GraphQL rate limit error: {\'message\': \'API rate limit exceeded\'}'],
  ])('GraphQL: 再試行の失敗（%s）も同じ規則で分類する', async (_name, retry, errorClass, message) => {
    await explains('401 の応答のテストです。GraphQL の再試行が失敗した場合（401 のまま・500・レート制限）に、通常と同じ規則で例外に分類することを確認します。')
    useProject()
    useFakeGh('gh_new_token')
    const server = await serve([
      rule({ operation: 'GetUserNodeId' }, { status: 401, text: 'Unauthorized' }),
      rule({ operation: 'GetUserNodeId' }, retry),
    ])
    const failure = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 'old' }).executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })
    await expect(failure).rejects.toBeInstanceOf(errorClass)
    await expect(failure).rejects.toThrow(message.replace('{{GRAPHQL}}', () => `${server.url}/graphql`))
  })

  it('GraphQL: errors の文言に 401 があるだけの失敗では、gh に切り替えない', async () => {
    await explains('401 の応答のテストです。GraphQL の `errors` のメッセージに 401 を含むだけの失敗では、`gh` のトークンに切り替えないことを確認します。')
    useProject()
    const bin = useFakeGh('gh_new_token')
    const recorded = recordDiagnostics()
    await serve([rule({ operation: 'GetUserNodeId' }, { status: 200, body: { errors: [{ message: 'Could not resolve to an Issue with the number of 401', type: 'NOT_FOUND' }] } })])
    const client = new GitHubClientBase({ diagnostics: recorded.diagnostics, token: 'old' })
    await expect(client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).rejects.toMatchObject({ name: 'GitHubAPIError' })
    expect(client.token).toBe('old')
    expect(readFakeCalls(bin, 'gh')).toEqual([])
    expect(recorded.lines).toEqual([])
  })

  it('GraphQL: 切り替えられないとき（gh 失敗）は最初の失敗の文で認証エラーにする', async () => {
    await explains('401 の応答のテストです。GraphQL で `gh` のトークンへ切り替えられない場合は、最初の失敗のメッセージを持つ認証エラーが発生することを確認します。')
    useProject()
    useFakeGh()
    const server = await serve([rule({ operation: 'GetUserNodeId' }, { status: 401, text: 'Unauthorized' })])
    await expect(new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 'old' }).executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).rejects.toThrow(
      new GitHubAuthError(`GraphQL authentication error: ${statusSentence('Client error', 401, 'Unauthorized').replace('{{GRAPHQL}}', () => `${server.url}/graphql`)}`),
    )
  })
})

// 期待値は Python の _execute_graphql が投げた例外（クラスと文）。{{GRAPHQL}} は GraphQL の URL
interface GraphqlSuccess {
  readonly name: string
  readonly respond: ResponseSpec
  readonly data: JsonValue
}

interface GraphqlFailureCase {
  readonly name: string
  readonly respond: ResponseSpec
  readonly expected: { readonly error: typeof GitHubAPIError, readonly message: string }
}

const REDIRECT_LOCATION = 'Redirect location: \'/new\'\n'
const DOCS_URL = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/'

/**
httpx の raise_for_status の文（GraphQL の URL は {{GRAPHQL}}）。extra は Redirect location の行
*/
function statusSentence(label: string, code: number, reason: string, extra = ''): string {
  return `${label} '${String(code)} ${reason}' for url '{{GRAPHQL}}'\n${extra}For more information check: ${DOCS_URL}${String(code)}`
}

const GRAPHQL_SUCCESSES: readonly GraphqlSuccess[] = [
  { name: '成功', respond: { status: 200, text: '{"data":{"a":1}}' }, data: { a: 1 } },
  { name: 'data が list（空）なら空のオブジェクト', respond: { status: 200, text: '{"data":[]}' }, data: {} },
  { name: 'errors が空の list なら data を返す', respond: { status: 200, text: '{"errors":[],"data":{"k":"v"}}' }, data: { k: 'v' } },
  { name: 'errors が null なら data を返す', respond: { status: 200, text: '{"errors":null,"data":{"k":"v"}}' }, data: { k: 'v' } },
]

const NO_RESULT = 'GraphQL query error: Server did not return a GraphQL result: '
const GRAPHQL_FAILURES: readonly GraphqlFailureCase[] = [
  { name: 'data が null で errors が無い', respond: { status: 200, text: '{"data":null}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: Transport returned an ExecutionResult without data or errors' } },
  { name: '500 で JSON でない本文は httpx の状態の文', respond: { status: 500, text: 'boom' }, expected: { error: GitHubAPIError, message: `GraphQL query error: ${statusSentence('Server error', 500, 'Internal Server Error')}` } },
  { name: '502', respond: { status: 502, text: '' }, expected: { error: GitHubAPIError, message: `GraphQL query error: ${statusSentence('Server error', 502, 'Bad Gateway')}` } },
  { name: '401 で JSON でない本文は認証エラー（文言に 401）', respond: { status: 401, text: 'nope' }, expected: { error: GitHubAuthError, message: `GraphQL authentication error: ${statusSentence('Client error', 401, 'Unauthorized')}` } },
  { name: '404 で JSON だが data と errors が無い', respond: { status: 404, text: '{"message":"Not Found"}' }, expected: { error: GitHubAPIError, message: `GraphQL query error: ${statusSentence('Client error', 404, 'Not Found')}` } },
  { name: '301 は Location つき', respond: { status: 301, text: '', headers: { Location: '/new' } }, expected: { error: GitHubAPIError, message: `GraphQL query error: ${statusSentence('Redirect response', 301, 'Moved Permanently', REDIRECT_LOCATION)}` } },
  { name: '2xx で JSON でない', respond: { status: 200, text: 'hello' }, expected: { error: GitHubAPIError, message: `${NO_RESULT}Not a JSON answer: hello` } },
  { name: '2xx で本文が空', respond: { status: 200, text: '' }, expected: { error: GitHubAPIError, message: `${NO_RESULT}Not a JSON answer: ` } },
  { name: '2xx で JSON にキーが無い', respond: { status: 200, text: '{"x":1}' }, expected: { error: GitHubAPIError, message: `${NO_RESULT}No "data" or "errors" keys in answer: {"x":1}` } },
  { name: '2xx で JSON が配列', respond: { status: 200, text: '[1]' }, expected: { error: GitHubAPIError, message: `${NO_RESULT}No "data" or "errors" keys in answer: [1]` } },
  { name: '2xx で JSON が文字列', respond: { status: 200, text: '"abc"' }, expected: { error: GitHubAPIError, message: `${NO_RESULT}No "data" or "errors" keys in answer: "abc"` } },
  { name: '2xx で JSON が null', respond: { status: 200, text: 'null' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: argument of type \'NoneType\' is not a container or iterable' } },
  { name: '2xx で JSON が整数', respond: { status: 200, text: '5' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: argument of type \'int\' is not a container or iterable' } },
  { name: '500 でも errors があれば errors[0] の repr', respond: { status: 500, text: '{"errors":[{"message":"bad","type":"X"}]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'bad\', \'type\': \'X\'}' } },
  { name: 'errors に rate limit', respond: { status: 200, text: '{"errors":[{"message":"API rate limit exceeded","type":"RATE_LIMITED"}]}' }, expected: { error: GitHubRateLimitError, message: 'GraphQL rate limit error: {\'message\': \'API rate limit exceeded\', \'type\': \'RATE_LIMITED\'}' } },
  { name: 'errors の文言に 401 があっても、状態が 401 でなければ認証エラーにしない', respond: { status: 200, text: '{"errors":[{"message":"Issue 401 not found","type":"NOT_FOUND"}]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'Issue 401 not found\', \'type\': \'NOT_FOUND\'}' } },
  { name: 'errors の文言に Unauthorized があっても、種類が UNAUTHORIZED でなければ認証エラーにしない', respond: { status: 200, text: '{"errors":[{"message":"Unauthorized thing"}]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'Unauthorized thing\'}' } },
  { name: 'errors の type が UNAUTHORIZED なら認証エラー', respond: { status: 200, text: '{"errors":[{"message":"nope","type":"UNAUTHORIZED"}]}' }, expected: { error: GitHubAuthError, message: 'GraphQL authentication error: {\'message\': \'nope\', \'type\': \'UNAUTHORIZED\'}' } },
  { name: '429 はレート制限', respond: { status: 429, text: 'slow down' }, expected: { error: GitHubRateLimitError, message: `GraphQL rate limit error: ${statusSentence('Client error', 429, 'Too Many Requests')}` } },
  { name: '403 で errors に rate limit', respond: { status: 403, text: '{"errors":[{"message":"secondary rate limit"}]}' }, expected: { error: GitHubRateLimitError, message: 'GraphQL rate limit error: {\'message\': \'secondary rate limit\'}' } },
  { name: 'errors が文字列なら先頭の 1 文字', respond: { status: 200, text: '{"errors":"oops"}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: o' } },
  { name: 'errors がオブジェクトなら全体の repr（float・true・null も Python の書式）', respond: { status: 200, text: '{"errors":{"message":"x","n":1.5,"t":true,"z":null}}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'x\', \'n\': 1.5, \'t\': True, \'z\': None}' } },
  { name: 'errors の文字列の repr は引用符を切り替える', respond: { status: 200, text: '{"errors":[{"message":"it\'s \\"q\\""}]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'it\\\'s "q"\'}' } },
  { name: 'errors[0] が文字列ならそのまま', respond: { status: 200, text: '{"errors":["plain", "second"]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: plain' } },
  { name: 'errors の日本語と改行', respond: { status: 200, text: '{"errors":[{"message":"日本語\\n改行"}]}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: {\'message\': \'日本語\\n改行\'}' } },
  { name: 'errors が数', respond: { status: 200, text: '{"errors":5}' }, expected: { error: GitHubAPIError, message: 'GraphQL query error: 5' } },
]

function isUserPath(path: readonly JsonValue[]): boolean {
  return path[0] === 'user'
}

async function runTolerating(body: unknown): ReturnType<GitHubClientBase['executeGraphqlTolerating']> {
  await serve([rule({ operation: 'GetUserNodeId' }, { status: 200, body })])
  return new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).executeGraphqlTolerating(QUERY_GET_USER_NODE_ID, { login: 'x' }, isUserPath)
}

describe('executeGraphqlTolerating', () => {
  beforeEach(() => {
    useProject()
    useFakeGh()
  })

  it('すべての errors が許容する道筋の場合は、data と errors を返す', async () => {
    await explains('許容する道筋を指定した GraphQL の実行のテストです。すべての `errors` が許容する道筋の場合に、`data` と `errors` を返すことを確認します。')
    const errors = [{ message: 'a', path: ['user', 'id'] }, { message: 'b', path: ['user', 'x', 0] }]
    expect(await runTolerating({ data: { user: JSON_NULL }, errors })).toEqual({ data: { user: JSON_NULL }, errors })
  })

  it('errors が存在しない場合は、errors は空になる', async () => {
    await explains('許容する道筋を指定した GraphQL の実行のテストです。`errors` が存在しない場合に、`errors` を空の配列として返すことを確認します。')
    expect(await runTolerating({ data: { user: { id: 'U' } } })).toEqual({ data: { user: { id: 'U' } }, errors: [] })
  })

  it('許容しない道筋の errors が 1 つでもある場合は、executeGraphql と同じ例外が発生する', async () => {
    await explains('許容する道筋を指定した GraphQL の実行のテストです。許容しない道筋の `errors` が 1 つでもある場合に、`executeGraphql` と同じ例外が発生することを確認します。')
    const errors = [{ message: 'a', path: ['user', 'id'] }, { message: 'b', path: ['organization'] }]
    await expect(runTolerating({ data: { user: JSON_NULL }, errors })).rejects.toBeInstanceOf(GitHubAPIError)
  })

  it.each([
    ['path が無い', [{ message: 'a' }]],
    ['path が配列でない', [{ message: 'a', path: 'user' }]],
    ['errors の要素が辞書でない', ['a']],
  ])('%s の errors の場合は、例外が発生する', async (_name, errors) => {
    await explains('許容する道筋を指定した GraphQL の実行のテストです。`path` が存在しない場合、`path` が配列でない場合、`errors` の要素がオブジェクトでない場合に、例外が発生することを確認します。')
    await expect(runTolerating({ data: { user: JSON_NULL }, errors })).rejects.toBeInstanceOf(GitHubAPIError)
  })

  it('data が存在しない場合は、許容する道筋の errors でも例外が発生する', async () => {
    await explains('許容する道筋を指定した GraphQL の実行のテストです。`data` が存在しない場合に、許容する道筋の `errors` だけでも例外が発生することを確認します。')
    await expect(runTolerating({ errors: [{ message: 'a', path: ['user'] }] })).rejects.toBeInstanceOf(GitHubAPIError)
  })
})

describe('executeGraphql', () => {
  beforeEach(() => {
    // 401 を含む失敗が gh に切り替えようとしても、devcontainer の実際の gh を拾わない
    useProject()
    useFakeGh()
  })

  it.each(GRAPHQL_SUCCESSES)('$name のとき、data を返す', async ({ respond, data }) => {
    await explains('GraphQL の実行のテストです。成功の応答（`data` が空のリストの場合や、`errors` が空や `null` の場合を含む）に対して、`data` を返すことを確認します。')
    const server = await serve([rule({ operation: 'GetUserNodeId' }, respond)])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    expect(await client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).toEqual(data)
    expect(server.problems()).toEqual([])
  })

  it.each(GRAPHQL_FAILURES)('$name のとき、$expected.error.name が発生する', async ({ respond, expected }) => {
    await explains('GraphQL の実行のテストです。失敗の応答（状態コード・`errors`・本文の形ごとの失敗）を、Python と同じクラスとメッセージの例外に分類することを確認します。')
    const server = await serve([rule({ operation: 'GetUserNodeId' }, respond)])
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' })
    const execution = client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })
    await expect(execution).rejects.toBeInstanceOf(expected.error)
    await expect(execution).rejects.toMatchObject({ message: expected.message.replace('{{GRAPHQL}}', () => `${server.url}/graphql`) })
    expect(server.problems()).toEqual([])
  })

  it('変数を省略すると、空のオブジェクトを送信する', async () => {
    await explains('GraphQL の実行のテストです。変数を省略した場合に、空のオブジェクトを送信することを確認します。')
    const server = await serve([rule({ operation: 'GetUserNodeId' }, { status: 200, body: { data: { user: { id: 'U' } } } })])
    await new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).executeGraphql(QUERY_GET_USER_NODE_ID)
    expect(server.requests()).toEqual([{ type: 'graphql', operation: 'GetUserNodeId', variables: {}, auth: 'Bearer' }])
  })

  it('null の変数をそのまま送信する', async () => {
    await explains('GraphQL の実行のテストです。`null` の変数を、そのまま送信することを確認します。')
    const server = await serve([rule({ operation: 'GetUserNodeId' }, { status: 200, body: { data: { user: JSON_NULL } } })])
    const result = await new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).executeGraphql(QUERY_GET_USER_NODE_ID, { login: JSON_NULL })
    expect(result).toEqual({ user: JSON_NULL })
    expect(server.requests()).toEqual([{ type: 'graphql', operation: 'GetUserNodeId', variables: { login: JSON_NULL }, auth: 'Bearer' }])
  })

  it('GraphQL の要求は POST で、query と variables を JSON で送信する', async () => {
    await explains('GraphQL の実行のテストです。要求が POST で、`query` と `variables` を JSON で送信し、URL とヘッダが正しいことを確認します。')
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{}}')
    })
    setEnvironment({ PECOT_GITHUB_API_URL: `${raw.url}/api/v3/` })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, host: 'ghes.example.com', token: 'tok' })
    await client.executeGraphql('query { viewer { login } }', { a: 1 })
    expect(raw.requests).toHaveLength(1)
    const [request] = raw.requests
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/v3/graphql')
    expect(request?.headers).toMatchObject({ 'authorization': 'token tok', 'content-type': 'application/json', 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' })
    expect(request?.body).toBe('{"query":"query { viewer { login } }","variables":{"a":1}}')
  })

  it('接続できないときは Python と同じ文（[Errno 111] Connection refused）で GraphQLクエリ実行エラー', async () => {
    await explains('GraphQL の実行のテストです。接続できない場合に、Python と同じ文（`[Errno 111] Connection refused`）の GraphQL クエリ実行エラーが発生することを確認します。')
    const closed = await startFakeGithub([])
    await closed.close()
    setEnvironment({ PECOT_GITHUB_API_URL: closed.url })
    const execution = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't' }).executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })
    await expect(execution).rejects.toBeInstanceOf(GitHubAPIError)
    await expect(execution).rejects.toMatchObject({ message: 'GraphQL query error: [Errno 111] Connection refused' })
  })

  it('時間切れは Python と同じ文（timed out）で GraphQLクエリ実行エラー', async () => {
    await explains('GraphQL の実行のテストです。時間切れの場合に、Python と同じ文（`timed out`）の GraphQL クエリ実行エラーが発生することを確認します。')
    const raw = await startRawServer(() => {
      // 応答しない
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't', timeoutMilliseconds: 50 })
    await expect(client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).rejects.toMatchObject({ message: 'GraphQL query error: timed out' })
  })

  it('要求の応答を待つ間に取り消すと、GraphQL の失敗に包まず CancelledError を投げる', async () => {
    await explains('GraphQL の実行のテストです。応答を待つ間の取り消しでは、GraphQL の失敗に包まず `CancelledError` が発生することを確認します。')
    const raw = await startRawServer(() => {
      // 応答しない
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    const controller = new AbortController()
    const execution = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't', signal: controller.signal }).executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })
    await vi.waitFor(() => {
      expect(raw.requests).toHaveLength(1)
    })
    controller.abort('stopped by test')
    await expect(execution).rejects.toThrow(new CancelledError('stopped by test'))
  })

  it('時間切れは、signal を渡していても取り消しでなく timed out の失敗にする', async () => {
    await explains('GraphQL の実行のテストです。`signal` を渡していても、時間切れの場合は取り消しではなく `timed out` の失敗になることを確認します。')
    const raw = await startRawServer(() => {
      // 応答しない
    })
    setEnvironment({ PECOT_GITHUB_API_URL: raw.url })
    const client = new GitHubClientBase({ diagnostics: ignoredDiagnostics, token: 't', timeoutMilliseconds: 50, signal: new AbortController().signal })
    await expect(client.executeGraphql(QUERY_GET_USER_NODE_ID, { login: 'x' })).rejects.toMatchObject({ message: 'GraphQL query error: timed out' })
  })
})
