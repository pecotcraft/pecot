/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// コマンドを、一時 git リポ・設定ファイル・偽の GitHub サーバの上で、プロセス内の runCli から動かす補助。
//
// 使い方。テストファイルの describe の外で useIsolatedEnvironment() を 1 回呼んでおく。
// runCommand に argv と偽サーバの応答の列を渡す。応答は restRule と graphqlRule で作る。
// 結果は、終了コードと出力と受けた要求を持つ。終わった後のファイルは read で読む。
//
// 作るもの:
//   - 一時 git リポ。origin は `git@<host>:<owner>/<name>.git`。`remote: false` なら git の外の空ディレクトリにする
//   - `.pecot/config/projects/` の設定ファイルと .active（`config: false` なら作らない）
//   - 偽の GitHub サーバ。API の URL とトークンの環境変数を、このサーバに向ける
// 動かし方:
//   process.chdir でリポに入って runCli を呼び、後で cwd を戻す。CliContext.cwd にも同じディレクトリを渡す。
//   env は runCommand が終わるときに、書き換える前の値へ戻す。useIsolatedEnvironment も各テストの後に戻す
//   process.chdir を使うので、it.concurrent と pool: threads のテストでは使えない
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { runCli } from '../../src/cli.js'
import { COMMANDS } from '../../src/commands/registry.js'
import type { CommandDefinition } from '../../src/commands/registry.js'
import { capture } from '../../src/commands/tests/support.js'
import { getEnvironmentVariableName } from '../../src/infra/github/auth.js'
import { setEnvironment } from '../../src/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
import { startFakeGithub } from '../fake-github/server.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'

export const DEFAULT_HOST = 'ghes.example.com'
export const DEFAULT_OWNER = 'acme'
export const DEFAULT_NAME = 'demo'

export interface RepositoryOptions {
  readonly host?: string
  readonly owner?: string
  readonly name?: string
}

export interface ConfigOptions {
  /**
  設定の repositories。既定は acme/demo（develop_branch は main）
  */
  readonly repositories?: readonly Readonly<Record<string, unknown>>[]
  /**
  workflow フィールドの選択肢（名前と ID）。既定は backlog〜archived の 6 つ
  */
  readonly workflowOptions?: Readonly<Record<string, string>>
  /**
  設定に足す・上書きするキー
  */
  readonly extra?: Readonly<Record<string, unknown>>
}

/**
アクティブなプロジェクト設定の中身（JSON にする前のオブジェクト）
*/
export function projectConfig(options: Readonly<ConfigOptions> = {}): Record<string, unknown> {
  return {
    host: DEFAULT_HOST,
    owner: DEFAULT_OWNER,
    workflow_suffix: 'acme',
    project: {
      number: 1,
      id: 'PVT_1',
      board_url: `https://${DEFAULT_HOST}/users/${DEFAULT_OWNER}/projects/1`,
      fields: {
        workflow: { id: 'PVTSSF_workflow', options: options.workflowOptions ?? { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
        priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } },
        size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } },
      },
    },
    repositories: options.repositories ?? [{ owner: DEFAULT_OWNER, name: DEFAULT_NAME, develop_branch: 'main' }],
    ...options.extra,
  }
}

export const CONFIG_FILE = `.pecot/config/projects/${DEFAULT_HOST}_${DEFAULT_OWNER}_board_acme.json`

export interface CommandRun {
  readonly argv: readonly string[]
  /**
  偽サーバの応答。受けた要求が当たらなければ problems に出る
  */
  readonly github?: readonly ResponseRule[]
  /**
  origin の指す先。`false` なら git の外で動かす。既定は ghes.example.com の acme/demo
  */
  readonly remote?: RepositoryOptions | false
  /**
  プロジェクト設定。`false` なら置かない（アクティブなプロジェクトが無い）。既定は projectConfig()
  */
  readonly config?: Readonly<Record<string, unknown>> | false
  /**
  リポに置くファイル（相対パスと内容）。設定ファイルより後に書く
  */
  readonly files?: Readonly<Record<string, string>>
  /**
  動かす前に足す環境変数。undefined の値は外す
  */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
  動かすコマンドの一覧。既定は COMMANDS
  */
  readonly commands?: readonly CommandDefinition[]
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /**
  偽サーバが受けた要求（受けた順）
  */
  readonly requests: readonly RecordedRequest[]
  /**
  偽サーバの誤り（応答に当たらない要求など）
  */
  readonly problems: readonly string[]
  /**
  使われなかった応答
  */
  readonly unused: readonly string[]
  /**
  動かしたディレクトリ（リポのルート）
  */
  readonly directory: string
  /**
  動かした後のファイルの中身。無ければ undefined
  */
  readonly read: (relative: string) => string | undefined
}

