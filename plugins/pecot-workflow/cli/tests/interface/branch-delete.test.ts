// branch delete の振る舞い（PW-BRANCH-DELETE-*）を MCP のツールで確かめ、CLI の行と終了コードも runCli をプロセス内で呼んで確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { ambiguousFiles, AMBIGUOUS_MESSAGE, NO_ACTIVE_FILES, otherRepositoryConfig, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { projectConfig, requestLabels, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const REPO_PATH = '/repos/acme/demo'
const repository = (): ResponseRule => restRule('GET', REPO_PATH, 200, { default_branch: 'main' })
const removal = (status = 204, body?: unknown): ResponseRule => restRule('DELETE', `${REPO_PATH}/git/refs/heads/feat/7`, status, body)

const DELETED = 'deleted: remote branch feat/7 in acme/demo\n'

async function tool(arguments_: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}): Promise<Awaited<ReturnType<typeof runTool>>> {
  return await runTool({ tool: 'branch_delete', arguments: arguments_, github: [repository(), removal()], ...extra })
}

async function remove(extra: Partial<CommandRun> = {}, argv: readonly string[] = ['branch', 'delete', 'acme/demo', 'feat/7']): Promise<CommandResult> {
  return await runCommand({ argv, github: [repository(), removal()], ...extra })
}

describe('branch delete', () => {
  it('リポジトリとブランチ名を渡して打つと、そのリポジトリのリモートブランチを削除する', async () => {
    const result = await remove()
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  it('--dry-run を付けて打つと、何も削除しない', async () => {
    const result = await remove({ github: [repository()] }, ['branch', 'delete', 'acme/demo', 'feat/7', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async () => {
    const result = await remove()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(DELETED)
  })

  it('--dry-run を付けて打つと、dry-run の行を標準エラーに出す', async () => {
    const result = await remove({ github: [repository()] }, ['branch', 'delete', 'acme/demo', 'feat/7', '-n'])
    expect(result.stderr).toBe('dry-run: would delete remote branch feat/7 in acme/demo\n')
  })

  it('削除するブランチが既定ブランチ・develop_branch・release_branch のどれかなら、保護するブランチを並べた error の行を標準エラーに出して終了コード 1 で終わる', async () => {
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
    for (const branch of ['main', 'develop-aist', 'release-v1']) {
      const result = await remove({ config, github: [repository()] }, ['branch', 'delete', 'acme/demo', branch])
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toBe(`error: ${branch} is a protected branch\n  protected: develop-aist, main, release-v1\n`)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    }
  })

  it('repo_ref が owner/repo の形でないと、終了コード 2 で終わる', async () => {
    const result = await remove({ github: [] }, ['branch', 'delete', 'invalid-format', 'feat/7'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid owner/repo form')
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const result = await remove({ files: ambiguousFiles(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n`)
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    const result = await remove({ config: otherRepositoryConfig(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
    expect(result.requests).toEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で削除する', async () => {
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

  it('リポジトリの既定ブランチを読めないと、終了コード 1 で終わる', async () => {
    const result = await remove({ github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\n$/u)
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチの削除で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    const result = await remove({ github: [repository(), removal(422, { message: 'Validation Failed' })] })
    expect(result.code).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe('error: could not delete remote branch feat/7 in acme/demo: GitHub API error: 422\n')
  })

  it('git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async () => {
    const result = await remove({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  run inside a git repository that has a remote\n')
    expect(result.requests).toEqual([])
  })

  it('origin の URL が GitHub の形でなくても、引数のリポジトリのリモートブランチを削除する', async () => {
    const result = await remove({ remoteUrl: '/srv/git/demo.git' })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(DELETED)
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  describe('MCP の data', () => {
    const ARGUMENTS = { repo: 'acme/demo', branch: 'feat/7' }
    it('ブランチを削除すると、ブランチ・リポジトリ・deleted を data に返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-01')
      await verifies(context, 'PW-BRANCH-DELETE-04')
      const result = await tool(ARGUMENTS)
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
      expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
    })

    it('CLI で --dry-run を付けると、何も削除せず、削除する予定を dry-run の行に出して 0 で終わる', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-03')
      await verifies(context, 'PW-BRANCH-DELETE-06')
      const result = await remove({ github: [repository()] }, ['branch', 'delete', 'acme/demo', 'feat/7', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('dry-run: would delete remote branch feat/7 in acme/demo\n')
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    })

    it('本流のブランチの削除で失敗すると、deleted を返さない', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-15')
      const result = await tool(ARGUMENTS, { github: [repository(), removal(422, { message: 'Validation Failed' })] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'github-api', detail: 'could not delete remote branch feat/7 in acme/demo: GitHub API error: 422' })
    })

    it.for(['main', 'develop-aist', 'release-v1'])('保護するブランチ %s を渡すと、保護するブランチを並べた detail と kind が guard-blocked の失敗を返す', async (branch, context) => {
      await verifies(context, 'PW-BRANCH-DELETE-10')
      await verifies(context, 'PW-BRANCH-DELETE-11')
      const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
      const result = await tool({ repo: 'acme/demo', branch }, { config, github: [repository()] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'guard-blocked', detail: `${branch} is a protected branch\n  protected: develop-aist, main, release-v1` })
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    })

    it('repo が owner/repo の形でないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-12')
      const result = await tool({ repo: 'invalid-format', branch: 'feat/7' }, { github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
      expect(result.structured['detail']).toContain('invalid owner/repo form')
      expect(result.requests).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないと、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-13')
      const result = await tool(ARGUMENTS, { files: ambiguousFiles(), github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      expect(result.requests).toEqual([])
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-20')
      const result = await tool(ARGUMENTS, { config: otherRepositoryConfig(), github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で削除する', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-21')
      const result = await tool({ ...ARGUMENTS, project: SECOND_PROJECT }, { files: ambiguousFiles() })
      expect(result.problems).toEqual([])
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
    })

    it('リポジトリの既定ブランチを読めないと、失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-14')
      const result = await tool(ARGUMENTS, { github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo$/u)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    })

    it('git の外で呼ぶと、the repository is ambiguous の文と呼ぶ場所の案内を detail に入れ、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-17')
      await verifies(context, 'PW-BRANCH-DELETE-18')
      const result = await tool(ARGUMENTS, { remote: false, github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'git-unresolved', detail: 'the repository is ambiguous\n  run inside a git repository that has a remote' })
      expect(result.requests).toEqual([])
    })

    it('origin の URL が GitHub の形でなくても、引数のリポジトリのリモートブランチを削除する', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-19')
      const result = await tool(ARGUMENTS, { remoteUrl: '/srv/git/demo.git' })
      expect(result.problems).toEqual([])
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
      expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
    })
  })
})
