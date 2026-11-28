/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PecotError } from '@pecot/workflow-core/domain/errors.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { SESSION_FINISH_TOOLS } from '../../commands/session-finish.js'
import { abortUnconfirmed, createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '../../commands/registry.js'
import type { ToolDefinition } from '../../commands/registry.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { exitWith, failWith, throwFailure } from '../../commands/tests/support.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { prepareProject } from '../../../tests/_helpers/board-issue-case.js'
import { connectInMemory, outcomeOf, outputSchemaIssues, structuredOf, toolOutcomeOf } from '../../../tests/_helpers/mcp-client.js'
import type { ConnectedClient } from '../../../tests/_helpers/mcp-client.js'
import { createMcpServer } from '../server.js'
import type { McpServerOptions } from '../server.js'

useIsolatedEnvironment()

const calls: unknown[] = []

const TOOLS: readonly ToolDefinition[] = [
  defineTool({
    name: 'echo',
    title: 'Test tool',
    description: '入力を返す',
    input: z.object({ text: z.string(), count: z.int().optional(), flag: z.boolean().optional() }),
    output: z.strictObject({}),
    run: async (input, io) => {
      calls.push(input)
      io.stdout(`echo ${input.text}\n`)
      io.stderr('note\n')
      return await exitWith(0)
    },
  }),
  defineTool({
    name: 'exit_three',
    title: 'Test tool',
    description: '3 で終わる',
    input: z.object({}),
    output: z.strictObject({}),
    run: async (_input, io) => {
      io.stdout('partial\n')
      return await exitWith(3)
    },
  }),
  defineTool({
    name: 'ask',
    title: 'Test tool',
    description: '確認を求める',
    input: z.object({}),
    output: z.strictObject({}),
    run: async (_input, io) => {
      await exitWith(0)
      return abortUnconfirmed(io, 'Overwrite?')
    },
  }),
  defineTool({
    name: 'bad_parameter',
    title: 'Test tool',
    description: 'context の無い使い方の誤り',
    input: z.object({}),
    output: z.strictObject({}),
    run: async () => await throwFailure(new UsageError('Invalid value for x')),
  }),
  defineTool({
    name: 'pecot_failure',
    title: 'Test tool',
    description: '報告できる失敗',
    input: z.object({}),
    output: z.strictObject({}),
    run: async () => await throwFailure(new PecotError('ルートがありません')),
  }),
  defineTool({
    name: 'bug',
    title: 'Test tool',
    description: 'プログラムの誤り',
    input: z.object({}),
    output: z.strictObject({}),
    run: async () => await failWith('boom'),
  }),
  defineTool({
    name: 'own_repo',
    title: 'Test tool',
    description: '自分の repo を持つ',
    input: z.object({ repo: z.string() }),
    hasOwnRepo: true,
    output: z.strictObject({}),
    run: async (input, io) => {
      io.stdout(`${input.repo}\n`)
      return await exitWith(0)
    },
  }),
  defineTool({
    name: 'slow',
    title: 'Test tool',
    description: '時間がかかる',
    input: z.object({ name: z.string() }),
    output: z.strictObject({}),
    run: async (input, io) => {
      calls.push(`start ${input.name}`)
      await new Promise((resolve) => {
        setTimeout(resolve, input.name === 'first' ? 30 : 0)
      })
      calls.push(`end ${input.name}`)
      io.stdout(`${input.name}\n`)
      return 0
    },
  }),
]

const TYPED_OUTPUT = z.strictObject({ name: z.string(), count: z.int().optional() })

// mode で、合う項目・合わない項目・途中まで進んだ失敗を返す
const TYPED = defineTool({
  name: 'typed',
  title: 'Test tool',
  description: '型のある項目を返す',
  input: z.object({ mode: z.enum(['ok', 'twice', 'wrong', 'fail', 'fail-wrong', 'crash', 'crash-wrong']) }),
  output: TYPED_OUTPUT,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof TYPED_OUTPUT>>(false, io)
    out.warning('slow API')
    if (input.mode === 'wrong') {
      out.done({ verb: 'create', target: 'issue #1' })
      out.result({ count: 1 })
      return await exitWith(0)
    }
    if (input.mode === 'fail' || input.mode === 'fail-wrong') {
      out.result({ name: 'x', count: input.mode === 'fail' ? 2 : 2.5 })
      out.error('half done\nhint: retry')
      return await exitWith(1, 'github-api')
    }
    if (input.mode === 'crash' || input.mode === 'crash-wrong') {
      out.result({ count: input.mode === 'crash' ? 4 : 4.5 })
      return await failWith('boom')
    }
    out.result({ name: 'a' })
    if (input.mode === 'twice') out.result({ name: 'b', count: 3 })
    return await exitWith(0)
  },
})

