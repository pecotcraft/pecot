/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PecotError } from '../../domain/errors.js'
import { BOARD_ADD_COMMANDS } from '../../commands/board-add.js'
import { isConfirmed } from '../../commands/output.js'
import { COMMANDS as REAL_COMMANDS, defineCommand } from '../../commands/registry.js'
import type { CommandDefinition } from '../../commands/registry.js'
import { UsageError } from '../../commands/usage-error.js'
import { exitWith, failWith, throwFailure } from '../../commands/tests/support.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { prepareProject } from '../../../tests/_helpers/board-issue-case.js'
import { connectInMemory, outcomeOf, structuredOf } from '../../../tests/_helpers/mcp-client.js'
import type { ConnectedClient } from '../../../tests/_helpers/mcp-client.js'
import { createMcpServer } from '../server.js'
import type { McpServerOptions } from '../server.js'

useIsolatedEnvironment()

const calls: unknown[] = []

const COMMANDS: readonly CommandDefinition[] = [
  defineCommand({
    path: ['echo'],
    description: '入力を返す',
    input: z.object({ text: z.string(), count: z.int().optional(), flag: z.boolean().optional() }),
    positional: ['text'],
    interactive: false,
    run: async (input, io) => {
      calls.push(input)
      io.stdout(`echo ${input.text}\n`)
      io.stderr('note\n')
      return await exitWith(0)
    },
  }),
  defineCommand({
    path: ['exit', 'three'],
    description: '3 で終わる',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async (_input, io) => {
      io.stdout('partial\n')
      return await exitWith(3)
    },
  }),
  defineCommand({
    path: ['ask'],
    description: '確認を求める',
    input: z.object({}),
    positional: [],
    interactive: true,
    run: async (_input, io) => await exitWith(isConfirmed(io, 'Overwrite?') ? 0 : 1),
  }),
  defineCommand({
    path: ['bad', 'parameter'],
    description: 'context の無い使い方の誤り',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await throwFailure(new UsageError('Invalid value for x')),
  }),
  defineCommand({
    path: ['pecot', 'failure'],
    description: '報告できる失敗',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await throwFailure(new PecotError('ルートがありません')),
  }),
  defineCommand({
    path: ['bug'],
    description: 'プログラムの誤り',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await failWith('boom'),
  }),
  defineCommand({
    path: ['own', 'repo'],
    description: '自分の repo を持つ',
    input: z.object({ repo: z.string() }),
    hasOwnRepo: true,
    positional: [],
    interactive: false,
    run: async (input, io) => {
      io.stdout(`${input.repo}\n`)
      return await exitWith(0)
    },
  }),
  defineCommand({
    path: ['slow'],
    description: '時間がかかる',
    input: z.object({ name: z.string() }),
    positional: ['name'],
    interactive: false,
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

const opened: ConnectedClient[] = []
const unexpected: unknown[] = []

async function open(commands: readonly CommandDefinition[], options: Readonly<McpServerOptions> = {}): Promise<ConnectedClient> {
  const connected = await connectInMemory(createMcpServer(commands, options))
  opened.push(connected)
  return connected
}

async function connect(): Promise<ConnectedClient> {
  return await open(COMMANDS, {
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
  it('終了コード 0 なら、stdout と stderr を structuredContent と同じ JSON の本文にし、isError を付けずに返す', async () => {
    const result = await call('echo', { text: 'hi', count: 2 })
    expect(result.isError).toBeUndefined()
    expect(structuredOf(result)).toEqual({ ok: true, exitCode: 0, artifacts: [], data: {}, message: 'echo hi', stdout: 'echo hi\n', stderr: 'note\n' })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
    expect(outcomeOf(result)).toEqual({ exitCode: 0, stdout: 'echo hi\n', stderr: 'note\n' })
    expect(calls).toEqual([{ text: 'hi', count: 2 }])
  })

  it('終了コードが 0 でなければ、isError を付けて、終了コードをそのまま返す', async () => {
    const result = await call('exit_three')
    expect(result.isError).toBe(true)
    expect(outcomeOf(result)).toEqual({ exitCode: 3, stdout: 'partial\n', stderr: '' })
    expect(structuredOf(result).kind).toBe('other')
  })

  it('確認が要るのに入力が無いと、Aborted. を stderr に出して終了コード 1 にする', async () => {
    const result = await call('ask')
    expect(result.isError).toBe(true)
    expect(outcomeOf(result)).toEqual({ exitCode: 1, stdout: ' ', stderr: 'Overwrite? [y/N]:Aborted.\n' })
  })

  it('本体が投げた context の無い使い方の誤りには、コマンドの使い方を付けて終了コード 2 にする', async () => {
    const result = await call('bad_parameter')
    const structured = outcomeOf(result)
    expect(structured.exitCode).toBe(2)
    expect(structured.stderr).toContain('Usage: ')
    expect(structured.stderr).toContain('bad parameter')
    expect(structured.stderr).toContain('Invalid value for x')
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input', message: 'Invalid value for x' })
  })

  it('報告できる失敗は、error: の行を stderr に出して終了コード 1 にする', async () => {
    const result = await call('pecot_failure')
    expect(outcomeOf(result)).toEqual({ exitCode: 1, stdout: '', stderr: 'error: ルートがありません\n' })
    expect(structuredOf(result)).toMatchObject({ kind: 'other', message: 'ルートがありません' })
  })

  it('プログラムの誤りは、kind が other の JSON の結果にして、報告先にも伝える', async () => {
    const result = await call('bug')
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ ok: false, exitCode: 1, kind: 'other', artifacts: [], data: {}, message: 'boom' })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(Error)
  })

  it('報告先が無くても、プログラムの誤りは isError の結果になる', async () => {
    const { client } = await open(COMMANDS)
    const result = await client.callTool({ name: 'bug', arguments: {} })
    expect(result.isError).toBe(true)
  })

  it('自分の repo を持つコマンドの repo は、コマンド自身の入力として届く', async () => {
    const result = await call('own_repo', { repo: 'acme/demo' })
    expect(outcomeOf(result)).toEqual({ exitCode: 0, stdout: 'acme/demo\n', stderr: '' })
  })

  it('呼び出しは並行に来ても、1 件ずつ順に実行する', async () => {
    const { client } = await connect()
    const results = await Promise.all([
      client.callTool({ name: 'slow', arguments: { name: 'first' } }),
      client.callTool({ name: 'slow', arguments: { name: 'second' } }),
    ])
    expect(results.map(result => result.isError)).toEqual([undefined, undefined])
    expect(calls).toEqual(['start first', 'end first', 'start second', 'end second'])
  })

  it('前の呼び出しがプログラムの誤りで終わっても、次の呼び出しが動く', async () => {
    const { client } = await connect()
    const [broken, fine] = await Promise.all([
      client.callTool({ name: 'bug', arguments: {} }),
      client.callTool({ name: 'echo', arguments: { text: 'after' } }),
    ])
    expect(broken.isError).toBe(true)
    expect(outcomeOf(fine)).toEqual({ exitCode: 0, stdout: 'echo after\n', stderr: 'note\n' })
  })
})

describe('PECOT_GITHUB_API_URL', () => {
  it('ループバックの http でなければ、入力の検証より先に、error: の行と終了コード 1 にする', async () => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://example.com' })
    const result = await call('echo', { unknown: true })
    expect(result.isError).toBe(true)
    expect(outcomeOf(result)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: https://example.com\n',
    })
    expect(calls).toEqual([])
  })

  it('ループバックの http なら、そのまま実行する', async () => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.0.0.1:9' })
    const result = await call('echo', { text: 'hi' })
    expect(outcomeOf(result)).toEqual({ exitCode: 0, stdout: 'echo hi\n', stderr: 'note\n' })
  })
})

