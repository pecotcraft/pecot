/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// review finish の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
// 場面は specs/027-auto-revise-on-pr/contracts/cli-commands.md の表
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { hasReportedTemplateViolations } from '../../src/commands/issue-shared.js'
import { createOutput } from '../../src/commands/output.js'
import { REVIEW_COMMANDS } from '../../src/commands/review-finish.js'
import { capture } from '../../src/commands/tests/support.js'
import { templateFile } from '../../src/infra/template-store.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { verifies } from '../_helpers/verifies.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'

useIsolatedEnvironment()

const TOKEN = 'ghs_secret-token-value'
const PR = '/repos/acme/demo/pulls/11'
const COMMENTS = '/repos/acme/demo/issues/11/comments'
const REVIEW_COMMENTS = '/repos/acme/demo/pulls/11/comments'
const COMMENT_URL = 'https://github.com/acme/demo/pull/11#issuecomment-1'

// 後始末の step が渡す値の組。conclusion は、Claude Code が動かなかった run では空
function ensureArguments(job: string, outcome: string, conclusion: string, token: 'true' | 'false'): readonly string[] {
  return ['--ensure', '--job-status', job, '--review-outcome', outcome, '--review-conclusion', conclusion, '--review-has-token', token]
}

const FAILED_RUN = ensureArguments('failure', 'failure', 'failure', 'true')
const CANCELLED_RUN = ensureArguments('cancelled', 'cancelled', '', 'true')
const NOT_STARTED_RUN = ensureArguments('failure', 'failure', '', 'true')
const NO_TOKEN_RUN = ensureArguments('failure', 'failure', '', 'false')
const SUCCEEDED_RUN = ensureArguments('success', 'success', 'success', 'true')

async function finish(argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['review', 'finish', 'acme/demo/11', ...argv], REVIEW_COMMANDS)
}

function prepare(environment: Readonly<Record<string, string | undefined>> = {}): void {
  setEnvironment({ PECOT_GITHUB_COM_TOKEN: TOKEN, GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: 'alice', ...environment })
}

function pullRequest(state = 'open'): ResponseRule {
  return { match: { method: 'GET', path: PR }, respond: { status: 200, body: { number: 11, state } }, times: 1 }
}

function comments(body: readonly unknown[] = []): ResponseRule {
  return { match: { method: 'GET', path: COMMENTS }, respond: { status: 200, body }, times: 1 }
}

function reviewComments(body: readonly unknown[] = []): ResponseRule {
  return { match: { method: 'GET', path: REVIEW_COMMENTS }, respond: { status: 200, body }, times: 1 }
}

function permission(value: string): ResponseRule {
  return { match: { method: 'GET', path: '/repos/acme/demo/collaborators/alice/permission' }, respond: { status: 200, body: { permission: value } }, times: 1 }
}

const POSTED: ResponseRule = { match: { method: 'POST', path: COMMENTS }, respond: { status: 201, body: { id: 1, html_url: COMMENT_URL } }, times: 1 }

function postedBody(requests: readonly RecordedRequest[]): string {
  const posted = requests.find(request => request.type === 'rest' && request.method === 'POST' && request.path === COMMENTS)
  if (posted?.type !== 'rest') throw new Error('コメントを書いていません')
  const sent = posted.body
  if (typeof sent !== 'object' || sent === null || !('body' in sent) || typeof sent.body !== 'string') throw new TypeError('コメントの本文がありません')
  return sent.body
}

function hasPosted(requests: readonly RecordedRequest[]): boolean {
  return requests.some(request => request.type === 'rest' && request.method === 'POST')
}

function executionFile(lines: readonly unknown[]): string {
  const file = path.join(makeTemporaryDirectory('pecot-review-finish-'), 'execution.json')
  writeFileSync(file, JSON.stringify(lines), 'utf8')
  return file
}

