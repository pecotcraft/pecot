import { describe, expect, it, vi } from 'vitest'

import { ISSUE_REOPEN_COMMANDS } from '../../src/commands/issue-reopen.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, settleWithFakeDelays, startGithub, useFakeDelays } from '../_helpers/interface-case.js'
import { boardItems, commented, failing, fieldUpdated, linkedRepositories, prepareProject, reopened, waitForRequests } from '../_helpers/board-issue-case.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { makeAmbiguous, removeActive, SECOND_CONFIG } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function reopen(argv: readonly string[]): Promise<CliResult> {
  useFakeDelays()
  return await settleWithFakeDelays(runInProcess(['issue', 'reopen', ...argv], ISSUE_REOPEN_COMMANDS))
}

function labelOf(request: RecordedRequest): string {
  return request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`
}

const PATCH = 'PATCH /repos/acme/demo/issues/7'
const COMMENT = 'POST /repos/acme/demo/issues/7/comments'

async function reopenTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  useFakeDelays()
  return await callToolOnce(ISSUE_REOPEN_COMMANDS, 'issue_reopen', argumentsOfTool, settleWithFakeDelays)
}

describe('issue reopen', () => {
  it('閉じた Issue の参照を渡すと、reopen して reopened の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-01')
    await verifies(context, 'PW-ISSUE-REOPEN-08')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(github.requests().filter(request => labelOf(request) === PATCH)).toHaveLength(2)
    expect(github.requests().find(request => labelOf(request) === PATCH)).toMatchObject({ body: { state: 'open' } })
  })

  it('ボードの項目がアーカイブ済みなら、Status を設定する前にアーカイブを解き、updated の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-22')
    prepareProject()
    const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
    const unarchived: ResponseRule = { match: { operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_1', itemId: 'PVTI_7' } }, respond: { status: 200, body: { data: { unarchiveProjectV2Item: { item: { id: 'PVTI_7' } } } } }, times: 1 }
    const github = await startGithub([linkedRepositories(), reopened(), archived, unarchived, fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('updated: Issue acme/demo/7 unarchived on the board\nset: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', 'UnarchiveProjectItem', PATCH, 'UpdateProjectItemField', PATCH])
  })

  it('もしアーカイブを解けないなら、Issue を開かずに error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-23')
    prepareProject()
    const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
    const github = await startGithub([linkedRepositories(), archived, failing({ operation: 'UnarchiveProjectItem' }, 500)])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not unarchive Issue acme\/demo\/7 on the board: .+500/u)
    expect(github.requests().map(request => labelOf(request))).not.toContain(PATCH)
  })

  it('--status を渡すと、reopen の後にボードの status をその値にして set の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-02')
    await verifies(context, 'PW-ISSUE-REOPEN-07')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o4'), reopened()])

    const result = await reopen(['acme/demo/7', '--status', 'active'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('set: Issue acme/demo/7 status active\nreopened: Issue acme/demo/7\n')
    expect(github.requests().map(request => labelOf(request))).toEqual([
      'GetLinkedRepositoriesUser',
      'GetIssueProjectItems',
      PATCH,
      'UpdateProjectItemField',
      PATCH,
    ])
    expect(github.requests()[3]).toMatchObject({ variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' } })
  })

  it('設定に blocked があるとき、--status blocked でボードの status を blocked の option にして set の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-02')
    await verifies(context, 'PW-ISSUE-REOPEN-07')
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o7'), reopened()])

    const result = await reopen(['acme/demo/7', '--status', 'blocked'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('set: Issue acme/demo/7 status blocked\nreopened: Issue acme/demo/7\n')
    expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('--status を省くと、ボードの status を ready にする', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-03')
    await verifies(context, 'PW-ISSUE-REOPEN-07')
    await verifies(context, 'PW-ISSUE-REOPEN-08')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.stderr).toBe('set: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
    expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o3' } })
  })

  it('status を設定すると、3 秒待ってからもう一度 reopen する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-04')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])
    useFakeDelays()

    const pending = runInProcess(['issue', 'reopen', 'acme/demo/7'], ISSUE_REOPEN_COMMANDS)
    await waitForRequests(() => github.requests().length, 4)
    await vi.advanceTimersByTimeAsync(2999)
    await waitForRequests(() => github.requests().length, 4)
    const beforeEnd = github.requests().map(request => labelOf(request))
    await vi.advanceTimersByTimeAsync(1)
    const result = await settleWithFakeDelays(pending)

    expect(beforeEnd).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', PATCH, 'UpdateProjectItemField'])
    expect(github.requests().map(request => labelOf(request)).slice(4)).toEqual([PATCH])
    expect(result.code).toBe(0)
  })

  it('--comment を付けると、reopen の後に理由をコメントに投稿して created の行を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-05')
    await verifies(context, 'PW-ISSUE-REOPEN-09')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o4'), reopened(), commented()])

    const result = await reopen(['acme/demo/7', '--status', 'active', '--comment', '再発したので開き直す'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('set: Issue acme/demo/7 status active\nreopened: Issue acme/demo/7\ncreated: comment on acme/demo/7\n')
    expect(github.requests().at(-1)).toMatchObject({ method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: '再発したので開き直す' } })
    expect(github.requests().map(request => labelOf(request)).slice(-2)).toEqual([PATCH, COMMENT])
  })

  it('--comment を付けて 2 回打つと、そのたびにコメントを投稿する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-06')
    prepareProject()
    const github = await startGithub([
      linkedRepositories(),
      reopened(),
      boardItems(),
      fieldUpdated('o3'),
      reopened(),
      commented(),
      linkedRepositories(),
      reopened(),
      boardItems(),
      fieldUpdated('o3'),
      reopened(),
      commented(),
    ])

    const first = await reopen(['acme/demo/7', '--comment', '理由'])
    const second = await reopen(['acme/demo/7', '--comment', '理由'])

    expect([first.code, second.code]).toEqual([0, 0])
    expect(github.requests().filter(request => labelOf(request) === COMMENT)).toHaveLength(2)
  })

  it('Issue がボードに無いとき、warning を出して status を変えずに reopen だけを行う', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-10')
    await verifies(context, 'PW-ISSUE-REOPEN-11')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems({ onBoard: false }), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'warning: Issue acme/demo/7 is not on the project board\nreopened: Issue acme/demo/7\n',
    })
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', PATCH, PATCH])
  })

  it('status がプロジェクトに設定されていないとき、warning を出して reopen する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-12')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), reopened()])

    const result = await reopen(['acme/demo/7', '--status', 'active'])

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'warning: status \'active\' is not configured in the project\nreopened: Issue acme/demo/7\n',
    })
    expect(github.requests().map(request => labelOf(request))).not.toContain('UpdateProjectItemField')
  })

  it('blocked がプロジェクトに設定されていないとき、足し方の hint を添えた warning を出して reopen する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-12')
    await verifies(context, 'PW-ISSUE-REOPEN-20')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), reopened()])

    const result = await reopen(['acme/demo/7', '--status', 'blocked'])

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: 'warning: status \'blocked\' is not configured in the project\n  hint: run pecot project init to add the Blocked option to the board\nreopened: Issue acme/demo/7\n',
    })
    expect(github.requests().map(request => labelOf(request))).not.toContain('UpdateProjectItemField')
  })

  it('選択肢の ID が古くて列を書けないと、書けなかった列の warning と project activate の案内を出し、reopen とコメントの投稿を続ける', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-24')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), staleOptionUpdate(), reopened(), commented()])

    const result = await reopen(['acme/demo/7', '--comment', '理由'])

    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: [
        `warning: could not set Issue acme/demo/7 status ready: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        'reopened: Issue acme/demo/7',
        'created: comment on acme/demo/7',
        '',
      ].join('\n'),
    })
    expect(github.requests().map(request => labelOf(request)).slice(-2)).toEqual([PATCH, COMMENT])
  })

  it('列を書けなかったときは、3 秒待たずにもう一度 reopen する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-24')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), staleOptionUpdate(), reopened()])
    useFakeDelays()

    const pending = runInProcess(['issue', 'reopen', 'acme/demo/7'], ISSUE_REOPEN_COMMANDS)
    // 偽のタイマーを進めないまま、2 回目の reopen が届く
    await waitForRequests(() => github.requests().length, 5)
    const result = await settleWithFakeDelays(pending)

    expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', PATCH, 'UpdateProjectItemField', PATCH])
    expect(result.code).toBe(0)
  })

  it('500 で列を書けないときは、warning だけを出し、ID を読み直す案内を添えない', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-24')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), failing({ operation: 'UpdateProjectItemField' }, 500), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: could not set Issue acme\/demo\/7 status ready: .+500/u)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(result.stderr).not.toContain('hint:')
  })

  it('2 回目の reopen の後も Issue が open でないとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-13')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened('closed')])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'set: Issue acme/demo/7 status ready\nerror: Issue acme/demo/7 did not become open (state: closed)\n',
    })
  })

  it('コメントの投稿に失敗したとき、コメントの失敗と分かる error を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-14')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened(), failing({ method: 'POST', path: '/repos/acme/demo/issues/7/comments' })])

    const result = await reopen(['acme/demo/7', '--comment', '理由'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(result.stderr).toMatch(/error: could not comment on Issue acme\/demo\/7: .*502/u)
    expect(result.stderr).not.toContain('could not reopen')
  })

  it.for([
    { name: '打つ', args: [] },
    { name: '--dry-run で打つ', args: ['--dry-run'] },
  ] satisfies readonly { name: string, args: readonly string[] }[])('--comment が空白だけで $name と、GitHub を呼ばず、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-25')
    prepareProject()
    const github = await startGithub([])

    const result = await reopen(['acme/demo/7', '--comment', '  \n ', ...row.args])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --comment is blank: give a reason or omit it\n' })
    expect(github.requests()).toEqual([])
  })

  it('--status が有効な値でないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-15')
    prepareProject()
    const github = await startGithub([])

    const result = await reopen(['acme/demo/7', '--status', 'foo'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-16')
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-28')
    prepareProject({ repositories: ['other'] })

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で reopen する', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-29')
    const { project } = prepareProject()
    makeAmbiguous(project)
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7', '--project', SECOND_CONFIG])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で reopen する', async () => {
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
  })

  it('リポジトリがプロジェクトに無いとき、reopen せずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-17')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-18')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ method: 'PATCH', path: '/repos/acme/demo/issues/7' }, 500)])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not reopen Issue acme\/demo\/7: .*500/u)
  })

  it('Issue の参照の形が誤っているとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-19')
    prepareProject()
    const github = await startGithub([])

    const result = await reopen(['invalid-format'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  describe('組み込みの Status の Done', () => {
    function itemWithStatus(name: string): ResponseRule {
      const nodes = [{ id: 'PVTI_7', isArchived: false, project: { id: 'PVT_1' }, status: { name, field: { id: 'PVTSSF_status' } } }]
      return { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes } } } } } }, times: 1 }
    }
    const CLEARED: ResponseRule = {
      match: { operation: 'ClearProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_status' } },
      respond: { status: 200, body: { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } } } },
      times: 1,
    }

    it('Status が Done の項目の Issue を開き直すと、開き直す前に Status を消し、removed の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-26')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done'), CLEARED, reopened(), fieldUpdated('o3'), reopened()])

      const result = await reopen(['acme/demo/7'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('removed: Issue acme/demo/7 Status Done on the board\nset: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
      const labels = github.requests().map(request => labelOf(request))
      expect(labels.indexOf('ClearProjectItemField')).toBeLessThan(labels.indexOf(PATCH))
    })

    it('Status が Done でないとき、Status を消さず、removed の行を出さない', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-26')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Needs Attention'), reopened(), fieldUpdated('o3'), reopened()])

      const result = await reopen(['acme/demo/7'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('set: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
      expect(github.requests().map(request => labelOf(request))).not.toContain('ClearProjectItemField')
    })

    it('Status が Done でないとき、doneCleared を false で data に返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), itemWithStatus('Needs Attention'), reopened(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: false, commented: false })
    })

    it('Status の Done を消せないとき、warning の行を出し、reopen とコメントの投稿を続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-27')
      prepareProject()
      await startGithub([linkedRepositories(), itemWithStatus('Done'), failing({ operation: 'ClearProjectItemField' }), reopened(), fieldUpdated('o3'), reopened(), commented()])

      const result = await reopen(['acme/demo/7', '--comment', '再発した'])

      expect(result.code).toBe(0)
      expect(result.stderr).toMatch(/^warning: could not remove Issue acme\/demo\/7 Status Done on the board: [\s\S]*\. The board automation may close the Issue again; clear Status on the board\n/u)
      expect(result.stderr).toContain('reopened: Issue acme/demo/7\ncreated: comment on acme/demo/7\n')
    })

    it('--dry-run で打つと、Status を消さずに、消す予定を reopen の後・set の前の dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-21')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done')])

      const result = await reopen(['acme/demo/7', '--dry-run'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('dry-run: would reopen Issue acme/demo/7\ndry-run: would remove Issue acme/demo/7 Status Done on the board\ndry-run: would set Issue acme/demo/7 status ready\n')
      expect(github.requests().map(request => labelOf(request))).not.toContain('ClearProjectItemField')
    })

    it('--dry-run で打つと、Status を消す予定を doneCleared で data に返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), itemWithStatus('Done')])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', dry_run: true })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: true, commented: false, dryRun: true })
    })

    it('Status の Done を消すと、doneCleared を true で data に返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), itemWithStatus('Done'), CLEARED, reopened(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: true, commented: false })
    })
  })

  describe('MCP の data', () => {
    it('アーカイブを解いて status を書きコメントを投稿すると、その結果を data に返す', async () => {
      prepareProject()
      const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
      const unarchived: ResponseRule = { match: { operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_1', itemId: 'PVTI_7' } }, respond: { status: 200, body: { data: { unarchiveProjectV2Item: { item: { id: 'PVTI_7' } } } } }, times: 1 }
      await startGithub([linkedRepositories(), reopened(), archived, unarchived, fieldUpdated('o4'), reopened(), commented()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', status: 'active', comment: '再発したので開き直す' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'active', unarchived: true, doneCleared: false, commented: true })
    })

    it('コメントの投稿に失敗したとき、コメントの失敗と分かる detail を github-api の失敗で返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened(), failing({ method: 'POST', path: '/repos/acme/demo/issues/7/comments' })])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由' })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(outcome.structured['detail']).toMatch(/^could not comment on Issue acme\/demo\/7: /u)
    })

    it('comment が空白だけのとき、入力の名前を comment と書いた invalid-input の失敗を返す', async () => {
      prepareProject()
      await startGithub([])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: ' '.repeat(3) })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input', detail: 'comment is blank: give a reason or omit it' } })
    })

    it('Issue がボードに無いとき、status を省いた data を返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), reopened(), boardItems({ onBoard: false }), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', unarchived: false, doneCleared: false, commented: false, warnings: ['Issue acme/demo/7 is not on the project board'] })
    })

    it('dry_run で打つと、書く予定の status と dryRun を data に返す', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), boardItems()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由', dry_run: true })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: false, commented: true, dryRun: true })
    })
  })
})
