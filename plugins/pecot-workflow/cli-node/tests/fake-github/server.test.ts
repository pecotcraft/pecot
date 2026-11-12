import { Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as queries from '../../src/infra/github/queries.js'
import { OPERATION_NAMES, operationNameOf, operationTable } from './operations.js'
import type { FakeGithub, ResponseRule, StartOptions } from './server.js'
import { isAvoidedPort, isSubset, MAX_LISTEN_ATTEMPTS, startFakeGithub } from './server.js'

const running: FakeGithub[] = []

async function start(rules: readonly ResponseRule[], options?: StartOptions): Promise<FakeGithub> {
  const server = await startFakeGithub(rules, options)
  running.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

function rule(match: ResponseRule['match'], status: number, body: unknown, times = 1): ResponseRule {
  return { match, respond: { status, body }, times }
}

const ISSUE_QUERY = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { id title } } }'

async function get(server: FakeGithub, pathname: string): Promise<Response> {
  return await fetch(`${server.url}${pathname}`)
}

async function post(server: FakeGithub, pathname: string, body: unknown): Promise<Response> {
  return await fetch(`${server.url}${pathname}`, {
    method: 'POST',
    headers: { 'authorization': 'token secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('REST', () => {
  it('上から見て、まだ使っていない最初の一致を返し、times を使い切ったら次へ進む', async () => {
    const server = await start([
      rule({ method: 'GET', path: '/repos/a/b' }, 200, { n: 1 }, 2),
      rule({ method: 'GET', path: '/repos/a/b' }, 404, { n: 2 }),
    ])
    const statuses: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const response = await get(server, '/repos/a/b')
      statuses.push(response.status)
    }
    expect(statuses).toEqual([200, 200, 404])
    expect(server.unused()).toEqual([])
    expect(server.problems()).toEqual([])
  })

  it('メソッド・パス・キー順のクエリ・本文・Authorization の前置きを記録する', async () => {
    const server = await start([rule({ method: 'POST', path: '/repos/a/b/issues' }, 201, { number: 3 })])
    const response = await post(server, '/repos/a/b/issues?z=1&a=2', { title: 't' })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ number: 3 })
    expect(server.requests()).toEqual([
      { type: 'rest', method: 'POST', path: '/repos/a/b/issues', query: { a: '2', z: '1' }, body: { title: 't' }, auth: 'token' },
    ])
  })

  it('query と body の部分一致で応答を選ぶ', async () => {
    const server = await start([
      rule({ method: 'GET', path: '/p', query: { page: '2' } }, 200, { page: 2 }),
      rule({ method: 'POST', path: '/p', body: { title: 't' } }, 200, { ok: true }),
    ])
    const paged = await get(server, '/p?page=2&x=1')
    expect(await paged.json()).toEqual({ page: 2 })
    const created = await post(server, '/p', { title: 't', extra: 1 })
    expect(created.status).toBe(200)
  })

  it('どの応答にも当たらない要求は 500 を返し、誤りとして残す', async () => {
    const server = await start([])
    const response = await get(server, '/nothing')
    expect(response.status).toBe(500)
    expect(server.problems()).toEqual(['どの応答にも当たらない要求を受けました: GET /nothing'])
    expect(server.requests()).toHaveLength(1)
  })

  it('使われなかった応答を unused に返す', async () => {
    const server = await start([rule({ method: 'GET', path: '/a' }, 200, {}), rule({ method: 'GET', path: '/b' }, 200, {}, 2)])
    await get(server, '/b')
    expect(server.unused()).toHaveLength(2)
    expect(server.unused()[0]).toContain('#1')
    expect(server.unused()[1]).toContain('#2')
  })

  it('応答の本文とヘッダの {{GITHUB_API}} を自分の URL に戻す。text は本文より優先する', async () => {
    const server = await start([
      { match: { method: 'GET', path: '/a' }, respond: { status: 200, body: { next: '{{GITHUB_API}}/a?page=2' }, headers: { link: '<{{GITHUB_API}}/a?page=2>; rel="next"' } }, times: 1 },
      { match: { method: 'GET', path: '/t' }, respond: { status: 200, body: { ignored: true }, text: 'plain {{GITHUB_API}}' }, times: 1 },
    ])
    const first = await get(server, '/a')
    expect(first.headers.get('link')).toBe(`<${server.url}/a?page=2>; rel="next"`)
    expect(await first.json()).toEqual({ next: `${server.url}/a?page=2` })
    const second = await get(server, '/t')
    expect(await second.text()).toBe(`plain ${server.url}`)
  })
})

