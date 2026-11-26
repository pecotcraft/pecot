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
import { AmbiguousRepositoryError, resolveRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { gitRunnerFor } from '@pecot/workflow-core/infra/git.js'
import { loadActiveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { projectRoot } from '@pecot/workflow-core/infra/paths.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

// 見本のコマンドが動いた回数と、run が渡した作業ディレクトリ
const state = { started: 0, cwd: process.cwd() }

function sample(name: string, body: () => void | Promise<void>): CommandDefinition {
  return defineCommand({
    path: [name],
    title: 'Test command',
    description: '見本のコマンド',
    input: z.object({}),
    output: z.strictObject({}),
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
  title: 'Test command',
  description: '対象を解決する',
  input: z.object({}),
  output: z.strictObject({}),
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
  await explains('`pecot --help` のテストです。`--help` を指定した場合に、使い方（`Usage: pecot`）と `--show-repo` の説明を標準出力に出力し、標準エラーには何も出力しないことを確認します。')
  const result = await run(['--help'])
  expect(result.stdout).toContain('Usage: pecot [OPTIONS] COMMAND [ARGS]...')
  expect(result.stdout).toContain('--show-repo')
  expect(result.stderr).toBe('')
})

it('--help を付けて打つと、終了コード 0 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-02')
  await explains('`pecot --help` の終了コードのテストです。`--help` を指定した場合に、終了コード 0 で終わることを確認します。')
  const result = await run(['--help'])
  expect(result.code).toBe(0)
})

it.for([{ flag: '--version' }, { flag: '-v' }])('$flag を付けて打つと、版を標準出力に出す', async ({ flag }, context) => {
  await verifies(context, 'PW-COMMON-03')
  await explains('`pecot --version` のテストです。`--version` か `-v` を指定した場合に、`pecot version` で始まる版を標準出力に出力し、標準エラーには何も出力しないことを確認します。')
  const result = await run([flag])
  expect(result.stdout).toMatch(/^pecot version \d[^\n]*\n$/u)
  expect(result.stderr).toBe('')
})

it.for([{ flag: '--version' }, { flag: '-v' }])('$flag を付けて打つと、終了コード 0 で終わる', async ({ flag }, context) => {
  await verifies(context, 'PW-COMMON-04')
  await explains('`pecot --version` の終了コードのテストです。`--version` か `-v` を指定した場合に、終了コード 0 で終わることを確認します。')
  const result = await run([flag])
  expect(result.code).toBe(0)
})

it('--show-repo を付けて打つと、解決したリポジトリを標準出力に出す', async (context) => {
  await verifies(context, 'PW-COMMON-05')
  await explains('`--show-repo` のテストです。`--repo` を渡した場合は `explicit` として、渡さない場合は git の `origin` から検出したものとして、解決したリポジトリを標準出力に出力することを確認します。')
  const explicit = await run(['--repo', 'owner/repoA', '--show-repo'])
  expect(explicit).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   explicit\n', stderr: '' })
  const repository = repositoryWithRemotes({ origin: 'git@github.com:owner/repoB.git' })
  const detected = await run(['--show-repo'], [TARGET], repository)
  expect(detected).toEqual({ code: 0, stdout: 'resolved: owner/repoB\nsource:   current-git (origin)\n', stderr: '' })
})

it('対象を決めないコマンドに --repo を渡すと、渡したリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-06')
  await explains('全コマンドに共通の `--repo` のテストです。対象を決める引数を持たないコマンドに `--repo` を渡した場合に、git の remote ではなく、渡したリポジトリを対象にすることを確認します。')
  const repository = repositoryWithRemotes({ origin: 'git@github.com:owner/other.git' })
  const result = await run(['--repo', 'owner/repoA', 'target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   explicit\n', stderr: '' })
  expect(state.started).toBe(1)
})

it('対象を決めないコマンドで --repo を省くと、カレントの git の origin remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-07')
  await explains('全コマンドに共通の `--repo` のテストです。`--repo` を省略した場合に、カレントの git の `origin` remote のリポジトリを対象にすることを確認します。')
  const repository = repositoryWithRemotes({ upstream: 'git@github.com:owner/up.git', origin: 'git@github.com:owner/repoA.git' })
  const result = await run(['target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/repoA\nsource:   current-git (origin)\n', stderr: '' })
})