const opened: ConnectedClient[] = []
const unexpected: unknown[] = []

async function open(tools: readonly ToolDefinition[], options: Readonly<McpServerOptions> = {}): Promise<ConnectedClient> {
  const connected = await connectInMemory(createMcpServer(tools, options))
  opened.push(connected)
  return connected
}

async function connect(): Promise<ConnectedClient> {
  return await open(TOOLS, {
    reportUnexpected: (error) => {
      unexpected.push(error)
    },
  })
}

async function call(name: string, arguments_: Readonly<Record<string, unknown>> = {}): Promise<Awaited<ReturnType<ConnectedClient['client']['callTool']>>> {
  const { client } = await connect()
  return await client.callTool({ name, arguments: { ...arguments_ } })
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (connected) => {
    await connected.close()
  }))
  calls.length = 0
  unexpected.length = 0
})

describe('ツールの呼び出し', () => {
  it('終了コードが 0 なら、stdout と stderr を載せず、文と JSON の 2 つの text にして、isError を付けずに返す', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。コマンドが終了コード 0 で終わる場合に、結果の行の文と `structuredContent` と同じ JSON の 2 つの `text` だけを返し、`isError` を付けないことを確認します。')
    const result = await call('echo', { text: 'hi', count: 2 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({})
    expect(result.content).toEqual([{ type: 'text', text: 'echo hi' }, { type: 'text', text: '{}' }])
    expect(calls).toEqual([{ text: 'hi', count: 2 }])
  })

  it('終了コードが 0 でなければ、isError を付けて、kind と detail を返す', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。コマンドが 0 以外の終了コードで終わる場合に、`isError` を付けて、`kind` が `other` の失敗を返すことを確認します。')
    const result = await call('exit_three')
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'other', detail: '' })
  })

  it('確認が要る所で問わずに止めると、detail が Aborted. の失敗を返す', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。ツールが確認の要る所で問い合わせないで止まった場合に、`Overwrite?` と `Aborted.` を `detail` に持つ失敗を返すことを確認します。')
    const result = await call('ask')
    expect(outcomeOf(result)).toEqual({ isError: true, detail: 'Overwrite?\nAborted.', warnings: [] })
  })

  it('コマンドの本体が使い方の誤りを投げると、例外の文だけを detail にして invalid-input の失敗にする', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。コマンドの本体が使い方の誤りを投げた場合に、例外の文だけを `detail` にし、`kind` を `invalid-input` にすることを確認します。')
    const result = await call('bad_parameter')
    const structured = outcomeOf(result)
    expect(structured.isError).toBe(true)
    expect(structured.detail).toBe('Invalid value for x')
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
  })

  it('報告できる失敗は、error の行の文を detail と text に入れる', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。コマンドが報告できる失敗を投げた場合に、その文を `detail` と文の `text` に入れ、`kind` が `other` になることを確認します。')
    const result = await call('pecot_failure')
    expect(outcomeOf(result)).toEqual({ isError: true, detail: 'ルートがありません', warnings: [] })
    expect(toolOutcomeOf(result)).toMatchObject({ text: 'ルートがありません', structured: { kind: 'other' } })
  })

  it('想定外の例外は、kind が other の JSON の結果にして、報告先にも通知する', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。コマンドが想定外の例外を投げた場合に、`kind` が `other` の結果を返し、報告先にも例外を 1 件通知することを確認します。')
    const result = await call('bug')
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'other', detail: 'boom' })
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }, { type: 'text', text: JSON.stringify(result.structuredContent) }])
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(Error)
  })

  it('報告先が存在しなくても、想定外の例外は isError の結果になる', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。報告先を指定せずにコマンドが想定外の例外を投げた場合に、`isError` が付いた結果を返すことを確認します。')
    const { client } = await open(TOOLS)
    const result = await client.callTool({ name: 'bug', arguments: {} })
    expect(result.isError).toBe(true)
  })

  it('独自の repo を持つコマンドの repo は、コマンド自身の入力として渡す', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。独自の `repo` の入力を持つコマンドを呼んだ場合に、`repo` をグローバルの入力として扱わず、コマンド自身の入力として渡すことを確認します。')
    const result = await call('own_repo', { repo: 'acme/demo' })
    expect(toolOutcomeOf(result)).toEqual({ isError: false, text: 'acme/demo', structured: {} })
  })

  it('呼び出しが並行に来ても、1 件ずつ順に実行する', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。時間のかかるコマンドを 2 件同時に呼んだ場合に、1 件目が終わってから 2 件目を開始する順に実行することを確認します。')
    const { client } = await connect()
    const results = await Promise.all([
      client.callTool({ name: 'slow', arguments: { name: 'first' } }),
      client.callTool({ name: 'slow', arguments: { name: 'second' } }),
    ])
    expect(results.map(result => result.isError)).toEqual([undefined, undefined])
    expect(calls).toEqual(['start first', 'end first', 'start second', 'end second'])
  })

  it('想定外の例外で終わった呼び出しの後でも、次の呼び出しは実行される', async () => {
    await explains('MCP サーバーのツール呼び出しのテストです。1 件目が想定外の例外で失敗した場合でも、続けて呼んだ 2 件目が正常に実行されることを確認します。')
    const { client } = await connect()
    const [broken, fine] = await Promise.all([
      client.callTool({ name: 'bug', arguments: {} }),
      client.callTool({ name: 'echo', arguments: { text: 'after' } }),
    ])
    expect(broken.isError).toBe(true)
    expect(toolOutcomeOf(fine)).toMatchObject({ isError: false, text: 'echo after' })
  })
})

