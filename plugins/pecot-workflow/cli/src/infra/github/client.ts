// GitHub API クライアントの基底（認証・REST と GraphQL の実行・エラー変換）。cli/core/github/client.py の移植。
// issues・pulls・projects・repos の操作はこの基底に足す。
//
// Python は httpx と gql で送っていた。ここでは fetch で送り、次の点を揃える。
// - redirect: 'manual' で呼ぶ。301 などは成功にせず、Python と同じ失敗にする。
// - URL は文字列の連結で作る。new URL は GHE の base（/api/v3）を落とす。
// - 失敗の文は httpx と gql の文言を写す。

import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { isJsonObject, parseJsonText } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { LinkedRepository } from '../../domain/config.js'
import { BaseError, InvalidValueError } from '../../domain/errors.js'
import type { JsonValue } from '../../domain/python-format.js'
import {
  formatHttpStatusError,
  isJsonArray,
  pythonRepr,
  pythonStrip,
  pythonTypeName,
  splitCodePoints,
} from '../../domain/python-format.js'
import { configDirectory } from '../config-store.js'
import type { Diagnostics } from '../diagnostics.js'
import { projectRoot } from '../paths.js'
import {
  ensureEnvironmentFile,
  environmentValue,
  getEnvironmentVariableName,
  loadEnvironmentFile,
  pythonString,
  ROOT_ENV_VAR_MAP,
  scopesFor,
  tokenUrlFor,
} from './auth.js'
import {
  GitHubAPIError,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from './errors.js'
import { asObject, isTruthy } from './payload.js'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])
const MAX_PORT = 65_535

// Python の TOKEN_FALLBACK_WARNING と同じ文。前置きと字下げを含まない
const TOKEN_FALLBACK_WARNING = 'the token in the environment variable is invalid (401 Unauthorized); fell back to gh auth token\n'
  + 'update or remove the token in .env'

function isControlOrSpace(character: string): boolean {
  return (character.codePointAt(0) ?? 0) <= 0x20
}

function trimTrailingSlashes(text: string): string {
  let end = text.length
  while (end > 0 && text.charAt(end - 1) === '/') end -= 1
  return text.slice(0, end)
}

