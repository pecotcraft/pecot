/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// auto-finish の action を、inputs を置いてプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { main } from '../../src/auto-finish.js'
import { NO_RESULT_TEXT, START_FAILED_TEXT } from '../../src/commands/auto-finish.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { prerequisitesData, prerequisitesRule } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { makeTemporaryDirectory } from '../../../libs/workflow-core/tests/_helpers/temporary.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runActionCase, startGithub } from '../_helpers/action-case.js'
import type { ActionResult } from '../_helpers/action-case.js'
import { AUTO_COMMENT_URL, AUTO_POSTED, AUTO_TOKEN, autoResult, boardItems, botResult, failing, issueComments, ISSUE_COMMENTS, LABEL_PATH, labelRemoved, postedBody, prepareAuto, statusUpdated, writesOf } from '../_helpers/auto-case.js'

useIsolatedEnvironment()

const BRANCH = 'feat/fix-x/7'
const ISSUE: ResponseRule = prerequisitesRule({ number: 7, column: 'Active', branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] })
const POST = `POST ${ISSUE_COMMENTS}`
const DELETE = `DELETE ${LABEL_PATH}`
const CREATED = 'created: auto result comment'
const SET_LINE = 'set: Status of Issue acme/demo/7 to Needs Attention\n'
const REMOVED_LINE = 'removed: label pecot-auto from Issue acme/demo/7\n'

// 結果が Needs Attention を書くときの、コメントの読み取りから書き込みまでの応答
const WAITING_WRITES: readonly ResponseRule[] = [ISSUE, boardItems(), AUTO_POSTED, statusUpdated('needs_attention'), labelRemoved()]

async function finish(inputs: Readonly<Record<string, string | undefined>>): Promise<ActionResult> {
  return await runActionCase(main, { token: AUTO_TOKEN, issue: '7', ...inputs })
}

function textFile(name: string, text: string): string {
  const file = path.join(makeTemporaryDirectory('pecot-auto-finish-'), name)
  writeFileSync(file, text, 'utf8')
  return file
}

function ensure(job: string, start = 'success'): Readonly<Record<string, string>> {
  return { 'job-status': job, 'start-outcome': start }
}

function missingFile(): string {
  return path.join(makeTemporaryDirectory('pecot-auto-finish-'), 'result.md')
}

