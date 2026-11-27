import { describe, expect, it } from 'vitest'

import { BOARD_ADD_TOOLS } from '../../src/commands/board-add.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { addedToBoard, failing, fieldUpdated, issueNodeId, linkedRepositories, prepareProject } from '../_helpers/board-issue-case.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function add(arguments_: Readonly<Record<string, unknown>>): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess('board_add', arguments_, BOARD_ADD_TOOLS)
}

describe('board_add', () => {
  it('Issue の参照を渡すと、ボードに足して added の行を標準エラーに出す', async () => {
    await explains('`board_add` の基本の動作のテストです。Issue の参照を渡した場合に、ボードへ追加して `added` の行を標準エラーに出力し、必要な GitHub API を順に呼び出すことを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: 'acme/demo/7' })

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

  it('status を省くと、足した項目の Status を ready にして set の行を出す', async () => {
    await explains('`board_add` の `status` のテストです。`status` を省略した場合に、追加した項目の Status を `ready` にして `set` の行を出力することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\nset: Issue acme/demo/7 status ready\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o3' } })
  })

  it('status に値を渡すと、足した項目の Status をその値にする', async () => {
    await explains('`board_add` の `status` のテストです。`status: active` を指定した場合に、追加した項目の Status を `active` に設定し、`set` の行を出力することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o4')])

    const result = await add({ issue_ref: 'acme/demo/7', status: 'active' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('set: Issue acme/demo/7 status active\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o4' } })
  })

  it('設定に blocked があるとき、status blocked で Status を blocked の選択肢に設定して set の行を出す', async () => {
    await explains('`board_add` の `status: blocked` のテストです。設定に `blocked` の選択肢が存在する場合に、その選択肢で Status を設定し、`set` の行を出力することを確認します。')
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o7')])

    const result = await add({ issue_ref: 'acme/demo/7', status: 'blocked' })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\nset: Issue acme/demo/7 status blocked\n')
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('status が空文字だと、Status を設定せず、ボードへの追加だけを行う', async () => {
    await explains('`board_add` の `status` のテストです。`status` に空文字を指定した場合に、Status を設定せず、ボードへの追加だけを行うことを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard()])

    const result = await add({ issue_ref: 'acme/demo/7', status: '' })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('added: Issue acme/demo/7 to project\n')
    expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId', 'AddToProject'])
  })

  it('番号だけを渡して repo を付けると、そのリポジトリの Issue を足す', async () => {
    await explains('`board_add` の `repo` のテストです。番号だけを渡して `repo` を指定した場合に、指定したリポジトリの Issue をボードへ追加することを確認します。')
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), issueNodeId('other'), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: '7', repo: 'acme/other' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/other/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'other', number: 7 } })
  })

  it('番号だけを渡して repo を省くと、git の remote のリポジトリの Issue を足す', async () => {
    await explains('`board_add` の対象のリポジトリのテストです。番号だけを渡して `repo` を省略した場合に、git の remote のリポジトリの Issue をボードへ追加することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: '7' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } })
  })

  it('status が有効な値でないとき、有効な値を並べた error を出し、足さずに終了コード 1 で終わる', async () => {
    await explains('`board_add` の `status` の値を検証するテストです。有効でない値を指定した場合に、有効な値を並べたエラーを出力し、ボードへ追加せずに終了コード 1 で終わることを確認します。')
    prepareProject()
    const github = await startGithub([])

    const result = await add({ issue_ref: 'acme/demo/7', status: 'foo' })

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n',
    })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`board_add` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async () => {
    await explains('`board_add` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合に、エラーと選べる設定の一覧を出力して終了コード 1 で終わることを確認します。')
    prepareProject({ repositories: ['other'] })

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定でボードに足す', async () => {
    await explains('`board_add` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定でボードへ追加することを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
    expect(github.requests()).toHaveLength(4)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定でボードに足す', async () => {
    await explains('`board_add` のプロジェクトの設定の選択のテストです。`.active` が存在しなくても、対象のリポジトリを含む設定が 1 つであれば、その設定でボードへ追加することを確認します。')
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('added: Issue acme/demo/7 to project\n')
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async () => {
    await explains('`board_add` の Issue の参照を検証するテストです。`invalid-format` のような不正な参照を渡した場合に、GitHub へ何も要求せず、終了コード 2 で終わることを確認します。')
    prepareProject()
    const github = await startGithub([])

    const result = await add({ issue_ref: 'invalid-format' })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async () => {
    await explains('`board_add` のプロジェクトの登録を検証するテストです。Issue のリポジトリがプロジェクトに登録されていない場合に、エラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async () => {
    await explains('`board_add` の GitHub API のエラーのテストです。Issue の取得が 502 で失敗した場合に、`could not add` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), failing({ operation: 'GetIssueNodeId' })])

    const result = await add({ issue_ref: 'acme/demo/7' })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not add Issue acme\/demo\/7 to project: .*502/u)
  })

  it('status の値をボードが定義していないとき、足さずに終了コード 1 で終わる', async () => {
    await explains('`board_add` の `status` の設定を検証するテストです。指定した Status の選択肢をボードが持たない場合に、ボードへ追加せず、エラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([])

    const result = await add({ issue_ref: 'acme/demo/7', status: 'active' })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toEqual([])
  })

  it('ボードに Blocked が無いとき、status blocked は足さずに、足し方の hint を添えた error を出す', async () => {
    await explains('`board_add` の `Blocked` の選択肢のテストです。ボードが `Blocked` を持たない場合に、`status: blocked` を指定すると、追加せずに `project_init` の実行を案内するエラーを出力することを確認します。')
    prepareProject()
    const github = await startGithub([])

    const result = await add({ issue_ref: 'acme/demo/7', status: 'blocked' })

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: status \'blocked\' is not configured in the project\n  hint: call project_init to add the Blocked option to the board\n',
    })
    expect(github.requests()).toEqual([])
  })

  describe('Status の書き込みの失敗', () => {
    it('選択肢の ID が古くて Status を書けないと、追加の行の後に書けなかった Status の error と project activate の案内を出して終了コード 1 で終わる', async () => {
      await explains('Status の書き込みが失敗した場合の `board_add` のテストです。古い選択肢の ID で書き込みが失敗した場合に、`added` の行に続けて、エラーと `project_activate` の案内を出力し、終了コード 1 で終わることを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), staleOptionUpdate()])

      const result = await add({ issue_ref: 'acme/demo/7' })

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: [
          'added: Issue acme/demo/7 to project',
          `error: could not set Issue acme/demo/7 status ready: ${STALE_OPTION_TEXT}`,
          '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
          '',
        ].join('\n'),
      })
    })

    it('500 で Status を書けないときは、書けなかった Status の error だけを出し、ID を読み直す案内を添えない', async () => {
      await explains('Status の書き込みが失敗した場合の `board_add` のテストです。書き込みが 500 で失敗した場合に、書き込みのエラーだけを出力し、ID を読み直す案内を付けないことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), failing({ operation: 'UpdateProjectItemField' }, 500)])

      const result = await add({ issue_ref: 'acme/demo/7' })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^added: Issue acme\/demo\/7 to project\nerror: could not set Issue acme\/demo\/7 status ready: .+500/u)
      expect(result.stderr).not.toContain('hint:')
      expect(result.stderr).not.toContain('could not add')
    })

    it('MCP では、失敗の結果に added: true を残し、status を返さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-20')
      await explains('MCP ツール `board_add` の Status の書き込みが失敗した場合のテストです。古い選択肢の ID で書き込みが失敗した場合に、`added: true` を残し、`status` を返さない失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), staleOptionUpdate()])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7' })

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
      await explains('MCP ツール `board_add` の基本の動作のテストです。Issue の参照を渡した場合に、ボードへ追加し、`issue`・`added: true`・`ready` の `status` を返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', optionId: 'o3' } })
    })

    it('status に値を渡すと、足した項目の Status をその値にして status に返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-03')
      await verifies(context, 'PW-BOARD-ADD-08')
      await explains('MCP ツール `board_add` の `status` のテストです。`status` に `active` を指定した場合に、追加した項目の Status を `active` に設定し、その値を `status` に返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o4')])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'active' })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o4' } })
    })

    it('status が空文字だと、Status を設定せず、status を返さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-04')
      await explains('MCP ツール `board_add` の `status` のテストです。`status` に空文字を指定した場合に、Status を設定せず、結果に `status` を含めないことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard()])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', status: '' })

      expect(outcome.structured).toEqual(ADDED)
      expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueNodeId', 'AddToProject'])
    })

    it('番号だけを渡して repo を付けると、そのリポジトリの Issue を足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-05')
      await explains('MCP ツール `board_add` の `repo` のテストです。番号だけを渡して `repo` を指定した場合に、指定したリポジトリの Issue をボードへ追加することを確認します。')
      prepareProject({ repositories: ['demo', 'other'] })
      const github = await startGithub([linkedRepositories(['demo', 'other']), issueNodeId('other'), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: '7', repo: 'acme/other' })

      expect(outcome.structured).toEqual({ issue: 'acme/other/7', added: true, status: 'ready' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'other', number: 7 } })
    })

    it('番号だけを渡して repo を省くと、git の remote のリポジトリの Issue を足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-06')
      await explains('MCP ツール `board_add` の対象のリポジトリのテストです。番号だけを渡して `repo` を省略した場合に、git の remote のリポジトリの Issue をボードへ追加することを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: '7' })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } })
    })

    it('status が有効な値でないとき、有効な値を並べた detail と kind が invalid-input の失敗を返し、足さない', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-09')
      await verifies(context, 'PW-BOARD-ADD-10')
      await verifies(context, 'PW-BOARD-ADD-11')
      await explains('MCP ツール `board_add` の `status` の値を検証するテストです。有効でない値を指定した場合に、有効な値を並べた `detail` と `invalid-input` の `kind` を持つ失敗を返し、ボードへ追加しないことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', status: 'foo' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-12')
      await explains('MCP ツール `board_add` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、`no-active-project` の失敗を返し、`detail` に候補と案内を入れることを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('project に設定の名前を渡すと、対象のリポを含む設定が 2 つあってもその設定でボードに足す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-22')
      await explains('MCP ツール `board_add` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定でボードへ追加することを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      const github = await startGithub([linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

      expect(outcome.structured).toEqual({ ...ADDED, status: 'ready' })
      expect(github.requests()).toHaveLength(4)
    })

    it('Issue の参照が不正なとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-13')
      await explains('MCP ツール `board_add` の Issue の参照を検証するテストです。不正な参照を渡した場合に、`kind` が `invalid-input` の失敗を返し、GitHub へ何も要求しないことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'invalid-format' })

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
      await explains('MCP ツール `board_add` のプロジェクトの登録を検証するテストです。Issue のリポジトリが登録されていない場合と、対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      prepareProject({ repositories: row.repositories })
      await startGithub(row.linked.length === 0 ? [] : [linkedRepositories(row.linked)])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: row.detail })
    })

    it('GitHub API がエラーを返したとき、失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-15')
      await explains('MCP ツール `board_add` の GitHub API のエラーのテストです。Issue の取得が 502 で失敗した場合に、`kind` が `github-api` の失敗を返し、`detail` に `could not add` で始まる理由を入れることを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), failing({ operation: 'GetIssueNodeId' })])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not add Issue acme\/demo\/7 to project: .*502/u)
    })

    it('status の値をボードが定義していないとき、足さずに kind が status-not-configured の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-16')
      await verifies(context, 'PW-BOARD-ADD-17')
      await explains('MCP ツール `board_add` の `status` の設定を検証するテストです。指定した Status の選択肢をボードが持たない場合に、ボードへ追加せず、`kind` が `status-not-configured` の失敗を返すことを確認します。')
      prepareProject({ missingStatus: 'active' })
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'active\' is not configured in the project' })
      expect(github.requests()).toEqual([])
    })

    it('ボードに Blocked が無いとき、status が blocked だと足さずに project_init の案内を detail に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-ADD-16')
      await verifies(context, 'PW-BOARD-ADD-17')
      await verifies(context, 'PW-BOARD-ADD-18')
      await explains('MCP ツール `board_add` の `Blocked` の選択肢のテストです。ボードが `Blocked` を持たない場合に、`status` に `blocked` を指定すると、追加せずに `project_init` の案内を `detail` に入れた失敗を返すことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await callToolOnce(BOARD_ADD_TOOLS, 'board_add', { issue_ref: 'acme/demo/7', status: 'blocked' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'blocked\' is not configured in the project\n  hint: call project_init to add the Blocked option to the board' })
      expect(github.requests()).toEqual([])
    })
  })
})
