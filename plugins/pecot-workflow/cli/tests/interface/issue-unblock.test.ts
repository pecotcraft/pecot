import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_TOOLS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { requestLabels, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { bodyWritten, bothLinked, labelUpdated, prepareDependencyProject, removeBlockedByRule, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/board-issue-case.js'
import { botResult, commentsFailure, commentsRule, humanResult, prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function unblock(arguments_: Readonly<Record<string, unknown>> = {}): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess('issue_unblock', arguments_, ISSUE_DEPENDENCY_TOOLS)
}

const BODY = '## Summary\n\n本文\n'
const WITH_SECTION = `${BODY}\n${WAITS_SECTION(['#5: main の版が要る'])}`

function writes(github: Readonly<RunningGithub>): readonly string[] {
  return requestLabels(github.requests()).filter(label => ['RemoveBlockedBy', 'UpdateProjectItemField'].includes(label) || label.startsWith('PATCH'))
}

async function unblockTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_DEPENDENCY_TOOLS, 'issue_unblock', argumentsOfTool)
}

describe('issue_unblock', () => {
  it('Issue と by を渡すと、前提を外して removed の行を出し、節の行を外し、判定が変われば列を Ready に動かす', async () => {
    await explains('前提（blocked by）を外す、`issue_unblock` の基本的な動作のテストです。`by` で指定した前提を外した場合に、`removed` の行を出力して本文の節の行を削除し、判定が変わればボードの列を `Ready` へ動かすことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('前提の一覧を読み切れず、外す前提が見つからないと、何も書かずに終了コード 1 で止める', async () => {
    await explains('前提を外す、`issue_unblock` の読み取りのテストです。前提の一部しか読めず、読めた分に `by` の前提が無い場合は、何も書かず、読めた件数を添えて終了コード 1 で終わることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 6 }], 3)])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not read blocked-by of #7: 1 of 3 issues were read\n' })
    expect(writes(github)).toEqual([])
  })

  it('選択肢の ID が古くて列を書けないと、前提を外したまま warning と project_activate の案内を出し、終了コード 0 で終わる', async () => {
    await explains('Status の選択肢の ID が古くなっている場合の、`issue_unblock` のテストです。列を書き込めないときに、前提は外したまま、`warning` と `project_activate` の案内を出力して終了コード 0 で終了することを確認します。')
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), staleOptionUpdate(),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: [
        'removed: blocked-by #5 from #7',
        `warning: could not move #7: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
        '',
      ].join('\n'),
    })
  })

  it('by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を外す', async () => {
    await explains('`by` に、プロジェクトへリンクされていない別のリポジトリの Issue を指定した場合の、`issue_unblock` のテストです。待つ側のリポジトリだけを確認して前提を外すことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, repo: 'other' }]), removeBlockedByRule(7, 5, 'other'),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/other/5' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by acme/other#5 from #7\n')
    expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
  })

  it('節に前提が 2 行あるとき、外した前提の行だけを節から消す', async () => {
    await explains('本文の節に前提が 2 行ある Issue の前提を外す、`issue_unblock` のテストです。1 つの前提を外した場合に、外した前提の行だけを節から削除することを確認します。')
    prepareDependencyProject()
    const both = `${BODY}\n${WAITS_SECTION(['#5: first', '#6: second'])}`
    const rest = `${BODY}\n${WAITS_SECTION(['#6: second'])}`
    await startGithub([
      bothLinked(), targetReferences(7, both, [{ number: 5 }, { number: 6 }]), removeBlockedByRule(7, 5), bodyWritten(7, rest),
      prerequisitesRule({ number: 7, column: 'Blocked', body: rest, blockedBy: [{ number: 6 }] }),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\n' })
  })

  it('付いていない前提を外すと、何も書かずに unchanged の行を出し、節に残った古い行も書き換えない', async () => {
    await explains('Issue に付いていない前提を外そうとした場合の、`issue_unblock` のテストです。何も書き込まず、`unchanged` の行を出力し、節に残った古い行も書き換えないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: #7 is not blocked by #5\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('Status が Needs Attention で、閉じた前提を外すと、列を戻した後に Status を Todo にする', async () => {
    await explains('Status が `Needs Attention` の Issue から、閉じた前提を外す場合の、`issue_unblock` のテストです。ボードの列を戻した後で、Status を `Todo` にすることを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
  })

  it('Status が Needs Attention で、bot が書いた最後の自動処理の結果が question なら、閉じた前提を外しても Status を Todo に戻さない', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-22')
    await explains('Status が `Needs Attention` の Issue から、閉じた前提を外す場合の、`issue_unblock` のテストです。bot が書いた最後の自動処理の結果が `question` のときは、Status を `Todo` に戻さないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7, [botResult('question')]), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('Status が Needs Attention で、人が書いた自動処理の結果の目印しか無いなら、閉じた前提を外すと Status を Todo に戻す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-05')
    await explains('Status が `Needs Attention` の Issue から、閉じた前提を外す場合の、`issue_unblock` のテストです。人が自動処理の結果の目印だけを書いているときは、bot の結果として扱わず、Status を `Todo` に戻すことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7, [humanResult('question')]), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
  })

  it('Status が Needs Attention の Issue のコメントを読めないと、前提は外し、判定を出せない warning を出して列と Status を動かさない', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-23')
    await explains('Status が `Needs Attention` の Issue のコメントを取得できない場合の、`issue_unblock` のテストです。前提は外し、判定できない旨の `warning` を出力して、列と Status は動かさないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsFailure(7),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nwarning: could not judge readiness of #7: GitHub API error: 500; the column and label of #7 were not moved\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('Status が Needs Attention でも、開いた最後の前提を外しただけなら、Status を戻さない', async () => {
    await explains('Status が `Needs Attention` の Issue から、開いた最後の前提を外す場合の、`issue_unblock` のテストです。ボードの列は動かすが、Status は戻さないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('着手の跡がある Issue から外すと、前提は外し、列と Status は動かさない', async () => {
    await explains('着手した形跡のある Issue から前提を外す場合の、`issue_unblock` のテストです。ブランチがあり、`Active` の列にある Issue では、前提だけを外し、列と Status は動かさないことを確認します。')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Active', label: 'Needs Attention', branch: 'feat/7', body: BODY, blockedBy: [] }),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('本文の節が読めないとき、前提だけを外し、節を直していない旨を warning で出す', async () => {
    await explains('本文の `Waits for merge` の節の書式が誤っている場合の、`issue_unblock` のテストです。節を解析できないときに、前提だけを外し、節は変更していない旨を `warning` に出力することを確認します。')
    prepareDependencyProject()
    const malformed = '## Waits for merge\n\nplain text\n'
    const github = await startGithub([
      bothLinked(), targetReferences(7, malformed, [{ number: 5 }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', body: malformed, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'removed: blocked-by #5 from #7\nwarning: Waits for merge of #7 is malformed: not a list item: plain text; the section was not changed\nmoved: #7 Blocked -> Ready (startable)\n',
    })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('読み直した前提が書いた内容と合わないとき、列と Status を動かさずに warning を出して終了コード 0 で終わる', async () => {
    await explains('前提を外した後の再取得の結果が、書き込んだ内容と合わない場合の、`issue_unblock` のテストです。前提がまだ残って見えるときに、列と Status は動かさず、`warning` を出力して終了コード 0 で終了することを確認します。')
    prepareDependencyProject()
    const stale = prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [{ number: 5 }] })
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5), stale, stale])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nwarning: could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('動かす先の Status（Todo）の選択肢がボードに存在しないとき、列は動かし、warning と project_init の hint を出す', async () => {
    await explains('動かす先の Status の選択肢がボードに存在しない場合の、`issue_unblock` のテストです。`Todo` の選択肢がないときに、列だけを動かし、`warning` と `project_init` の `hint` を出力することを確認します。')
    prepareDependencyProject({ omit: ['todo'] })
    await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nwarning: the Todo option is not on the board, so #7 was not moved\n  hint: call project_init to add the Todo option to the board\n',
    })
  })

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async () => {
    await explains('Issue の依存関係に対応していない GHES での、`issue_unblock` のテストです。GraphQL の応答が非対応を示す場合に、`error` の行を出力して終了コード 1 で終了することを確認します。')
    prepareDependencyProject()
    const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
    const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
    await startGithub([bothLinked(), unsupported])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n',
    })
  })

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async () => {
    await explains('Issue の参照の形式が誤っている場合の、`issue_unblock` のテストです。`invalid-format` のような参照を渡したときに、要求を送信せず、終了コード 2 で終了することを確認します。')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await unblock({ issue_ref: 'invalid-format', by: 'acme/demo/5' })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに無いとき、終了コード 1 で止める', async () => {
    await explains('リポジトリがプロジェクトにリンクされていない場合の、`issue_unblock` のテストです。対象のリポジトリがプロジェクトに存在しないときは、`error` を出力して終了コード 1 で終了することを確認します。')
    prepareDependencyProject()
    await startGithub([linkedRepositories(['other'])])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と project の案内を出して終了コード 1 で止める', async () => {
    await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、`issue_unblock` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `project` の案内を出力して終了コード 1 で終了することを確認します。')
    const project = setUpProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('待つ側のリポを含む設定が無いとき、error を出して終了コード 1 で止める', async () => {
    await explains('待つ側のリポジトリを含むプロジェクトの設定が存在しない場合の、`issue_unblock` のテストです。該当する設定がないときに、`error` の行を出力して終了コード 1 で終了することを確認します。')
    setUpProject({ repositories: ['other'] })

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async () => {
    await explains('`issue_unblock` の `project` オプションのテストです。待つ側のリポジトリを含む設定が 2 つある場合でも、`project` で設定を指定したときに、その設定で前提を外すことを確認します。')
    const project = prepareDependencyProject()
    makeAmbiguous(project)
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', project: SECOND_PROJECT })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by #5 from #7\n')
  })

  it('.active が無くても、待つ側のリポを含む設定が 1 つならその設定で動く', async () => {
    await explains('`.active` が存在しない場合の、`issue_unblock` のテストです。待つ側のリポジトリを含む設定が 1 つだけのときに、その設定で前提を外すことを確認します。')
    const project = prepareDependencyProject()
    removeActive(project)
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by #5 from #7\n')
  })

  it('前提を外す要求が失敗したとき、error を出して終了コード 1 で止める', async () => {
    await explains('前提を外す GitHub API の要求が失敗した場合の、`issue_unblock` のテストです。要求が 502 を返したときに、`could not remove blocked-by` の `error` を出力して終了コード 1 で終了することを確認します。')
    prepareDependencyProject()
    const failing: ResponseRule = { match: { operation: 'RemoveBlockedBy' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), failing])

    const result = await unblock({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not remove blocked-by #5 from #7: /u)
  })

  describe('MCP の data', () => {
    it('前提を外すと、節の行を外し、Issue と前提の参照と removed と、動かした列を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-01')
      await verifies(context, 'PW-ISSUE-UNBLOCK-03')
      await verifies(context, 'PW-ISSUE-UNBLOCK-04')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      await explains('前提を外した結果を返す、MCP の `issue_unblock` のテストです。前提を外した場合に、Issue と前提の参照、`removed`、動かした列を `data` に含めて返し、本文の節の行も削除することを確認します。')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }],
      })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
    })

    it('Status が Needs Attention で閉じた前提を外すと、Status を Todo に戻し、moves の要素に label を入れて data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-05')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      await explains('Status が `Needs Attention` の Issue から、閉じた前提を外す場合の、MCP の `issue_unblock` のテストです。Status を `Todo` に戻し、`moves` の要素に `label` を含めて `data` に返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', label: 'Todo', reason: 'startable' }],
      })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    })

    it('Status が Needs Attention で、bot が書いた最後の自動処理の結果が failed なら、Status を戻さず、列の動きだけを moves に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-22')
      await explains('Status が `Needs Attention` の Issue から、閉じた前提を外す場合の、MCP の `issue_unblock` のテストです。bot が書いた最後の自動処理の結果が `failed` のときは、Status を戻さず、列の移動だけを `moves` に含めることを確認します。')
      prepareDependencyProject()
      await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7, [botResult('failed')]), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }],
      })
    })

    it('Status が Needs Attention の Issue のコメントを読めないと、空の moves と判定を出せない旨の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-23')
      await explains('Status が `Needs Attention` の Issue のコメントを取得できない場合の、MCP の `issue_unblock` のテストです。`moves` を空にし、判定できない旨の警告を `warnings` に含めて返すことを確認します。')
      prepareDependencyProject()
      await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsFailure(7),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [],
        warnings: ['could not judge readiness of #7: GitHub API error: 500; the column and label of #7 were not moved'],
      })
    })

    it('読み直した前提が書いた内容と合わないとき、空の moves と理由の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-10')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      await explains('前提を外した後の再取得の結果が、書き込んだ内容と合わない場合の、MCP の `issue_unblock` のテストです。`moves` を空にし、理由を示す警告を `warnings` に含めて返すことを確認します。')
      prepareDependencyProject()
      const stale = prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [{ number: 5 }] })
      await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5), stale, stale])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [],
        warnings: ['could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved'],
      })
    })

    it('付いていない前提を外すと、何も書かずに unchanged と空の moves を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-02')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      await explains('Issue に付いていない前提を外そうとした場合の、MCP の `issue_unblock` のテストです。何も書き込まず、`change` が `unchanged` で `moves` が空の `data` を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'unchanged', moves: [] })
      expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
    })

    it('選択肢の ID が古くて列を書けないと、前提を外したまま warnings に project_activate の案内を入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-19')
      await explains('Status の選択肢の ID が古くなっている場合の、MCP の `issue_unblock` のテストです。列を書き込めないときに、前提は外したまま、`project_activate` の案内を `warnings` に含めて成功を返すことを確認します。')
      prepareDependencyProject()
      await startGithub([
        bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), staleOptionUpdate(),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [],
        warnings: [`could not move #7: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`],
      })
    })

    it('by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を外す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-17')
      await explains('`by` に、プロジェクトへリンクされていない別のリポジトリの Issue を指定した場合の、MCP の `issue_unblock` のテストです。待つ側のリポジトリだけを確認して前提を外すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, repo: 'other' }]), removeBlockedByRule(7, 5, 'other'),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/other/5' })

      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', by: 'acme/other/5', change: 'removed' })
      expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
    })

    it('節に前提が 2 行あるとき、外した前提の行だけを節から消す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-03')
      await explains('本文の節に前提が 2 行ある Issue の前提を外す、MCP の `issue_unblock` のテストです。1 つの前提を外した場合に、外した前提の行だけを節から削除することを確認します。')
      prepareDependencyProject()
      const both = `${BODY}\n${WAITS_SECTION(['#5: first', '#6: second'])}`
      const rest = `${BODY}\n${WAITS_SECTION(['#6: second'])}`
      const github = await startGithub([
        bothLinked(), targetReferences(7, both, [{ number: 5 }, { number: 6 }]), removeBlockedByRule(7, 5), bodyWritten(7, rest),
        prerequisitesRule({ number: 7, column: 'Blocked', body: rest, blockedBy: [{ number: 6 }] }),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'removed', moves: [] })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'PATCH /repos/acme/demo/issues/7'])
    })

    it('Status が Needs Attention でも、開いた最後の前提を外しただけなら、Status を戻さない', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-06')
      await explains('Status が `Needs Attention` の Issue から、開いた最後の前提を外す場合の、MCP の `issue_unblock` のテストです。ボードの列は動かすが、Status は戻さないことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toMatchObject({ moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }] })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
    })

    it('着手の跡がある Issue から外すと、前提は外し、列と Status は動かさない', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-07')
      await explains('着手した形跡のある Issue から前提を外す場合の、MCP の `issue_unblock` のテストです。ブランチがあり、`Active` の列にある Issue では、前提だけを外し、列と Status は動かさないことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Active', label: 'Needs Attention', branch: 'feat/7', body: BODY, blockedBy: [] }),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'removed', moves: [] })
      expect(writes(github)).toEqual(['RemoveBlockedBy'])
    })

    it('本文の節が読めないとき、前提だけを外し、節を直していない旨を warnings に入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-09')
      await explains('本文の `Waits for merge` の節の書式が誤っている場合の、MCP の `issue_unblock` のテストです。節を解析できないときに、前提だけを外し、節は変更していない旨を `warnings` に含めることを確認します。')
      prepareDependencyProject()
      const malformed = '## Waits for merge\n\nplain text\n'
      const github = await startGithub([
        bothLinked(), targetReferences(7, malformed, [{ number: 5 }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', body: malformed, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }],
        warnings: ['Waits for merge of #7 is malformed: not a list item: plain text; the section was not changed'],
      })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
    })

    it('動かす先の Status（Todo）の選択肢がボードに存在しないとき、列は動かし、warnings に project_init の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-11')
      await explains('動かす先の Status の選択肢がボードに存在しない場合の、MCP の `issue_unblock` のテストです。`Todo` の選択肢がないときに、列だけを動かし、`project_init` の案内を `warnings` に含めることを確認します。')
      prepareDependencyProject({ omit: ['todo'] })
      await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), commentsRule(7), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }],
        warnings: ['the Todo option is not on the board, so #7 was not moved\n  hint: call project_init to add the Todo option to the board'],
      })
    })

    it('依存関係に対応しない GHES では、kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-12')
      await explains('Issue の依存関係に対応していない GHES での、MCP の `issue_unblock` のテストです。GraphQL の応答が非対応を示す場合に、種別 `dependency-rejected` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
      const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
      await startGithub([bothLinked(), unsupported])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'dependency-rejected', detail: 'could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required' })
    })

    it('Issue の参照の形が誤っているとき、要求を送らずに kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-13')
      await explains('Issue の参照の形式が誤っている場合の、MCP の `issue_unblock` のテストです。`invalid-format` のような参照を渡したときに、要求を送信せず、種別 `invalid-input` の失敗を返すことを確認します。')
      prepareDependencyProject()
      const github = await startGithub([])

      const outcome = await unblockTool({ issue_ref: 'invalid-format', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toMatch(/^invalid reference: invalid-format\n/u)
      expect(github.requests()).toEqual([])
    })

    it('リポジトリがプロジェクトに無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-14')
      await explains('リポジトリがプロジェクトにリンクされていない場合の、MCP の `issue_unblock` のテストです。対象のリポジトリがプロジェクトに存在しないときは、種別 `repo-not-in-project` の失敗を返すことを確認します。')
      prepareDependencyProject()
      await startGithub([linkedRepositories(['other'])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'repository acme/demo is not in the project' })
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-15')
      await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、MCP の `issue_unblock` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `project` の案内を含む種別 `no-active-project` の失敗を返すことを確認します。')
      makeAmbiguous(setUpProject())
      const github = await startGithub([])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
      expect(github.requests()).toEqual([])
    })

    it('待つ側のリポを含む設定が無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-20')
      await explains('待つ側のリポジトリを含むプロジェクトの設定が存在しない場合の、MCP の `issue_unblock` のテストです。該当する設定がないときに、種別 `repo-not-in-project` の失敗を返すことを確認します。')
      setUpProject({ repositories: ['other'] })

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-21')
      await explains('MCP の `issue_unblock` の `project` 入力のテストです。待つ側のリポジトリを含む設定が 2 つある場合でも、`project` で設定を指定したときに、その設定で前提を外すことを確認します。')
      makeAmbiguous(prepareDependencyProject())
      await startGithub([
        bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
        prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', project: SECOND_PROJECT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', change: 'removed' })
    })

    it('前提を外す要求が失敗したとき、失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-16')
      await explains('前提を外す GitHub API の要求が失敗した場合の、MCP の `issue_unblock` のテストです。要求が 502 を返したときに、種別 `github-api` の失敗を返し、`detail` に `could not remove blocked-by` を含めることを確認します。')
      prepareDependencyProject()
      const failing: ResponseRule = { match: { operation: 'RemoveBlockedBy' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
      await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), failing])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not remove blocked-by #5 from #7: /u)
    })
  })
})