describe('auto finish', () => {
  it('結果が question なら、結果のコメントを書き、Status を Needs Attention にして起動ラベルを外し、URL を標準出力に出す', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-01')
    await verifies(context, 'PA-AUTO-FINISH-15')
    await explains('`auto-finish` の action のテストです。結果が `question` の場合に、結果のコメントを書き、Status を `Needs Attention` にして起動ラベルを外し、コメントの URL を標準出力へ出すことを確認します。')
    prepareAuto()
    const file = textFile('body.md', '形式を残すか、移すかを決めてください。')
    const github = await startGithub([issueComments(), ...WAITING_WRITES])

    const outcome = await finish({ 'result': 'question', 'body-file': file })

    expect(outcome).toEqual({ code: 0, stdout: `${AUTO_COMMENT_URL}\n`, stderr: `${CREATED} (question) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}` })
    const body = postedBody(github.requests())
    expect(body).toContain('形式を残すか、移すかを決めてください。')
    expect(body).toContain(`<!-- pecot-auto: result=question run=500 attempt=1 branch=${BRANCH} -->`)
    expect(body).toContain('https://github.com/acme/demo/actions/runs/500')
    expect(writesOf(github.requests())).toEqual([POST, 'UpdateProjectItemField', DELETE])
    expect(`${outcome.stdout}${outcome.stderr}${body}`).not.toContain(AUTO_TOKEN)
  })

  it('PR を開いたブランチが Development のブランチから外れていても、目印のブランチに開いた PR の head を書く', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-16')
    await explains('`auto-finish` の action のテストです。PR を開いたブランチが Development のブランチから外れている場合でも、目印のブランチに開いた PR の head を結果のコメントへ書くことを確認します。')
    prepareAuto()
    const file = textFile('body.md', 'PR を作った。')
    const github = await startGithub([issueComments(), prerequisitesRule({ number: 7, column: 'Active', pullRequests: [{ number: 11, head: BRANCH }] }), AUTO_POSTED, labelRemoved()])

    const outcome = await finish({ 'result': 'pr-created', 'body-file': file })

    expect(outcome.code).toBe(0)
    expect(postedBody(github.requests())).toContain(`<!-- pecot-auto: result=pr-created run=500 attempt=1 branch=${BRANCH} -->`)
  })

  it.for([
    { result: 'pr-created', writes: [POST, DELETE], lines: REMOVED_LINE },
    { result: 'out-of-scope', writes: [POST, DELETE], lines: REMOVED_LINE },
    { result: 'ci-fix-pushed', writes: [POST], lines: '' },
    { result: 'ci-passed', writes: [POST], lines: '' },
  ])('結果が $result なら、Status を書かない', async ({ result, writes, lines }, context) => {
    await verifies(context, 'PA-AUTO-FINISH-02')
    await explains(`\`auto-finish\` の action のテストです。結果が \`${result}\` の場合に、Status を書かず、期待する行を出し、期待する書き込みだけを行うことを確認します。`)
    prepareAuto()
    const rules = writes.includes(DELETE) ? [issueComments(), ISSUE, AUTO_POSTED, labelRemoved()] : [issueComments(), ISSUE, AUTO_POSTED]
    const github = await startGithub(rules)

    const outcome = await finish({ result })

    expect(outcome.stderr).toBe(`${CREATED} (${result}) on Issue acme/demo/7\n${lines}`)
    expect(writesOf(github.requests())).toEqual(writes)
  })

  it('起動ラベルが既に外れていても、unchanged の行を出して成功する', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-03')
    await explains('`auto-finish` の action のテストです。起動ラベルがすでに外れている場合でも、`unchanged` の行を出して成功することを確認します。')
    prepareAuto()
    await startGithub([issueComments(), ISSUE, AUTO_POSTED, labelRemoved(404)])

    const outcome = await finish({ result: 'pr-created' })

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`${CREATED} (pr-created) on Issue acme/demo/7\nunchanged: label pecot-auto on Issue acme/demo/7 (not attached)\n`)
  })

  it('PECOT_AUTO_LABEL があると、その名前のラベルを外す', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-04')
    await explains('`auto-finish` の action のテストです。環境変数 `PECOT_AUTO_LABEL` を設定した場合に、その名前のラベルを外すことを確認します。')
    prepareAuto({}, { PECOT_AUTO_LABEL: 'my-auto' })
    const removed: ResponseRule = { match: { method: 'DELETE', path: '/repos/acme/demo/issues/7/labels/my-auto' }, respond: { status: 200, body: [] }, times: 1 }
    const github = await startGithub([issueComments(), ISSUE, AUTO_POSTED, removed])

    await finish({ result: 'pr-created' })

    expect(writesOf(github.requests())).toEqual([POST, 'DELETE /repos/acme/demo/issues/7/labels/my-auto'])
  })

  it.for([
    { name: 'Issue がボードに無い', missingStatus: undefined, board: boardItems({ onBoard: false }), missing: 'Issue on the board', warning: 'warning: Issue acme/demo/7 is not on the board; the Status stays as it is\n' },
    { name: '設定に Needs Attention が無い', missingStatus: 'needs_attention', board: boardItems(), missing: 'Status option Needs Attention', warning: 'warning: the board has no option Needs Attention for Status; the Status stays as it is\n  run: pecot project init\n' },
  ])('$name と、Status を書かずに足りない設定をコメントに足し、warning の行を出して成功する', async ({ missingStatus, board, missing, warning }, context) => {
    await verifies(context, 'PA-AUTO-FINISH-05')
    await explains('`auto-finish` の action のテストです。ボードに Issue が存在しない場合と、`Needs Attention` が設定にない場合は、Status を書かずに不足している設定をコメントへ追加することを確認します。')
    prepareAuto({ missingStatus })
    const github = await startGithub([issueComments(), ISSUE, board, AUTO_POSTED, labelRemoved()])

    const outcome = await finish({ result: 'failed' })

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`${warning}${CREATED} (failed) on Issue acme/demo/7\n${REMOVED_LINE}`)
    expect(postedBody(github.requests())).toContain(`足りない設定は \`${missing}\` だ。`)
    expect(writesOf(github.requests())).toEqual([POST, DELETE])
  })

  describe('job の様子から結果を決める', () => {
    it('Start の step が成功していなければ、結果のファイルがあっても setup-missing を Start の失敗の本文で書く', async (context) => {
      await verifies(context, 'PA-AUTO-FINISH-11')
      await explains('`auto-finish` の action のテストです。Start の step が成功していない場合に、結果のファイルがあっても、Start の失敗を本文にして `setup-missing` を書くことを確認します。')
      prepareAuto()
      const file = textFile('result.md', '---\nresult: pr-created\n---\nPR を作った。\n')
      const github = await startGithub([issueComments(), ISSUE, AUTO_POSTED, labelRemoved()])

      const outcome = await finish({ ...ensure('failure', 'failure'), 'result-file': file })

      expect(outcome.stderr).toBe(`${CREATED} (setup-missing) on Issue acme/demo/7\n${REMOVED_LINE}`)
      const body = postedBody(github.requests())
      expect(body).toContain('result=setup-missing run=500 attempt=1')
      expect(body).toContain(START_FAILED_TEXT)
    })

    it('結果のファイルがあれば、job が失敗でも、frontmatter の result と本文をそのまま書く', async (context) => {
      await verifies(context, 'PA-AUTO-FINISH-13')
      await explains('`auto-finish` の action のテストです。結果のファイルがある場合に、job が失敗していても、frontmatter の `result` と HTML のコメントを除いた本文を書くことを確認します。')
      prepareAuto()
      const file = textFile('result.md', '---\nresult: question\n---\n<!-- 見本の注記 -->\n形式を残すか、移すかを決めてください。\n')
      const github = await startGithub([issueComments(), ...WAITING_WRITES])

      const outcome = await finish({ ...ensure('failure'), 'result-file': file, 'execution-file': textFile('execution.json', '[]') })

      expect(outcome).toEqual({ code: 0, stdout: `${AUTO_COMMENT_URL}\n`, stderr: `${CREATED} (question) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}` })
      const body = postedBody(github.requests())
      expect(body).toContain('result=question run=500 attempt=1')
      expect(body).toContain('形式を残すか、移すかを決めてください。')
      expect(body).not.toContain('見本の注記')
    })

    it('結果のファイルの本文が空なら、本文を足さずに frontmatter の result を書く', async (context) => {
      await verifies(context, 'PA-AUTO-FINISH-13')
      await explains('`auto-finish` の action のテストです。結果のファイルの本文が空の場合に、本文を追加せずに frontmatter の `result` を書くことを確認します。')
      prepareAuto()
      const file = textFile('result.md', '---\nresult: pr-created\n---\n')
      const github = await startGithub([issueComments(), ISSUE, AUTO_POSTED, labelRemoved()])

      const outcome = await finish({ ...ensure('success'), 'result-file': file })

      expect(outcome.stderr).toBe(`${CREATED} (pr-created) on Issue acme/demo/7\n${REMOVED_LINE}`)
      expect(postedBody(github.requests())).toContain('result=pr-created run=500 attempt=1')
    })

    it.for([
      { name: 'frontmatter が無い', text: '形式を残す。\n', warning: 'the result file has no frontmatter; writing failed', reason: 'frontmatter が無い' },
      { name: 'result が決まった値でない', text: '---\nresult: done\n---\n形式を残す。\n', warning: 'the result file has no result of a known kind; writing failed', reason: 'frontmatter の `result` が決まった値でない' },
      { name: 'frontmatter が YAML でない', text: '---\nresult: question\nresult: failed\n---\n形式を残す。\n', warning: 'the result file has no result of a known kind; writing failed', reason: 'frontmatter の `result` が決まった値でない' },
    ])('結果のファイルの $name と、warning の行を出し、読めなかった理由を本文にして failed を書く', async ({ text, warning, reason }, context) => {
      await verifies(context, 'PA-AUTO-FINISH-14')
      await explains('`auto-finish` の action のテストです。frontmatter が無いなど、結果のファイルを読めない場合に、`warning` の行を出し、読めなかった理由を本文にして `failed` を書くことを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments(), ...WAITING_WRITES])

      const outcome = await finish({ ...ensure('success'), 'result-file': textFile('result.md', text) })

      expect(outcome.code).toBe(0)
      expect(outcome.stderr).toBe(`warning: ${warning}\n${CREATED} (failed) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}`)
      expect(postedBody(github.requests())).toContain(`スキルが書いた結果のファイルを読めなかった（${reason}）。`)
    })

    it('結果のファイルが無く job が成功なら、スキルが書かずに終わったことを本文にして failed を書く', async (context) => {
      await verifies(context, 'PA-AUTO-FINISH-06')
      await explains('`auto-finish` の action のテストです。結果のファイルが無く job が成功した場合に、スキルが結果を書かずに終わったことを本文にして `failed` を書くことを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments(), ...WAITING_WRITES])

      const outcome = await finish({ ...ensure('success'), 'result-file': missingFile() })

      expect(outcome.stderr).toBe(`${CREATED} (failed) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}`)
      const body = postedBody(github.requests())
      expect(body).toContain('result=failed run=500 attempt=1')
      expect(body).toContain(NO_RESULT_TEXT)
    })

    it.for([
      { name: 'job が cancelled', job: 'cancelled', lines: [], expected: 'limit' },
      { name: '最後の result が error_max_turns', job: 'failure', lines: [{ type: 'result', subtype: 'error_max_turns', is_error: true }], expected: 'limit' },
      { name: 'ほかの失敗', job: 'failure', lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true }], expected: 'failed' },
    ])('結果のファイルが無く $name なら、$expected の結果のコメントを書く', async ({ job, lines, expected }, context) => {
      await verifies(context, 'PA-AUTO-FINISH-07')
      await explains(`\`auto-finish\` の action のテストです。結果のファイルが無く、job が \`cancelled\` や失敗で終わった場合に、実行の記録から \`${expected}\` の結果のコメントを書くことを確認します。`)
      prepareAuto()
      const file = textFile('execution.json', JSON.stringify(lines))
      const github = await startGithub([issueComments([botResult('question', '400')]), ...WAITING_WRITES])

      const outcome = await finish({ ...ensure(job), 'execution-file': file, 'result-file': missingFile() })

      expect(outcome.stderr).toBe(`${CREATED} (${expected}) on Issue acme/demo/7\n${SET_LINE}${REMOVED_LINE}`)
      expect(postedBody(github.requests())).toContain(`result=${expected} run=500 attempt=1`)
    })

    it('同じ run・同じ試行の結果のコメントがあると、コメントを書かずに Status とラベルを書き直す', async (context) => {
      await verifies(context, 'PA-AUTO-FINISH-08')
      await explains('`auto-finish` の action のテストです。同じ run と同じ試行の結果のコメントがすでにある場合に、コメントを書かず、Status とラベルを書き直すことを確認します。')
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
      await verifies(context, 'PA-AUTO-FINISH-08')
      await explains('`auto-finish` の action のテストです。人が書いた同じ目印のコメントがある場合に、それを数えず、結果のコメントを書くことを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments([{ body: autoResult('question', BRANCH, '500') }]), ...WAITING_WRITES])

      await finish(ensure('cancelled'))

      expect(writesOf(github.requests())).toContain(POST)
    })
  })

  it('result を渡しても、同じ run・同じ試行の結果のコメントがあると、コメントを書かない', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-08')
    await explains('`auto-finish` の action のテストです。input の `result` を渡した場合でも、同じ run と同じ試行の結果のコメントがあれば、コメントを書かずに起動ラベルだけを外すことを確認します。')
    prepareAuto()
    const github = await startGithub([issueComments([botResult('setup-missing', '500')]), labelRemoved()])

    const outcome = await finish({ result: 'setup-missing' })

    expect(outcome.stderr).toBe(`${REMOVED_LINE}skipped: auto result comment on Issue acme/demo/7 (this run already posted one)\n`)
    expect(writesOf(github.requests())).toEqual([DELETE])
  })

  it('GITHUB_RUN_ID が無いと、目印を付けずに書き、コメントを読まない', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-09')
    await explains('`auto-finish` の action のテストです。`GITHUB_RUN_ID` が無い場合に、目印を付けずにコメントを書き、既存のコメントを読まないことを確認します。')
    prepareAuto({}, { GITHUB_RUN_ID: undefined })
    const github = await startGithub(WAITING_WRITES)

    await finish(ensure('cancelled'))

    const body = postedBody(github.requests())
    expect(body).not.toContain('pecot-auto:')
    expect(body).toContain('分からない（`GITHUB_RUN_ID` が無い）')
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'GET' && request.path === ISSUE_COMMENTS)).toBe(false)
  })

  it('GITHUB_RUN_ATTEMPT が無いと、1 回目の試行として書く', async () => {
    await explains('`auto-finish` の action のテストです。`GITHUB_RUN_ATTEMPT` が無い場合に、1 回目の試行としてコメントを書くことを確認します。')
    prepareAuto({}, { GITHUB_RUN_ATTEMPT: undefined })
    const github = await startGithub([issueComments(), ...WAITING_WRITES])

    await finish(ensure('cancelled'))

    expect(postedBody(github.requests())).toContain('run=500 attempt=1 ')
  })

  it('Issue の前提が部分エラーで読めないと、書かずにその理由で止まる', async () => {
    await explains('`auto-finish` の action のテストです。Issue の前提が部分エラーで読めない場合に、何も書かず、その理由を示して step を失敗にすることを確認します。')
    prepareAuto()
    const body = { data: prerequisitesData({ number: 7 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
    const github = await startGithub([issueComments(), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }])

    const outcome = await finish({ result: 'failed' })

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: could not read Issue acme/demo/7: blockedBy could not be read: denied\n' })
    expect(writesOf(github.requests())).toEqual([])
  })

  it.for([
    { name: 'result と job-status', inputs: { 'result': 'failed', 'job-status': 'failure' }, message: 'error: job-status is not used with result\n' },
    { name: 'result と result-file', inputs: { 'result': 'failed', 'result-file': 'result.md' }, message: 'error: result-file is not used with result\n' },
    { name: 'result の無い body-file', inputs: { ...ensure('failure'), 'body-file': 'x.md' }, message: 'error: body-file is only for result\n' },
    { name: 'result と job-status の無い入力', inputs: {}, message: 'error: job-status is required without result\n' },
    { name: 'result の無い start-outcome 無し', inputs: { 'job-status': 'failure' }, message: 'error: start-outcome is required without result\n' },
  ])('$name を渡すと、何も読まずに終了コード 1 で終わる', async ({ inputs, message }, context) => {
    await verifies(context, 'PA-AUTO-FINISH-10')
    await explains('`auto-finish` の action のテストです。input の組み合わせが誤っている場合に、何も読まず、期待するエラーを出して step を失敗にすることを確認します。')
    prepareAuto()
    const github = await startGithub([])

    const outcome = await finish(inputs)

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: message })
    expect(github.requests()).toEqual([])
  })

  it('job-status に決まった値でない文字を渡すと、何も読まずに入力の誤りで止まる', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-10')
    await explains('`auto-finish` の action のテストです。`job-status` に決まった値でない文字を渡した場合に、何も読まず、入力の誤りとして step を失敗にすることを確認します。')
    prepareAuto()
    const github = await startGithub([])

    const outcome = await finish(ensure('skipped'))

    expect(outcome.code).toBe(2)
    expect(outcome.stderr).toMatch(/^error: invalid input: .*job_status/su)
    expect(github.requests()).toEqual([])
  })

  it('設定に fields.status が無いと、何も読まずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-12')
    await explains('`auto-finish` の action のテストです。設定に `fields.status` が無い場合に、何も読まず、`project init` を案内して step を失敗にすることを確認します。')
    prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await finish({ result: 'failed' })

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the project config has no Status field (fields.status)\n  run: pecot project init\n' })
    expect(github.requests()).toEqual([])
  })

  describe('GitHub の読み書きの失敗', () => {
    it('コメントの一覧を読めないと、書かずにその理由で止まる', async () => {
      await explains('`auto-finish` の action のテストです。Issue のコメントの一覧を読めない場合に、何も書かず、その理由を示して step を失敗にすることを確認します。')
      prepareAuto()
      const github = await startGithub([failing({ method: 'GET', path: ISSUE_COMMENTS })])

      const outcome = await finish({ result: 'failed' })

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not read the comments of Issue acme\/demo\/7: /u)
      expect(writesOf(github.requests())).toEqual([])
    })

    it('コメントの書き込みが失敗すると、Status とラベルを書かずにその理由で止まる', async () => {
      await explains('`auto-finish` の action のテストです。結果のコメントの書き込みが失敗した場合に、Status とラベルを書かず、その理由を示して step を失敗にすることを確認します。')
      prepareAuto()
      const github = await startGithub([issueComments(), ISSUE, boardItems(), failing({ method: 'POST', path: ISSUE_COMMENTS })])

      const outcome = await finish({ result: 'question' })

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not create a comment on Issue acme\/demo\/7: /u)
      expect(writesOf(github.requests())).toEqual([POST])
    })

    it('Status の書き込みが失敗すると、コメントを書いた行の後にその理由で止まる', async () => {
      await explains('`auto-finish` の action のテストです。Status の書き込みが失敗した場合に、コメントを書いた行の後にその理由を出し、step を失敗にすることを確認します。')
      prepareAuto()
      await startGithub([issueComments(), ISSUE, boardItems(), AUTO_POSTED, failing({ operation: 'UpdateProjectItemField' })])

      const outcome = await finish({ result: 'question' })

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^created: auto result comment \(question\) on Issue acme\/demo\/7\nerror: could not set the Status of Issue acme\/demo\/7 to Needs Attention: /u)
    })

    it('起動ラベルを外す書き込みが失敗すると、その理由で止まる', async () => {
      await explains('`auto-finish` の action のテストです。起動ラベルを外す書き込みが失敗した場合に、その理由を示して step を失敗にすることを確認します。')
      prepareAuto()
      await startGithub([issueComments(), ISSUE, AUTO_POSTED, failing({ method: 'DELETE', path: LABEL_PATH })])

      const outcome = await finish({ result: 'pr-created' })

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/\nerror: could not remove the label pecot-auto from Issue acme\/demo\/7: /u)
    })
  })

  it('body-file のファイルが無いと、何も読まずに入力の誤りで止まる', async (context) => {
    await verifies(context, 'PA-AUTO-FINISH-10')
    await explains('`auto-finish` の action のテストです。`body-file` に存在しないファイルを渡した場合に、何も読まず、入力の誤りとして step を失敗にすることを確認します。')
    prepareAuto()
    const file = path.join(makeTemporaryDirectory('pecot-auto-finish-'), 'missing.md')
    const github = await startGithub([])

    const outcome = await finish({ 'result': 'question', 'body-file': file })

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: `error: body-file does not exist: ${file}\n` })
    expect(github.requests()).toEqual([])
  })
})
