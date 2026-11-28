// 全ツールに共通の振る舞い（PW-COMMON-*）を、見本のツールを MCP のサーバに載せて確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 定義の型は readonly にできない */
import path from 'node:path'

import { z } from 'zod'
import { it, expect } from 'vitest'

import { defineTool } from '../../src/commands/registry.js'
import type { ToolDefinition } from '../../src/commands/registry.js'
import { exitWith } from '../../src/commands/tests/support.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { AmbiguousRepositoryError, repositoryFullName, resolveRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { gitRunnerFor } from '@pecot/workflow-core/infra/git.js'
import { loadActiveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { projectRoot } from '@pecot/workflow-core/infra/paths.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { explains } from '../_helpers/explains.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'
import { step, stepSync } from '../_helpers/step.js'

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
  const repository = stepSync('remote を持つリポジトリを用意する', () => repositoryWithRemotes({ origin: 'git@github.com:owner/other.git' }))
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, { repo: 'owner/repoA' }, repository))
  stepSync('ツールの本体が動いた回数・結果の文を確かめる', () => {
    expect(result).toEqual({ isError: false, structured: {}, text: 'owner/repoA (explicit)' })
    expect(state.started).toBe(1)
  })
})

it('対象を決めないツールで repo を省くと、カレントの git の origin remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-07')
  await explains('全ツールに共通の `repo` の入力のテストです。`repo` を省略した場合に、カレントの git の `origin` remote のリポジトリを対象にすることを確認します。')
  const repository = stepSync('remote を持つリポジトリを用意する', () => repositoryWithRemotes({ upstream: 'git@github.com:owner/up.git', origin: 'git@github.com:owner/repoA.git' }))
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, {}, repository))
  stepSync('結果の文を確かめる', () => {
    expect(result.text).toBe('owner/repoA (origin)')
  })
})

it('対象を決めないツールで repo を省いて origin remote が無いと、最初の remote のリポジトリを対象にする', async (context) => {
  await verifies(context, 'PW-COMMON-08')
  await explains('全ツールに共通の `repo` の入力のテストです。`repo` を省略し、`origin` remote が存在しない場合に、`git remote` の出力順で最初の remote のリポジトリを対象にすることを確認します。')
  // 最初は git remote の出力順（名前順）。追加した順の先頭（upstream）ではなく fork になる
  const repository = stepSync('remote を持つリポジトリを用意する', () => repositoryWithRemotes({ upstream: 'https://github.com/owner/up.git', mirror: 'https://github.com/owner/mirror.git', fork: 'https://github.com/owner/fork.git' }))
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, {}, repository))
  stepSync('結果の文を確かめる', () => {
    expect(result.text).toBe('owner/fork (fork)')
  })
})

it('repo が owner/repo の形でないと、入力の誤りとして失敗する', async (context) => {
  await verifies(context, 'PW-COMMON-10')
  await explains('全ツールに共通の `repo` の入力の検証のテストです。`owner/repo` の形でない値を渡した場合に、`owner/repo` の形を求める文を持つ入力の誤りとして失敗することを確認します。')
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, { repo: 'invalid' }))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    expect(result.structured['detail']).toContain('owner/repo')
  })
})

it('remote の URL から owner/repo を読めないと、その理由を失敗の detail に入れる', async (context) => {
  await verifies(context, 'PW-COMMON-21')
  await explains('対象のリポジトリの解決のテストです。`repo` を省略し、remote の URL から `owner/repo` を読み取れない場合に、その理由を失敗の `detail` に入れることを確認します。')
  const repository = stepSync('remote を持つリポジトリを用意する', () => repositoryWithRemotes({ origin: '/srv/git/demo.git' }))
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, {}, repository))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result).toMatchObject({ isError: true, structured: { detail: 'could not read the repository from the URL of the Git remote origin' } })
  })
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
  const repository = stepSync('remote を持つリポジトリを用意する', () => repositoryWithRemotes({ origin: url }))
  const result = await step('対象を決めるツールを動かす', () => call(TARGET, {}, repository))
  stepSync('結果の文を確かめる', () => {
    expect(result.text).toBe('pecotcraft/pecot (origin)')
  })
})

