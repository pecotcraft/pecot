/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- node:http の型は readonly にできない */
// 偽の GitHub サーバ。127.0.0.1 の空きポートで待ち受け、シナリオの応答の列どおりに返す。
// REST は <URL><パス> で受ける。GraphQL は <URL>/graphql で受ける。
// この組み立ては、Python の PECOT_GITHUB_API_URL の処理と同じにする。
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import { compareStrings, isRecord } from '../parity/baseline.js'
import { operationNameOf } from './operations.js'

export const API_PLACEHOLDER = '{{GITHUB_API}}'

export interface ResponseMatch {
  readonly method?: string | undefined
  readonly path?: string | undefined
  readonly operation?: string | undefined
  /**
  クエリ文字列の部分一致
  */
  readonly query?: Readonly<Record<string, string>> | undefined
  /**
  GraphQL の変数の部分一致
  */
  readonly variables?: unknown
  /**
  REST の本文の部分一致
  */
  readonly body?: unknown
}

export interface ResponseSpec {
  readonly status: number
  /**
  JSON にして返す値
  */
  readonly body?: unknown
  /**
  そのまま返す文字列。body より優先する
  */
  readonly text?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  /**
  true なら応答を返さずに接続を切る（通信の失敗を作る）
  */
  readonly drop?: boolean | undefined
}

export interface ResponseRule {
  readonly match: ResponseMatch
  readonly respond: ResponseSpec
  /**
  この応答を返せる回数。既定は 1
  */
  readonly times: number
}

export type RecordedRequest
  = | {
    readonly type: 'rest'
    readonly method: string
    readonly path: string
    readonly query: Readonly<Record<string, string>>
    readonly body?: unknown
    readonly auth: string
  }
  | {
    readonly type: 'graphql'
    readonly operation: string
    readonly variables: unknown
    readonly auth: string
  }

export interface FakeGithub {
  readonly url: string
  /**
  受けた要求の全部。受けた順
  */
  readonly requests: () => readonly RecordedRequest[]
  /**
  誤りの一覧: 表に無い operation、どの応答にも当たらない要求
  */
  readonly problems: () => readonly string[]
  /**
  使われなかった応答の説明
  */
  readonly unused: () => readonly string[]
  readonly close: () => Promise<void>
}

/**
expected の持つ値がすべて actual に含まれるか。配列は長さも含めて比べる
*/
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item: unknown, index) => isSubset(item, actual.at(index)))
  }
  if (isRecord(expected)) {
    return isRecord(actual)
      && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && isSubset(value, Reflect.get(actual, key)))
  }
  return expected === actual
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

function parseJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

// Python の cli/core/github/client.py は、GraphQL の例外の文言に "401" が含まれるかで認証エラーを決める。
// httpx の文言には URL が入るため、ポートの数字に 401 が入ると 502 でも認証エラーに分類される。
// 本物の GitHub の URL にはポートが入らないので、このポートは使わない。
// この回避は Python の判定に依存している。Node に移して判定が変われば要らなくなる。
export const AVOIDED_PORT_DIGITS = '401'
export const MAX_LISTEN_ATTEMPTS = 20

/**
避けるべきポートか
*/
export function isAvoidedPort(port: number): boolean {
  return String(port).includes(AVOIDED_PORT_DIGITS)
}

function listenOnce(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new TypeError('偽サーバのポートを取得できません'))
        return
      }
      resolve(address.port)
    })
  })
}

async function listenAvoiding(server: Server, listen: (server: Server) => Promise<number>): Promise<number> {
  for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt += 1) {
    const port = await listen(server)
    if (!isAvoidedPort(port)) return port
    // 差し込まれた listen が bind しない場合は、閉じる対象が無い
    if (!server.listening) continue
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  throw new Error(`${AVOIDED_PORT_DIGITS} を含まないポートを ${String(MAX_LISTEN_ATTEMPTS)} 回で選べませんでした`)
}

interface RuleState {
  readonly rule: ResponseRule
  readonly number: number
  used: number
}

function describeRule(state: RuleState): string {
  return `#${String(state.number)} ${JSON.stringify(state.rule.match)} (使った回数が times=${String(state.rule.times)} に届いていません)`
}

