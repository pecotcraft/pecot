// 全コマンドに共通の振る舞い（PW-COMMON-*）を、runCli をプロセス内で呼んで確かめる。
import path from 'node:path'

import { z } from 'zod'
import { it, expect } from 'vitest'

import { runCli } from '../../src/cli.js'
import type { CliContext } from '../../src/cli.js'
import { defineCommand } from '../../src/commands/registry.js'
import type { CommandDefinition } from '../../src/commands/registry.js'
import { formatResolvedRepository } from '../../src/commands/repository-display.js'
import { capture, exitWith } from '../../src/commands/tests/support.js'
import { AmbiguousRepositoryError, resolveRepository } from '../../src/domain/repository-resolver.js'
import { gitRunnerFor } from '../../src/infra/git.js'
import { loadActiveConfig } from '../../src/infra/config-store.js'
import { projectRoot } from '../../src/infra/paths.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

// 見本のコマンドが動いた回数と、run が渡した作業ディレクトリ
const state = { started: 0, cwd: process.cwd() }

function sample(name: string, body: () => void | Promise<void>): CommandDefinition {
  return defineCommand({
    path: [name],
    description: '見本のコマンド',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => {
      state.started += 1
      await body()
      return await exitWith(0)
    },
  })
}

// 対象を決める引数を持たない見本。解決したリポジトリを標準出力に出す
const TARGET = defineCommand({
  path: ['target'],
  description: '対象を解決する',
  input: z.object({}),
  positional: [],
  interactive: false,
  run: async (input, io) => {
    state.started += 1
    const resolved = resolveRepository(input.repo, gitRunnerFor(state.cwd))
    io.stdout(formatResolvedRepository(resolved))
    return await exitWith(0)
  },
})

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(argv: readonly string[], commands: readonly CommandDefinition[] = [TARGET], cwd = process.cwd()): Promise<Run> {
  const io = capture()
  state.cwd = cwd
  state.started = 0
  const context: CliContext = { commands, io, cwd, environment: {}, terminalColumns: undefined }
  const code = await runCli(argv, context)
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

function repositoryWithRemotes(remotes: Readonly<Record<string, string>>): string {
  const repository = createGitRepository()
  for (const [name, url] of Object.entries(remotes)) gitForTest(repository, ['remote', 'add', name, url])
  return repository
}

function outsideGit(): string {
  const directory = makeTemporaryDirectory('pecot-nogit-')
  setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
  return directory
}

it('--help を付けて打つと、使い方を標準出力に出す', async (context) => {
  await verifies(context, 'PW-COMMON-01')
  const result = await run(['--help'])
  expect(result.stdout).toContain('Usage: pecot [OPTIONS] COMMAND [ARGS]...')
  expect(result.stdout).toContain('--show-repo')
  expect(result.stderr).toBe('')
})

it('--help を付けて打つと、終了コード 0 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-02')
  const result = await run(['--help'])
  expect(result.code).toBe(0)
})

it.for([{ flag: '--version' }, { flag: '-v' }])('$flag を付けて打つと、版を標準出力に出す', async ({ flag }, context) => {
  await verifies(context, 'PW-COMMON-03')
  const result = await run([flag])
  expect(result.stdout).toMatch(/^pecot version \d[^\n]*\n$/u)
  expect(result.stderr).toBe('')
})

it.for([{ flag: '--version' }, { flag: '-v' }])('$flag を付けて打つと、終了コード 0 で終わる', async ({ flag }, context) => {
  await verifies(context, 'PW-COMMON-04')
  const result = await run([flag])
  expect(result.code).toBe(0)
})

it('--show-repo を付けて打つと、解決したリポジトリを標準出力に出す', async (context) => {
  await verifies(context, 'PW-COMMON-05')
  const explicit = await run(['--repo', 'owner/repoA', '--show-repo'])
  expect(explicit).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   explicit\n', stderr: '' })
  const repository = repositoryWithRemotes({ origin: 'git@github.com:owner/repoB.git' })
  const detected = await run(['--show-repo'], [TARGET], repository)
  expect(detected).toEqual({ code: 0, stdout: 'resolved: owner/repoB\nsource:   current-git (origin)\n', stderr: '' })
})

