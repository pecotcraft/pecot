import { Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as queries from '../../../src/infra/github/queries.js'
import { parseOperation } from './identify.js'
import { OPERATION_NAMES, operationNameOf, operationTable } from './operations.js'
import type { FakeGithub, ResponseRule, StartOptions } from './server.js'
import { isAvoidedPort, isSubset, MAX_LISTEN_ATTEMPTS, startFakeGithub } from './server.js'
import { explains } from '../explains.js'
import { step, stepSync } from '../step.js'

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
    await explains('偽の GitHub サーバのREST の応答の選び方のテストです。同じ条件のルールが複数ある場合に、`times` を使い切るまで上のルールで応じ、使い切ると次のルールで応じることを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([
      rule({ method: 'GET', path: '/repos/a/b' }, 200, { n: 1 }, 2),
      rule({ method: 'GET', path: '/repos/a/b' }, 404, { n: 2 }),
    ]))
    const statuses: number[] = []
    await step('偽サーバへ要求を送る', async () => {
      for (let index = 0; index < 3; index += 1) {
        const response = await get(server, '/repos/a/b')
        statuses.push(response.status)
      }
    })
    stepSync('結果を確認する', () => {
      expect(statuses).toEqual([200, 200, 404])
      expect(server.unused()).toEqual([])
      expect(server.problems()).toEqual([])
    })
  })

  it('REST の要求を受けると、メソッド・パス・キー順のクエリ・本文・Authorization の種別を記録する', async () => {
    await explains('偽の GitHub サーバの要求の記録のテストです。クエリ付きの POST を受けた場合に、メソッド・パス・クエリ（キー順）・本文と、`Authorization` ヘッダの種別（`token`）だけを記録することを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ method: 'POST', path: '/repos/a/b/issues' }, 201, { number: 3 })]))
    const response = await step('偽サーバへ要求を送る', async () => await post(server, '/repos/a/b/issues?z=1&a=2', { title: 't' }))
    await step('結果を確認する', async () => {
      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({ number: 3 })
      expect(server.requests()).toEqual([
        { type: 'rest', method: 'POST', path: '/repos/a/b/issues', query: { a: '2', z: '1' }, body: { title: 't' }, auth: 'token' },
      ])
    })
  })

  it('query と body は、ルールに指定した項目だけが一致すれば、応答を選ぶ', async () => {
    await explains('REST のルールの一致条件のテストです。ルールに指定したクエリや本文の項目が要求に含まれていれば、ほかの項目があっても、そのルールの応答を返すことを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([
      rule({ method: 'GET', path: '/p', query: { page: '2' } }, 200, { page: 2 }),
      rule({ method: 'POST', path: '/p', body: { title: 't' } }, 200, { ok: true }),
    ]))
    const paged = await step('偽サーバへ要求を送る', async () => await get(server, '/p?page=2&x=1'))
    await step('結果を確認する', async () => {
      expect(await paged.json()).toEqual({ page: 2 })
    })
    const created = await step('偽サーバへ要求を送る', async () => await post(server, '/p', { title: 't', extra: 1 }))
    stepSync('結果を確認する', () => {
      expect(created.status).toBe(200)
    })
  })

  it('どの応答にも当たらない要求を受けると、500 を返し、問題として記録する', async () => {
    await explains('偽の GitHub サーバのテストです。ルールに一致しない要求を受けた場合に、ステータス 500 を返し、その要求を問題の記録に残すことを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([]))
    const response = await step('偽サーバへ要求を送る', async () => await get(server, '/nothing'))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(500)
      expect(server.problems()).toEqual(['どの応答にも当たらない要求を受けました: GET /nothing'])
      expect(server.requests()).toHaveLength(1)
    })
  })

  it('使われなかったルールを、unused の一覧に返す', async () => {
    await explains('`unused` のテストです。使われていないルールと、`times` を使い切っていないルールの両方が、番号付きで一覧に含まれることを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ method: 'GET', path: '/a' }, 200, {}), rule({ method: 'GET', path: '/b' }, 200, {}, 2)]))
    await step('偽サーバへ要求を送る', async () => {
      await get(server, '/b')
    })
    stepSync('結果を確認する', () => {
      expect(server.unused()).toHaveLength(2)
      expect(server.unused()[0]).toContain('#1')
      expect(server.unused()[1]).toContain('#2')
    })
  })

  it('応答の本文とヘッダの {{GITHUB_API}} を、サーバ自身の URL に置き換える。text は本文より優先する', async () => {
    await explains('応答のプレースホルダのテストです。本文とヘッダの `{{GITHUB_API}}` がサーバ自身の URL に置き換わり、`text` を指定した場合は本文より優先して返されることを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([
      { match: { method: 'GET', path: '/a' }, respond: { status: 200, body: { next: '{{GITHUB_API}}/a?page=2' }, headers: { link: '<{{GITHUB_API}}/a?page=2>; rel="next"' } }, times: 1 },
      { match: { method: 'GET', path: '/t' }, respond: { status: 200, body: { ignored: true }, text: 'plain {{GITHUB_API}}' }, times: 1 },
    ]))
    const first = await step('偽サーバへ要求を送る', async () => await get(server, '/a'))
    await step('結果を確認する', async () => {
      expect(first.headers.get('link')).toBe(`<${server.url}/a?page=2>; rel="next"`)
      expect(await first.json()).toEqual({ next: `${server.url}/a?page=2` })
    })
    const second = await step('偽サーバへ要求を送る', async () => await get(server, '/t'))
    await step('結果を確認する', async () => {
      expect(await second.text()).toBe(`plain ${server.url}`)
    })
  })
})