function substitute(text: string, baseUrl: string): string {
  return text.split(API_PLACEHOLDER).join(baseUrl)
}

export interface StartOptions {
  /**
  server を listen し、得たポートを返す。既定は OS が空きポートを選ぶ。テストが偽の関数を差し込む
  */
  readonly listen?: (server: Server) => Promise<number>
}

export async function startFakeGithub(rules: readonly ResponseRule[], options: StartOptions = {}): Promise<FakeGithub> {
  const states: RuleState[] = rules.map((rule, index) => ({ rule, number: index + 1, used: 0 }))
  const recorded: RecordedRequest[] = []
  const problems: string[] = []

  let baseUrl = ''

  function respond(response: ServerResponse, spec: ResponseSpec): void {
    if (spec.drop === true) {
      response.socket?.destroy()
      return
    }
    const headers = { 'content-type': 'application/json', ...spec.headers }
    const restored = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, substitute(value, baseUrl)]))
    const payload = spec.text ?? JSON.stringify(spec.body ?? {})
    response.writeHead(spec.status, restored)
    response.end(substitute(payload, baseUrl))
  }

  function select(candidate: {
    readonly method: string
    readonly path: string
    readonly operation: string | undefined
    readonly query: Readonly<Record<string, string>>
    readonly variables: unknown
    readonly body: unknown
  }): ResponseSpec | undefined {
    const state = states.find(({ rule, used }) => {
      const { match } = rule
      return used < rule.times
        && (match.method === undefined || match.method.toUpperCase() === candidate.method)
        && (match.path === undefined || match.path === candidate.path)
        && (match.operation === undefined || match.operation === candidate.operation)
        && (match.query === undefined || isSubset(match.query, candidate.query))
        && (match.variables === undefined || isSubset(match.variables, candidate.variables))
        && (match.body === undefined || isSubset(match.body, candidate.body))
    })
    if (state === undefined) return undefined
    state.used += 1
    return state.rule.respond
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const text = await readBody(request)
      const method = (request.method ?? 'GET').toUpperCase()
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const auth = (request.headers.authorization ?? '').split(' ', 1)[0] ?? ''
      const body = parseJson(text)
      const pairs = [...url.searchParams]
      const query = Object.fromEntries(pairs.toSorted(([a], [b]) => compareStrings(a, b)))

      let operation: string | undefined
      let variables: unknown
      const isGraphql = method === 'POST' && url.pathname === '/graphql'
      if (isGraphql) {
        const graphqlQuery = isRecord(body) ? body['query'] : undefined
        variables = isRecord(body) ? body['variables'] : undefined
        operation = typeof graphqlQuery === 'string' ? operationNameOf(graphqlQuery) : undefined
        if (operation === undefined) {
          problems.push(`対応表に無い GraphQL の operation を受けました: ${String(graphqlQuery)}`)
          recorded.push({ type: 'graphql', operation: '(unknown)', variables, auth })
          respond(response, { status: 500, body: { message: '対応表に無い operation' } })
          return
        }
        recorded.push({ type: 'graphql', operation, variables, auth })
      }
      else {
        recorded.push({ type: 'rest', method, path: url.pathname, query, ...(body !== undefined && { body }), auth })
      }

      const spec = select({ method, path: url.pathname, operation, query, variables, body })
      if (spec === undefined) {
        const label = isGraphql ? `GraphQL ${String(operation)}` : `${method} ${url.pathname}`
        problems.push(`どの応答にも当たらない要求を受けました: ${label}`)
        respond(response, { status: 500, body: { message: 'どの応答にも当たらない要求' } })
        return
      }
      respond(response, spec)
    })().catch((error: unknown) => {
      problems.push(`偽サーバの内部エラー: ${String(error)}`)
      if (response.headersSent) response.end()
      else response.writeHead(500).end()
    })
  })

  const port = await listenAvoiding(server, options.listen ?? listenOnce)
  baseUrl = `http://127.0.0.1:${String(port)}`

  return {
    url: baseUrl,
    requests: () => recorded,
    problems: () => problems,
    unused: () => states.filter(({ rule, used }) => used < rule.times).map(state => describeRule(state)),
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
      server.closeAllConnections()
    }),
  }
}
