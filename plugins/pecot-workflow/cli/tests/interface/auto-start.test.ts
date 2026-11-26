// auto start の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

import { AUTO_START_COMMANDS } from '../../src/commands/auto-start.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { AUTO_TOKEN, autoResult, bot, botResult, issueComments, permissionOf, prepareAuto, statusUpdated, writesOf } from '../_helpers/auto-case.js'
import { addedToBoard, boardItems, failing, fieldUpdated, issueNodeId } from '../_helpers/board-issue-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { prerequisitesData, prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const BRANCH = 'feat/fix-x/7'
const PLAN = '## Plan\n\n形式を残す。'
const ANSWER = '残してください。'
const QUESTION = autoResult('question', BRANCH)
const WAITING = { number: 7, column: 'Active', label: 'Needs Attention' }

async function start(argv: readonly string[] = []): Promise<CliResult> {
  return await runInProcess(['auto', 'start', 'acme/demo/7', ...argv], AUTO_START_COMMANDS)
}

function emptyContext(values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { issue: { ref: 'acme/demo/7', title: '課題7', body: '本文' }, plan: '', results: [], answers: [], withheld: 0, branch: '', pr: 0, ...values }
}

describe('auto start', () => {
  it('ボードにあり、Status を自動処理が書いていなければ、何も書かずに計画・結果・答えを JSON で出す', async (context) => {
    await verifies(context, 'PW-AUTO-START-01')
    await verifies(context, 'PW-AUTO-START-08')
    await explains('`auto start` が、自動処理に渡す文脈を JSON で出力するテストです。ボード上の Issue の Status を自動処理が書いていない場合に、何も書き込まず、計画・結果・答えを出力し、権限を持たない人のコメントを `withheld` に数えることを確認します。')
    prepareAuto()
    const comments = [{ body: PLAN }, bot(QUESTION), { body: ANSWER }, { body: '別のやり方で', login: 'mallory', association: 'NONE' }]
    const github = await startGithub([
      prerequisitesRule({ number: 7, column: 'Active', branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] }),
      issueComments(comments),
      permissionOf('alice', 'write'),
      permissionOf('mallory', 'read'),
    ])

    const outcome = await start()

    expect(outcome.code).toBe(0)
    expect(JSON.parse(outcome.stdout)).toEqual(emptyContext({ plan: PLAN, results: [QUESTION], answers: [{ author: 'alice', body: ANSWER }], withheld: 1, branch: BRANCH, pr: 11 }))
    expect(outcome.stderr).toBe('count: withheld comments: 1\n')
    expect(writesOf(github.requests())).toEqual([])
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain(AUTO_TOKEN)
  })

  it('書き込み権限の無い人の計画と答えは、本文を出さずに数だけを出す', async (context) => {
    await verifies(context, 'PW-AUTO-START-02')
    await explains('計画と答えを書いた人の権限を判定する、`auto start` のテストです。書き込み権限を持たない人が計画と答えを書いた場合に、その本文を出力せず、数だけを `withheld` に入れることを確認します。')
    prepareAuto()
    const comments = [{ body: PLAN, login: 'bob' }, bot(QUESTION), { body: ANSWER, login: 'bob' }]
    await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments(comments), permissionOf('bob', 'read')])

    const outcome = await start()

    expect(JSON.parse(outcome.stdout)).toEqual(emptyContext({ results: [QUESTION], withheld: 2 }))
  })

  it('ボードに無い Issue なら、進行の欄を Ready にしてボードに載せる', async (context) => {
    await verifies(context, 'PW-AUTO-START-03')
    await explains('ボードに載っていない Issue を扱う、`auto start` のテストです。Issue がボードへ追加されていない場合に、進行の欄を `Ready` にして追加し、`AddToProject` と `UpdateProjectItemField` の書き込みだけを行うことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule({ number: 7 }), issueComments(), boardItems({ onBoard: false }), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const outcome = await start()

    expect(outcome.stderr).toBe('added: Issue acme/demo/7 to the board in Ready\n')
    expect(writesOf(github.requests())).toEqual(['AddToProject', 'UpdateProjectItemField'])
  })

  it.for([
    { name: 'PR が存在しない', spec: WAITING, key: 'todo', status: 'Todo' },
    { name: '開いた PR が存在する', spec: { ...WAITING, branch: BRANCH, pullRequests: [{ number: 11, head: BRANCH }] }, key: 'in_progress', status: 'In Progress' },
  ])('Status が自動処理の書いた Needs Attention で、$name とき、Status を $status に戻す', async ({ spec, key, status }, context) => {
    await verifies(context, 'PW-AUTO-START-04')
    await explains('Needs Attention になった Issue の Status を戻す、`auto start` のテストです。自動処理が書いた Needs Attention の場合に、開いた PR が存在しなければ `Todo` に、存在すれば `In Progress` に戻すことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(spec), issueComments([bot(QUESTION)]), boardItems(), statusUpdated(key)])

    const outcome = await start()

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`set: Status of Issue acme/demo/7 to ${status}\n`)
    expect(writesOf(github.requests())).toEqual(['UpdateProjectItemField'])
  })

  it('Status が pecot の判定の置いた Needs Attention の場合は、Status を戻さない', async (context) => {
    await verifies(context, 'PW-AUTO-START-05')
    await explains('pecot の判定が置いた Needs Attention を扱う、`auto start` のテストです。最後の結果を pecot の判定が書いている場合に、Status は戻さず、ボードにも書き込まないことを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([botResult('pr-created')])])

    const outcome = await start()

    expect(outcome.stderr).toBe('')
    expect(writesOf(github.requests())).toEqual([])
  })

  it('--dry-run を指定すると、戻す予定の Status を dry-run の行に出力し、ボードには書き込まない', async (context) => {
    await verifies(context, 'PW-AUTO-START-06')
    await explains('`auto start --dry-run` のテストです。`--dry-run` を指定した場合に、戻す予定の Status を `dry-run` の行として標準エラーに出力し、ボードには書き込まずに文脈の JSON を出力することを確認します。')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems()])

    const outcome = await start(['--dry-run'])

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe('dry-run: would set Status of Issue acme/demo/7 to Todo\n')
    expect(JSON.parse(outcome.stdout)).toEqual(emptyContext({ results: [QUESTION] }))
    expect(writesOf(github.requests())).toEqual([])
  })

  it('設定に fields.status が無いと、何も読まずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PW-AUTO-START-07')
    await explains('プロジェクトの設定を検証する、`auto start` のテストです。`fields.status` を持たない設定の場合に、GitHub へ何も要求せず、`pecot project init` の実行を案内して終了コード 1 で終わることを確認します。')
    prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the project config has no Status field (fields.status)\n  run: pecot project init\n' })
    expect(github.requests()).toEqual([])
  })

  it('戻す Status の選択肢が設定に存在しないと、書き込まずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PW-AUTO-START-07')
    await explains('プロジェクトの設定を検証する、`auto start` のテストです。戻す Status（`Todo`）の選択肢を設定が持たない場合に、ボードへ書き込まず、`pecot project init` の実行を案内して終了コード 1 で終わることを確認します。')
    prepareAuto({ missingStatus: 'todo' })
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems()])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the board has no option Todo for Status\n  run: pecot project init\n' })
    expect(writesOf(github.requests())).toEqual([])
  })

  describe('ボードの読み書きの失敗', () => {
    it('--dry-run でボードに無い Issue なら、載せるはずの行を出し、ボードに書かない', async () => {
      await explains('`auto start --dry-run` のテストです。ボードに存在しない Issue へ `--dry-run` を指定した場合に、追加する予定を `dry-run` の行として出力し、ボードには書き込まないことを確認します。')
      prepareAuto()
      const github = await startGithub([prerequisitesRule({ number: 7 }), issueComments(), boardItems({ onBoard: false })])

      const outcome = await start(['--dry-run'])

      expect(outcome.code).toBe(0)
      expect(outcome.stderr).toBe('dry-run: would add Issue acme/demo/7 to the board in Ready\n')
      expect(writesOf(github.requests())).toEqual([])
    })

    it('ボードへの追加が失敗すると、その理由で止まる', async () => {
      await explains('ボードへの追加に失敗した場合の、`auto start` のテストです。`AddToProject` の呼び出しが失敗した場合に、`could not add` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule({ number: 7 }), issueComments(), boardItems({ onBoard: false }), issueNodeId(), failing({ operation: 'AddToProject' })])

      const outcome = await start()

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not add Issue acme\/demo\/7 to the board: /u)
    })

    it('Status を戻す書き込みが失敗すると、その理由で止まる', async () => {
      await explains('Status の書き込みに失敗した場合の、`auto start` のテストです。`UpdateProjectItemField` の呼び出しが失敗した場合に、`could not set the Status` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems(), failing({ operation: 'UpdateProjectItemField' })])

      const outcome = await start()

      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toMatch(/^error: could not set the Status of Issue acme\/demo\/7 to Todo: /u)
    })

    it('Status を戻す対象でも、ボードに項目が見つからなければ、何も書き込まない', async () => {
      await explains('ボードに項目が存在しない場合の、`auto start` のテストです。Status を戻す対象の Issue でも、ボード上の項目が見つからない場合に、何も書き込まず、エラーも出力しないことを確認します。')
      prepareAuto()
      const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems({ onBoard: false })])

      const outcome = await start()

      expect(outcome.code).toBe(0)
      expect(outcome.stderr).toBe('')
      expect(writesOf(github.requests())).toEqual([])
    })

    it('Issue の前提が部分エラーで読めないと、その理由で止まる', async () => {
      await explains('Issue の前提を読み取れない場合の、`auto start` のテストです。`blockedBy` の読み取りが部分エラーで失敗した場合に、その理由を含むエラーを出力し、何も書き込まずに終了コード 1 で終わることを確認します。')
      prepareAuto()
      const body = { data: prerequisitesData({ number: 7 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
      const github = await startGithub([{ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }])

      const outcome = await start()

      expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: could not read Issue acme/demo/7: blockedBy could not be read: denied\n' })
      expect(writesOf(github.requests())).toEqual([])
    })
  })

  describe('MCP の data', () => {
    it('呼ぶと、Issue・計画・結果・答え・ブランチ・PR を返す', async (context) => {
      await verifies(context, 'PW-AUTO-START-09')
      await explains('MCP ツール `auto_start` のテストです。ツールを呼び出した場合に、Issue・計画・結果・答え・ブランチ・PR を含む構造化データを返すことを確認します。')
      prepareAuto()
      await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments([bot(QUESTION)])])

      const outcome = await callToolOnce(AUTO_START_COMMANDS, 'auto_start', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject(emptyContext({ results: [QUESTION] }))
    })
  })
})
