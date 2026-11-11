/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// コマンドをプロセス内で動かすための作業場。一時 git リポ（origin は bare リポ）と偽の GitHub サーバを用意する。
//
// 使い方: `await openWorkspace({ branch, branches, github })` で作り、`workspace.run(argv)` で動かす。
// 後始末は、このファイルを import したテストの afterEach が行う。
// 環境変数を戻すのは useIsolatedEnvironment の afterEach。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach } from 'vitest'

import { runCli } from '../../src/cli.js'
import { COMMANDS } from '../../src/commands/command-list.js'
import { capture } from '../../src/commands/tests/support.js'
import { setEnvironment } from '../../src/tests/_helpers/environment.js'
import { gitEnvironment } from '../../src/tests/_helpers/git-repository.js'
import { startFakeGithub } from '../fake-github/server.js'
import type { FakeGithub, RecordedRequest, ResponseMatch, ResponseRule, ResponseSpec } from '../fake-github/server.js'
import type { CommitSetup, Scenario, WorktreeSetup } from '../parity/scenario.js'
import { baseEnvironment, createSandbox, destroySandbox } from '../parity/setup.js'
import type { Sandbox } from '../parity/setup.js'

export type ResponseRuleList = readonly ResponseRule[]

export const OWNER = 'acme'
export const REPOSITORY = 'demo'
export const HOST = 'ghes.example.com'
const TOKEN_VARIABLE = 'PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN'

// 応答の組み立て

/**
応答の規則 1 件。times の既定は 1
*/
export function rule(match: Readonly<ResponseMatch>, respond: Readonly<ResponseSpec>, times = 1): ResponseRule {
  return { match, respond, times }
}

/**
GraphQL の operation への 200 応答
*/
export function graphql(operation: string, data: unknown, options: Readonly<{ variables?: unknown, times?: number }> = {}): ResponseRule {
  return rule({ operation, variables: options.variables }, { status: 200, body: { data } }, options.times)
}

/**
REST への応答。status 204 などは body を省く
*/
export function rest(method: string, requestPath: string, status: number, body?: unknown, times = 1): ResponseRule {
  return rule({ method, path: requestPath }, { status, body }, times)
}

export interface PullRequestSample {
  readonly number?: number
  readonly state?: string
  readonly title?: string
  readonly body?: string
  readonly head?: string
  readonly base?: string
  readonly isDraft?: boolean
  readonly mergeable?: string
  readonly comments?: number
  readonly closing?: readonly (readonly [number, string])[]
  readonly reviews?: readonly unknown[]
  readonly threads?: readonly unknown[]
}

/**
GetPullRequestSlim / GetPullRequestWithReviews の data。reviewThreads は threads を渡したときだけ付く
*/
export function pullRequestData(sample: Readonly<PullRequestSample> = {}): unknown {
  const pullRequest: Record<string, unknown> = {
    number: sample.number ?? 21,
    state: sample.state ?? 'MERGED',
    title: sample.title ?? 'feat(demo): #12 見本の変更',
    body: sample.body ?? 'Closes #12\n',
    headRefName: sample.head ?? 'feat/demo/12',
    baseRefName: sample.base ?? 'main',
    isDraft: sample.isDraft ?? false,
    mergeable: sample.mergeable ?? 'MERGEABLE',
    comments: { totalCount: sample.comments ?? 0 },
    closingIssuesReferences: { nodes: (sample.closing ?? [[12, '見本の Issue']]).map(([number, title]) => ({ number, title })) },
    reviews: { nodes: sample.reviews ?? [] },
  }
  if (sample.threads !== undefined) pullRequest['reviewThreads'] = { nodes: sample.threads }
  return { repository: { pullRequest } }
}

/**
GetIssueKind の data。subIssues が 1 件以上、または issueType が Epic なら Epic になる
*/
export function issueKindData(options: Readonly<{ number?: number, subIssues?: number, issueType?: string }> = {}): unknown {
  // GraphQL の応答は、Issue Type が無いと null
  // eslint-disable-next-line unicorn/no-null -- 応答の形
  const issueType = options.issueType === undefined ? null : { name: options.issueType }
  return { repository: { issue: { number: options.number ?? 12, state: 'OPEN', issueType, subIssues: { totalCount: options.subIssues ?? 0 } } } }
}

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
  priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } },
  size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } },
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
    workflow_suffix: OWNER,
    project: { number: 1, id: 'PVT_1', board_url: `https://${HOST}/users/${OWNER}/projects/1`, fields: BOARD_FIELDS },
    repositories: [repository, ...(options.hasSecondRepository === true ? [{ owner: OWNER, name: 'other', develop_branch: 'main' }] : [])],
  }
  return {
    [`.pecot/config/projects/${CONFIG_NAME}`]: `${JSON.stringify(config, undefined, 2)}\n`,
    '.pecot/config/projects/.active': `${CONFIG_NAME}\n`,
  }
}

// 作業場

export interface WorkspaceOptions {
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

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
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
  readonly run: (argv: readonly string[], cwd?: string) => Promise<CliResult>
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
    command: { path: [], args: [] },
    stdin: '',
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
        files: { ...configFiles, ...options.files },
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
    run: async (argv, cwd = sandbox.repositoryDirectory) => {
      const io = capture()
      const previous = process.cwd()
      process.chdir(cwd)
      try {
        const code = await runCli(argv, { commands: COMMANDS, io, cwd, environment: { COLUMNS: '80' }, terminalColumns: undefined })
        return { code, stdout: io.out.join(''), stderr: io.err.join('') }
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