describe('PECOT_GITHUB_API_URL', () => {
  it('ループバックの http でなければ、入力の検証より先に失敗を返し、detail は error の行の文にする', async () => {
    await explains('環境変数 `PECOT_GITHUB_API_URL` のテストです。`https://example.com` のようにループバックの http でない値を設定した場合に、入力の検証より先に失敗を返し、コマンドを実行しないことを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://example.com' })
    const result = await call('echo', { unknown: true })
    expect(outcomeOf(result)).toEqual({
      isError: true,
      detail: 'PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: https://example.com',
      warnings: [],
    })
    expect(calls).toEqual([])
  })

  it('ループバックの http なら、そのまま実行する', async () => {
    await explains('環境変数 `PECOT_GITHUB_API_URL` のテストです。`http://127.0.0.1` のループバックの URL を設定した場合に、コマンドをそのまま実行することを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.0.0.1:9' })
    const result = await call('echo', { text: 'hi' })
    expect(toolOutcomeOf(result)).toMatchObject({ isError: false, text: 'echo hi' })
  })
})

describe('入力の検証の誤り', () => {
  it('定義に存在しないキーが複数あると、すべてを名指しして、コマンドの本体を実行しない', async () => {
    await explains('ツールの入力の検証のテストです。入力の定義にないキーを 2 つ渡した場合に、すべてのキーを示す `invalid-input` の失敗を返し、コマンドの本体を実行しないことを確認します。')
    const result = await call('echo', { text: 'hi', one: 1, two: 2 })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown keys \'one\', \'two\'' })
    expect(calls).toEqual([])
  })

  it('グローバルの repo が owner/repo の形でないと、コマンドの本体を実行しない', async () => {
    await explains('ツールの入力の検証のテストです。グローバルの `repo` に `owner/repo` の形でない値を渡した場合に、`invalid-input` の失敗を返し、コマンドの本体を実行しないことを確認します。')
    const result = await call('echo', { text: 'hi', repo: 'nope' })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('invalid input: repo: ')
    expect(calls).toEqual([])
  })

  it('グローバルの repo が owner/repo の形なら受け付ける', async () => {
    await explains('ツールの入力の検証のテストです。グローバルの `repo` に `owner/repo` の形の値を渡した場合に、検証を通り、コマンドの本体にその値を渡すことを確認します。')
    const result = await call('echo', { text: 'hi', repo: 'acme/demo' })
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual([{ text: 'hi', repo: 'acme/demo' }])
  })

  it('型が違う入力は、入力の名前を添えて拒否する', async () => {
    await explains('ツールの入力の検証のテストです。真偽値の入力に文字列を渡した場合に、入力の名前を含む `invalid-input` の失敗を返し、コマンドの本体を実行しないことを確認します。')
    const result = await call('echo', { text: 'hi', flag: 'true' })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('invalid input: flag: ')
    expect(calls).toEqual([])
  })

  it('必須の入力が存在しないと、入力の名前を添えて拒否する', async () => {
    await explains('ツールの入力の検証のテストです。必須の入力を渡さなかった場合に、入力の名前を含む `invalid-input` の失敗を返すことを確認します。')
    const result = await call('echo')
    expect(outcomeOf(result).detail).toContain('invalid input: text: ')
  })

  it('検証の途中で想定外の例外が発生しても、isError の結果にして、報告先にも通知する', async () => {
    await explains('ツールの入力の検証のテストです。入力の検証の途中で想定外の例外が発生した場合に、`isError` の結果を返し、報告先にも例外を 1 件通知することを確認します。')
    const broken = defineTool({
      name: 'broken',
      title: 'Test tool',
      description: '検証が誤っている',
      input: z.object({}).refine(() => {
        throw new TypeError('refine bug')
      }),
      output: z.strictObject({}),
      run: async () => await exitWith(0),
    })
    const { client } = await open([broken], { reportUnexpected: (error) => {
      unexpected.push(error)
    } })
    const result = await client.callTool({ name: 'broken', arguments: {} })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'other', detail: 'refine bug' })
    expect(unexpected).toHaveLength(1)
  })

  it('待機中にキャンセルされた呼び出しは、コマンドの本体を実行しない', async () => {
    await explains('ツールのキャンセルのテストです。先行する呼び出しの完了を待っている間にキャンセルした場合は、その呼び出しは拒否され、コマンドの本体を実行しないことを確認します。')
    const { client } = await connect()
    const first = client.callTool({ name: 'slow', arguments: { name: 'first' } })
    const controller = new AbortController()
    const second = client.callTool({ name: 'slow', arguments: { name: 'second' } }, { signal: controller.signal })
    const settled = Promise.allSettled([second])
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
    controller.abort()
    const results = await settled
    expect(results.map(entry => entry.status)).toEqual(['rejected'])
    await first
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(calls).toEqual(['start first', 'end first'])
  })

  it('実行中の呼び出しがキャンセルされると、コマンドが受け取った io の signal が中断される', async () => {
    await explains('ツールのキャンセルのテストです。実行中の呼び出しをキャンセルした場合に、コマンドが受け取った `io.signal` の `abort` が発火し、呼び出しが拒否されることを確認します。')
    const started = Promise.withResolvers<boolean>()
    const aborted = Promise.withResolvers<boolean>()
    const waiting = defineTool({
      name: 'waiting',
      title: 'Test tool',
      description: '取り消しを待つ',
      input: z.object({}),
      output: z.strictObject({}),
      run: async (_input, io) => {
        io.signal?.addEventListener('abort', () => {
          aborted.resolve(true)
        }, { once: true })
        started.resolve(true)
        await aborted.promise
        return await exitWith(0)
      },
    })
    const { client } = await open([waiting])
    const controller = new AbortController()
    const settled = Promise.allSettled([client.callTool({ name: 'waiting', arguments: {} }, { signal: controller.signal })])
    await started.promise
    controller.abort()
    expect(await aborted.promise).toBe(true)
    const results = await settled
    expect(results.map(entry => entry.status)).toEqual(['rejected'])
  })

  it('順番を待つ間に取り消された呼び出しは、コマンドを実行せず、取り消しの理由を通知する', async () => {
    await explains('ツールのキャンセルのテストです。順番待ちの呼び出しを理由つきで取り消した場合に、そのコマンドを実行せず、`reportCancelled` に取り消しの理由を渡すことを確認します。')
    const started = Promise.withResolvers<boolean>()
    const release = Promise.withResolvers<boolean>()
    const ran: string[] = []
    const first = defineTool({
      name: 'first',
      title: 'Test tool',
      description: '先に動いて待つ',
      input: z.object({}),
      output: z.strictObject({}),
      run: async () => {
        started.resolve(true)
        await release.promise
        return await exitWith(0)
      },
    })
    const second = defineTool({
      name: 'second',
      title: 'Test tool',
      description: '後に並ぶ',
      input: z.object({}),
      output: z.strictObject({}),
      run: async () => {
        ran.push('second')
        return await exitWith(0)
      },
    })
    const reasons: string[] = []
    const { client } = await open([first, second], {
      reportCancelled: (reason) => {
        reasons.push(reason)
      },
    })
    const running = client.callTool({ name: 'first', arguments: {} })
    await started.promise
    const controller = new AbortController()
    const queued = Promise.allSettled([client.callTool({ name: 'second', arguments: {} }, { signal: controller.signal })])
    // サーバが要求を受け付けて順番を待ち始めてから取り消す
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
    controller.abort('cancelled while queued')
    const outcomes = await queued
    expect(outcomes.map(entry => entry.status)).toEqual(['rejected'])
    release.resolve(true)
    await running
    await expect.poll(() => reasons).toEqual(['cancelled while queued'])
    expect(ran).toEqual([])
  })

  it('想定外の例外のときは、それまでに集めた出力も通知する', async () => {
    await explains('ツールの入力の検証のテストです。出力を書いた後でコマンドが想定外の例外を投げた場合に、報告先へそれまでに集めた標準出力と標準エラー出力を渡し、`kind` が `other` の結果を返すことを確認します。')
    const noisy = defineTool({
      name: 'noisy',
      title: 'Test tool',
      description: '出力の後の誤り',
      input: z.object({}),
      output: z.strictObject({}),
      run: async (_input, io) => {
        io.stdout('half\n')
        io.stderr('warn\n')
        return await failWith('boom')
      },
    })
    const reported: unknown[] = []
    const { client } = await open([noisy], { reportUnexpected: (_error, collected) => {
      reported.push(collected)
    } })
    const result = await client.callTool({ name: 'noisy', arguments: {} })
    expect(reported).toEqual([{ stdout: 'half\n', stderr: 'warn\n' }])
    expect(structuredOf(result)).toEqual({ kind: 'other', detail: 'boom' })
  })

  it('引数が存在しなくても、空の入力として検証する', async () => {
    await explains('ツールの入力の検証のテストです。`arguments` を省略して呼んだ場合に、空の入力として検証し、コマンドの終了コードに従った結果を返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'exit_three' })
    expect(toolOutcomeOf(result)).toMatchObject({ isError: true, structured: { kind: 'other' } })
  })

  it('入力の全体を見る検証の誤りは、名前を付けずに文だけを返す', async () => {
    await explains('ツールの入力の検証のテストです。複数の入力にまたがる検証を満たさない場合は、入力の名前を付けず、検証の文だけを含む `invalid-input` の失敗を返すことを確認します。')
    const refined = defineTool({
      name: 'refined',
      title: 'Test tool',
      description: '全体の検証',
      input: z.object({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a === undefined || value.b === undefined, 'a と b は同時に渡せません'),
      output: z.strictObject({}),
      run: async () => await exitWith(0),
    })
    const { client } = await open([refined])
    const result = await client.callTool({ name: 'refined', arguments: { a: 'x', b: 'y' } })
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: a と b は同時に渡せません' })
  })
})

