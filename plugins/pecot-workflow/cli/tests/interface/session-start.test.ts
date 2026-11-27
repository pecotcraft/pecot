/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時リポ配下だけ */
// session_start の振る舞い（PW-SESSION-START-01〜39）を、ツールをプロセス内で呼んで確かめる。
// 一時 git リポ・設定ファイル・偽の GitHub サーバの上で動かし、受けた要求と終わった後のファイルを比べる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { explains } from '../_helpers/explains.js'
import { ambiguousFiles, AMBIGUOUS_MESSAGE, NO_ACTIVE_FILES, otherRepositoryConfig, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { TargetSpec } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { STALE_OPTION_TEXT, graphqlRule, projectConfig, requestLabels, restRule, runCommand, runTool, staleOptionUpdate } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun, ToolResult, ToolRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const SHA = '0123456789abcdef0123456789abcdef01234567'
const STACK_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
const ACTIVE = '.pecot/state/.pecot-active'
const TITLE = '.pecot/state/.pecot-session-title'
const BASE = '.pecot/state/.pecot-base'

const linkedRepositories = (): ResponseRule => graphqlRule(
  'GetLinkedRepositoriesUser',
  { user: { projectV2: { repositories: { nodes: [{ name: 'demo', owner: { login: 'acme' } }] } } } },
  { owner: 'acme', projectNumber: 1 },
)
const issueNode = (): ResponseRule => graphqlRule('GetIssueNodeId', { repository: { issue: { id: 'I_7', title: '[Task] 見本の Issue' } } }, { owner: 'acme', repo: 'demo', number: 7 })
// スタック先のブランチ（main 以外で、feat/ で始まるもの）には、別の SHA を返す
const baseSha = (branch: string): ResponseRule => restRule('GET', `/repos/acme/demo/git/ref/heads/${branch}`, 200, { object: { sha: branch.startsWith('feat/') ? STACK_SHA : SHA } })
const linkedBranch = (): ResponseRule => graphqlRule('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/7', prefix: 'refs/heads/' } } } })
const projectItems = (): ResponseRule => graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', project: { id: 'PVT_1' } }] } } } }, { owner: 'acme', repo: 'demo', number: 7 })
const statusUpdate = (): ResponseRule => graphqlRule(
  'UpdateProjectItemField',
  { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } },
  { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' },
)
const noPrerequisites = (): ResponseRule => prerequisitesRule({ number: 7 })

/**
前提が spec の Issue の、最後まで成功する応答の列
*/
function judged(spec: Partial<TargetSpec>, base = 'main'): ResponseRule[] {
  return [linkedRepositories(), prerequisitesRule({ number: 7, ...spec }), issueNode(), baseSha(base), linkedBranch(), projectItems(), statusUpdate()]
}

/**
最後まで成功する応答の列。base はベースブランチ
*/
function succeeding(base = 'main'): ResponseRule[] {
  return [linkedRepositories(), noPrerequisites(), issueNode(), baseSha(base), linkedBranch(), projectItems(), statusUpdate()]
}

const CREATED = 'created: branch feat/7 in acme/demo from main\n'
const STATUS_SET = 'set: Issue acme/demo/7 status active\n'
const TARGET_SET = 'created: work directory .pecot/work/7/\n'

const CREATE_ARGUMENTS = { issue_ref: 'acme/demo/7', branch: 'feat' }

async function create(extra: Partial<CommandRun> = {}, arguments_: Readonly<Record<string, unknown>> = CREATE_ARGUMENTS): Promise<CommandResult> {
  return await runCommand({ tool: 'session_start', arguments: arguments_, github: succeeding(), ...extra })
}

function expectClean(result: Readonly<Pick<CommandResult, 'problems' | 'unused'>>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

// 前の PR（#21、ブランチ feat/old/5）の手元の後片付けの取りこぼしの見本
const OLD_BRANCH = 'feat/old/5'
const LIST_BY_HEAD = 'ListPullRequestsByHead'

function headPullRequests(...states: readonly string[]): ResponseRule {
  const nodes = states.map((state, index) => ({ number: 21 + index, state, headRefName: OLD_BRANCH, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }))
  return graphqlRule(LIST_BY_HEAD, { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } }, { owner: 'acme', repo: 'demo', headRefName: OLD_BRANCH })
}

const FINISH_HINT = 'PR acme/demo#21 of the current branch feat/old/5 is merged but not cleaned up; call session_finish with pr_ref: "acme/demo/21", delete_branch: true'

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
async function start(run: Readonly<Partial<ToolRun>>): Promise<ToolResult> {
  return await runTool({ tool: 'session_start', arguments: { issue_ref: 'acme/demo/7', branch: 'feat' }, github: succeeding(), ...run })
}

