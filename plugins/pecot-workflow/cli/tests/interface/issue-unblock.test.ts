import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_DEPENDENCY_COMMANDS } from '../../src/commands/issue-dependency.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { requestLabels } from '../_helpers/command-harness.js'
import { runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { bodyWritten, bothLinked, labelUpdated, prepareDependencyProject, removeBlockedByRule, targetReferences, WAITS_SECTION } from '../_helpers/issue-dependency-case.js'
import { boardItems, fieldUpdated, linkedRepositories } from '../_helpers/issue-project-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { ResponseRule } from '../fake-github/server.js'
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

describe('issue unblock', () => {
  it('Issue と --by を渡すと、前提を外して removed の行を出し、節の行を外し、判定が変われば列を Ready に動かす', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-01')
    await verifies(context, 'PW-ISSUE-UNBLOCK-03')
    await verifies(context, 'PW-ISSUE-UNBLOCK-04')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }]), removeBlockedByRule(7, 5), bodyWritten(7, BODY),
      prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'PATCH /repos/acme/demo/issues/7', 'UpdateProjectItemField'])
  })

  it('--by がプロジェクトに無い別のリポジトリでも、待つ側のリポジトリだけを確かめて前提を外す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-17')
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

  it('節に前提が 2 行あるとき、外した前提の行だけを節から消す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-03')
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

  it('付いていない前提を外すと、何も書かずに unchanged の行を出し、節に残った古い行も書き換えない', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-02')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: #7 is not blocked by #5\n' })
    expect(requestLabels(github.requests())).toEqual(['GetLinkedRepositoriesUser', 'GetIssueBlockedByReferences'])
  })

  it('札が Needs Attention で、閉じた前提を外すと、列を戻した後に札を Todo にする', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-05')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'), labelUpdated('s2'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\nset: Status of #7 to Todo\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField', 'UpdateProjectItemField'])
  })

  it('札が Needs Attention でも、開いた最後の前提を外しただけなら、札を戻さない', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-06')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Blocked', label: 'Needs Attention', body: BODY, blockedBy: [] }), boardItems(), fieldUpdated('o3'),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nmoved: #7 Blocked -> Ready (startable)\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy', 'UpdateProjectItemField'])
  })

  it('着手の跡がある Issue から外すと、前提は外し、列と札は動かさない', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-07')
    prepareDependencyProject()
    const github = await startGithub([
      bothLinked(), targetReferences(7, BODY, [{ number: 5, state: 'CLOSED' }]), removeBlockedByRule(7, 5),
      prerequisitesRule({ number: 7, column: 'Active', label: 'Needs Attention', branch: 'feat/7', body: BODY, blockedBy: [] }),
    ])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: blocked-by #5 from #7\n' })
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('--dry-run を付けると、読み取りだけ行い、書き込みを送らずに dry-run の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-08')
    prepareDependencyProject()
    const github = await startGithub([bothLinked(), targetReferences(7, WITH_SECTION, [{ number: 5 }])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5', '--dry-run')

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would remove blocked-by #5 from #7\n' })
    expect(writes(github)).toEqual([])
  })

  it('本文の節が読めないとき、前提だけを外し、節を直していない旨を warning で出す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-09')
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

  it('読み直した前提が書いた内容と合わないとき、列と札を動かさずに warning を出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-10')
    prepareDependencyProject()
    const stale = prerequisitesRule({ number: 7, column: 'Blocked', body: BODY, blockedBy: [{ number: 5 }] })
    const github = await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), removeBlockedByRule(7, 5), stale, stale])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('removed: blocked-by #5 from #7\nwarning: could not confirm that GitHub reflects the blocked-by change of #7; the column and label of #7 were not moved\n')
    expect(writes(github)).toEqual(['RemoveBlockedBy'])
  })

  it('動かす先の札がボードに無いとき、列は動かし、warning と project init の hint を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-11')
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

  it('依存関係に対応しない GHES では、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-12')
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

  it('Issue の参照の形が誤っているとき、要求を送らずに終了コード 2 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-13')
    prepareDependencyProject()
    const github = await startGithub([])

    const result = await unblock('invalid-format', '--by', 'acme/demo/5')

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('リポジトリがプロジェクトに無いとき、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-14')
    prepareDependencyProject()
    await startGithub([linkedRepositories(['other'])])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-15')
    const project = setUpProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('前提を外す要求が失敗したとき、error を出して終了コード 1 で止める', async (context) => {
    await verifies(context, 'PW-ISSUE-UNBLOCK-16')
    prepareDependencyProject()
    const failing: ResponseRule = { match: { operation: 'RemoveBlockedBy' }, respond: { status: 502, body: { message: 'failure' } }, times: 1 }
    await startGithub([bothLinked(), targetReferences(7, BODY, [{ number: 5 }]), failing])

    const result = await unblock('acme/demo/7', '--by', 'acme/demo/5')

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not remove blocked-by #5 from #7: /u)
  })
})
