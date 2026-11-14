/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_QUICK_COMMANDS } from '../../src/commands/issue-quick.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import {
  addedToProject,
  BRANCH_SHA,
  createdIssue,
  developBranchHead,
  failedAddToProject,
  failedIssueCreation,
  failedSubIssue,
  issueNodeId,
  ISSUE_URL_BASE,
  linkedBranchCreated,
  linkedRepositories,
  missingDevelopBranch,
  parentEpic,
  setUpIssueProject,
  subIssueAdded,
  updatedFields,
} from '../_helpers/issue-create-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const PENDING_FLAGS = { '.pecot/state/issue-pending': '1\n', '.pecot/state/issue-create-slash-pending': '1\n' }
const MESSAGE = '一覧の状態列を直す'

async function quick(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'quick', ...argv], ISSUE_QUICK_COMMANDS)
}

function hasFile(root: string, relative: string): boolean {
  return existsSync(path.join(root, relative))
}

describe('issue quick', () => {
  it('メッセージとリポジトリを渡すと、起票からブランチの作成までを行って URL を出す', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-01')
    await verifies(context, 'PW-ISSUE-QUICK-03')
    await verifies(context, 'PW-ISSUE-QUICK-04')
    await verifies(context, 'PW-ISSUE-QUICK-07')
    await verifies(context, 'PW-ISSUE-QUICK-08')
    await verifies(context, 'PW-ISSUE-QUICK-09')
    await verifies(context, 'PW-ISSUE-QUICK-12')
    await verifies(context, 'PW-ISSUE-QUICK-13')
    await verifies(context, 'PW-ISSUE-QUICK-14')
    await verifies(context, 'PW-ISSUE-QUICK-15')
    await verifies(context, 'PW-ISSUE-QUICK-16')
    await verifies(context, 'PW-ISSUE-QUICK-17')
    const project = setUpIssueProject({ files: PENDING_FLAGS })
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3), developBranchHead(), linkedBranchCreated(12)])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe(
      'created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status active, priority medium, size s\n'
      + 'created: branch feat/20260101-000000/12 in acme/demo\nset: work target acme/demo/12 (work directory .pecot/work/12/)\n',
    )
    const requests = github.requests()
    const fieldOptions = requests.filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField').map(request => request.type === 'graphql' ? request.variables : undefined)
    expect(fieldOptions).toMatchObject([{ optionId: 'o4' }, { optionId: 'p2' }, { optionId: 's2' }])
    const branch = requests.find(request => request.type === 'graphql' && request.operation === 'CreateLinkedBranch')
    expect(branch).toMatchObject({ variables: { input: { issueId: 'I_kwDO12', oid: BRANCH_SHA } } })
    const branchName = branch?.type === 'graphql' ? JSON.stringify(branch.variables) : ''
    expect(branchName).toMatch(/"name":"feat\/\d{8}-\d{6}\/12"/u)
    expect(readFileSync(path.join(project.root, '.pecot/state/.pecot-active'), 'utf8')).toBe('acme/demo/12')
    expect(hasFile(project.root, '.pecot/work/12')).toBe(true)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(true)
    expect(hasFile(project.root, '.pecot/state/issue-pending')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/issue-create-slash-pending')).toBe(false)
  })

  it('長いメッセージを渡すと、先頭 50 文字の連続する空白を 1 つにしたものを type の接頭辞つきのタイトルにする', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-02')
    setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])
    const message = `先頭の   行\n次の行 ${'あ'.repeat(60)}`

    const result = await quick('-m', message, '-r', 'acme/demo', '--no-branch')

    expect(result.code).toBe(0)
    const post = github.requests().find(request => request.type === 'rest')
    const expectedTitle = `[Task] 先頭の 行 次の行 ${'あ'.repeat(50 - '先頭の   行\n次の行 '.length)}`
    expect(post).toMatchObject({ body: { title: expectedTitle } })
    const sent = post?.type === 'rest' ? JSON.stringify(post.body) : ''
    expect(sent).toContain(String.raw`先頭の   行\n次の行 ${'あ'.repeat(60)}\n\n<!-- pecot issue quick で起票`)
  })

  it('Epic に --parent-epic を付けると、warning の行を出して親につなぎ、欄は backlog と medium だけで size を付けず、quick のフラグを作らない', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-05')
    await verifies(context, 'PW-ISSUE-QUICK-06')
    await verifies(context, 'PW-ISSUE-QUICK-04')
    await verifies(context, 'PW-ISSUE-QUICK-12')
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(2), issueNodeId(3), subIssueAdded()])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--type', 'epic', '--parent-epic', '3', '--no-branch')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toBe(
      'created: Issue acme/demo/12\nadded: Issue acme/demo/12 to project\nset: Issue acme/demo/12 status backlog, priority medium\n'
      + 'warning: giving a parent Epic to an Epic is not recommended\nadded: Issue acme/demo/12 as sub-issue of acme/demo/3\n'
      + 'set: work target acme/demo/12 (work directory .pecot/work/12/)\n',
    )
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
  })

  it('--no-branch を付けると、ブランチを作らずに作業対象を書き、作業ディレクトリを作る', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-10')
    await verifies(context, 'PW-ISSUE-QUICK-11')
    const project = setUpIssueProject()
    const github = await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--no-branch')

    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/\nset: work target acme\/demo\/12 \(work directory \.pecot\/work\/12\/\)\n$/u)
    expect(readFileSync(path.join(project.root, '.pecot/state/.pecot-active'), 'utf8')).toBe('acme/demo/12')
    expect(hasFile(project.root, '.pecot/work/12')).toBe(true)
    expect(github.requests().some(request => request.type === 'rest' && request.method === 'GET')).toBe(false)
  })

  it('前の作業対象の .pecot-base が残っていても、--no-branch で作業対象を替えると消す', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-36')
    const project = setUpIssueProject({ files: { '.pecot/state/.pecot-base': `feat/3 ${'0'.repeat(40)} acme/demo#3` } })
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--no-branch')

    expect(result.code).toBe(0)
    expect(hasFile(project.root, '.pecot/state/.pecot-base')).toBe(false)
  })

  it('ボードへの追加に失敗したとき、warning の行と Issue の URL を出し、欄の設定とブランチの作成をしない', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-18')
    await verifies(context, 'PW-ISSUE-QUICK-19')
    await verifies(context, 'PW-ISSUE-QUICK-20')
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), failedAddToProject()])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/^created: Issue acme\/demo\/12\nwarning: could not add Issue acme\/demo\/12 to project: .+\n$/u)
    expect(hasFile(project.root, '.pecot/state/.pecot-active')).toBe(false)
  })

  it('親 Epic へのつなぎに失敗したとき、Issue の URL を標準出力に出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-21')
    await verifies(context, 'PW-ISSUE-QUICK-22')
    setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3), issueNodeId(3), failedSubIssue()])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--parent-epic', '3')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/\nerror: could not add Issue acme\/demo\/12 as sub-issue of acme\/demo\/3: .+\n {2}the order in its title is not counted for the next numbering until it is linked to the parent; link it by hand\n$/u)
  })

  it('develop_branch が設定に無いとき、error の行を出して終了コード 1 で終わり、URL とフラグを出さない', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-23')
    await verifies(context, 'PW-ISSUE-QUICK-24')
    await verifies(context, 'PW-ISSUE-QUICK-25')
    const project = setUpIssueProject({ developBranch: undefined })
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3)])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/\nerror: develop_branch is not set for repository acme\/demo\n {2}set it with: pecot repo set acme\/demo --develop-branch develop\n {2}\(or --develop-branch develop-aist \/ --develop-branch main\)\n$/u)
    expect(hasFile(project.root, '.pecot/state/.pecot-active')).toBe(false)
    expect(hasFile(project.root, '.pecot/state/.pecot-quick-mode')).toBe(false)
  })

  it('ブランチの作成が API で失敗したとき、warning の行を出して終了コード 0 で終わり、作業対象を書かない', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-26')
    await verifies(context, 'PW-ISSUE-QUICK-27')
    const project = setUpIssueProject()
    await startGithub([linkedRepositories(), createdIssue(12), addedToProject(), updatedFields(3), missingDevelopBranch()])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${ISSUE_URL_BASE}/12\n`)
    expect(result.stderr).toMatch(/\nwarning: could not create the branch: .+\n {2}create the branch manually\n$/u)
    expect(hasFile(project.root, '.pecot/state/.pecot-active')).toBe(false)
  })

  it('メッセージが空白だけのとき、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-28')
    setUpIssueProject()

    const result = await quick('-m', '  \n ', '-r', 'acme/demo')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: the message is empty\n' })
  })

  it('リポジトリが owner/repo の形でないとき、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-29')
    setUpIssueProject()

    const result = await quick('-m', MESSAGE, '-r', 'acme')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: invalid repository format: acme\n  expected: owner/repo\n' })
  })

  it('アクティブなプロジェクトが無いとき、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-30')
    setUpIssueProject({ files: { '.pecot/config/projects/.active': '' } })

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('リポジトリがプロジェクトにつながっていないとき、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-31')
    setUpIssueProject()
    await startGithub([linkedRepositories(1, [])])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not linked to the project\n' })
  })

  it('同じ親 Epic に同じ order の Issue があるとき、作らずに error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-32')
    setUpIssueProject()
    await startGithub([linkedRepositories(), parentEpic(3, [{ number: 9, state: 'OPEN', title: '#3-02: 先の子' }])])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--parent-epic', '3', '--order', '2')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: Epic #3 already has an Issue with order=2 (OPEN)\n  #9 #3-02: 先の子\n  next available order: 3\n')
  })

  it('GitHub API がエラーを返したとき、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-33')
    setUpIssueProject()
    await startGithub([linkedRepositories(), failedIssueCreation(403)])

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not create an Issue in acme\/demo: .+\n$/u)
  })

  it('--parent-epic の形が誤っているとき、使い方のエラーを出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-QUICK-34')
    setUpIssueProject()

    const result = await quick('-m', MESSAGE, '-r', 'acme/demo', '--parent-epic', 'abc')

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^Usage: pecot issue quick \[OPTIONS\]\n/u)
    expect(result.stderr).toContain('Invalid value: could not resolve parent_epic')
  })

  it.for([
    { id: 'PW-ISSUE-QUICK-35', name: '-m', argv: ['-r', 'acme/demo'], missing: 'Missing option \'--message\' / \'-m\'.' },
    { id: 'PW-ISSUE-QUICK-35', name: '-r', argv: ['-m', MESSAGE], missing: 'Missing option \'--repo\' / \'-r\'.' },
  ])('$name を省いたとき、使い方のエラーを出して終了コード 2 で終わる', async (row, context) => {
    await verifies(context, row.id)
    setUpIssueProject()

    const result = await quick(...row.argv)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^Usage: pecot issue quick \[OPTIONS\]\n/u)
    expect(result.stderr).toContain(row.missing)
  })
})
