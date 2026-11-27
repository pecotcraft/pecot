/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// auto finish の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AUTO_FINISH_COMMANDS } from '../../src/commands/auto-finish.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { AUTO_COMMENT_URL, AUTO_POSTED, AUTO_TOKEN, autoResult, botResult, issueComments, ISSUE_COMMENTS, LABEL_PATH, labelRemoved, postedBody, prepareAuto, statusUpdated, writesOf } from '../_helpers/auto-case.js'
import { boardItems } from '../_helpers/board-issue-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { prerequisitesData, prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { verifies } from '../_helpers/verifies.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../_helpers/explains.js'

useIsolatedEnvironment()

const BRANCH = 'feat/fix-x/7'
const ISSUE: ResponseRule = prerequisitesRule({ number: 7, column: 'Active', branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] })
const POST = `POST ${ISSUE_COMMENTS}`
const DELETE = `DELETE ${LABEL_PATH}`
const CREATED = 'created: auto result comment'
const SET_LINE = 'set: Status of Issue acme/demo/7 to Needs Attention\n'
const REMOVED_LINE = 'removed: label pecot-auto from Issue acme/demo/7\n'

async function finish(argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['auto', 'finish', 'acme/demo/7', ...argv], AUTO_FINISH_COMMANDS)
}

function textFile(name: string, text: string): string {
  const file = path.join(makeTemporaryDirectory('pecot-auto-finish-'), name)
  writeFileSync(file, text, 'utf8')
  return file
}

function ensure(job: string): readonly string[] {
  return ['--ensure', '--job-status', job]
}