describe('対象のリポを決められなかったとき', () => {
  const reason = 'cannot determine the target repository: test'

  it('どのツールもコマンドを実行せず、理由を detail に持つ失敗を返す', async () => {
    await explains('対象のリポジトリを決められなかったときのテストです。理由を指定してサーバーを作成した場合に、どのツールを呼んでもコマンドを実行せず、`session-directory-unresolved` の失敗を返すことを確認します。')
    const { client } = await open(TOOLS, { unavailableReason: reason })
    for (const name of ['echo', 'own_repo', 'bug']) {
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect(structuredOf(result)).toEqual({ kind: 'session-directory-unresolved', detail: reason })
    }
    expect(calls).toEqual([])
  })

  it('入力が誤っていても、入力の検証より先に理由を返す', async () => {
    await explains('対象のリポジトリを決められなかったときのテストです。定義にない入力を渡した場合でも、入力の検証より先に理由を `detail` として返すことを確認します。')
    const { client } = await open(TOOLS, { unavailableReason: reason })
    const result = await client.callTool({ name: 'echo', arguments: { unknown: 1 } })
    expect(outcomeOf(result).detail).toBe(reason)
  })

  it('理由を指定しても、tools/list の結果は変わらない', async () => {
    await explains('対象のリポジトリを決められなかったときのテストです。理由を指定したサーバーと指定しないサーバーで、`tools/list` が返すツールの一覧が同じになることを確認します。')
    const available = await open(TOOLS)
    const unavailable = await open(TOOLS, { unavailableReason: reason })
    const [expected, actual] = await Promise.all([available.client.listTools(), unavailable.client.listTools()])
    expect(actual.tools).toEqual(expected.tools)
  })
})

