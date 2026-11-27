/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// auto-start の action を、inputs を置いてプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { main } from '../../src/auto-start.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import { prerequisitesData, prerequisitesRule } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runActionCase, startGithub } from '../_helpers/action-case.js'
import type { ActionResult } from '../_helpers/action-case.js'
import { addedToBoard, AUTO_TOKEN, autoResult, boardItems, bot, botResult, failing, fieldUpdated, issueComments, issueNodeId, permissionOf, prepareAuto, readOutputs, statusUpdated, writesOf } from '../_helpers/auto-case.js'
import type { AutoRunner } from '../_helpers/auto-case.js'

useIsolatedEnvironment()

const BRANCH = 'feat/fix-x/7'
const PLAN = '## Plan\n\n形式を残す。'
const ANSWER = '残してください。'
const QUESTION = autoResult('question', BRANCH)
const WAITING = { number: 7, column: 'Active', label: 'Needs Attention' }

async function start(issue = '7'): Promise<ActionResult> {
  return await runActionCase(main, { token: AUTO_TOKEN, issue })
}

function emptyContext(values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { issue: { ref: 'acme/demo/7', title: '課題7', body: '本文' }, plan: '', results: [], answers: [], withheld: 0, branch: '', pr: 0, ...values }
}

function contextFile(runner: Readonly<AutoRunner>): string {
  return path.join(runner.temporary, 'pecot-auto', 'context.json')
}

function writtenContext(runner: Readonly<AutoRunner>): unknown {
  return JSON.parse(readFileSync(contextFile(runner), 'utf8'))
}

