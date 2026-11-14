/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { realpathSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { childStdin, setChildStdin } from '../../infra/child-stdin.js'
import { defineCommand } from '../../commands/registry.js'
import { exitWith, failWith } from '../../commands/tests/support.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { outcomeOf } from '../../../tests/_helpers/mcp-client.js'
import { createMcpServer } from '../server.js'
import { defaultDependencies, executeMcpServe, installStdoutGuard, runMcpServe } from '../serve.js'
import type { McpServeDependencies, WritableTarget } from '../serve.js'

interface FakeTarget extends WritableTarget {
  readonly chunks: string[]
}

function fakeTarget(): FakeTarget {
  const chunks: string[] = []
  return {
    chunks,
    write: (chunk, callback) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      callback?.()
      return true
    },
  }
}

const initialExitCode = process.exitCode

afterEach(() => {
  setChildStdin('inherit')
  process.exitCode = initialExitCode
})

describe('installStdoutGuard', () => {
  it('返した Writable だけが本物の stdout に届き、ほかの書き込みは stderr に逃げる', () => {
    const stdout = fakeTarget()
    const stderr = fakeTarget()
    const protocol = installStdoutGuard(stdout, stderr)
    protocol.write('{"jsonrpc":"2.0"}\n')
    stdout.write('stray\n')
    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0"}\n'])
    expect(stderr.chunks).toEqual(['stray\n'])
  })

  it('同じ stdout に二度張っても、初回の Writable を返す', () => {
    const stdout = fakeTarget()
    const stderr = fakeTarget()
    const first = installStdoutGuard(stdout, stderr)
    expect(installStdoutGuard(stdout, stderr)).toBe(first)
    first.write('x')
    expect(stdout.chunks).toEqual(['x'])
  })

  it('コールバックを encoding の位置に渡した書き込みも、完了を知らせる', () => {
    const stdout = fakeTarget()
    installStdoutGuard(stdout, fakeTarget())
    const done = vi.fn()
    const write: unknown = Reflect.get(stdout, 'write')
    if (typeof write !== 'function') throw new TypeError('write が関数ではありません')
    Reflect.apply(write, stdout, ['x', done])
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stdout への書き込みが失敗したら、stderr に error: の行を出して終了コードを 1 にする', () => {
    const stderr = fakeTarget()
    const protocol = installStdoutGuard(fakeTarget(), stderr)
    protocol.emit('error', new Error('EPIPE'))
    expect(stderr.chunks).toEqual(['error: failed to write to stdout: EPIPE\n'])
    expect(process.exitCode).toBe(1)
  })
})

const started: string[] = []

const COMMANDS = [
  defineCommand({
    path: ['slow'],
    description: '時間がかかる',
    input: z.object({ name: z.string() }),
    positional: ['name'],
    interactive: false,
    run: async (input) => {
      started.push(input.name)
      await new Promise((resolve) => {
        setTimeout(resolve, input.name === 'first' ? 80 : 0)
      })
      return await exitWith(0)
    },
  }),
  defineCommand({
    path: ['hello'],
    description: 'あいさつ',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async (_input, io) => {
      io.stdout('hello\n')
      return await exitWith(0)
    },
  }),
  defineCommand({
    path: ['noisy', 'bug'],
    description: '出力の後にプログラムの誤り',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async (_input, io) => {
      io.stdout('half\n')
      io.stderr('warn\n')
      return await failWith('boom')
    },
  }),
  defineCommand({
    path: ['bug'],
    description: 'プログラムの誤り',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await failWith('boom'),
  }),
]

function dependenciesOver(stdin: PassThrough, stderr: FakeTarget, serverTransport: InMemoryTransport): McpServeDependencies {
  return {
    createServer: options => createMcpServer(COMMANDS, options),
    createTransport: () => serverTransport,
    installStdoutGuard: () => new Writable(),
    stdin,
    stderr,
    environment: {},
    cwd: () => process.cwd(),
    changeDirectory: vi.fn(),
  }
}

function stdioDependencies(stdin: PassThrough, stdout: PassThrough): McpServeDependencies {
  return {
    ...dependenciesOver(stdin, fakeTarget(), InMemoryTransport.createLinkedPair()[1]),
    createTransport: (input, output) => new StdioServerTransport(input, output),
    installStdoutGuard: () => stdout,
  }
}

function sendLine(stdin: PassThrough, message: Readonly<Record<string, unknown>>): void {
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function slowCall(id: number, name: string): Record<string, unknown> {
  return { id, method: 'tools/call', params: { name: 'slow', arguments: { name } } }
}

async function initialize(stdin: PassThrough, stdout: PassThrough): Promise<void> {
  const answered = new Promise<void>((resolve) => {
    stdout.once('data', () => {
      resolve()
    })
  })
  sendLine(stdin, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } })
  await answered
  sendLine(stdin, { method: 'notifications/initialized' })
}