it('プロジェクトのルートを決められないと、その理由を示して失敗する', async (context) => {
  await verifies(context, 'PW-COMMON-14')
  await explains('プロジェクトのルートの検索のテストです。ルートを決められない場合に、`project root not found` で始まる `detail` を持つ失敗を返すことを確認します。')
  const directory = stepSync('git の外のディレクトリを用意する', () => outsideGit())
  const root = stepSync('見本のツールを用意する', () => sample('root_show', () => {
    projectRoot({ cwd: directory })
  }))
  const result = await step('見本のツールを動かす', () => call(root, {}, directory))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result.isError).toBe(true)
    expect(result.structured['detail']).toMatch(/^project root not found/u)
  })
})

it.for([{ content: 'not json' }, { content: '{"host":"github.com"}' }])('読み込む設定ファイルの中身が $content だと、その理由を示して失敗する', async ({ content }, context) => {
  await verifies(context, 'PW-COMMON-15')
  await explains('設定ファイルの読み込みのテストです。中身が JSON でない場合と、必須の項目が存在しない場合に、`invalid config file` で始まる `detail` を持つ失敗を返すことを確認します。')
  const directory = stepSync('中身の誤った設定ファイルを置く', () => {
    const directory = makeTemporaryDirectory('pecot-config-')
    writeTree(directory, { '.pecot/config/projects/broken.json': content, '.pecot/config/projects/.active': 'broken.json\n' })
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    return directory
  })
  const config = stepSync('見本のツールを用意する', () => sample('config_show', () => {
    loadActiveConfig()
  }))
  const result = await step('見本のツールを動かす', () => call(config, {}, directory))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result.isError).toBe(true)
    expect(result.structured['detail']).toMatch(/^invalid config file: \S*broken\.json: /u)
  })
})

it('ツールが捕まえなかった独自の例外が起きると、その文を失敗の detail に入れる', async (context) => {
  await verifies(context, 'PW-COMMON-16')
  await explains('ツールが捕まえなかった独自の例外（`AmbiguousRepositoryError`）のテストです。例外が起きた場合に、メッセージを失敗の `detail` に入れ、2 行目以降を字下げすることを確認します。')
  const root = stepSync('見本のツールを用意する', () => sample('root_show', () => {
    throw new AmbiguousRepositoryError('first line\nsecond line')
  }))
  const result = await step('見本のツールを動かす', () => call(root))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result).toMatchObject({ isError: true, structured: { detail: 'first line\n  second line' } })
  })
})

it('ツールが捕まえなかった独自の例外が起きると、リポジトリが曖昧なときも kind が other の失敗を返す', async (context) => {
  await verifies(context, 'PW-COMMON-17')
  await explains('ツールが捕まえなかった独自の例外のテストです。git リポジトリの外でリポジトリが曖昧な場合に、`kind` が `other` で、`repo` の指定を求める `detail` を持つ失敗を返すことを確認します。')
  const ambiguous = stepSync('見本のツールを用意する', () => sample('ambiguous_show', () => {
    resolveRepository(undefined, gitRunnerFor(state.cwd))
  }))
  const result = await step('見本のツールを動かす', () => call(ambiguous, {}, outsideGit()))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result).toMatchObject({ isError: true, structured: { kind: 'other' } })
    expect(result.structured['detail']).toMatch(/^repository is ambiguous: /u)
  })
})

