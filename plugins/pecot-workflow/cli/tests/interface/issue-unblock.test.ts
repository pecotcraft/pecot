import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_COMMANDS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { requestLabels, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { bodyWritten, bothLinked, labelUpdated, prepareDependencyProject, removeBlockedByRule, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/board-issue-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { ResponseRule } from '../fake-github/server.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function unblock(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'unblock', ...argv], ISSUE_DEPENDENCY_COMMANDS)
}

const BODY = '## Summary\n\n本文\n'
const WITH_SECTION = `${BODY}\n${WAITS_SECTION(['#5: main の版が要る'])}`

function writes(github: Readonly<RunningGithub>): readonly string[] {
  return requestLabels(github.requests()).filter(label => ['RemoveBlockedBy', 'UpdateProjectItemField'].includes(label) || label.startsWith('PATCH'))
}

async function unblockTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_DEPENDENCY_COMMANDS, 'issue_unblock', argumentsOfTool)
}

describe('issue unblock', () => {
  it('Issue と --by を渡すと、前提を外して removed の行を出し、節の行を外し、判定が変われば列を Ready に動かす', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('選択肢の ID が古くて列を書けないと、前提を外したまま warning と project activate の案内を出し、終了コード 0 で終わる', async () => {
    prepareDependencyProject()
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), staleOptionUpdate(),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: [
        'removed: blocked-by #5 from #7',
        `warning: could not move #7: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        '',
      ].join('\n'),
    })
  })

  it('--by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を外す', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, repo: 'other' }]), removeBlockedByRule(7, 5, 'other'),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/other/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by acme/other#5 from #7\n')
    expect(requestLabels(github.requests()).filter(label => label === 'GetLinkedRepositoriesUser')).toHaveLength(1)
  })

  it('節に前提が 2 行あるとき、外した前提の行だけを節から消す', async () => {
    prepareDependencyProject()
    const both = `${BODY}\n${WAITS_SECTION(['#5: first', '#6: second'])}`
    const rest = `${BODY}\n${WAITS_SECTION(['#6: second'])}`
    await startGithub([
      bothLinked(), targetReferences(7, both, [{ number: 5 }, { number: 6 }]), removeBlockedByRule(7, 5), bodyWritten(7, rest),
      prerequisitesRule({ number: 7, column: 'Blocked', body: rest, blockedBy: [{ number: 6 }] }),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\n' })
  })

  it('付いていない前提を外すと、何も書かずに unchanged の行を出し、節に残った古い行も書き換えない', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: #7 is not blocked by #5\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('札が Needs Attention で、閉じた前提を外すと、列を戻した後に札を Todo にする', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
  })

  it('札が Needs Attention でも、開いた最後の前提を外しただけなら、札を戻さない', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('着手の跡がある Issue から外すと、前提は外し、列と札は動かさない', async () => {
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Active', label: 'Needs Attention', branch: 'feat/7', body: BODY, blockedBy: [] }),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('--dry-run を付けると、読み取りだけ行い、書き込みを送らずに dry-run の行を出す', async () => {
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5', '--dry-run')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would remove blocked-by #5 from #7\n' })
    expect(writes(github)).toEqual([])
  })

  it('本文の節が読めないとき、前提だけを外し、節を直していない旨を warning で出す', async () => {
    prepareDependencyProject()
    const malformed = '## Waits for merge\n\nplain text\n'
    const github = await startGithub([
      bothLinked(), targetReferences(7, malformed, [{ number: 5 }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', body: malformed, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'removed: blocked-by #5 from #7\nwarning: Waits for merge of #7 is malformed: not a list item: plain text; the section was not changed\nmoved: #7 Blocked -> Ready (startable)\n',
    })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('読み直した前提が書いた内容と合わないとき、列と札を動かさずに warning を出して終了コード 0 で終わる', async () => {
    prepareDependencyProject()
    const stale = prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [{ number: 5 }] })
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5), stale, stale])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nwarning: could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('動かす先の札がボードに無いとき、列は動かし、warning と project init の hint を出す', async () => {
    prepareDependencyProject({ omit: ['todo'] })
    await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nwarning: the Todo option is not on the board, so #7 was not moved\n  hint: run pecot project init to add the Todo option to the board\n',
    })
  })

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const message = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''
    const unsupported: ResponseRule = { match: { operation: 'GetIssueBlockedByReferences' }, respond: { status: 200, body: { errors: [{ message }] } }, times: 1 }
    await startGithub([bothLinked(), unsupported])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: could not read blocked-by of #7: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n',
    })
  })

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async () => {
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await unblock('invalid-format', '--by', 'acme/demo/5')

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに無いとき、終了コード 1 で止める', async () => {
    prepareDependencyProject()
    await startGithub([linkedRepositories(['other'])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で止める', async () => {
    const project = setUpProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('待つ側のリポを含む設定が無いとき、error を出して終了コード 1 で止める', async () => {
    setUpProject({ repositories: ['other'] })

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async () => {
    const project = prepareDependencyProject()
    makeAmbiguous(project)
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5', '--project', SECOND_PROJECT)

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by #5 from #7\n')
  })

  it('.active が無くても、待つ側のリポを含む設定が 1 つならその設定で動く', async () => {
    const project = prepareDependencyProject()
    removeActive(project)
    await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('removed: blocked-by #5 from #7\n')
  })

  it('前提を外す要求が失敗したとき、error を出して終了コード 1 で止める', async () => {
    prepareDependencyProject()
    const failing: ResponseRule = { match: { operation: 'RemoveBlockedBy' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), failing])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not remove blocked-by #5 from #7: /u)
  })

  describe('MCP の data', () => {
    it('前提を外すと、節の行を外し、Issue と前提の参照と removed と、動かした列を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-01')
      await verifies(context, 'PW-ISSUE-UNBLOCK-03')
      await verifies(context, 'PW-ISSUE-UNBLOCK-04')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
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

    it('札が Needs Attention で閉じた前提を外すと、札を Todo に戻し、moves の要素に label を入れて data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-05')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
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

    it('読み直した前提が書いた内容と合わないとき、空の moves と理由の warning を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-10')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
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
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'unchanged', moves: [] })
      expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
    })

    it('dry_run で付いていない前提を外すと、moves を入れずに unchanged と dryRun を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      prepareDependencyProject()
      await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', dry_run: true })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'unchanged', dryRun: true })
    })

    it('dry_run で打つと、書き込みを送らずに、外す予定の removed と dryRun を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-08')
      await verifies(context, 'PW-ISSUE-UNBLOCK-18')
      prepareDependencyProject()
      const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5', dry_run: true })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', by: 'acme/demo/5', change: 'removed', dryRun: true })
      expect(writes(github)).toEqual([])
    })

    it('選択肢の ID が古くて列を書けないと、前提を外したまま warnings に project_activate の案内を入れて成功を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-19')
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
        warnings: [`could not move #7: ${STALE_OPTION_TEXT}\nhint: if the board options were recreated, run project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`],
      })
    })

    it('by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を外す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-17')
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

    it('札が Needs Attention でも、開いた最後の前提を外しただけなら、札を戻さない', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-06')
      prepareDependencyProject()
      const github = await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toMatchObject({ moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }] })
      expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
    })

    it('着手の跡がある Issue から外すと、前提は外し、列と札は動かさない', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-07')
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

    it('動かす先の札がボードに無いとき、列は動かし、warnings に project_init の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-11')
      prepareDependencyProject({ omit: ['todo'] })
      await startGithub([
        bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
        prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
      ])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        by: 'acme/demo/5',
        change: 'removed',
        moves: [{ issue: '#7', from: 'Blocked', to: 'Ready', reason: 'startable' }],
        warnings: ['the Todo option is not on the board, so #7 was not moved\nhint: run project_init to add the Todo option to the board'],
      })
    })

    it('依存関係に対応しない GHES では、kind が dependency-rejected の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-12')
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
      prepareDependencyProject()
      await startGithub([linkedRepositories(['other'])])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'repository acme/demo is not in the project' })
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-15')
      makeAmbiguous(setUpProject())
      const github = await startGithub([])

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
      expect(github.requests()).toEqual([])
    })

    it('待つ側のリポを含む設定が無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-20')
      setUpProject({ repositories: ['other'] })

      const outcome = await unblockTool({ issue_ref: 'acme/demo/7', by: 'acme/demo/5' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、待つ側のリポを含む設定が 2 つあってもその設定で動く', async (context) => {
      await verifies(context, 'PW-ISSUE-UNBLOCK-21')
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
