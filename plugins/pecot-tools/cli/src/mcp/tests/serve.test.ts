/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- Node stream の write を模したフェイクを扱う */
import { PassThrough, Writable } from 'node:stream'

import type { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
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
import { AttachingClient } from '../../../tests/_helpers/attaching-client.js'
import { explains } from '../../../tests/_helpers/explains.js'

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

  it('ガードが返した Writable への書き込みだけを、元の標準出力へ送る', async () => {
    await explains('標準出力を JSON-RPC の通信専用にする `installStdoutGuard` のテストです。返された `Writable` に JSON-RPC のメッセージを書き込んだ場合に、元の標準出力にそのメッセージが書き込まれ、標準エラー出力には何も書き込まれないことを確認します。')
    const stdout = makeTarget()
    const stderr = makeTarget()

    const protocolStdout = installStdoutGuard(stdout, stderr)
    await writeAndFlush(protocolStdout)

    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0","id":1}\n'])
    expect(stderr.chunks).toEqual([])
  })

  it('ガードを設定した後に標準出力へ書き込まれた内容は、標準エラー出力へ移す', async () => {
    await explains('標準出力を JSON-RPC の通信専用にする `installStdoutGuard` のテストです。`console.log` のように標準出力へ直接書き込まれた文字列が、標準エラー出力に書き込まれ、元の標準出力には書き込まれないことを確認します。')
    const stdout = makeTarget()
    const stderr = makeTarget()

    installStdoutGuard(stdout, stderr)
    stdout.write('console.log 相当の混入\n')

    expect(stderr.chunks).toEqual(['console.log 相当の混入\n'])
    expect(stdout.chunks).toEqual([])
  })

  it('標準エラー出力へ移した書き込みでも、callback を呼び出す', async () => {
    await explains('標準出力を JSON-RPC の通信専用にする `installStdoutGuard` のテストです。標準出力への書き込みを encoding の指定がある場合とない場合の両方で行った場合に、どちらの callback も 1 回ずつ呼び出され、内容が標準エラー出力に書き込まれることを確認します。')
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

  it('同じ標準出力に 2 回ガードを設定しても、初回と同じ Writable を返す', async () => {
    await explains('標準出力を JSON-RPC の通信専用にする `installStdoutGuard` のテストです。同じ標準出力に対して 2 回呼び出した場合に、同じ `Writable` が返り、JSON-RPC のメッセージが標準出力に書き込まれて、標準エラー出力には書き込まれないことを確認します。')
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

  it('標準出力への書き込みが失敗したときは、標準エラー出力へ 1 行出力し、終了コードを 1 にする', async () => {
    // 実際の EPIPE は同期 throw ではなく write の callback にエラーが返る形で現れる。
    await explains('標準出力を JSON-RPC の通信専用にする `installStdoutGuard` のテストです。標準出力への書き込みが失敗した場合は、標準エラー出力へ `error: failed to write` を出力し、`process.exitCode` が `1` になることを確認します。')
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
      expect(stderr.chunks.join('')).toContain('error: failed to write to stdout: EPIPE 相当')
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
    client: new AttachingClient({ name: 'test-client', version: '0.0.0' }),
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
  it('transport へ接続すると、クライアントから serverInfo を確認できる', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。サーバを起動してクライアントを接続した場合に、クライアントから見える `serverInfo` の名前が `MCP_SERVER_NAME` と一致し、サーバが接続済みの状態であることを確認します。')
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

  it('1 回の接続でサーバのインスタンスを 1 つだけ作り、終了処理の登録を重複させない', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。サーバを起動してクライアントを接続した場合に、インスタンスを作る処理が 1 回だけ呼ばれ、シグナルなどの登録が 3 件だけであることを確認します。')
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

  it('標準入力が終端に達したときは、接続を閉じ、終了処理をすべて呼び出す', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。標準入力を終了した場合に、サーバの接続が閉じられ、登録した終了処理がすべて 1 回ずつ呼び出されることを確認します。')
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

  it('標準入力が終端に達したときは、処理中の tools/call の signal を中断する', async () => {
    // ハンドラが止まったままだと、クライアントが去ったあとも awscli の子が孤児として残る。
    await explains('MCP サーバを起動する `runMcpServe` のテストです。処理が終わらない `tools/call` の実行中に標準入力を終了した場合に、ハンドラへ渡した `signal` が中断状態になることを確認します。')
    const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const gated: ToolDefinition = {
      name: 'gated',
      config: { title: 'Test tool', description: 'EOF での abort の検証', inputSchema: z.object({}) },
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

  it('SIGTERM または SIGINT を受けたときは、終了処理を呼び出してから、明示的にプロセスを終了する', async () => {
    // ハンドラを登録すると既定の即終了が無効になるため、exit を自分で呼ばないと
    // シグナルを受けたまま止まらないプロセスになる。
    await explains('MCP サーバを起動する `runMcpServe` のテストです。`SIGTERM` と `SIGINT` を受けた場合に、終了処理がそれぞれ呼び出され、終了コードが `143` と `130` で終了することを確認します。')
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

  it('process の exit イベントでも、最後の手段として終了処理を呼び出す', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。`exit` イベントを受けた場合に、終了処理がすべて 1 回ずつ呼び出され、`exit` は再度呼び出されないことを確認します。')
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

  it('サーバのインスタンスが検出したプロトコル層のエラーを、標準エラー出力へ 1 行出力する', async () => {
    // 不正な JSON-RPC やハンドラ不在は個別レスポンスにならず onerror にしか出てこない。
    await explains('MCP サーバを起動する `runMcpServe` のテストです。サーバの `onerror` にエラーが通知された場合に、標準エラー出力に `error: Unknown message type` が出力されることを確認します。')
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      serverOf(harness).server.onerror?.(new Error('Unknown message type'))
      expect(harness.stderr.chunks.join('')).toContain('error: Unknown message type')
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('transport 層のエラーも、標準エラー出力へ 1 行出力する', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。transport の `onerror` にエラーが通知された場合に、標準エラー出力に `error: transport failure` が出力されることを確認します。')
    const harness = makeHarness()
    const handle = await startAndConnect(harness)
    try {
      harness.serverTransport.onerror?.(new Error('transport failure'))
      expect(harness.stderr.chunks.join('')).toContain('error: transport failure')
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('JSON-RPC として不正な標準入力の行は、標準エラー出力へ報告し、接続は維持する', async () => {
    // 型で表せない不正フレームは、実 stdio transport の生の入力 (stdin) から注入する。
    await explains('MCP サーバを起動する `runMcpServe` のテストです。接続後に宣言外のキーを含む不正な JSON-RPC の行を送った場合に、標準エラー出力へ `Unrecognized key` を含むエラーが 1 件だけ出力され、サーバは増えないことを確認します。')
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
        expect(reported).toContain('error: ')
        expect(reported).toContain('Unrecognized key')
      })
      // transport とインスタンスの両方へ同じ Error が流れても、診断は 1 件。
      expect(harness.stderr.chunks.filter(chunk => chunk.startsWith('error: '))).toHaveLength(1)
      expect(harness.servers).toHaveLength(1)
    }
    finally {
      await handle.close()
    }
  })

  it('サーバの作成処理が失敗したときは、標準エラー出力へ報告し、終了コードを 1 にして接続を閉じる', async () => {
    await explains('MCP サーバを起動する `runMcpServe` のテストです。サーバを作る処理が例外を発生させた場合は、接続が拒否され、標準エラー出力へ `error: factory failure` が出力され、終了コードが `1` になることを確認します。')
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
      expect(harness.stderr.chunks.join('')).toContain('error: factory failure')
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

  it('executeMcpServe を呼び出すと、サーバを起動し、終了コードを変更しない', async () => {
    await explains('MCP サーバの起動処理 `executeMcpServe` のテストです。サーバの起動処理を呼び出してクライアントを接続した場合に、サーバが接続済みの状態になり、終了コードが `0` のままであることを確認します。')
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

  it('起動に失敗したときは、標準エラー出力へ出力し、終了コードを 1 にする', async () => {
    await explains('MCP サーバの起動処理 `executeMcpServe` のテストです。transport の作成が例外を発生させた場合に、標準エラー出力に `error: transport 生成に失敗` が出力され、終了コードが `1` になることを確認します。')
    const harness = makeHarness({
      createTransport: () => {
        throw new Error('transport 生成に失敗')
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('error: transport 生成に失敗')
    expect(process.exitCode).toBe(1)
  })

  it('Error 以外の値が throw されたときも、標準エラー出力へ出力する', async () => {
    await explains('MCP サーバの起動処理 `executeMcpServe` のテストです。文字列が throw された場合に、標準エラー出力に `error: plain string failure` が出力され、終了コードが `1` になることを確認します。')
    const harness = makeHarness({
      createTransport: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error の throw を整形する処理を検証する
        throw 'plain string failure'
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('error: plain string failure')
    expect(process.exitCode).toBe(1)
  })
})

describe('mcpServeDefaultDependencies', () => {
  it('既定の依存は、実際のプロセスの stdio と、SDK の stdio transport を組み立てる', async () => {
    await explains('起動処理の既定の依存を作る `mcpServeDefaultDependencies` のテストです。入出力とシグナルの接続先が実際の `process` で、終了処理が `killRunningAwscli` と `shutdownLoginRegistry` であることを確認します。')
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