// 進んだ項目を結果に入れてから止まる見本。止まる前の文の数を変えられる
function stopping(name: string, messages: readonly string[]): ToolDefinition {
  const earlier = messages.slice(0, -1)
  const last = messages.at(-1) ?? 'boom'
  const run = (_input: unknown, io: CommandIo): never => {
    const out = createOutput<{ moved: number[] }>(false, io)
    out.result({ moved: [13] })
    for (const message of earlier) out.error(message)
    return stopWith(out, last, 'other')
  }
  const output = z.strictObject({ moved: z.array(z.int()).optional() })
  return defineTool({ name, title: 'Test tool', description: '進んでから止まる', input: z.object({}), output, run })
}

it('ツールが進んだ後に失敗すると、isError・kind・detail と進んだ項目を最上位に入れて返す', async (context) => {
  await verifies(context, 'PW-COMMON-18')
  await explains('MCP のツールの失敗の結果のテストです。結果に項目を入れた後で止まった場合に、`isError` を `true` にし、`kind`・`detail` と進んだ項目を最上位に入れて返すことを確認します。')
  const result = await step('見本のツールを動かす', () => call(stopping('moved_show', ['boom'])))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result).toMatchObject({ isError: true })
    expect(result.structured).toEqual({ moved: [13], kind: 'other', detail: 'boom' })
  })
})

it('失敗の文が 2 つ以上あると、error の前置きを付けずに改行でつないで detail に入れる', async (context) => {
  await verifies(context, 'PW-COMMON-26')
  await explains('MCP のツールの失敗の文のテストです。止まるまでに失敗の文を 2 つ出した場合に、どちらにも `error: ` を付けず、改行でつないで `detail` に入れることを確認します。')
  const result = await step('見本のツールを動かす', () => call(stopping('twice_show', ['first', 'second'])))
  stepSync('失敗の kind と detail を確かめる', () => {
    expect(result.structured['detail']).toBe('first\nsecond')
  })
})

// 結果の行を出す見本。本題でない片付けの行を先に、本題の行を後に出す
const RESULT_LINES = defineTool({
  name: 'result_lines',
  title: 'Test tool',
  description: '結果の行を出す',
  input: z.object({}),
  output: z.strictObject({}),
  run: async (_input, io) => {
    const output = createOutput(false, io)
    output.done({ verb: 'delete', target: 'branch old', aside: true })
    output.done({ verb: 'create', target: 'issue #1' })
    return await exitWith(0)
  },
})

// 結果の行を出さず、標準出力だけに書く見本
const STDOUT_ONLY = defineTool({
  name: 'stdout_only',
  title: 'Test tool',
  description: '標準出力だけに書く',
  input: z.object({}),
  output: z.strictObject({}),
  run: async (_input, io) => {
    io.stdout('\n  first\nsecond\n')
    return await exitWith(0)
  },
})

it('成功して結果の行を出すと、片付けの行を除いた最初の行を content の最初の text にする', async (context) => {
  await verifies(context, 'PW-COMMON-29')
  await verifies(context, 'PW-COMMON-31')
  await explains('MCP の成功の応答のテストです。片付けの行の後に結果の行を出した場合に、結果の行が `content` の最初の text になり、最後の text が `structuredContent` と同じ JSON であることを確認します。')
  const result = await step('結果の行を出すツールを呼ぶ', async () => await call(RESULT_LINES))
  await step('最初の text と構造化された結果を確認する', () => {
    expect(result).toEqual({ isError: false, structured: {}, text: 'created: issue #1' })
  })
})

it('成功して結果の行を出さないと、標準出力の最初の空でない行を content の最初の text にする', async (context) => {
  await verifies(context, 'PW-COMMON-30')
  await explains('MCP の成功の応答のテストです。結果の行を出さず、先頭に空行と字下げのある標準出力だけを書いた場合に、最初の空でない行が `content` の最初の text になることを確認します。')
  const result = await step('標準出力だけに書くツールを呼ぶ', async () => await call(STDOUT_ONLY))
  await step('最初の text を確認する', () => {
    expect(result.text).toBe('first')
  })
})
