// branch_delete の振る舞い（PW-BRANCH-DELETE-*）を、MCP のツールと、プロセス内で呼んだツールの行と終了コードで確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../_helpers/explains.js'
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

const REMOVE_ARGUMENTS = { repo: 'acme/demo', branch: 'feat/7' }

async function remove(extra: Partial<CommandRun> = {}, arguments_: Readonly<Record<string, unknown>> = REMOVE_ARGUMENTS): Promise<CommandResult> {
  return await runCommand({ tool: 'branch_delete', arguments: arguments_, github: [repository(), removal()], ...extra })
}

describe('branch_delete', () => {
  it('リポジトリとブランチ名を渡して打つと、そのリポジトリのリモートブランチを削除する', async () => {
    await explains('`branch_delete` の基本の動作のテストです。リポジトリとブランチ名を渡した場合に、そのリポジトリのリモートブランチを GitHub API で削除することを確認します。')
    const result = await remove()
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
    expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async () => {
    await explains('`branch_delete` の出力のテストです。ブランチを削除した場合に、`deleted` の行を標準エラーに出力し、標準出力には何も出力しないことを確認します。')
    const result = await remove()
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(DELETED)
  })

  it('削除するブランチが既定ブランチ・develop_branch・release_branch のどれかなら、保護するブランチを並べた error の行を標準エラーに出して終了コード 1 で終わる', async () => {
    await explains('`branch_delete` の保護するブランチのテストです。削除するブランチが既定ブランチ・`develop_branch`・`release_branch` のいずれかの場合に、保護するブランチを並べたエラーを出力して終了コード 1 で終わることを確認します。')
    const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
    for (const branch of ['main', 'develop-aist', 'release-v1']) {
      const result = await remove({ config, github: [repository()] }, { repo: 'acme/demo', branch: branch })
      expect(result.code).toBe(1)
      expect(result.problems).toEqual([])
      expect(result.stderr).toBe(`error: ${branch} is a protected branch\n  protected: develop-aist, main, release-v1\n`)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    }
  })

  it('repo_ref が owner/repo の形でないと、終了コード 2 で終わる', async () => {
    await explains('`branch_delete` の引数を検証するテストです。`repo_ref` が `owner/repo` の形でない場合に、GitHub へ何も要求せず、終了コード 2 で終わることを確認します。')
    const result = await remove({ github: [] }, { repo: 'invalid-format', branch: 'feat/7' })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid owner/repo form')
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`branch_delete` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const result = await remove({ files: ambiguousFiles(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n`)
    expect(result.requests).toEqual([])
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    await explains('`branch_delete` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合に、エラーと選べる設定の一覧を出力して終了コード 1 で終わることを確認します。')
    const result = await remove({ config: otherRepositoryConfig(), github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
    expect(result.requests).toEqual([])
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で削除する', async () => {
    await explains('`branch_delete` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定でブランチを削除することを確認します。')
    const result = await remove({ files: ambiguousFiles() }, { repo: 'acme/demo', branch: 'feat/7', project: SECOND_PROJECT })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stderr).toContain(DELETED)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で削除する', async () => {
    await explains('`branch_delete` のプロジェクトの設定の選択のテストです。`.active` が存在しなくても、対象のリポジトリを含む設定が 1 つであれば、その設定でブランチを削除することを確認します。')
    const result = await remove({ files: NO_ACTIVE_FILES })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(DELETED)
  })

  it('リポジトリの既定ブランチを読めないと、終了コード 1 で終わる', async () => {
    await explains('`branch_delete` の既定ブランチの取得のテストです。GitHub API が 404 を返した場合に、`could not read the default branch` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await remove({ github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo\n$/u)
    expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
  })

  it('ブランチの削除で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    await explains('`branch_delete` の GitHub API のエラーのテストです。ブランチの削除が 422 で失敗した場合に、`could not delete remote branch` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await remove({ github: [repository(), removal(422, { message: 'Validation Failed' })] })
    expect(result.code).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.stderr).toBe('error: could not delete remote branch feat/7 in acme/demo: GitHub API error: 422\n')
  })

  it('git の外で打つと、the repository is ambiguous の行を標準エラーに出して終了コード 1 で終わる', async () => {
    await explains('`branch_delete` の実行場所のテストです。git リポジトリの外で実行した場合に、`the repository is ambiguous` のエラーを出力して終了コード 1 で終わり、GitHub へは要求しないことを確認します。')
    const result = await remove({ remote: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: the repository is ambiguous\n  run inside a git repository that has a remote\n')
    expect(result.requests).toEqual([])
  })

  it('origin の URL が GitHub の形でなくても、引数のリポジトリのリモートブランチを削除する', async () => {
    await explains('`branch_delete` の `origin` の URL のテストです。URL が GitHub の形式でない場合でも、引数で渡したリポジトリのリモートブランチを削除することを確認します。')
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
      await explains('MCP ツール `branch_delete` の結果のテストです。ブランチを削除した場合に、`branch`・`repository`・`deleted` を返すことを確認します。')
      const result = await tool(ARGUMENTS)
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
      expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
    })

    it('ブランチの削除で GitHub API がエラーを返すと、deleted を返さず、kind が github-api の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-15')
      await explains('MCP ツール `branch_delete` の GitHub API のエラーのテストです。ブランチの削除が 422 で失敗した場合に、`deleted` を返さず、`kind` が `github-api` の失敗を返すことを確認します。')
      const result = await tool(ARGUMENTS, { github: [repository(), removal(422, { message: 'Validation Failed' })] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'github-api', detail: 'could not delete remote branch feat/7 in acme/demo: GitHub API error: 422' })
    })

    it.for(['main', 'develop-aist', 'release-v1'])('保護するブランチ %s を渡すと、保護するブランチを並べた detail と kind が guard-blocked の失敗を返す', async (branch, context) => {
      await verifies(context, 'PW-BRANCH-DELETE-10')
      await verifies(context, 'PW-BRANCH-DELETE-11')
      await explains('MCP ツール `branch_delete` の保護するブランチのテストです。既定ブランチなど保護するブランチを渡した場合に、保護するブランチを並べた `detail` と、`kind` が `guard-blocked` の失敗を返すことを確認します。')
      const config = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop-aist', release_branch: 'release-v1' }] })
      const result = await tool({ repo: 'acme/demo', branch }, { config, github: [repository()] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'guard-blocked', detail: `${branch} is a protected branch\n  protected: develop-aist, main, release-v1` })
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    })

    it('repo が owner/repo の形でないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-12')
      await explains('MCP ツール `branch_delete` の引数を検証するテストです。`repo` が `owner/repo` の形でない場合に、`kind` が `invalid-input` の失敗を返し、GitHub へは要求しないことを確認します。')
      const result = await tool({ repo: 'invalid-format', branch: 'feat/7' }, { github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
      expect(result.structured['detail']).toContain('invalid owner/repo form')
      expect(result.requests).toEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないと、kind が no-active-project の失敗に候補と project の案内を入れる', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-13')
      await explains('MCP ツール `branch_delete` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、`kind` が `no-active-project` の失敗を返し、`detail` に候補と案内を入れることを確認します。')
      const result = await tool(ARGUMENTS, { files: ambiguousFiles(), github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      expect(result.requests).toEqual([])
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-20')
      await explains('MCP ツール `branch_delete` のプロジェクトの設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      const result = await tool(ARGUMENTS, { config: otherRepositoryConfig(), github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で削除する', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-21')
      await explains('MCP ツール `branch_delete` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定でブランチを削除することを確認します。')
      const result = await tool({ ...ARGUMENTS, project: SECOND_PROJECT }, { files: ambiguousFiles() })
      expect(result.problems).toEqual([])
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
    })

    it('リポジトリの既定ブランチを読めないと、失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-14')
      await explains('MCP ツール `branch_delete` の既定ブランチの取得のテストです。GitHub API が 404 を返した場合に、失敗を返し、`detail` に `could not read the default branch` で始まる理由を入れることを確認します。')
      const result = await tool(ARGUMENTS, { github: [restRule('GET', REPO_PATH, 404, { message: 'Not Found' })] })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not read the default branch of acme\/demo: resource not found: http:\/\/127\.0\.0\.1:\d+\/repos\/acme\/demo$/u)
      expect(requestLabels(result.requests)).toEqual(['GET /repos/acme/demo'])
    })

    it('git の外で呼ぶと、the repository is ambiguous の文と呼ぶ場所の案内を detail に入れ、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-17')
      await verifies(context, 'PW-BRANCH-DELETE-18')
      await explains('MCP ツール `branch_delete` の実行場所のテストです。git リポジトリの外で呼び出した場合に、`git-unresolved` の失敗を返し、`detail` に `the repository is ambiguous` と案内を入れることを確認します。')
      const result = await tool(ARGUMENTS, { remote: false, github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'git-unresolved', detail: 'the repository is ambiguous\n  run inside a git repository that has a remote' })
      expect(result.requests).toEqual([])
    })

    it('origin の URL が GitHub の形でなくても、引数のリポジトリのリモートブランチを削除する', async (context) => {
      await verifies(context, 'PW-BRANCH-DELETE-19')
      await explains('MCP ツール `branch_delete` の `origin` の URL のテストです。URL が GitHub の形式でない場合でも、引数で渡したリポジトリのリモートブランチを削除することを確認します。')
      const result = await tool(ARGUMENTS, { remoteUrl: '/srv/git/demo.git' })
      expect(result.problems).toEqual([])
      expect(result.structured).toEqual({ branch: 'feat/7', repository: 'acme/demo', deleted: true })
      expect(requestLabels(result.requests)).toContain('DELETE /repos/acme/demo/git/refs/heads/feat/7')
    })
  })
})
