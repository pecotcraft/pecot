// branch delete の振る舞い（PW-BRANCH-DELETE-01〜19）を、runCli をプロセス内で呼んで確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { ambiguousFiles, AMBIGUOUS_MESSAGE, NO_ACTIVE_FILES, otherRepositoryConfig, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { projectConfig, requestLabels, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const REPO_PATH = '/repos/acme/demo'
const repository = (): ResponseRule => restRule('GET', REPO_PATH, 200, { default_branch: 'main' })
const removal = (status = 204, body?: unknown): ResponseRule => restRule('DELETE', `${REPO_PATH}/git/refs/heads/feat/7`, status, body)

const DELETED = 'deleted: remote branch feat/7 in acme/demo\n'

async function remove(extra: Partial<CommandRun> = {}, argv: readonly string[] = ['branch', 'delete', 'acme/demo', 'feat/7']): Promise<CommandResult> {
  return await runCommand({ argv, github: [repository(), removal()], ...extra })
}

describe('branch delete', () => {
  it('リポジトリとブランチ名を渡して打つと、そのリポジトリのリモートブランチを削除する', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-01')
    const result = await remove()
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  it('--dry-run を付けて打つと、何も削除しない', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-03')
    const result = await remove({ github: [repository()] }, ['branch', 'delete', 'acme/demo', 'feat/7', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-04')
    const result = await remove()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(DELETED)
  })

  it('--dry-run を付けて打つと、dry-run の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-06')
    const result = await remove({ github: [repository()] }, ['branch', 'delete', 'acme/demo', 'feat/7', '-n'])
    expect(result.stderr).toBe('dry-run: would delete remote branch feat/7 in acme/demo\n')
  })

  it('削除するブランチが既定ブランチ・develop_branch・release_branch のどれかなら、保護するブランチを並べた error の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-10')
    await verifies(context, 'PW-BRANCH-DELETE-11')
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
    for (const branch of ['main', 'develop-aist', 'release-v1']) {
      const result = await remove({ config, github: [repository()] }, ['branch', 'delete', 'acme/demo', branch])
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toBe(`error: ${branch} is a protected branch\n  protected: develop-aist, main, release-v1\n`)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    }
  })

  it('repo_ref が owner/repo の形でないと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-12')
    const result = await remove({ github: [] }, ['branch', 'delete', 'invalid-format', 'feat/7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid owner/repo form')
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-13')
    const result = await remove({ files: ambiguousFiles(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n`)
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-20')
    const result = await remove({ config: otherRepositoryConfig(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
    expect(result.requests).toEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で削除する', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-21')
    const result = await remove({ files: ambiguousFiles() }, ['branch', 'delete', 'acme/demo', 'feat/7', '--project', SECOND_PROJECT])
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(DELETED)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で削除する', async () => {
    const result = await remove({ files: NO_ACTIVE_FILES })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(DELETED)
  })

  it('リポジトリの既定ブランチを読めないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-14')
    const result = await remove({ github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\n$/u)
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチの削除で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-15')
    const result = await remove({ github: [repository(), removal(422, { message: 'Validation Failed' })] })
    expect(result.code).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe('error: could not delete remote branch feat/7 in acme/demo: GitHub API error: 422\n')
  })

  it('git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-17')
    await verifies(context, 'PW-BRANCH-DELETE-18')
    const result = await remove({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  run inside a git repository that has a remote\n')
    expect(result.requests).toEqual([])
  })

  it('origin の URL が GitHub の形でなくても、引数のリポジトリのリモートブランチを削除する', async (context) => {
    await verifies(context, 'PW-BRANCH-DELETE-19')
    const result = await remove({ remoteUrl: '/srv/git/demo.git' })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(DELETED)
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  describe('MCP の data', () => {
    const ARGUMENTS = { repo: 'acme/demo', branch: 'feat/7' }

    it('ブランチを削除すると、ブランチ・リポジトリ・deleted を data に返す', async () => {
      const result = await runTool({ tool: 'branch_delete', arguments: ARGUMENTS, github: [repository(), removal()] })
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
    })

    it('dry_run で打つと、deleted を false にして dryRun を返す', async () => {
      const result = await runTool({ tool: 'branch_delete', arguments: { ...ARGUMENTS, dry_run: true }, github: [repository()] })
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: false, dryRun: true })
    })

    it('本流のブランチの削除で失敗すると、deleted を返さない', async () => {
      const result = await runTool({ tool: 'branch_delete', arguments: ARGUMENTS, github: [repository(), removal(422, { message: 'Validation Failed' })] })
      expect(result.isError).toBe(true)
      expect(result.structured).not.toHaveProperty('deleted')
    })
  })
})
