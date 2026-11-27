// 全ツールに共通の振る舞い（PW-COMMON-*）を、見本のツールを MCP のサーバに載せて確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 定義の型は readonly にできない */
import path from 'node:path'

import { z } from 'zod'
import { it, expect } from 'vitest'

import { defineTool } from '../../src/commands/registry.js'
import type { ToolDefinition } from '../../src/commands/registry.js'
import { exitWith } from '../../src/commands/tests/support.js'
import { AmbiguousRepositoryError, repositoryFullName, resolveRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { gitRunnerFor } from '@pecot/workflow-core/infra/git.js'
import { loadActiveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { projectRoot } from '@pecot/workflow-core/infra/paths.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { explains } from '../_helpers/explains.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

// 見本のツールが動いた回数と、run が使う作業ディレクトリ
const state = { started: 0, cwd: process.cwd() }

function sample(name: string, body: () => void | Promise<void>): ToolDefinition {
  return defineTool({
    name,
    title: 'Test tool',
    description: '見本のツール',
    input: z.object({}),
    output: z.strictObject({}),
    run: async () => {
      state.started += 1
      await body()
      return await exitWith(0)
    },
  })
}

// 対象を決める入力を持たない見本。解決したリポジトリと解決元を、結果の文に出す
const TARGET = defineTool({
  name: 'target_show',
  title: 'Test tool',
  description: '対象を解決する',
  input: z.object({}),
  output: z.strictObject({}),
  run: async (input, io) => {
    state.started += 1
    const resolved = resolveRepository(input.repo, gitRunnerFor(state.cwd))
    io.stdout(`${repositoryFullName(resolved.repository)} (${resolved.source === 'explicit' ? 'explicit' : resolved.remoteName ?? ''})\n`)
    return await exitWith(0)
  },
})

async function call(tool: ToolDefinition, arguments_: Readonly<Record<string, unknown>> = {}, cwd = process.cwd()): Promise<ToolOutcome> {
  state.cwd = cwd
  state.started = 0
  return await callToolOnce([tool], tool.name, arguments_)
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

it('対象を決めないツールに repo を渡すと、渡したリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-06')
  await explains('全ツールに共通の `repo` の入力のテストです。対象を決める入力を持たないツールに `repo` を渡した場合に、git の remote ではなく、渡したリポジトリを対象にすることを確認します。')
  const repository = repositoryWithRemotes({ origin: 'git@github.com:owner/other.git' })
  const result = await call(TARGET, { repo: 'owner/repoA' }, repository)
  expect(result).toEqual({ isError: false, structured: {}, text: 'owner/repoA (explicit)' })
  expect(state.started).toBe(1)
})

it('対象を決めないツールで repo を省くと、カレントの git の origin remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-07')
  await explains('全ツールに共通の `repo` の入力のテストです。`repo` を省略した場合に、カレントの git の `origin` remote のリポジトリを対象にすることを確認します。')
  const repository = repositoryWithRemotes({ upstream: 'git@github.com:owner/up.git', origin: 'git@github.com:owner/repoA.git' })
  const result = await call(TARGET, {}, repository)
  expect(result.text).toBe('owner/repoA (origin)')
})

it('対象を決めないツールで repo を省いて origin remote が無いと、最初の remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-08')
  await explains('全ツールに共通の `repo` の入力のテストです。`repo` を省略し、`origin` remote が存在しない場合に、`git remote` の出力順で最初の remote のリポジトリを対象にすることを確認します。')
  // 最初は git remote の出力順（名前順）。追加した順の先頭（upstream）ではなく fork になる
  const repository = repositoryWithRemotes({ upstream: 'https://github.com/owner/up.git', mirror: 'https://github.com/owner/mirror.git', fork: 'https://github.com/owner/fork.git' })
  const result = await call(TARGET, {}, repository)
  expect(result.text).toBe('owner/fork (fork)')
})

it('repo が owner/repo の形でないと、入力の誤りとして失敗する', async (context) => {
  await verifies(context, 'PW-COMMON-10')
  await explains('全ツールに共通の `repo` の入力の検証のテストです。`owner/repo` の形でない値を渡した場合に、`owner/repo` の形を求める文を持つ入力の誤りとして失敗することを確認します。')
  const result = await call(TARGET, { repo: 'invalid' })
  expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
  expect(result.structured['detail']).toContain('owner/repo')
})

it('remote の URL から owner/repo を読めないと、その理由を失敗の detail に入れる', async (context) => {
  await verifies(context, 'PW-COMMON-21')
  await explains('対象のリポジトリの解決のテストです。`repo` を省略し、remote の URL から `owner/repo` を読み取れない場合に、その理由を失敗の `detail` に入れることを確認します。')
  const repository = repositoryWithRemotes({ origin: '/srv/git/demo.git' })
  const result = await call(TARGET, {}, repository)
  expect(result).toMatchObject({ isError: true, structured: { detail: 'could not read the repository from the URL of the Git remote origin' } })
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
])('origin の URL が $url だと、pecotcraft/pecot を対象にする', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-23')
  await explains('git の `origin` の URL の形式のテストです。`https`・`ssh`・`git@github.com:` などの形式の場合に、いずれも `pecotcraft/pecot` を対象のリポジトリにすることを確認します。')
  const repository = repositoryWithRemotes({ origin: url })
  const result = await call(TARGET, {}, repository)
  expect(result.text).toBe('pecotcraft/pecot (origin)')
})

