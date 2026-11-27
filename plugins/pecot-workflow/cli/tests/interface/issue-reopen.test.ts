import { describe, expect, it, vi } from 'vitest'

import { ISSUE_REOPEN_COMMANDS } from '../../src/commands/issue-reopen.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { CliResult } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { runInProcess, settleWithFakeDelays, startGithub, useFakeDelays } from '../_helpers/interface-case.js'
import { boardItems, commented, failing, fieldUpdated, linkedRepositories, prepareProject, reopened, waitForRequests } from '../_helpers/board-issue-case.js'
import type { RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
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

function reopenWithComment(): ResponseRule[] {
  return [linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened(), commented()]
}

describe('issue reopen', () => {
  it('閉じた Issue の参照を渡すと、reopen して reopened の行を標準エラーに出す', async () => {
    await explains('閉じた Issue を開き直す、`issue reopen` の基本的な動作のテストです。閉じた Issue の参照だけを渡した場合に、Issue を再び開き、`reopened` の行を標準エラーに出力することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(github.requests().filter(request => labelOf(request) === PATCH)).toHaveLength(2)
    expect(github.requests().find(request => labelOf(request) === PATCH)).toMatchObject({ body: { state: 'open' } })
  })

  it('ボードの項目がアーカイブ済みなら、Status を設定する前にアーカイブを解き、updated の行を標準エラーに出す', async () => {
    await explains('ボードの項目がアーカイブされている Issue を開き直す、`issue reopen` のテストです。アーカイブ済みの場合に、Status を設定する前にアーカイブを解除し、`updated` の行を標準エラーに出力することを確認します。')
    prepareProject()
    const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
    const unarchived: ResponseRule = { match: { operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_1', itemId: 'PVTI_7' } }, respond: { status: 200, body: { data: { unarchiveProjectV2Item: { item: { id: 'PVTI_7' } } } } }, times: 1 }
    const github = await startGithub([linkedRepositories(), reopened(), archived, unarchived, fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('updated: Issue acme/demo/7 unarchived on the board\nset: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
    expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', 'UnarchiveProjectItem', PATCH, 'UpdateProjectItemField', PATCH])
  })

  it('もしアーカイブを解けないなら、Issue を開かずに error の行を出して終了コード 1 で終わる', async () => {
    await explains('ボードの項目のアーカイブ解除に失敗した場合の、`issue reopen` のテストです。解除の API が 500 を返したときに、Issue を開かず、`error` の行を出力して終了コード 1 で終了することを確認します。')
    prepareProject()
    const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
    const github = await startGithub([linkedRepositories(), archived, failing({ operation: 'UnarchiveProjectItem' }, 500)])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not unarchive Issue acme\/demo\/7 on the board: .+500/u)
    expect(github.requests().map(request => labelOf(request))).not.toContain(PATCH)
  })

  it('--status を渡すと、reopen の後にボードの status をその値にして set の行を出す', async () => {
    await explains('`issue reopen` の `--status` オプションのテストです。`--status active` を渡した場合に、開き直した後でボードの Status を `active` に設定し、`set` の行を出力することを確認します。')
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

  it('設定に blocked があるとき、--status blocked でボードの status を blocked の option にして set の行を出す', async () => {
    await explains('Status の選択肢に `blocked` を追加したボードでの、`issue reopen` のテストです。`--status blocked` を渡した場合に、ボードの Status を `blocked` の選択肢に設定することを確認します。')
    prepareProject({ hasBlocked: true })
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o7'), reopened()])

    const result = await reopen(['acme/demo/7', '--status', 'blocked'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('set: Issue acme/demo/7 status blocked\nreopened: Issue acme/demo/7\n')
    expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
  })

  it('--status を省くと、ボードの status を ready にする', async () => {
    await explains('`--status` を指定しない場合の、`issue reopen` の既定の動作のテストです。オプションを省略した場合に、ボードの Status を `ready` に設定することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.stderr).toBe('set: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
    expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o3' } })
  })

  it('status を設定すると、3 秒待ってからもう一度 reopen する', async () => {
    await explains('Status を設定した後の、`issue reopen` の待ち時間のテストです。Status を設定すると、3 秒が経過するまでは 2 回目の reopen を送信せず、経過した後で 1 回だけ送信することを確認します。')
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

  it('--comment を付けると、reopen の後に理由をコメントに投稿して created の行を出す', async () => {
    await explains('`issue reopen` の `--comment` オプションのテストです。`--comment` を指定した場合に、開き直した後で理由を Issue のコメントとして投稿し、`created` の行を出力することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o4'), reopened(), commented()])

    const result = await reopen(['acme/demo/7', '--status', 'active', '--comment', '再発したので開き直す'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('set: Issue acme/demo/7 status active\nreopened: Issue acme/demo/7\ncreated: comment on acme/demo/7\n')
    expect(github.requests().at(-1)).toMatchObject({ method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: '再発したので開き直す' } })
    expect(github.requests().map(request => labelOf(request)).slice(-2)).toEqual([PATCH, COMMENT])
  })

  it('--comment を付けて 2 回打つと、そのたびにコメントを投稿する', async () => {
    await explains('`--comment` を付けた `issue reopen` を繰り返し実行する場合のテストです。同じ内容のコメントを付けて 2 回実行したときに、実行のたびにコメントを投稿することを確認します。')
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

  it('Issue がボードに無いとき、warning を出して status を変えずに reopen だけを行う', async () => {
    await explains('ボードに載っていない Issue を開き直す、`issue reopen` のテストです。Issue がボードに存在しない場合は、Status を変更せず、`warning` の行を出力して Issue を開くだけで完了することを確認します。')
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

  it('status がプロジェクトに設定されていないとき、warning を出して reopen する', async () => {
    await explains('プロジェクトの設定に Status の選択肢が存在しない場合の、`issue reopen` のテストです。指定した `active` が設定に存在しないときは、`warning` の行を出力して Issue を開き直すことを確認します。')
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

  it.for([
    { name: 'Issue がボードに無い', setup: (): void => { prepareProject() }, rules: (): ResponseRule[] => [linkedRepositories(), boardItems({ onBoard: false })], argv: [], warning: 'warning: Issue acme/demo/7 is not on the project board\n' },
    { name: 'status がプロジェクトに設定されていない', setup: (): void => { prepareProject({ missingStatus: 'active' }) }, rules: (): ResponseRule[] => [linkedRepositories(), boardItems()], argv: ['--status', 'active'], warning: 'warning: status \'active\' is not configured in the project\n' },
  ])('--dry-run で $name とき、warning を出し、Issue を開かない', async ({ setup, rules, argv, warning }) => {
    await explains('`issue reopen` の `--dry-run` のテストです。ボードの項目が存在しない場合と、指定した Status の選択肢が設定に存在しない場合は、`warning` の行を出力し、Issue を開かないことを確認します。')
    setup()
    const github = await startGithub(rules())

    const result = await reopen(['acme/demo/7', '--dry-run', ...argv])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(warning)
    expect(github.requests().map(request => labelOf(request))).not.toContain(PATCH)
  })

  it('2 回目の reopen の応答に state が無いとき、None と書いた error を出して終了コード 1 で終わる', async () => {
    await explains('2 回目の reopen の応答に `state` が含まれない場合の、`issue reopen` のテストです。応答が空だったときに、`None` を含む `error` の行を出力して終了コード 1 で終了することを確認します。')
    prepareProject()
    const noState: ResponseRule = { match: { method: 'PATCH', path: '/repos/acme/demo/issues/7' }, respond: { status: 200, body: {} }, times: 1 }
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), noState])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: Issue acme/demo/7 did not become open (state: None)\n')
  })

  it('blocked がプロジェクトに設定されていないとき、足し方の hint を添えた warning を出して reopen する', async () => {
    await explains('プロジェクトの設定に `blocked` が存在しない場合の、`issue reopen` のテストです。`--status blocked` を渡したときに、追加方法を示す `hint` を付けた `warning` を出力し、Issue を開き直すことを確認します。')
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

  it('選択肢の ID が古くて列を書けないと、書けなかった列の warning と project activate の案内を出し、reopen とコメントの投稿を続ける', async () => {
    await explains('Status の選択肢の ID が古くなっている場合の、`issue reopen` のテストです。Status を書き込めないときに、`warning` と `project activate` の案内を出力し、Issue の再オープンとコメントの投稿は続けることを確認します。')
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

  it('列を書けなかったときは、3 秒待たずにもう一度 reopen する', async () => {
    await explains('Status の書き込みに失敗した場合の、`issue reopen` の待ち時間のテストです。Status を設定できなかったときに、3 秒を待たずに 2 回目の reopen を送信することを確認します。')
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

  it('500 で列を書けないときは、warning だけを出し、ID を読み直す案内を添えない', async () => {
    await explains('Status の書き込みが 500 で失敗した場合の、`issue reopen` のテストです。選択肢の ID が古いのではなく API のエラーのときに、`warning` だけを出力し、ID を読み直す案内を含めないことを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), failing({ operation: 'UpdateProjectItemField' }, 500), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: could not set Issue acme\/demo\/7 status ready: .+500/u)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
    expect(result.stderr).not.toContain('hint:')
  })

  it('2 回目の reopen の後も Issue が open でないとき、error を出して終了コード 1 で終わる', async () => {
    await explains('2 回目の reopen の後も Issue が開いていない場合の、`issue reopen` のテストです。応答の `state` が `closed` のままのときに、`error` の行を出力して終了コード 1 で終了することを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened('closed')])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'set: Issue acme/demo/7 status ready\nerror: Issue acme/demo/7 did not become open (state: closed)\n',
    })
  })

  it('コメントの投稿に失敗したとき、コメントの失敗と分かる error を出し、終了コード 1 で終わる', async () => {
    await explains('コメントの投稿に失敗した場合の、`issue reopen` のテストです。コメントの投稿が失敗したときに、再オープンは完了したうえで、コメントの失敗を示す `error` を出力し、終了コード 1 で終了することを確認します。')
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
  ] satisfies readonly { name: string, args: readonly string[] }[])('--comment が空白だけで $name と、GitHub を呼ばず、終了コード 1 で終わる', async (row) => {
    await explains('`--comment` に空白だけを渡した場合の、`issue reopen` のテストです。通常の実行でも `--dry-run` でも、GitHub を呼び出さず、`--comment is blank` の `error` を出力して終了コード 1 で終了することを確認します。')
    prepareProject()
    const github = await startGithub([])

    const result = await reopen(['acme/demo/7', '--comment', '  \n ', ...row.args])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --comment is blank: give a reason or omit it\n' })
    expect(github.requests()).toEqual([])
  })

  it('--status が有効な値でないとき、終了コード 1 で終わる', async () => {
    await explains('`--status` に不正な値を渡した場合の、`issue reopen` のテストです。`foo` のような有効でない値を渡したときに、有効な値の一覧を示す `error` を出力し、GitHub を呼び出さずに終了コード 1 で終了することを確認します。')
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

  it('対象のリポを含む設定が 2 つあり .active も選べないとき、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、`issue reopen` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `--project` の案内を出力して終了コード 1 で終了することを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いとき、error を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合の、`issue reopen` のテストです。該当する設定がないときに、`error` の行を出力して終了コード 1 で終了することを確認します。')
    prepareProject({ repositories: ['other'] })

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で reopen する', async () => {
    await explains('`issue reopen` の `--project` オプションのテストです。対象のリポジトリを含む設定が 2 つある場合でも、`--project` で設定を指定したときに、その設定を使って Issue を開き直すことを確認します。')
    const { project } = prepareProject()
    makeAmbiguous(project)
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7', '--project', SECOND_PROJECT])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で reopen する', async () => {
    await explains('`.active` が存在しない場合の、`issue reopen` のテストです。対象のリポジトリを含む設定が 1 つだけのときに、その設定を使って Issue を開き直すことを確認します。')
    const { project } = prepareProject()
    removeActive(project)
    await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('reopened: Issue acme/demo/7\n')
  })

  it('リポジトリがプロジェクトに無いとき、reopen せずに終了コード 1 で終わる', async () => {
    await explains('リポジトリがプロジェクトにリンクされていない場合の、`issue reopen` のテストです。対象のリポジトリがプロジェクトに存在しないときは、Issue を開かず、終了コード 1 で終了することを確認します。')
    prepareProject()
    const github = await startGithub([linkedRepositories(['other'])])

    const result = await reopen(['acme/demo/7'])

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: repository acme/demo is not in the project\n' })
    expect(github.requests()).toHaveLength(1)
  })

  it('GitHub API がエラーを返したとき、error を出して終了コード 1 で終わる', async () => {
    await explains('GitHub API が失敗した場合の、`issue reopen` のテストです。Issue を開く要求が 500 を返したときに、`could not reopen` の `error` を出力して終了コード 1 で終了することを確認します。')
    prepareProject()
    await startGithub([linkedRepositories(), boardItems(), failing({ method: 'PATCH', path: '/repos/acme/demo/issues/7' }, 500)])

    const result = await reopen(['acme/demo/7'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not reopen Issue acme\/demo\/7: .*500/u)
  })

  it('Issue の参照の形が誤っているとき、終了コード 2 で終わる', async () => {
    await explains('Issue の参照の形式が誤っている場合の、`issue reopen` のテストです。`invalid-format` のような参照を渡したときに、終了コード 2 で終了し、GitHub を呼び出さないことを確認します。')
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

    it('Status が Done の項目の Issue を開き直すと、開き直す前に Status を消し、removed の行を標準エラーに出す', async () => {
      await explains('Status が `Done` のボードの項目を持つ Issue を開き直す、`issue reopen` のテストです。開き直す前に Status を消去し、`removed` の行を標準エラーに出力することを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done'), CLEARED, reopened(), fieldUpdated('o3'), reopened()])

      const result = await reopen(['acme/demo/7'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('removed: Issue acme/demo/7 Status Done on the board\nset: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
      const labels = github.requests().map(request => labelOf(request))
      expect(labels.indexOf('ClearProjectItemField')).toBeLessThan(labels.indexOf(PATCH))
    })

    it('Status が Done でないとき、Status を消さず、removed の行を出さない', async () => {
      await explains('Status が `Done` 以外の項目を持つ Issue を開き直す、`issue reopen` のテストです。`Needs Attention` などの場合に、Status を消去せず、`removed` の行も出力しないことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Needs Attention'), reopened(), fieldUpdated('o3'), reopened()])

      const result = await reopen(['acme/demo/7'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('set: Issue acme/demo/7 status ready\nreopened: Issue acme/demo/7\n')
      expect(github.requests().map(request => labelOf(request))).not.toContain('ClearProjectItemField')
    })

    it('Status が Done でないとき、Status を消さず、doneCleared を false で data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-26')
      await explains('Status が `Done` 以外の項目を持つ Issue を MCP の `issue_reopen` で開き直す場合のテストです。Status を消去せず、結果の `doneCleared` を `false` で返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Needs Attention'), reopened(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: false, commented: false })
      expect(github.requests().map(request => labelOf(request))).not.toContain('ClearProjectItemField')
    })

    it('Status の Done を消せないとき、warning の行を出し、reopen とコメントの投稿を続ける', async () => {
      await explains('Status の `Done` の消去に失敗した場合の、`issue reopen` のテストです。消去できないときに、`warning` の行を出力し、Issue の再オープンとコメントの投稿は続けることを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), itemWithStatus('Done'), failing({ operation: 'ClearProjectItemField' }), reopened(), fieldUpdated('o3'), reopened(), commented()])

      const result = await reopen(['acme/demo/7', '--comment', '再発した'])

      expect(result.code).toBe(0)
      expect(result.stderr).toMatch(/^warning: could not remove Issue acme\/demo\/7 Status Done on the board: [\s\S]*\. The board automation may close the Issue again; clear Status on the board\n/u)
      expect(result.stderr).toContain('reopened: Issue acme/demo/7\ncreated: comment on acme/demo/7\n')
    })

    it('--dry-run で打つと、Status を消さずに、消す予定を reopen の後・set の前の dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-21')
      await explains('`--dry-run` を付けた、Status が `Done` の Issue に対する `issue reopen` のテストです。Status を消去せず、消去する予定を再オープンの後・設定の前の `dry-run` の行に出力することを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done')])

      const result = await reopen(['acme/demo/7', '--dry-run'])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('dry-run: would reopen Issue acme/demo/7\ndry-run: would remove Issue acme/demo/7 Status Done on the board\ndry-run: would set Issue acme/demo/7 status ready\n')
      expect(github.requests().map(request => labelOf(request))).not.toContain('ClearProjectItemField')
    })

    it('Status が Done の項目の Issue を開き直すと、開き直す前に Status を消し、doneCleared を true で data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-26')
      await explains('Status が `Done` のボードの項目を持つ Issue を MCP の `issue_reopen` で開き直す場合のテストです。開き直す前に Status を消去し、結果の `doneCleared` を `true` で返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done'), CLEARED, reopened(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: true, commented: false })
      const labels = github.requests().map(request => labelOf(request))
      expect(labels.indexOf('ClearProjectItemField')).toBeLessThan(labels.indexOf(PATCH))
    })

    it('Status の Done を消せないとき、warnings で伝え、reopen とコメントの投稿を続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-27')
      await explains('Status の `Done` の消去に失敗した場合の、MCP の `issue_reopen` のテストです。消去できないときに、`warnings` で利用者へ伝え、Issue の再オープンとコメントの投稿は続けることを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), itemWithStatus('Done'), failing({ operation: 'ClearProjectItemField' }), reopened(), fieldUpdated('o3'), reopened(), commented()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: '再発した' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', doneCleared: false, commented: true })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not remove Issue acme\/demo\/7 Status Done on the board: [\s\S]*\. The board automation may close the Issue again; clear Status on the board$/u)])
      expect(github.requests().map(request => labelOf(request)).slice(-2)).toEqual([PATCH, COMMENT])
    })
  })

  describe('MCP の data', () => {
    it('アーカイブを解いて status を書きコメントを投稿すると、その結果を data に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-02')
      await verifies(context, 'PW-ISSUE-REOPEN-05')
      await verifies(context, 'PW-ISSUE-REOPEN-07')
      await verifies(context, 'PW-ISSUE-REOPEN-09')
      await verifies(context, 'PW-ISSUE-REOPEN-22')
      await explains('MCP の `issue_reopen` が、結果を `data` として返すテストです。アーカイブの解除、Status の書き込み、コメントの投稿をすべて行った場合に、その内容を反映した `data` を返すことを確認します。')
      prepareProject()
      const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
      const unarchived: ResponseRule = { match: { operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_1', itemId: 'PVTI_7' } }, respond: { status: 200, body: { data: { unarchiveProjectV2Item: { item: { id: 'PVTI_7' } } } } }, times: 1 }
      const github = await startGithub([linkedRepositories(), reopened(), archived, unarchived, fieldUpdated('o4'), reopened(), commented()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', status: 'active', comment: '再発したので開き直す' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'active', unarchived: true, doneCleared: false, commented: true })
      expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', 'UnarchiveProjectItem', PATCH, 'UpdateProjectItemField', PATCH, COMMENT])
      expect(github.requests()[4]).toMatchObject({ variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' } })
      expect(github.requests().at(-1)).toMatchObject({ body: { body: '再発したので開き直す' } })
    })

    it('コメントの投稿に失敗したとき、コメントの失敗と分かる detail を github-api の失敗で返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-14')
      await explains('コメントの投稿に失敗した場合の、MCP の `issue_reopen` のテストです。投稿が失敗したときに、コメントの失敗と分かる `detail` を付け、種別 `github-api` の失敗として返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened(), failing({ method: 'POST', path: '/repos/acme/demo/issues/7/comments' })])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由' })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(outcome.structured['detail']).toMatch(/^could not comment on Issue acme\/demo\/7: /u)
    })

    it('comment が空白だけで呼ぶと、GitHub を呼ばずに、入力の名前を comment と書いた invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-25')
      await explains('`comment` に空白だけを渡した場合の、MCP の `issue_reopen` のテストです。GitHub を呼び出さず、入力名 `comment` を示す種別 `invalid-input` の失敗を返すことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: ' '.repeat(3) })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'comment is blank: give a reason or omit it' })
      expect(github.requests()).toEqual([])
    })

    it('Issue がボードに無いとき、status を変えずに reopen だけを行い、warnings に入れて status を省いた data を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-10')
      await verifies(context, 'PW-ISSUE-REOPEN-11')
      await explains('ボードに載っていない Issue を開き直す、MCP の `issue_reopen` のテストです。Issue がボードに存在しない場合は、Status を変更せず、`warnings` に入れて `status` を含まない `data` を返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), reopened(), boardItems({ onBoard: false }), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', unarchived: false, doneCleared: false, commented: false, warnings: ['Issue acme/demo/7 is not on the project board'] })
      expect(github.requests().map(request => labelOf(request))).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', PATCH, PATCH])
    })

    it('閉じた Issue の参照を渡すと、reopen して issue に入れ、status を省くと ready にする', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-01')
      await verifies(context, 'PW-ISSUE-REOPEN-03')
      await verifies(context, 'PW-ISSUE-REOPEN-07')
      await verifies(context, 'PW-ISSUE-REOPEN-08')
      await explains('MCP の `issue_reopen` の基本的な動作のテストです。閉じた Issue の参照だけを渡した場合に、Issue を開き直し、`status` を `ready` にした `data` を返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: false, commented: false })
      expect(github.requests().filter(request => labelOf(request) === PATCH)).toHaveLength(2)
      expect(github.requests().find(request => labelOf(request) === PATCH)).toMatchObject({ body: { state: 'open' } })
      expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { optionId: 'o3' } })
    })

    it('設定に blocked があるとき、status に blocked を渡すと、ボードの status を blocked の option にする', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-02')
      await verifies(context, 'PW-ISSUE-REOPEN-07')
      await explains('Status の選択肢に `blocked` を追加したボードでの、MCP の `issue_reopen` のテストです。`status` に `blocked` を渡した場合に、ボードの Status を `blocked` の選択肢に設定することを確認します。')
      prepareProject({ hasBlocked: true })
      const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o7'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', status: 'blocked' })

      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', status: 'blocked' })
      expect(github.requests()[3]).toMatchObject({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o7' } })
    })

    it('status を設定すると、3 秒待ってからもう一度 reopen する', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-04')
      await explains('Status を設定した後の、MCP の `issue_reopen` の待ち時間のテストです。Status を設定すると、3 秒が経過するまでは 2 回目の reopen を送信せず、経過した後で 1 回だけ送信することを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])
      const observed: { beforeEnd: string[] } = { beforeEnd: [] }
      useFakeDelays()

      const outcome = await callToolOnce(ISSUE_REOPEN_COMMANDS, 'issue_reopen', { issue_ref: 'acme/demo/7' }, async (pending) => {
        await waitForRequests(() => github.requests().length, 4)
        await vi.advanceTimersByTimeAsync(2999)
        await waitForRequests(() => github.requests().length, 4)
        observed.beforeEnd = github.requests().map(request => labelOf(request))
        await vi.advanceTimersByTimeAsync(1)
        return await settleWithFakeDelays(pending)
      })

      expect(observed.beforeEnd).toEqual(['GetLinkedRepositoriesUser', 'GetIssueProjectItems', PATCH, 'UpdateProjectItemField'])
      expect(github.requests().map(request => labelOf(request)).slice(4)).toEqual([PATCH])
      expect(outcome.isError).toBe(false)
    })

    it('comment を渡して 2 回呼ぶと、そのたびにコメントを投稿する', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-06')
      await explains('`comment` を付けた MCP の `issue_reopen` を繰り返し呼び出す場合のテストです。同じ内容のコメントを付けて 2 回呼び出したときに、呼び出しのたびにコメントを投稿することを確認します。')
      prepareProject()
      const github = await startGithub([...reopenWithComment(), ...reopenWithComment()])

      const first = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由' })
      const second = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由' })

      expect([first.structured['commented'], second.structured['commented']]).toEqual([true, true])
      expect(github.requests().filter(request => labelOf(request) === COMMENT)).toHaveLength(2)
    })

    it.for([
      { name: 'active が設定に無い', id: 'PW-ISSUE-REOPEN-12', options: { missingStatus: 'active' }, status: 'active', warning: 'status \'active\' is not configured in the project' },
      { name: 'blocked が設定に無い', id: 'PW-ISSUE-REOPEN-20', options: {}, status: 'blocked', warning: 'status \'blocked\' is not configured in the project\n  hint: call project_init to add the Blocked option to the board' },
    ])('$name とき、warnings に入れて reopen する', async (row, context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-12')
      await verifies(context, row.id)
      await explains('プロジェクトの設定に Status の選択肢が存在しない場合の、MCP の `issue_reopen` のテストです。`active` や `blocked` が設定に存在しないときは、`warnings` に入れて Issue を開き直すことを確認します。')
      prepareProject(row.options)
      const github = await startGithub([linkedRepositories(), reopened(), boardItems(), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', status: row.status })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([row.warning])
      expect(github.requests().map(request => labelOf(request))).not.toContain('UpdateProjectItemField')
    })

    it('選択肢の ID が古くて列を書けないと、warnings に project_activate の案内を入れ、3 秒待たずに reopen とコメントの投稿を続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-24')
      await explains('Status の選択肢の ID が古くなっている場合の、MCP の `issue_reopen` のテストです。Status を書き込めないときに、`warnings` に `project_activate` の案内を入れ、再オープンとコメントの投稿は続けることを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(), reopened(), boardItems(), staleOptionUpdate(), reopened(), commented()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', comment: '理由' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([
        `could not set Issue acme/demo/7 status ready: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
      ])
      expect(github.requests().map(request => labelOf(request)).slice(-2)).toEqual([PATCH, COMMENT])
    })

    it('500 で列を書けないときは、warnings に入れ、ID を読み直す案内を添えない', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-24')
      await explains('Status の書き込みが 500 で失敗した場合の、MCP の `issue_reopen` のテストです。選択肢の ID が古いのではなく API のエラーのときに、`warnings` に入れ、ID を読み直す案内を含めないことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), reopened(), boardItems(), failing({ operation: 'UpdateProjectItemField' }, 500), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^could not set Issue acme\/demo\/7 status ready: .+500[\s\S]*$/u)])
      expect(String(outcome.structured['warnings'])).not.toContain('hint:')
    })

    it('ボードの項目のアーカイブを解けないなら、Issue を開かずに失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-23')
      await explains('ボードの項目のアーカイブ解除に失敗した場合の、MCP の `issue_reopen` のテストです。解除の API が 500 を返したときに、Issue を開かず、失敗を返すことを確認します。')
      prepareProject()
      const archived: ResponseRule = { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', isArchived: true, project: { id: 'PVT_1' } }] } } } } } }, times: 1 }
      const github = await startGithub([linkedRepositories(), archived, failing({ operation: 'UnarchiveProjectItem' }, 500)])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toMatch(/^could not unarchive Issue acme\/demo\/7 on the board: .+500/u)
      expect(github.requests().map(request => labelOf(request))).not.toContain(PATCH)
    })

    it('2 回目の reopen の後も Issue が open でないとき、kind が other の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-13')
      await explains('2 回目の reopen の後も Issue が開いていない場合の、MCP の `issue_reopen` のテストです。応答の `state` が `closed` のままのときに、種別 `other` の失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened('closed')])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'other', detail: 'Issue acme/demo/7 did not become open (state: closed)', issue: 'acme/demo/7', status: 'ready', unarchived: false, doneCleared: false, commented: false })
    })

    it('status が有効な値でないとき、要求を送らずに kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-15')
      await explains('`status` に不正な値を渡した場合の、MCP の `issue_reopen` のテストです。`foo` のような有効でない値を渡したときに、要求を送信せず、種別 `invalid-input` の失敗を返すことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', status: 'foo' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないとき、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-16')
      await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、MCP の `issue_reopen` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `project` の案内を含む種別 `no-active-project` の失敗を返すことを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      const github = await startGithub([])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が無いとき、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-28')
      await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合の、MCP の `issue_reopen` のテストです。該当する設定がないときに、種別 `repo-not-in-project` の失敗を返すことを確認します。')
      prepareProject({ repositories: ['other'] })

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で reopen する', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-29')
      await explains('MCP の `issue_reopen` の `project` 入力のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で設定を指定したときに、その設定を使って Issue を開き直すことを確認します。')
      const { project } = prepareProject()
      makeAmbiguous(project)
      await startGithub([linkedRepositories(), reopened(), boardItems(), fieldUpdated('o3'), reopened()])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', status: 'ready' })
    })

    it('リポジトリがプロジェクトに無いとき、reopen せずに kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-17')
      await explains('リポジトリがプロジェクトにリンクされていない場合の、MCP の `issue_reopen` のテストです。対象のリポジトリがプロジェクトに存在しないときは、Issue を開かず、種別 `repo-not-in-project` の失敗を返すことを確認します。')
      prepareProject()
      const github = await startGithub([linkedRepositories(['other'])])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'repository acme/demo is not in the project' })
      expect(github.requests()).toHaveLength(1)
    })

    it('GitHub API がエラーを返したとき、失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-18')
      await explains('GitHub API が失敗した場合の、MCP の `issue_reopen` のテストです。Issue を開く要求が 500 を返したときに、種別 `github-api` の失敗を返すことを確認します。')
      prepareProject()
      await startGithub([linkedRepositories(), boardItems(), failing({ method: 'PATCH', path: '/repos/acme/demo/issues/7' }, 500)])

      const outcome = await reopenTool({ issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('github-api')
      expect(outcome.structured['detail']).toMatch(/^could not reopen Issue acme\/demo\/7: .*500/u)
    })

    it('Issue の参照の形が誤っているとき、要求を送らずに kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-REOPEN-19')
      await explains('Issue の参照の形式が誤っている場合の、MCP の `issue_reopen` のテストです。`invalid-format` のような参照を渡したときに、要求を送信せず、種別 `invalid-input` の失敗を返すことを確認します。')
      prepareProject()
      const github = await startGithub([])

      const outcome = await reopenTool({ issue_ref: 'invalid-format' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toMatch(/^invalid reference: invalid-format\n/u)
      expect(github.requests()).toEqual([])
    })
  })
})
