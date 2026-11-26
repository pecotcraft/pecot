// serve.ts と同じく Node stream の write シグネチャを模したフェイクを扱う。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { PassThrough, Writable } from 'node:stream'

import type { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'

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
import { rejectionOf } from '../../../tests/_helpers/rejection.js'
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
  it('返した Writable への書き込みだけが元の stdout へ届く', async () => {
    await explains('標準出力を保護する `installStdoutGuard` のテストです。返された `Writable` に書き込んだ内容だけが元の標準出力に届き、標準エラー出力には何も出力されないことを確認します。')
    const stdout = makeTarget()
    const stderr = makeTarget()

    const protocolStdout = installStdoutGuard(stdout, stderr)
    await writeAndFlush(protocolStdout)

    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0","id":1}\n'])
    expect(stderr.chunks).toEqual([])
  })

  it('保護を設定した後の標準出力への書き込みは、標準エラー出力へ振り替える', async () => {
    await explains('`installStdoutGuard` を実行した後に、元の標準出力へ直接書き込んだ場合のテストです。書き込んだ内容が標準エラー出力に出力され、元の標準出力には何も届かないことを確認します。')
    const stdout = makeTarget()
    const stderr = makeTarget()

    installStdoutGuard(stdout, stderr)
    stdout.write('console.log 相当の混入\n')

    expect(stderr.chunks).toEqual(['console.log 相当の混入\n'])
    // 元の stdout には JSON-RPC 以外が一切載らない。
    expect(stdout.chunks).toEqual([])
  })

  it('標準エラー出力へ振り替えた書き込みでも、完了を知らせるコールバックを呼び出す', async () => {
    await explains('標準出力への書き込みを、コールバックを付けた場合と、文字コードとコールバックを付けた場合で実行したテストです。どちらの形でもコールバックが 1 回ずつ呼び出され、内容が標準エラー出力に出力されることを確認します。')
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

  it('同じ標準出力に対して 2 回実行した場合は、1 回目と同じ Writable を返す', async () => {
    await explains('同じ標準出力に対して `installStdoutGuard` を 2 回実行した場合のテストです。2 回目も 1 回目と同じ `Writable` が返り、書き込みが元の標準出力に届いて、標準エラー出力に回らないことを確認します。')
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

  it('標準出力への書き込みが失敗した場合は、標準エラー出力へ 1 行出力し、終了コードを 1 にする', async () => {
    await explains('標準出力への書き込みが `EPIPE` のように失敗した場合のテストです。標準エラー出力に `error: stdout write failed:` で始まるメッセージが出力され、終了コードが 1 になることを確認します。')
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
      expect(stderr.chunks.join('')).toContain('error: stdout write failed: EPIPE 相当')
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})

/**
SIGTERM / SIGINT / 'exit' の接続先。実 process へ張ると他テストへ抜けるためフェイクを使う。
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
  factory (deps.createServer) が作ったインスタンス。serveStdio は接続ごとに作る。
  */
  readonly servers: McpServer[]
  readonly client: Client
  readonly clientTransport: InMemoryTransport
  readonly serverTransport: InMemoryTransport
  readonly stdin: PassThrough
  readonly stderr: FakeTarget
  readonly signals: FakeSignals
  readonly shutdownDevServers: Mock<() => void>
}

function makeHarness(overrides: Partial<McpServeDependencies> = {}): Harness {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const servers: McpServer[] = []
  const stdin = new PassThrough()
  const stderr = makeTarget()
  const signals = makeSignals()
  const shutdownDevServers = vi.fn()
  const dependencies: McpServeDependencies = {
    createServer: () => {
      const server = createMcpServer()
      servers.push(server)
      return server
    },
    createTransport: () => serverTransport,
    installStdoutGuard: () => new Writable({ write(_chunk, _encoding, callback) {
      callback()
    } }),
    stdin,
    stderr,
    shutdownDevServers,
    signals,
    ...overrides,
  }
  return {
    deps: dependencies,
    servers,
    client: new AttachingClient({ name: 'test-client', version: '0.0.0' }),
    clientTransport,
    serverTransport,
    stdin,
    stderr,
    signals,
    shutdownDevServers,
  }
}

describe('runMcpServe', () => {
  it('トランスポートに接続し、クライアントから serverInfo を取得できる', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。トランスポートへ接続した後で、サーバー情報にサーバー名が含まれ、サーバーが接続済みになることを確認します。')
    const harness = makeHarness()
    const handle = runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      expect(harness.client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME })
      expect(harness.servers[0]?.isConnected()).toBe(true)
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('1 回の接続で作るサーバーのインスタンスは 1 つだけで、終了処理の登録も重複しない', async () => {
    await explains('`runMcpServe` で 1 回接続した場合のテストです。サーバーのインスタンスが 1 つだけ作られ、終了の通知（`SIGTERM`、`SIGINT`、`exit`）の受け取り先が 3 つだけ登録されることを確認します。')
    const harness = makeHarness()
    const handle = runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      expect(harness.servers).toHaveLength(1)
      // 終了接続は factory の外で 1 回だけ (SIGTERM / SIGINT / exit)。
      expect(harness.signals.listeners.size).toBe(3)
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('標準入力が終了した場合は、開発用サーバーを停止し、接続を閉じる', async () => {
    await explains('標準入力が終了（EOF）した場合のテストです。サーバーの接続が閉じられ、開発用サーバーを停止する処理が呼び出されることを確認します。')
    const harness = makeHarness()
    runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    expect(harness.servers[0]?.isConnected()).toBe(true)

    // 実運用では transport.start() が付ける data listener が stdin を flowing にする。
    // ここでは InMemoryTransport を使うため、明示的に resume してから EOF を起こす。
    harness.stdin.resume()
    harness.stdin.end()

    await vi.waitFor(() => {
      expect(harness.servers[0]?.isConnected()).toBe(false)
    })
    // 子の stdio パイプがイベントループを保持するため、dev サーバを落とさないと
    // 接続を閉じるだけでは サーバが自力終了できない。
    expect(harness.shutdownDevServers).toHaveBeenCalled()
    await harness.client.close()
  })

  it('標準入力が終了した場合は、処理中のハンドラの signal を中断する', async () => {
    await explains('ツールの処理中に、標準入力が終了（EOF）した場合のテストです。ハンドラに渡された `signal` が、終了の前は中断されておらず、終了の後に中断されることを確認します。')
    const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const gated: ToolDefinition = {
      name: 'gated',
      config: { title: 'Test tool', description: '処理中の接続切断の検証', inputSchema: z.object({}) },
      handler: async (_arguments, call) => {
        started.resolve(call.signal)
        await gate.promise
        return { content: [] }
      },
    }
    const harness = makeHarness({ createServer: () => createMcpServer([gated]) })
    runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    const pending = rejectionOf(harness.client.callTool({ name: 'gated', arguments: {} }))
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

  it('SIGTERM と SIGINT を受け取った場合は、開発用サーバーを停止してから終了する', async () => {
    await explains('`SIGTERM` と `SIGINT` を受け取った場合のテストです。開発用サーバーを停止する処理が 2 回呼び出され、終了コードがそれぞれ 143 と 130 になることを確認します。')
    // ハンドラを登録すると既定の即終了が無効になるため、exit を自分で呼ばないと
    // シグナルを受けたまま止まらないプロセスになる。
    const harness = makeHarness()
    const handle = runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      harness.signals.listeners.get('SIGTERM')?.()
      harness.signals.listeners.get('SIGINT')?.()

      expect(harness.shutdownDevServers).toHaveBeenCalledTimes(2)
      expect(harness.signals.exitCodes).toEqual([143, 130])
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('プロセスが終了する場合にも、開発用サーバーを停止する', async () => {
    await explains('プロセスの `exit` を受け取った場合のテストです。開発用サーバーを停止する処理が 1 回呼び出され、終了の再呼び出しが行われないことを確認します。')
    const harness = makeHarness()
    const handle = runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      harness.signals.listeners.get('exit')?.()

      expect(harness.shutdownDevServers).toHaveBeenCalledTimes(1)
      // 'exit' では同期処理しか動かないので、exit の呼び直しはしない。
      expect(harness.signals.exitCodes).toEqual([])
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('サーバーのインスタンス内部で発生したエラーを、標準エラー出力へ 1 行出力する', async () => {
    await explains('サーバーのインスタンスの `onerror` にエラーが通知された場合のテストです。標準エラー出力に、`error:` で始まるそのエラーのメッセージが出力されることを確認します。')
    // 不正な JSON-RPC やハンドラ不在は個別レスポンスにならず onerror にしか出てこない。
    // 拾っていないと完全沈黙になり、接続不能の分けができなくなる。
    const harness = makeHarness()
    const handle = runMcpServe(harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      harness.servers[0]?.server.onerror?.(new Error('Unknown message type'))
      expect(harness.stderr.chunks.join('')).toContain('error: Unknown message type')
    }
    finally {
      await harness.client.close()
      await handle.close()
    }
  })

  it('JSON-RPC として不正な行を受け取った場合は、標準エラー出力へ 1 行出力する', async () => {
    await explains('実際の標準入出力のトランスポートに、JSON-RPC として不正な行を書き込んだ場合のテストです。標準エラー出力に、`error:` で始まるメッセージが出力されることを確認します。')
    // 実際の StdioServerTransport を PassThrough の stdin につなぎ、不正な行を生で書き込む。
    const harness = makeHarness({
      createTransport: (stdin, stdout) => new StdioServerTransport(stdin, stdout),
    })
    const handle = runMcpServe(harness.deps)
    try {
      harness.stdin.write('{"jsonrpc":"2.0","foo":1}\n')

      await vi.waitFor(() => {
        expect(harness.stderr.chunks.join('')).toContain('error: ')
      })
    }
    finally {
      await handle.close()
    }
  })
})

describe('runMcpServe (実 stdio transport)', () => {
  it('接続が確立した後に不正な行を受け取った場合は、標準エラー出力へ 1 件だけ出力する', async () => {
    await explains('接続の確立後に、JSON-RPC として不正な行を書き込んだ場合のテストです。同じエラーが重複して報告されず、標準エラー出力に `error:` で始まる行が 1 件だけ出力されることを確認します。')
    // 確定後の異常は serveStdio の onerror とインスタンスの onerror の両方に届くため、
    // 同じ Error を 2 回報告すると診断が重複する。
    const harness = makeHarness({
      createTransport: (stdin, stdout) => new StdioServerTransport(stdin, stdout),
    })
    const handle = runMcpServe(harness.deps)
    try {
      harness.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
      })}\n`)
      harness.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      await vi.waitFor(() => {
        expect(harness.servers[0]?.isConnected()).toBe(true)
      })

      harness.stdin.write('{"jsonrpc":"2.0","foo":1}\n')
      await vi.waitFor(() => {
        expect(harness.stderr.chunks.join('')).toContain('error: ')
      })
      // 重複があれば直後の同期区間で 2 件目が届く。macrotask を数回回して取りこぼしを防ぐ。
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
      }

      expect(harness.stderr.chunks.filter(chunk => chunk.startsWith('error: '))).toHaveLength(1)
    }
    finally {
      await handle.close()
    }
  })
})

describe('executeMcpServe', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('サーバーを起動する', async () => {
    await explains('サーバーを起動する `executeMcpServe` のテストです。クライアントが接続でき、サーバーが接続済みになり、終了コードが 0 のままであることを確認します。')
    const harness = makeHarness()

    executeMcpServe(() => harness.deps)
    await harness.client.connect(harness.clientTransport)
    try {
      expect(harness.servers[0]?.isConnected()).toBe(true)
      expect(process.exitCode ?? 0).toBe(0)
    }
    finally {
      await harness.client.close()
    }
  })

  it('起動に失敗した場合は、標準エラー出力へ出力し、終了コードを 1 にする', async () => {
    await explains('トランスポートの作成が失敗する場合のテストです。標準エラー出力に、`error:` で始まる失敗の内容が出力され、終了コードが 1 になることを確認します。')
    const harness = makeHarness({
      createTransport: () => {
        throw new Error('transport 生成に失敗')
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('error: transport 生成に失敗')
    expect(process.exitCode).toBe(1)
  })

  it('Error 以外の値が throw された場合も、標準エラー出力へ出力する', async () => {
    await explains('トランスポートの作成で、`Error` ではない文字列が throw された場合のテストです。標準エラー出力に、`error:` で始まるその文字列が出力され、終了コードが 1 になることを確認します。')
    const harness = makeHarness({
      createTransport: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error throw の整形ルートを検証する
        throw 'plain string failure'
      },
    })

    executeMcpServe(() => harness.deps)

    expect(harness.stderr.chunks.join('')).toContain('error: plain string failure')
    expect(process.exitCode).toBe(1)
  })

  it('サーバーのインスタンスの作成に失敗した場合は、標準エラー出力へ 1 行出力し、終了コードを 1 にして、接続を閉じる', async () => {
    await explains('サーバーのインスタンスの作成が失敗する場合のテストです。クライアントの接続が失敗し、標準エラー出力に失敗の内容が 1 行だけ出力され、終了コードが 1 になることを確認します。')
    const harness = makeHarness({
      createServer: () => {
        throw new Error('インスタンス生成に失敗')
      },
    })

    executeMcpServe(() => harness.deps)
    const connecting = rejectionOf(harness.client.connect(harness.clientTransport))

    await expect(connecting).resolves.toBeInstanceOf(Error)
    await vi.waitFor(() => {
      expect(harness.stderr.chunks.join('')).toContain('error: インスタンス生成に失敗')
    })
    expect(harness.stderr.chunks.filter(chunk => chunk.includes('インスタンス生成に失敗'))).toHaveLength(1)
    expect(process.exitCode).toBe(1)
  })
})

describe('mcpServeDefaultDependencies', () => {
  it('実プロセスの stdio と SDK の stdio transport を組み立てる', async () => {
    await explains('既定の依存を作る `mcpServeDefaultDependencies` のテストです。実際のプロセスの標準入出力とシグナルを使い、SDK の標準入出力のトランスポートを作成することを確認します。')
    const dependencies = mcpServeDefaultDependencies()

    expect(dependencies.stdin).toBe(process.stdin)
    expect(dependencies.stderr).toBe(process.stderr)
    // 終了接続の相手は実 process。ここがフェイクのままだと SIGTERM で dev サーバが残る。
    expect(dependencies.signals).toBe(process)
    expect(typeof dependencies.shutdownDevServers).toBe('function')
    expect(dependencies.createServer()).toBeInstanceOf(McpServer)
    // start() は呼ばないため process.stdin へ listener は付かない。
    expect(dependencies.createTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(StdioServerTransport)
  })
})