// ループバックの http の URL ではない値。どれも拒否される
// eslint-disable-next-line unicorn/prefer-https -- http で外部ホストの URL を拒否することの確認
const NON_LOOPBACK_URLS = [{ url: 'https://example.com' }, { url: 'ftp://127.0.0.1' }, { url: 'http://example.com' }]

it.for(NON_LOOPBACK_URLS)('PECOT_GITHUB_API_URL が $url だと、ツールの本体を動かさない', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-12')
  await explains('環境変数 `PECOT_GITHUB_API_URL` の検証のテストです。ループバックの `http` の URL ではない値を指定した場合に、ツールの本体を実行しないことを確認します。')
  setEnvironment({ PECOT_GITHUB_API_URL: url })
  await call(TARGET)
  expect(state.started).toBe(0)
})

it.for(NON_LOOPBACK_URLS)('PECOT_GITHUB_API_URL が $url だと、受け付ける URL を示して失敗する', async ({ url }, context) => {
  await verifies(context, 'PW-COMMON-13')
  await explains('環境変数 `PECOT_GITHUB_API_URL` の検証のテストです。ループバックの `http` の URL ではない値を指定した場合に、受け付ける URL を示す `detail` を持つ失敗を返すことを確認します。')
  setEnvironment({ PECOT_GITHUB_API_URL: url })
  const result = await call(TARGET)
  expect(result).toMatchObject({ isError: true, structured: { detail: `PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: ${url}` } })
})

it('プロジェクトのルートを決められないと、その理由を示して失敗する', async (context) => {
  await verifies(context, 'PW-COMMON-14')
  await explains('プロジェクトのルートの検索のテストです。ルートを決められない場合に、`project root not found` で始まる `detail` を持つ失敗を返すことを確認します。')
  const directory = outsideGit()
  const root = sample('root_show', () => {
    projectRoot({ cwd: directory })
  })
  const result = await call(root, {}, directory)
  expect(result.isError).toBe(true)
  expect(result.structured['detail']).toMatch(/^project root not found/u)
})

it.for([{ content: 'not json' }, { content: '{"host":"github.com"}' }])('読み込む設定ファイルの中身が $content だと、その理由を示して失敗する', async ({ content }, context) => {
  await verifies(context, 'PW-COMMON-15')
  await explains('設定ファイルの読み込みのテストです。中身が JSON でない場合と、必須の項目が存在しない場合に、`invalid config file` で始まる `detail` を持つ失敗を返すことを確認します。')
  const directory = makeTemporaryDirectory('pecot-config-')
  writeTree(directory, { '.pecot/config/projects/broken.json': content, '.pecot/config/projects/.active': 'broken.json\n' })
  setEnvironment({ CLAUDE_PROJECT_DIR: directory })
  const config = sample('config_show', () => {
    loadActiveConfig()
  })
  const result = await call(config, {}, directory)
  expect(result.isError).toBe(true)
  expect(result.structured['detail']).toMatch(/^invalid config file: \S*broken\.json: /u)
})

it('ツールが捕まえなかった独自の例外が起きると、その文を失敗の detail に入れる', async (context) => {
  await verifies(context, 'PW-COMMON-16')
  await explains('ツールが捕まえなかった独自の例外（`AmbiguousRepositoryError`）のテストです。例外が起きた場合に、メッセージを失敗の `detail` に入れ、2 行目以降を字下げすることを確認します。')
  const root = sample('root_show', () => {
    throw new AmbiguousRepositoryError('first line\nsecond line')
  })
  const result = await call(root)
  expect(result).toMatchObject({ isError: true, structured: { detail: 'first line\n  second line' } })
})

it('ツールが捕まえなかった独自の例外が起きると、リポジトリが曖昧なときも kind が other の失敗を返す', async (context) => {
  await verifies(context, 'PW-COMMON-17')
  await explains('ツールが捕まえなかった独自の例外のテストです。git リポジトリの外でリポジトリが曖昧な場合に、`kind` が `other` で、`repo` の指定を求める `detail` を持つ失敗を返すことを確認します。')
  const ambiguous = sample('ambiguous_show', () => {
    resolveRepository(undefined, gitRunnerFor(state.cwd))
  })
  const result = await call(ambiguous, {}, outsideGit())
  expect(result).toMatchObject({ isError: true, structured: { kind: 'other' } })
  expect(result.structured['detail']).toMatch(/^repository is ambiguous: /u)
})
