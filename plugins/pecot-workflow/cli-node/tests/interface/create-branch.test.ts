/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時リポ配下だけ */
// create-branch の振る舞い（PW-CREATE-BRANCH-01〜27）を、runCli をプロセス内で呼んで確かめる。
// 一時 git リポ・設定ファイル・偽の GitHub サーバの上で動かし、受けた要求と終わった後のファイルを比べる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const SHA = '0123456789abcdef0123456789abcdef01234567'
const ACTIVE = '.pecot/state/.pecot-active'
const TITLE = '.pecot/state/.pecot-session-title'

const linkedRepositories = (): ResponseRule => graphqlRule(
  'GetLinkedRepositoriesUser',
  { user: { projectV2: { repositories: { nodes: [{ name: 'demo', owner: { login: 'acme' } }] } } } },
  { owner: 'acme', projectNumber: 1 },
)
const issueNode = (): ResponseRule => graphqlRule('GetIssueNodeId', { repository: { issue: { id: 'I_7', title: '[Task] 見本の Issue' } } }, { owner: 'acme', repo: 'demo', number: 7 })
const baseSha = (branch: string): ResponseRule => restRule('GET', `/repos/acme/demo/git/ref/heads/${branch}`, 200, { object: { sha: SHA } })
const linkedBranch = (): ResponseRule => graphqlRule('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/7', prefix: 'refs/heads/' } } } })
const projectItems = (): ResponseRule => graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', project: { id: 'PVT_1' } }] } } } }, { owner: 'acme', repo: 'demo', number: 7 })
const statusUpdate = (): ResponseRule => graphqlRule(
  'UpdateProjectItemField',
  { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } },
  { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' },
)
const slimIssue = (state: string): ResponseRule => graphqlRule(
  'GetIssueSlim',
  { repository: { issue: { number: 999, state, title: 't', body: 'b', comments: { totalCount: 0 } } } },
  { owner: 'acme', repo: 'demo', number: 999 },
)

/**
最後まで成功する応答の列。base はベースブランチ
*/
function succeeding(base = 'main'): ResponseRule[] {
  return [linkedRepositories(), issueNode(), baseSha(base), linkedBranch(), projectItems(), statusUpdate()]
}

const CREATED = 'created: branch feat/7 in acme/demo from main\n'
const STATUS_SET = 'set: Issue acme/demo/7 status active\n'
const TARGET_SET = 'set: work target acme/demo/7 (work directory .pecot/work/7/)\n'

async function create(extra: Partial<CommandRun> = {}, argv: readonly string[] = ['create-branch', 'acme/demo/7', 'feat']): Promise<CommandResult> {
  return await runCommand({ argv, github: succeeding(), ...extra })
}

