import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ISSUE_PROJECT_COMMANDS } from '../../src/commands/issue-project.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { runInProcess, settleWithFakeDelays, startGithub, useFakeDelays } from '../_helpers/interface-case.js'
import { boardItems, commented, failing, fieldUpdated, linkedRepositories, prepareProject, reopened, waitForRequests } from '../_helpers/issue-project-case.js'
import type { RecordedRequest } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function reopen(argv: readonly string[]): Promise<CliResult> {
  useFakeDelays()
  return await settleWithFakeDelays(runInProcess(['issue', 'reopen', ...argv], ISSUE_PROJECT_COMMANDS))
}

function labelOf(request: RecordedRequest): string {
  return request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`
}

const PATCH = 'PATCH /repos/acme/demo/issues/7'
const COMMENT = 'POST /repos/acme/demo/issues/7/comments'

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
      PATCH,
      'GetIssueProjectItems',
      'UpdateProjectItemField',
      PATCH,
    ])
    expect(github.requests()[3]).toMatchObject({ variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' } })
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

    const pending = runInProcess(['issue', 'reopen', 'acme/demo/7'], ISSUE_PROJECT_COMMANDS)
    await waitForRequests(() => github.requests().length, 4)
    await vi.advanceTimersByTimeAsync(2999)
    await waitForRequests(() => github.requests().length, 4)
    const beforeEnd = github.requests().map(request => labelOf(request))
    await vi.advanceTimersByTimeAsync(1)
    const result = await settleWithFakeDelays(pending)

    expect(beforeEnd).toEqual(['GetLinkedRepositoriesUser', PATCH, 'GetIssueProjectItems', 'UpdateProjectItemField'])
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
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', PATCH, 'GetIssueProjectItems', PATCH])
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

  it('コメントの投稿に失敗したとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-14')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened(), failing({ method: 'POST', path: '/repos/acme/demo/issues/7/comments' })])

    const result = await reopen(['acme/demo/7', '--comment', '理由'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(result.stderr).toMatch(/error: could not reopen Issue acme\/demo\/7: .*502/u)
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

  it('アクティブなプロジェクトが無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-REOPEN-16')
    const { project } = prepareProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
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
    await startGithub([linkedRepositories(), failing({ method: 'PATCH', path: '/repos/acme/demo/issues/7' }, 500)])

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
})