it('対象を決めないコマンドで --repo を省いて origin remote が無いと、最初の remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-08')
  await explains('全コマンドに共通の `--repo` のテストです。`--repo` を省略し、`origin` remote が存在しない場合に、`git remote` の出力順で最初の remote のリポジトリを対象にすることを確認します。')
  // 最初は git remote の出力順（名前順）。追加した順の先頭（upstream）ではなく fork になる
  const repository = repositoryWithRemotes({ upstream: 'https://github.com/owner/up.git', mirror: 'https://github.com/owner/mirror.git', fork: 'https://github.com/owner/fork.git' })
  const result = await run(['target'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: owner/fork\nsource:   current-git (fork)\n', stderr: '' })
})

it.for([{ argv: ['--no-such-option'] }, { argv: ['target', '--no-such-option'] }])('知らないオプション $argv を渡すと、終了コード 2 で終わる', async ({ argv }, context) => {
  await verifies(context, 'PW-COMMON-09')
  await explains('全コマンドに共通のオプションの検証のテストです。不明なオプション（`--no-such-option`）を渡した場合に、`No such option` を含むエラーを出力して終了コード 2 で終わることを確認します。')
  const result = await run(argv)
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('No such option: --no-such-option')
})

it('--repo が owner/repo の形でないと、終了コード 2 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-10')
  await explains('全コマンドに共通の `--repo` の検証のテストです。`owner/repo` の形でない値を渡した場合に、エラーを出力して終了コード 2 で終わることを確認します。')
  const result = await run(['--repo', 'invalid', '--show-repo'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('Invalid value for \'--repo\'')
  expect(result.stderr).toContain('owner/repo')
})

it('--show-repo でリポジトリを解決できないと、終了コード 2 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-11')
  await explains('`--show-repo` のテストです。git リポジトリの外でリポジトリを解決できない場合に、`repository is ambiguous` のエラーを出力して終了コード 2 で終わることを確認します。')
  const result = await run(['--show-repo'], [TARGET], outsideGit())
  expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: repository is ambiguous: pass --repo <owner/repo>\n' })
})

it('--show-repo で remote の URL から owner/repo を読めないと、その理由の error の行を標準エラーに出す', async (context) => {
  await verifies(context, 'PW-COMMON-21')
  await explains('`--show-repo` のテストです。remote の URL から `owner/repo` を読み取れない場合に、その理由を `error` の行として標準エラーに出力し、終了コード 2 で終わることを確認します。')
  const repository = repositoryWithRemotes({ origin: '/srv/git/demo.git' })
  const result = await run(['--show-repo'], [TARGET], repository)
  expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: could not read the repository from the URL of the Git remote origin\n' })
})

it.for([
  // eslint-disable-next-line unicorn/prefer-https -- remote の URL として http の形を読むことの確認
  { url: 'http://github.com/pecotcraft/pecot.git' },
  { url: 'https://github.com/pecotcraft/pecot.git' },
  { url: 'ssh://git@github.com:22/pecotcraft/pecot.git' },
  { url: 'git://github.com/pecotcraft/pecot.git' },
  { url: 'ftp://github.com/pecotcraft/pecot.git' },
  { url: 'ftps://github.com/pecotcraft/pecot.git' },
  { url: 'git@github.com:pecotcraft/pecot.git' },
  { url: 'gh-alias:pecotcraft/pecot.git' },
  { url: 'git@github.com:/pecotcraft/pecot.git' },
  { url: 'https://github.com/pecotcraft/pecot/' },
])('origin の URL が $url だと、--show-repo で pecotcraft/pecot を出す', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-23')
  await explains('git の `origin` の URL の形式のテストです。`https`・`ssh`・`git@github.com:` などの形式の場合に、いずれも `--show-repo` が `pecotcraft/pecot` を解決して出力することを確認します。')
  const repository = repositoryWithRemotes({ origin: url })
  const result = await run(['--show-repo'], [TARGET], repository)
  expect(result).toEqual({ code: 0, stdout: 'resolved: pecotcraft/pecot\nsource:   current-git (origin)\n', stderr: '' })
})

