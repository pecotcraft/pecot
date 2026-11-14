/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_COMMANDS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { requestLabels } from '../_helpers/command-harness.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../fake-github/server.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { addBlockedByRule, bodyWritten, bothLinked, levelRule, nodeId, nodeIdRule, prepareDependencyProject, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/board-issue-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function block(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'block', ...argv], ISSUE_DEPENDENCY_COMMANDS)
}

const BODY = '## Summary\n\n本文\n\n## Notes\n\nメモ\n'
const MERGE_BODY = `${BODY}\n${WAITS_SECTION(['#5: main の版が要る'])}`

interface CycleRow {
  readonly name: string
  readonly edges: readonly (readonly [number, readonly number[]])[]
  readonly line: string
}
const NOT_IN_REVIEW = 'blocked by #5 (not in review: #5 (not started))'

function writes(github: Readonly<RunningGithub>): readonly string[] {
  return requestLabels(github.requests()).filter(label => ['AddBlockedBy', 'UpdateProjectItemField'].includes(label) || label.startsWith('PATCH'))
}

describe('issue block', () => {
  it('Issue と --by を渡すと、blocked by を付けて added の行を出し、判定が変われば列を Blocked に動かす', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-01')
    await verifies(context, 'PW-ISSUE-BLOCK-06')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: `added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (${NOT_IN_REVIEW})\n` })
    expect(requestLabels(github.requests())).toEqual([
      'GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences', 'GetIssueNodeId', 'GetBlockedByOfNodes', 'AddBlockedBy',
      'GetIssuePrerequisites', 'GetIssueProjectItems', 'UpdateProjectItemField',
    ])
  })

  it('--wait merge と --reason を付けると、本文の節に前提と理由の行を足し、節の外は書き換えない', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-02')
    await verifies(context, 'PW-ISSUE-BLOCK-09')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), bodyWritten(7, MERGE_BODY),
      prerequisitesRule({ number: 7, column: 'Ready', body: MERGE_BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'main の版が要る')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (blocked by #5 (waits for merge))\n' })
    expect(writes(github)).toEqual(['AddBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('別のリポジトリの前提を付けると、行と節に owner/repo#N の形で出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-02')
    prepareDependencyProject()
    const body = `${BODY}\n${WAITS_SECTION(['acme/other#9: b の版が要る'])}`
    await startGithub([
      bothLinked(['demo', 'other']), targetReferences(7, BODY, []), nodeIdRule(9, 'other'), levelRule([nodeId(9, 'other')], {}),
      addBlockedByRule(7, 9, 'other'),
      bodyWritten(7, body),
      prerequisitesRule({ number: 7, column: 'Ready', body, blockedBy: [{ number: 9, repo: 'other' }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/other/9', '--wait', 'merge', '--reason', 'b の版が要る')

    expect(result.stderr).toBe('added: blocked-by acme/other#9 to #7\nmoved: #7 Ready -> Blocked (blocked by acme/other#9 (waits for merge))\n')
  })

  it('--by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を付ける', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-23')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5, 'other'), levelRule([nodeId(5, 'other')], {}), addBlockedByRule(7, 5, 'other'),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5, repo: 'other' }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/other/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by acme/other#5 to #7\n')
    expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
  })

  it('既に付いていて種類と理由が同じなら、書き込まずに unchanged の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-04')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'main の版が要る')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: blocked-by #5 on #7\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('既に付いている前提の理由を変えると、節の行の理由だけを置き換えて updated の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-05')
    prepareDependencyProject()
    const changed = `${BODY}\n${WAITS_SECTION(['#5: 検証の手順が main にある'])}`
    const github = await startGithub([
      bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, changed),
      prerequisitesRule({ number: 7, column: 'Blocked', body: changed, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', '検証の手順が main にある')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: blocked-by #5 on #7 (wait: merge)\n' })
    expect(writes(github)).toEqual(['PATCH /repos/acme/demo/issues/7'])
  })

  it('種類を stack に戻すと、節から行を外して updated の行を出し、積める判定なら列を Ready に戻す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-03')
    await verifies(context, 'PW-ISSUE-BLOCK-06')
    prepareDependencyProject()
    const inReview = { number: 5, branch: 'feat/5', pullRequests: [{ number: 50, head: 'feat/5' }] }
    await startGithub([
      bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [inReview] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: blocked-by #5 on #7 (wait: stack)\nmoved: #7 Blocked -> Ready (stackable on #5)\n' })
  })

  it('着手の跡がある Issue に付けると、前提は付け、列と札は動かさずに食い違いを warning で出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-07')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', branch: 'feat/7', body: BODY, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nwarning: #7 is in Ready but blocked by #5\n' })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('--dry-run を付けると、読み取りだけ行い、書き込みを送らずに dry-run の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-08')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {})])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x', '--dry-run')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would add blocked-by #5 to #7\n' })
    expect(writes(github)).toEqual([])
  })

  it('--dry-run で種類を変えるとき、would update の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-08')
    prepareDependencyProject()
    await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x', '--dry-run')

    expect(result.stderr).toBe('dry-run: would update blocked-by #5 on #7 (wait: merge)\n')
  })

  it.for<CycleRow>([
    { name: '2 つの Issue', edges: [[5, [7]]], line: '#7 -> #5 -> #7' },
    { name: '3 つの Issue', edges: [[5, [6]], [6, [7]]], line: '#7 -> #5 -> #6 -> #7' },
  ])('付けると $name の輪になるとき、要求を送る前に終了コード 2 で止める', async ({ edges, line }, context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-10')
    prepareDependencyProject()
    const levels = edges.map(([number, blockers]) => levelRule([nodeId(number)], { [nodeId(number)]: blockers.map(blocker => ({ number: blocker })) }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), ...levels])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 2, stdout: '', stderr: `error: blocked-by would form a cycle: ${line}\n` })
    expect(writes(github)).toEqual([])
  })

  it('--by が待つ側と同じ Issue のとき、要求を送らずに終了コード 2 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-10')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/7')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: blocked-by would form a cycle: #7 -> #7\n' })
    expect(github.requests()).toEqual([])
  })

  it('輪を確かめる Issue が読めないとき、付けずに終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-11')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], { [nodeId(5)]: null })])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not check blocked-by cycle of #7: could not read blocked-by of #5: the node is not an Issue or was not found\n' })
    expect(writes(github)).toEqual([])
  })

  it('たどる Issue が 200 件を超えるとき、付けずに終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-11')
    prepareDependencyProject()
    const first = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
    const second = Object.fromEntries(first.map(({ number }) => [nodeId(number), Array.from({ length: 50 }, (_, index) => ({ number: number * 100 + index }))]))
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], { [nodeId(5)]: first }),
      levelRule(first.map(({ number }) => nodeId(number)), second),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not check blocked-by cycle of #7: more than 200 issues in the blocked-by chain\n' })
    expect(writes(github)).toEqual([])
  })

  it('--wait merge で --reason が無いとき、要求を送らずに終了コード 2 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-12')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --reason is required with --wait merge\n' })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: '--wait stack', argv: ['--wait', 'stack'] },
    { name: '--wait を省いた既定', argv: [] },
  ])('$name で --reason を渡すとき、要求を送らずに終了コード 2 で止める', async ({ argv }, context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-13')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', ...argv, '--reason', 'x')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --reason is only valid with --wait merge\n' })
    expect(github.requests()).toEqual([])
  })

  it('前提が 50 件あるとき、新しい前提を付けずに終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-14')
    prepareDependencyProject()
    const fifty = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, fifty)])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: #7 already has 50 blocked-by issues\n' })
    expect(writes(github)).toEqual([])
  })

  it('本文の節が読めないとき、要求を送る前に終了コード 3 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-15')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, '## Waits for merge\n\nplain text\n', [])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: Waits for merge of #7 is malformed: not a list item: plain text; fix the section in the Issue body and run the command again\n')
    expect(writes(github)).toEqual([])
  })

  it('読み直した前提が書いた内容と合わないとき、列と札を動かさずに warning を出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-16')
    prepareDependencyProject()
    const stale = prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] })
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), stale, stale])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'added: blocked-by #5 to #7\nwarning: could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved\n',
    })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('1 回目の読み直しが古くても、2 回目で一致すれば列を動かす', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-16')
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] }),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.stderr).toBe(`added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (${NOT_IN_REVIEW})\n`)
  })

  it('動かす先の列がボードに無いとき、warning と project init の hint を出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-17')
    prepareDependencyProject({ omit: ['blocked'] })
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'added: blocked-by #5 to #7\nwarning: the Blocked option is not on the board, so #7 was not moved\n  hint: run pecot project init to add the Blocked option to the board\n',
    })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('本文の書き込みが失敗したとき、前提は付いたまま終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-22')
    prepareDependencyProject()
    const failing = { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), failing])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^added: blocked-by #5 to #7\nerror: could not update the body of #7; blocked-by #5 was added, run the command again to write the section: /u)
  })

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-18')
    prepareDependencyProject()
    const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
    const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
    await startGithub([bothLinked(), unsupported])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n',
    })
  })

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-19')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('invalid-format', '--by', 'acme/demo/5')

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに無いとき、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-20')
    prepareDependencyProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-21')
    const project = setUpProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('GitHub API がエラーを返したとき、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-BLOCK-22')
    prepareDependencyProject()
    const failing = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), failing])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read blocked-by of #7: /u)
  })
})
