/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時リポ配下だけ */
// create-branch の振る舞い（PW-CREATE-BRANCH-01〜27）を、runCli をプロセス内で呼んで確かめる。
// 一時 git リポ・設定ファイル・偽の GitHub サーバの上で動かし、受けた要求と終わった後のファイルを比べる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { TargetSpec } from '../_helpers/prerequisites.js'
import { graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

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
// 積む先のブランチ（main 以外で、feat/ で始まるもの）には、別の SHA を返す
const baseSha = (branch: string): ResponseRule => restRule('GET', `/repos/acme/demo/git/ref/heads/${branch}`, 200, { object: { sha: branch.startsWith('feat/') ? STACK_SHA : SHA } })
const linkedBranch = (): ResponseRule => graphqlRule('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/7', prefix: 'refs/heads/' } } } })
const projectItems = (): ResponseRule => graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_7', project: { id: 'PVT_1' } }] } } } }, { owner: 'acme', repo: 'demo', number: 7 })
const statusUpdate = (): ResponseRule => graphqlRule(
  'UpdateProjectItemField',
  { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } },
  { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId: 'o4' },
)
const noPrerequisites = (): ResponseRule => prerequisitesRule({ number: 7 })
const slimIssue = (state: string): ResponseRule => graphqlRule(
  'GetIssueSlim',
  { repository: { issue: { number: 999, state, title: 't', body: 'b', comments: { totalCount: 0 } } } },
  { owner: 'acme', repo: 'demo', number: 999 },
)

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
      'GetIssuePrerequisites',
      'GetIssueNodeId',
      'GET /repos/acme/demo/git/ref/heads/main',
      'CreateLinkedBranch',
      'GetIssueProjectItems',
      'UpdateProjectItemField',
    ])
    expect(result.requests.at(4)).toMatchObject({ variables: { input: { issueId: 'I_7', oid: SHA, name: 'feat/7' } } })
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
    expect(result.requests.at(6)).toMatchObject({
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
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), failing] })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(CREATED)
    expect(result.stderr).toMatch(/warning: could not set Issue acme\/demo\/7 status active: .+\n/u)
    expect(result.stderr).not.toContain('set: Issue')
  })

  it('Issue がボードに載っていないと、Status を変えずに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-16')
    const empty = graphqlRule('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), empty] })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain('warning: could not set Issue acme/demo/7 status active: the Issue is not on the project board\n')
  })

  it('設定に workflow の active が無いと、Status を変えずに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-16')
    const result = await create({ config: projectConfig({ workflowOptions: { backlog: 'o1' } }), github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), linkedBranch(), projectItems()] })
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
    const result = await create({ config: projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] }), github: [linkedRepositories(), noPrerequisites()] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toBe([
      'error: develop_branch is not set for acme/demo',
      '  set it with: pecot project set-repo acme/demo --develop-branch develop',
      '  or give the base: pecot create-branch acme/demo/7 feat --base main',
      '',
    ].join('\n'))
    expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssuePrerequisites'])
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
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), notFound] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toMatch(/^error: could not create branch feat\/7 in acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\/git\/ref\/heads\/main\n$/u)
    expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
    expect(result.read(ACTIVE)).toBeUndefined()
  })

  it('ブランチの作成の mutation が GraphQL の errors を返すと、ステータスの更新へ進まず終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-CREATE-BRANCH-24')
    const rejected: ResponseRule = { match: { operation: 'CreateLinkedBranch' }, respond: { status: 200, body: { errors: [{ type: 'UNPROCESSABLE', message: 'Ref already exists' }] } }, times: 1 }
    const result = await create({ github: [linkedRepositories(), noPrerequisites(), issueNode(), baseSha('main'), rejected] })
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not create branch feat\/7 in acme\/demo: .*Ref already exists/u)
    expect(requestLabels(result.requests)).not.toContain('GetIssueProjectItems')
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
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
  describe('着手の判定', () => {
    const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
    const waiting = { number: 4, title: '待つ前提' }
    const WAITS = '## Waits for merge\n- #4: 公開後に確かめる\n'
    const STACKED = 'created: branch feat/7 in acme/demo from feat/3 (stacked on #3)\n'

    it('前提の PR が 1 本に積めると、その PR のブランチの先頭からブランチを作り、created の行に積んだ先を付ける', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-28')
      await verifies(context, 'PW-CREATE-BRANCH-29')
      const result = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(requestLabels(result.requests)).toContain('GET /repos/acme/demo/git/ref/heads/feat/3')
      expect(result.stderr).toBe(`${STACKED}${STATUS_SET}${TARGET_SET}`)
      expect(requestLabels(result.requests)).toContain('CreateLinkedBranch')
      expect(result.requests.find(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')).toMatchObject({ variables: { input: { issueId: 'I_7', oid: STACK_SHA, name: 'feat/7' } } })
    })

    it('ブランチを作ると、選んだ base を .pecot-base に書く（積んだときは積んだ先の Issue も）', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-30')
      const stacked = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') })
      expect(stacked.read(BASE)).toBe(`feat/3 ${STACK_SHA} acme/demo#3`)
      const plain = await create({ files: { [BASE]: `release ${SHA} acme/demo#1` } })
      expect(plain.read(BASE)).toBe(`main ${SHA}`)
    })

    it('積む先と同じ --base を付けると、そのまま積んで作る', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-28')
      const result = await create({ github: judged({ blockedBy: [inReview] }, 'feat/3') }, ['create-branch', 'acme/demo/7', 'feat', '--base', 'feat/3'])
      expect(result.code).toBe(0)
      expect(result.stderr).toContain(STACKED)
    })

    it('積む先と違う --base を付けると、ブランチを作らず終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-33')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] })] }, ['create-branch', 'acme/demo/7', 'feat', '--base', 'release'])
      expect(result.code).toBe(2)
      expectClean(result)
      expect(result.stderr).toBe('error: --base release differs from the base chosen by readiness: feat/3 (stacked on #3)\n')
      expect(result.read(ACTIVE)).toBeUndefined()
      expect(result.read(BASE)).toBeUndefined()
    })

    it('前提が 2 件で、1 件が merge 待ちなら、ブランチを作らず理由と直し方を出して終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-31')
      await verifies(context, 'PW-CREATE-BRANCH-32')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview, waiting], body: WAITS })] })
      expect(result.code).toBe(2)
      expectClean(result)
      expect(requestLabels(result.requests)).toEqual(['GetLinkedRepositoriesUser', 'GetIssuePrerequisites'])
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3, #4 (waits for merge)',
        '  - #3: in review',
        '  - #4: wait: merge — 公開後に確かめる',
        '  to remove the prerequisite: pecot issue unblock acme/demo/7 --by acme/demo/3',
        '  to remove the prerequisite: pecot issue unblock acme/demo/7 --by acme/demo/4',
        '  to stack on it instead of waiting for merge: pecot issue block acme/demo/7 --by acme/demo/4 --wait stack',
        '',
      ].join('\n'))
      expect(result.read(ACTIVE)).toBeUndefined()
    })

    it('済んでいない前提が 1 件で merge 待ちなら、直し方にその Issue の参照を入れる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-31')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [waiting], body: WAITS })] })
      expect(result.code).toBe(2)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #4 (waits for merge)',
        '  - #4: wait: merge — 公開後に確かめる',
        '  to remove the prerequisite: pecot issue unblock acme/demo/7 --by acme/demo/4',
        '  to stack on it instead of waiting for merge: pecot issue block acme/demo/7 --by acme/demo/4 --wait stack',
        '',
      ].join('\n'))
    })

    it('merge 待ち以外の理由で blocked なら、直し方は unblock の 1 行だけにする', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-31')
      await verifies(context, 'PW-CREATE-BRANCH-32')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, title: '未着手' }] })] })
      expect(result.code).toBe(2)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3 (not in review: #3 (not started))',
        '  - #3: not started',
        '  to remove the prerequisite: pecot issue unblock acme/demo/7 --by acme/demo/3',
        '',
      ].join('\n'))
    })

    it('blocked のときは、--base を付けても比べずに blocked で止まる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-32')
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [waiting], body: WAITS })] }, ['create-branch', 'acme/demo/7', 'feat', '--base', 'release'])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('error: #7 is blocked by #4')
    })

    it('前提を読めないと、ブランチを作らず終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-34')
      const failing: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      const result = await create({ github: [linkedRepositories(), failing] })
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toMatch(/^error: could not read blocked-by of #7: .+500/u)
      expect(result.read(ACTIVE)).toBeUndefined()
    })

    it('前提は読めても判定できないと、判定できない旨の error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-34')
      const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo' }] })
      const result = await create({ config, github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] })] }, ['create-branch', 'acme/demo/7', 'feat', '--base', 'main'])
      expect(result.code).toBe(1)
      expectClean(result)
      expect(result.stderr).toBe([
        'error: could not judge readiness of #7: develop_branch is not set for acme/demo',
        '  set it with: pecot project set-repo acme/demo --develop-branch develop',
        '',
      ].join('\n'))
    })

    it('Epic は判定を持たないので、今までどおり開発ブランチから作る', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-03')
      const result = await create({ github: judged({ issueType: 'Epic' }) })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toBe(`${CREATED}${STATUS_SET}${TARGET_SET}`)
    })

    it('依存関係に対応しない GHES では、判定を省いた旨の warning を出して、今までどおり開発ブランチから作る', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-03')
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const result = await create({ github: [linkedRepositories(), unsupported, issueNode(), baseSha('main'), linkedBranch(), projectItems(), statusUpdate()] })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toBe(`warning: readiness is not checked: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n${CREATED}${STATUS_SET}${TARGET_SET}`)
    })

    it('積む先のブランチが判定の後に無くなると、積む先が見つからない旨の error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-35')
      const gone = restRule('GET', '/repos/acme/demo/git/ref/heads/feat/3', 404, { message: 'Not Found' })
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [inReview] }), issueNode(), gone] })
      expect(result.code).toBe(1)
      expectClean(result)
      expect(result.stderr).toMatch(/^error: base branch feat\/3 of #3 not found: resource not found: .+\n$/u)
      expect(requestLabels(result.requests)).not.toContain('CreateLinkedBranch')
      expect(result.read(ACTIVE)).toBeUndefined()
    })

    it('blocked の理由が diverged なら、直し方は unblock の行だけにする', async (context) => {
      await verifies(context, 'PW-CREATE-BRANCH-32')
      const diverged = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3', base: 'feat/2' }] }
      const noPullRequests = graphqlRule('ListPullRequestsByHead', { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } })
      const result = await create({ github: [linkedRepositories(), prerequisitesRule({ number: 7, blockedBy: [diverged] }), noPullRequests] })
      expect(result.code).toBe(2)
      expectClean(result)
      expect(result.stderr).toBe([
        'error: #7 is blocked by #3 (not in one chain)',
        '  - #3: in review',
        '  to remove the prerequisite: pecot issue unblock acme/demo/7 --by acme/demo/3',
        '',
      ].join('\n'))
    })
  })
})