it('対象を決めないコマンドに --repo を渡すと、渡したリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-06')
  const repository = repositoryWithRemotes({ origin: 'git@github.com:owner/other.git' })
  const result = await run(['--repo', 'owner/repoA', 'target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   explicit\n', stderr: '' })
  expect(state.started).toBe(1)
})

it('対象を決めないコマンドで --repo を省くと、カレントの git の origin remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-07')
  const repository = repositoryWithRemotes({ upstream: 'git@github.com:owner/up.git', origin: 'git@github.com:owner/repoA.git' })
  const result = await run(['target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   current-git (origin)\n', stderr: '' })
})

it('対象を決めないコマンドで --repo を省いて origin remote が無いと、最初の remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-08')
  const repository = repositoryWithRemotes({ upstream: 'https://github.com/owner/up.git' })
  const result = await run(['target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/up\nsource:   current-git (upstream)\n', stderr: '' })
})

it.for([{ argv: ['--no-such-option'] }, { argv: ['target', '--no-such-option'] }])('知らないオプション $argv を渡すと、終了コード 2 で終わる', async ({ argv }, context) => {
  await verifies(context, 'PW-COMMON-09')
  const result = await run(argv)
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('No such option: --no-such-option')
})

it('--repo が owner/repo の形でないと、終了コード 2 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-10')
  const result = await run(['--repo', 'invalid', '--show-repo'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('owner/repo')
})

it('--show-repo でリポジトリを解決できないと、終了コード 2 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-11')
  const result = await run(['--show-repo'], [TARGET], outsideGit())
  expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: repository is ambiguous: pass --repo <owner/repo>\n' })
})

it.for([{ url: 'https://example.com' }, { url: 'ftp://127.0.0.1' }])('PECOT_GITHUB_API_URL が $url だと、サブコマンドを動かさない', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-12')
  setEnvironment({ PECOT_GITHUB_API_URL: url })
  await run(['target'])
  expect(state.started).toBe(0)
})

it('PECOT_GITHUB_API_URL がループバックの http の URL でないと、終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-13')
  setEnvironment({ PECOT_GITHUB_API_URL: 'https://example.com' })
  const result = await run(['target'])
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: https://example.com\n')
})

it('プロジェクトのルートを決められないと、終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-14')
  const directory = outsideGit()
  const root = sample('root', () => {
    projectRoot({ cwd: directory })
  })
  const result = await run(['root'], [root], directory)
  expect(result.code).toBe(1)
  expect(result.stderr.split('\n', 1)[0]).toMatch(/^error: project root not found/u)
})

it('読み込む設定ファイルの形式が不正だと、終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-15')
  const directory = makeTemporaryDirectory('pecot-config-')
  writeTree(directory, { '.pecot/config/projects/broken.json': '{"host":"github.com"}', '.pecot/config/projects/.active': 'broken.json\n' })
  setEnvironment({ CLAUDE_PROJECT_DIR: directory })
  const config = sample('config', () => {
    loadActiveConfig()
  })
  const result = await run(['config'], [config], directory)
  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/^error: /u)
})

it('コマンドが捕まえなかった独自の例外が起きると、error の行を標準エラーに出す', async (context) => {
  await verifies(context, 'PW-COMMON-16')
  const root = sample('root', () => {
    throw new AmbiguousRepositoryError('first line\nsecond line')
  })
  const result = await run(['root'], [root])
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('error: first line\n  second line\n')
})

it('コマンドが捕まえなかった独自の例外が起きると、リポジトリが曖昧なときも終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-17')
  const ambiguous = sample('ambiguous', () => {
    resolveRepository(undefined, gitRunnerFor(state.cwd))
  })
  const result = await run(['ambiguous'], [ambiguous], outsideGit())
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('error: repository is ambiguous: pass --repo <owner/repo>\n')
})