describe('GraphQL', () => {
  it('名前のない query は、構造から operation 名を判定し、名前と変数を記録する', async () => {
    await explains('偽の GitHub サーバのGraphQL の判定のテストです。operation 名のない query を受けた場合に、構造から `GetIssueNodeId` と判定し、名前と変数を記録することを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ operation: 'GetIssueNodeId', variables: { number: 1 } }, 200, { data: {} })]))
    const response = await step('偽サーバへ要求を送る', async () => await post(server, '/graphql', { query: ISSUE_QUERY, variables: { owner: 'a', repo: 'b', number: 1 } }))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(200)
      expect(server.requests()).toEqual([
        { type: 'graphql', operation: 'GetIssueNodeId', variables: { owner: 'a', repo: 'b', number: 1 }, auth: 'token' },
      ])
      expect(server.problems()).toEqual([])
    })
  })

  it('名前のある operation は、query に書かれた名前を使う', async () => {
    await explains('GraphQL の判定のテストです。`mutation CreateLinkedBranch` のように名前のある operation は、その名前で応答のルールに一致することを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ operation: 'CreateLinkedBranch' }, 200, { data: {} })]))
    const query = 'mutation CreateLinkedBranch($input: CreateLinkedBranchInput!) { createLinkedBranch(input: $input) { linkedBranch { ref { name prefix } } } }'
    const response = await step('偽サーバへ要求を送る', async () => await post(server, '/graphql', { query, variables: {} }))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(200)
      expect(server.unused()).toEqual([])
    })
  })

  it('対応表に存在しない operation は、問題として記録し、500 を返す', async () => {
    await explains('GraphQL の判定のテストです。対応表に存在しない operation を受けた場合に、ステータス 500 を返し、問題として記録することを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([]))
    const response = await step('偽サーバへ要求を送る', async () => await post(server, '/graphql', { query: '{ viewer { login } }', variables: {} }))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(500)
      expect(server.problems()[0]).toContain('対応表に無い GraphQL の operation')
    })
  })

  it('operation が異なる場合は、ルールに一致しない', async () => {
    await explains('GraphQL の判定のテストです。ルールの operation と受けた operation が異なる場合に、一致しない要求として記録され、ルールが未使用のまま残ることを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ operation: 'GetRepositoryId' }, 200, {})]))
    await step('偽サーバへ要求を送る', async () => {
      await post(server, '/graphql', { query: ISSUE_QUERY, variables: {} })
    })
    stepSync('結果を確認する', () => {
      expect(server.problems()).toEqual(['どの応答にも当たらない要求を受けました: GraphQL GetIssueNodeId'])
      expect(server.unused()).toHaveLength(1)
    })
  })
})