describe('GraphQL', () => {
  it('無名の query は構造から operation 名を引き、名前と変数を記録する', async () => {
    const server = await start([rule({ operation: 'GetIssueNodeId', variables: { number: 1 } }, 200, { data: {} })])
    const response = await post(server, '/graphql', { query: ISSUE_QUERY, variables: { owner: 'a', repo: 'b', number: 1 } })
    expect(response.status).toBe(200)
    expect(server.requests()).toEqual([
      { type: 'graphql', operation: 'GetIssueNodeId', variables: { owner: 'a', repo: 'b', number: 1 }, auth: 'token' },
    ])
    expect(server.problems()).toEqual([])
  })

  it('名前を持つ operation は query の名前を使う', async () => {
    const server = await start([rule({ operation: 'CreateLinkedBranch' }, 200, { data: {} })])
    const query = 'mutation CreateLinkedBranch($input: CreateLinkedBranchInput!) { createLinkedBranch(input: $input) { linkedBranch { ref { name prefix } } } }'
    const response = await post(server, '/graphql', { query, variables: {} })
    expect(response.status).toBe(200)
    expect(server.unused()).toEqual([])
  })

  it('表に無い operation は誤りとして残し、500 を返す', async () => {
    const server = await start([])
    const response = await post(server, '/graphql', { query: '{ viewer { login } }', variables: {} })
    expect(response.status).toBe(500)
    expect(server.problems()[0]).toContain('対応表に無い GraphQL の operation')
  })

  it('operation が違えば当たらない', async () => {
    const server = await start([rule({ operation: 'GetRepositoryId' }, 200, {})])
    await post(server, '/graphql', { query: ISSUE_QUERY, variables: {} })
    expect(server.problems()).toEqual(['どの応答にも当たらない要求を受けました: GraphQL GetIssueNodeId'])
    expect(server.unused()).toHaveLength(1)
  })
})

describe('ポートの選び方', () => {
  it('401 を含むポートか判定する', () => {
    expect(isAvoidedPort(40_199)).toBe(true)
    expect(isAvoidedPort(14_010)).toBe(true)
    expect(isAvoidedPort(40_299)).toBe(false)
  })

  it('401 を含むポートを得たら選び直す。偽の listen は bind しない', async () => {
    const candidates = [40_199, 40_299]
    const server = await start([], { listen: () => Promise.resolve(candidates.shift() ?? 0) })
    expect(server.url).toBe('http://127.0.0.1:40299')
    expect(candidates).toEqual([])
  })

  it('実際の listen で起動でき、選ばれたポートは 401 を含まない', async () => {
    const server = await start([])
    const response = await get(server, '/x')
    expect(response.status).toBe(500)
    expect(new URL(server.url).port).not.toContain('401')
  })

  it('上限まで 401 を含むポートしか得られなければ、理由付きで失敗する', async () => {
    let calls = 0
    const listen = (): Promise<number> => {
      calls += 1
      return Promise.resolve(40_100)
    }
    await expect(startFakeGithub([], { listen })).rejects.toThrow('401 を含まないポート')
    expect(calls).toBe(MAX_LISTEN_ATTEMPTS)
  })
})

describe('異常時', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('応答の組み立てで例外が起きても 500 を返し、誤りに残す', async () => {
    const server = await start([rule({ path: '/x' }, 200, { value: 1n })])
    const response = await get(server, '/x')
    expect(response.status).toBe(500)
    expect(server.problems()[0]).toContain('偽サーバの内部エラー')
  })

  it('アドレスが取れなければ server を閉じて失敗する', async () => {
    vi.spyOn(Server.prototype, 'address').mockReturnValue('pipe')
    const close = vi.spyOn(Server.prototype, 'close')
    await expect(startFakeGithub([])).rejects.toThrow('ポートを取得できません')
    expect(close).toHaveBeenCalled()
  })
})

describe('isSubset', () => {
  it('オブジェクトは含まれていればよく、配列は長さも含めて比べる', () => {
    expect(isSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true)
    expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true)
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false)
    expect(isSubset({ a: 1 }, {})).toBe(false)
    expect(isSubset([1, 2], [1, 2])).toBe(true)
    expect(isSubset([1], [1, 2])).toBe(false)
    expect(isSubset({ a: 1 }, [1])).toBe(false)
  })
})

describe('対応表', () => {
  it('識別子と名前のどちらにも重複が無い', () => {
    const table = operationTable()
    expect(new Set(table.map(([id]) => id)).size).toBe(table.length)
    expect(OPERATION_NAMES.size).toBe(table.length)
  })

  it('queries.ts の全定数が、表の名前に引ける', () => {
    const texts = Object.values(queries)
    expect(texts).toHaveLength(operationTable().length)
    expect(texts.map(query => operationNameOf(query)).filter(name => name === undefined)).toEqual([])
  })
})
