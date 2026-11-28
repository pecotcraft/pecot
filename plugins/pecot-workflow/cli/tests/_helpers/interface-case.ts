/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 定義の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// tests/interface/<ツール>.test.ts が共有する準備。ツールの本体はプロセス内で呼ぶ。
// 使う側は useIsolatedEnvironment() を 1 回呼ぶ。後始末は、このファイルの afterEach が行う。
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { afterEach, vi } from 'vitest'

import type { ToolDefinition } from '../../src/commands/registry.js'
import { setEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { runToolInProcess } from './run-tool.js'
import type { ToolRunResult } from './run-tool.js'
import { stepSync } from './step.js'

const startingDirectory = process.cwd()

afterEach(() => {
  process.chdir(startingDirectory)
  vi.useRealTimers()
})

export type { ToolRunResult } from './run-tool.js'

export interface RunOptions {
  /**
  既定は process.cwd()。enterGitRepository の後なら、移った先
  */
  readonly cwd?: string | undefined
}

/**
ツールの本体をプロセス内で呼び、終了コードと出力を返す。cwd を渡すと、呼ぶ間だけそこへ移る
*/
export async function runInProcess(name: string, arguments_: Readonly<Record<string, unknown>>, tools: readonly ToolDefinition[], options: Readonly<RunOptions> = {}): Promise<ToolRunResult> {
  const previous = process.cwd()
  if (options.cwd !== undefined) process.chdir(options.cwd)
  try {
    return await runToolInProcess(tools, name, arguments_)
  }
  finally {
    process.chdir(previous)
  }
}

export interface ProjectFixtureOptions {
  readonly host?: string
  readonly owner?: string
  /**
  設定の repositories に載せるリポジトリ名
  */
  readonly repositories?: readonly string[]
  /**
  プロジェクトルートに足すファイル（相対パス → 内容）。例は `.pecot/state/.pecot-base`
  */
  readonly files?: Readonly<Record<string, string>>
}

export interface ProjectFixture {
  readonly root: string
  readonly configFile: string
}

function fixtureConfig(host: string, owner: string, repositories: readonly string[]): string {
  const fields = {
    workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } },
  }
  const project = { number: 1, id: 'PVT_1', board_url: `https://${host}/users/${owner}/projects/1`, fields }
  const config = { host, owner, project, repositories: repositories.map(name => ({ owner, name, develop_branch: 'main' })) }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
一時のプロジェクトルートに、プロジェクトの設定と `.active` を置き、CLAUDE_PROJECT_DIR を設定する。
設定の形は tests/parity/scenarios/issue-quick-ok.yaml と同じ（ホスト ghes.example.com・owner acme・リポジトリ demo が既定）
*/
export function setUpProject(options: Readonly<ProjectFixtureOptions> = {}): ProjectFixture {
  return stepSync('プロジェクトの設定を置く', () => writeProject(options))
}

function writeProject(options: Readonly<ProjectFixtureOptions>): ProjectFixture {
  const { host = 'ghes.example.com', owner = 'acme', repositories = ['demo'], files = {} } = options
  const root = makeTemporaryDirectory('pecot-project-')
  const configFile = `${host}_${owner}_board_${owner}.json`
  writeTree(root, {
    [`.pecot/config/projects/${configFile}`]: fixtureConfig(host, owner, repositories),
    '.pecot/config/projects/.active': `${configFile}\n`,
    ...files,
  })
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  return { root, configFile }
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
