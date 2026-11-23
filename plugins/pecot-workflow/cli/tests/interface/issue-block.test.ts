/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_COMMANDS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { requestLabels, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../fake-github/server.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { addBlockedByRule, bodyWritten, bothLinked, labelUpdated, levelRule, nodeId, nodeIdRule, prepareDependencyProject, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/board-issue-case.js'
import { botResult, commentsFailure, commentsRule, humanResult, prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec } from '../_helpers/prerequisites.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
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

async function blockTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_DEPENDENCY_COMMANDS, 'issue_block', argumentsOfTool)
}

describe('issue block', () => {
  it('Issue と --by を渡すと、blocked by を付けて added の行を出し、判定が変われば列を Blocked に動かす', async () => {
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

  it('選択肢の ID が古くて列を書けないと、前提を付けたまま warning と project activate の案内を出し、終了コード 0 で終わる', async () => {
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), staleOptionUpdate(),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: [
        'added: blocked-by #5 to #7',
        `warning: could not move #7: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        '',
      ].join('\n'),
    })
  })

  it('--wait merge と --reason を付けると、本文の節に前提と理由の行を足し、節の外は書き換えない', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), bodyWritten(7, MERGE_BODY),
      prerequisitesRule({ number: 7, column: 'Ready', body: MERGE_BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'main の版が要る')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (blocked by #5 (waits for merge))\n' })
    expect(writes(github)).toEqual(['AddBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('別のリポジトリの前提を付けると、行と節に owner/repo#N の形で出す', async () => {
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

  it('--by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を付ける', async () => {
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

  it('既に付いていて種類と理由が同じなら、書き込まずに unchanged の行を出す', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'main の版が要る')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: blocked-by #5 on #7\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('既に付いている前提の理由を変えると、節の行の理由だけを置き換えて updated の行を出す', async () => {
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

  it('種類を stack に戻すと、節から行を外して updated の行を出し、積める判定なら列を Ready に戻す', async () => {
    prepareDependencyProject()
    const inReview = { number: 5, branch: 'feat/5', pullRequests: [{ number: 50, head: 'feat/5' }] }
    await startGithub([
      bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [inReview] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: blocked-by #5 on #7 (wait: stack)\nmoved: #7 Blocked -> Ready (stackable on #5)\n' })
  })

  it('着手の跡がある Issue に付けると、前提は付け、列と札は動かさずに食い違いを warning で出す', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', branch: 'feat/7', body: BODY, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nwarning: #7 is in Ready but blocked by #5\n' })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('--dry-run を付けると、読み取りだけ行い、書き込みを送らずに dry-run の行を出す', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {})])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x', '--dry-run')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would add blocked-by #5 to #7\n' })
    expect(writes(github)).toEqual([])
  })

  it('--dry-run で種類を変えるとき、would update の行を出す', async () => {
    prepareDependencyProject()
    await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x', '--dry-run')

    expect(result.stderr).toBe('dry-run: would update blocked-by #5 on #7 (wait: merge)\n')
  })

  it.for<CycleRow>([
    { name: '2 つの Issue', edges: [[5, [7]]], line: '#7 -> #5 -> #7' },
    { name: '3 つの Issue', edges: [[5, [6]], [6, [7]]], line: '#7 -> #5 -> #6 -> #7' },
  ])('付けると $name の輪になるとき、要求を送る前に終了コード 2 で止める', async ({ edges, line }) => {
    prepareDependencyProject()
    const levels = edges.map(([number, blockers]) => levelRule([nodeId(number)], { [nodeId(number)]: blockers.map(blocker => ({ number: blocker })) }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), ...levels])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 2, stdout: '', stderr: `error: blocked-by would form a cycle: ${line}\n` })
    expect(writes(github)).toEqual([])
  })

  it('--by が待つ側と同じ Issue のとき、要求を送らずに終了コード 2 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/7')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: blocked-by would form a cycle: #7 -> #7\n' })
    expect(github.requests()).toEqual([])
  })

  it('輪を確かめる Issue が読めないとき、付けずに終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], { [nodeId(5)]: null })])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not check blocked-by cycle of #7: could not read blocked-by of #5: the node is not an Issue or was not found\n' })
    expect(writes(github)).toEqual([])
  })

  it('たどる Issue が 200 件を超えるとき、付けずに終了コード 1 で止める', async () => {
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

  it('--wait merge で --reason が無いとき、要求を送らずに終了コード 2 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --reason is required with --wait merge\n' })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: '--wait stack', argv: ['--wait', 'stack'] },
    { name: '--wait を省いた既定', argv: [] },
  ])('$name で --reason を渡すとき、要求を送らずに終了コード 2 で止める', async ({ argv }) => {
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', ...argv, '--reason', 'x')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: --reason is only valid with --wait merge\n' })
    expect(github.requests()).toEqual([])
  })

  it('前提が 50 件あるとき、新しい前提を付けずに終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const fifty = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, fifty)])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: #7 already has 50 blocked-by issues\n' })
    expect(writes(github)).toEqual([])
  })

  it('本文の節が読めないとき、要求を送る前に終了コード 3 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, '## Waits for merge\n\nplain text\n', [])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: Waits for merge of #7 is malformed: not a list item: plain text; fix the section in the Issue body and run the command again\n')
    expect(writes(github)).toEqual([])
  })

  it('読み直した前提が書いた内容と合わないとき、列と札を動かさずに warning を出して終了コード 0 で終わる', async () => {
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

  it('1 回目の読み直しが古くても、2 回目で一致すれば列を動かす', async () => {
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] }),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.stderr).toBe(`added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (${NOT_IN_REVIEW})\n`)
  })

  it('動かす先の列がボードに無いとき、warning と project init の hint を出して終了コード 0 で終わる', async () => {
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

  it('本文の書き込みが失敗したとき、前提は付いたまま終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const failing = { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), failing])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'x')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^added: blocked-by #5 to #7\nerror: could not update the body of #7; blocked-by #5 was added, run the command again to write the section: /u)
  })

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async () => {
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

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block('invalid-format', '--by', 'acme/demo/5')

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに無いとき、終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で止める', async () => {
    const project = setUpProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('待つ側のリポを含む設定が無いとき、error を出して終了コード 1 で止める', async () => {
    setUpProject({ repositories: ['other'] })

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async () => {
    const project = prepareDependencyProject()
    makeAmbiguous(project)
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--project', SECOND_PROJECT)

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by #5 to #7\n')
  })

  it('.active が無くても、待つ側のリポを含む設定が 1 つならその設定で動く', async () => {
    const project = prepareDependencyProject()
    removeActive(project)
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by #5 to #7\n')
  })

  it('GitHub API がエラーを返したとき、終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const failing = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), failing])

    const result = await block('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read blocked-by of #7: /u)
  })

  describe('札が Needs Attention の Issue に、済んだ前提を付ける', () => {
    const merged: IssueSpec = { number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }
    const addMerged = (...after: readonly ResponseRule[]): ResponseRule[] => [
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [merged] }), ...after,
    ]

    it('自動処理の結果のコメントが無いと、列を Ready へ戻した後で札を Todo にする', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      prepareDependencyProject()
      const github = await startGithub(addMerged(commentsRule(7), boardItems(), fieldUpdated('o3'), labelUpdated('s2')))

      const result = await block('acme/demo/7', '--by', 'acme/demo/5')

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    })

    it('bot が書いた最後の自動処理の結果が limit なら、列は Ready に戻し、札を Todo に戻さない', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-28')
      prepareDependencyProject()
      const comments = commentsRule(7, [botResult('limit')])
      const github = await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3')))

      const result = await block('acme/demo/7', '--by', 'acme/demo/5')

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\n' })
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField'])
    })

    it('人が書いた自動処理の結果の目印しか無いなら、札を Todo に戻す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      prepareDependencyProject()
      const comments = commentsRule(7, [humanResult('limit')])
      const github = await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3'), labelUpdated('s2')))

      const result = await block('acme/demo/7', '--by', 'acme/demo/5')

      expect(result.stderr).toBe('added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n')
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    })

    it('コメントを読めないと、前提は付けたまま、判定を出せない warning を出して列と札を動かさない', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-29')
      prepareDependencyProject()
      const github = await startGithub(addMerged(commentsFailure(7)))

      const result = await block('acme/demo/7', '--by', 'acme/demo/5')

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nwarning: could not judge readiness of #7: GitHub API error: 500; the column and label of #7 were not moved\n' })
      expect(writes(github)).toEqual(['AddBlockedBy'])
    })

    it('bot が書いた最後の自動処理の結果が question なら、札を戻さず、列の動きだけを moves に入れて data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-28')
      prepareDependencyProject()
      const comments = commentsRule(7, [botResult('question')])
      await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3')))

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'stack', change: 'added', moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }] })
    })

    it('コメントを読めないと、空の moves と判定を出せない旨の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-29')
      prepareDependencyProject()
      await startGithub(addMerged(commentsFailure(7)))

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'stack',
        change: 'added',
        moves: [],
        warnings: ['could not judge readiness of #7: GitHub API error: 500; the column and label of #7 were not moved'],
      })
    })
  })

  describe('MCP の data', () => {
    it('前提を付けると、Issue と前提の参照と種類と added と、動かした列を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-01')
      await verifies(context, 'PW-ISSUE-BLOCK-02')
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      await verifies(context, 'PW-ISSUE-BLOCK-09')
      await verifies(context, 'PW-ISSUE-BLOCK-24')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), bodyWritten(7, MERGE_BODY),
        prerequisitesRule({ number: 7, column: 'Ready', body: MERGE_BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'main の版が要る' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'merge',
        change: 'added',
        moves: [{ issue: '#7', from: 'Ready', to: 'Blocked', reason: 'blocked by #5 (waits for merge)' }],
      })
      expect(writes(github)).toEqual(['AddBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
    })

    it('着手の跡があって列を動かさないとき、空の moves を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-07')
      await verifies(context, 'PW-ISSUE-BLOCK-24')
      prepareDependencyProject()
      await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Ready', branch: 'feat/7', body: BODY, blockedBy: [{ number: 5 }] }),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'stack',
        change: 'added',
        moves: [],
        warnings: ['#7 is in Ready but blocked by #5'],
      })
    })

    it('読み直した前提が書いた内容と合わないとき、空の moves と理由の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-16')
      await verifies(context, 'PW-ISSUE-BLOCK-24')
      prepareDependencyProject()
      const stale = prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] })
      await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), stale, stale])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'stack',
        change: 'added',
        moves: [],
        warnings: ['could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved'],
      })
    })

    it('動かす先の列がボードに無いとき、空の moves と理由の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-17')
      await verifies(context, 'PW-ISSUE-BLOCK-24')
      prepareDependencyProject({ omit: ['blocked'] })
      await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'stack',
        change: 'added',
        moves: [],
        warnings: ['the Blocked option is not on the board, so #7 was not moved\n  hint: call project_init to add the Blocked option to the board'],
      })
    })

    it('既に付いている前提の理由を変えると、updated を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-05')
      prepareDependencyProject()
      const changed = `${BODY}\n${WAITS_SECTION(['#5: 検証の手順が main にある'])}`
      const github = await startGithub([
        bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, changed),
        prerequisitesRule({ number: 7, column: 'Blocked', body: changed, blockedBy: [{ number: 5 }] }),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: '検証の手順が main にある' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', change: 'updated', moves: [] })
      expect(writes(github)).toEqual(['PATCH /repos/acme/demo/issues/7'])
    })

    it('既に付いていて種類と理由が同じなら、何も書かずに unchanged を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-04')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'main の版が要る' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', change: 'unchanged', moves: [] })
      expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
    })

    it('CLI で既に付いている前提に --dry-run を付けると、何も書かずに、変えない予定を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-08')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

      const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--wait', 'merge', '--reason', 'main の版が要る', '--dry-run')

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would leave blocked-by #5 on #7 unchanged\n' })
      expect(writes(github)).toEqual([])
    })

    it('CLI で --dry-run を付けると、書き込みを送らずに、付ける予定を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-08')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {})])

      const result = await block('acme/demo/7', '--by', 'acme/demo/5', '--dry-run')

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would add blocked-by #5 to #7\n' })
      expect(writes(github)).toEqual([])
    })

    it('種類を stack に戻すと、節から行を外して updated を返し、積める判定なら列を Ready に戻して moves に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-03')
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      prepareDependencyProject()
      const inReview = { number: 5, branch: 'feat/5', pullRequests: [{ number: 50, head: 'feat/5' }] }
      await startGithub([
        bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, BODY),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [inReview] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'stack', change: 'updated', moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'stackable on #5' }] })
    })

    it('選択肢の ID が古くて列を書けないと、前提を付けたまま warnings に project_activate の案内を入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-25')
      prepareDependencyProject()
      await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), staleOptionUpdate(),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        wait: 'stack',
        change: 'added',
        moves: [],
        warnings: [`could not move #7: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`],
      })
    })

    it('by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を付ける', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-23')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5, 'other'), levelRule([nodeId(5, 'other')], {}), addBlockedByRule(7, 5, 'other'),
        prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5, repo: 'other' }] }), boardItems(), fieldUpdated('o7'),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/other/5' })

      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', by: 'acme/other/5', change: 'added' })
      expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
    })

    it.for<CycleRow>([
      { name: '2 つの Issue', edges: [[5, [7]]], line: '#7 -> #5 -> #7' },
      { name: '3 つの Issue', edges: [[5, [6]], [6, [7]]], line: '#7 -> #5 -> #6 -> #7' },
    ])('付けると $name の輪になるとき、書き込みを送らずに kind が dependency-rejected の失敗を返す', async ({ edges, line }, context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-10')
      prepareDependencyProject()
      const levels = edges.map(([number, blockers]) => levelRule([nodeId(number)], { [nodeId(number)]: blockers.map(blocker => ({ number: blocker })) }))
      const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), ...levels])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: `blocked-by would form a cycle: ${line}` })
      expect(writes(github)).toEqual([])
    })

    it('by が待つ側と同じ Issue のとき、要求を送らずに kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-10')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: 'blocked-by would form a cycle: #7 -> #7' })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: '輪を確かめる Issue が読めない', detail: 'could not check blocked-by cycle of #7: could not read blocked-by of #5: the node is not an Issue or was not found', big: false },
      { name: 'たどる Issue が 200 件を超える', detail: 'could not check blocked-by cycle of #7: more than 200 issues in the blocked-by chain', big: true },
    ])('$name とき、前提を付けずに kind が dependency-unreadable の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-11')
      prepareDependencyProject()
      const first = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
      const second = Object.fromEntries(first.map(({ number }) => [nodeId(number), Array.from({ length: 50 }, (_, index) => ({ number: number * 100 + index }))]))
      const levels = row.big
        ? [levelRule([nodeId(5)], { [nodeId(5)]: first }), levelRule(first.map(({ number }) => nodeId(number)), second)]
        : [levelRule([nodeId(5)], { [nodeId(5)]: null })]
      const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), ...levels])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-unreadable', detail: row.detail })
      expect(writes(github)).toEqual([])
    })

    it.for([
      { name: 'wait が merge で reason が無い', id: 'PW-ISSUE-BLOCK-12', extra: { wait: 'merge' }, detail: 'reason is required with wait: "merge"' },
      { name: 'wait が stack で reason を渡した', id: 'PW-ISSUE-BLOCK-13', extra: { wait: 'stack', reason: 'x' }, detail: 'reason is only valid with wait: "merge"' },
      { name: 'wait を省いて reason を渡した', id: 'PW-ISSUE-BLOCK-13', extra: { reason: 'x' }, detail: 'reason is only valid with wait: "merge"' },
    ])('$name とき、要求を送らずに kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', ...row.extra })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: row.detail })
      expect(github.requests()).toEqual([])
    })

    it('前提が 50 件あるとき、新しい前提を付けずに kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-14')
      prepareDependencyProject()
      const fifty = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
      const github = await startGithub([bothLinked(), targetReferences(7, BODY, fifty)])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: '#7 already has 50 blocked-by issues' })
      expect(writes(github)).toEqual([])
    })

    it('本文の節が読めないとき、書き込みを送らずに kind が content-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-15')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, '## Waits for merge\n\nplain text\n', [])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'content-invalid', detail: 'Waits for merge of #7 is malformed: not a list item: plain text; fix the section in the Issue body and call the tool again' })
      expect(writes(github)).toEqual([])
    })

    it('依存関係に対応しない GHES では、kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-18')
      prepareDependencyProject()
      const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
      const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
      await startGithub([bothLinked(), unsupported])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: 'could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required' })
    })

    it('Issue の参照の形が誤っているとき、要求を送らずに kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-19')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'invalid-format', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('invalid reference')
      expect(github.requests()).toEqual([])
    })

    it('リポジトリがプロジェクトに無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-20')
      prepareDependencyProject()
      await startGithub([linkedRepositories(['other'])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'repository acme/demo is not in the project' })
    })

    it('待つ側のリポを含む設定が無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-26')
      setUpProject({ repositories: ['other'] })

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-21')
      const project = setUpProject()
      makeAmbiguous(project)
      await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-27')
      const project = prepareDependencyProject()
      makeAmbiguous(project)
      await startGithub([
        bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', project: SECOND_PROJECT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', change: 'added' })
    })

    it.for([
      { name: '本文の書き込みが失敗した', wait: { wait: 'merge', reason: 'x' }, rules: (): ResponseRule[] => [targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }], detail: /^could not update the body of #7; blocked-by #5 was added, call the tool again to write the section: GitHub API error: 502$/u },
      { name: 'GitHub API がエラーを返した', wait: {}, rules: (): ResponseRule[] => [{ match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }], detail: /^could not read blocked-by of #7: /u },
    ])('$name とき、失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-22')
      prepareDependencyProject()
      await startGithub([bothLinked(), ...row.rules()])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', ...row.wait })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(row.detail)
    })
  })
})