function expectClean(result: Readonly<CommandResult>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

describe('create-branch', () => {
  it('Issue の参照とブランチ名を渡して打つと、Issue に紐づいたブランチを ブランチ名/Issue 番号 の名前で作る', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-01')
    const result = await create()
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual([
      'GetLinkedRepositoriesUser',
      'GetIssueNodeId',
      'GET /repos/acme/demo/git/ref/heads/main',
      'CreateLinkedBranch',
      'GetIssueProjectItems',
      'UpdateProjectItemField',
    ])
    expect(result.requests.at(3)).toMatchObject({ variables: { input: { issueId: 'I_7', oid: SHA, name: 'feat/7' } } })
  })

  it('--base を付けて打つと、そのブランチの先頭からブランチを作る', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-02')
    const result = await create({ github: succeeding('release') }, ['create-branch', 'acme/demo/7', 'feat', '--base', 'release'])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/release')
    expect(result.stderr).toContain('created: branch feat/7 in acme/demo from release\n')
  })

  it('--base を省いて打つと、設定ファイルの develop_branch の先頭からブランチを作る', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-03')
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] })
    const result = await create({ config, github: succeeding('develop') })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/develop')
    expect(result.stderr).toContain('created: branch feat/7 in acme/demo from develop\n')
  })

  it('--allow-cross-repo を付けて打つと、作業ディレクトリのリポジトリと Issue のリポジトリを比べずにブランチを作る', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-04')
    const result = await create({ remote: { owner: 'other', name: 'tree' } }, ['create-branch', 'acme/demo/7', 'feat', '--allow-cross-repo'])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(CREATED)
  })

  it('--force-overwrite-active を付けて打つと、.pecot-active の内容を確かめずに上書きする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-05')
    const result = await create({ files: { [ACTIVE]: 'acme/demo/999' } }, ['create-branch', 'acme/demo/7', 'feat', '--force-overwrite-active'])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).not.toContain('GetIssueSlim')
    expect(result.read(ACTIVE)).toBe('acme/demo/7')
  })

  it.for([{ flag: '--checkout' }, { flag: '--no-checkout' }])('$flag を付けて打つと、付けないときと同じ結果になる', async ({ flag }, context) => {
    await verifies(context, 'PW-CREATE-BRANCH-06')
    const plain = await create()
    const flagged = await create({}, ['create-branch', 'acme/demo/7', 'feat', flag])
    expect(flagged.code).toBe(plain.code)
    expect(flagged.stderr).toBe(plain.stderr)
    expect(flagged.requests).toEqual(plain.requests)
    expect(flagged.read(ACTIVE)).toBe(plain.read(ACTIVE))
  })

  it('ブランチを作ると、ボード上の Issue の Status を active にする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-07')
    const result = await create()
    expectClean(result)
    expect(result.requests.at(5)).toMatchObject({
      type: 'graphql',
      operation: 'UpdateProjectItemField',
      variables: { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' },
    })
  })

  it('ブランチを作ると、その Issue を作業対象として .pecot-active と .pecot-session-title に記録する', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-08')
    const result = await create()
    expect(result.read(ACTIVE)).toBe('acme/demo/7')
    expect(result.read(TITLE)).toBe('#7 見本の Issue')
    expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(true)
  })

  it('ブランチを作ると、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-09')
    const result = await create()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${CREATED}${STATUS_SET}${TARGET_SET}`)
  })

  it('Status を active にすると、set の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-10')
    const result = await create()
    expect(result.stderr).toContain(STATUS_SET)
  })

  it('作業対象を記録すると、set の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-11')
    const result = await create()
    expect(result.stderr).toContain(TARGET_SET)
  })

  it('.pecot-active の内容が不正な形だと、warning の行を標準エラーに出して上書きする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-12')
    await verifies(context, 'PW-CREATE-BRANCH-13')
    const result = await create({ files: { [ACTIVE]: 'garbage-value' } })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: the content of .pecot-active (\'garbage-value\') is malformed; overwriting it\n')
    expect(requestLabels(result.requests)).not.toContain('GetIssueSlim')
    expect(result.read(ACTIVE)).toBe('acme/demo/7')
  })

  it('.pecot-active の Issue が CLOSED だと、warning の行を標準エラーに出して上書きする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-14')
    await verifies(context, 'PW-CREATE-BRANCH-15')
    const result = await create({ files: { [ACTIVE]: 'acme/demo/999' }, github: [slimIssue('CLOSED'), ...succeeding()] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: .pecot-active points to closed Issue acme/demo/999; overwriting it\n')
    expect(result.read(ACTIVE)).toBe('acme/demo/7')
  })

  it('.pecot-active の Issue が OPEN でも CLOSED でもないときも、warning の行を標準エラーに出して上書きする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-14')
    await verifies(context, 'PW-CREATE-BRANCH-15')
    const result = await create({ files: { [ACTIVE]: 'acme/demo/999' }, github: [slimIssue('MERGED'), ...succeeding()] })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: the state of acme/demo/999 in .pecot-active is unexpected (\'MERGED\'); overwriting it\n')
    expect(result.read(ACTIVE)).toBe('acme/demo/7')
  })

  it('ボード上の Issue の Status を active にできないと、warning の行を標準エラーに出してブランチは作ったままにする', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-16')
    const failing: ResponseRule = { match: { operation: 'GetIssueProjectItems' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
    const result = await create({ github: [linkedRepositories(), issueNode(), baseSha('main'), linkedBranch(), failing] })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(CREATED)
    expect(result.stderr).toMatch(/warning: could not set Issue acme\/demo\/7 status active: .+\n/u)
    expect(result.stderr).not.toContain('set: Issue')
  })

  it('Issue がボードに載っていないと、Status を変えずに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-16')
    const empty = graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
    const result = await create({ github: [linkedRepositories(), issueNode(), baseSha('main'), linkedBranch(), empty] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: could not set Issue acme/demo/7 status active: the Issue is not on the project board\n')
  })

  it('設定に workflow の active が無いと、Status を変えずに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-16')
    const result = await create({ config: projectConfig({ workflowOptions: { backlog: 'o1' } }), github: [linkedRepositories(), issueNode(), baseSha('main'), linkedBranch(), projectItems()] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: could not set Issue acme/demo/7 status active: the workflow status field has no \'active\' option\n')
  })

  it('作業対象を記録できないと、warning の行を標準エラーに出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-17')
    // 状態ディレクトリの場所にファイルを置くと、書けない
    const result = await create({ files: { '.pecot/state': 'not a directory' } }, ['create-branch', 'acme/demo/7', 'feat', '--force-overwrite-active'])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(CREATED)
    expect(result.stderr).toMatch(/warning: could not record the work target: .+\n/u)
    expect(result.stderr).not.toContain('set: work target')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-18')
    const result = await create({ config: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: no active project\n  run: pecot project activate <PROJECT>\n')
    expect(result.requests).toEqual([])
  })

  it.for([
    { reference: '7', message: 'error: the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'\n' },
    { reference: 'invalid-format', message: 'error: invalid reference: invalid-format\n  accepted forms:\n    - full: \'owner/repo/N\'\n    - short: \'N\' (with a base repository)\n' },
  ])('Issue の参照が $reference でフル形式でないと、終了コード 2 で終わる', async ({ reference, message }, context) => {
    await verifies(context, 'PW-CREATE-BRANCH-19')
    const result = await create({ github: [] }, ['create-branch', reference, 'feat'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(message)
    expect(result.requests).toEqual([])
  })

  it('作業ディレクトリの git remote のリポジトリが Issue のリポジトリと違うと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-20')
    const result = await create({ remote: { owner: 'other', name: 'tree' }, github: [] })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe([
      'error: the repository of the work Issue (acme/demo) differs from the CWD git remote (other/tree)',
      '  move to the worktree of the target repository and run again:',
      '  <project-root>/base/demo/ or <project-root>/<wtN>/demo/',
      '  create one with /pecot-w:w-worktree-add only if the repository has no worktree',
      '  to issue the command on purpose from outside the CWD (for example in a script), give --allow-cross-repo',
      '',
    ].join('\n'))
    expect(result.requests).toEqual([])
  })

  it('.pecot-active に別の OPEN な Issue が残っていると、ブランチを作らず終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-21')
    const result = await create({ files: { [ACTIVE]: 'acme/demo/999' }, github: [slimIssue('OPEN')] })
    expect(result.code).toBe(2)
    expect(result.problems).toEqual([])
    expect(requestLabels(result.requests)).toEqual(['GetIssueSlim'])
    expect(result.stderr).toBe([
      'error: this worktree is already working on another Issue (acme/demo/999, OPEN)',
      '  overwriting .pecot-active could mix up the tasks',
      '  finish the other Issue first, or create another worktree with /pecot-w:w-worktree-add and run /pecot-w:w-active again in its session',
      '  if it is stale and you want to overwrite it on purpose, give --force-overwrite-active',
      '',
    ].join('\n'))
    expect(result.read(ACTIVE)).toBe('acme/demo/999')
  })

  it('--base を省いて develop_branch も設定していないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-22')
    const result = await create({ config: projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] }), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe([
      'error: develop_branch is not set for acme/demo',
      '  set it with: pecot project set-repo acme/demo --develop-branch develop',
      '  or give the base: pecot create-branch acme/demo/7 feat --base main',
      '',
    ].join('\n'))
    expect(result.requests).toEqual([])
  })

  it('Issue のリポジトリがプロジェクトに登録されていないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-23')
    const unlinked = graphqlRule('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [] } } } })
    const result = await create({ github: [unlinked] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toBe('error: acme/demo is not in the project\n')
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser'])
  })

  it('ブランチの作成までの GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-24')
    const notFound = restRule('GET', '/repos/acme/demo/git/ref/heads/main', 404, { message: 'Not Found' })
    const result = await create({ github: [linkedRepositories(), issueNode(), notFound] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toMatch(/^error: could not create branch feat\/7 in acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\/git\/ref\/heads\/main\n$/u)
    expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
    expect(result.read(ACTIVE)).toBeUndefined()
  })

  it('--repo が今の git remote のリポジトリと食い違うと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-25')
    const result = await create({ github: [] }, ['--repo', 'other/tree', 'create-branch', 'acme/demo/7', 'feat'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --repo other/tree differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
    expect(result.requests).toEqual([])
  })

  it('--repo を省いて git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-26')
    await verifies(context, 'PW-CREATE-BRANCH-27')
    const result = await create({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  give --repo <owner/repo>\n')
    expect(result.requests).toEqual([])
  })
})
