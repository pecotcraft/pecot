import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BOARD_MOVE_COMMANDS } from '../../src/commands/board-move.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { boardItems, failing, fieldUpdated, linkedRepositories, prepareProject } from '../_helpers/board-issue-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function update(argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(argv, BOARD_MOVE_COMMANDS)
}

describe('board move', () => {
  it('Issue の参照と Status を渡すと、ボード上のその Issue の Status を渡した値にして set の行を出す', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-01')
    await verifies(context, 'PW-BOARD-MOVE-04')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

    const result = await update(['board', 'move', 'acme/demo/7', 'in_review'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status in_review\n' })
    expect(github.requests()).toMatchObject([
      { operation: 'GetLinkedRepositoriesUser' },
      { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } },
      { operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o5' } },
    ])
  })

  it('設定に blocked があるとき、blocked を渡すと set の行を出し、blocked の option で更新する', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-01')
    await verifies(context, 'PW-BOARD-MOVE-04')
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o7')])

    const result = await update(['board', 'move', 'acme/demo/7', 'blocked'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status blocked\n' })
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('ボードに Blocked が無いとき、blocked を渡すと、足し方の hint を添えた error を出す', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-12')
    await verifies(context, 'PW-BOARD-MOVE-14')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems()])

    const result = await update(['board', 'move', 'acme/demo/7', 'blocked'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: status \'blocked\' is not configured in the project\n  hint: run pecot project init to add the Blocked option to the board\n',
    })
  })

  it('番号だけを渡して --repo を付けると、そのリポジトリの Issue の Status を設定する', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-02')
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), boardItems({ onBoard: true, repository: 'other' }), fieldUpdated('o4')])

    const result = await update(['--repo', 'acme/other', 'board', 'move', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/other/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'other', number: 7 } })
  })

  it('番号だけを渡して --repo を省くと、git の remote のリポジトリの Issue を対象にする', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-03')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o4')])

    const result = await update(['board', 'move', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'demo', number: 7 } })
  })

  it('Status が有効な値でないとき、有効な値を並べた error を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-05')
    await verifies(context, 'PW-BOARD-MOVE-06')
    prepareProject()
    const github = await startGithub([])

    const result = await update(['board', 'move', 'acme/demo/7', 'foo'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('アクティブなプロジェクトが無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-07')
    const { project } = prepareProject()
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-08')
    prepareProject()
    const github = await startGithub([])

    const result = await update(['board', 'move', 'invalid-format', 'active'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-09')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('Issue がボードに無いとき、board add を案内する error を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-10')
    await verifies(context, 'PW-BOARD-MOVE-11')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems({ onBoard: false })])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: Issue acme/demo/7 is not on the project board\n  hint: add it to the board first with pecot board add acme/demo/7\n',
    })
    expect(github.requests()).toHaveLength(2)
  })

  it('ボードが Status を定義していないとき、更新せずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-12')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([linkedRepositories(), boardItems()])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toHaveLength(2)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-MOVE-13')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ operation: 'UpdateProjectItemField' })])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not set Issue acme\/demo\/7 status active: .*502/u)
  })
})