/**
urlsplit(raw) の結果が、ループバックの http URL（query・fragment・userinfo なし）かを判定する。
host は new URL で正規化せず、元の文字列の authority で比べる。
そのため `127.1`・`0x7f.0.0.1` は拒否し、`HTTP://LOCALHOST:5` は受ける（urlsplit が scheme と host を小文字にする）。
空の query と fragment（クエリ記号やハッシュだけの末尾）は受ける
*/
function isLoopbackHttpUrl(raw: string): boolean {
  let start = 0
  while (start < raw.length && isControlOrSpace(raw.charAt(start))) start += 1
  const url = raw.slice(start).replaceAll(/[\t\n\r]/gu, '')
  const scheme = /^([A-Za-z][\d+.A-Za-z-]*):/u.exec(url)
  if (scheme?.[1]?.toLowerCase() !== 'http') return false
  const rest = url.slice(scheme[0].length)
  if (!rest.startsWith('//')) return false
  const afterSlashes = rest.slice(2)
  const delimiter = afterSlashes.search(/[#/?]/u)
  const netloc = delimiter === -1 ? afterSlashes : afterSlashes.slice(0, delimiter)
  const tail = delimiter === -1 ? '' : afterSlashes.slice(delimiter)
  const fragmentStart = tail.indexOf('#')
  const fragment = fragmentStart === -1 ? '' : tail.slice(fragmentStart + 1)
  const beforeFragment = fragmentStart === -1 ? tail : tail.slice(0, fragmentStart)
  const queryStart = beforeFragment.indexOf('?')
  const query = queryStart === -1 ? '' : beforeFragment.slice(queryStart + 1)
  // userinfo があるもの、IPv6 の角括弧があるものは、ループバックの 2 つのいずれでもない
  if (query !== '' || fragment !== '' || /[@[\]]/u.test(netloc)) return false
  const portStart = netloc.indexOf(':')
  const hostname = (portStart === -1 ? netloc : netloc.slice(0, portStart)).toLowerCase()
  if (!LOOPBACK_HOSTS.has(hostname)) return false
  if (portStart === -1) return true
  const port = netloc.slice(portStart + 1)
  return port === '' || (/^\d+$/u.test(port) && Number(port) <= MAX_PORT)
}

/**
PECOT_GITHUB_API_URL を検証して返す。未設定・空文字なら undefined。
前後比較のテストが GitHub の代わりに偽サーバへ向けるための差し替え口。
ループバックの http URL だけを受け付け、それ以外は InvalidValueError。末尾の `/` は落とす
*/
export function resolveApiUrlOverride(): string | undefined {
  const raw = process.env['PECOT_GITHUB_API_URL'] ?? ''
  if (raw === '') return undefined
  if (!isLoopbackHttpUrl(raw)) {
    throw new InvalidValueError(`PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: ${raw}`)
  }
  return trimTrailingSlashes(raw)
}

export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

/**
クエリの値。undefined は Python の None に当たり、`key=` と書く
*/
export type QueryValue = boolean | number | string | undefined

export interface RestRequestOptions {
  readonly params?: Readonly<Record<string, QueryValue>> | undefined
  /**
  JSON の本文
  */
  readonly json?: JsonValue | undefined
  /**
  X-GitHub-Api-Version の値。省略すると DEFAULT_API_VERSION
  */
  readonly apiVersion?: string | undefined
}

export const DEFAULT_API_VERSION = '2022-11-28'

/**
送信の失敗（接続できない・時間切れ）。Python の httpx の例外に当たり、PecotError ではない
*/
export class TransportFailure extends BaseError {}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

const SOCKET_FAILURES: ReadonlyMap<string, string> = new Map([
  ['ECONNREFUSED', '[Errno 111] Connection refused'],
  ['ECONNRESET', '[Errno 104] Connection reset by peer'],
  ['ENOTFOUND', '[Errno -2] Name or service not known'],
  ['EAI_AGAIN', '[Errno -3] Temporary failure in name resolution'],
])

/**
fetch の失敗の文。接続の失敗は errno の文、時間切れは httpx の ReadTimeout の文（timed out）にする。
それ以外は例外の文そのもの
*/
function describeTransportFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out'
  const cause = error instanceof Error ? error.cause : undefined
  const code = errorCode(cause) ?? errorCode(error)
  const known = code === undefined ? undefined : SOCKET_FAILURES.get(code)
  if (known !== undefined) return known
  if (cause instanceof Error) return cause.message
  return error instanceof Error ? error.message : String(error)
}

// urllib.parse.quote_plus と同じ。英数字と `_.-~` 以外は UTF-8 の %XX にし、空白は `+`
function quotePlus(text: string): string {
  let result = ''
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    const character = String.fromCodePoint(byte)
    if (/[\w.~-]/u.test(character)) result += character
    else if (byte === 0x20) result += '+'
    else result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return result
}

function queryValueText(value: QueryValue): string {
  if (value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

const ABSOLUTE_URL = /^[A-Za-z][\d+.A-Za-z-]*:\/\//u

function buildUrl(base: string, target: string, parameters: Readonly<Record<string, QueryValue>> | undefined): string {
  const url = ABSOLUTE_URL.test(target) ? target : `${base}/${target.replace(/^\/+/u, '')}`
  if (parameters === undefined) return url
  const query = Object.entries(parameters).map(([key, value]) => `${quotePlus(key)}=${quotePlus(queryValueText(value))}`).join('&')
  // params を指定すると、URL に書かれたクエリは置き換わる。空の params は URL のクエリを消す（httpx と同じ）
  const queryStart = url.indexOf('?')
  const withoutQuery = queryStart === -1 ? url : url.slice(0, queryStart)
  return query === '' ? withoutQuery : `${withoutQuery}?${query}`
}

export interface HeaderLink {
  readonly url: string
  readonly rel?: string | undefined
}

const LINK_STRIP = new Set([' ', '\'', '"'])

function stripCharacters(text: string, characters: ReadonlySet<string>): string {
  let start = 0
  let end = text.length
  while (start < end && characters.has(text.charAt(start))) start += 1
  while (end > start && characters.has(text.charAt(end - 1))) end -= 1
  return text.slice(start, end)
}

// `key=value;key=value` を読む。要素が `=` で 2 つに割れなければ、そこで打ち切る
function parseLinkParameters(text: string): ReadonlyMap<string, string> {
  const parameters = new Map<string, string>()
  for (const parameter of text.split(';')) {
    const pieces = parameter.split('=')
    if (pieces.length !== 2) return parameters
    parameters.set(stripCharacters(pieces[0] ?? '', LINK_STRIP), stripCharacters(pieces[1] ?? '', LINK_STRIP))
  }
  return parameters
}

/**
Link ヘッダを httpx の Response.links と同じ規則で読む。キーは rel、無ければ url
*/
function parseLinks(header = ''): ReadonlyMap<string, HeaderLink> {
  const links = new Map<string, HeaderLink>()
  const value = stripCharacters(header, LINK_STRIP)
  if (value === '') return links
  const urlStrip = new Set([...LINK_STRIP, '<', '>'])
  for (const part of value.split(/, *</u)) {
    const semicolon = part.indexOf(';')
    const url = stripCharacters(semicolon === -1 ? part : part.slice(0, semicolon), urlStrip)
    const relation = parseLinkParameters(semicolon === -1 ? '' : part.slice(semicolon + 1)).get('rel')
    links.set(relation === undefined || relation === '' ? url : relation, { url, rel: relation })
  }
  return links
}

/**
REST の応答。Python の httpx.Response のうち、呼び出し側が使う部分
*/
export class RestResponse {
  private readonly headers: ReadonlyMap<string, string>
  readonly statusCode: number
  readonly statusText: string
  readonly url: string
  readonly text: string

  constructor(init: Readonly<{ statusCode: number, statusText: string, url: string, text: string, headers: ReadonlyMap<string, string> }>) {
    this.statusCode = init.statusCode
    this.statusText = init.statusText
    this.url = init.url
    this.text = init.text
    this.headers = init.headers
  }

  /**
  状態コードが 2xx
  */
  get isSuccess(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300
  }

  /**
  ヘッダの値。名前は大文字小文字を区別しない
  */
  header(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())
  }

  /**
  Link ヘッダ。キーは rel（無ければ url）
  */
  get links(): ReadonlyMap<string, HeaderLink> {
    return parseLinks(this.header('link'))
  }

  /**
  本文を JSON として読む。不正なら InvalidValueError
  */
  json(): JsonValue {
    return parseJsonText(this.text)
  }
}

interface GraphqlFailureDetail {
  /**
  応答の状態コード。送信に失敗して応答が無いときは undefined
  */
  readonly statusCode?: number | undefined
  /**
  errors[0] の type（GitHub が付ける種類）
  */
  readonly errorType?: string | undefined
  readonly cause?: unknown
}

/**
gql の例外に当たる。分類には文ではなく、応答の状態コードと errors の type を使う
*/
class GraphqlFailure extends BaseError {
  readonly statusCode: number | undefined
  readonly errorType: string | undefined

  constructor(message: string, detail: Readonly<GraphqlFailureDetail> = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause })
    this.statusCode = detail.statusCode
    this.errorType = detail.errorType
  }
}

