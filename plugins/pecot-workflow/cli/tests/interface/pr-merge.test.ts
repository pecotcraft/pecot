// pr merge の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
// 場面は specs/024-issue-readiness-stacked-prs/contracts/cli-commands.md の pecot pr merge の表
import { describe, expect, it } from 'vitest'

import { PR_COMMANDS } from '../../src/commands/pr.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { prepareProject } from '../_helpers/board-issue-case.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, settleWithFakeDelays, startGithub, useFakeDelays } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'

useIsolatedEnvironment()

const VERSION = '2026-03-10'
const MERGE_ASYNC = '/repos/acme/demo/pulls/11/merge-async'
const PUT = `PUT ${MERGE_ASYNC}`

async function merge(argv: readonly string[]): Promise<CliResult> {
  useFakeDelays()
  return await settleWithFakeDelays(runInProcess(['pr', 'merge', ...argv], PR_COMMANDS))
}

async function mergeTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  useFakeDelays()
  return await callToolOnce(PR_COMMANDS, 'pr_merge', argumentsOfTool, settleWithFakeDelays)
}

function labelOf(request: RecordedRequest): string {
  return request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`
}

interface PullRequestState {
  readonly number?: number
  readonly state?: string
  readonly isDraft?: boolean
  readonly baseRefName?: string
  readonly isMergeQueueEnabled?: boolean
  readonly isInMergeQueue?: boolean
}

function pullRequest(sample: Readonly<PullRequestState> = {}, times = 1): ResponseRule {
  const number = sample.number ?? 11
  const node = { number, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: `sha-${String(number)}`, isMergeQueueEnabled: false, isInMergeQueue: false, ...sample }
  return { match: { operation: 'GetPullRequestForMerge', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { pullRequest: node } } } }, times }
}

function resultMissing(times = 1): ResponseRule {
  return { match: { method: 'GET', path: `${MERGE_ASYNC}/u-1` }, respond: { status: 404, body: { message: 'Not Found' } }, times }
}

const SYNC_MERGE = '/repos/acme/demo/pulls/11/merge'

const SYNC_MERGED = { sha: 'merge-sha', merged: true, message: 'Pull Request successfully merged' }

function syncMerged(status = 200, body: unknown = SYNC_MERGED): ResponseRule {
  return { match: { method: 'PUT', path: SYNC_MERGE }, respond: { status, body }, times: 1 }
}

const ASYNC_MISSING = requested(404, { message: 'Not Found' })

function stacks(body: unknown, status = 200): ResponseRule {
  return { match: { method: 'GET', path: '/repos/acme/demo/stacks', query: { pull_request: '11' }, apiVersion: VERSION }, respond: { status, body }, times: 1 }
}

function stackOf(pullRequests: readonly number[]): unknown {
  return { number: 3, pull_requests: pullRequests.map(pr => ({ number: pr })) }
}

const NO_STACK = stacks([])

function requested(status: number, body: unknown, expectedBody?: unknown): ResponseRule {
  return { match: { method: 'PUT', path: MERGE_ASYNC, apiVersion: VERSION, ...expectedBody !== undefined && { body: expectedBody } }, respond: { status, body }, times: 1 }
}

function pending(uuid = 'u-1'): unknown {
  return { status: 'pending', details: { message: 'accepted', uuid, merge_method: 'squash', merge_action: 'default', expected_head_sha: 'sha-11', bypass_rules: false } }
}

function result(body: unknown, uuid = 'u-1', times = 1): ResponseRule {
  return { match: { method: 'GET', path: `${MERGE_ASYNC}/${uuid}`, apiVersion: VERSION }, respond: { status: 200, body }, times }
}

const MERGED = { status: 'merged', details: { message: 'Pull request merged', sha: 'merge-sha' } }
const ENQUEUED = { status: 'enqueued', details: { message: 'Added to the merge queue' } }

describe('pr merge', () => {
  it('単独の PR を、読んだ head の SHA と squash で頼み、結果が merged になれば merged の行を出して 0 で終わる', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), NO_STACK, requested(202, pending(), { sha: 'sha-11', merge_method: 'squash' }), result(pending()), result(MERGED)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
    expect(github.requests().find(request => labelOf(request) === PUT)).toMatchObject({ body: { sha: 'sha-11', merge_method: 'squash' } })
  })

  it('スタックの一番下の PR をマージすると、スタックの番号とPR の数を添えた merged の行を出す', async () => {
    prepareProject()
    await startGithub([pullRequest(), stacks([stackOf([11, 12])]), requested(202, pending()), result(MERGED)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main (stack #3, 1 of 2)\n' })
  })

  it('親 PR がマージ済みで並びに残っていても、一番下として扱う', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), stacks([stackOf([10, 11, 12])]), pullRequest({ number: 10, state: 'MERGED' }), requested(202, pending()), result(MERGED)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main (stack #3, 1 of 2)\n' })
    expect(github.requests().map(request => labelOf(request))).toContain(PUT)
  })

  it('merge queue のあるブランチでは、マージの方法の値を渡さず、enqueued なら added の行を出して 0 で終わる', async () => {
    prepareProject()
    const github = await startGithub([pullRequest({ isMergeQueueEnabled: true }), NO_STACK, requested(202, pending()), result(ENQUEUED)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'added: PR #11 to merge queue of main\n' })
    const put = github.requests().find(request => labelOf(request) === PUT)
    expect(put?.type === 'rest' ? put.body : undefined).toEqual({ sha: 'sha-11' })
  })

  it('スタックの一番下でなければ、要求を送らずに、先にマージする PR を示す error の行を出し、終了コード 2 を返す', async () => {
    prepareProject()
    const github = await startGithub([pullRequest({ number: 12 }), { match: { method: 'GET', path: '/repos/acme/demo/stacks', query: { pull_request: '12' } }, respond: { status: 200, body: [stackOf([10, 11, 12])] }, times: 1 }, pullRequest({ number: 10, state: 'MERGED' }), pullRequest({ number: 11 })])

    const outcome = await merge(['acme/demo/12'])

    expect(outcome).toEqual({ code: 2, stdout: '', stderr: 'error: PR #12 is not the bottom of stack #3. Merge PR #11 first\n' })
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'PUT')).toBe(false)
  })

  it('MCP で一番下でない PR を渡すと、kind が pr-state の失敗を返す', async (context) => {
    await verifies(context, 'PW-PR-MERGE-05')
    prepareProject()
    await startGithub([pullRequest({ number: 12 }), { match: { method: 'GET', path: '/repos/acme/demo/stacks', query: { pull_request: '12' } }, respond: { status: 200, body: [stackOf([11, 12])] }, times: 1 }, pullRequest({ number: 11 })])

    const outcome = await mergeTool({ pr_ref: 'acme/demo/12' })

    expect(outcome.isError).toBe(true)
    expect(outcome.structured).toMatchObject({ kind: 'pr-state', detail: 'PR #12 is not the bottom of stack #3. Merge PR #11 first' })
  })

  it('ドラフトの PR は、要求を送らずに error の行を出し、終了コード 2 を返す', async () => {
    prepareProject()
    const github = await startGithub([pullRequest({ isDraft: true })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 2, stdout: '', stderr: 'error: PR #11 is a draft\n' })
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetPullRequestForMerge'])
  })

  it('GitHub が規則で拒んだ（failed）ときは、details.message を添えた error の行を出し、終了コード 1 を返す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(202, pending()), result({ status: 'failed', details: { message: 'Repository rule violations found' } })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: merge was rejected: Repository rule violations found\n' })
  })

  it('非同期のマージが 60 秒で終わらなければ、確かめる PR を示す error の行を出し、終了コード 1 を返す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(202, pending()), result(pending(), 'u-1', 30)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: merge did not finish in 60s. Check PR #11\n' })
  })

  it.each([
    ['既にマージ済み（200）', MERGED, 'merged: PR #11 into main\n'],
    ['既にキューの中（200）', ENQUEUED, 'added: PR #11 to merge queue of main\n'],
  ])('%s なら、結果を読み直さず、その行を出して 0 で終わる', async (_label, body, line) => {
    prepareProject()
    const github = await startGithub([pullRequest(), NO_STACK, requested(200, body)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: line })
    expect(github.requests().filter(request => request.type === 'rest' && request.method === 'GET' && request.path.startsWith(MERGE_ASYNC))).toEqual([])
  })

  it('読んだ後に閉じられた PR など（400）は、GitHub の文を添えた error の行を出し、終了コード 1 を返す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(400, { message: 'Pull request is closed' })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: merge was rejected: Pull request is closed\n' })
  })

  it('同じ PR の要求が既にある（409）ときは、返った uuid の結果を読み続ける', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), NO_STACK, requested(409, pending('u-old')), result(pending('u-old'), 'u-old'), result(MERGED, 'u-old')])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
    expect(github.requests().filter(request => labelOf(request) === `GET ${MERGE_ASYNC}/u-old`)).toHaveLength(2)
  })

  it('409 の本文に uuid が無ければ、PR の状態を読み直し、キューの中なら added の行を出す', async () => {
    prepareProject()
    await startGithub([pullRequest({ isMergeQueueEnabled: true }), NO_STACK, requested(409, { message: 'conflict' }), pullRequest({ isMergeQueueEnabled: true, isInMergeQueue: true })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'added: PR #11 to merge queue of main\n' })
  })

  it('uuid の結果が消えていたら（404）、PR の状態を読み直し、マージ済みなら merged の行を出す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(202, pending()), { match: { method: 'GET', path: `${MERGE_ASYNC}/u-1` }, respond: { status: 404, body: { message: 'Not Found' } }, times: 1 }, pullRequest({ state: 'MERGED' })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
  })

  it('uuid の結果の 404 が続き、PR が open のまま、キューにも無いまま 60 秒が過ぎれば、error の行を出し、終了コード 1 を返す', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), NO_STACK, requested(202, pending()), resultMissing(30), pullRequest({}, 30)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: could not confirm the merge of PR #11: it is neither merged nor in the merge queue\n' })
    expect(github.requests().filter(request => labelOf(request) === 'GetPullRequestForMerge')).toHaveLength(31)
  })

  it('uuid の結果の 404 が続いても、期限までに PR が MERGED へ変われば、merged の行を出して 0 で終わる', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(202, pending()), resultMissing(3), pullRequest({}, 2), pullRequest({ state: 'MERGED' })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
  })

  it('uuid の結果の 404 の後に結果が読めて failed なら、details.message を添えた error の行を出す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(202, pending()), resultMissing(1), pullRequest({}, 1), result({ status: 'failed', details: { message: 'Repository rule violations found' } })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: merge was rejected: Repository rule violations found\n' })
  })

  it('merge-async が 404（GHES）なら、スタックに入っていない PR を、読んだ head の SHA と squash の同期のマージでマージする', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), stacks({ message: 'Not Found' }, 404), ASYNC_MISSING, syncMerged()])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
    const put = github.requests().find(request => labelOf(request) === `PUT ${SYNC_MERGE}`)
    expect(put?.type === 'rest' ? put.body : undefined).toEqual({ merge_method: 'squash', sha: 'sha-11' })
  })

  it('merge-async が 404 で、同期のマージが 409（head が読んだ SHA と違う）なら、GitHub の文を添えた rejected の行を出す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, ASYNC_MISSING, syncMerged(409, { message: 'Head branch was modified. Review and try the merge again.' })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: merge was rejected: Head branch was modified. Review and try the merge again.\n' })
  })

  it('スタックの中の PR で merge-async が 404 なら、同期のマージに戻さず、失敗の行を出して終了コード 1 を返す', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), stacks([stackOf([11, 12])]), ASYNC_MISSING])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toMatch(/^error: could not merge PR acme\/demo\/11: /u)
    expect(github.requests().map(request => labelOf(request))).not.toContain(`PUT ${SYNC_MERGE}`)
  })

  it.for([
    { state: 'CLOSED', line: 'error: PR #11 is closed\n' },
    { state: 'MERGED', line: 'error: PR #11 is already merged\n' },
  ])('state が $state なら、スタックを読まず要求も送らずに error の行を出し、終了コード 2 を返す', async ({ state, line }) => {
    prepareProject()
    const github = await startGithub([pullRequest({ state })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 2, stdout: '', stderr: line })
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetPullRequestForMerge'])
  })

  it('--dry-run でも、閉じている PR は error の行を出し、終了コード 2 を返す', async () => {
    prepareProject()
    await startGithub([pullRequest({ state: 'CLOSED' })])

    const outcome = await merge(['acme/demo/11', '--dry-run'])

    expect(outcome).toEqual({ code: 2, stdout: '', stderr: 'error: PR #11 is closed\n' })
  })
  it('スタックの機能が無いリポ（404）では、単独の PR として扱う', async () => {
    prepareProject()
    await startGithub([pullRequest(), stacks({ message: 'Not Found' }, 404), requested(202, pending()), result(MERGED)])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'merged: PR #11 into main\n' })
  })

  it('403 は、ほかの API と同じ失敗の文を出し、終了コード 1 を返す', async () => {
    prepareProject()
    await startGithub([pullRequest(), NO_STACK, requested(403, { message: 'Forbidden' })])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toMatch(/^error: could not merge PR acme\/demo\/11: access denied/u)
  })

  it('--dry-run は、PR とスタックを読み、要求を送らずに dry-run の行を出して 0 で終わる', async () => {
    prepareProject()
    const github = await startGithub([pullRequest(), stacks([stackOf([11, 12])])])

    const outcome = await merge(['acme/demo/11', '--dry-run'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would merge PR #11 into main (stack #3, 1 of 2)\n' })
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'PUT')).toBe(false)
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    prepareProject({ repositories: ['other'] })
    const github = await startGithub([])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
    expect(github.requests()).toEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async () => {
    const { project } = prepareProject()
    makeAmbiguous(project)
    await startGithub([pullRequest(), stacks([stackOf([11, 12])])])

    const outcome = await merge(['acme/demo/11', '--dry-run', '--project', SECOND_PROJECT])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would merge PR #11 into main (stack #3, 1 of 2)\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const { project } = prepareProject()
    makeAmbiguous(project)
    await startGithub([])

    const outcome = await merge(['acme/demo/11'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で読む', async () => {
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([pullRequest(), stacks([stackOf([11, 12])])])

    const outcome = await merge(['acme/demo/11', '--dry-run'])

    expect(outcome.code).toBe(0)
  })

  it('MCP で成功すると、マージした PR・base・結果・スタックを返す', async (context) => {
    await verifies(context, 'PW-PR-MERGE-02')
    prepareProject()
    await startGithub([pullRequest(), stacks([stackOf([11, 12])]), requested(202, pending()), result(MERGED)])

    const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })

    expect(outcome.isError).toBe(false)
    expect(outcome.text).toBe('merged: PR #11 into main (stack #3, 1 of 2)')
    expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged', stack: { number: 3, size: 2 } })
  })

  describe('MCP の呼び出し', () => {
    it('スタックの外の PR を渡すと、読んだ head のコミットと squash でマージを頼み、status を merged にする', async (context) => {
      await verifies(context, 'PW-PR-MERGE-01')
      prepareProject()
      const github = await startGithub([pullRequest(), NO_STACK, requested(202, pending(), { sha: 'sha-11', merge_method: 'squash' }), result(pending()), result(MERGED)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged' })
      expect(github.requests().find(request => labelOf(request) === PUT)).toMatchObject({ body: { sha: 'sha-11', merge_method: 'squash' } })
    })

    it('親 PR がマージ済みで並びに残っていても、一番下として扱い、残りのPR の数を stack に入れる', async (context) => {
      await verifies(context, 'PW-PR-MERGE-03')
      prepareProject()
      await startGithub([pullRequest(), stacks([stackOf([10, 11, 12])]), pullRequest({ number: 10, state: 'MERGED' }), requested(202, pending()), result(MERGED)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged', stack: { number: 3, size: 2 } })
    })

    it('merge queue のあるブランチでは、マージの方法を送らず、merge queue に入ると status を enqueued にする', async (context) => {
      await verifies(context, 'PW-PR-MERGE-04')
      prepareProject()
      const github = await startGithub([pullRequest({ isMergeQueueEnabled: true }), NO_STACK, requested(202, pending()), result(ENQUEUED)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'enqueued' })
      const put = github.requests().find(request => labelOf(request) === PUT)
      expect(put?.type === 'rest' ? put.body : undefined).toEqual({ sha: 'sha-11' })
    })

    it('ドラフトの PR は、要求を送らずに kind が pr-state の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-06')
      prepareProject()
      const github = await startGithub([pullRequest({ isDraft: true })])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ kind: 'pr-state', detail: 'PR #11 is a draft' })
      expect(github.requests().map(request => labelOf(request))).toEqual(['GetPullRequestForMerge'])
    })

    it.for([
      { name: 'GitHub が規則で拒んだ', rules: [requested(202, pending()), result({ status: 'failed', details: { message: 'Repository rule violations found' } })], message: 'Repository rule violations found' },
      { name: '読んだ後に PR が閉じられた', rules: [requested(400, { message: 'Pull request is closed' })], message: 'Pull request is closed' },
    ])('$name とき、GitHub の文を添えた detail を入れて kind が pr-state の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-PR-MERGE-07')
      prepareProject()
      await startGithub([pullRequest(), NO_STACK, ...row.rules])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', kind: 'pr-state', detail: `merge was rejected: ${row.message}` })
    })

    it('マージが 60 秒で終わらないと、確かめる PR を detail で示して kind が github-api の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-08')
      prepareProject()
      await startGithub([pullRequest(), NO_STACK, requested(202, pending()), result(pending(), 'u-1', 30)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', kind: 'github-api', detail: 'merge did not finish in 60s. Check PR #11' })
    })

    it('同じ PR のマージの要求が既にあると、その要求の結果を読み続ける', async (context) => {
      await verifies(context, 'PW-PR-MERGE-09')
      prepareProject()
      const github = await startGithub([pullRequest(), NO_STACK, requested(409, pending('u-old')), result(pending('u-old'), 'u-old'), result(MERGED, 'u-old')])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged' })
      expect(github.requests().filter(request => labelOf(request) === `GET ${MERGE_ASYNC}/u-old`)).toHaveLength(2)
    })

    it.for([
      { name: '409 の本文に uuid が無く、PR が merge queue の中', rules: [pullRequest({ isMergeQueueEnabled: true }), NO_STACK, requested(409, { message: 'conflict' }), pullRequest({ isMergeQueueEnabled: true, isInMergeQueue: true })], status: 'enqueued' },
      { name: 'uuid の結果が消え、PR がマージ済み', rules: [pullRequest(), NO_STACK, requested(202, pending()), resultMissing(1), pullRequest({ state: 'MERGED' })], status: 'merged' },
    ])('$name なら、PR の状態を読み直して status を $status にする', async (row, context) => {
      await verifies(context, 'PW-PR-MERGE-10')
      prepareProject()
      await startGithub(row.rules)
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: row.status })
    })

    it('結果を読めないまま 60 秒が過ぎ、PR がマージ済みでも merge queue の中でもないと、kind が pr-state の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-11')
      prepareProject()
      await startGithub([pullRequest(), NO_STACK, requested(202, pending()), resultMissing(30), pullRequest({}, 30)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', kind: 'pr-state', detail: 'could not confirm the merge of PR #11: it is neither merged nor in the merge queue' })
    })

    it('リポジトリにスタックの API が無いと、スタックの外の PR として扱う', async (context) => {
      await verifies(context, 'PW-PR-MERGE-12')
      prepareProject()
      await startGithub([pullRequest(), stacks({ message: 'Not Found' }, 404), requested(202, pending()), result(MERGED)])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged' })
    })

    it('GitHub API がほかのエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-13')
      prepareProject()
      await startGithub([pullRequest(), NO_STACK, requested(403, { message: 'Forbidden' })])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toMatch(/^could not merge PR acme\/demo\/11: access denied/u)
    })

    it('CLI で --dry-run を付けると、PR とスタックを読み、要求を送らずに、マージする予定を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-14')
      prepareProject()
      const github = await startGithub([pullRequest(), stacks([stackOf([11, 12])])])
      const outcome = await merge(['acme/demo/11', '--dry-run'])
      expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would merge PR #11 into main (stack #3, 1 of 2)\n' })
      expect(github.requests().some(request => request.type === 'rest' && request.method === 'PUT')).toBe(false)
    })

    it.for([
      { state: 'CLOSED', detail: 'PR #11 is closed' },
      { state: 'MERGED', detail: 'PR #11 is already merged' },
    ])('state が $state なら、要求を送らずに kind が pr-state の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-PR-MERGE-15')
      prepareProject()
      const github = await startGithub([pullRequest({ state: row.state })])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ kind: 'pr-state', detail: row.detail })
      expect(github.requests().map(request => labelOf(request))).toEqual(['GetPullRequestForMerge'])
    })

    it('非同期のマージ API が無いと、スタックの外の PR を、読んだ head のコミットを添えた同期のマージ API で squash でマージする', async (context) => {
      await verifies(context, 'PW-PR-MERGE-16')
      prepareProject()
      const github = await startGithub([pullRequest(), stacks({ message: 'Not Found' }, 404), ASYNC_MISSING, syncMerged()])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ pullRequest: 'acme/demo/11', base: 'main', status: 'merged' })
      const put = github.requests().find(request => labelOf(request) === `PUT ${SYNC_MERGE}`)
      expect(put?.type === 'rest' ? put.body : undefined).toEqual({ merge_method: 'squash', sha: 'sha-11' })
    })

    it('スタックの中の PR で非同期のマージ API が無いと、同期のマージ API を呼ばずに失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-17')
      prepareProject()
      const github = await startGithub([pullRequest(), stacks([stackOf([11, 12])]), ASYNC_MISSING])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toMatch(/^could not merge PR acme\/demo\/11: /u)
      expect(github.requests().map(request => labelOf(request))).not.toContain(`PUT ${SYNC_MERGE}`)
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-MERGE-18')
      prepareProject({ repositories: ['other'] })
      const github = await startGithub([])
      const outcome = await mergeTool({ pr_ref: 'acme/demo/11' })
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
      expect(github.requests()).toEqual([])
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async (context) => {
      await verifies(context, 'PW-PR-MERGE-19')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([pullRequest(), stacks([stackOf([11, 12])])])
      const outcome = await merge(['acme/demo/11', '--dry-run', '--project', SECOND_PROJECT])
      expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would merge PR #11 into main (stack #3, 1 of 2)\n' })
    })
  })
})
