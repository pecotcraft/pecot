import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_PROJECT_COMMANDS } from '../../src/commands/issue-project.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { addedToBoard, failing, fieldUpdated, issueNodeId, linkedRepositories, prepareProject } from '../_helpers/issue-project-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function add(argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(argv, ISSUE_PROJECT_COMMANDS)
}

describe('add-to-project', () => {
  it('Issue の参照を渡すと、ボードに足して added の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-01')
    await verifies(context, 'PW-ADD-TO-PROJECT-07')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['add-to-project', 'acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()).toMatchObject([
      { operation: 'GetLinkedRepositoriesUser' },
      { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } },
      { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_7' } },
      { operation: 'UpdateProjectItemField' },
    ])
  })

  it('--status を省くと、足した項目の Status を ready にして set の行を出す', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-02')
    await verifies(context, 'PW-ADD-TO-PROJECT-08')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['add-to-project', 'acme/demo/7'])

    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\nset: Issue acme/demo/7 status ready\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
  })

  it('--status に値を渡すと、足した項目の Status をその値にする', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-03')
    await verifies(context, 'PW-ADD-TO-PROJECT-08')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o4')])

    const result = await add(['add-to-project', 'acme/demo/7', '--status', 'active'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('set: Issue acme/demo/7 status active\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o4' } })
  })

  it('--status が空文字だと、Status を設定せず、ボードへの追加だけを行う', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-04')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard()])

    const result = await add(['add-to-project', 'acme/demo/7', '--status', ''])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\n')
    expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId', 'AddToProject'])
  })

  it('番号だけを渡して --repo を付けると、そのリポジトリの Issue を足す', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-05')
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), issueNodeId('other'), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['--repo', 'acme/other', 'add-to-project', '7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/other/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'other', number: 7 } })
  })

  it('番号だけを渡して --repo を省くと、git の remote のリポジトリの Issue を足す', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-06')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['add-to-project', '7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } })
  })

  it('--status が有効な値でないとき、有効な値を並べた error を出し、足さずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-09')
    await verifies(context, 'PW-ADD-TO-PROJECT-10')
    await verifies(context, 'PW-ADD-TO-PROJECT-11')
    prepareProject()
    const github = await startGithub([])

    const result = await add(['add-to-project', 'acme/demo/7', '--status', 'foo'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-12')
    const { project } = prepareProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await add(['add-to-project', 'acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-13')
    prepareProject()
    const github = await startGithub([])

    const result = await add(['add-to-project', 'invalid-format'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-14')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await add(['add-to-project', 'acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-15')
    prepareProject()
    await startGithub([linkedRepositories(), failing({ operation: 'GetIssueNodeId' })])

    const result = await add(['add-to-project', 'acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not add Issue acme\/demo\/7 to project: .*502/u)
  })

  it('--status の値をボードが定義していないとき、足さずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ADD-TO-PROJECT-16')
    await verifies(context, 'PW-ADD-TO-PROJECT-17')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([])

    const result = await add(['add-to-project', 'acme/demo/7', '--status', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toEqual([])
  })
})
