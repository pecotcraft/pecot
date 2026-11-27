// github-ops の action の、どの operation にも共通の振る舞い（結果の行・入力の誤り・GitHub の失敗）を確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { explains } from '../../_helpers/explains.js'
import { verifies } from '../../_helpers/verifies.js'
import { restRule } from '../../_helpers/github-rules.js'
import { runOperation } from '../../_helpers/github-ops-case.js'

useIsolatedEnvironment()

const REPOSITORY_RESPONSE = { default_branch: 'main', delete_branch_on_merge: true, owner: { type: 'Organization' } }

describe('github ops', () => {
  it('operation と params を渡したとき、request_id・ok・result を入れた PECOT_RESULT の行を 1 つ出し、0 を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-01')
    await explains('`github-ops` の action の、成功したときの結果の行のテストです。`repo-settings` を呼び、`PECOT_RESULT` の行に operation・request_id・`ok: true`・result が入ることを確認します。')
    const result = await runOperation('repo-settings', {}, [restRule('GET', '/repos/acme/demo', 200, REPOSITORY_RESPONSE)], { requestId: 'cuj-1' })
    expect(result.code).toBe(0)
    expect(result.line).toEqual({ operation: 'repo-settings', request_id: 'cuj-1', ok: true, result: { delete_branch_on_merge: true, default_branch: 'main', owner_type: 'Organization' } })
  })

  it.for([
    { name: '一覧に無い operation', operation: 'merge-async', rawParams: '{}', message: /^unknown operation: merge-async/u },
    { name: 'JSON でない params', operation: 'repo-settings', rawParams: '{"issue":', message: /^params is not JSON$/u },
    { name: '形の合わない params', operation: 'link-branch', rawParams: '{"issue":"abc","branch":"x"}', message: /^invalid params for link-branch/u },
    { name: '知らない鍵のある params', operation: 'repo-settings', rawParams: '{"extra":1}', message: /^invalid params for repo-settings/u },
  ])('$name を渡すと、GitHub を呼ばずに ok: false・invalid-input の行を出し、step を失敗にする', async ({ operation, rawParams, message }, context) => {
    await verifies(context, 'PA-GITHUB-OPS-02')
    await explains('`github-ops` の action の、入力の誤りのテストです。operation か params が誤っているとき、GitHub へ要求を送らずに、`invalid-input` の結果の行を出して失敗することを確認します。')
    const result = await runOperation(operation, undefined, [], { rawParams })
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ operation, request_id: 'req-1', ok: false, error: { kind: 'invalid-input' } })
    expect(result.message).toMatch(message)
    expect(result.github.requests()).toEqual([])
  })

  it('空の params は {} として読む', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-02')
    await explains('`github-ops` の action の、params の既定のテストです。params が空の文字列のとき、`{}` として読み、params の要らない operation が動くことを確認します。')
    const result = await runOperation('repo-settings', undefined, [restRule('GET', '/repos/acme/demo', 200, REPOSITORY_RESPONSE)], { rawParams: '' })
    expect(result.code).toBe(0)
    expect(result.line['ok']).toBe(true)
  })

  it('GITHUB_REPOSITORY が owner/repo でないと、GitHub を呼ばずに invalid-input の行を出す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-02')
    await explains('`github-ops` の action の、ワークフローのリポが読めないときのテストです。`GITHUB_REPOSITORY` が `owner/repo` の形でないとき、`invalid-input` の結果の行を出して失敗することを確認します。')
    const result = await runOperation('repo-settings', {}, [], { environment: { GITHUB_REPOSITORY: 'acme' } })
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'invalid-input', message: 'GITHUB_REPOSITORY is not owner/repo' } })
  })

  it('GitHub が 403 で断ると、ok: false と GitHub の文を入れた行を出し、step を失敗にする', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-03')
    await explains('`github-ops` の action の、GitHub が断ったときのテストです。REST が 403 を返したとき、`ok: false` と失敗の種類と GitHub の文を入れた結果の行を出し、失敗することを確認します。')
    const result = await runOperation('repo-settings', {}, [restRule('GET', '/repos/acme/demo', 403, { message: 'Resource not accessible by integration' })])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-api' } })
    expect(result.message).toContain('Resource not accessible by integration')
    expect(result.stderr).toContain('error: ')
  })

  it('GitHub への接続が切れると、ok: false・github-api の行を出す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-03')
    await explains('`github-ops` の action の、接続の失敗のテストです。GitHub が応答を返さずに接続を切ったとき、`github-api` の結果の行を出して失敗することを確認します。')
    const result = await runOperation('repo-settings', {}, [{ match: { method: 'GET', path: '/repos/acme/demo' }, respond: { status: 200, disconnect: true }, times: 1 }])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-api' } })
  })

  it('結果の行と標準エラーに、token の値を書かない', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-15')
    await explains('`github-ops` の action の、token の扱いのテストです。失敗したときも、結果の行と標準エラーに token の値が出ないことを確認します。')
    const result = await runOperation('repo-settings', {}, [restRule('GET', '/repos/acme/demo', 401, { message: 'Bad credentials' })])
    expect(`${result.stdout}${result.stderr}`).not.toContain('dummy-token')
  })
})
