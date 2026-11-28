/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- ツールの定義の型は readonly にできない */
// ツールを、一時 git リポと設定ファイルの上で、プロセス内で動かす補助。describe の外で useIsolatedEnvironment() を 1 回呼んでおく。
// runCommand は本体を呼んで終了コードと出力を、runTool は MCP のクライアントから呼んで結果の項目を返す。process.chdir を使うので it.concurrent では使えない
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { TOOLS } from '../../src/commands/registry.js'
import type { ToolDefinition } from '../../src/commands/registry.js'
import { attachReadText } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { setEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { callToolOnce } from './mcp-client.js'
import type { ToolOutcome } from './mcp-client.js'
import { runToolInProcess } from './run-tool.js'

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
    project: {
      number: 1,
      id: 'PVT_1',
      board_url: `https://${DEFAULT_HOST}/users/${DEFAULT_OWNER}/projects/1`,
      fields: {
        workflow: { id: 'PVTSSF_workflow', options: options.workflowOptions ?? { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
      },
    },
    repositories: options.repositories ?? [{ owner: DEFAULT_OWNER, name: DEFAULT_NAME, develop_branch: 'main' }],
    ...options.extra,
  }
}

export const CONFIG_FILE = `.pecot/config/projects/${DEFAULT_HOST}_${DEFAULT_OWNER}_board_acme.json`

export interface CommandRun {
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  /**
  origin の指す先。`false` なら git の外で動かす。既定は ghes.example.com の acme/demo
  */
  readonly remote?: RepositoryOptions | false
  /**
  config を置くパス。既定は CONFIG_FILE
  */
  readonly configFile?: string
  /**
  origin の URL をそのまま渡す（GitHub の形でない手元のパスなど）。remote より先に使う
  */
  readonly remoteUrl?: string
  /**
  動かす前に checkout して作るブランチ。既定は初期のブランチのまま
  */
  readonly branch?: string
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
  動かすツールの一覧。既定は TOOLS
  */
  readonly tools?: readonly ToolDefinition[]
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
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

function prepareDirectory(run: Readonly<Pick<CommandRun, 'remote' | 'remoteUrl' | 'branch'>>): string {
  const { remote, remoteUrl, branch } = run
  if (remote === false) {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    // 親をたどって実リポを読まない
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    return directory
  }
  const directory = createGitRepository()
  const { host = DEFAULT_HOST, owner = DEFAULT_OWNER, name = DEFAULT_NAME } = remote ?? {}
  gitForTest(directory, ['remote', 'add', 'origin', remoteUrl ?? `git@${host}:${owner}/${name}.git`])
  if (branch !== undefined) gitForTest(directory, ['checkout', '-q', '-b', branch])
  return directory
}

type Sandboxed = Pick<CommandResult, 'directory' | 'read'>

/**
一時リポと設定を用意して、そのリポの中で body を呼ぶ。終わったら cwd と env を戻す
*/
async function inSandbox<T>(run: Readonly<Omit<CommandRun, 'tool' | 'arguments'>>, body: (directory: string) => Promise<T>): Promise<T & Sandboxed> {
  const originalDirectory = process.cwd()
  const originalEnvironment = { ...process.env }
  try {
    const directory = prepareDirectory(run)
    if (run.config !== false) {
      writeTree(directory, {
        [run.configFile ?? CONFIG_FILE]: `${JSON.stringify(run.config ?? projectConfig(), undefined, 2)}\n`,
        '.pecot/config/projects/.active': `${path.basename(run.configFile ?? CONFIG_FILE)}\n`,
      })
    }
    writeTree(directory, run.files ?? {})
    setEnvironment({
      CLAUDE_PROJECT_DIR: directory,
      ...run.environment,
    })
    process.chdir(directory)
    const result = await body(directory)
    return {
      ...result,
      directory,
      read: (relative) => {
        const text = readIfExists(directory, relative)
        if (text !== undefined) attachReadText(relative, text)
        return text
      },
    }
  }
  finally {
    process.chdir(originalDirectory)
    restoreEnvironment(originalEnvironment)
  }
}

/**
一時リポと設定を用意して、ツールの本体をプロセス内で呼ぶ。終わったら cwd を戻す
*/
export async function runCommand(run: Readonly<CommandRun>): Promise<CommandResult> {
  return await inSandbox(run, async () => await runToolInProcess(run.tools ?? TOOLS, run.tool, run.arguments))
}

export type ToolRun = CommandRun

export interface ToolResult extends Sandboxed, ToolOutcome {}

/**
runCommand と同じ用意の上で、MCP のツールを同じプロセスの中のクライアントから 1 回呼ぶ。structuredContent の項目を確かめるときに使う
*/
export async function runTool(run: Readonly<ToolRun>): Promise<ToolResult> {
  return await inSandbox(run, async () => {
    return await callToolOnce(run.tools ?? TOOLS, run.tool, run.arguments)
  })
}

// 書き換えた env を、呼ぶ前の値へ戻す。呼ぶ前に無かったキーは外す
function restoreEnvironment(original: Readonly<Record<string, string | undefined>>): void {
  const removed = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]))
  setEnvironment({ ...removed, ...original })
}