// errors[0] が辞書で type が文字列なら、その type
function firstErrorType(errors: JsonValue): string | undefined {
  const first = isJsonArray(errors) ? errors.at(0) : errors
  const type = isJsonObject(first) ? first['type'] : undefined
  return typeof type === 'string' ? type : undefined
}

// gql の str_first_element。list は先頭、str は先頭の 1 文字、dict などは全体
function firstErrorText(errors: JsonValue): string {
  if (isJsonArray(errors)) {
    const first = errors.at(0)
    return first === undefined ? '' : pythonString(first)
  }
  return pythonString(typeof errors === 'string' ? splitCodePoints(errors).slice(0, 1).join('') : errors)
}

/**
errors[].path（フィールドの道筋）を受けて、許す errors かを答える
*/
export type PathPredicate = (path: readonly JsonValue[]) => boolean

/**
executeGraphqlTolerating の結果。data と、許した errors
*/
export interface GraphqlOutcome {
  readonly data: JsonObject
  readonly errors: readonly JsonObject[]
}

// data があり、errors のすべてが道筋を持って isTolerated を満たすとき、その errors。それ以外は undefined
function toleratedErrors(errors: JsonValue | undefined, data: JsonValue | undefined, isTolerated: PathPredicate | undefined): readonly JsonObject[] | undefined {
  if (isTolerated === undefined || !isJsonObject(data) || !isJsonArray(errors) || errors.length === 0) return undefined
  const objects = errors.filter(error => isJsonObject(error))
  const areAllTolerated = objects.length === errors.length && objects.every((error) => {
    const path = error['path']
    return isJsonArray(path) && isTolerated(path)
  })
  return areAllTolerated ? objects : undefined
}

