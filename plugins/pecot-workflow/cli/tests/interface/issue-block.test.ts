/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_TOOLS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { requestLabels, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { addBlockedByRule, bodyWritten, bothLinked, labelUpdated, levelRule, nodeId, nodeIdRule, prepareDependencyProject, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/board-issue-case.js'
import { botResult, commentsFailure, commentsRule, humanResult, prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { IssueSpec } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function block(arguments_: Readonly<Record<string, unknown>> = {}): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess('issue_block', arguments_, ISSUE_DEPENDENCY_TOOLS)
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
  return await callToolOnce(ISSUE_DEPENDENCY_TOOLS, 'issue_block', argumentsOfTool)
}

describe('issue_block', () => {
  it('Issue と by を渡すと、blocked by を付けて added の行を出し、判定が変われば列を Blocked に動かす', async () => {
    await explains('`issue_block` の基本の動作のテストです。Issue と `by` を渡した場合に、前提を付けて `added` の行を出力し、判定が変われば列を Blocked へ動かすことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: `added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (${NOT_IN_REVIEW})\n` })
    expect(requestLabels(github.requests())).toEqual([
      'GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences', 'GetIssueNodeId', 'GetBlockedByOfNodes', 'AddBlockedBy',
      'GetIssuePrerequisites', 'GetIssueProjectItems', 'UpdateProjectItemField',
    ])
  })

  it('選択肢の ID が古くて Status を書けないと、前提を付けたまま warning と project_activate の案内を出し、終了コード 0 で終わる', async () => {
    await explains('`issue_block` の Status の書き込みが失敗した場合のテストです。古い選択肢の ID で書き込みが失敗した場合に、前提は付けたまま、warning と `project_activate` の案内を出力して終了コード 0 で終わることを確認します。')
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), staleOptionUpdate(),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: [
        'added: blocked-by #5 to #7',
        `warning: could not move #7: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
        '',
      ].join('\n'),
    })
  })

  it('wait merge と reason を付けると、本文の節へ前提と理由の行を追加し、節の外は書き換えない', async () => {
    await explains('`issue_block` の `wait: merge` のテストです。`wait: merge` と `reason` を指定した場合に、本文の節へ前提と理由の行を追加し、節の外は書き換えないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), bodyWritten(7, MERGE_BODY),
      prerequisitesRule({ number: 7, column: 'Ready', body: MERGE_BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'main の版が要る' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (blocked by #5 (waits for merge))\n' })
    expect(writes(github)).toEqual(['AddBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('別のリポジトリの前提を付けると、行と節に owner/repo#N の形で出す', async () => {
    await explains('`issue_block` の別のリポジトリの前提のテストです。別のリポジトリの Issue を `by` へ指定した場合に、`added` の行と本文の節の両方で `owner/repo#N` の形で書くことを確認します。')
    prepareDependencyProject()
    const body = `${BODY}\n${WAITS_SECTION(['acme/other#9: b の版が要る'])}`
    await startGithub([
      bothLinked(['demo', 'other']), targetReferences(7, BODY, []), nodeIdRule(9, 'other'), levelRule([nodeId(9, 'other')], {}),
      addBlockedByRule(7, 9, 'other'),
      bodyWritten(7, body),
      prerequisitesRule({ number: 7, column: 'Ready', body, blockedBy: [{ number: 9, repo: 'other' }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/other/9', wait: 'merge', reason: 'b の版が要る' })

    expect(result.stderr).toBe('added: blocked-by acme/other#9 to #7\nmoved: #7 Ready -> Blocked (blocked by acme/other#9 (waits for merge))\n')
  })

  it('by がプロジェクトに登録されていない別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を付ける', async () => {
    await explains('`issue_block` のプロジェクトの登録のテストです。`by` のリポジトリがプロジェクトに登録されていない場合でも、待つ側のリポジトリだけを確認して前提を付けることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5, 'other'), levelRule([nodeId(5, 'other')], {}), addBlockedByRule(7, 5, 'other'),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5, repo: 'other' }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/other/5' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by acme/other#5 to #7\n')
    expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
  })

  it('既に付いていて種類と理由が同じなら、書き込まずに unchanged の行を出す', async () => {
    await explains('`issue_block` を既に付いている前提へ重ねるテストです。種類と理由が同じ場合に、書き込みは行わず `unchanged` の行を出力することを確認します。')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'main の版が要る' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: blocked-by #5 on #7\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('既に付いている前提の理由を変えると、節の行の理由だけを置き換えて updated の行を出す', async () => {
    await explains('`issue_block` を既に付いている前提へ重ねるテストです。理由だけを変えた場合に、節の行の理由を置き換えて `updated` の行を出力することを確認します。')
    prepareDependencyProject()
    const changed = `${BODY}\n${WAITS_SECTION(['#5: 検証の手順が main にある'])}`
    const github = await startGithub([
      bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, changed),
      prerequisitesRule({ number: 7, column: 'Blocked', body: changed, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: '検証の手順が main にある' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: blocked-by #5 on #7 (wait: merge)\n' })
    expect(writes(github)).toEqual(['PATCH /repos/acme/demo/issues/7'])
  })

  it('種類を stack に戻すと、節から行を外して updated の行を出し、スタック可の判定なら列を Ready に戻す', async () => {
    await explains('`issue_block` の種類を戻すテストです。既に付いている前提を `stack` へ戻した場合に、節から行を外して `updated` の行を出力し、スタック可の判定なら列を Ready へ戻すことを確認します。')
    prepareDependencyProject()
    const inReview = { number: 5, branch: 'feat/5', pullRequests: [{ number: 50, head: 'feat/5' }] }
    await startGithub([
      bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [inReview] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: blocked-by #5 on #7 (wait: stack)\nmoved: #7 Blocked -> Ready (stackable on #5)\n' })
  })

  it('着手の跡がある Issue に付けると、前提は付け、列と Status は動かさずに食い違いを warning で出す', async () => {
    await explains('`issue_block` の着手の跡がある Issue のテストです。列が Ready のまま前提を付けた場合に、列と Status は動かさず、食い違いを warning で出力することを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', branch: 'feat/7', body: BODY, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nwarning: #7 is in Ready but blocked by #5\n' })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it.for<CycleRow>([
    { name: '2 つの Issue', edges: [[5, [7]]], line: '#7 -> #5 -> #7' },
    { name: '3 つの Issue', edges: [[5, [6]], [6, [7]]], line: '#7 -> #5 -> #6 -> #7' },
  ])('付けると $name で前提が循環するとき、要求を送る前に終了コード 2 で止める', async ({ edges, line }) => {
    await explains('`issue_block` の循環の検証のテストです。前提を付けると 2 つか 3 つの Issue で循環する場合に、要求は送らず、循環する並びを出力して終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const levels = edges.map(([number, blockers]) => levelRule([nodeId(number)], { [nodeId(number)]: blockers.map(blocker => ({ number: blocker })) }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), ...levels])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 2, stdout: '', stderr: `error: blocked-by would form a cycle: ${line}\n` })
    expect(writes(github)).toEqual([])
  })

  it('by が待つ側と同じ Issue のとき、要求を送らずに終了コード 2 で止める', async () => {
    await explains('`issue_block` の引数の検証のテストです。`by` が待つ側と同じ Issue の場合に、要求は送らず、終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/7' })

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: blocked-by would form a cycle: #7 -> #7\n' })
    expect(github.requests()).toEqual([])
  })

  it('循環の確認に要る Issue が読めないとき、付けずに終了コード 1 で止める', async () => {
    await explains('`issue_block` の循環の検証のテストです。循環の確認に要る Issue を読めない場合に、前提を付けず、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], { [nodeId(5)]: null })])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not check blocked-by cycle of #7: could not read blocked-by of #5: the node is not an Issue or was not found\n' })
    expect(writes(github)).toEqual([])
  })

  it('たどる Issue が 200 件を超えるとき、付けずに終了コード 1 で止める', async () => {
    await explains('`issue_block` の循環の検証のテストです。たどる Issue が 200 件を超える場合に、前提を付けず、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const first = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
    const second = Object.fromEntries(first.map(({ number }) => [nodeId(number), Array.from({ length: 50 }, (_, index) => ({ number: number * 100 + index }))]))
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], { [nodeId(5)]: first }),
      levelRule(first.map(({ number }) => nodeId(number)), second),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not check blocked-by cycle of #7: more than 200 issues in the blocked-by chain\n' })
    expect(writes(github)).toEqual([])
  })

  it('wait merge で reason を渡していないとき、要求を送らずに終了コード 2 で止める', async () => {
    await explains('`issue_block` の `wait: merge` の引数の検証のテストです。`reason` を指定しなかった場合に、要求は送らず、終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge' })

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: reason is required with wait: "merge"\n' })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'wait が stack', input: { wait: 'stack' } },
    { name: 'wait を省いた既定', input: {} },
  ])('$name で reason を渡すとき、要求を送らずに終了コード 2 で止める', async ({ input }) => {
    await explains('`issue_block` の `reason` の検証のテストです。`wait: stack` を指定した場合と `wait` を省略した場合に、`reason` は使えないため、要求は送らず終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', ...input, reason: 'x' })

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: reason is only valid with wait: "merge"\n' })
    expect(github.requests()).toEqual([])
  })

  it('reason が複数行のとき、要求を送らずに終了コード 2 で止める', async () => {
    await explains('`issue_block` の `reason` の検証のテストです。`reason` に改行を含めた場合に、1 行にするよう案内し、要求は送らず終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: '1 行目\n2 行目' })

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: reason must be a single line\n' })
    expect(github.requests()).toEqual([])
  })

  it('前提が 50 件あるとき、新しい前提を付けずに終了コード 1 で止める', async () => {
    await explains('`issue_block` の前提の上限のテストです。前提が既に 50 件ある場合に、新しい前提は付けず、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const fifty = Array.from({ length: 50 }, (_, index) => ({ number: 100 + index }))
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, fifty)])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: #7 already has 50 blocked-by issues\n' })
    expect(writes(github)).toEqual([])
  })

  it('本文の節が読めないとき、要求を送る前に終了コード 3 で止める', async () => {
    await explains('`issue_block` の本文の検証のテストです。本文の節を読み取れない場合に、要求は送らず、終了コード 3 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, '## Waits for merge\n\nplain text\n', [])])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: Waits for merge of #7 is malformed: not a list item: plain text; fix the section in the Issue body and call the tool again\n')
    expect(writes(github)).toEqual([])
  })

  it('読み直した前提が書いた内容と合わないとき、列と Status を動かさずに warning を出して終了コード 0 で終わる', async () => {
    await explains('`issue_block` の反映の確認のテストです。読み直した前提が書いた内容と一致しない場合に、列と Status は動かさず、warning を出力して終了コード 0 で終わることを確認します。')
    prepareDependencyProject()
    const stale = prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] })
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), stale, stale])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'added: blocked-by #5 to #7\nwarning: could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved\n',
    })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('1 回目の読み直しが古くても、2 回目で一致すれば列を動かす', async () => {
    await explains('`issue_block` の反映の確認のテストです。1 回目の読み直しが古くても 2 回目で一致した場合に、列を動かすことを確認します。')
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [] }),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.stderr).toBe(`added: blocked-by #5 to #7\nmoved: #7 Ready -> Blocked (${NOT_IN_REVIEW})\n`)
  })

  it('動かす先の列がボードに存在しないとき、warning と project_init の案内を出して終了コード 0 で終わる', async () => {
    await explains('`issue_block` の Blocked の選択肢のテストです。ボードが動かす先の列を持たない場合に、warning と `project_init` の案内を出力して終了コード 0 で終わることを確認します。')
    prepareDependencyProject({ omit: ['blocked'] })
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'added: blocked-by #5 to #7\nwarning: the Blocked option is not on the board, so #7 was not moved\n  hint: call project_init to add the Blocked option to the board\n',
    })
    expect(writes(github)).toEqual(['AddBlockedBy'])
  })

  it('本文の書き込みが失敗したとき、前提は付いたまま終了コード 1 で止める', async () => {
    await explains('`issue_block` の本文の書き込みが失敗した場合のテストです。本文の書き込みが失敗した場合に、前提は付けたまま、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const failing = { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5), failing])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'x' })

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^added: blocked-by #5 to #7\nerror: could not update the body of #7; blocked-by #5 was added, call the tool again to write the section: /u)
  })

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async () => {
    await explains('`issue_block` の GitHub Enterprise Server のテストです。依存関係に対応していない版の場合に、必要な版を示すエラーを出力して終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
    const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
    await startGithub([bothLinked(), unsupported])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n',
    })
  })

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async () => {
    await explains('`issue_block` の Issue の参照を検証するテストです。参照の形が誤っている場合に、要求は送らず、終了コード 2 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await block({ issue_ref: 'invalid-format', by: 'acme/demo/5' })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに登録されていないとき、終了コード 1 で止める', async () => {
    await explains('`issue_block` のプロジェクトの登録を検証するテストです。リポジトリがプロジェクトに登録されていない場合に、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と project の案内を出して終了コード 1 で止める', async () => {
    await explains('`issue_block` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const project = setUpProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('待つ側のリポを含む設定が存在しないとき、error を出して終了コード 1 で止める', async () => {
    await explains('`issue_block` のプロジェクトの設定の選択のテストです。待つ側のリポジトリを含む設定が存在しない場合に、エラーを出力して終了コード 1 で終わることを確認します。')
    setUpProject({ repositories: ['other'] })

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async () => {
    await explains('`issue_block` の `project` のテストです。待つ側のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定で前提を付けることを確認します。')
    const project = prepareDependencyProject()
    makeAmbiguous(project)
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', project: SECOND_PROJECT })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by #5 to #7\n')
  })

  it('.active が存在しなくても、待つ側のリポを含む設定が 1 つならその設定で動く', async () => {
    await explains('`issue_block` のプロジェクトの設定の選択のテストです。`.active` が存在しなくても、待つ側のリポジトリを含む設定が 1 つであれば、その設定で前提を付けることを確認します。')
    const project = prepareDependencyProject()
    removeActive(project)
    await startGithub([
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Ready', body: BODY, blockedBy: [{ number: 5 }] }), boardItems(), fieldUpdated('o7'),
    ])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: blocked-by #5 to #7\n')
  })

  it('GitHub API がエラーを返したとき、終了コード 1 で止める', async () => {
    await explains('`issue_block` の GitHub API のエラーのテストです。GitHub API がエラーを返した場合に、終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const failing = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), failing])

    const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read blocked-by of #7: /u)
  })

  describe('Status が Needs Attention の Issue に、済んだ前提を付ける', () => {
    const merged: IssueSpec = { number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }
    const addMerged = (...after: readonly ResponseRule[]): ResponseRule[] => [
      bothLinked(), targetReferences(7, BODY, []), nodeIdRule(5), levelRule([nodeId(5)], {}), addBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [merged] }), ...after,
    ]

    it('自動処理の結果のコメントが存在しないと、列を Ready へ戻した後でStatus を Todo にする', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      await explains('Status が Needs Attention の Issue に済んだ前提を付ける、`issue_block` のテストです。自動処理の結果のコメントが存在しない場合に、列を Ready へ戻してから Status を Todo にすることを確認します。')
      prepareDependencyProject()
      const github = await startGithub(addMerged(commentsRule(7), boardItems(), fieldUpdated('o3'), labelUpdated('s2')))

      const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    })

    it('bot が書いた最後の自動処理の結果が limit なら、列は Ready に戻し、Status を Todo に戻さない', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-28')
      await explains('Status が Needs Attention の Issue に済んだ前提を付ける、`issue_block` のテストです。bot が書いた最後の自動処理の結果が `limit` の場合に、列は Ready へ戻し、Status は Todo に戻さないことを確認します。')
      prepareDependencyProject()
      const comments = commentsRule(7, [botResult('limit')])
      const github = await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3')))

      const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\n' })
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField'])
    })

    it('人が書いた自動処理の結果の目印しか存在しないなら、Status を Todo に戻す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      await explains('Status が Needs Attention の Issue に済んだ前提を付ける、`issue_block` のテストです。自動処理の結果の目印が人の書いたものだけの場合に、Status を Todo に戻すことを確認します。')
      prepareDependencyProject()
      const comments = commentsRule(7, [humanResult('limit')])
      const github = await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3'), labelUpdated('s2')))

      const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(result.stderr).toBe('added: blocked-by #5 to #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n')
      expect(writes(github)).toEqual(['AddBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    })

    it('コメントを読めないと、前提は付けたまま、判定できない warning を出して列と Status を動かさない', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-29')
      await explains('Status が Needs Attention の Issue に済んだ前提を付ける、`issue_block` のテストです。コメントを読めない場合に、前提は付けたまま、判定できない旨の warning を出力して列と Status を動かさないことを確認します。')
      prepareDependencyProject()
      const github = await startGithub(addMerged(commentsFailure(7)))

      const result = await block({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: blocked-by #5 to #7\nwarning: could not judge readiness of #7: GitHub API error: 500; the column and label of #7 were not moved\n' })
      expect(writes(github)).toEqual(['AddBlockedBy'])
    })

    it('bot が書いた最後の自動処理の結果が question なら、Status を戻さず、列の動きだけを moves に入れて data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-28')
      await explains('MCP ツール `issue_block` のテストです。bot が書いた最後の自動処理の結果が `question` の場合に、Status は戻さず、列の動きだけを `moves` に入れて `data` に返すことを確認します。')
      prepareDependencyProject()
      const comments = commentsRule(7, [botResult('question')])
      await startGithub(addMerged(comments, boardItems(), fieldUpdated('o3')))

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'stack', change: 'added', moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }] })
    })

    it('コメントを読めないと、空の moves と判定できない旨の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-29')
      await explains('MCP ツール `issue_block` のテストです。コメントを読めない場合に、空の `moves` と判定できない旨の warning を `data` に返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の基本の動作のテストです。前提を付けた場合に、Issue・前提の参照・種類・`added`・動かした列を `data` に返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の着手の跡がある Issue のテストです。列を動かさない場合に、空の `moves` を `data` に返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の反映の確認のテストです。読み直した前提が書いた内容と一致しない場合に、空の `moves` と理由の warning を `data` に返すことを確認します。')
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

    it('動かす先の列がボードに存在しないとき、空の moves と理由の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-17')
      await verifies(context, 'PW-ISSUE-BLOCK-24')
      await explains('MCP ツール `issue_block` の Blocked の選択肢のテストです。ボードが動かす先の列を持たない場合に、空の `moves` と理由の warning を `data` に返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の理由の変更のテストです。既に付いている前提の理由を変えた場合に、`updated` を `data` に返すことを確認します。')
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
      await explains('MCP ツール `issue_block` を既に付いている前提へ重ねるテストです。種類と理由が同じ場合に、何も書かず `unchanged` を `data` に返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', reason: 'main の版が要る' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'merge', change: 'unchanged', moves: [] })
      expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
    })

    it('種類を stack に戻すと、節から行を外して updated を返し、スタック可の判定なら列を Ready に戻して moves に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-03')
      await verifies(context, 'PW-ISSUE-BLOCK-06')
      await explains('MCP ツール `issue_block` の種類を戻すテストです。前提を `stack` へ戻した場合に、節から行を外して `updated` を返し、スタック可の判定なら列を Ready に戻して `moves` に入れることを確認します。')
      prepareDependencyProject()
      const inReview = { number: 5, branch: 'feat/5', pullRequests: [{ number: 50, head: 'feat/5' }] }
      await startGithub([
        bothLinked(), targetReferences(7, MERGE_BODY, [{ number: 5 }]), bodyWritten(7, BODY),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [inReview] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', wait: 'stack', change: 'updated', moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'stackable on #5' }] })
    })

    it('選択肢の ID が古くて Status を書けないと、前提を付けたまま warnings に project_activate の案内を入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-25')
      await explains('MCP ツール `issue_block` の Status の書き込みが失敗した場合のテストです。古い選択肢の ID で書き込みが失敗した場合に、前提は付けたまま、`project_activate` の案内を `warnings` に入れて成功を返すことを確認します。')
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

    it('by がプロジェクトに登録されていない別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を付ける', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-23')
      await explains('MCP ツール `issue_block` のプロジェクトの登録のテストです。`by` のリポジトリがプロジェクトに登録されていない場合でも、待つ側のリポジトリだけを確認して前提を付けることを確認します。')
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
    ])('付けると $name で前提が循環するとき、書き込みを送らずに kind が dependency-rejected の失敗を返す', async ({ edges, line }, context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-10')
      await explains('MCP ツール `issue_block` の循環の検証のテストです。前提を付けると 2 つか 3 つの Issue で循環する場合に、書き込みは送らず、`kind` が `dependency-rejected` の失敗を返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の引数の検証のテストです。`by` が待つ側と同じ Issue の場合に、要求は送らず、`kind` が `dependency-rejected` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: 'blocked-by would form a cycle: #7 -> #7' })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: '循環の確認に要る Issue が読めない', detail: 'could not check blocked-by cycle of #7: could not read blocked-by of #5: the node is not an Issue or was not found', big: false },
      { name: 'たどる Issue が 200 件を超える', detail: 'could not check blocked-by cycle of #7: more than 200 issues in the blocked-by chain', big: true },
    ])('$name とき、前提を付けずに kind が dependency-unreadable の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-11')
      await explains('MCP ツール `issue_block` の循環の検証のテストです。循環の確認に要る Issue を読めない場合と、たどる Issue が 200 件を超える場合に、前提は付けず、`kind` が `dependency-unreadable` の失敗を返すことを確認します。')
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
      { name: 'wait が merge で reason を渡していない', id: 'PW-ISSUE-BLOCK-12', extra: { wait: 'merge' }, detail: 'reason is required with wait: "merge"' },
      { name: 'wait が stack で reason を渡した', id: 'PW-ISSUE-BLOCK-13', extra: { wait: 'stack', reason: 'x' }, detail: 'reason is only valid with wait: "merge"' },
      { name: 'wait を省いて reason を渡した', id: 'PW-ISSUE-BLOCK-13', extra: { reason: 'x' }, detail: 'reason is only valid with wait: "merge"' },
    ])('$name とき、要求を送らずに kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      await explains('MCP ツール `issue_block` の `reason` の検証のテストです。`wait` と `reason` の組み合わせが誤っている場合に、要求は送らず、`kind` が `invalid-input` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', ...row.extra })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: row.detail })
      expect(github.requests()).toEqual([])
    })

    it('前提が 50 件あるとき、新しい前提を付けずに kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-14')
      await explains('MCP ツール `issue_block` の前提の上限のテストです。前提が既に 50 件ある場合に、新しい前提は付けず、`kind` が `dependency-rejected` の失敗を返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の本文の検証のテストです。本文の節を読み取れない場合に、書き込みは送らず、`kind` が `content-invalid` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, '## Waits for merge\n\nplain text\n', [])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'content-invalid', detail: 'Waits for merge of #7 is malformed: not a list item: plain text; fix the section in the Issue body and call the tool again' })
      expect(writes(github)).toEqual([])
    })

    it('依存関係に対応しない GHES では、kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-18')
      await explains('MCP ツール `issue_block` の GitHub Enterprise Server のテストです。依存関係に対応していない版の場合に、`kind` が `dependency-rejected` の失敗を返すことを確認します。')
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
      await explains('MCP ツール `issue_block` の Issue の参照を検証するテストです。参照の形が誤っている場合に、要求は送らず、`kind` が `invalid-input` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await blockTool({ issue_ref: 'invalid-format', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('invalid reference')
      expect(github.requests()).toEqual([])
    })

    it('リポジトリがプロジェクトに登録されていないとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-20')
      await explains('MCP ツール `issue_block` のプロジェクトの登録を検証するテストです。リポジトリがプロジェクトに登録されていない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      prepareDependencyProject()
      await startGithub([linkedRepositories(['other'])])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'repository acme/demo is not in the project' })
    })

    it('待つ側のリポを含む設定が存在しないとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-26')
      await explains('MCP ツール `issue_block` のプロジェクトの設定の選択のテストです。待つ側のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      setUpProject({ repositories: ['other'] })

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-21')
      await explains('MCP ツール `issue_block` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、`kind` が `no-active-project` の失敗を返し、`detail` に候補と案内を入れることを確認します。')
      const project = setUpProject()
      makeAmbiguous(project)
      await startGithub([])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async (context) => {
      await verifies(context, 'PW-ISSUE-BLOCK-27')
      await explains('MCP ツール `issue_block` の `project` のテストです。待つ側のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定で前提を付けることを確認します。')
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
      await explains('MCP ツール `issue_block` の GitHub API のエラーのテストです。本文の書き込みが失敗した場合と、GitHub API がエラーを返した場合に、`kind` が `github-api` の失敗を返すことを確認します。')
      prepareDependencyProject()
      await startGithub([bothLinked(), ...row.rules()])

      const outcome = await blockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', ...row.wait })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(row.detail)
    })
  })
})
