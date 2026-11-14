/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// session finish の振る舞い（PW-SESSION-FINISH-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { verifies } from '../_helpers/verifies.js'
import { graphql, issueKindData, openWorkspace, pullRequestData, rest, rule } from '../_helpers/workspace.js'
import type { PullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'

useIsolatedEnvironment()

const BRANCH = 'feat/demo/12'
const KIND_FAILURE = rule({ operation: 'GetIssueKind' }, { status: 500, body: { message: 'Server Error' } })
const KIND_WARNING_UNPROTECTED = /^warning: kind check of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; not protected\n/mu

function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

function restRequests(workspace: Readonly<Workspace>, method: string): unknown[] {
  return workspace.requests().filter(request => request.type === 'rest' && request.method === method)
}

function operationsOf(workspace: Readonly<Workspace>): string[] {
  return workspace.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

function stateFile(name: string): string {
  return `.pecot/state/${name}`
}

function filesOf(directory: string): string[] {
  const entries = readdirSync(directory, { recursive: true, encoding: 'utf8' })
  return entries
    .filter(relative => relative !== '.git' && !relative.startsWith('.git/'))
    .map((relative) => {
      const stat = lstatSync(path.join(directory, relative))
      return `${relative}:${String(stat.size)}:${String(stat.mtimeMs)}`
    })
}

const MERGED = 'GetPullRequestSlim'

function kindRule(number: number, options: Readonly<{ subIssues?: number, issueType?: string }> = {}): ReturnType<typeof graphql> {
  return graphql('GetIssueKind', issueKindData({ number, ...options }), { variables: { number } })
}

function closeRule(number: number, status = 200): ReturnType<typeof rest> {
  return rest('PATCH', `/repos/acme/demo/issues/${String(number)}`, status, status === 200 ? { number, state: 'closed' } : { message: 'Server Error' })
}

function deleteRule(branch: string, status = 204, message?: string): ReturnType<typeof rest> {
  return rest('DELETE', `/repos/acme/demo/git/refs/heads/${branch}`, status, message === undefined ? undefined : { message })
}

function mergedRules(sample: Readonly<PullRequestSample> = {}, extra: ResponseRuleList = [kindRule(12), closeRule(12)]): ResponseRuleList {
  return [graphql(MERGED, pullRequestData(sample)), ...extra]
}

const ALL_FLAGS = ['.pecot-active', '.pecot-base', '.pecot-session-title', '.pecot-quick-mode', '.wip-branch-linked', 'merge-slash-pending']

function flagFiles(): Record<string, string> {
  return Object.fromEntries(ALL_FLAGS.map(name => [stateFile(name), 'x\n']))
}

function currentBranch(workspace: Readonly<Workspace>, cwd?: string): string {
  return workspace.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
}

function hasBranch(workspace: Readonly<Workspace>): boolean {
  return workspace.git(['branch', '--list', BRANCH]).trim() !== ''
}

function cleanupBranch(extra: Readonly<WorkspaceOptions> = {}): Promise<Workspace> {
  return openWorkspace({
    branch: BRANCH,
    branches: [{ name: BRANCH, commits: [{ message: '未マージの変更', files: { 'feature.txt': 'x\n' } }] }],
    ...extra,
  })
}

const CLEANUP = ['session', 'finish', 'acme/demo/21']
// eslint-disable-next-line unicorn/no-null -- 応答の形（PR が無いと null）
const NO_PULL_REQUEST = { repository: { pullRequest: null } }

describe('session finish', () => {
  it('マージ済みの PR の参照を渡すと、closing issues・本文の Closes / Fixes / Resolves・head ブランチ名の末尾の番号の Issue を close する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-01')
    const github = mergedRules({ closing: [[10, 'closing']], body: 'Fixes #11\n\nResolves #13\n\nCloses #14\n' }, [10, 11, 12, 13, 14].flatMap(number => [kindRule(number), closeRule(number)]))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    const closed = restRequests(workspace, 'PATCH')
    expect(closed).toMatchObject([10, 11, 12, 13, 14].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it.for([
    { title: 'Issue Type が Epic', options: { issueType: 'Epic' } },
    { title: 'sub-issue を持つ Issue', options: { subIssues: 3 } },
  ])('次の Issue があると（$title）、その Issue を close しない', async (row, context) => {
    await verifies(context, 'PW-SESSION-FINISH-02')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [[10, 'epic']] }, [kindRule(10, row.options), kindRule(12), closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    expect(result.stderr).toContain('count: Issues to close: 1\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('Issue の種別を読めないと、warning の行を出して、その Issue を Epic として守らずに close する', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [KIND_FAILURE, closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(KIND_WARNING_UNPROTECTED)
    expect(result.stderr).toMatch(/\ncount: Issues to close: 1\nclosed: Issue #12\n$/u)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
  })

  it('Epic か sub-issue を持つ Issue があると、skipped の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-03')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { subIssues: 1 })]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it('--delete-branch を付けて打つと、リモートの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '--delete-branch', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }, { path: `/repos/acme/demo/git/refs/heads/wip/${BRANCH}` }])
  })

  it('リモートの head ブランチを削除すると、続けて wip/<head> を削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-05')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(lines(result.stderr).slice(-2)).toStrictEqual([`deleted: remote branch ${BRANCH}`, `deleted: remote branch wip/${BRANCH}`])
  })

  it('カレントのリポジトリが PR のリポジトリと同じで worktree の外だと、develop_branch のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('set: current branch to main\n')
    expect(currentBranch(workspace)).toBe('main')
  })

  it('カレントが worktree だと、置き場所の親ディレクトリの名前の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt1', branch: 'wt1-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt1', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('カレントが worktree で add の記録があると、記録の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt2', branch: 'wt2-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt2', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const record = workspace.git(['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name'], worktree).trim()
    writeFileSync(record, 'wt1\n')
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('ブランチを切り替えると、origin の remote（無ければ最初の remote）から develop_branch を pull する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-07')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    workspace.advanceRemote('main')
    expect(workspace.git(['rev-parse', 'main'])).not.toBe(workspace.remoteGit(['rev-parse', 'main']))
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('updated: main from upstream/main\n')
    expect(workspace.git(['rev-parse', 'main'])).toBe(workspace.remoteGit(['rev-parse', 'main']))
  })

  it('pull すると、ローカルの head ブランチを git branch -D で削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-08')
    const workspace = await cleanupBranch({ github: mergedRules() })
    expect(hasBranch(workspace)).toBe(true)
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain(`deleted: local branch ${BRANCH}\n`)
    expect(hasBranch(workspace)).toBe(false)
  })

  it('ローカルの片付けを終えると、フラグのファイルと merge-slash-pending を消す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-09')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true, true, true, true, true])
    await workspace.run(CLEANUP)
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([false, false, false, false, false, false])
  })

  it('--skip-local-cleanup を付けて打つと、ローカルの片付けをしない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-10')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(result.stderr).not.toContain('current branch')
  })

  it('--skip-local-cleanup を付けて打つと、フラグのファイルと merge-slash-pending を消さない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-11')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true, true, true, true, true])
  })

  it('--dry-run を付けて打つと、何も変えずに dry-run: would の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-12')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    const files = filesOf(workspace.directory)
    const result = await workspace.run([...CLEANUP, '--dry-run', '--delete-branch'])
    expect(lines(result.stderr)).toStrictEqual([
      'count: Issues to close: 1',
      'dry-run: would close Issue #12',
      `dry-run: would delete remote branch ${BRANCH}`,
      'dry-run: would set current branch to main',
      'dry-run: would update main from origin/main',
      `dry-run: would delete local branch ${BRANCH}`,
    ])
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
    expect(restRequests(workspace, 'DELETE')).toStrictEqual([])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('実行すると、close する Issue の件数を count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-13')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [[10, 'a']] }, [kindRule(10), closeRule(10), kindRule(12), closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr.startsWith('count: Issues to close: 2\n')).toBe(true)
  })

  it('Issue を close すると、closed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-14')
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 1\nclosed: Issue #12\n')
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-15')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチが既に無いと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-16')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH, 422, 'Reference does not exist'), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`unchanged: remote branch ${BRANCH} (already deleted)\n`)
  })

  it('ローカルの head ブランチが既に無いなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-17')
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`\\nwarning: deleting local branch ${BRANCH} failed: .*\\n$`, 'u'))
  })

  it('--delete-branch を付けてローカルの片付けも通すと、結果の行を実行した順で標準エラーへ出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    await verifies(context, 'PW-SESSION-FINISH-13')
    await verifies(context, 'PW-SESSION-FINISH-14')
    await verifies(context, 'PW-SESSION-FINISH-15')
    const workspace = await cleanupBranch({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.split('\n')).toStrictEqual([
      'count: Issues to close: 1',
      'closed: Issue #12',
      `deleted: remote branch ${BRANCH}`,
      `deleted: remote branch wip/${BRANCH}`,
      'set: current branch to main',
      'updated: main from origin/main',
      `deleted: local branch ${BRANCH}`,
      '',
    ])
  })

  it('origin の develop_branch が無く pull に失敗すると、warning の行を出したうえで、ローカルの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-17')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.remoteGit(['update-ref', '-d', 'refs/heads/main'])
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    const output = lines(result.stderr)
    expect(output.slice(0, 3)).toStrictEqual(['count: Issues to close: 1', 'closed: Issue #12', 'set: current branch to main'])
    const pulling = output.findIndex(line => line.startsWith('warning: pulling main failed: '))
    expect(pulling).toBe(3)
    expect(output.at(-1)).toBe(`deleted: local branch ${BRANCH}`)
    expect(hasBranch(workspace)).toBe(false)
    expect(result.stderr).not.toContain('updated:')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-18')
    const github = [graphql(MERGED, pullRequestData({ closing: [], body: '', head: 'feat/other' }))]
    const workspace = await cleanupBranch({ github })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup\n')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、ローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-19')
    const github = [graphql(MERGED, pullRequestData({ closing: [], body: '', head: BRANCH }))]
    const workspace = await cleanupBranch({ github })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.stderr).not.toContain('current branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
  })

  it('Issue の close に失敗したなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-20')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12, 500)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/\nwarning: closing Issue #12 failed: /u)
  })

  it('Issue の close に失敗したなら、ほかの Issue と後の処理を続ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-21')
    const github = mergedRules({ closing: [[10, 'a']] }, [kindRule(10), closeRule(10, 500), kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)])
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('closed: Issue #12\n')
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチの削除に失敗したなら、wip/<head> の削除を飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-22')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH, 403, 'Forbidden'), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch ${BRANCH} failed: `)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(1)
  })

  it('checkout に失敗したなら、pull と git branch -D を飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-23')
    const workspace = await cleanupBranch({ config: { developBranch: 'ghost' }, github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: checking out ghost failed: ')
    expect(result.stderr).not.toContain('updated:')
    expect(result.stderr).not.toContain('deleted: local branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
  })

  it('PR がマージされていないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-24')
    const workspace = await openWorkspace({ github: mergedRules({ state: 'OPEN' }) })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR #21 is not merged yet (state: OPEN); merge it with gh pr merge first\n' })
  })

  it('PR がマージされていないなら、何も変えない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-25')
    const workspace = await cleanupBranch({ github: mergedRules({ state: 'OPEN' }), files: flagFiles() })
    const files = filesOf(workspace.directory)
    await workspace.run([...CLEANUP, '-d'])
    expect(operationsOf(workspace)).toStrictEqual([MERGED])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('アクティブなプロジェクトが無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-26')
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it.for([
    { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'error: PR not found: acme/demo/21\n' },
    { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'error: GraphQL query error: ' },
  ])('次の場合は（$title）、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-SESSION-FINISH-27')
    const workspace = await openWorkspace({ github: row.rules })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(row.expected)).toBe(true)
  })

  it('PR の参照の形が誤っているなら、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-28')
    const workspace = await openWorkspace()
    const result = await workspace.run(['session', 'finish', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  it('wip/<head> のリモートブランチが無いなら、何も出さない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-29')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`, 422, 'Reference does not exist')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(2)
    expect(result.stderr).not.toContain('wip/')
  })

  it('wip/<head> があるのに削除できなかったなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-30')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`, 403, 'Forbidden')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch wip/${BRANCH} failed: `)
  })
})
