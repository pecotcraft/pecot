import { describe, expect, it } from 'vitest'

import { BOARD_MOVE_COMMANDS } from '../../src/commands/board-move.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { boardItems, failing, fieldUpdated, linkedRepositories, prepareProject } from '../_helpers/board-issue-case.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function update(argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(argv, BOARD_MOVE_COMMANDS)
}

async function move(arguments_: Readonly<Record<string, unknown>>): Promise<Awaited<ReturnType<typeof callToolOnce>>> {
  return await callToolOnce(BOARD_MOVE_COMMANDS, 'board_move', arguments_)
}

describe('board move', () => {
  it('Issue の参照と Status を渡すと、ボード上のその Issue の Status を渡した値にして set の行を出す', async () => {
    await explains('`board move` の基本の動作のテストです。Issue の参照と Status を渡した場合に、ボード上のその Issue の Status を指定した値に更新し、`set` の行を出力することを確認します。')
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

  it('設定に blocked があるとき、blocked を渡すと、blocked の選択肢で Status を更新して set の行を出す', async () => {
    await explains('`board move` の `blocked` のテストです。設定に `blocked` の選択肢が存在する場合に、その選択肢で Status を更新し、`set` の行を出力することを確認します。')
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o7')])

    const result = await update(['board', 'move', 'acme/demo/7', 'blocked'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status blocked\n' })
    expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('ボードに Blocked が存在しないとき、blocked を渡すと、選択肢の追加方法を案内する error を出す', async () => {
    await explains('`board move` の `Blocked` の選択肢のテストです。ボードが `Blocked` を持たない場合に、`blocked` を渡すと、`pecot project init` の実行を案内するエラーを出力することを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems()])

    const result = await update(['board', 'move', 'acme/demo/7', 'blocked'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: status \'blocked\' is not configured in the project\n  hint: run pecot project init to add the Blocked option to the board\n',
    })
  })

  it('番号だけを渡して --repo を付けると、そのリポジトリの Issue の Status を設定する', async () => {
    await explains('`board move` の `--repo` のテストです。番号だけを渡して `--repo` を指定した場合に、指定したリポジトリの Issue の Status を設定することを確認します。')
    prepareProject({ repositories: ['demo', 'other'] })
    const github = await startGithub([linkedRepositories(['demo', 'other']), boardItems({ onBoard: true, repository: 'other' }), fieldUpdated('o4')])

    const result = await update(['--repo', 'acme/other', 'board', 'move', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/other/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'other', number: 7 } })
  })

  it('番号だけを渡して --repo を省くと、git の remote のリポジトリの Issue を対象にする', async () => {
    await explains('`board move` の対象のリポジトリのテストです。番号だけを渡して `--repo` を省略した場合に、git の remote のリポジトリの Issue を対象にすることを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o4')])

    const result = await update(['board', 'move', '7', 'active'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status active\n' })
    expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'demo', number: 7 } })
  })

  it('Status が有効な値でないとき、有効な値を並べた error を出し、終了コード 1 で終わる', async () => {
    await explains('`board move` の Status の値を検証するテストです。有効でない値を渡した場合に、有効な値を並べたエラーを出力し、GitHub へ何も要求せずに終了コード 1 で終わることを確認します。')
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

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`board move` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、候補と `--project` の案内を出力して終了コード 1 で終わることを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async () => {
    await explains('`board move` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合に、エラーと選べる設定の一覧を出力して終了コード 1 で終わることを確認します。')
    prepareProject({ repositories: ['other'] })

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で Status を更新する', async () => {
    await explains('`board move` の `--project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`--project` で指定した設定で Status を更新することを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

    const result = await update(['board', 'move', 'acme/demo/7', 'in_review', '--project', SECOND_PROJECT])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status in_review\n' })
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で Status を更新する', async () => {
    await explains('`board move` のプロジェクトの設定の選択のテストです。`.active` が存在しなくても、対象のリポジトリを含む設定が 1 つであれば、その設定で Status を更新することを確認します。')
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

    const result = await update(['board', 'move', 'acme/demo/7', 'in_review'])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'set: Issue acme/demo/7 status in_review\n' })
  })

  it('Issue の参照が不正なとき、終了コード 2 で終わる', async () => {
    await explains('`board move` の Issue の参照を検証するテストです。`invalid-format` のような不正な参照を渡した場合に、GitHub へ何も要求せず、終了コード 2 で終わることを確認します。')
    prepareProject()
    const github = await startGithub([])

    const result = await update(['board', 'move', 'invalid-format', 'active'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid reference')
    expect(github.requests()).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないとき、終了コード 1 で終わる', async () => {
    await explains('`board move` のプロジェクトの登録を検証するテストです。Issue のリポジトリがプロジェクトに登録されていない場合に、エラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('Issue がボードに無いとき、board add を案内する error を出し、終了コード 1 で終わる', async () => {
    await explains('`board move` の Issue がボードに載っていない場合のテストです。Issue がボードへ追加されていない場合に、`pecot board add` を案内するエラーを出力して終了コード 1 で終わることを確認します。')
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

  it('ボードが Status を定義していないとき、更新せずに終了コード 1 で終わる', async () => {
    await explains('`board move` の Status の設定を検証するテストです。指定した Status の選択肢をボードが持たない場合に、更新せず、エラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject({ missingStatus: 'active' })
    const github = await startGithub([linkedRepositories(), boardItems()])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: status \'active\' is not configured in the project\n' })
    expect(github.requests()).toHaveLength(2)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async () => {
    await explains('`board move` の GitHub API のエラーのテストです。Status の書き込みが 502 で失敗した場合に、`could not set` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ operation: 'UpdateProjectItemField' })])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not set Issue acme\/demo\/7 status active: .*502/u)
  })

  it('選択肢の ID が古くて Status を書けないと、書けなかった Status の error に project activate の案内を添えて終了コード 1 で終わる', async () => {
    await explains('Status の書き込みが失敗した場合の `board move` のテストです。古い選択肢の ID で書き込みが失敗した場合に、エラーに `pecot project activate` の案内を添えて、終了コード 1 で終わることを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), staleOptionUpdate()])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: [
        `error: could not set Issue acme/demo/7 status active: ${STALE_OPTION_TEXT}`,
        '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
        '',
      ].join('\n'),
    })
  })

  it('500 で Status を書けないときは、書けなかった Status の error だけを出し、ID を読み直す案内を添えない', async () => {
    await explains('Status の書き込みが失敗した場合の `board move` のテストです。書き込みが 500 で失敗した場合に、書き込みのエラーだけを出力し、ID を読み直す案内を付けないことを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ operation: 'UpdateProjectItemField' }, 500)])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not set Issue acme\/demo\/7 status active: .+500/u)
    expect(result.stderr).not.toContain('hint:')
  })

  it('ボードの項目を読めないときは、error に ID を読み直す案内を添えない', async () => {
    await explains('ボードの項目の読み出しが失敗した場合の `board move` のテストです。読み出しが失敗した場合に、エラーを出力して終了コード 1 で終わり、ID を読み直す案内は付けないことを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), failing({ operation: 'GetIssueProjectItems' })])

    const result = await update(['board', 'move', 'acme/demo/7', 'active'])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not set Issue acme\/demo\/7 status active: .*502/u)
    expect(result.stderr).not.toContain('hint:')
  })

  describe('MCP の呼び出し', () => {
    it('Issue の参照と Status を渡すと、ボード上の Status をその値にし、issue と status を返す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-01')
      await verifies(context, 'PW-BOARD-MOVE-04')
      await explains('MCP ツール `board_move` の基本の動作のテストです。Issue の参照と Status を渡した場合に、ボード上の Status を指定した値に更新し、`issue` と `status` を返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'in_review' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'in_review' })
      expect(github.requests().at(-1)).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o5' } })
    })

    it('番号だけを渡して repo を付けると、そのリポジトリの Issue の Status を設定する', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-02')
      await explains('MCP ツール `board_move` の `repo` のテストです。番号だけを渡して `repo` を指定した場合に、指定したリポジトリの Issue の Status を設定することを確認します。')
      prepareProject({ repositories: ['demo', 'other'] })
      const github = await startGithub([linkedRepositories(['demo', 'other']), boardItems({ onBoard: true, repository: 'other' }), fieldUpdated('o4')])

      const outcome = await move({ issue_ref: '7', status: 'active', repo: 'acme/other' })

      expect(outcome.structured).toEqual({ issue: 'acme/other/7', status: 'active' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'other', number: 7 } })
    })

    it('番号だけを渡して repo を省くと、git の remote のリポジトリの Issue を対象にする', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-03')
      await explains('MCP ツール `board_move` の対象のリポジトリのテストです。番号だけを渡して `repo` を省略した場合に、git の remote のリポジトリの Issue を対象にすることを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o4')])

      const outcome = await move({ issue_ref: '7', status: 'active' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'active' })
      expect(github.requests()[1]).toMatchObject({ operation: 'GetIssueProjectItems', variables: { repo: 'demo', number: 7 } })
    })

    it('Status が有効な値でないとき、有効な値を並べた detail と kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-05')
      await verifies(context, 'PW-BOARD-MOVE-06')
      await explains('MCP ツール `board_move` の `status` の値を検証するテストです。有効でない値を渡した場合に、有効な値を並べた `detail` と `invalid-input` の `kind` を持つ失敗を返し、GitHub へ何も要求しないことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'foo' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-07')
      await explains('MCP ツール `board_move` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、`no-active-project` の失敗を返し、`detail` に候補と案内を入れることを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
    })

    it('project に設定の名前を渡すと、対象のリポを含む設定が 2 つあってもその設定で Status を更新する', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-18')
      await explains('MCP ツール `board_move` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定で Status を更新することを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([linkedRepositories(), boardItems(), fieldUpdated('o5')])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'in_review', project: SECOND_PROJECT })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'in_review' })
    })

    it('Issue の参照が不正なとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-08')
      await explains('MCP ツール `board_move` の Issue の参照を検証するテストです。不正な参照を渡した場合に、`kind` が `invalid-input` の失敗を返し、GitHub へ何も要求しないことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await move({ issue_ref: 'invalid-format', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toContain('invalid reference')
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'Issue のリポジトリがプロジェクトに登録されていない', id: 'PW-BOARD-MOVE-09', repositories: ['demo'], linked: ['other'], detail: 'repository acme/demo is not in the project' },
      { name: '対象のリポを含む設定が無い', id: 'PW-BOARD-MOVE-17', repositories: ['other'], linked: [], detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' },
    ])('$name とき、kind が repo-not-in-project の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      await explains('MCP ツール `board_move` のプロジェクトの登録を検証するテストです。Issue のリポジトリが登録されていない場合と、対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      prepareProject({ repositories: row.repositories })
      await startGithub(row.linked.length === 0 ? [] : [linkedRepositories(row.linked)])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: row.detail })
    })

    it('Issue がボードに無いとき、board_add の案内を detail に入れ、kind が not-on-board の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-10')
      await verifies(context, 'PW-BOARD-MOVE-11')
      await explains('MCP ツール `board_move` の Issue がボードに載っていない場合のテストです。Issue がボードへ追加されていない場合に、`not-on-board` の失敗を返し、`detail` に `board_add` の案内を入れることを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), boardItems({ onBoard: false })])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'not-on-board', detail: 'Issue acme/demo/7 is not on the project board\n  hint: add it to the board first with board_add with issue_ref: "acme/demo/7"' })
    })

    it('ボードが Status を定義していないとき、更新せずに kind が status-not-configured の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-12')
      await explains('MCP ツール `board_move` の Status の設定を検証するテストです。指定した Status の選択肢をボードが持たない場合に、更新せず、`kind` が `status-not-configured` の失敗を返すことを確認します。')
      prepareProject({ missingStatus: 'active' })
      const github = await startGithub([linkedRepositories(), boardItems()])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'active\' is not configured in the project' })
      expect(github.requests()).toHaveLength(2)
    })

    it('ボードに Blocked が無いとき、blocked を渡すと project_init の案内を detail に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-12')
      await verifies(context, 'PW-BOARD-MOVE-14')
      await explains('MCP ツール `board_move` の `Blocked` の選択肢のテストです。ボードが `Blocked` を持たない場合に、`blocked` を渡すと、`detail` に `project_init` の案内を入れた失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), boardItems()])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'blocked' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'status-not-configured', detail: 'status \'blocked\' is not configured in the project\n  hint: call project_init to add the Blocked option to the board' })
    })

    it.for([
      { name: 'Status の書き込みに GitHub API がエラーを返した', failed: 'UpdateProjectItemField', rules: [boardItems()] },
      { name: 'ボードの項目の読み出しに GitHub API がエラーを返した', failed: 'GetIssueProjectItems', rules: [] },
    ])('$name とき、失敗を返す', async (row, context) => {
      await verifies(context, 'PW-BOARD-MOVE-13')
      await explains('MCP ツール `board_move` の GitHub API のエラーのテストです。Status の書き込みと、ボードの項目の読み出しのどちらかが失敗した場合に、`kind` が `github-api` の失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), ...row.rules, failing({ operation: row.failed })])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not set Issue acme\/demo\/7 status active: .*502/u)
    })

    it('選択肢の ID が古くて Status を書けないと、書けなかった Status と project_activate の案内を detail に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-16')
      await explains('MCP ツール `board_move` の Status の書き込みが失敗した場合のテストです。古い選択肢の ID で書き込みが失敗した場合に、`detail` に書き込めなかった Status と `project_activate` の案内を入れた失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), boardItems(), staleOptionUpdate()])

      const outcome = await move({ issue_ref: 'acme/demo/7', status: 'active' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({
        kind: 'github-api',
        detail: `could not set Issue acme/demo/7 status active: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
      })
    })

    it('CLI で --dry-run を付けると、ボードの項目を読むだけで Status を動かさず、設定する予定を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-BOARD-MOVE-15')
      await explains('`board move --dry-run` のテストです。`--dry-run` を指定した場合に、ボードの項目の読み出しだけを行って Status を更新せず、設定する予定を `dry-run` の行に出力することを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), boardItems()])

      const result = await update(['board', 'move', 'acme/demo/7', 'active', '--dry-run'])

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would set Issue acme/demo/7 status active\n' })
      expect(github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems'])
    })
  })
})