describe('ポートの選び方', () => {
  it('401 を含むポートかどうかを判定する', async () => {
    await explains('`isAvoidedPort` のテストです。ポート番号に `401` を含む場合は `true`、含まない場合は `false` を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(isAvoidedPort(40_199)).toBe(true)
      expect(isAvoidedPort(14_010)).toBe(true)
      expect(isAvoidedPort(40_299)).toBe(false)
    })
  })

  it('401 を含むポートを得た場合は、次の候補のポートを選び直す', async () => {
    await explains('偽の `listen` を指定したテストです。最初に `401` を含むポート 40199 を得た場合に、40299 を選び直してサーバの URL に使うことを確認します。')
    const candidates = [40_199, 40_299]
    const server = await step('偽サーバとクライアントを用意する', async () => await start([], { listen: () => Promise.resolve(candidates.shift() ?? 0) }))
    stepSync('結果を確認する', () => {
      expect(server.url).toBe('http://127.0.0.1:40299')
      expect(candidates).toEqual([])
    })
  })

  it('実際の listen で起動でき、選ばれたポートは 401 を含まない', async () => {
    await explains('`startFakeGithub` の起動のテストです。実際に待ち受けを開始した場合に、サーバが要求に応答し、選ばれたポートに `401` が含まれないことを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([]))
    const response = await step('偽サーバへ要求を送る', async () => await get(server, '/x'))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(500)
      expect(new URL(server.url).port).not.toContain('401')
    })
  })

  it('上限まで 401 を含むポートしか得られない場合は、理由を示して失敗する', async () => {
    await explains('`startFakeGithub` のテストです。`401` を含むポートしか得られない場合に、上限の回数まで試行したうえで、理由を示す例外が発生することを確認します。')
    let calls = 0
    const listen = (): Promise<number> => {
      calls += 1
      return Promise.resolve(40_100)
    }
    await step('結果を確認する', async () => {
      await expect(startFakeGithub([], { listen })).rejects.toThrow('401 を含まないポート')
      expect(calls).toBe(MAX_LISTEN_ATTEMPTS)
    })
  })
})

describe('異常時', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('応答の組み立てで例外が発生しても、500 を返し、問題として記録する', async () => {
    await explains('偽の GitHub サーバの異常時のテストです。応答の本文に JSON へ変換できない値（`BigInt`）を指定した場合に、ステータス 500 を返し、内部エラーを問題として記録することを確認します。')
    const server = await step('偽サーバとクライアントを用意する', async () => await start([rule({ path: '/x' }, 200, { value: 1n })]))
    const response = await step('偽サーバへ要求を送る', async () => await get(server, '/x'))
    stepSync('結果を確認する', () => {
      expect(response.status).toBe(500)
      expect(server.problems()[0]).toContain('偽サーバの内部エラー')
    })
  })

  it('アドレスを取得できない場合は、server を閉じて失敗する', async () => {
    await explains('`startFakeGithub` の異常時のテストです。サーバのアドレスを取得できない場合に、サーバを閉じたうえで、ポートを取得できない旨の例外が発生することを確認します。')
    vi.spyOn(Server.prototype, 'address').mockReturnValue('pipe')
    const close = vi.spyOn(Server.prototype, 'close')
    await step('結果を確認する', async () => {
      await expect(startFakeGithub([])).rejects.toThrow('ポートを取得できません')
      expect(close).toHaveBeenCalled()
    })
  })
})