// ループバックの http の URL ではない値。どれも拒否される
// eslint-disable-next-line unicorn/prefer-https -- http で外部ホストの URL を拒否することの確認
const NON_LOOPBACK_URLS = [{ url: 'https://example.com' }, { url: 'ftp://127.0.0.1' }, { url: 'http://example.com' }]

it.for(NON_LOOPBACK_URLS)('PECOT_GITHUB_API_URL が $url だと、サブコマンドを動かさない', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-12')
  await explains('環境変数 `PECOT_GITHUB_API_URL` の検証のテストです。ループバックの `http` の URL ではない値を指定した場合に、サブコマンドを実行しないことを確認します。')
  setEnvironment({ PECOT_GITHUB_API_URL: url })
  await run(['target'])
  expect(state.started).toBe(0)
})

it.for(NON_LOOPBACK_URLS)('PECOT_GITHUB_API_URL が $url だと、終了コード 1 で終わる', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-13')
  await explains('環境変数 `PECOT_GITHUB_API_URL` の検証のテストです。ループバックの `http` の URL ではない値を指定した場合に、`PECOT_GITHUB_API_URL accepts only` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
  setEnvironment({ PECOT_GITHUB_API_URL: url })
  const result = await run(['target'])
  expect(result.code).toBe(1)
  expect(result.stderr).toBe(`error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: ${url}\n`)
})

it('プロジェクトのルートを決められないと、終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-14')
  await explains('プロジェクトのルートの検索のテストです。ルートを決められない場合に、`project root not found` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
  const directory = outsideGit()
  const root = sample('root', () => {
    projectRoot({ cwd: directory })
  })
  const result = await run(['root'], [root], directory)
  expect(result.code).toBe(1)
  expect(result.stderr.split('\n', 1)[0]).toMatch(/^error: project root not found/u)
})

it.for([{ content: 'not json' }, { content: '{"host":"github.com"}' }])('読み込む設定ファイルの中身が $content だと、終了コード 1 で終わる', async ({ content }, context) => {
  await verifies(context, 'PW-COMMON-15')
  await explains('設定ファイルの読み込みのテストです。中身が JSON でない場合と、必須の項目が存在しない場合に、`invalid config file` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
  const directory = makeTemporaryDirectory('pecot-config-')
  writeTree(directory, { '.pecot/config/projects/broken.json': content, '.pecot/config/projects/.active': 'broken.json\n' })
  setEnvironment({ CLAUDE_PROJECT_DIR: directory })
  const config = sample('config', () => {
    loadActiveConfig()
  })
  const result = await run(['config'], [config], directory)
  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/^error: invalid config file: \S*broken\.json: /u)
})

it('コマンドが捕まえなかった独自の例外が起きると、error の行を標準エラーに出す', async (context) => {
  await verifies(context, 'PW-COMMON-16')
  await explains('コマンドが捕まえなかった独自の例外（`AmbiguousRepositoryError`）のテストです。例外が起きた場合に、メッセージを `error` の行として標準エラーに出力し、2 行目以降を字下げすることを確認します。')
  const root = sample('root', () => {
    throw new AmbiguousRepositoryError('first line\nsecond line')
  })
  const result = await run(['root'], [root])
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('error: first line\n  second line\n')
})

it('コマンドが捕まえなかった独自の例外が起きると、リポジトリが曖昧なときも終了コード 1 で終わる', async (context) => {
  await verifies(context, 'PW-COMMON-17')
  await explains('コマンドが捕まえなかった独自の例外のテストです。リポジトリが曖昧な場合に、メッセージを `error` の行として標準エラーに出力し、終了コード 1 で終わることを確認します。')
  const ambiguous = sample('ambiguous', () => {
    resolveRepository(undefined, gitRunnerFor(state.cwd))
  })
  const result = await run(['ambiguous'], [ambiguous], outsideGit())
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('error: repository is ambiguous: pass --repo <owner/repo>\n')
})