describe('runMcpServe', () => {
  it('クライアントのツールの呼び出しに答える', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    runMcpServe(dependenciesOver(new PassThrough(), fakeTarget(), serverTransport))
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'hello', arguments: {} })
    expect(outcomeOf(result)).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' })
  })

  it('実行中に stdin が閉じたら、待っている呼び出しは本体を呼ばない', async () => {
    started.length = 0
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const handle = runMcpServe(stdioDependencies(stdin, stdout))
    await initialize(stdin, stdout)
    sendLine(stdin, slowCall(2, 'first'))
    sendLine(stdin, slowCall(3, 'second'))
    stdin.end()
    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
    await handle.close()
    expect(started).toEqual(['first'])
  })
})

describe('runMcpServe のプログラムの誤り', () => {
  it('コマンドが想定外の例外を投げたら、stderr に error: の行で伝える', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const stderr = fakeTarget()
    runMcpServe(dependenciesOver(new PassThrough(), stderr, serverTransport))
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'bug', arguments: {} })
    expect(result.isError).toBe(true)
    expect(stderr.chunks.join('')).toContain('error: Error: boom')
    expect(stderr.chunks.join('')).not.toContain('so far')
  })
})

describe('runMcpServe の途中までの出力', () => {
  it('プログラムの誤りのとき、途中まで集めた stdout と stderr も stderr に出す', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const stderr = fakeTarget()
    runMcpServe(dependenciesOver(new PassThrough(), stderr, serverTransport))
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    await client.callTool({ name: 'noisy_bug', arguments: {} })
    const text = stderr.chunks.join('')
    expect(text).toContain('error: stdout so far: half')
    expect(text).toContain('error: stderr so far: warn')
  })
})

describe('runMcpServe の失敗', () => {
  it('サーバを作れなかったら、終了コードを 1 にして接続を閉じる', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    runMcpServe({
      ...dependenciesOver(new PassThrough(), fakeTarget(), serverTransport),
      createServer: () => {
        throw new Error('no server')
      },
    })
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await expect(client.connect(clientTransport, { timeout: 2000 })).rejects.toThrow()
    expect(process.exitCode).toBe(1)
  })
})

