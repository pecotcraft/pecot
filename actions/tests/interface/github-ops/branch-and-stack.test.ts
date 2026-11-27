// github-ops の link-branch と stack-register を確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../../_helpers/explains.js'
import { verifies } from '../../_helpers/verifies.js'
import { graphqlRule, requestLabels, restRule } from '../../_helpers/github-rules.js'
import { runOperation, SHA, writesOf } from '../../_helpers/github-ops-case.js'

useIsolatedEnvironment()

const issueNode = graphqlRule('GetIssueNodeId', { repository: { issue: { id: 'I_7', title: '見本の Issue' } } }, { owner: 'acme', repo: 'demo', number: 7 })
const linkedBranch = graphqlRule('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/x/7', prefix: 'refs/heads/' } } } })
const headOf = (branch: string): ResponseRule => restRule('GET', `/repos/acme/demo/git/ref/heads/${branch}`, 200, { object: { sha: SHA } })

const STACKS = '/repos/acme/demo/stacks'
const STACKS_VERSION = '2026-03-10'
const stack = (number: number, pullRequests: readonly number[]): Record<string, unknown> => ({ number, pull_requests: pullRequests.map(pr => ({ number: pr })) })
const stacksOf = (pr: number, body: readonly unknown[]): ResponseRule => ({ match: { method: 'GET', path: STACKS, query: { pull_request: String(pr) }, apiVersion: STACKS_VERSION }, respond: { status: 200, body }, times: 1 })

describe('github ops', () => {
  it('link-branch に base を省くと、既定のブランチの先頭から Issue につながったブランチを作り、作ったブランチと元を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-04')
    await explains('`link-branch` のテストです。`base` を省いた場合に、リポの既定のブランチの先頭から `createLinkedBranch` でブランチを作成し、ブランチ名・元のブランチ・commit を返すことを確認します。')
    const repository = restRule('GET', '/repos/acme/demo', 200, { default_branch: 'main', delete_branch_on_merge: true, owner: { type: 'Organization' } })
    const result = await runOperation('link-branch', { issue: 7, branch: 'feat/x/7' }, [repository, headOf('main'), issueNode, linkedBranch])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ issue: 7, branch: 'feat/x/7', base: 'main', sha: SHA })
    expect(result.github.requests().find(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')).toMatchObject({ variables: { input: { issueId: 'I_7', oid: SHA, name: 'feat/x/7' } } })
  })

  it('link-branch に base を渡すと、既定のブランチを読まずに base の先頭から作る', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-04')
    await explains('`link-branch` のテストです。`base` を指定した場合に、リポの設定を読まずに、指定したブランチの先頭から作成することを確認します。')
    const result = await runOperation('link-branch', { issue: 7, branch: 'feat/x/7', base: 'feat/parent/6' }, [headOf('feat/parent/6'), issueNode, linkedBranch])
    expect(result.code).toBe(0)
    expect(result.result).toMatchObject({ base: 'feat/parent/6' })
    expect(requestLabels(result.github.requests())).not.toContain('GET /repos/acme/demo')
  })

  it('link-branch で GitHub がブランチの作成を断ると、ok: false と GitHub の文を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-05')
    await explains('`link-branch` のテストです。同じ名前のブランチが既に存在し、GitHub が `createLinkedBranch` を断った場合に、`ok: false` と GitHub のエラー文を返すことを確認します。')
    const rejected: ResponseRule = { match: { operation: 'CreateLinkedBranch' }, respond: { status: 200, body: { errors: [{ type: 'UNPROCESSABLE', message: 'Ref already exists' }] } }, times: 1 }
    const result = await runOperation('link-branch', { issue: 7, branch: 'feat/x/7', base: 'main' }, [headOf('main'), issueNode, rejected])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false })
    expect(result.message).toContain('Ref already exists')
  })

  it.for([
    { name: '親がスタックに無い', rules: [stacksOf(20, []), stacksOf(21, []), { match: { method: 'POST', path: STACKS, body: { pull_requests: [20, 21] } }, respond: { status: 201, body: stack(5, [20, 21]) }, times: 1 }], expected: { change: 'created', number: 5, pull_requests: [20, 21] } },
    { name: '親がスタックの一番上', rules: [stacksOf(20, [stack(5, [19, 20])]), stacksOf(21, []), { match: { method: 'POST', path: `${STACKS}/5/add`, body: { pull_requests: [21] } }, respond: { status: 200, body: stack(5, [19, 20, 21]) }, times: 1 }], expected: { change: 'added', number: 5, pull_requests: [19, 20, 21] } },
  ])('stack-register で $name とき、子の PR をスタックへ登録し、登録後のスタックを返す', async ({ rules, expected }, context) => {
    await verifies(context, 'PA-GITHUB-OPS-06')
    await explains('`stack-register` のテストです。親の PR のスタックの有無に応じて、スタックを作成するか一番上に子の PR を追加し、登録後の PR の並びを返すことを確認します。')
    const result = await runOperation('stack-register', { pr: 21, parent_pr: 20 }, rules)
    expect(result.code).toBe(0)
    expect(result.result).toEqual(expected)
  })

  it('stack-register で子が既に親の直後にあると、書き込まず unchanged を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-07')
    await explains('`stack-register` の 2 回目の呼び出しのテストです。子の PR が既に親の直後へ並んでいる場合に、スタックへ書き込まず、`change` を `unchanged` として返すことを確認します。')
    const registered = [stack(5, [20, 21])]
    const result = await runOperation('stack-register', { pr: 21, parent_pr: 20 }, [stacksOf(20, registered), stacksOf(21, registered)])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ change: 'unchanged', number: 5, pull_requests: [20, 21] })
    expect(writesOf(result.github.requests())).toEqual([])
  })

  it.for([
    { name: '親がスタックの一番上でない', parent: [stack(5, [20, 22])], child: [], reason: 'PR #20 is not the top of stack #5 (top: PR #22)' },
    { name: '子が別のスタックにある', parent: [], child: [stack(6, [30, 21])], reason: 'PR #21 is already in stack #6' },
  ])('stack-register で $name とき、書き込まずに order-conflict を返す', async ({ parent, child, reason }, context) => {
    await verifies(context, 'PA-GITHUB-OPS-07')
    await explains('`stack-register` の順の食い違いのテストです。親と子の PR を指定した順でスタックへ登録できない場合は、書き込みを行わず、`order-conflict` と理由を返すことを確認します。')
    const result = await runOperation('stack-register', { pr: 21, parent_pr: 20 }, [stacksOf(20, parent), stacksOf(21, child)])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'order-conflict', message: reason } })
    expect(writesOf(result.github.requests())).toEqual([])
  })
})