describe('auto start', () => {
  it('ボードにあり、札を自動処理が書いていなければ、何も書かずに計画・結果・答えを JSON のファイルに書く', async (context) => {
    await verifies(context, 'PA-AUTO-START-01')
    await verifies(context, 'PA-AUTO-START-08')
    await explains('`auto-start` の action が、自動処理に渡す文脈を JSON のファイルに書くテストです。Status を自動処理が書いていない場合に、ボードへ書き込まず、計画・結果・答えをファイルに書き、権限を持たない人のコメントを `withheld` に数えることを確認します。')
    const runner = prepareAuto()
    const comments = [{ body: PLAN }, bot(QUESTION), { body: ANSWER }, { body: '別のやり方で', login: 'mallory', association: 'NONE' }]
    const github = await startGithub([
      prerequisitesRule({ number: 7, column: 'Active', branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] }),
      issueComments(comments),
      permissionOf('alice', 'write'),
      permissionOf('mallory', 'read'),
    ])

    const outcome = await start()

    expect(outcome).toEqual({ code: 0, stdout: '', stderr: 'count: withheld comments: 1\n' })
    expect(writtenContext(runner)).toEqual(emptyContext({ plan: PLAN, results: [QUESTION], answers: [{ author: 'alice', body: ANSWER }], withheld: 1, branch: BRANCH, pr: 11 }))
    expect(writesOf(github.requests())).toEqual([])
    expect(readFileSync(contextFile(runner), 'utf8')).not.toContain(AUTO_TOKEN)
  })

  it('文脈を書いたファイルのパスを、outputs の context-file に出す', async (context) => {
    await verifies(context, 'PA-AUTO-START-09')
    await explains('`auto-start` の action の outputs のテストです。文脈を JSON のファイルへ書いた場合は、そのファイルのパスを outputs の `context-file` に出すことを確認します。')
    const runner = prepareAuto()
    await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments([bot(QUESTION)])])

    await start()

    expect(readOutputs(runner.outputFile)).toEqual({ 'context-file': contextFile(runner) })
    expect(writtenContext(runner)).toEqual(emptyContext({ results: [QUESTION] }))
  })

  it('書き込み権限の無い人の計画と答えは、本文を出さずに数だけを出す', async (context) => {
    await verifies(context, 'PA-AUTO-START-02')
    await explains('計画と答えを書いた人の権限を判定する、`auto-start` の action のテストです。書き込み権限を持たない人が計画と答えを書いた場合に、その本文を文脈のファイルに書かず、数だけを `withheld` に入れることを確認します。')
    const runner = prepareAuto()
    const comments = [{ body: PLAN, login: 'bob' }, bot(QUESTION), { body: ANSWER, login: 'bob' }]
    await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments(comments), permissionOf('bob', 'read')])

    await start()

    expect(writtenContext(runner)).toEqual(emptyContext({ results: [QUESTION], withheld: 2 }))
  })

  it('ボードに無い Issue なら、進行の欄を Ready にしてボードに載せる', async (context) => {
    await verifies(context, 'PA-AUTO-START-03')
    await explains('ボードに載っていない Issue を扱う、`auto-start` の action のテストです。Issue がボードへ追加されていない場合に、進行の欄を `Ready` にして追加し、`AddToProject` と `UpdateProjectItemField` の書き込みだけを行うことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule({ number: 7 }), issueComments(), boardItems({ onBoard: false }), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const outcome = await start()

    expect(outcome.stderr).toBe('added: Issue acme/demo/7 to the board in Ready\n')
    expect(writesOf(github.requests())).toEqual(['AddToProject', 'UpdateProjectItemField'])
  })

  it.for([
    { name: 'PR が無い', spec: WAITING, key: 'todo', status: 'Todo' },
    { name: '開いた PR がある', spec: { ...WAITING, branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] }, key: 'in_progress', status: 'In Progress' },
  ])('札が自動処理の書いた Needs Attention で $name なら、札を $status に戻す', async ({ spec, key, status }, context) => {
    await verifies(context, 'PA-AUTO-START-04')
    await explains('Needs Attention になった Issue の Status を戻す、`auto-start` の action のテストです。自動処理が書いた Needs Attention の場合に、開いた PR が存在しなければ `Todo` に、存在すれば `In Progress` に戻すことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(spec), issueComments([bot(QUESTION)]), boardItems(), statusUpdated(key)])

    const outcome = await start()

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`set: Status of Issue acme/demo/7 to ${status}\n`)
    expect(writesOf(github.requests())).toEqual(['UpdateProjectItemField'])
  })

  it('札が pecot の判定の置いた Needs Attention なら、戻さない', async (context) => {
    await verifies(context, 'PA-AUTO-START-05')
    await explains('pecot の判定が置いた Needs Attention を扱う、`auto-start` の action のテストです。最後の結果を pecot の判定が書いている場合に、Status は戻さず、ボードにも書き込まないことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([botResult('pr-created')])])

    const outcome = await start()

    expect(outcome.stderr).toBe('')
    expect(writesOf(github.requests())).toEqual([])
  })

  it('issue に owner/repo/N を渡すと、そのリポの Issue を読む', async (context) => {
    await verifies(context, 'PA-AUTO-START-01')
    await explains('`auto-start` の action の input `issue` のテストです。`acme/demo/7` の形で Issue を指定した場合に、そのリポの Issue を読み、文脈を JSON のファイルに書くことを確認します。')
    const runner = prepareAuto()
    await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments()])

    const outcome = await start('acme/demo/7')

    expect(outcome.code).toBe(0)
    expect(writtenContext(runner)).toEqual(emptyContext())
  })

  it('設定に fields.status が無いと、何も読まずに project_init を案内して止まる', async (context) => {
    await verifies(context, 'PA-AUTO-START-07')
    await explains('プロジェクトの設定を検証する、`auto-start` の action のテストです。`fields.status` を持たない設定の場合に、GitHub へ何も要求せず、文脈のファイルを書かずに `project_init` を案内して step を失敗にすることを確認します。')
    const runner = prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the project config has no Status field (fields.status)\n  call project_init\n' })
    expect(github.requests()).toEqual([])
    expect(existsSync(contextFile(runner))).toBe(false)
  })

  it('戻すはずの札の選択肢が設定に無いと、書かずに project_init を案内して止まる', async (context) => {
    await verifies(context, 'PA-AUTO-START-07')
    await explains('プロジェクトの設定を検証する、`auto-start` の action のテストです。戻す Status（`Todo`）の選択肢を設定が持たない場合に、ボードへ書き込まず、`project_init` の実行を案内して step を失敗にすることを確認します。')
    prepareAuto({ missingStatus: 'todo' })
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems()])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the board has no option Todo for Status\n  call project_init\n' })
    expect(writesOf(github.requests())).toEqual([])
  })

  it('RUNNER_TEMP が無いと、何も読まずに止まる', async (context) => {
    await verifies(context, 'PA-AUTO-START-06')
    await explains('`auto-start` の action の実行環境のテストです。環境変数 `RUNNER_TEMP` が設定されていない場合に、GitHub へ何も要求せず、GitHub Actions の job で動かすよう案内して step を失敗にすることを確認します。')
    prepareAuto({}, { RUNNER_TEMP: undefined })
    const github = await startGithub([])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: RUNNER_TEMP is not set; run this action in a GitHub Actions job\n' })
    expect(github.requests()).toEqual([])
  })

  describe('ボードの読み書きの失敗', () => {
    it('ボードへの追加が失敗すると、その理由で止まる', async () => {
      await explains('ボードへの追加に失敗した場合の、`auto-start` の action のテストです。`AddToProject` の呼び出しが失敗した場合に、`could not add` で始まるエラーを出力して step を失敗にすることを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule({ number: 7 }), issueComments(), boardItems({ onBoard: false }), issueNodeId(), failing({ operation: 'AddToProject' })])

      const outcome = await start()

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not add Issue acme\/demo\/7 to the board: /u)
    })

    it('Status を戻す書き込みが失敗すると、その理由で止まる', async () => {
      await explains('Status の書き込みに失敗した場合の、`auto-start` の action のテストです。`UpdateProjectItemField` の呼び出しが失敗した場合に、`could not set the Status` で始まるエラーを出力して step を失敗にすることを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems(), failing({ operation: 'UpdateProjectItemField' })])

      const outcome = await start()

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not set the Status of Issue acme\/demo\/7 to Todo: /u)
    })

    it('Status を戻す対象でも、ボードに項目が見つからなければ、何も書き込まない', async () => {
      await explains('ボードに項目が存在しない場合の、`auto-start` の action のテストです。Status を戻す対象の Issue でも、ボード上の項目が見つからない場合に、何も書き込まず、エラーも出力しないことを確認します。')
      prepareAuto()
      const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems({ onBoard: false })])

      const outcome = await start()

      expect(outcome.code).toBe(0)
      expect(outcome.stderr).toBe('')
      expect(writesOf(github.requests())).toEqual([])
    })

    it('書いた人の権限を読めないと、warning の行を出し、その人のコメントを数だけにする', async () => {
      await explains('コメントを書いた人の権限を読み取れない場合の、`auto-start` の action のテストです。`warning` の行をログに出し、その人のコメントの本文を書かずに `withheld` へ数えて成功することを確認します。')
      const runner = prepareAuto()
      await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments([{ body: PLAN, login: 'bob' }]), failing({ method: 'GET', path: '/repos/acme/demo/collaborators/bob/permission' })])

      const outcome = await start()

      expect(outcome.code).toBe(0)
      expect(outcome.stderr).toMatch(/^warning: could not read the permission of bob: .*\ncount: withheld comments: 1\n$/su)
      expect(writtenContext(runner)).toEqual(emptyContext({ withheld: 1 }))
    })

    it('コメントの一覧を読めないと、その理由で止まる', async () => {
      await explains('Issue のコメントの一覧を読み取れない場合の、`auto-start` の action のテストです。`could not read the comments` で始まるエラーを出力して step を失敗にすることを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), failing({ method: 'GET', path: '/repos/acme/demo/issues/7/comments' })])

      const outcome = await start()

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not read the comments of Issue acme\/demo\/7: /u)
    })

    it('Issue の前提が部分エラーで読めないと、その理由で止まる', async () => {
      await explains('Issue の前提を読み取れない場合の、`auto-start` の action のテストです。`blockedBy` の読み取りが部分エラーで失敗した場合に、その理由を含むエラーを出力し、何も書き込まずに step を失敗にすることを確認します。')
      prepareAuto()
      const body = { data: prerequisitesData({ number: 7 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
      const github = await startGithub([{ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }])

      const outcome = await start()

      expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: could not read Issue acme/demo/7: blockedBy could not be read: denied\n' })
      expect(writesOf(github.requests())).toEqual([])
    })
  })
})