describe('入力の検証の誤り', () => {
  it('定義に無いキーが複数あると、全部を名指しして、本体を呼ばない', async () => {
    const result = await call('echo', { text: 'hi', one: 1, two: 2 })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ ok: false, exitCode: 2, kind: 'invalid-input', artifacts: [], data: {}, message: 'invalid input: unknown keys \'one\', \'two\'' })
    expect(calls).toEqual([])
  })

  it('改名した古い入力名のキーは、今の入力名を添えて断る', async () => {
    const { client } = await open(REAL_COMMANDS.filter(command => command.path.join(' ') === 'issue comment'))
    const result = await client.callTool({ name: 'issue_comment', arguments: { issue: 'o/r/1', message: 'm' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ ok: false, exitCode: 2, kind: 'invalid-input', artifacts: [], data: {}, message: 'invalid input: unknown key \'issue\' (\'issue\' was renamed to \'issue_ref\')' })
  })

  it('グローバルの repo の形が owner/repo でないと、本体を呼ばない', async () => {
    const result = await call('echo', { text: 'hi', repo: 'nope' })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(structuredOf(result).message).toContain('invalid input: repo: ')
    expect(calls).toEqual([])
  })

  it('グローバルの repo が owner/repo なら受け付ける', async () => {
    const result = await call('echo', { text: 'hi', repo: 'acme/demo' })
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual([{ text: 'hi', repo: 'acme/demo' }])
  })

  it('型の違いは、入力の名前を添えて断る', async () => {
    const result = await call('echo', { text: 'hi', flag: 'true' })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(structuredOf(result).message).toContain('invalid input: flag: ')
    expect(calls).toEqual([])
  })

  it('必須の入力が無いと、入力の名前を添えて断る', async () => {
    const result = await call('echo')
    expect(structuredOf(result).message).toContain('invalid input: text: ')
  })

  it('検証の途中で投げたプログラムの誤りは、isError の結果にして、報告先にも伝える', async () => {
    const broken = defineCommand({
      path: ['broken'],
      description: '検証が誤っている',
      input: z.object({}).refine(() => {
        throw new TypeError('refine bug')
      }),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const { client } = await open([broken], { reportUnexpected: (error) => {
      unexpected.push(error)
    } })
    const result = await client.callTool({ name: 'broken', arguments: {} })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ ok: false, exitCode: 1, kind: 'other', message: 'refine bug' })
    expect(unexpected).toHaveLength(1)
  })

  it('待っている間にキャンセルされた呼び出しは、本体を呼ばない', async () => {
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

  it('プログラムの誤りのとき、それまでに集めた出力も伝える', async () => {
    const noisy = defineCommand({
      path: ['noisy'],
      description: '出力の後の誤り',
      input: z.object({}),
      positional: [],
      interactive: false,
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
    expect(structuredOf(result)).toEqual({ ok: false, exitCode: 1, kind: 'other', artifacts: [], data: {}, message: 'boom', stdout: 'half\n', stderr: 'warn\n' })
  })

  it('引数が無くても、空の入力として検証する', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'exit_three' })
    expect(outcomeOf(result)).toEqual({ exitCode: 3, stdout: 'partial\n', stderr: '' })
  })

  it('入力の全体を見る検証の誤りは、名前を付けずに文だけを返す', async () => {
    const refined = defineCommand({
      path: ['refined'],
      description: '全体の検証',
      input: z.object({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a === undefined || value.b === undefined, 'a と b は同時に渡せません'),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const { client } = await open([refined])
    const result = await client.callTool({ name: 'refined', arguments: { a: 'x', b: 'y' } })
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input', message: 'invalid input: a と b は同時に渡せません' })
  })
})

describe('対象のリポを決められなかったとき', () => {
  const reason = 'cannot determine the target repository: test'

  it('どのツールもコマンドを呼ばず、理由を stderr に持つ失敗を返す', async () => {
    const { client } = await open(COMMANDS, { unavailableReason: reason })
    for (const name of ['echo', 'own_repo', 'bug']) {
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect(outcomeOf(result)).toEqual({ exitCode: 1, stdout: '', stderr: `error: ${reason}\n` })
      expect(structuredOf(result)).toMatchObject({ kind: 'session-directory-unresolved', message: reason })
    }
    expect(calls).toEqual([])
  })

  it('入力が誤りでも、入力の検証より先に理由を返す', async () => {
    const { client } = await open(COMMANDS, { unavailableReason: reason })
    const result = await client.callTool({ name: 'echo', arguments: { unknown: 1 } })
    expect(outcomeOf(result).stderr).toBe(`error: ${reason}\n`)
  })

  it('tools/list は変わらない', async () => {
    const available = await open(COMMANDS)
    const unavailable = await open(COMMANDS, { unavailableReason: reason })
    const [expected, actual] = await Promise.all([available.client.listTools(), unavailable.client.listTools()])
    expect(actual.tools).toEqual(expected.tools)
  })
})

describe('失敗の原因の名前', () => {
  it('board_add でボードが定義していない status を渡すと、kind を status-not-configured にする', async () => {
    prepareProject({ missingStatus: 'active' })
    const { client } = await open(BOARD_ADD_COMMANDS)
    const result = await client.callTool({ name: 'board_add', arguments: { issue_ref: 'acme/demo/7', status: 'active' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({
      ok: false,
      exitCode: 1,
      kind: 'status-not-configured',
      artifacts: [],
      data: {},
      message: 'status \'active\' is not configured in the project',
      stderr: 'error: status \'active\' is not configured in the project\n',
    })
  })
})