describe('失敗の原因の名前', () => {
  it('session_finish にマージしていない PR を渡すと、kind を pr-state にする', async () => {
    await explains('失敗の種別のテストです。`session_finish` の `reads.pull_request` にマージしていない PR の読み取りを渡した場合に、`kind` が `pr-state` の失敗を返すことを確認します。')
    prepareProject()
    const { client } = await open(SESSION_FINISH_TOOLS)
    const pullRequest = { number: 7, state: 'open', draft: false, merged: false, html_url: 'https://github.com/acme/demo/pull/7', head: { ref: 'feat/7' }, base: { ref: 'main' } }
    const result = await client.callTool({ name: 'session_finish', arguments: { pr_ref: 'acme/demo/7', reads: { pull_request: pullRequest } } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'pr-state', detail: 'PR #7 is not merged yet (state: open); merge it on GitHub first' })
  })
})

const SchemaShape = z.looseObject({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), anyOf: z.array(z.unknown()).optional() })

async function callTyped(mode: string): Promise<Awaited<ReturnType<ConnectedClient['client']['callTool']>>> {
  const { client } = await open([TYPED], { reportUnexpected: (error) => {
    unexpected.push(error)
  } })
  return await client.callTool({ name: 'typed', arguments: { mode } })
}

describe('結果の項目', () => {
  it('result と warning で渡した値を、structuredContent の最上位の項目と warnings に入れる', async () => {
    await explains('ツールの結果の項目のテストです。コマンドが `result` と `warning` を出力した場合に、`structuredContent` の最上位の項目と `warnings` に入れ、`isError` を付けないことを確認します。')
    const result = await callTyped('ok')
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ name: 'a', warnings: ['slow API'] })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
  })

  it('result を複数回呼ぶと、項目を浅く重ねて後の値を残す', async () => {
    await explains('ツールの結果の項目のテストです。コマンドが `result` を 2 回出力した場合に、項目を浅く重ねて、後から渡した値を残すことを確認します。')
    const result = await callTyped('twice')
    expect(structuredOf(result)).toEqual({ name: 'b', count: 3, warnings: ['slow API'] })
  })

  it('終了コード 0 で項目が output に合わないと、再実行しないよう detail で伝える失敗にし、報告先にも通知する', async () => {
    await explains('ツールの結果の項目のテストです。終了コード 0 で出力の項目がスキーマと一致しない場合は、失敗の種別を `other` にし、再実行しないことを `detail` で伝えて、一致する項目だけを残して報告先へ通知することを確認します。')
    const result = await callTyped('wrong')
    expect(result.isError).toBe(true)
    const detail = 'the command finished, but its data does not match the output schema: name: Invalid input: expected string, received undefined; the operation may already be done, so do not call it again'
    expect(result.structuredContent).toEqual({ kind: 'other', detail, count: 1, warnings: ['slow API'] })
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(z.ZodError)
  })

  it('失敗では、kind・detail・途中まで進んだ項目を最上位に入れ、reason を入れない', async () => {
    await explains('ツールの結果の項目のテストです。コマンドが項目を出力してから失敗した場合に、`kind`・`detail` と途中までの項目を最上位に入れ、`reason` を入れないことを確認します。')
    const result = await callTyped('fail')
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ kind: 'github-api', detail: 'half done\n  hint: retry', name: 'x', count: 2, warnings: ['slow API'] })
    expect(unexpected).toEqual([])
  })

  it('失敗で項目がスキーマに合わないと、kind と detail を保ってツールの項目を除き、報告先にも通知する', async () => {
    await explains('ツールの結果の項目のテストです。失敗した結果の項目がスキーマに一致しない場合は、`kind` と `detail` を残してツールの項目を除き、報告先に通知することを確認します。')
    const result = await callTyped('fail-wrong')
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ kind: 'github-api', detail: 'half done\n  hint: retry', warnings: ['slow API'] })
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(z.ZodError)
  })

  it('想定外の例外で終わると、途中まで集めた項目を other の失敗に載せる', async () => {
    await explains('ツールの結果の項目のテストです。項目を出力してから想定外の例外が発生した場合に、`kind` が `other` の失敗に途中までの項目を載せ、報告先に通知することを確認します。')
    const result = await callTyped('crash')
    expect(result.structuredContent).toEqual({ kind: 'other', detail: 'boom', count: 4, warnings: ['slow API'] })
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(Error)
  })

  it('想定外の例外で終わり、途中の項目もスキーマに合わなければ、ツールの項目を除く', async () => {
    await explains('ツールの結果の項目のテストです。想定外の例外が発生し、途中までの項目もスキーマに一致しない場合は、ツールの項目を除いた `other` の失敗を返し、報告先に 2 件通知することを確認します。')
    const result = await callTyped('crash-wrong')
    expect(result.structuredContent).toEqual({ kind: 'other', detail: 'boom', warnings: ['slow API'] })
    expect(unexpected).toHaveLength(2)
    expect(unexpected[1]).toBeInstanceOf(z.ZodError)
  })

  it.for(['ok', 'twice', 'wrong', 'fail', 'fail-wrong', 'crash', 'crash-wrong'])('mode %s の structuredContent は、tools/list の outputSchema に合う', async (mode) => {
    await explains(`ツールの結果の項目のテストです。\`mode\` が \`${mode}\` の呼び出しで返す \`structuredContent\` が、\`tools/list\` の \`outputSchema\` に一致することを確認します。`)
    const { client } = await open([TYPED])
    const { tools } = await client.listTools()
    const result = await callTyped(mode)
    expect(await outputSchemaIssues(SchemaShape.parse(tools[0]?.outputSchema), result.structuredContent)).toEqual([])
  })

  it('tools/list の outputSchema は、ツールの項目と共通の 4 項目を並べ、成功の必須項目か kind と detail を求める', async () => {
    await explains('ツールの結果の項目のテストです。`tools/list` の `outputSchema` が、`properties` にツールの項目と共通の項目を並べ、`anyOf` で成功の必須項目か `kind` と `detail` を求めることを確認します。')
    const { client } = await open([TYPED])
    const { tools } = await client.listTools()
    const schema = SchemaShape.parse(tools[0]?.outputSchema)
    expect(Object.keys(schema.properties)).toEqual(['name', 'count', 'kind', 'detail', 'log', 'warnings'])
    expect(schema).toMatchObject({ additionalProperties: false, anyOf: [{ required: ['name'] }, { required: ['kind', 'detail'] }] })
  })

  it('成功の必須項目が存在しないツールの outputSchema には、anyOf を置かない', async () => {
    await explains('ツールの結果の項目のテストです。成功の必須項目がないツールの場合に、`outputSchema` に `anyOf` が含まれないことを確認します。')
    const { client } = await open(TOOLS.slice(0, 1))
    const { tools } = await client.listTools()
    expect(SchemaShape.parse(tools[0]?.outputSchema).anyOf).toBeUndefined()
  })
})