function readIfExists(directory: string, relative: string): string | undefined {
  try {
    return readFileSync(path.join(directory, relative), 'utf8')
  }
  catch (error: unknown) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined
    throw error
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
function prepareDirectory(run: Readonly<CommandRun>): string {
  const { remote } = run
  if (remote === false) {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    // 親をたどって実リポを読まない
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    return directory
  }
  const directory = createGitRepository()
  const { host = DEFAULT_HOST, owner = DEFAULT_OWNER, name = DEFAULT_NAME } = remote ?? {}
  gitForTest(directory, ['remote', 'add', 'origin', `git@${host}:${owner}/${name}.git`])
  return directory
}

/**
一時リポ・設定・偽サーバを用意して、runCli をプロセス内で呼ぶ。終わったら cwd を戻し、偽サーバを閉じる
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
export async function runCommand(run: Readonly<CommandRun>): Promise<CommandResult> {
  const originalDirectory = process.cwd()
  const originalEnvironment = { ...process.env }
  const server = await startFakeGithub(run.github ?? [])
  try {
    const directory = prepareDirectory(run)
    if (run.config !== false) {
      writeTree(directory, {
        [CONFIG_FILE]: `${JSON.stringify(run.config ?? projectConfig(), undefined, 2)}\n`,
        '.pecot/config/projects/.active': `${path.basename(CONFIG_FILE)}\n`,
      })
    }
    writeTree(directory, run.files ?? {})
    setEnvironment({
      CLAUDE_PROJECT_DIR: directory,
      PECOT_GITHUB_API_URL: server.url,
      [getEnvironmentVariableName(DEFAULT_HOST)]: 'dummy-token',
      ...run.environment,
    })
    process.chdir(directory)
    const io = capture()
    const code = await runCli(run.argv, {
      commands: run.commands ?? COMMANDS,
      io,
      cwd: directory,
      environment: {},
      terminalColumns: undefined,
    })
    return {
      code,
      stdout: io.out.join(''),
      stderr: io.err.join(''),
      requests: [...server.requests()],
      problems: [...server.problems()],
      unused: [...server.unused()],
      directory,
      read: relative => readIfExists(directory, relative),
    }
  }
  finally {
    process.chdir(originalDirectory)
    restoreEnvironment(originalEnvironment)
    await server.close()
  }
}

// 書き換えた env を、呼ぶ前の値へ戻す。呼ぶ前に無かったキーは外す
function restoreEnvironment(original: Readonly<Record<string, string | undefined>>): void {
  const removed = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]))
  setEnvironment({ ...removed, ...original })
}

/**
GraphQL の応答の規則。operation は tests/fake-github/operations.ts の名前
*/
export function graphqlRule(operation: string, data: unknown, variables?: unknown): ResponseRule {
  return { match: { operation, ...(variables !== undefined && { variables }) }, respond: { status: 200, body: { data } }, times: 1 }
}

/**
REST の応答の規則。body が無ければ空の本文（204 は本文なし）
*/
export function restRule(method: string, requestPath: string, status: number, body?: unknown): ResponseRule {
  // 204 は本文を持たない
  const payload = status === 204 ? { text: '' } : (body === undefined ? {} : { body })
  return { match: { method, path: requestPath }, respond: { status, ...payload }, times: 1 }
}

/**
受けた要求の GraphQL の operation 名と REST の `METHOD path` を、受けた順に並べる
*/
export function requestLabels(requests: readonly RecordedRequest[]): string[] {
  return requests.map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}