describe('isSubset', () => {
  it('オブジェクトは含まれていれば一致とし、配列は長さも含めて比較する', async () => {
    await explains('`isSubset` のテストです。オブジェクトは期待する項目が含まれていれば一致とし、配列は長さも含めて一致を判定することを確認します。')
    stepSync('結果を確認する', () => {
      expect(isSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true)
      expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true)
      expect(isSubset({ a: 1 }, { a: 2 })).toBe(false)
      expect(isSubset({ a: 1 }, {})).toBe(false)
      expect(isSubset([1, 2], [1, 2])).toBe(true)
      expect(isSubset([1], [1, 2])).toBe(false)
      expect(isSubset({ a: 1 }, [1])).toBe(false)
    })
  })
})

describe('対応表', () => {
  it('識別子と名前のどちらにも重複が存在しない', async () => {
    await explains('operation の対応表のテストです。識別子と名前のどちらも重複がなく、表の件数と一致することを確認します。')
    const table = operationTable()
    stepSync('結果を確認する', () => {
      expect(new Set(table.map(([id]) => id)).size).toBe(table.length)
      expect(OPERATION_NAMES.size).toBe(table.length)
    })
  })

  it('queries.ts の全定数は、対応表の名前に対応する', async () => {
    await explains('`queries.ts` の GraphQL の定数のテストです。すべての定数が対応表と同じ件数で、どの定数からも operation 名を取得できることを確認します。')
    const texts = Object.values(queries)
    stepSync('結果を確認する', () => {
      expect(texts).toHaveLength(operationTable().length)
      expect(texts.map(query => operationNameOf(query)).filter(name => name === undefined)).toEqual([])
    })
  })
})

function idOf(query: string): string {
  return parseOperation(query).id
}

describe('識別子（fragment）', () => {
  it('fragment の参照（...Name）は、定義の選択集合に展開する', async () => {
    await explains('`parseOperation` が作る識別子のテストです。`...A` のような fragment の参照が、定義の選択集合に展開されることを確認します。')
    const query = 'query ($n: Int!) { repository { issue(number: $n) { ...A id } } } fragment A on Issue { title body }'
    stepSync('結果を確認する', () => {
      expect(idOf(query)).toBe('repository.issue{title,body,id}|n')
    })
  })

  it('inline fragment の中の参照と、fragment の中の fragment も展開する', async () => {
    await explains('識別子のテストです。inline fragment の中の参照と、fragment の中で参照する別の fragment も、順に展開されることを確認します。')
    const query = 'query { node { ... on Issue { ...A } } } fragment A on Issue { ...B state } fragment B on Issue { title }'
    stepSync('結果を確認する', () => {
      expect(idOf(query)).toBe('node{title,state}|')
    })
  })

  it('子が 1 つだけの間は、fragment の中のフィールドも識別子のパスに含める', async () => {
    await explains('識別子のテストです。子が 1 つだけのフィールドが fragment の中にある場合も、`repository.issue` のようにパスに含まれることを確認します。')
    stepSync('結果を確認する', () => {
      expect(idOf('query { repository { ...A } } fragment A on Repository { issue { ...B } } fragment B on Issue { title body }')).toBe('repository.issue{title,body}|')
    })
  })

  it('定義のない fragment を参照すると、理由を示して失敗する', async () => {
    await explains('識別子のテストです。定義が存在しない fragment を参照した場合に、見つからない旨の例外が発生することを確認します。')
    stepSync('結果を確認する', () => {
      expect(() => idOf('query { repository { ...Missing } }')).toThrow('GraphQL の fragment Missing の定義が見つかりません')
    })
  })

  it('fragment が自分自身を参照しても、展開が止まる', async () => {
    await explains('識別子のテストです。fragment が自分自身を参照している場合でも、無限に展開せず、結果を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(idOf('query { node { ...A } } fragment A on Issue { title ...A }')).toBe('node{title}|')
    })
  })
})
