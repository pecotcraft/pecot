// 塊 D2 のテスト共通。偽の GitHub サーバを起動し、PECOT_GITHUB_API_URL をそこへ向けたクライアントを作る。
// 使い方（テストファイルの describe の外で 1 回呼ぶ）:
//   useFakeGithub()
//     env の隔離と、テスト後の後始末を登録する。
//     後始末は、サーバを閉じることと、誤りの無いこと・応答を使い切ったことの確認。
//   startClient(rules)
//     偽サーバとクライアントを作る。rules は graphqlData・graphqlError・restResponse で作る。
import { afterEach, expect } from 'vitest'

import { startFakeGithub } from '../../../../tests/fake-github/server.js'
import type { FakeGithub, RecordedRequest, ResponseRule, ResponseSpec } from '../../../../tests/fake-github/server.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { installFakeGh, prependToPath } from '../../../tests/_helpers/fake-executables.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { GitHubClient } from '../index.js'
import { recordDiagnostics } from '../../tests/recording-diagnostics.js'

const servers: FakeGithub[] = []

/**
env の隔離を登録し、各テストの後に偽サーバを閉じる。
サーバが受けた誤り（表に無い要求）と、使われなかった応答があれば、そのテストを失敗にする
*/
export function useFakeGithub(): void {
  useIsolatedEnvironment()
  afterEach(async () => {
    const opened = servers.splice(0)
    const problems = opened.flatMap(server => server.problems())
    const unused = opened.flatMap(server => server.unused())
    await Promise.all(opened.map(async server => server.close()))
    expect({ problems, unused }).toEqual({ problems: [], unused: [] })
  })
}

export interface StartedClient {
  readonly client: GitHubClient
  readonly server: FakeGithub
}

/**
偽サーバを起動して、そこへ向けたクライアントを返す。host は GHE にして Authorization の種類を確かめやすくする
*/
export async function startClient(rules: readonly ResponseRule[], host = 'github.com'): Promise<StartedClient> {
  const server = await startFakeGithub(rules)
  servers.push(server)
  // 401 の再試行は gh auth token を呼ぶ。本物の gh を起動しないよう、失敗する偽の gh を PATH の先頭に置く
  const bin = makeTemporaryDirectory()
  installFakeGh(bin)
  prependToPath(bin)
  setEnvironment({ PECOT_GITHUB_API_URL: server.url })
  return { client: new GitHubClient({ host, token: 'test_token', diagnostics: recordDiagnostics().diagnostics }), server }
}

/**
GraphQL の応答。data を 200 で返す
*/
export function graphqlData(operation: string, data: unknown, times = 1): ResponseRule {
  return { match: { operation }, respond: { status: 200, body: { data } }, times }
}

/**
GraphQL の errors を 200 で返す（GitHub の実際の失敗の返し方）
*/
export function graphqlError(operation: string, message: string, times = 1): ResponseRule {
  return { match: { operation }, respond: { status: 200, body: { errors: [{ message }] } }, times }
}

/**
REST の応答
*/
export function restResponse(method: string, path: string, respond: ResponseSpec, times = 1): ResponseRule {
  return { match: { method, path }, respond, times }
}

/**
サーバが受けた REST の要求
*/
export function restRequests(server: FakeGithub): readonly Extract<RecordedRequest, { type: 'rest' }>[] {
  return server.requests().filter(request => request.type === 'rest')
}

/**
サーバが受けた GraphQL の要求（operation と variables）
*/
export function graphqlRequests(server: FakeGithub): readonly { readonly operation: string, readonly variables: unknown }[] {
  return server.requests().filter(request => request.type === 'graphql').map(({ operation, variables }) => ({ operation, variables }))
}

type ErrorClass = new (message: string) => Error

/**
Promise が失敗したときの例外を返す。成功したら undefined
*/
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error: unknown) {
    return error
  }
  return undefined
}

/**
例外が指定のクラス（サブクラスは不可）・文言・属性であることを確かめる期待値。
rejection で取った例外を expect に渡し、toMatchObject の引数にこの値を渡す。
クラスは名前で比べる（PecotError は name にクラス名を入れる）
*/
export function failure(errorClass: ErrorClass, message: string, detail: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { name: errorClass.name, message, ...detail }
}
