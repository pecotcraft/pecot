/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// ツールをプロセス内で動かすための作業場。一時 git リポ（origin は bare リポ）と偽の GitHub サーバを用意する。
//
// 使い方: `await openWorkspace({ branch, branches, github })` で作り、`workspace.run(name, arguments)` で動かす。
// 後始末は、このファイルを import したテストの afterEach が行う。
// 環境変数を戻すのは useIsolatedEnvironment の afterEach。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach } from 'vitest'

import { TOOLS } from '../../src/commands/registry.js'
import { setEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { startFakeGithub } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { FakeGithub, RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { CommitSetup, Scenario, WorktreeSetup } from '../parity/scenario.js'
import { baseEnvironment, createSandbox, destroySandbox } from '../parity/setup.js'
import type { Sandbox } from '../parity/setup.js'

import { developmentRecordOf } from './base-record.js'
import type { BaseRecordOption } from './base-record.js'
import { runToolInProcess } from './run-tool.js'
import type { ToolRunResult } from './run-tool.js'

export const OWNER = 'acme'
export const REPOSITORY = 'demo'
export const HOST = 'ghes.example.com'
const TOKEN_VARIABLE = 'PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN'

// 設定ファイル

export interface ConfigOptions {
  /**
  false なら develop_branch を書かない。既定は main
  */
  readonly developBranch?: string | false
  readonly releaseBranch?: string
  readonly releaseType?: 'single' | 'multi' | 'nx'
  /**
  設定のリポジトリを 2 つにする
  */
  readonly hasSecondRepository?: boolean
}

const BOARD_FIELDS = {
  workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
}

const CONFIG_NAME = 'ghes.example.com_acme_board_acme.json'

/**
アクティブなプロジェクトの設定ファイル 2 つ（設定の JSON と .active）。リポジトリ直下からの相対パスで返す
*/
export function projectConfigFiles(options: Readonly<ConfigOptions> = {}): Readonly<Record<string, string>> {
  const developBranch = options.developBranch ?? 'main'
  const repository = {
    owner: OWNER,
    name: REPOSITORY,
    ...(developBranch !== false && { develop_branch: developBranch }),
    ...(options.releaseBranch !== undefined && { release_branch: options.releaseBranch }),
    ...(options.releaseType !== undefined && { release_type: options.releaseType }),
  }
  const config = {
    host: HOST,
    owner: OWNER,
    project: { number: 1, id: 'PVT_1', board_url: `https://${HOST}/users/${OWNER}/projects/1`, fields: BOARD_FIELDS },
    repositories: [repository, ...(options.hasSecondRepository === true ? [{ owner: OWNER, name: 'other', develop_branch: 'main' }] : [])],
  }
  return {
    [`.pecot/config/projects/${CONFIG_NAME}`]: `${JSON.stringify(config, undefined, 2)}\n`,
    '.pecot/config/projects/.active': `${CONFIG_NAME}\n`,
  }
}

// 作業場

export interface WorkspaceOptions extends BaseRecordOption {
  /**
  最後に checkout しているブランチ。origin に無ければ push しない（未 push）
  */
  readonly branch?: string
  /**
  main から分けて origin へ push するブランチ
  */
  readonly branches?: readonly Readonly<{ name: string, commits?: readonly CommitSetup[] }>[]
  /**
  初期コミットの上に積むコミット
  */
  readonly commits?: readonly CommitSetup[]
  readonly worktrees?: readonly WorktreeSetup[]
  /**
  作業ツリーに置くだけのファイル（コミットしない）
  */
  readonly files?: Readonly<Record<string, string>>
  /**
  アクティブなプロジェクトの設定。false なら置かない。既定は develop_branch が main の設定
  */
  readonly config?: ConfigOptions | false
  readonly github?: readonly ResponseRule[]
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface Workspace {
  /**
  作業リポジトリ（checkout 済み）
  */
  readonly directory: string
  /**
  一時 root。リポジトリの外に置くファイルの置き場
  */
  readonly root: string
  readonly server: FakeGithub
  /**
  既定は作業リポジトリで実行する。cwd を渡すと、そこで実行する
  */
  readonly run: (name: string, arguments_: Readonly<Record<string, unknown>>, cwd?: string) => Promise<ToolRunResult>
  readonly git: (arguments_: readonly string[], cwd?: string) => string
  /**
  origin の bare リポで git を実行する
  */
  readonly remoteGit: (arguments_: readonly string[]) => string
  /**
  origin のブランチに、空のコミットを 1 つ積む
  */
  readonly advanceRemote: (branch: string) => void
  /**
  作業リポジトリからの相対パスを読む
  */
  readonly read: (relative: string) => string
  readonly exists: (relative: string) => boolean
  /**
  作業リポジトリの外（一時 root の files/）にファイルを書き、そのパスを返す
  */
  readonly scratch: (name: string, content: string) => string
  readonly requests: () => readonly RecordedRequest[]
}

interface Opened {
  readonly sandbox: Sandbox
  readonly server: FakeGithub
}

const opened: Opened[] = []

afterEach(async () => {
  for (const { sandbox, server } of opened.splice(0)) {
    await server.close()
    destroySandbox(sandbox)
  }
})

// 偽サーバの代わりに、プロキシと PATH は触らない
const NOT_APPLIED = new Set(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'])

function scenarioOf(options: Readonly<WorkspaceOptions>): Scenario {
  const configFiles = options.config === false ? {} : projectConfigFiles(options.config)
  return {
    id: 'interface',
    tool: '',
    arguments: {},
    setup: {
      repo: {
        owner: OWNER,
        name: REPOSITORY,
        host: HOST,
        branch: options.branch ?? 'main',
        commits: options.commits ?? [],
        branches: (options.branches ?? []).map(branch => ({ name: branch.name, commits: branch.commits ?? [] })),
        tags: [],
        worktrees: options.worktrees ?? [],
        files: { ...configFiles, ...developmentRecordOf(options), ...options.files },
      },
      cwd: '.',
      data: {},
      env: {},
      ghToken: undefined,
    },
    github: [],
  }
}

export async function openWorkspace(options: Readonly<WorkspaceOptions> = {}): Promise<Workspace> {
  const sandbox = createSandbox(scenarioOf(options))
  const server = await startFakeGithub(options.github ?? [])
  opened.push({ sandbox, server })

  const environment = Object.fromEntries(Object.entries(baseEnvironment(sandbox)).filter(([name]) => !NOT_APPLIED.has(name)))
  setEnvironment({ ...environment, PECOT_GITHUB_API_URL: server.url, [TOKEN_VARIABLE]: 'dummy-token', ...options.env })

  const bare = path.join(sandbox.root, 'remotes', OWNER, `${REPOSITORY}.git`)
  const gitIn = (cwd: string, arguments_: readonly string[]): string => execFileSync('git', [...arguments_], { cwd, env: { ...gitEnvironment(), ...baseEnvironment(sandbox) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const filesDirectory = path.join(sandbox.root, 'files')

  return {
    directory: sandbox.repositoryDirectory,
    root: sandbox.root,
    server,
    run: async (name, arguments_, cwd = sandbox.repositoryDirectory) => {
      const previous = process.cwd()
      process.chdir(cwd)
      try {
        return await runToolInProcess(TOOLS, name, arguments_)
      }
      finally {
        process.chdir(previous)
      }
    },
    git: (arguments_, cwd = sandbox.repositoryDirectory) => gitIn(cwd, arguments_),
    remoteGit: arguments_ => gitIn(bare, arguments_),
    advanceRemote: (branch) => {
      const tree = gitIn(bare, ['rev-parse', [branch, '^{tree}'].join('')]).trim()
      const next = gitIn(bare, ['commit-tree', tree, '-p', branch, '-m', 'advance']).trim()
      gitIn(bare, ['update-ref', `refs/heads/${branch}`, next])
    },
    read: relative => readFileSync(path.join(sandbox.repositoryDirectory, relative), 'utf8'),
    exists: relative => existsSync(path.join(sandbox.repositoryDirectory, relative)),
    scratch: (name, content) => {
      mkdirSync(filesDirectory, { recursive: true })
      const target = path.join(filesDirectory, name)
      writeFileSync(target, content)
      return target
    },
    requests: () => server.requests(),
  }
}
