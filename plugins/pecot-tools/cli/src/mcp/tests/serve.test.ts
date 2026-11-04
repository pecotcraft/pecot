/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- Node stream の write を模したフェイクを扱う */
import { PassThrough, Writable } from 'node:stream'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'

import { killRunningAwscli } from '../../infra/awscli.js'
import { ignoreRejection } from '../../infra/ignore-rejection.js'
import { shutdownLoginRegistry } from '../../infra/sso/login-registry.js'
import {
  executeMcpServe,
  installStdoutGuard,
  mcpServeDefaultDependencies,
  runMcpServe,
  type McpServeDependencies,
  type ProcessSignals,
} from '../serve.js'
import { createMcpServer, MCP_SERVER_NAME, type ToolDefinition } from '../server.js'

type WriteCallback = (error?: Error | null) => void

interface FakeTarget {
  readonly chunks: string[]
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean
}

function makeTarget(): FakeTarget {
  const chunks: string[] = []
  return {
    chunks,
    write(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      done?.()
      return true
    },
  }
}

/**
Writable.write の完了 (内部 _write の callback 呼び出し) まで待つ。
*/
async function writeAndFlush(stream: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write('{"jsonrpc":"2.0","id":1}\n', (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe('installStdoutGuard', () => {
  // 直前の assert が落ちても exitCode を持ち越さない（後続テストの見え方を汚す）。
  afterEach(() => {
    process.exitCode = undefined
  })

  it('返した Writable への書き込みだけが元の stdout へ届く', async () => {
    const stdout = makeTarget()
    const stderr = makeTarget()

    const protocolStdout = installStdoutGuard(stdout, stderr)
    await writeAndFlush(protocolStdout)

    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0","id":1}\n'])
    expect(stderr.chunks).toEqual([])
  })

  it('ガード後の stdout 書き込みは stderr へ逃がす', () => {
    const stdout = makeTarget()
    const stderr = makeTarget()

    installStdoutGuard(stdout, stderr)
    stdout.write('console.log 相当の混入\n')

    expect(stderr.chunks).toEqual(['console.log 相当の混入\n'])
    expect(stdout.chunks).toEqual([])
  })

  it('逃がした書き込みでも callback は呼ぶ (encoding 付き / 無しの両形)', () => {
    const stdout = makeTarget()
    const stderr = makeTarget()
    installStdoutGuard(stdout, stderr)

    const withCallback = vi.fn()
    const withEncoding = vi.fn()
    stdout.write('a\n', withCallback)
    stdout.write('b\n', 'utf8', withEncoding)
    stdout.write('c\n')

    expect(withCallback).toHaveBeenCalledTimes(1)
    expect(withEncoding).toHaveBeenCalledTimes(1)
    expect(stderr.chunks).toEqual(['a\n', 'b\n', 'c\n'])
  })

  it('同じ stdout への 2 回目は初回と同じ Writable を返す (冪等)', async () => {
    const stdout = makeTarget()
    const stderr = makeTarget()

    const first = installStdoutGuard(stdout, stderr)
    const second = installStdoutGuard(stdout, stderr)

    expect(second).toBe(first)
    // 二重ガードだと 2 回目が「転送用 write」を元の write として束縛し、JSON-RPC が stderr に回る。
    await writeAndFlush(second)
    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0","id":1}\n'])
    expect(stderr.chunks).toEqual([])
  })

  it('stdout への書き込みが失敗したら stderr へ 1 行出して exit code 1 を立てる', async () => {
    // 実際の EPIPE は同期 throw ではなく write の callback にエラーが返る形で現れる。
    const failing: FakeTarget = {
      chunks: [],
      write(_chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
        setImmediate(() => {
          done?.(new Error('EPIPE 相当'))
        })
        return true
      },
    }
    const stderr = makeTarget()
    const protocolStdout = installStdoutGuard(failing, stderr)

    protocolStdout.write('{"jsonrpc":"2.0"}\n')
    await vi.waitFor(() => {
      expect(stderr.chunks.join('')).toContain('pecot-tools mcp: stdout への書き込みに失敗しました: EPIPE 相当')
    })
    expect(process.exitCode).toBe(1)
  })
})

/**
SIGTERM / SIGINT / 'exit' の配線先。実 process へ張ると他テストへ漏れるためフェイクを使う。
*/
interface FakeSignals extends ProcessSignals {
  readonly listeners: Map<string, () => void>
  readonly exitCodes: number[]
}

function makeSignals(): FakeSignals {
  const listeners = new Map<string, () => void>()
  const exitCodes: number[] = []
  return {
    listeners,
    exitCodes,
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener)
    },
    exit: (code: number) => {
      exitCodes.push(code)
    },
  }
}

interface Harness {
  readonly deps: McpServeDependencies
  /**
  createServer が返したインスタンス。serveStdio は接続の途中で複数回 factory を呼び得る。
  */
  readonly servers: McpServer[]
  readonly createServer: Mock<() => McpServer>
  readonly client: Client
  readonly clientTransport: InMemoryTransport
  readonly serverTransport: InMemoryTransport
  readonly stdin: PassThrough
  readonly stderr: FakeTarget
  readonly signals: FakeSignals
  readonly shutdownHooks: readonly Mock<() => void>[]
}

function makeHarness(overrides: Partial<McpServeDependencies> = {}): Harness {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const servers: McpServer[] = []
  const createServer = vi.fn(() => {
    const server = createMcpServer()
    servers.push(server)
    return server
  })
  const stdin = new PassThrough()
  const stderr = makeTarget()
  const signals = makeSignals()
  // 後始末は複数登録できる (Phase 4 の SSO レジストリを見越した配列)。全件呼ばれることを見る。
  const shutdownHooks = [vi.fn(), vi.fn()]
  const dependencies: McpServeDependencies = {
    createServer,
    createTransport: () => serverTransport,
    installStdoutGuard: () => new Writable({ write(_chunk, _encoding, callback) {
      callback()
    } }),
    stdin,
    stderr,
    onShutdown: shutdownHooks,
    signals,
    ...overrides,
  }
  return {
    deps: dependencies,
    servers,
    createServer,
    client: new Client({ name: 'test-client', version: '0.0.0' }),
    clientTransport,
    serverTransport,
    stdin,
    stderr,
    signals,
    shutdownHooks,
  }
}

/**
起動してクライアントを接続する。
*/
async function startAndConnect(harness: Harness): Promise<StdioServerHandle> {
  const handle = runMcpServe(harness.deps)
  await harness.client.connect(harness.clientTransport)
  return handle
}

function serverOf(harness: Harness): McpServer {
  const [server] = harness.servers
  if (server === undefined) throw new Error('createServer が呼ばれていません')
  return server
}

describe('runMcpServe', () => {
  it('transport へ接続し、クライアントから serverInfo が見える', async () => {
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      expect(harness.client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME })
      expect(serverOf(harness).isConnected()).toBe(true)
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('1 接続でインスタンスを 1 つだけ作り、factory 以外の副作用で重複しない', async () => {
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      expect(harness.createServer).toHaveBeenCalledTimes(1)
      // 後始末の配線は factory の外で 1 回だけ。
      expect(harness.signals.listeners.size).toBe(3)
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('stdin の EOF で接続を閉じ、後始末を全件呼ぶ', async () => {
    const harness = makeHarness()
    await startAndConnect(harness)
    expect(serverOf(harness).isConnected()).toBe(true)

    // 実運用では transport.start() が付ける data listener が stdin を flowing にする。
    // ここでは InMemoryTransport を使うため、明示的に resume してから EOF を起こす。
    harness.stdin.resume()
    harness.stdin.end()

    await vi.waitFor(() => {
      expect(serverOf(harness).isConnected()).toBe(false)
    })
    for (const hook of harness.shutdownHooks) expect(hook).toHaveBeenCalledTimes(1)
    await harness.client.close()
  })

  it('stdin の EOF で処理中の tools/call の signal を abort する', async () => {
    // ハンドラが止まったままだと、クライアントが去ったあとも awscli の子が孤児として残る。
    const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const gated: ToolDefinition = {
      name: 'gated',
      config: { description: 'EOF での abort の検証', inputSchema: z.object({}) },
      handler: async (_arguments, call) => {
        started.resolve(call.signal)
        await gate.promise
        return { content: [] }
      },
    }
    const harness = makeHarness({ createServer: () => createMcpServer([gated]) })
    await startAndConnect(harness)
    const pending = ignoreRejection(harness.client.callTool({ name: 'gated', arguments: {} }))
    try {
      const signal = await started.promise
      expect(signal.aborted).toBe(false)

      harness.stdin.resume()
      harness.stdin.end()

      await vi.waitFor(() => {
        expect(signal.aborted).toBe(true)
      })
    }
    finally {
      gate.resolve()
      await pending
      await harness.client.close()
    }
  })

  it('SIGTERM / SIGINT で後始末をしてから明示的に終了する', async () => {
    // ハンドラを登録すると既定の即終了が無効になるため、exit を自分で呼ばないと
    // シグナルを受けたまま止まらないプロセスになる。
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      harness.signals.listeners.get('SIGTERM')?.()
      harness.signals.listeners.get('SIGINT')?.()

      for (const hook of harness.shutdownHooks) expect(hook).toHaveBeenCalledTimes(2)
      expect(harness.signals.exitCodes).toEqual([143, 130])
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('最後の網として process の exit でも後始末を呼ぶ', async () => {
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      harness.signals.listeners.get('exit')?.()

      for (const hook of harness.shutdownHooks) expect(hook).toHaveBeenCalledTimes(1)
      // 'exit' では同期処理しか実行されないので、exit の呼び直しはしない。
      expect(harness.signals.exitCodes).toEqual([])
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('インスタンス内部のプロトコル層エラーを stderr へ 1 行流す', async () => {
    // 不正な JSON-RPC やハンドラ不在は個別レスポンスにならず onerror にしか出てこない。
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      serverOf(harness).server.onerror?.(new Error('Unknown message type'))
      expect(harness.stderr.chunks.join('')).toContain('pecot-tools mcp: Unknown message type')
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('transport 層のエラー (onerror) も stderr へ 1 行流す', async () => {
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      harness.serverTransport.onerror?.(new Error('transport failure'))
      expect(harness.stderr.chunks.join('')).toContain('pecot-tools mcp: transport failure')
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('JSON-RPC として不正な stdin の行は stderr へ報告し、接続は生きたまま', async () => {
    // 型で表せない不正フレームは、実 stdio transport の生の入力 (stdin) から注入する。
    const stdin = new PassThrough()
    const responses: string[] = []
    const harness = makeHarness({
      stdin,
      createTransport: (input, output) => new StdioServerTransport(input, output),
      installStdoutGuard: () => new Writable({ write(chunk: Buffer, _encoding, callback) {
        responses.push(chunk.toString())
        callback()
      } }),
    })
    const handle = runMcpServe(harness.deps)
    try {
      stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      })}\n`)
      await vi.waitFor(() => {
        expect(harness.servers).toHaveLength(1)
      })
      // 接続確定後の異常だけが transport とインスタンスの両方へ流れるため、initialize の応答を待ってから送る。
      await vi.waitFor(() => {
        expect(responses.join('')).toContain('"id":1')
      })
      stdin.write('{"jsonrpc":"2.0","foo":1}\n')

      await vi.waitFor(() => {
        const reported = harness.stderr.chunks.join('')
        expect(reported).toContain('pecot-tools mcp: ')
        expect(reported).toContain('Unrecognized key')
      })
      // transport とインスタンスの両方へ同じ Error が流れても、診断は 1 件。
      expect(harness.stderr.chunks.filter(chunk => chunk.startsWith('pecot-tools mcp: '))).toHaveLength(1)
      expect(harness.servers).toHaveLength(1)
    }
    finally {
      await handle.close()
    }
  })

  it('factory が失敗したら stderr へ報告し、exit code 1 を立てて接続を閉じる', async () => {
    const harness = makeHarness({
      createServer: () => {
        throw new Error('factory failure')
      },
    })
    const closeSpy = vi.spyOn(harness.serverTransport, 'close')
    try {
      runMcpServe(harness.deps)
      await expect(harness.client.connect(harness.clientTransport)).rejects.toThrow()

      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalled()
      })
      expect(harness.stderr.chunks.join('')).toContain('pecot-tools mcp: factory failure')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = undefined
    }
  })
})

describe('executeMcpServe', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('サーバを起動する', async () => {
    const harness = makeHarness()

    executeMcpServe(() => harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      expect(serverOf(harness).isConnected()).toBe(true)
      expect(process.exitCode ?? 0).toBe(0)
    }
    finally {
      await harness.client.close()
    }
  })

  it('起動に失敗したら stderr へ出して exit code 1 を立てる', () => {
    const harness = makeHarness({
      createTransport: () => {
        throw new Error('transport 生成に失敗')
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('pecot-tools mcp: transport 生成に失敗')
    expect(process.exitCode).toBe(1)
  })

  it('Error 以外の throw も stderr へ出す', () => {
    const harness = makeHarness({
      createTransport: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error の throw を整形する処理を検証する
        throw 'plain string failure'
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('pecot-tools mcp: plain string failure')
    expect(process.exitCode).toBe(1)
  })
})

describe('mcpServeDefaultDependencies', () => {
  it('実プロセスの stdio と SDK の stdio transport を組み立てる', () => {
    const dependencies = mcpServeDefaultDependencies()

    expect(dependencies.stdin).toBe(process.stdin)
    expect(dependencies.stderr).toBe(process.stderr)
    // 終了配線の相手は実 process。ここがフェイクのままだと SIGTERM で子プロセスが残る。
    expect(dependencies.signals).toBe(process)
    // 実行中の awscli 子プロセスと SSO の待機中の子を畳む後始末が配線されていること。
    // 欠けると SIGTERM でその子が孤児になる。
    expect(dependencies.onShutdown).toEqual([killRunningAwscli, shutdownLoginRegistry])
    expect(dependencies.createServer()).toBeInstanceOf(McpServer)
    // start() は呼ばないため process.stdin へ listener は付かない。
    expect(dependencies.createTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(StdioServerTransport)
  })
})
