// issue reopen で、ボードのアイテムがアーカイブ済みなら、Status を書く前にアーカイブを解く
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import type { CliResult } from '../../../tests/_helpers/interface-case.js'
import { runInProcess, settleWithFakeDelays, startGithub, useFakeDelays } from '../../../tests/_helpers/interface-case.js'
import { fieldUpdated, linkedRepositories, prepareProject, reopened } from '../../../tests/_helpers/board-issue-case.js'
import type { RecordedRequest, ResponseRule } from '../../../tests/fake-github/server.js'
import { ISSUE_REOPEN_COMMANDS } from '../issue-reopen.js'

useIsolatedEnvironment()

async function reopen(argv: readonly string[]): Promise<CliResult> {
  useFakeDelays()
  return await settleWithFakeDelays(runInProcess(['issue', 'reopen', ...argv], ISSUE_REOPEN_COMMANDS))
}

function boardItem(isArchived: boolean): ResponseRule {
  const nodes = [{ id: 'PVTI_7', isArchived, project: { id: 'PVT_1' } }]
  return { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes } } } } } }, times: 1 }
}

const UNARCHIVED: ResponseRule = {
  match: { operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_1', itemId: 'PVTI_7' } },
  respond: { status: 200, body: { data: { unarchiveProjectV2Item: { item: { id: 'PVTI_7' } } } } },
  times: 1,
}

function labelOf(request: RecordedRequest): string {
  return request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`
}

describe('issue reopen のアーカイブ済みのアイテム', () => {
  it('アーカイブ済みなら、アーカイブを解いてから Status を設定し、updated の行を出す', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItem(true), UNARCHIVED, fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('updated: Issue acme/demo/7 unarchived on the board\nset: Issue acme/demo/7 status ready\n')
    const labels = github.requests().map(request => labelOf(request))
    expect(labels.indexOf('UnarchiveProjectItem')).toBeGreaterThan(-1)
    expect(labels.indexOf('UnarchiveProjectItem')).toBeLessThan(labels.indexOf('UpdateProjectItemField'))
  })

  it('アーカイブされていなければ、アーカイブの解除を呼ばない', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItem(false), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('unarchived')
    expect(github.requests().map(request => labelOf(request))).not.toContain('UnarchiveProjectItem')
  })
})