// 認証エラーの判定。文に 401 が入っていても（Issue 番号の 401 など）、認証エラーにはしない
function isUnauthorized(failure: Readonly<GraphqlFailure>): boolean {
  return failure.statusCode === 401 || failure.errorType === 'UNAUTHORIZED'
}

/**
レート制限の判定は、REST と GraphQL でこの 1 つを使う。
状態が 429、GitHub の種類が RATE_LIMITED、または文に rate limit を含むとき
*/
function isRateLimited(signal: Readonly<{ statusCode?: number | undefined, errorType?: string | undefined, text: string }>): boolean {
  return signal.statusCode === 429 || signal.errorType === 'RATE_LIMITED' || signal.text.toLowerCase().includes('rate limit')
}

function toGraphqlFailure(error: unknown): GraphqlFailure {
  if (error instanceof GraphqlFailure) return error
  return new GraphqlFailure(error instanceof Error ? error.message : pythonRepr(String(error)), { cause: error })
}

export interface GitHubClientOptions {
  /**
  GitHub のホスト。既定は github.com
  */
  readonly host?: string | undefined
  /**
  認証トークン。省略または空なら、config/.env・ルート .env・gh auth token の順で取る
  */
  readonly token?: string | undefined
  /**
  1 回の要求の時間切れ（ミリ秒）。既定は 30000
  */
  readonly timeoutMilliseconds?: number | undefined
  /**
  gh auth token の時間切れ（ミリ秒）。既定は 10000
  */
  readonly ghTimeoutMilliseconds?: number | undefined
  /**
  警告の受け口。トークンを切り替えたときの案内を渡す。省略できない（省くと警告が出ない）
  */
  readonly diagnostics: Diagnostics
}

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000
// gh auth token は手元の資格情報を読むだけで、ネットワークを使わない。
// OS のキーチェーンの解錠待ちを見込んで 10 秒にする。それ以上かかるなら、無応答として認証エラーに倒す
const DEFAULT_GH_TIMEOUT_MILLISECONDS = 10_000

/**
GitHub API クライアント（REST と GraphQL）。github.com と GHES に対応する。

トークンの優先順位は、token の指定、config/.env、ルート .env、gh auth token の順。
issues・pulls・projects・repos の操作は、次のメソッドを使って作る。
restJson・restObject・restRequest・handleHttpError・executeGraphql。
*/
export class GitHubClientBase {
  private readonly diagnostics: Diagnostics
  private usedFallback = false
  readonly host: string
  token: string
  readonly timeoutMilliseconds: number
  readonly ghTimeoutMilliseconds: number
  readonly apiUrl: string
  readonly graphqlUrl: string
  /**
  プロジェクトにリンクされたリポジトリの一覧のキャッシュ（`owner/projectNumber` がキー）
  */
  readonly linkedRepositoriesCache = new Map<string, readonly LinkedRepository[]>()

