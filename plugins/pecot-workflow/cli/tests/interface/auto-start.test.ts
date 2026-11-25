// auto start の振る舞いを、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

import { AUTO_START_COMMANDS } from '../../src/commands/auto-start.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { AUTO_TOKEN, autoResult, bot, botResult, issueComments, permissionOf, prepareAuto, statusUpdated, writesOf } from '../_helpers/auto-case.js'
import { addedToBoard, boardItems, fieldUpdated, issueNodeId } from '../_helpers/board-issue-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
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
  it('ボードにあり、札を自動処理が書いていなければ、何も書かずに計画・結果・答えを JSON で出す', async (context) => {
    await verifies(context, 'PW-AUTO-START-01')
    await verifies(context, 'PW-AUTO-START-08')
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
    prepareAuto()
    const comments = [{ body: PLAN, login: 'bob' }, bot(QUESTION), { body: ANSWER, login: 'bob' }]
    await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments(comments), permissionOf('bob', 'read')])

    const outcome = await start()

    expect(JSON.parse(outcome.stdout)).toEqual(emptyContext({ results: [QUESTION], withheld: 2 }))
  })

  it('ボードに無い Issue なら、進行の欄を Ready にしてボードに載せる', async (context) => {
    await verifies(context, 'PW-AUTO-START-03')
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
    await verifies(context, 'PW-AUTO-START-04')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(spec), issueComments([bot(QUESTION)]), boardItems(), statusUpdated(key)])

    const outcome = await start()

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toBe(`set: Status of Issue acme/demo/7 to ${status}\n`)
    expect(writesOf(github.requests())).toEqual(['UpdateProjectItemField'])
  })

  it('札が pecot の判定の置いた Needs Attention なら、戻さない', async (context) => {
    await verifies(context, 'PW-AUTO-START-05')
    prepareAuto()
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([botResult('pr-created')])])

    const outcome = await start()

    expect(outcome.stderr).toBe('')
    expect(writesOf(github.requests())).toEqual([])
  })

  it('--dry-run なら、戻すはずの札の行を出し、ボードに書かない', async (context) => {
    await verifies(context, 'PW-AUTO-START-06')
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
    prepareAuto({ hasStatus: false })
    const github = await startGithub([])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the project config has no Status field (fields.status)\n  run: pecot project init\n' })
    expect(github.requests()).toEqual([])
  })

  it('戻すはずの札の選択肢が設定に無いと、書かずに project init を案内して止まる', async (context) => {
    await verifies(context, 'PW-AUTO-START-07')
    prepareAuto({ missingStatus: 'todo' })
    const github = await startGithub([prerequisitesRule(WAITING), issueComments([bot(QUESTION)]), boardItems()])

    const outcome = await start()

    expect(outcome).toEqual({ code: 1, stdout: '', stderr: 'error: the board has no option Todo for Status\n  run: pecot project init\n' })
    expect(writesOf(github.requests())).toEqual([])
  })

  describe('MCP の data', () => {
    it('呼ぶと、Issue・計画・結果・答え・ブランチ・PR を返す', async (context) => {
      await verifies(context, 'PW-AUTO-START-09')
      prepareAuto()
      await startGithub([prerequisitesRule({ number: 7, column: 'Active' }), issueComments([bot(QUESTION)])])

      const outcome = await callToolOnce(AUTO_START_COMMANDS, 'auto_start', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject(emptyContext({ results: [QUESTION] }))
    })
  })
})
