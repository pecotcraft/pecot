/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// auto gate の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AUTO_GATE_COMMANDS } from '../../src/commands/auto-gate.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { AUTO_COMMENT_URL, AUTO_POSTED, AUTO_TOKEN, autoResult, bot, botResult, issueComments, LABEL_PATH, labelRemoved, permissionOf, postedBody, prepareAuto, statusUpdated, writesOf } from '../_helpers/auto-case.js'
import { boardItems } from '../_helpers/board-issue-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { verifies } from '../_helpers/verifies.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'

useIsolatedEnvironment()

const BRANCH = 'feat/fix-x/7'
const HEAD = 'sha-head'
const REPOSITORY = { name: 'demo', full_name: 'acme/demo', owner: { login: 'acme' } }
const POSTED_LINE = 'created: auto result comment'
const REMOVED_LINE = 'removed: label pecot-auto from Issue acme/demo/7\n'

function eventFile(event: Readonly<Record<string, unknown>>): string {
  const file = path.join(makeTemporaryDirectory('pecot-auto-gate-'), 'event.json')
  writeFileSync(file, JSON.stringify(event), 'utf8')
  return file
}

function labeled(sender = 'alice'): string {
  return eventFile({ action: 'labeled', label: { name: 'pecot-auto' }, issue: { number: 7, state: 'open' }, sender: { login: sender }, repository: REPOSITORY })
}

function workflowRun(values: Readonly<Record<string, unknown>> = {}): string {
  const run = { conclusion: 'failure', head_branch: BRANCH, head_sha: HEAD, actor: { login: 'pecot-agent[bot]', type: 'Bot' }, created_at: '2026-11-24T09:00:00Z', head_repository: { full_name: 'acme/demo' }, pull_requests: [{ number: 11 }], ...values }
  return eventFile({ action: 'completed', workflow_run: run, repository: REPOSITORY })
}

async function gate(name: 'issues' | 'workflow_run', file: string, argv: readonly string[] = []): Promise<CliResult> {
  return await runInProcess(['auto', 'gate', '--event-name', name, '--event-path', file, ...argv], AUTO_GATE_COMMANDS)
}

function runJson(values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { issue: 'acme/demo/7', number: 7, kind: '', proceed: false, reason: '', branch: '', pr: 0, ci_attempts: 0, ...values }
}

function branchSha(sha = HEAD): ResponseRule {
  return { match: { method: 'GET', path: `/repos/acme/demo/git/ref/heads/${BRANCH}` }, respond: { status: 200, body: { object: { sha } } }, times: 1 }
}

function headRuns(conclusions: readonly (string | undefined)[] = ['success']): ResponseRule {
  const runs = conclusions.map((conclusion, index) => ({ id: index + 1, conclusion }))
  return { match: { method: 'GET', path: '/repos/acme/demo/actions/runs' }, respond: { status: 200, body: { total_count: runs.length, workflow_runs: runs } }, times: 1 }
}

