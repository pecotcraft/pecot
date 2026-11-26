import { describe, expect, it } from 'vitest'

import { BOARD_ADD_COMMANDS } from '../../src/commands/board-add.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { addedToBoard, failing, fieldUpdated, issueNodeId, linkedRepositories, prepareProject } from '../_helpers/board-issue-case.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function add(argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(argv, BOARD_ADD_COMMANDS)
}

describe('board add', () => {
  it('Issue の参照を渡すと、ボードに足して added の行を標準エラーに出す', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['board', 'add', 'acme/demo/7'])

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

  it('--status を省くと、足した項目の Status を ready にして set の行を出す', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\nset: Issue acme/demo/7 status ready\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
  })

  it('--status に値を渡すと、足した項目の Status をその値にする', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o4')])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', 'active'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('set: Issue acme/demo/7 status active\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o4' } })
  })

  it('設定に blocked があるとき、--status blocked で blocked の option に設定して set の行を出す', async () => {
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o7')])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', 'blocked'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\nset: Issue acme/demo/7 status blocked\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('--status が空文字だと、Status を設定せず、ボードへの追加だけを行う', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard()])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', ''])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\n')
    expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId', 'AddToProject'])
  })

  it('番号だけを渡して --repo を付けると、そのリポジトリの Issue を足す', async () => {
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), issueNodeId('other'), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['--repo', 'acme/other', 'board', 'add', '7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/other/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'other', number: 7 } })
  })

  it('番号だけを渡して --repo を省くと、git の remote のリポジトリの Issue を足す', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['board', 'add', '7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } })
  })

  it('--status が有効な値でないとき、有効な値を並べた error を出し、足さずに終了コード 1 で終わる', async () => {
    prepareProject()
    const github = await startGithub([])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', 'foo'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async () => {
    prepareProject({ repositories: ['other'] })

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定でボードに足す', async () => {
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['board', 'add', 'acme/demo/7', '--project', SECOND_PROJECT])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()).toHaveLength(4)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定でボードに足す', async () => {
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async () => {
    prepareProject()
    const github = await startGithub([])

    const result = await add(['board', 'add', 'invalid-format'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async () => {
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async () => {
    prepareProject()
    await startGithub([linkedRepositories(), failing({ operation: 'GetIssueNodeId' })])

    const result = await add(['board', 'add', 'acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not add Issue acme\/demo\/7 to project: .*502/u)
  })

  it('--status の値をボードが定義していないとき、足さずに終了コード 1 で終わる', async () => {
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toEqual([])
  })

  it('ボードに Blocked が無いとき、--status blocked は足さずに、足し方の hint を添えた error を出す', async () => {
    prepareProject()
    const github = await startGithub([])

    const result = await add(['board', 'add', 'acme/demo/7', '--status', 'blocked'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: status \'blocked\' is not configured in the project\n  hint: run pecot project init to add the Blocked option to the board\n',
    })
    expect(github.requests()).toEqual([])
  })

  describe('列の書き込みの失敗', () => {
    it('選択肢の ID が古くて列を書けないと、追加の行の後に書けなかった列の error と project activate の案内を出して終了コード 1 で終わる', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), staleOptionUpdate()])

      const result = await add(['board', 'add', 'acme/demo/7'])

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: [
          'added: Issue acme/demo/7 to project',
          `error: could not set Issue acme/demo/7 status ready: ${STALE_OPTION_TEXT}`,
          '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
          '',
        ].join('\n'),
      })
    })

    it('500 で列を書けないときは、書けなかった列の error だけを出し、ID を読み直す案内を添えない', async () => {
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), failing({ operation: 'UpdateProjectItemField' }, 500)])

      const result = await add(['board', 'add', 'acme/demo/7'])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^added: Issue acme\/demo\/7 to project\nerror: could not set Issue acme\/demo\/7 status ready: .+500/u)
      expect(result.stderr).not.toContain('hint:')
      expect(result.stderr).not.toContain('could not add')
    })

    it('MCP では、失敗の結果に added: true を残し、status を返さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-20')
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), staleOptionUpdate()])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        added: true,
        kind: 'github-api',
        detail: `could not set Issue acme/demo/7 status ready: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
      })
    })
  })

  describe('MCP の呼び出し', () => {
    const ADDED = { issue: 'acme/demo/7', added: true }

    it('Issue の参照を渡すと、ボードに足し、issue・added: true・ready の status を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-01')
      await verifies(context, 'PW-BOARD-ADD-02')
      await verifies(context, 'PW-BOARD-ADD-07')
      await verifies(context, 'PW-BOARD-ADD-08')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', optionId: 'o3' } })
    })

    it('status に値を渡すと、足した項目の Status をその値にして status に返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-03')
      await verifies(context, 'PW-BOARD-ADD-08')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o4')])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'active' })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o4' } })
    })

    it('status が空文字だと、Status を設定せず、status を返さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-04')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard()])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', status: '' })

      expect(outcome.structured).toEqual(ADDED)
      expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId', 'AddToProject'])
    })

    it('番号だけを渡して repo を付けると、そのリポジトリの Issue を足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-05')
      prepareProject({ repositories: ['demo', 'other'] })
      const github = await startGithub([linkedRepositories(['demo', 'other']), issueNodeId('other'), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: '7', repo: 'acme/other' })

      expect(outcome.structured).toEqual({ issue: 'acme/other/7', added: true, status: 'ready' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'other', number: 7 } })
    })

    it('番号だけを渡して repo を省くと、git の remote のリポジトリの Issue を足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-06')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: '7' })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } })
    })

    it('status が有効な値でないとき、有効な値を並べた detail と kind が invalid-input の失敗を返し、足さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-09')
      await verifies(context, 'PW-BOARD-ADD-10')
      await verifies(context, 'PW-BOARD-ADD-11')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', status: 'foo' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-12')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('project に設定の名前を渡すと、対象のリポを含む設定が 2 つあってもその設定でボードに足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-22')
      const { project } = prepareProject()
      makeAmbiguous(project)
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests()).toHaveLength(4)
    })

    it('Issue の参照が不正なとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-13')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'invalid-format' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('invalid reference')
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'Issue のリポジトリがプロジェクトに登録されていない', id: 'PW-BOARD-ADD-14', repositories: ['demo'], linked: ['other'], detail: 'repository acme/demo is not in the project' },
      { name: '対象のリポを含む設定が無い', id: 'PW-BOARD-ADD-21', repositories: ['other'], linked: [], detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' },
    ])('$name とき、kind が repo-not-in-project の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      prepareProject({ repositories: row.repositories })
      await startGithub(row.linked.length === 0 ? [] : [linkedRepositories(row.linked)])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: row.detail })
    })

    it('GitHub API がエラーを返したとき、失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-15')
      prepareProject()
      await startGithub([linkedRepositories(), failing({ operation: 'GetIssueNodeId' })])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not add Issue acme\/demo\/7 to project: .*502/u)
    })

    it('status の値をボードが定義していないとき、足さずに kind が status-not-configured の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-16')
      await verifies(context, 'PW-BOARD-ADD-17')
      prepareProject({ missingStatus: 'active' })
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'active\' is not configured in the project' })
      expect(github.requests()).toEqual([])
    })

    it('ボードに Blocked が無いとき、status が blocked だと足さずに project_init の案内を detail に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-16')
      await verifies(context, 'PW-BOARD-ADD-17')
      await verifies(context, 'PW-BOARD-ADD-18')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_COMMANDS, 'board_add', { issue_ref: 'acme/demo/7', status: 'blocked' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'blocked\' is not configured in the project\n  hint: call project_init to add the Blocked option to the board' })
      expect(github.requests()).toEqual([])
    })

    it('CLI で --dry-run を付けると、Issue を読むだけで足さず、足す予定と設定する予定の Status を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-19')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId()])

      const result = await add(['board', 'add', 'acme/demo/7', '--dry-run'])

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would add Issue acme/demo/7 to project\ndry-run: would set Issue acme/demo/7 status ready\n' })
      expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId'])
    })
  })
})