  constructor(options: Readonly<GitHubClientOptions>) {
    this.diagnostics = options.diagnostics
    this.host = options.host ?? 'github.com'
    this.ghTimeoutMilliseconds = options.ghTimeoutMilliseconds ?? DEFAULT_GH_TIMEOUT_MILLISECONDS
    this.token = options.token === undefined || options.token === '' ? this.resolveToken(this.host) : options.token
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
    const override = resolveApiUrlOverride()
    if (override !== undefined) {
      this.apiUrl = override
      this.graphqlUrl = `${override}/graphql`
    }
    else if (this.host === 'github.com') {
      this.apiUrl = 'https://api.github.com'
      this.graphqlUrl = 'https://api.github.com/graphql'
    }
    else {
      this.apiUrl = `https://${this.host}/api/v3`
      this.graphqlUrl = `https://${this.host}/api/graphql`
    }
  }

  // config/.env → ルート .env → gh auth token の順
  private resolveToken(host: string): string {
    return this.tokenFromEnvironment(host) ?? this.tokenFromGh(host)
  }

  private tokenFromEnvironment(host: string): string | undefined {
    loadEnvironmentFile(path.join(configDirectory(), '.env'))
    const token = environmentValue(getEnvironmentVariableName(host))
    if (token !== undefined && token !== '') return token

    loadEnvironmentFile(path.join(projectRoot(), '.env'))
    const rootName = ROOT_ENV_VAR_MAP.get(host)
    if (rootName === undefined) return undefined
    const rootToken = environmentValue(rootName)
    return rootToken === undefined || rootToken === '' ? undefined : rootToken
  }

  private tokenFromGh(host: string): string {
    const arguments_ = host === 'github.com' ? ['auth', 'token'] : ['auth', 'token', '-h', host]
    const result = spawnSync('gh', arguments_, { encoding: 'utf8', timeout: this.ghTimeoutMilliseconds })
    // gh が無い・時間切れ（error）、終了コードが 0 でない、または出力が空
    const token = result.error === undefined && result.status === 0 ? pythonStrip(result.stdout) : ''
    if (token.length === 0) throw new GitHubAuthError(this.authErrorMessage(host))
    return token
  }

  /**
  認証エラーの文を作る。.env が無ければ生成し、あるときはホストの変数が無ければ追記する
  */
  private authErrorMessage(host: string): string {
    const file = ensureEnvironmentFile(host)
    const scopes = scopesFor(host)
    const scopesLine = scopes.length > 0 ? `   required scopes: ${scopes.join(', ')}` : ''
    return `authentication error: could not get a GitHub API token

${file} was generated. Set the token as follows:

1. get a token: ${tokenUrlFor(host)}
${scopesLine}

2. edit ${file} and set the token in ${getEnvironmentVariableName(host)}

or authenticate with the GitHub CLI:
   gh auth login -h ${host}`
  }