describe('auto finish', () => {
  it('結果が question なら、結果のコメントを書き、Status を Needs Attention にして起動ラベルを外し、URL を標準出力に出す', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-01')
    await verifies(context, 'PW-AUTO-FINISH-15')
    await explains('`auto finish` のテストです。結果が `question` の場合に、結果のコメントを書き、Status を `Needs Attention` にして起動ラベルを外し、コメントの URL を標準出力へ出すことを確認します。')
    prepareAuto()
    const file = textFile('body.md', '形式を残すか、移すかを決めてください。')
    const github = await startGithub([ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

    const outcome = await finish(['--result', 'question', '--body-file', file])

    expect(outcome).toEqual({ code: 0, stdout: `${AUTO_COMMENT_URL}\n`, stderr: `${CREATED} (question) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}` })
    const body = postedBody(github.requests())
    expect(body).toContain('形式を残すか、移すかを決めてください。')
    expect(body).toContain(`<!-- pecot-auto: result=question run=500 attempt=1 branch=${BRANCH} -->`)
    expect(body).toContain('https://github.com/acme/demo/actions/runs/500')
    expect(writesOf(github.requests())).toEqual([POST, 'UpdateProjectItemField', DELETE])
    expect(`${outcome.stdout}${outcome.stderr}${body}`).not.toContain(AUTO_TOKEN)
  })

  it('PR を開いたブランチが Development のブランチから外れていても、目印のブランチに開いた PR の head を書く', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-16')
    await explains('`auto finish` のテストです。PR を開いたブランチが Development のブランチから外れている場合でも、目印のブランチに開いた PR の head を結果のコメントへ書くことを確認します。')
    prepareAuto()
    const file = textFile('body.md', 'PR を作った。')
    const github = await startGithub([prerequisitesRule({ number: 7, column: 'Active', pullRequests: [{ number: 11, head: BRANCH }] }), AUTO_POSTED, labelRemoved()])

    const outcome = await finish(['--result', 'pr-created', '--body-file', file])

    expect(outcome.code).toBe(0)
    expect(postedBody(github.requests())).toContain(`<!-- pecot-auto: result=pr-created run=500 attempt=1 branch=${BRANCH} -->`)
  })

  it.for([
    { result: 'pr-created', writes: [POST, DELETE], lines: REMOVED_LINE },
    { result: 'out-of-scope', writes: [POST, DELETE], lines: REMOVED_LINE },
    { result: 'ci-fix-pushed', writes: [POST], lines: '' },
    { result: 'ci-passed', writes: [POST], lines: '' },
  ])('結果が $result なら、Status を書かない', async ({ result, writes, lines }, context) => {
    await verifies(context, 'PW-AUTO-FINISH-02')
    await explains(`\`auto finish\` のテストです。結果が \`${result}\` の場合に、Status を書かず、期待する行を標準エラー出力へ出し、期待する書き込みだけを行うことを確認します。`)
    prepareAuto()
    const rules = writes.includes(DELETE) ? [ISSUE, AUTO_POSTED, labelRemoved()] : [ISSUE, AUTO_POSTED]
    const github = await startGithub(rules)

    const outcome = await finish(['--result', result])

    expect(outcome.stderr).toBe(`${CREATED} (${result}) on Issue acme/demo/7\n${lines}`)
    expect(writesOf(github.requests())).toEqual(writes)
  })

  it('起動ラベルが既に外れていても、unchanged の行を出して成功する', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-03')
    await explains('`auto finish` のテストです。起動ラベルがすでに外れている場合でも、`unchanged` の行を出して成功することを確認します。')
    prepareAuto()
    await startGithub([ISSUE, AUTO_POSTED, labelRemoved(404)])

    const outcome = await finish(['--result', 'pr-created'])

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`${CREATED} (pr-created) on Issue acme/demo/7\nunchanged: label pecot-auto on Issue acme/demo/7 (not attached)\n`)
  })

  it('PECOT_AUTO_LABEL があると、その名前のラベルを外す', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-04')
    await explains('`auto finish` のテストです。環境変数 `PECOT_AUTO_LABEL` を設定した場合に、その名前のラベルを外すことを確認します。')
    prepareAuto({}, { PECOT_AUTO_LABEL: 'my-auto' })
    const removed: ResponseRule = { match: { method: 'DELETE', path: '/repos/acme/demo/issues/7/labels/my-auto' }, respond: { status: 200, body: [] }, times: 1 }
    const github = await startGithub([ISSUE, AUTO_POSTED, removed])

    await finish(['--result', 'pr-created'])

    expect(writesOf(github.requests())).toEqual([POST, 'DELETE /repos/acme/demo/issues/7/labels/my-auto'])
  })

  it.for([
    { name: 'Issue がボードに無い', missingStatus: undefined, board: boardItems({ onBoard: false }), missing: 'Issue on the board', warning: 'warning: Issue acme/demo/7 is not on the board; the Status stays as it is\n' },
    { name: '設定に Needs Attention が無い', missingStatus: 'needs_attention', board: boardItems(), missing: 'Status option Needs Attention', warning: 'warning: the board has no option Needs Attention for Status; the Status stays as it is\n  run: pecot project init\n' },
  ])('$name と、Status を書かずに足りない設定をコメントに足し、warning の行を出して成功する', async ({ missingStatus, board, missing, warning }, context) => {
    await verifies(context, 'PW-AUTO-FINISH-05')
    await explains('`auto finish` のテストです。ボードに Issue が存在しない場合と、`Needs Attention` が設定にない場合は、Status を書かずに不足している設定をコメントへ追加することを確認します。')
    prepareAuto({ missingStatus })
    const github = await startGithub([ISSUE, board, AUTO_POSTED, labelRemoved()])

    const outcome = await finish(['--result', 'failed'])

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`${warning}${CREATED} (failed) on Issue acme/demo/7\n${REMOVED_LINE}`)
    expect(postedBody(github.requests())).toContain(`足りない設定は \`${missing}\` だ。`)
    expect(writesOf(github.requests())).toEqual([POST, DELETE])
  })

  describe('--ensure', () => {
    it('job が成功なら、何も読まずに skipped の行を出す', async (context) => {
      await verifies(context, 'PW-AUTO-FINISH-06')
      await explains('`auto finish --ensure` のテストです。job が成功した場合に、何も読まず、`skipped` の行を出して終わることを確認します。')
      prepareAuto()
      const github = await startGithub([])

      const outcome = await finish(ensure('success'))

      expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'skipped: auto result comment on Issue acme/demo/7 (the job succeeded and the skill wrote the result)\n' })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'job が cancelled', argv: ensure('cancelled'), lines: [], expected: 'limit' },
      { name: '最後の result が error_max_turns', argv: ensure('failure'), lines: [{ type: 'result', subtype: 'error_max_turns', is_error: true }], expected: 'limit' },
      { name: 'ほかの失敗', argv: ensure('failure'), lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true }], expected: 'failed' },
    ])('$name なら、$expected の結果のコメントを書く', async ({ argv, lines, expected }, context) => {
      await verifies(context, 'PW-AUTO-FINISH-07')
      await explains(`\`auto finish --ensure\` のテストです。job が \`cancelled\` や失敗で終わった場合に、実行の記録から \`${expected}\` の結果のコメントを書くことを確認します。`)
      prepareAuto()
      const file = textFile('execution.json', JSON.stringify(lines))
      const github = await startGithub([issueComments([botResult('question', '400')]), ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

      const outcome = await finish([...argv, '--execution-file', file])

      expect(outcome.stderr).toBe(`${CREATED} (${expected}) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}`)
      expect(postedBody(github.requests())).toContain(`result=${expected} run=500 attempt=1`)
    })

    it('同じ run・同じ試行の結果のコメントがあると、コメントを書かずに Status とラベルを書き直す', async (context) => {
      await verifies(context, 'PW-AUTO-FINISH-08')
      await explains('`auto finish --ensure` のテストです。同じ run と同じ試行の結果のコメントがすでにある場合に、コメントを書かず、Status とラベルを書き直すことを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments([botResult('question', '500')]), boardItems(), statusUpdated('needs_attention'), labelRemoved(404)])

      const outcome = await finish(ensure('failure'))

      expect(outcome).toEqual({
        code: 0,
        stdout: '',
        stderr: `${SET_LINE}unchanged: label pecot-auto on Issue acme/demo/7 (not attached)\nskipped: auto result comment on Issue acme/demo/7 (this run already posted one)\n`,
      })
      expect(writesOf(github.requests())).toEqual(['UpdateProjectItemField', DELETE])
    })

    it('人が書いた同じ目印は数えず、書く', async (context) => {
      await verifies(context, 'PW-AUTO-FINISH-08')
      await explains('`auto finish --ensure` のテストです。人が書いた同じ目印のコメントがある場合に、それを数えず、結果のコメントを書くことを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments([{ body: autoResult('question', BRANCH, '500') }]), ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

      await finish(ensure('cancelled'))

      expect(writesOf(github.requests())).toContain(POST)
    })
  })

  it('GITHUB_RUN_ID が無いと、目印を付けずに書き、コメントを読まない', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-09')
    await explains('`auto finish` のテストです。`GITHUB_RUN_ID` が無い場合に、目印を付けずにコメントを書き、既存のコメントを読まないことを確認します。')
    prepareAuto({}, { GITHUB_RUN_ID: undefined })
    const github = await startGithub([ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

    await finish(ensure('cancelled'))

    const body = postedBody(github.requests())
    expect(body).not.toContain('pecot-auto:')
    expect(body).toContain('分からない（`GITHUB_RUN_ID` が無い）')
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'GET' && request.path === ISSUE_COMMENTS)).toBe(false)
  })

  it('GITHUB_RUN_ATTEMPT が無いと、1 回目の試行として書く', async () => {
    await explains('`auto finish` のテストです。`GITHUB_RUN_ATTEMPT` が無い場合に、1 回目の試行としてコメントを書くことを確認します。')
    prepareAuto({}, { GITHUB_RUN_ATTEMPT: undefined })
    const github = await startGithub([issueComments(), ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()])

    await finish(ensure('cancelled'))

    expect(postedBody(github.requests())).toContain('run=500 attempt=1 ')
  })

  it('Issue の前提が部分エラーで読めないと、書かずにその理由で止まる', async () => {
    await explains('`auto finish` のテストです。Issue の前提が部分エラーで読めない場合に、何も書かず、その理由を示して終了コード 1 で止まることを確認します。')
    prepareAuto()
    const body = { data: prerequisitesData({ number: 7 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
    const github = await startGithub([{ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }])

    const outcome = await finish(['--result', 'failed'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: could not read Issue acme/demo/7: blockedBy could not be read: denied\n' })
    expect(writesOf(github.requests())).toEqual([])
  })

  it.for([
    { name: '--result と --ensure の両方', argv: ['--result', 'failed', ...ensure('failure')], message: 'error: specify exactly one of --result and --ensure\n' },
    { name: 'どちらも無し', argv: [], message: 'error: specify exactly one of --result and --ensure\n' },
    { name: '--ensure に --job-status が無い', argv: ['--ensure'], message: 'error: --job-status is required with --ensure\n' },
    { name: '--result に --job-status', argv: ['--result', 'failed', '--job-status', 'failure'], message: 'error: --job-status is only for --ensure\n' },
    { name: '--ensure に --body-file', argv: [...ensure('failure'), '--body-file', 'x.md'], message: 'error: --body-file is only for --result\n' },
  ])('$name を渡すと、何も読まずに終了コード 1 で終わる', async ({ argv, message }, context) => {
    await verifies(context, 'PW-AUTO-FINISH-10')
    await explains('`auto finish` のテストです。`--result` と `--ensure` の指定が誤っている場合に、何も読まず、期待するエラーを出して終了コード 1 で終わることを確認します。')
    prepareAuto()
    const github = await startGithub([])

    const outcome = await finish(argv)

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: message })
    expect(github.requests()).toEqual([])
  })

  it('--dry-run なら、書くはずの本文を標準出力に出し、コメント・Status・ラベルを書かない', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-11')
    await explains('`auto finish` のテストです。`--dry-run` を付けた場合に、書くはずの本文を標準出力へ出し、コメント・Status・ラベルを書かないことを確認します。')
    prepareAuto()
    const github = await startGithub([ISSUE, boardItems()])

    const outcome = await finish(['--result', 'limit', '--dry-run'])

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('## Auto result')
    expect(outcome.stderr).toBe('dry-run: would create auto result comment (limit) on Issue acme/demo/7\ndry-run: would set Status of Issue acme/demo/7 to Needs Attention\ndry-run: would remove label pecot-auto from Issue acme/demo/7\n')
    expect(writesOf(github.requests())).toEqual([])
  })

  it('設定に fields.status が無いと、何も読まずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-12')
    await explains('`auto finish` のテストです。設定に `fields.status` が無い場合に、何も読まず、`project init` を案内して終了コード 1 で止まることを確認します。')
    prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await finish(['--result', 'failed'])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the project config has no Status field (fields.status)\n  run: pecot project init\n' })
    expect(github.requests()).toEqual([])
  })

  it('--body-file のファイルが無いと、何も読まずに入力の誤りで止まる', async (context) => {
    await verifies(context, 'PW-AUTO-FINISH-10')
    await explains('`auto finish` のテストです。`--body-file` のファイルが存在しない場合に、何も読まず、入力の誤りとして終了コード 1 で止まることを確認します。')
    prepareAuto()
    const file = path.join(makeTemporaryDirectory('pecot-auto-finish-'), 'missing.md')
    const github = await startGithub([])

    const outcome = await finish(['--result', 'question', '--body-file', file])

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: `error: --body-file does not exist: ${file}\n` })
    expect(github.requests()).toEqual([])
  })

  describe('MCP の data', () => {
    it('コメントを書くと、結果と URL を返す', async (context) => {
      await verifies(context, 'PW-AUTO-FINISH-13')
      await explains('MCP の `auto_finish` のテストです。結果を `pr-created` にして呼び出した場合に、コメントを書き、結果とコメントの URL を返すことを確認します。')
      prepareAuto()
      await startGithub([ISSUE, AUTO_POSTED, labelRemoved()])

      const outcome = await callToolOnce(AUTO_FINISH_COMMANDS, 'auto_finish', { issue_ref: 'acme/demo/7', result: 'pr-created' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', result: 'pr-created', commentUrl: AUTO_COMMENT_URL })
    })

    it('ensure で job が成功なら、書かずに skipped を返す', async (context) => {
      await verifies(context, 'PW-AUTO-FINISH-14')
      await explains('MCP の `auto_finish` のテストです。`ensure` を指定して job が成功した場合に、何も書かず、`skipped` を返すことを確認します。')
      prepareAuto()
      await startGithub([])

      const outcome = await callToolOnce(AUTO_FINISH_COMMANDS, 'auto_finish', { issue_ref: 'acme/demo/7', ensure: true, job_status: 'success' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', skipped: 'job-succeeded' })
    })
  })
})
