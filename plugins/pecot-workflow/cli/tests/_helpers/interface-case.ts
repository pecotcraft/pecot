/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 定義の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// tests/interface/<コマンド>.test.ts が共有する準備。コマンドは runCli でプロセス内で呼ぶ。
// 使う側は useIsolatedEnvironment() を 1 回呼ぶ。後始末は、このファイルの afterEach が行う。
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { afterEach, expect, vi } from 'vitest'

import { runCli } from '../../src/cli.js'
import type { CommandDefinition } from '../../src/commands/registry.js'
import { capture } from '../../src/commands/tests/support.js'
import { installFakeGh, prependToPath } from '../../src/tests/_helpers/fake-executables.js'
import { setEnvironment } from '../../src/tests/_helpers/environment.js'
import { createGitRepository } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
import { startFakeGithub } from '../fake-github/server.js'
import type { FakeGithub, RecordedRequest, ResponseRule } from '../fake-github/server.js'

const startingDirectory = process.cwd()
const servers: FakeGithub[] = []

afterEach(async () => {
  process.chdir(startingDirectory)
  vi.useRealTimers()
  const opened = servers.splice(0)
  const problems = opened.flatMap(server => server.problems())
  const unused = opened.flatMap(server => server.unused())
  await Promise.all(opened.map(async server => server.close()))
  expect({ problems, unused }).toEqual({ problems: [], unused: [] })
})

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  /**
  既定は process.cwd()。enterGitRepository の後なら、移った先
  */
  readonly cwd?: string | undefined
}

/**
runCli をプロセス内で呼び、終了コードと出力を返す。commands は検証したいコマンドの定義
*/
export async function runInProcess(argv: readonly string[], commands: readonly CommandDefinition[], options: Readonly<RunOptions> = {}): Promise<CliResult> {
  const io = capture()
  const code = await runCli(argv, { commands, io, cwd: options.cwd ?? process.cwd(), environment: {}, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

export interface ProjectFixtureOptions {
  readonly host?: string
  readonly owner?: string
  /**
  設定の repositories に載せるリポジトリ名
  */
  readonly repositories?: readonly string[]
  /**
  プロジェクトルートに足すファイル（相対パス → 内容）。例は `.pecot/state/issue-pending`
  */
  readonly files?: Readonly<Record<string, string>>
  /**
  トークンの環境変数に入れる値。既定は dummy-token
  */
  readonly token?: string
}

export interface ProjectFixture {
  readonly root: string
  readonly configFile: string
  /**
  トークンを入れた環境変数の名前
  */
  readonly tokenVariable: string
}

function fixtureConfig(host: string, owner: string, repositories: readonly string[]): string {
  const fields = {
    workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
    priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } },
    size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } },
  }
  const project = { number: 1, id: 'PVT_1', board_url: `https://${host}/users/${owner}/projects/1`, fields }
  const config = { host, owner, workflow_suffix: owner, project, repositories: repositories.map(name => ({ owner, name, develop_branch: 'main' })) }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
一時のプロジェクトルートに、プロジェクトの設定と `.active` を置き、CLAUDE_PROJECT_DIR とトークンの環境変数を設定する。
設定の形は tests/parity/scenarios/issue-quick-ok.yaml と同じ（ホスト ghes.example.com・owner acme・リポジトリ demo が既定）
*/
export function setUpProject(options: Readonly<ProjectFixtureOptions> = {}): ProjectFixture {
  const { host = 'ghes.example.com', owner = 'acme', repositories = ['demo'], files = {}, token = 'dummy-token' } = options
  const root = makeTemporaryDirectory('pecot-project-')
  const configFile = `${host}_${owner}_board_${owner}.json`
  writeTree(root, {
    [`.pecot/config/projects/${configFile}`]: fixtureConfig(host, owner, repositories),
    '.pecot/config/projects/.active': `${configFile}\n`,
    ...files,
  })
  const tokenVariable = `PECOT_GITHUB_${host.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}_TOKEN`
  setEnvironment({ CLAUDE_PROJECT_DIR: root, [tokenVariable]: token })
  return { root, configFile, tokenVariable }
}

export interface RunningGithub {
  readonly url: string
  /**
  受けた要求の全部。受けた順
  */
  readonly requests: () => readonly RecordedRequest[]
}

/**
偽の GitHub サーバを始め、PECOT_GITHUB_API_URL をそこへ向ける。止めるのはテストの後（afterEach）。
表に無い要求と、使われなかった応答があれば、そのテストは失敗になる。
401 の再試行で本物の gh を起動しないよう、失敗する偽の gh を PATH の先頭に置く
*/
export async function startGithub(rules: readonly ResponseRule[]): Promise<RunningGithub> {
  const server = await startFakeGithub(rules)
  servers.push(server)
  const bin = makeTemporaryDirectory('pecot-gh-')
  installFakeGh(bin)
  prependToPath(bin)
  setEnvironment({ PECOT_GITHUB_API_URL: server.url })
  return { url: server.url, requests: () => server.requests() }
}

/**
一時の git リポジトリを作り、process.chdir で移る。元の作業ディレクトリへ戻すのはテストの後（afterEach）。
返すパスは realpath 済み
*/
export function enterGitRepository(files?: Readonly<Record<string, string>>): string {
  const repository = realpathSync(createGitRepository(files))
  process.chdir(repository)
  return path.resolve(repository)
}

/**
setTimeout（node:timers/promises を含む）を偽にする。戻すのはテストの後（afterEach）。
待ちを含むコマンドを呼ぶ前に呼び、コマンドの Promise は settleWithFakeDelays に渡して待つ
*/
export function useFakeDelays(): void {
  // fakeNodeBuiltins が無いと node:timers/promises の setTimeout は偽にならない
  vi.useFakeTimers({ toFake: ['setTimeout'], fakeNodeBuiltins: true })
}

const SETTLE_LIMIT_MILLISECONDS = 30_000

/**
渡した Promise が終わるまで、偽のタイマーを 3 秒ずつ進め、実の setImmediate で I/O に順番を譲る。
終わらないまま 30 秒（実時間）経ったら、例外にする
*/
export async function settleWithFakeDelays<T>(pending: Promise<T>): Promise<T> {
  const state = { isSettled: false }
  const watched = (async (): Promise<T> => {
    try {
      return await pending
    }
    finally {
      state.isSettled = true
    }
  })()
  const startedAt = performance.now()
  while (!state.isSettled) {
    if (performance.now() - startedAt > SETTLE_LIMIT_MILLISECONDS) throw new Error('settleWithFakeDelays: the command did not finish')
    await vi.advanceTimersByTimeAsync(3000)
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
  return await watched
}
