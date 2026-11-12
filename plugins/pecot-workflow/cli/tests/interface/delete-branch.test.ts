// delete-branch の振る舞い（PW-DELETE-BRANCH-01〜18）を、runCli をプロセス内で呼んで確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { projectConfig, requestLabels, restRule, runCommand } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const REPO_PATH = '/repos/acme/demo'
const repository = (): ResponseRule => restRule('GET', REPO_PATH, 200, { default_branch: 'main' })
const removal = (branch: string, status = 204, body?: unknown): ResponseRule => restRule('DELETE', `${REPO_PATH}/git/refs/heads/${branch}`, status, body)

const DELETED = 'deleted: remote branch feat/7 in acme/demo\n'

async function remove(extra: Partial<CommandRun> = {}, argv: readonly string[] = ['delete-branch', 'acme/demo', 'feat/7']): Promise<CommandResult> {
  return await runCommand({ argv, github: [repository(), removal('feat/7'), removal('wip/feat/7')], ...extra })
}

describe('delete-branch', () => {
  it('リポジトリとブランチ名を渡して打つと、そのリポジトリのリモートブランチを削除する', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-01')
    const result = await remove()
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  it('wip/ブランチ名 のリモートブランチがあると、それも削除する', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-02')
    const result = await remove()
    expect(requestLabels(result.requests)).toEqual([
      'GET /repos/acme/demo',
      'DELETE /repos/acme/demo/git/refs/heads/feat/7',
      'DELETE /repos/acme/demo/git/refs/heads/wip/feat/7',
    ])
  })

  it('--dry-run を付けて打つと、何も削除しない', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-03')
    const result = await remove({ github: [repository()] }, ['delete-branch', 'acme/demo', 'feat/7', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-04')
    const result = await remove()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(DELETED)
  })

  it('wip/ブランチ名 を削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-05')
    const result = await remove()
    expect(result.stderr).toBe(`${DELETED}deleted: remote branch wip/feat/7 in acme/demo\n`)
  })

  it('--dry-run を付けて打つと、dry-run の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-06')
    const result = await remove({ github: [repository()] }, ['delete-branch', 'acme/demo', 'feat/7', '-n'])
    expect(result.stderr).toBe('dry-run: would delete remote branch feat/7 in acme/demo\n')
  })

  it('wip/ブランチ名 のリモートブランチが無いと、何も出さない', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-07')
    const result = await remove({ github: [repository(), removal('feat/7'), removal('wip/feat/7', 422, { message: 'Reference does not exist' })] })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe(DELETED)
  })

  it('wip/ブランチ名 があるのに削除できないと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-08')
    await verifies(context, 'PW-DELETE-BRANCH-09')
    const result = await remove({ github: [repository(), removal('feat/7'), removal('wip/feat/7', 403, { message: 'Forbidden' })] })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe(`${DELETED}warning: could not delete remote branch wip/feat/7 in acme/demo: access denied Forbidden\n`)
  })

  it('wip/ブランチ名 の削除が 404 だと、本文の message を足した warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-08')
    const result = await remove({ github: [repository(), removal('feat/7'), removal('wip/feat/7', 404, { message: 'Not Found' })] })
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^deleted: remote branch feat\/7 in acme\/demo\nwarning: could not delete remote branch wip\/feat\/7 in acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\/git\/refs\/heads\/wip\/feat\/7 Not Found\n$/u)
  })

  it('削除するブランチが既定ブランチ・develop_branch・release_branch のどれかなら、保護するブランチを並べた error の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-10')
    await verifies(context, 'PW-DELETE-BRANCH-11')
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
    for (const branch of ['main', 'develop-aist', 'release-v1']) {
      const result = await remove({ config, github: [repository()] }, ['delete-branch', 'acme/demo', branch])
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toBe(`error: ${branch} is a protected branch\n  protected: develop-aist, main, release-v1\n`)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    }
  })

  it('repo_ref が owner/repo の形でないと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-12')
    const result = await remove({ github: [] }, ['delete-branch', 'invalid-format', 'feat/7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid owner/repo form')
    expect(result.requests).toEqual([])
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-13')
    const result = await remove({ config: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: no active project\n  run: pecot project activate <PROJECT>\n')
    expect(result.requests).toEqual([])
  })

  it('リポジトリの既定ブランチを読めないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-14')
    const result = await remove({ github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\n$/u)
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチの削除で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-15')
    const result = await remove({ github: [repository(), removal('feat/7', 422, { message: 'Validation Failed' })] })
    expect(result.code).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe('error: could not delete remote branch feat/7 in acme/demo: GitHub API error: 422\n')
    expect(requestLabels(result.requests)).not.toContain('DELETE /repos/acme/demo/git/refs/heads/wip/feat/7')
  })

  it('--repo が今の git remote のリポジトリと食い違うと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-16')
    const result = await remove({ github: [] }, ['--repo', 'other/tree', 'delete-branch', 'acme/demo', 'feat/7'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --repo other/tree differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
    expect(result.requests).toEqual([])
  })

  it('--repo を省いて git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DELETE-BRANCH-17')
    await verifies(context, 'PW-DELETE-BRANCH-18')
    const result = await remove({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  give --repo <owner/repo>\n')
    expect(result.requests).toEqual([])
  })
})