describe('auto gate', () => {
  describe('issues のイベント', () => {
    it('書き込み権限を持つ人が Ready の Issue にラベルを付けると、kind が start で proceed が真の JSON を出し、何も書かない', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-01')
      await verifies(context, 'PW-AUTO-GATE-14')
      prepareAuto()
      const github = await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Ready' }), issueComments()])

      const outcome = await gate('issues', labeled())

      expect(outcome).toEqual({ code: 0, stdout: `${JSON.stringify(runJson({ kind: 'start', proceed: true }))}\n`, stderr: '' })
      expect(writesOf(github.requests())).toEqual([])
      expect(`${outcome.stdout}${outcome.stderr}`).not.toContain(AUTO_TOKEN)
    })

    it('GITHUB_OUTPUT があると、同じ値を key=value の行で足す', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-02')
      prepareAuto()
      const file = path.join(makeTemporaryDirectory('pecot-auto-gate-'), 'output')
      writeFileSync(file, 'earlier=1\n', 'utf8')
      setEnvironment({ GITHUB_OUTPUT: file })
      await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Ready', branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] }), issueComments()])

      await gate('issues', labeled())

      expect(readFileSync(file, 'utf8')).toBe(`earlier=1\nissue=acme/demo/7\nnumber=7\nkind=resume\nproceed=true\nreason=\nbranch=${BRANCH}\npr=11\nci_attempts=0\n`)
    })

    it('計画のコメントとブランチが無く、開いた PR だけがある Issue は、kind を resume にして、その PR を出す', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-16')
      prepareAuto()
      await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Ready', pullRequests: [{ number: 11, head: BRANCH }] }), issueComments()])

      const outcome = await gate('issues', labeled())

      expect(JSON.parse(outcome.stdout)).toMatchObject({ kind: 'resume', proceed: true, branch: BRANCH, pr: 11 })
    })

    it.for([
      { name: 'read', permission: 'read', reason: 'the sender has no write permission' },
      { name: 'triage', permission: 'triage', reason: 'the sender has no write permission' },
    ])('ラベルを付けた人の権限が $name なら、Issue を読まずに proceed が偽の JSON と skipped の行を出す', async ({ permission, reason }, context) => {
      await verifies(context, 'PW-AUTO-GATE-03')
      prepareAuto()
      const github = await startGithub([permissionOf('alice', permission)])

      const outcome = await gate('issues', labeled())

      expect(outcome).toEqual({ code: 0, stdout: `${JSON.stringify(runJson({ reason }))}\n`, stderr: `skipped: automated fix for Issue acme/demo/7 (${reason})\n` })
      expect(writesOf(github.requests())).toEqual([])
    })

    it('ラベルを付けた人が [bot] なら、権限を読まず、proceed を偽にする', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-03')
      prepareAuto()
      const github = await startGithub([])

      const outcome = await gate('issues', labeled('renovate[bot]'))

      expect(outcome.stdout).toBe(`${JSON.stringify(runJson({ reason: 'the sender is a bot' }))}\n`)
      expect(github.requests()).toEqual([])
    })

    it('Backlog の Issue なら、out-of-scope の結果のコメントを書いて起動ラベルを外し、proceed が偽の JSON を出して成功する', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-04')
      prepareAuto()
      const github = await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Backlog' }), issueComments(), AUTO_POSTED, labelRemoved()])

      const outcome = await gate('issues', labeled())

      expect(outcome).toEqual({
        code: 0,
        stdout: `${JSON.stringify(runJson({ reason: 'the Issue is in Backlog' }))}\n`,
        stderr: `${POSTED_LINE} (out-of-scope) on Issue acme/demo/7\n${REMOVED_LINE}`,
      })
      const body = postedBody(github.requests())
      expect(body).toContain('`Backlog`')
      expect(body).toContain('<!-- pecot-auto: result=out-of-scope run=500 attempt=1 branch=- -->')
      expect(writesOf(github.requests())).toEqual(['POST /repos/acme/demo/issues/7/comments', `DELETE ${LABEL_PATH}`])
    })

    it('--dry-run なら、書くはずの本文を JSON の comment に入れ、コメントとラベルを書かない', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-10')
      prepareAuto()
      const github = await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Backlog' }), issueComments()])

      const outcome = await gate('issues', labeled(), ['--dry-run'])

      expect(outcome.code).toBe(0)
      const printed: unknown = JSON.parse(outcome.stdout)
      expect(printed).toMatchObject(runJson({ reason: 'the Issue is in Backlog' }))
      expect(printed).toHaveProperty('comment', expect.stringContaining('## Auto result'))
      expect(outcome.stderr).toBe(`dry-run: would create auto result comment (out-of-scope) on Issue acme/demo/7\ndry-run: would remove label pecot-auto from Issue acme/demo/7\n`)
      expect(writesOf(github.requests())).toEqual([])
    })
  })

  describe('workflow_run のイベント', () => {
    it('自動処理が PR を作ったブランチの CI が落ちると、kind が ci-fix で proceed が真の JSON を出す', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-05')
      prepareAuto()
      const github = await startGithub([issueComments([botResult('pr-created')]), branchSha()])

      const outcome = await gate('workflow_run', workflowRun())

      expect(outcome).toEqual({ code: 0, stdout: `${JSON.stringify(runJson({ kind: 'ci-fix', proceed: true, branch: BRANCH, pr: 11 }))}\n`, stderr: '' })
      expect(writesOf(github.requests())).toEqual([])
    })

    it('CI が通ると、ci-passed の結果のコメントを書き、ラベルと Status は書かない', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-06')
      prepareAuto()
      const github = await startGithub([issueComments([botResult('pr-created')]), branchSha(), headRuns(['success', undefined]), AUTO_POSTED])

      const outcome = await gate('workflow_run', workflowRun({ conclusion: 'success' }))

      expect(outcome.stdout).toBe(`${JSON.stringify(runJson({ kind: 'ci-passed', reason: 'the CI passed', branch: BRANCH, pr: 11 }))}\n`)
      expect(outcome.stderr).toBe(`${POSTED_LINE} (ci-passed) on Issue acme/demo/7\n`)
      expect(writesOf(github.requests())).toEqual(['POST /repos/acme/demo/issues/7/comments'])
    })

    it('CI を直した回数が上限に達していると、limit の結果のコメントを書き、Status を Needs Attention にして起動ラベルを外す', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-07')
      prepareAuto()
      const comments = [botResult('pr-created'), botResult('ci-fix-pushed')]
      const github = await startGithub([issueComments(comments), branchSha(), boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

      const outcome = await gate('workflow_run', workflowRun(), ['--max-ci-attempts', '1'])

      expect(JSON.parse(outcome.stdout)).toEqual(runJson({ kind: 'ci-fix', reason: 'the CI fixes reached the limit (1 of 1)', branch: BRANCH, pr: 11, ci_attempts: 1 }))
      expect(outcome.stderr).toBe(`${POSTED_LINE} (limit) on Issue acme/demo/7\nset: Status of Issue acme/demo/7 to Needs Attention\n${REMOVED_LINE}`)
      expect(postedBody(github.requests())).toContain('CI を直す回数が上限（1 回）に達した')
    })

    it.for([
      { name: 'fork のブランチ', values: { head_repository: { full_name: 'mallory/demo' } }, reason: 'the run is from a fork' },
      { name: '末尾が Issue 番号でないブランチ', values: { head_branch: 'renovate/x' }, reason: 'the branch renovate/x does not end with an Issue number' },
    ])('$name の CI なら、何も読まず、proceed を偽にする', async ({ values, reason }, context) => {
      await verifies(context, 'PW-AUTO-GATE-08')
      prepareAuto()
      const github = await startGithub([])

      const outcome = await gate('workflow_run', workflowRun(values))

      expect(outcome.code).toBe(0)
      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false, reason })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: '自動処理が PR を作っていない', comments: [], sha: HEAD, reason: `no PR was created by the automation on ${BRANCH}` },
      { name: 'ブランチの先頭でない commit', comments: [botResult('pr-created')], sha: 'sha-newer', reason: `the run is not for the head of ${BRANCH}` },
      { name: 'CI が通った後に人が push した', comments: [botResult('pr-created'), bot(autoResult('ci-passed'), '2026-11-24T08:00:00Z')], sha: HEAD, reason: `${BRANCH} was pushed by a person after the CI passed` },
    ])('$name ブランチの CI なら、何も書かず、proceed を偽にする', async ({ comments, sha, reason }, context) => {
      await verifies(context, 'PW-AUTO-GATE-09')
      prepareAuto()
      const github = await startGithub([issueComments(comments), branchSha(sha)])

      const outcome = await gate('workflow_run', workflowRun({ actor: { login: 'alice', type: 'User' } }))

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false, reason })
      expect(outcome.stderr).toBe(`skipped: automated fix for Issue acme/demo/7 (${reason})\n`)
      expect(writesOf(github.requests())).toEqual([])
    })

    it('CI が通っても、同じ commit のほかの run が落ちていれば、ci-passed を書かず、proceed を偽にする', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-15')
      prepareAuto()
      const github = await startGithub([issueComments([botResult('pr-created')]), branchSha(), headRuns(['success', 'failure'])])

      const outcome = await gate('workflow_run', workflowRun({ conclusion: 'success' }))

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false, reason: `another CI run of ${HEAD} failed` })
      expect(writesOf(github.requests())).toEqual([])
    })

    it('同じ push の CI でもう ci-passed を書いていれば、ci-passed を重ねて書かない', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-15')
      prepareAuto()
      const comments = [botResult('pr-created'), bot(autoResult('ci-passed'), '2026-11-24T10:00:00Z')]
      const github = await startGithub([issueComments(comments), branchSha(), headRuns()])

      const outcome = await gate('workflow_run', workflowRun({ conclusion: 'success' }))

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false, reason: `the CI already passed for this push of ${BRANCH}` })
      expect(writesOf(github.requests())).toEqual([])
    })
  })

  it('設定に fields.status が無いと、何も読まずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PW-AUTO-GATE-11')
    prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await gate('issues', labeled())

    expect(outcome.code).toBe(1)
    expect(outcome.stdout).toBe('')
    expect(outcome.stderr).toBe('error: the project config has no Status field (fields.status)\n  run: pecot project init\n')
    expect(github.requests()).toEqual([])
  })

  it('イベントのファイルが無いと、何も読まずに入力の誤りで止まる', async (context) => {
    await verifies(context, 'PW-AUTO-GATE-12')
    prepareAuto()
    const file = path.join(makeTemporaryDirectory('pecot-auto-gate-'), 'missing.json')
    const github = await startGithub([])

    const outcome = await gate('issues', file)

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: `error: --event-path does not exist: ${file}\n` })
    expect(github.requests()).toEqual([])
  })

  it('イベントのファイルが JSON でないと、入力の誤りで止まる', async (context) => {
    await verifies(context, 'PW-AUTO-GATE-12')
    prepareAuto()
    const file = path.join(makeTemporaryDirectory('pecot-auto-gate-'), 'broken.json')
    writeFileSync(file, '{', 'utf8')
    await startGithub([])

    const outcome = await gate('issues', file)

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: `error: --event-path is not JSON: ${file}\n` })
  })

  describe('読めないイベントと GitHub の失敗', () => {
    it.for([
      { name: 'repository.name', event: { issue: { number: 7, state: 'open' }, sender: { login: 'alice' }, repository: { owner: { login: 'acme' } } } },
      { name: 'issue.number', event: { issue: { state: 'open' }, sender: { login: 'alice' }, repository: REPOSITORY } },
      { name: 'issue.state of open or closed', event: { issue: { number: 7 }, sender: { login: 'alice' }, repository: REPOSITORY } },
    ])('issues のイベントに $name が無いと、何も読まずに入力の誤りで止まる', async ({ name, event }, context) => {
      await verifies(context, 'PW-AUTO-GATE-12')
      prepareAuto()
      const github = await startGithub([])

      const outcome = await gate('issues', eventFile(event))

      expect(outcome).toEqual({ code: 1, stdout: '', stderr: `error: the event has no ${name}\n` })
      expect(github.requests()).toEqual([])
    })

    it('ラベルを付けた人の権限を読めないと、Issue を読まずに proceed を偽にする', async () => {
      prepareAuto()
      const github = await startGithub([{ match: { method: 'GET', path: '/repos/acme/demo/collaborators/alice/permission' }, respond: { status: 404, body: { message: 'Not Found' } }, times: 1 }])

      const outcome = await gate('issues', labeled())

      expect(outcome.code).toBe(0)
      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false })
      expect(writesOf(github.requests())).toEqual([])
    })

    it('Issue の読み取りが GitHub の失敗で止まると、Issue を示して止まる', async () => {
      prepareAuto()
      const github = await startGithub([permissionOf('alice', 'write'), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await gate('issues', labeled())

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not read Issue acme\/demo\/7: /u)
      expect(writesOf(github.requests())).toEqual([])
    })

    it('Blocked の Issue の前提を判定できないと、前提を blocked とだけ書いて、proceed を偽にする', async () => {
      prepareAuto()
      const blocker = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, base: 'feat/2' }] }
      const github = await startGithub([
        permissionOf('alice', 'write'),
        prerequisitesRule({ number: 7, column: 'Blocked', blockedBy: [blocker] }),
        { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 },
        issueComments(),
        AUTO_POSTED,
        labelRemoved(),
      ])

      const outcome = await gate('issues', labeled())

      expect(outcome.code).toBe(0)
      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false })
      expect(postedBody(github.requests())).toContain('待っている前提は `blocked` だ')
    })

    it('Blocked の Issue なら、残る前提を本文に書いて、proceed を偽にする', async () => {
      prepareAuto()
      const github = await startGithub([
        permissionOf('alice', 'write'),
        prerequisitesRule({ number: 7, column: 'Blocked', blockedBy: [{ number: 3, column: 'In Progress' }] }),
        issueComments(),
        AUTO_POSTED,
        labelRemoved(),
      ])

      const outcome = await gate('issues', labeled())

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false })
      expect(postedBody(github.requests())).toContain('待っている前提は `blocked by #3 (not in review: #3 (not started))` だ')
    })

    it('終わっていない run の conclusion が null で、PR が無いと、何も読まず、PR の番号を 0 にする', async () => {
      prepareAuto()
      const github = await startGithub([])

      // eslint-disable-next-line unicorn/no-null -- イベントの JSON の null（終わっていない run）
      const outcome = await gate('workflow_run', workflowRun({ conclusion: null, pull_requests: [] }))

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false, pr: 0 })
      expect(github.requests()).toEqual([])
    })

    it('CI のブランチがもう無いと、proceed を偽にする', async () => {
      prepareAuto()
      const github = await startGithub([issueComments([botResult('pr-created')]), { match: { method: 'GET', path: `/repos/acme/demo/git/ref/heads/${BRANCH}` }, respond: { status: 404, body: { message: 'Not Found' } }, times: 1 }])

      const outcome = await gate('workflow_run', workflowRun())

      expect(JSON.parse(outcome.stdout)).toMatchObject({ proceed: false })
      expect(writesOf(github.requests())).toEqual([])
    })

    it('CI のブランチの読み取りが GitHub の失敗で止まると、ブランチを示して止まる', async () => {
      prepareAuto()
      await startGithub([issueComments([botResult('pr-created')]), { match: { method: 'GET', path: `/repos/acme/demo/git/ref/heads/${BRANCH}` }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await gate('workflow_run', workflowRun())

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(new RegExp(`^error: could not read the branch ${BRANCH}: `, 'u'))
    })
  })

  describe('MCP の data', () => {
    it('結果のコメントを書くと、実行の欄を run に入れ、結果と URL を足して返す', async (context) => {
      await verifies(context, 'PW-AUTO-GATE-13')
      prepareAuto()
      await startGithub([permissionOf('alice', 'write'), prerequisitesRule({ number: 7, column: 'Backlog' }), issueComments(), AUTO_POSTED, labelRemoved()])

      const outcome = await callToolOnce(AUTO_GATE_COMMANDS, 'auto_gate', { event_name: 'issues', event_path: labeled() })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ run: runJson({ reason: 'the Issue is in Backlog' }), result: 'out-of-scope', commentUrl: AUTO_COMMENT_URL })
    })
  })
})