describe('session_start', () => {
  it('Issue の参照とブランチ名を渡して打つと、Issue に紐づいたブランチを ブランチ名/Issue 番号 の名前で作る', async (context) => {
    await verifies(context, 'PW-SESSION-START-01')
    await explains('`session_start` に Issue の参照とブランチ名を指定した場合のテストです。Issue に紐づくブランチを `ブランチ名/Issue 番号` の名前で作成し、期待する順序で GitHub API を呼び出すことを確認します。')
    const result = await create()
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual([
      'GetLinkedRepositoriesUser',
      'GetIssuePrerequisites',
      'GetIssueNodeId',
      'GET /repos/acme/demo/git/ref/heads/main',
      'CreateLinkedBranch',
      'GetIssueProjectItems',
      'UpdateProjectItemField',
    ])
    expect(result.requests.at(4)).toMatchObject({ variables: { input: { issueId: 'I_7', oid: SHA, name: 'feat/7' } } })
  })

  it('base を付けて打つと、そのブランチの先頭からブランチを作る', async (context) => {
    await verifies(context, 'PW-SESSION-START-02')
    await explains('`base` を指定した場合のテストです。指定したブランチの先頭から、ブランチを作成することを確認します。')
    const result = await create({ github: succeeding('release') }, { issue_ref: 'acme/demo/7', branch: 'feat', base: 'release' })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/release')
    expect(result.stderr).toContain('created: branch feat/7 in acme/demo from release\n')
  })

  it('base を省いて打つと、設定ファイルの develop_branch の先頭からブランチを作る', async (context) => {
    await verifies(context, 'PW-SESSION-START-03')
    await explains('`base` を省略した場合のテストです。設定ファイルの `develop_branch` の先頭から、ブランチを作成することを確認します。')
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] })
    const result = await create({ config, github: succeeding('develop') })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/develop')
    expect(result.stderr).toContain('created: branch feat/7 in acme/demo from develop\n')
  })

  it.for([{ checkout: true }, { checkout: false }])('checkout に $checkout を渡して呼ぶと、渡さないときと同じ結果になる', async ({ checkout }, context) => {
    await verifies(context, 'PW-SESSION-START-06')
    await explains(`\`checkout\` に \`${String(checkout)}\` を指定した場合のテストです。指定しない場合と、終了コード・標準エラー・GitHub への要求・セッション名の記録がすべて同じになることを確認します。`)
    const plain = await create()
    const given = await create({}, { issue_ref: 'acme/demo/7', branch: 'feat', checkout })
    expect(given.code).toBe(plain.code)
    expect(given.stderr).toBe(plain.stderr)
    expect(given.requests).toEqual(plain.requests)
    expect(given.read(TITLE)).toBe(plain.read(TITLE))
  })

  it('ブランチを作ると、ボード上の Issue の Status を active にする', async (context) => {
    await verifies(context, 'PW-SESSION-START-07')
    await explains('ブランチを作成した場合のテストです。ボード上の Issue の Status を `active` にする GitHub API を呼び出すことを確認します。')
    const result = await create()
    expectClean(result)
    expect(result.requests.at(6)).toMatchObject({
      type: 'graphql',
      operation: 'UpdateProjectItemField',
      variables: { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' },
    })
  })

  it('ブランチを作ると、セッション名を .pecot-session-title に記録して作業ディレクトリを作り、.pecot-active は作らない', async (context) => {
    await verifies(context, 'PW-SESSION-START-08')
    await explains('ブランチを作成した場合のテストです。セッション名を `.pecot-session-title` に記録して作業ディレクトリを作成し、`.pecot-active` は作成しないことを確認します。')
    const result = await create()
    expect(result.read(TITLE)).toBe('#7 見本の Issue')
    expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(true)
    expect(result.read(ACTIVE)).toBeUndefined()
  })

  it('作業ディレクトリがすでにあっても、ブランチを作って作業ディレクトリの created の行を出す', async () => {
    await explains('作業ディレクトリが既に存在する場合のテストです。ブランチを作成し、作業ディレクトリの `created` の行を標準エラーに出力することを確認します。')
    const result = await create({ files: { '.pecot/work/7/keep': 'x' } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${CREATED}${STATUS_SET}${TARGET_SET}`)
  })

  it('ブランチを作ると、created の行を標準エラーに出す', async () => {
    await explains('ブランチを作成した場合のテストです。`created` の行を標準エラーに出力し、標準出力には何も出力しないことを確認します。')
    const result = await create()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${CREATED}${STATUS_SET}${TARGET_SET}`)
  })

  it('Status を active にすると、set の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-START-10')
    await explains('Status を `active` にした場合のテストです。`set` の行を標準エラーに出力することを確認します。')
    const result = await create()
    expect(result.stderr).toContain(STATUS_SET)
  })

  it('作業ディレクトリを作ると、created の行を標準エラーに出す', async () => {
    await explains('作業ディレクトリを作成した場合のテストです。`created: work directory` の行を標準エラーに出力することを確認します。')
    const result = await create()
    expect(result.stderr).toContain(TARGET_SET)
  })

  it('ボード上の Issue の Status を active にできないと、warning の行を標準エラーに出してブランチは作ったままにする', async () => {
    await explains('ボード上の Issue の項目を取得できず、Status を `active` にできない場合のテストです。警告を標準エラーに出力し、作成済みのブランチは残したまま終了コード 0 で終了することを確認します。')
    const failing: ResponseRule = { match: { operation: 'GetIssueProjectItems' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), failing] })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(CREATED)
    expect(result.stderr).toMatch(/warning: could not set Issue acme\/demo\/7 status active: .+\n/u)
    expect(result.stderr).not.toContain('set: Issue')
  })

  it('選択肢の ID が古くて Status を active にできないと、warning の行に project_activate の案内を添える', async () => {
    await explains('選択肢の ID が古く、Status を `active` にできない場合のテストです。警告に、`project_activate` で ID を読み直す案内（`hint:`）が付くことを確認します。')
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), projectItems(), staleOptionUpdate()] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain([
      `warning: could not set Issue acme/demo/7 status active: ${STALE_OPTION_TEXT}`,
      '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
      '',
    ].join('\n'))
    expect(result.stderr).not.toContain(STATUS_SET)
  })

  it('ボードの項目を読めずに Status を active にできないときは、warning に ID を読み直す案内を添えない', async () => {
    await explains('ボードの項目の取得が失敗して、Status を `active` にできない場合のテストです。警告に、ID を読み直す案内が付かないことを確認します。')
    const failing: ResponseRule = { match: { operation: 'GetIssueProjectItems' }, respond: { status: 200, body: { errors: [{ type: 'VALIDATION', message: 'bad item' }] } }, times: 1 }
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), failing] })
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/warning: could not set Issue acme\/demo\/7 status active: .+VALIDATION.+\n/u)
    expect(result.stderr).not.toContain('hint:')
  })

  it('Issue がボードに載っていないと、Status を変えずに warning の行を標準エラーに出す', async () => {
    await explains('Issue がボードに載っていない場合のテストです。Status を変更せず、警告を標準エラーに出力することを確認します。')
    const empty = graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), empty] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: could not set Issue acme/demo/7 status active: the Issue is not on the project board\n')
  })

  it('設定に workflow の active が無いと、Status を変えずに warning の行を標準エラーに出す', async () => {
    await explains('設定に workflow の `active` の選択肢が存在しない場合のテストです。Status を変更せず、警告を標準エラーに出力することを確認します。')
    const result = await create({ config: projectConfig({ workflowOptions: { backlog: 'o1' } }), github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), projectItems()] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: could not set Issue acme/demo/7 status active: the workflow status field has no \'active\' option\n')
  })

  it('作業対象を記録できないと、warning の行を標準エラーに出して終了コード 0 で終わる', async () => {
    await explains('作業対象を記録できない場合のテストです。状態ディレクトリの場所にファイルを置くと、警告を標準エラーに出力して終了コード 0 で終了することを確認します。')
    // 状態ディレクトリの場所にファイルを置くと、書けない
    const result = await create({ files: { '.pecot/state': 'not a directory' } }, { issue_ref: 'acme/demo/7', branch: 'feat' })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(CREATED)
    expect(result.stderr).toMatch(/warning: could not record the work target: .+\n/u)
    expect(result.stderr).not.toContain('created: work directory')
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含む設定が 2 つあり、`.active` でも選べない場合のテストです。候補と `project` の案内を標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const result = await create({ files: ambiguousFiles(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n`)
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含む設定が存在しない場合のテストです。エラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const result = await create({ config: otherRepositoryConfig(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
    expect(result.requests).toEqual([])
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定でブランチを作る', async (context) => {
    await verifies(context, 'PW-SESSION-START-42')
    await explains('`project` を指定した場合のテストです。対象のリポジトリを含む設定が 2 つあっても、指定した設定でブランチを作成することを確認します。')
    const result = await create({ files: ambiguousFiles() }, { issue_ref: 'acme/demo/7', branch: 'feat', project: SECOND_PROJECT })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(CREATED)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定でブランチを作る', async () => {
    await explains('`.active` が存在しない場合のテストです。対象のリポジトリを含む設定が 1 つだけなら、その設定でブランチを作成することを確認します。')
    const result = await create({ files: NO_ACTIVE_FILES })
    expect(result.code).toBe(0)
    expectClean(result)
  })

  it.for([
    { reference: '7', message: 'error: the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'\n' },
    { reference: 'invalid-format', message: 'error: invalid reference: invalid-format\n  accepted forms:\n    - full: \'owner/repo/N\'\n    - short: \'N\' (with a base repository)\n' },
  ])('Issue の参照が $reference でフル形式でないと、終了コード 2 で終わる', async ({ reference, message }) => {
    await explains(`Issue の参照に \`${reference}\` を指定した場合のテストです。フル形式（\`owner/repo/N\`）ではないため、エラーを標準エラーに出力して終了コード 2 で終了することを確認します。`)
    const result = await create({ github: [] }, { issue_ref: reference, branch: 'feat' })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(message)
    expect(result.requests).toEqual([])
  })

  it('作業ディレクトリの git remote のリポジトリが Issue のリポジトリと違うと、終了コード 2 で終わる', async () => {
    await explains('作業ディレクトリの git remote のリポジトリが、Issue のリポジトリと異なる場合のテストです。移動先を案内するエラーを標準エラーに出力して、終了コード 2 で終了することを確認します。')
    const result = await create({ remote: { owner: 'other', name: 'tree' }, github: [] })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe([
      'error: the repository of the work Issue (acme/demo) differs from the CWD git remote (other/tree)',
      '  move to the worktree of the target repository and call the tool again:',
      '  <project-root>/base/demo/ or <project-root>/<wtN>/demo/',
      '  create one with /pecot-w:w-worktree-add only if the repository has no worktree',
      '',
    ].join('\n'))
    expect(result.requests).toEqual([])
  })

  it('base を省いて develop_branch も設定していないと、終了コード 1 で終わる', async () => {
    await explains('`base` を省略し、`develop_branch` も設定していない場合のテストです。設定方法を案内するエラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const result = await create({ config: projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] }), github: [linkedRepositories(), noPrerequisites()] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toBe([
      'error: develop_branch is not set for acme/demo',
      '  set it with: project_link with repo: "acme/demo", develop_branch: "develop"',
      '  or give the base: session_start with issue_ref: "acme/demo/7", branch: "feat", base: "main"',
      '',
    ].join('\n'))
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssuePrerequisites'])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないと、終了コード 1 で終わる', async () => {
    await explains('Issue のリポジトリがプロジェクトに登録されていない場合のテストです。`is not in the project` のエラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const unlinked = graphqlRule('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [] } } } })
    const result = await create({ github: [unlinked] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toBe('error: acme/demo is not in the project\n')
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser'])
  })

  it('ブランチの作成までの GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    await explains('ブランチの作成までに GitHub API がエラー（HTTP 404）を返す場合のテストです。ブランチを作成せず、エラーを標準エラーに出力して終了コード 1 で終了し、セッション名を記録しないことを確認します。')
    const notFound = restRule('GET', '/repos/acme/demo/git/ref/heads/main', 404, { message: 'Not Found' })
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), notFound] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toMatch(/^error: could not create branch feat\/7 in acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\/git\/ref\/heads\/main\n$/u)
    expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
    expect(result.read(TITLE)).toBeUndefined()
  })

  it('ブランチの作成の mutation が GraphQL の errors を返すと、ステータスの更新へ進まず終了コード 1 で終わる', async () => {
    await explains('ブランチの作成の mutation が GraphQL の `errors` を返す場合のテストです。Status の更新へ進まずに、エラーを標準エラーに出力して終了コード 1 で終了することを確認します。')
    const rejected: ResponseRule = { match: { operation: 'CreateLinkedBranch' }, respond: { status: 200, body: { errors: [{ type: 'UNPROCESSABLE', message: 'Ref already exists' }] } }, times: 1 }
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), rejected] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not create branch feat\/7 in acme\/demo: .*Ref already exists/u)
    expect(requestLabels(result.requests)).not.toContain('GetIssueProjectItems')
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
    expect(result.read(TITLE)).toBeUndefined()
  })

  it('repo が今の git remote のリポジトリと食い違うと、終了コード 1 で終わる', async () => {
    await explains('`repo` が現在の git remote のリポジトリと異なる場合のテストです。エラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const result = await create({ github: [] }, { issue_ref: 'acme/demo/7', branch: 'feat', repo: 'other/tree' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: repo other/tree differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
    expect(result.requests).toEqual([])
  })

  it('repo を省いて git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async () => {
    await explains('`repo` を省略し、git リポジトリの外で実行した場合のテストです。`the repository is ambiguous` のエラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
    const result = await create({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  give repo: <owner/repo>\n')
    expect(result.requests).toEqual([])
  })

  describe('remote の URL から owner/repo を読めない', () => {
    // origin が手元のパス（bare リポ）で、URL から owner/repo を読めない
    const LOCAL_REMOTE = '/srv/git/demo.git'
    const WARNING = 'could not read the repository from the URL of the Git remote origin'

    it('repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-SESSION-START-38')
      await explains('remote の URL から owner と repo を読み取れない場合に、`repo` を指定したときのテストです。警告を標準エラーに出力し、同じ文を結果の `warnings` に含めて、処理を続行することを確認します。')
      const cli = await create({ remoteUrl: LOCAL_REMOTE }, { issue_ref: 'acme/demo/7', branch: 'feat', repo: 'acme/demo' })
      expectClean(cli)
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using repo acme/demo (${WARNING})\n`)
      expect(cli.stderr).toContain(CREATED)
      const tool = await runTool({ tool: 'session_start', arguments: { issue_ref: 'acme/demo/7', branch: 'feat', repo: 'acme/demo' }, github: succeeding(), remoteUrl: LOCAL_REMOTE })
      expectClean(tool)
      expect(tool.isError).toBe(false)
      expect(tool.structured).toMatchObject({ branch: 'feat/7', warnings: [`using repo acme/demo (${WARNING})`] })
    })

    it('repo を渡すと、Issue のリポジトリと作業ディレクトリの remote を比べずにブランチを作る', async (context) => {
      await verifies(context, 'PW-SESSION-START-40')
      await explains('remote の URL から owner と repo を読み取れない状態で、別のリポジトリを `repo` に指定した場合のテストです。作業ディレクトリの remote と比較せず、ブランチを作成することを確認します。')
      const cli = await create({ remoteUrl: LOCAL_REMOTE }, { issue_ref: 'acme/demo/7', branch: 'feat', repo: 'other/tree' })
      expectClean(cli)
      expect(cli.code).toBe(0)
      expect(cli.stderr).not.toContain('differs from the CWD git remote')
      expect(cli.stderr).toContain(CREATED)
    })

    it('repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-SESSION-START-39')
      await explains('remote の URL から owner と repo を読み取れない状態で、`repo` を省略した場合のテストです。`git-unresolved` の失敗と終了コード 1 を返し、GitHub へ要求を送らないことを確認します。')
      const cli = await create({ remoteUrl: LOCAL_REMOTE, github: [] })
      expect(cli.code).toBe(1)
      expect(cli.stderr).toBe('error: the repository is ambiguous\n  could not read the repository from the URL of the Git remote origin\n  give repo: <owner/repo>\n')
      expect(cli.requests).toEqual([])
      const tool = await runTool({ tool: 'session_start', arguments: { issue_ref: 'acme/demo/7', branch: 'feat' }, github: [], remoteUrl: LOCAL_REMOTE })
      expect(tool).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(tool.structured['detail']).toContain('give repo: <owner/repo>')
      expect(tool.requests).toEqual([])
    })
  })

  describe('MCP の data', () => {
    const ARGUMENTS = { issue_ref: 'acme/demo/7', branch: 'feat' }

    it('ブランチを作ると、作ったブランチ・リポジトリ・base・作業 Issue・作業ディレクトリの絶対パスを data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-09')
      await verifies(context, 'PW-SESSION-START-10')
      await verifies(context, 'PW-SESSION-START-11')
      await explains('MCP の `session_start` でブランチを作成した場合のテストです。作成したブランチ・リポジトリ・base・作業 Issue・作業ディレクトリの絶対パスが、`data` に含まれることを確認します。')
      const result = await runTool({ tool: 'session_start', arguments: ARGUMENTS, github: succeeding() })
      expectClean(result)
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({
        branch: 'feat/7',
        repository: 'acme/demo',
        base: 'main',
        issue: 'acme/demo/7',
        workDirectory: path.join(result.directory, '.pecot/work/7'),
      })
    })

    it('前提の PR にスタックして作ると、スタック先の Issue の番号を stackedOn に返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-29')
      await explains('MCP の `session_start` で、前提の PR にスタックして作成した場合のテストです。スタック先の Issue の番号が `stackedOn` に含まれることを確認します。')
      const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
      const result = await runTool({ tool: 'session_start', arguments: ARGUMENTS, github: judged({ blockedBy: [inReview] }, 'feat/3') })
      expectClean(result)
      expect(result.structured).toMatchObject({ branch: 'feat/7', base: 'feat/3', stackedOn: 3 })
    })

    it.for([
      { name: 'allow_cross_repo' },
      { name: 'force_overwrite_active' },
    ])('$name を渡すと、未知の入力として invalid-input で弾き、ブランチを作らない', async ({ name }, context) => {
      await verifies(context, 'PW-SESSION-START-37')
      await explains(`MCP の \`session_start\` に、未知の入力 \`${name}\` を指定した場合のテストです。\`invalid-input\` の失敗を返し、ブランチを作成しないことを確認します。`)
      const result = await runTool({ tool: 'session_start', arguments: { ...ARGUMENTS, [name]: true }, github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.requests).toEqual([])
    })

    it('Status を active にできないと、warning を data.warnings に返し、ブランチの data は返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-16')
      await explains('MCP の `session_start` で、Status を `active` にできない場合のテストです。警告を `data.warnings` に含め、ブランチの情報は返すことを確認します。')
      const empty = graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
      const result = await runTool({ tool: 'session_start', arguments: ARGUMENTS, github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), empty] })
      expectClean(result)
      expect(result.structured).toMatchObject({ branch: 'feat/7', warnings: ['could not set Issue acme/demo/7 status active: the Issue is not on the project board'] })
    })

    it('ブランチを作れないと、失敗の kind と detail を返し、成功の項目を返さない', async (context) => {
      await verifies(context, 'PW-SESSION-START-24')
      await explains('MCP の `session_start` で、ブランチを作成できない場合のテストです。成功の項目は含めず、失敗の `kind` と `detail` だけを返すことを確認します。')
      const notFound = restRule('GET', '/repos/acme/demo/git/ref/heads/main', 404, { message: 'Not Found' })
      const result = await runTool({ tool: 'session_start', arguments: ARGUMENTS, github: [linkedRepositories(), noPrerequisites(), issueNode(), notFound] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'github-not-found' } })
      expect(Object.keys(result.structured).toSorted((left, right) => left.localeCompare(right))).toEqual(['detail', 'kind'])
      expect(result.structured['detail']).toMatch(/^could not create branch feat\/7 in acme\/demo: resource not found: /u)
    })

    const start = async (extra: Partial<CommandRun> & { arguments?: Record<string, unknown> } = {}): Promise<Awaited<ReturnType<typeof runTool>>> => {
      const { arguments: toolArguments = {}, ...rest } = extra
      return await runTool({ tool: 'session_start', arguments: { ...ARGUMENTS, ...toolArguments }, github: succeeding(), ...rest })
    }
    const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }

    it('作業ディレクトリがすでにあっても、そのパスを workDirectory に入れる', async (context) => {
      await verifies(context, 'PW-SESSION-START-11')
      await explains('MCP の `session_start` で、作業ディレクトリが既に存在する場合のテストです。そのパスが `workDirectory` に含まれることを確認します。')
      const result = await start({ files: { '.pecot/work/7/keep': 'x' } })
      expect(result.structured['workDirectory']).toBe(path.join(result.directory, '.pecot/work/7'))
    })

    it('選択肢の ID が古くて Status を active にできないと、warnings に project_activate の案内を添える', async (context) => {
      await verifies(context, 'PW-SESSION-START-16')
      await explains('MCP の `session_start` で、選択肢の ID が古く Status を `active` にできない場合のテストです。`project_activate` の案内を含む警告が `warnings` に含まれることを確認します。')
      const result = await start({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), projectItems(), staleOptionUpdate()] })
      expectClean(result)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^could not set Issue acme\/demo\/7 status active: [\s\S]*project_activate/u)])
    })

    it('作業対象を記録できないと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-START-17')
      await explains('MCP の `session_start` で、作業対象を記録できない場合のテストです。警告が `warnings` に 1 つだけ含まれることを確認します。')
      const result = await start({ files: { '.pecot/state': 'not a directory' } })
      expectClean(result)
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^could not record the work target: /u)])
    })

    it('リポを含む設定が 2 つあってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-SESSION-START-18')
      await explains('MCP の `session_start` で、リポジトリを含む設定が 2 つあり、アクティブな設定がどれでもない場合のテストです。`no-active-project` の失敗を返し、`detail` に候補と `project` の案内が含まれることを確認します。')
      const result = await start({ files: ambiguousFiles(), github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(result.structured['detail']).toContain('choose one with project: <NAME>')
      expect(result.structured['detail']).toContain(`available: ${AMBIGUOUS_MESSAGE}`)
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-41')
      await explains('MCP の `session_start` で、対象のリポジトリを含む設定が存在しない場合のテストです。`repo-not-in-project` の失敗を返し、GitHub へ要求を送らないことを確認します。')
      const result = await start({ config: otherRepositoryConfig(), github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-not-in-project' } })
      expect(result.requests).toEqual([])
    })

    it.for([{ reference: '7' }, { reference: 'invalid-format' }])('issue_ref が $reference でフル形式でないと、kind が invalid-input の失敗を返す', async ({ reference }, context) => {
      await verifies(context, 'PW-SESSION-START-19')
      await explains(`MCP の \`session_start\` で、\`issue_ref\` に \`${reference}\` を指定した場合のテストです。フル形式ではないため、\`invalid-input\` の失敗を返し、GitHub へ要求を送らないことを確認します。`)
      const result = await start({ arguments: { issue_ref: reference }, github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.requests).toEqual([])
    })

    it('セッションのディレクトリの git remote のリポジトリが Issue のリポジトリと違うと、kind が repo-mismatch の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-20')
      await explains('MCP の `session_start` で、セッションのディレクトリの git remote のリポジトリが Issue のリポジトリと異なる場合のテストです。`repo-mismatch` の失敗を返すことを確認します。')
      const result = await start({ remote: { owner: 'other', name: 'tree' }, github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(result.requests).toEqual([])
    })

    it('base を省いて develop_branch も設定していないと、kind が repo-setting-missing の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-22')
      await explains('MCP の `session_start` で、`base` を省略し、`develop_branch` も設定していない場合のテストです。`repo-setting-missing` の失敗を返すことを確認します。')
      const result = await start({ config: projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] }), github: [linkedRepositories(), noPrerequisites()] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-setting-missing' } })
    })

    it('Issue のリポジトリがプロジェクトに登録されていないと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-23')
      await explains('MCP の `session_start` で、Issue のリポジトリがプロジェクトに登録されていない場合のテストです。`repo-not-in-project` の失敗を返すことを確認します。')
      const unlinked = graphqlRule('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [] } } } })
      const result = await start({ github: [unlinked] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-not-in-project', detail: 'acme/demo is not in the project' } })
    })

    it('repo が今の git remote のリポジトリと食い違うと、kind が repo-mismatch の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-25')
      await explains('MCP の `session_start` で、`repo` が現在の git remote のリポジトリと異なる場合のテストです。`repo-mismatch` の失敗を返すことを確認します。')
      const result = await start({ arguments: { repo: 'other/tree' }, github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(result.requests).toEqual([])
    })

    it('repo を省いて git の外で呼ぶと、the repository is ambiguous で始まる detail を入れ、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-26')
      await verifies(context, 'PW-SESSION-START-27')
      await explains('MCP の `session_start` で、`repo` を省略し、git リポジトリの外で呼び出した場合のテストです。`git-unresolved` の失敗を返し、`detail` が `the repository is ambiguous` で始まることを確認します。')
      const result = await start({ remote: false, github: [] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(result.structured['detail']).toMatch(/^the repository is ambiguous\n/u)
    })

    it('着手の判定が blocked だと、ブランチを作らず、理由と直し方を detail に入れ、kind が not-ready の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-31')
      await verifies(context, 'PW-SESSION-START-32')
      await explains('MCP の `session_start` で、着手の判定が `blocked` の場合のテストです。ブランチを作成せず、理由と直し方を `detail` に含めた `not-ready` の失敗を返すことを確認します。')
      const result = await start({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, title: '未着手' }] })] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-ready' } })
      expect(result.structured['detail']).toContain('#7 is blocked by #3 (not in review: #3 (not started))')
      expect(result.structured['detail']).toContain('issue_dependency_check')
      expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
    })

    it('stackable の判定で base の値とスタック先が違うと、ブランチを作らず、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-33')
      await explains('MCP の `session_start` で、判定が `stackable` なのに、`base` がスタック先と異なる場合のテストです。ブランチを作成せず、`invalid-input` の失敗を返すことを確認します。')
      const result = await start({ arguments: { base: 'release' }, github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] })] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.read(BASE)).toBeUndefined()
    })

    it('前提を読めないと、ブランチを作らず、kind が dependency-unreadable の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-34')
      await explains('MCP の `session_start` で、前提を取得できない場合のテストです。ブランチを作成せず、`dependency-unreadable` の失敗を返すことを確認します。')
      const failing: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      const result = await start({ github: [linkedRepositories(), failing] })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'dependency-unreadable' } })
      expect(result.read(TITLE)).toBeUndefined()
    })

    it('スタック先のブランチが判定の後に無くなると、スタック先が見つからない旨を detail に入れ、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-START-35')
      await explains('MCP の `session_start` で、判定の後にスタック先のブランチが存在しなくなった場合のテストです。スタック先が見つからないことを `detail` に含めた、`git-unresolved` の失敗を返すことを確認します。')
      const gone = restRule('GET', '/repos/acme/demo/git/ref/heads/feat/3', 404, { message: 'Not Found' })
      const result = await start({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] }), issueNode(), gone] })
      expectClean(result)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(result.structured['detail']).toMatch(/^base branch feat\/3 of #3 not found: /u)
    })
  })
  describe('着手の判定', () => {
    const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
    const waiting = { number: 4, title: '待つ前提' }
    const WAITS = '## Waits for merge\n- #4: 公開後に確かめる\n'
    const STACKED = 'created: branch feat/7 in acme/demo from feat/3 (stacked on #3)\n'

    it('前提の PR が 1 本にスタックできると、その PR のブランチの先頭からブランチを作り、created の行にスタック先を付ける', async (context) => {
      await verifies(context, 'PW-SESSION-START-28')
      await explains('前提の PR が 1 本あり、スタックできる場合のテストです。その PR のブランチの先頭からブランチを作成し、`created` の行にスタック先を付けることを確認します。')
      const result = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/feat/3')
      expect(result.stderr).toBe(`${STACKED}${STATUS_SET}${TARGET_SET}`)
      expect(requestLabels(result.requests)).toContain('CreateLinkedBranch')
      expect(result.requests.find(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')).toMatchObject({ variables: { input: { issueId: 'I_7', oid: STACK_SHA, name: 'feat/7' } } })
    })

    it('ブランチを作ると、選んだ base を .pecot-base に書く（スタックしたときはスタック先の Issue も）', async (context) => {
      await verifies(context, 'PW-SESSION-START-30')
      await explains('ブランチを作成した場合の、`.pecot-base` の記録のテストです。選んだ base が書き込まれ、スタックしたときはスタック先の Issue も書き込まれることを確認します。')
      const stacked = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') })
      expect(stacked.read(BASE)).toBe(`feat/3 ${STACK_SHA} acme/demo#3`)
      const plain = await create({ files: { [BASE]: `release ${SHA} acme/demo#1` } })
      expect(plain.read(BASE)).toBe(`main ${SHA}`)
    })

    it('スタック先と同じ base を付けると、そのままスタックして作る', async (context) => {
      await verifies(context, 'PW-SESSION-START-28')
      await explains('スタック先と同じブランチを `base` に指定した場合のテストです。そのままスタックして、ブランチを作成することを確認します。')
      const result = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') }, { issue_ref: 'acme/demo/7', branch: 'feat', base: 'feat/3' })
      expect(result.code).toBe(0)
      expect(result.stderr).toContain(STACKED)
    })

    it('スタック先と違う base を付けると、ブランチを作らず終了コード 2 で終わる', async () => {
      await explains('スタック先と異なるブランチを `base` に指定した場合のテストです。ブランチを作成せず、エラーを標準エラーに出力して終了コード 2 で終了することを確認します。')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] })] }, { issue_ref: 'acme/demo/7', branch: 'feat', base: 'release' })
      expect(result.code).toBe(2)
      expectClean(result)
      expect(result.stderr).toBe('error: base: "release" differs from the base chosen by readiness: feat/3 (stacked on #3)\n')
      expect(result.read(TITLE)).toBeUndefined()
      expect(result.read(BASE)).toBeUndefined()
    })

    it('前提が 2 件で、1 件が merge 待ちなら、ブランチを作らず理由と直し方を出して終了コード 2 で終わる', async () => {
      await explains('前提が 2 件あり、1 件が merge 待ちの場合のテストです。ブランチを作成せず、理由と直し方を標準エラーに出力して、終了コード 2 で終了することを確認します。')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview, waiting], body: WAITS })] })
      expect(result.code).toBe(2)
      expectClean(result)
      expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssuePrerequisites'])
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3, #4 (waits for merge)',
        '  - #3: in review',
        '  - #4: wait: merge — 公開後に確かめる',
        '  to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 3, then issue_dependency_write with the same arguments',
        '  to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 4, then issue_dependency_write with the same arguments',
        '  to stack on it instead of waiting for merge: remove #4 from the Waits for merge section of the body of acme/demo/7, then issue_check with method: "update" and issue_write',
        '',
      ].join('\n'))
      expect(result.read(TITLE)).toBeUndefined()
    })

    it('済んでいない前提が 1 件で merge 待ちなら、直し方にその Issue の参照を入れる', async () => {
      await explains('完了していない前提が 1 件で、merge 待ちの場合のテストです。直し方に、その Issue の参照が含まれることを確認します。')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [waiting], body: WAITS })] })
      expect(result.code).toBe(2)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #4 (waits for merge)',
        '  - #4: wait: merge — 公開後に確かめる',
        '  to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 4, then issue_dependency_write with the same arguments',
        '  to stack on it instead of waiting for merge: remove #4 from the Waits for merge section of the body of acme/demo/7, then issue_check with method: "update" and issue_write',
        '',
      ].join('\n'))
    })

    it('merge 待ち以外の理由で blocked なら、直し方は unblock の 1 行だけにする', async () => {
      await explains('merge 待ち以外の理由で `blocked` の場合のテストです。直し方が `unblock` の 1 行だけになることを確認します。')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, title: '未着手' }] })] })
      expect(result.code).toBe(2)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3 (not in review: #3 (not started))',
        '  - #3: not started',
        '  to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 3, then issue_dependency_write with the same arguments',
        '',
      ].join('\n'))
    })

    it('blocked のときは、base を付けても比べずに blocked で止まる', async () => {
      await explains('`blocked` の状態で `base` を指定した場合のテストです。`base` を比較せずに、`blocked` のエラーで終了することを確認します。')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [waiting], body: WAITS })] }, { issue_ref: 'acme/demo/7', branch: 'feat', base: 'release' })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('error: #7 is blocked by #4')
    })

    it('前提を読めないと、ブランチを作らず終了コード 1 で終わる', async () => {
      await explains('前提を取得できない場合のテストです。ブランチを作成せず、エラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
      const failing: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      const result = await create({ github: [linkedRepositories(), failing] })
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toMatch(/^error: could not read blocked-by of #7: .+500/u)
      expect(result.read(TITLE)).toBeUndefined()
    })

    it('前提は読めても判定できないと、判定できない旨の error の行を出して終了コード 1 で終わる', async () => {
      await explains('前提は取得できたが、判定ができない場合のテストです。判定できないことを示すエラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
      const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] })
      const result = await create({ config, github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] })] }, { issue_ref: 'acme/demo/7', branch: 'feat', base: 'main' })
      expect(result.code).toBe(1)
      expectClean(result)
      expect(result.stderr).toBe([
        'error: could not judge readiness of #7: develop_branch is not set for acme/demo',
        '  set it with: project_link with repo: "acme/demo", develop_branch: "develop"',
        '',
      ].join('\n'))
    })

    it('Epic は判定を持たないので、今までどおり開発ブランチから作る', async (context) => {
      await verifies(context, 'PW-SESSION-START-03')
      await explains('Epic の Issue に着手する場合のテストです。Epic は判定を持たないため、これまでどおり開発ブランチからブランチを作成することを確認します。')
      const result = await create({ github: judged({ issueType: 'Epic' }) })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toBe(`${CREATED}${STATUS_SET}${TARGET_SET}`)
    })

    it('依存関係に対応しない GHES では、判定を省いた旨の warning を出して、今までどおり開発ブランチから作る', async (context) => {
      await verifies(context, 'PW-SESSION-START-03')
      await explains('依存関係に対応しない GHES の場合のテストです。判定を省略した旨の警告を出力し、これまでどおり開発ブランチからブランチを作成することを確認します。')
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const result = await create({ github: [linkedRepositories(), unsupported, issueNode(), baseSha('main'), linkedBranch(), projectItems(), statusUpdate()] })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toBe(`warning: readiness is not checked: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n${CREATED}${STATUS_SET}${TARGET_SET}`)
    })

    it('スタック先のブランチが判定の後に無くなると、スタック先が見つからない旨の error の行を出して終了コード 1 で終わる', async () => {
      await explains('判定の後にスタック先のブランチが存在しなくなった場合のテストです。スタック先が見つからないことを示すエラーを標準エラーに出力して、終了コード 1 で終了することを確認します。')
      const gone = restRule('GET', '/repos/acme/demo/git/ref/heads/feat/3', 404, { message: 'Not Found' })
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] }), issueNode(), gone] })
      expect(result.code).toBe(1)
      expectClean(result)
      expect(result.stderr).toMatch(/^error: base branch feat\/3 of #3 not found: resource not found: .+\n$/u)
      expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
      expect(result.read(TITLE)).toBeUndefined()
    })

    it('blocked の理由が diverged なら、直し方は unblock の行だけにする', async () => {
      await explains('`blocked` の理由が `diverged`（前提の PR が 1 本の連なりではない）場合のテストです。直し方が `unblock` の行だけになることを確認します。')
      const diverged = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3', base: 'feat/2' }] }
      const noPullRequests = graphqlRule('ListPullRequestsByHead', { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } })
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [diverged] }), noPullRequests] })
      expect(result.code).toBe(2)
      expectClean(result)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3 (not in one chain)',
        '  - #3: in review',
        '  to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 3, then issue_dependency_write with the same arguments',
        '',
      ].join('\n'))
    })
  })

  describe('前の PR の手元の後片付けの取りこぼし', () => {
    it('今のブランチの PR がマージ済みで開いた PR が無いと、leftovers にその PR を入れ、session_finish を案内してブランチを作る', async (context) => {
      await verifies(context, 'PW-SESSION-START-43')
      await explains('MCP の `session_start` で、今のブランチの PR がマージ済みで、開いた PR が存在しない場合のテストです。その PR を `leftovers` に含め、`session_finish` の案内を警告に含めて、ブランチを作成することを確認します。')
      const tool = await start({ branch: OLD_BRANCH, github: [...succeeding(), headPullRequests('MERGED')] })
      expectClean(tool)
      expect(tool.isError).toBe(false)
      expect(tool.structured).toMatchObject({ branch: 'feat/7', leftovers: [{ pullRequest: 'acme/demo/21' }] })
      expect(tool.structured['warnings']).toEqual([FINISH_HINT])
    })

    it('今のブランチの名前が番号で終わらないと、取りこぼしを確かめる要求を送らず、leftovers を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-START-45')
      await explains('MCP の `session_start` で、今のブランチの名前が番号で終わらない場合のテストです。取りこぼしを確認する要求を送らず、`leftovers` を含めないことを確認します。')
      const result = await create({}, { issue_ref: 'acme/demo/7', branch: 'feat' })
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain(LIST_BY_HEAD)
      const tool = await start({ branch: 'wt8' })
      expectClean(tool)
      expect(tool.structured).not.toHaveProperty('leftovers')
      expect(tool.structured).not.toHaveProperty('warnings')
    })

    it.for([
      { name: '今のブランチの PR が開いている', states: ['OPEN', 'MERGED'] },
      { name: '今のブランチの PR が閉じただけ', states: ['CLOSED'] },
    ])('$name とき、取りこぼしとせず、leftovers と warnings を入れない', async ({ states }, context) => {
      await verifies(context, 'PW-SESSION-START-46')
      await explains('MCP の `session_start` で、今のブランチの PR が開いている場合と、閉じただけの場合のテストです。どちらも取りこぼしとして扱わず、`leftovers` と `warnings` を含めないことを確認します。')
      const tool = await start({ branch: OLD_BRANCH, github: [...succeeding(), headPullRequests(...states)] })
      expectClean(tool)
      expect(tool.structured).not.toHaveProperty('leftovers')
      expect(tool.structured).not.toHaveProperty('warnings')
    })

    it.for([
      { name: 'GitHub API がエラーを返す', respond: { status: 500, body: { message: 'boom' } } },
      { name: '接続が切れる', respond: { status: 200, disconnect: true } },
    ])('今のブランチの PR を読むとき $name と、warnings に入れてブランチを作る', async ({ respond }, context) => {
      await verifies(context, 'PW-SESSION-START-48')
      await explains('MCP の `session_start` で、今のブランチの PR を取得するときに GitHub API がエラーを返す場合と、接続が切れる場合のテストです。どちらも警告を `warnings` に含めて、ブランチを作成することを確認します。')
      const failed: ResponseRule = { match: { operation: LIST_BY_HEAD }, respond, times: 1 }
      const tool = await start({ branch: OLD_BRANCH, github: [...succeeding(), failed] })
      expectClean(tool)
      expect(tool.isError).toBe(false)
      expect(tool.structured).toMatchObject({ branch: 'feat/7', warnings: [expect.stringMatching(/^could not check leftovers: reading the PR of the current branch failed: /u)] })
      expect(tool.structured).not.toHaveProperty('leftovers')
    })
  })
})