describe('defaultDependencies', () => {
  it('実際の stdio の transport とサーバを作る', () => {
    const dependencies = defaultDependencies()
    expect(dependencies.createServer({ reportUnexpected: vi.fn() })).toBeInstanceOf(McpServer)
    expect(dependencies.createTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(StdioServerTransport)
  })

  it('環境変数と cwd は実プロセスのもので、作業ディレクトリは process.chdir で移す', () => {
    const dependencies = defaultDependencies()
    expect(new Set(Object.keys(dependencies.environment))).toEqual(new Set(['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'COPILOT_PLUGIN_ROOT', 'COPILOT_SESSION_CWD', 'CLAUDE_PROJECT_DIR']))
    expect(dependencies.cwd()).toBe(process.cwd())
  })

  it('changeDirectory は実際に作業ディレクトリを移す', () => {
    const original = process.cwd()
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- makeTemporaryDirectory の一時ディレクトリ
    const target = realpathSync(makeTemporaryDirectory())
    try {
      defaultDependencies().changeDirectory(target)
      expect(process.cwd()).toBe(target)
    }
    finally {
      process.chdir(original)
    }
    expect(process.cwd()).toBe(original)
  })
})

describe('executeMcpServe', () => {
  it('待ち受けを始める前に、子プロセスの stdin を切り離す', () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const stdin = new PassThrough()
    expect(executeMcpServe(() => dependenciesOver(stdin, fakeTarget(), serverTransport))).toBe(0)
    expect(childStdin()).toBe('ignore')
    stdin.end()
  })

  it('起動に失敗したら、stderr に error: の行を出して 1 を返す', () => {
    const stderr = fakeTarget()
    const code = executeMcpServe(() => ({
      ...dependenciesOver(new PassThrough(), stderr, InMemoryTransport.createLinkedPair()[1]),
      createTransport: () => {
        throw new Error('no transport')
      },
    }))
    expect(stderr.chunks).toEqual(['error: no transport\n'])
    expect(code).toBe(1)
  })

  it('Error でない値で失敗しても、文字にして伝える', () => {
    const stderr = fakeTarget()
    executeMcpServe(() => ({
      ...dependenciesOver(new PassThrough(), stderr, InMemoryTransport.createLinkedPair()[1]),
      createTransport: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Error でない値の扱いを確かめる
        throw 'plain'
      },
    }))
    expect(stderr.chunks).toEqual(['error: plain\n'])
  })
})

function environmentOf(pluginRoot: string, session?: string): Record<string, string> {
  return { CLAUDE_PLUGIN_ROOT: pluginRoot, ...session !== undefined && { COPILOT_SESSION_CWD: session } }
}

const CWD_READ_REASON = 'cannot determine the target repository: cannot read the current directory: ENOENT: no such file or directory, uv_cwd'

describe('executeMcpServe のセッションのディレクトリ', () => {
  const hello = { name: 'hello', arguments: {} }

  it('cwd がプラグインの root の外なら、移らずに起動する', async () => {
    const pluginRoot = makeTemporaryDirectory()
    const changeDirectory = vi.fn()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const dependencies = { ...dependenciesOver(new PassThrough(), fakeTarget(), serverTransport), environment: environmentOf(pluginRoot, pluginRoot), cwd: () => process.cwd(), changeDirectory }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(changeDirectory).not.toHaveBeenCalled()
    expect(outcomeOf(await client.callTool(hello))).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' })
  })

  it('決まったディレクトリへ、待ち受けを始める前に 1 回だけ移る', () => {
    const pluginRoot = makeTemporaryDirectory()
    const session = makeTemporaryDirectory()
    const order: string[] = []
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const dependencies: McpServeDependencies = {
      ...dependenciesOver(new PassThrough(), fakeTarget(), serverTransport),
      environment: environmentOf(pluginRoot, session),
      cwd: () => pluginRoot,
      changeDirectory: (directory) => {
        order.push(`chdir ${directory}`)
      },
      createTransport: () => {
        order.push('listen')
        return serverTransport
      },
    }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    expect(order).toEqual([`chdir ${session}`, 'listen'])
  })

  it('決められなくても起動し、tools/list は変わらず、どのツールも理由を返してコマンドを呼ばない', async () => {
    started.length = 0
    const pluginRoot = makeTemporaryDirectory()
    const stderr = fakeTarget()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const changeDirectory = vi.fn()
    const dependencies = { ...dependenciesOver(new PassThrough(), stderr, serverTransport), environment: environmentOf(pluginRoot), cwd: () => pluginRoot, changeDirectory }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    const reason = `cannot determine the target repository: the server was started in the plugin directory (${pluginRoot}) and the host passed no session directory (COPILOT_SESSION_CWD); upgrade GitHub Copilot CLI to 1.0.106 or later, or start the server in the target repository`
    expect(stderr.chunks).toEqual([`error: ${reason}\n`])
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['slow', 'hello', 'noisy_bug', 'bug'])
    const result = await client.callTool(hello)
    expect(result.isError).toBe(true)
    expect(outcomeOf(result)).toEqual({ exitCode: 1, stdout: '', stderr: `error: ${reason}\n` })
    expect(JSON.stringify(result.content)).toContain('exit code: 1')
    await client.callTool({ name: 'slow', arguments: { name: 'x' } })
    expect(started).toEqual([])
    expect(changeDirectory).not.toHaveBeenCalled()
  })

  it('移るのに失敗したら、決められない扱いにして理由を返す', async () => {
    const pluginRoot = makeTemporaryDirectory()
    const session = makeTemporaryDirectory()
    const stderr = fakeTarget()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const dependencies: McpServeDependencies = {
      ...dependenciesOver(new PassThrough(), stderr, serverTransport),
      environment: environmentOf(pluginRoot, session),
      cwd: () => pluginRoot,
      changeDirectory: () => {
        throw new Error('EACCES')
      },
    }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    const reason = `cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: ${session}: EACCES`
    expect(stderr.chunks).toEqual([`error: ${reason}\n`])
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(outcomeOf(await client.callTool(hello))).toEqual({ exitCode: 1, stdout: '', stderr: `error: ${reason}\n` })
  })

  it('cwd を読めなくても（消えている）起動し、読めない旨と元の失敗を理由にして返す', async () => {
    const stderr = fakeTarget()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const changeDirectory = vi.fn()
    const dependencies: McpServeDependencies = {
      ...dependenciesOver(new PassThrough(), stderr, serverTransport),
      cwd: () => {
        throw new Error('ENOENT: no such file or directory, uv_cwd')
      },
      changeDirectory,
    }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    expect(stderr.chunks).toEqual([`error: ${CWD_READ_REASON}\n`])
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(outcomeOf(await client.callTool(hello))).toEqual({ exitCode: 1, stdout: '', stderr: `error: ${CWD_READ_REASON}\n` })
    expect(changeDirectory).not.toHaveBeenCalled()
  })

  it('依存の組み立てに失敗したら、stderr に error: の行を出して 1 を返す', () => {
    // eslint-disable-next-line unicorn/consistent-boolean-name -- 差し替えた write のスパイで、真偽値ではない
    const stderrSpy = vi.spyOn(process.stderr, 'write')
    stderrSpy.mockImplementation(() => true)
    try {
      const code = executeMcpServe(() => {
        throw new Error('no dependencies')
      })
      expect(code).toBe(1)
      expect(stderrSpy).toHaveBeenCalledWith('error: no dependencies\n')
    }
    finally {
      stderrSpy.mockRestore()
    }
  })
})