  // github.com は Bearer、GHE Server は token（gh CLI 互換）
  private requestHeaders(apiVersion = DEFAULT_API_VERSION): Record<string, string> {
    return {
      'Authorization': `${this.host === 'github.com' ? 'Bearer' : 'token'} ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': apiVersion,
    }
  }

  /**
  env のトークンが失効したとき、gh auth token に 1 回だけ切り替える。切り替えたら true
  */
  private retryWithFallbackToken(): boolean {
    if (this.usedFallback) return false
    this.usedFallback = true
    let newToken: string
    try {
      newToken = this.tokenFromGh(this.host)
    }
    catch (error: unknown) {
      if (error instanceof GitHubAuthError) return false
      throw error
    }
    if (newToken === this.token) return false
    this.diagnostics.warning(TOKEN_FALLBACK_WARNING)
    this.token = newToken
    return true
  }

  private async send(method: HttpMethod, url: string, headers: Readonly<Record<string, string>>, body: string | undefined): Promise<RestResponse> {
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined && { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      })
      const text = await response.text()
      return new RestResponse({
        statusCode: response.status,
        statusText: response.statusText,
        url: response.url === '' ? url : response.url,
        text,
        headers: new Map(response.headers),
      })
    }
    catch (error: unknown) {
      throw new TransportFailure(describeTransportFailure(error), { cause: error })
    }
  }

  private async sendRest(method: HttpMethod, url: string, options: Readonly<RestRequestOptions>): Promise<RestResponse> {
    const { json } = options
    const base = this.requestHeaders(options.apiVersion)
    const headers = json === undefined ? base : { ...base, 'Content-Type': 'application/json' }
    return this.send(method, url, headers, json === undefined ? undefined : JSON.stringify(json))
  }

  // gql の HTTPXTransport.execute と同じ 4 つの失敗の文を作る。成功したら data と、許した errors
  private async sendGraphql(query: string, variables: Readonly<Record<string, JsonValue>>, isTolerated?: PathPredicate): Promise<GraphqlOutcome> {
    let response: RestResponse
    try {
      response = await this.send('POST', this.graphqlUrl, { ...this.requestHeaders(), 'Content-Type': 'application/json' }, JSON.stringify({ query, variables }))
    }
    catch (error: unknown) {
      throw new GraphqlFailure(error instanceof Error ? error.message : String(error), { cause: error })
    }
    const { statusCode } = response

    // JSON でない応答。2xx 以外は httpx の状態の文、2xx は gql の文
    const raiseResponseError = (reason: string): never => {
      if (!response.isSuccess) {
        throw new GraphqlFailure(formatHttpStatusError({
          statusCode: response.statusCode,
          statusText: response.statusText,
          url: response.url,
          location: response.header('location'),
        }), { statusCode })
      }
      throw new GraphqlFailure(`Server did not return a GraphQL result: ${reason}: ${response.text}`, { statusCode })
    }

    let result: JsonValue
    try {
      result = response.json()
    }
    catch {
      return raiseResponseError('Not a JSON answer')
    }

    // "errors" not in result and "data" not in result。オブジェクトはキーの有無、配列と文字列は「含まない」とみなす
    if (result === null || typeof result === 'number' || typeof result === 'boolean') {
      throw new GraphqlFailure(`argument of type '${pythonTypeName(result)}' is not a container or iterable`, { statusCode })
    }
    const object = isJsonObject(result) ? result : {}
    if (!Object.hasOwn(object, 'errors') && !Object.hasOwn(object, 'data')) {
      return raiseResponseError('No "data" or "errors" keys in answer')
    }

    // errors は status を問わず先頭の要素の文になる。許す errors（isTolerated）だけで data もあるときは、data と一緒に返す
    const errors = object['errors']
    const data = object['data']
    const tolerated = toleratedErrors(errors, data, isTolerated)
    if (tolerated === undefined && errors !== undefined && isTruthy(errors)) throw new GraphqlFailure(firstErrorText(errors), { statusCode, errorType: firstErrorType(errors) })

    if (data === undefined || data === null) throw new GraphqlFailure('Transport returned an ExecutionResult without data or errors', { statusCode })
    return { data: isJsonObject(data) ? data : {}, errors: tolerated ?? [] }
  }

  private classifyGraphqlFailure(failure: Readonly<GraphqlFailure>): GitHubAPIError {
    const { message } = failure
    const detail = { cause: failure }
    if (isUnauthorized(failure)) return new GitHubAuthError(`GraphQL authentication error: ${message}`, detail)
    if (isRateLimited({ statusCode: failure.statusCode, errorType: failure.errorType, text: message })) {
      return new GitHubRateLimitError(`GraphQL rate limit error: ${message}`, detail)
    }
    return new GitHubAPIError(`GraphQL query error: ${message}`, detail)
  }

  private async runGraphql(query: string, variables: Readonly<Record<string, JsonValue>>, isTolerated?: PathPredicate): Promise<GraphqlOutcome> {
    try {
      return await this.sendGraphql(query, variables, isTolerated)
    }
    catch (error: unknown) {
      const failure = toGraphqlFailure(error)
      if (!isUnauthorized(failure)) throw this.classifyGraphqlFailure(failure)
      if (!this.retryWithFallbackToken()) throw new GitHubAuthError(`GraphQL authentication error: ${failure.message}`, { cause: failure })
      try {
        return await this.sendGraphql(query, variables, isTolerated)
      }
      catch (retryError: unknown) {
        throw this.classifyGraphqlFailure(toGraphqlFailure(retryError))
      }
    }
  }

  // 絶対 URL（Link ヘッダの next など）は、API と同じ origin だけを辿る。
  // 別のホストへ Authorization を付けて送らないため
  private assertSameOrigin(target: string): void {
    if (!ABSOLUTE_URL.test(target)) return
    if (URL.canParse(target) && new URL(target).origin === new URL(this.apiUrl).origin) return
    throw new GitHubAPIError(`refusing to follow a URL on a different host than the API: ${target}`)
  }

  /**
  REST の要求（401 のときは gh auth token に切り替えて 1 回だけ再試行する）。
  target は `/user` のようなパス（base の後ろにつなぐ）か、`https://` で始まる絶対 URL（Link ヘッダの next など）。
  失敗の状態コードは例外にせず、そのまま返す。呼び出し側が isSuccess を見て handleHttpError に渡す
  */
  async restRequest(method: HttpMethod, target: string, options: Readonly<RestRequestOptions> = {}): Promise<RestResponse> {
    this.assertSameOrigin(target)
    const url = buildUrl(this.apiUrl, target, options.params)
    const response = await this.sendRest(method, url, options)
    return response.statusCode === 401 && this.retryWithFallbackToken() ? this.sendRest(method, url, options) : response
  }

  /**
  REST の要求を送り、成功した応答の JSON を返す。失敗の応答は handleHttpError の例外にする。
  本文が無い応答（204 など）には使わない
  */
  async restJson(method: HttpMethod, target: string, options: Readonly<RestRequestOptions> = {}): Promise<JsonValue> {
    const response = await this.restRequest(method, target, options)
    if (!response.isSuccess) this.handleHttpError(response)
    return response.json()
  }

  /**
  restJson の結果をオブジェクトとして返す（オブジェクトでなければ空のオブジェクト。Python の as_dict と同じ）
  */
  async restObject(method: HttpMethod, target: string, options: Readonly<RestRequestOptions> = {}): Promise<JsonObject> {
    return asObject(await this.restJson(method, target, options))
  }

  /**
  HTTP エラーの応答を、状態コード別の例外にして投げる
  */
  handleHttpError(response: RestResponse): never {
    const detail = { statusCode: response.statusCode, responseBody: response.text }
    if (response.statusCode === 401) {
      throw new GitHubAuthError('authentication failed: check the token', detail)
    }
    if (response.statusCode === 404) {
      throw new GitHubNotFoundError(`resource not found: ${response.url}`, detail)
    }
    if (response.statusCode === 429 || (response.statusCode === 403 && isRateLimited({ statusCode: 403, text: response.text }))) {
      throw new GitHubRateLimitError('API rate limit reached', detail)
    }
    if (response.statusCode === 403) {
      throw new GitHubAPIError('access denied', detail)
    }
    throw new GitHubAPIError(`GitHub API error: ${String(response.statusCode)}`, detail)
  }

  /**
  GraphQL を実行する。失敗は応答の状態コードと errors の type で分類する。
  状態が 401（または type が UNAUTHORIZED）は GitHubAuthError。gh auth token に 1 回切り替えて再試行する。
  レート制限は GitHubRateLimitError、それ以外は GitHubAPIError
  */
  async executeGraphql(query: string, variables: Readonly<Record<string, JsonValue>> = {}): Promise<JsonObject> {
    const { data } = await this.runGraphql(query, variables)
    return data
  }

  /**
  executeGraphql の、部分エラーを許す版。data があり、errors のすべてが isTolerated を満たすとき、例外にせず data と errors を返す。
  それ以外の errors は executeGraphql と同じ例外になる
  */
  async executeGraphqlTolerating(query: string, variables: Readonly<Record<string, JsonValue>>, isTolerated: PathPredicate): Promise<GraphqlOutcome> {
    return this.runGraphql(query, variables, isTolerated)
  }

  /**
  認証ユーザーの情報（login・id・name・email など）
  */
  async getAuthenticatedUser(): Promise<JsonValue> {
    return this.restJson('GET', '/user')
  }
}
