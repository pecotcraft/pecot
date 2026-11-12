import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_PROJECT_COMMANDS } from '../../src/commands/issue-project.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { boardItems, failing, fieldUpdated, linkedRepositories, prepareProject } from '../_helpers/issue-project-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function update(argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(argv, ISSUE_PROJECT_COMMANDS)
}

describe('update-issue-status', () => {
  it('Issue の参照と Status を渡すと、ボード上のその Issue の Status を渡した値にして set の行を出す', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-01')
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-04')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

    const result = await update(['update-issue-status', 'acme/demo/7', 'in_review'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status in_review\n' })
    expect(github.requests()).toMatchObject([
      { operation: 'GetLinkedRepositoriesUser' },
      { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } },
      { operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o5' } },
    ])
  })

  it('番号だけを渡して --repo を付けると、そのリポジトリの Issue の Status を設定する', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-02')
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), boardItems({ onBoard: true, repository: 'other' }), fieldUpdated('o4')])

    const result = await update(['--repo', 'acme/other', 'update-issue-status', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/other/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'other', number: 7 } })
  })

  it('番号だけを渡して --repo を省くと、git の remote のリポジトリの Issue を対象にする', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-03')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o4')])

    const result = await update(['update-issue-status', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'demo', number: 7 } })
  })

  it('Status が有効な値でないとき、有効な値を並べた error を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-05')
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-06')
    prepareProject()
    const github = await startGithub([])

    const result = await update(['update-issue-status', 'acme/demo/7', 'foo'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-07')
    const { project } = prepareProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await update(['update-issue-status', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-08')
    prepareProject()
    const github = await startGithub([])

    const result = await update(['update-issue-status', 'invalid-format', 'active'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-09')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await update(['update-issue-status', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('Issue がボードに無いとき、add-to-project を案内する error を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-10')
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-11')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems({ onBoard: false })])

    const result = await update(['update-issue-status', 'acme/demo/7', 'active'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: Issue acme/demo/7 is not on the project board\n  hint: add it to the board first with add-to-project\n',
    })
    expect(github.requests()).toHaveLength(2)
  })

  it('ボードが Status を定義していないとき、更新せずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-12')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([linkedRepositories(), boardItems()])

    const result = await update(['update-issue-status', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toHaveLength(2)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-UPDATE-ISSUE-STATUS-13')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ operation: 'UpdateProjectItemField' })])

    const result = await update(['update-issue-status', 'acme/demo/7', 'active'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not set Issue acme\/demo\/7 status active: .*502/u)
  })
})
