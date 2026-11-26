/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// tests/<処理>.test.ts が共有する準備。action は inputs を INPUT_<名前> の環境変数で受けるので、それを置いて呼ぶ。
// 使う側は useIsolatedEnvironment() を 1 回呼ぶ。偽の GitHub と作業ディレクトリの後始末は、このファイルの afterEach が行う。
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { afterEach, expect, vi } from 'vitest'

import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { capture } from '../../../libs/workflow-core/tests/_helpers/captured-io.js'
import { setEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import { installFakeGh, prependToPath } from '../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { startFakeGithub } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import type { FakeGithub, RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { createGitRepository } from '../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../libs/workflow-core/tests/_helpers/temporary.js'

const startingDirectory = process.cwd()
const servers: FakeGithub[] = []

afterEach(async () => {
  process.chdir(startingDirectory)
  process.exitCode = undefined
  vi.useRealTimers()
  const opened = servers.splice(0)
  const problems = opened.flatMap(server => server.problems())
  const unused = opened.flatMap(server => server.unused())
  await Promise.all(opened.map(async server => server.close()))
  expect({ problems, unused }).toEqual({ problems: [], unused: [] })
})

export interface ActionResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
GitHub の runner が inputs を渡すときの環境変数の名前（空白を _ にし、大文字にする）
*/
export function inputVariable(name: string): string {
  return `INPUT_${name.replaceAll(' ', '_').toUpperCase()}`
}

/**
inputs を置いて action の処理を呼び、終了コードと出力を返す。undefined の input は置かない
*/
export async function runActionCase(action: (io: CommandIo) => Promise<number>, inputs: Readonly<Record<string, string | undefined>> = {}): Promise<ActionResult> {
  setEnvironment(Object.fromEntries(Object.entries(inputs).map(([name, value]) => [inputVariable(name), value])))
  const io = capture()
  const code = await action(io)
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

export interface ProjectFixtureOptions {
  readonly host?: string
  readonly owner?: string
  readonly repositories?: readonly string[]
  /**
  プロジェクトルートに足すファイル（相対パス → 内容）
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
一時のリポのルートにプロジェクトの設定を置き、作業ディレクトリをそこへ移す。action は checkout したリポのルートで動く
*/
export function setUpProject(options: Readonly<ProjectFixtureOptions> = {}): ProjectFixture {
  const { host = 'github.com', owner = 'acme', repositories = ['demo'], files = {} } = options
  const configFile = `${host}_${owner}_board_${owner}.json`
  const root = realpathSync(createGitRepository({
    [`.pecot/config/projects/${configFile}`]: fixtureConfig(host, owner, repositories),
    ...files,
  }))
  process.chdir(root)
  setEnvironment({ GITHUB_REPOSITORY: `${owner}/${repositories[0] ?? 'demo'}` })
  return { root: path.resolve(root), configFile }
}

/**
一時ディレクトリにファイルを置き、そのディレクトリを返す
*/
export function writeFiles(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory('pecot-action-')
  writeTree(directory, files)
  return directory
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
表に無い要求と、使われなかった応答があれば、そのテストは失敗になる
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