describe('review finish', () => {
  it('--ensure と job の failure で同じ実行のコメントが無いと、failed のコメントを 1 つ書き、URL を標準出力に出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-01')
    await verifies(context, 'PW-REVIEW-FINISH-14')
    prepare()
    const file = executionFile([{ type: 'result', subtype: 'error_during_execution', is_error: true }])
    const github = await startGithub([pullRequest(), comments(), POSTED])

    const outcome = await finish([...FAILED_RUN, '--execution-file', file])

    expect(outcome).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: stopped-review comment (failed) on PR acme/demo#11\n' })
    const body = postedBody(github.requests())
    expect(body).toContain('- 結果 — `failed`（途中で失敗した）')
    expect(body).toContain('- 止まった場所 — 分からない')
    expect(body).toContain('<!-- pecot-review-stopped run=500 attempt=1 -->')
    expect(`${outcome.stdout}${outcome.stderr}${body}`).not.toContain(TOKEN)
  })

  it('同じ実行・同じ試行の目印を持つ bot のコメントがあると、書かずに skipped の行を出して 0 で終わる', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-02')
    prepare()
    const github = await startGithub([pullRequest(), comments([{ body: 'x\n<!-- pecot-review-stopped run=500 attempt=1 -->', user: { type: 'Bot' } }])])

    const outcome = await finish([...CANCELLED_RUN])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (this run already posted one)\n' })
    expect(hasPosted(github.requests())).toBe(false)
  })

  it('re-run で試行の番号が違うと、前の試行の目印があっても書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-02')
    prepare({ GITHUB_RUN_ATTEMPT: '2' })
    const github = await startGithub([pullRequest(), comments([{ body: '<!-- pecot-review-stopped run=500 attempt=1 -->', user: { type: 'Bot' } }]), POSTED])

    const outcome = await finish([...CANCELLED_RUN])

    expect(outcome.code).toBe(0)
    expect(postedBody(github.requests())).toContain('<!-- pecot-review-stopped run=500 attempt=2 -->')
  })

  it('人が書いた目印は数えず、書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-02')
    prepare()
    const github = await startGithub([pullRequest(), comments([{ body: '<!-- pecot-review-stopped run=500 attempt=1 -->', user: { type: 'User' } }]), POSTED])

    await finish([...CANCELLED_RUN])

    expect(hasPosted(github.requests())).toBe(true)
  })

  it('--ensure と job の cancelled で打つと、limit のコメントを書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-03')
    prepare()
    const github = await startGithub([pullRequest(), comments(), POSTED])

    const outcome = await finish([...CANCELLED_RUN])

    expect(outcome.stderr).toBe('created: stopped-review comment (limit) on PR acme/demo#11\n')
    expect(postedBody(github.requests())).toContain('## Review stopped — 自動レビューがターンか時間の上限で止まった')
  })

  it('実行のファイルの最後の result が error_max_turns だと、limit のコメントを書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-04')
    prepare()
    const file = executionFile([{ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }])
    const github = await startGithub([pullRequest(), comments(), POSTED])

    await finish([...FAILED_RUN, '--execution-file', file])

    expect(postedBody(github.requests())).toContain('- 結果 — `limit`')
  })

  it('実行のファイルの最後の result が api_error の認証の失敗だと、トークンを作り直す手順を添えた failed のコメントを書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-05')
    prepare()
    const file = executionFile([{ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'API Error: Token exchange failed with status 401: {"error":{"type":"authentication_error"}}' }])
    const github = await startGithub([pullRequest(), comments(), POSTED])

    await finish([...FAILED_RUN, '--execution-file', file])

    const body = postedBody(github.requests())
    expect(body).toContain('- 結果 — `failed`')
    expect(body).toContain('`claude setup-token` でトークンを作り直し')
  })

  it('自動レビューの step が failure で github_token が無いと、App を入れる手順を添えた setup-missing のコメントを書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-06')
    prepare()
    const github = await startGithub([pullRequest(), comments(), POSTED])

    await finish(NO_TOKEN_RUN)

    const body = postedBody(github.requests())
    expect(body).toContain('- 結果 — `setup-missing`')
    expect(body).toContain('リポに Claude の GitHub App を入れてから')
  })

  it('Claude Code が動かずに step が落ち、起動した人が write の権限を持たないと、書かずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-07')
    prepare()
    const github = await startGithub([pullRequest(), permission('read')])

    const outcome = await finish(NOT_STARTED_RUN)

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (the actor has no write permission)\n' })
    expect(hasPosted(github.requests())).toBe(false)
  })

  it('Claude Code が動かずに step が落ち、起動した人が write の権限を持つと、failed のコメントを書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-07')
    prepare()
    const github = await startGithub([pullRequest(), permission('write'), comments(), POSTED])

    await finish(NOT_STARTED_RUN)

    expect(postedBody(github.requests())).toContain('- 結果 — `failed`')
  })

  it('起動した人の権限を読めないと、warning の行を出して書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-17')
    prepare()
    const denied: ResponseRule = { match: { method: 'GET', path: '/repos/acme/demo/collaborators/alice/permission' }, respond: { status: 403, body: { message: 'Resource not accessible by integration' } }, times: 1 }
    const github = await startGithub([pullRequest(), denied, comments(), POSTED])

    const outcome = await finish(NOT_STARTED_RUN)

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe('warning: could not read the permission of alice: access denied\ncreated: stopped-review comment (failed) on PR acme/demo#11\n')
    expect(hasPosted(github.requests())).toBe(true)
  })

  it('起動した人の名前が [bot] で終わると、権限を読まずに書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-07')
    prepare({ GITHUB_ACTOR: 'renovate[bot]' })
    const github = await startGithub([pullRequest(), comments(), POSTED])

    const outcome = await finish(NOT_STARTED_RUN)

    expect(outcome.stderr).toBe('created: stopped-review comment (failed) on PR acme/demo#11\n')
    expect(github.requests().some(request => request.type === 'rest' && request.path.includes('/collaborators/'))).toBe(false)
  })

  it('--result reviewed で打つと、PR を読まずに、書かずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-08')
    prepare()
    const github = await startGithub([])

    const outcome = await finish(['--result', 'reviewed'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (the review finished)\n' })
    expect(github.requests()).toEqual([])
  })

  it('--ensure と job の success で打つと、PR を読まずに、書かずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-09')
    prepare()
    const github = await startGithub([])

    const outcome = await finish(SUCCEEDED_RUN)

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (the job succeeded)\n' })
    expect(github.requests()).toEqual([])
  })

  it('自動レビューの step が成功で conclusion が空だと、雛形の食い違いの理由を添えて、書かずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-19')
    prepare()
    const github = await startGithub([])

    const outcome = await finish(ensureArguments('success', 'success', '', 'false'))

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (the workflow file differs from the default branch, so the action skipped the review; a review started by a comment does not run on this PR either)\n' })
    expect(github.requests()).toEqual([])
  })

  it('PR が閉じていると、書かずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-10')
    prepare()
    const github = await startGithub([pullRequest('closed')])

    const outcome = await finish(['--result', 'failed'])

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: stopped-review comment on PR acme/demo#11 (the PR is closed)\n' })
    expect(hasPosted(github.requests())).toBe(false)
  })

  it('--since より後に F-NN で始まるインラインコメントがあると、止まった場所をインラインコメントを投稿した後と書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-11')
    prepare()
    const github = await startGithub([pullRequest(), comments(), reviewComments([{ body: '**F-01** [tech] 型が違う', created_at: '2026-11-17T10:05:00Z' }]), POSTED])

    await finish([...CANCELLED_RUN, '--since', '2026-11-17T10:00:00Z'])

    expect(postedBody(github.requests())).toContain('- 止まった場所 — インラインコメントを投稿した後（指摘の一覧はまだ無い）')
  })

  it('--since より後に指摘のインラインコメントが無いと、止まった場所を指摘を投稿する前と書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-11')
    prepare()
    const github = await startGithub([pullRequest(), comments(), reviewComments([{ body: '**F-01** [tech] 前の実行', created_at: '2026-11-17T09:00:00Z' }]), POSTED])

    await finish([...CANCELLED_RUN, '--since', '2026-11-17T10:00:00Z'])

    expect(postedBody(github.requests())).toContain('- 止まった場所 — 指摘を投稿する前')
  })

  it('--since が空だと、止まった場所を分からないと書く', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-18')
    prepare()
    const github = await startGithub([pullRequest(), comments(), POSTED])

    const outcome = await finish([...CANCELLED_RUN, '--since', ''])

    expect(outcome.code).toBe(0)
    expect(postedBody(github.requests())).toContain('- 止まった場所 — 分からない')
  })

  it('GITHUB_RUN_ID が無いと、目印を付けず、PR のコメントを読まない', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-12')
    prepare({ GITHUB_RUN_ID: undefined })
    const github = await startGithub([pullRequest(), POSTED])

    await finish(['--result', 'limit'])

    expect(postedBody(github.requests())).not.toContain('pecot-review-stopped')
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'GET' && request.path === COMMENTS)).toBe(false)
  })

  it('--dry-run を付けると、PR を読み、書くはずの本文を標準出力に出し、コメントを書かない', async (context) => {
    await verifies(context, 'PW-REVIEW-FINISH-16')
    prepare()
    const github = await startGithub([pullRequest(), comments()])

    const outcome = await finish(['--result', 'limit', '--dry-run'])

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('## Review stopped — 自動レビューがターンか時間の上限で止まった')
    expect(outcome.stderr).toBe('dry-run: would create stopped-review comment (limit) on PR acme/demo#11\n')
    expect(hasPosted(github.requests())).toBe(false)
  })

  it('合言葉の環境変数があると、次にすることの文にその合言葉を書く', async () => {
    prepare({ PECOT_REVIEW_TRIGGER_PHRASE: '@my-bot review' })
    const github = await startGithub([pullRequest(), comments(), POSTED])

    await finish(['--result', 'failed'])

    expect(postedBody(github.requests())).toContain('PR に `@my-bot review` とコメントして起動し直す')
  })

  it.for([
    { name: '--result と --ensure の両方', argv: ['--result', 'failed', '--ensure', '--job-status', 'failure'], message: 'error: specify exactly one of --result and --ensure\n' },
    { name: 'どちらも無し', argv: [], message: 'error: specify exactly one of --result and --ensure\n' },
    { name: '--ensure に --job-status が無い', argv: ['--ensure'], message: 'error: --job-status is required with --ensure\n' },
    { name: '--ensure に自動レビューの step の値が無い', argv: ['--ensure', '--job-status', 'failure'], message: 'error: --review-outcome is required with --ensure\n' },
    { name: '--result に --review-has-token', argv: ['--result', 'failed', '--review-has-token', 'true'], message: 'error: --review-has-token is only for --ensure\n' },
    { name: '--result に --since', argv: ['--result', 'failed', '--since', '2026-11-17T10:00:00Z'], message: 'error: --since is only for --ensure\n' },
    { name: 'setup-missing でない --detail', argv: ['--result', 'failed', '--detail', 'x'], message: 'error: --detail is only for --result setup-missing\n' },
    { name: 'ISO 8601 でない --since', argv: [...FAILED_RUN, '--since', 'yesterday'], message: 'error: --since is not an ISO 8601 time: yesterday\n' },
  ])('$name を渡すと、何も読まずに終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-REVIEW-FINISH-13')
    prepare()
    const github = await startGithub([])

    const outcome = await finish(row.argv)

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: row.message })
    expect(github.requests()).toEqual([])
  })

  it('埋めた本文が、テンプレートの検証を通る', async () => {
    prepare()
    const github = await startGithub([pullRequest(), comments(), POSTED])
    await finish(['--result', 'setup-missing', '--detail', 'secret <X>'])
    const io = capture()

    const isViolated = hasReportedTemplateViolations(createOutput(false, io), postedBody(github.requests()), templateFile('comment', 'review-stopped'))

    expect(isViolated).toBe(false)
  })

  describe('MCP の data', () => {
    it('result の reviewed で呼ぶと、書かずに skipped を data に返す', async (context) => {
      await verifies(context, 'PW-REVIEW-FINISH-15')
      prepare()
      await startGithub([])

      const outcome = await callToolOnce(REVIEW_COMMANDS, 'review_finish', { pr_ref: 'acme/demo/11', result: 'reviewed' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ pullRequest: 'acme/demo/11', skipped: 'reviewed' })
    })

    it('コメントを書くと、結果・止まった場所・URL を data に返す', async () => {
      prepare()
      await startGithub([pullRequest(), comments(), POSTED])

      const outcome = await callToolOnce(REVIEW_COMMANDS, 'review_finish', { pr_ref: 'acme/demo/11', result: 'limit' })

      expect(outcome.structured).toMatchObject({ pullRequest: 'acme/demo/11', result: 'limit', location: 'unknown', commentUrl: COMMENT_URL })
    })
  })
})
