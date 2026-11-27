/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { realpathSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'

import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { childStdin, setChildStdin } from '@pecot/workflow-core/infra/child-stdin.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { defineTool } from '../../commands/registry.js'
import { exitWith, failWith } from '../../commands/tests/support.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { outcomeOf, structuredOf, toolOutcomeOf } from '../../../tests/_helpers/mcp-client.js'
import { createMcpServer } from '../server.js'
import { defaultDependencies, executeMcpServe, installStdoutGuard, runMcpServe } from '../serve.js'
import type { McpServeDependencies, WritableTarget } from '../serve.js'
import { AttachingClient } from '../../../tests/_helpers/attaching-client.js'

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
  it('返した Writable だけが本物の stdout に届き、ほかの書き込みは stderr に送る', async () => {
    await explains('MCP サーバーの標準出力を保護する `installStdoutGuard` のテストです。保護を設定した後に、返された `Writable` への書き込みだけが本物の標準出力に届き、標準出力へ直接書いた内容は標準エラー出力に送られることを確認します。')
    const stdout = fakeTarget()
    const stderr = fakeTarget()
    const protocol = installStdoutGuard(stdout, stderr)
    protocol.write('{"jsonrpc":"2.0"}\n')
    stdout.write('stray\n')
    expect(stdout.chunks).toEqual(['{"jsonrpc":"2.0"}\n'])
    expect(stderr.chunks).toEqual(['stray\n'])
  })

  it('同じ stdout に 2 回設定しても、初回の Writable を返す', async () => {
    await explains('MCP サーバーの標準出力を保護する `installStdoutGuard` のテストです。同じ標準出力に 2 回設定した場合は、2 回目も初回と同じ `Writable` を返し、書き込みが重複しないことを確認します。')
    const stdout = fakeTarget()
    const stderr = fakeTarget()
    const first = installStdoutGuard(stdout, stderr)
    expect(installStdoutGuard(stdout, stderr)).toBe(first)
    first.write('x')
    expect(stdout.chunks).toEqual(['x'])
  })

  it('コールバックを encoding の位置に渡した書き込みでも、完了を通知する', async () => {
    await explains('MCP サーバーの標準出力を保護する `installStdoutGuard` のテストです。`encoding` の位置にコールバックを渡して書き込んだ場合に、そのコールバックが 1 回だけ呼ばれることを確認します。')
    const stdout = fakeTarget()
    installStdoutGuard(stdout, fakeTarget())
    const done = vi.fn()
    const write: unknown = Reflect.get(stdout, 'write')
    if (typeof write !== 'function') throw new TypeError('write が関数ではありません')
    Reflect.apply(write, stdout, ['x', done])
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stdout への書き込みが失敗したら、stderr に error: の行を出力して終了コードを 1 にする', async () => {
    await explains('MCP サーバーの標準出力を保護する `installStdoutGuard` のテストです。標準出力への書き込みで `error` イベントが発生した場合に、標準エラー出力へ `error:` で始まる行を出力し、終了コードを 1 にすることを確認します。')
    const stderr = fakeTarget()
    const protocol = installStdoutGuard(fakeTarget(), stderr)
    protocol.emit('error', new Error('EPIPE'))
    expect(stderr.chunks).toEqual(['error: failed to write to stdout: EPIPE\n'])
    expect(process.exitCode).toBe(1)
  })
})

const started: string[] = []

const TOOLS = [
  defineTool({
    name: 'slow',
    title: 'Test tool',
    description: '時間がかかる',
    input: z.object({ name: z.string() }),
    output: z.strictObject({}),
    run: async (input) => {
      started.push(input.name)
      await new Promise((resolve) => {
        setTimeout(resolve, input.name === 'first' ? 80 : 0)
      })
      return await exitWith(0)
    },
  }),
  defineTool({
    name: 'hello',
    title: 'Test tool',
    description: 'あいさつ',
    input: z.object({}),
    output: z.strictObject({}),
    run: async (_input, io) => {
      io.stdout('hello\n')
      return await exitWith(0)
    },
  }),
  defineTool({
    name: 'noisy_bug',
    title: 'Test tool',
    description: '出力の後にプログラムの誤り',
    input: z.object({}),
    output: z.strictObject({}),
    run: async (_input, io) => {
      io.stdout('half\n')
      io.stderr('warn\n')
      return await failWith('boom')
    },
  }),
  defineTool({
    name: 'bug',
    title: 'Test tool',
    description: 'プログラムの誤り',
    input: z.object({}),
    output: z.strictObject({}),
    run: async () => await failWith('boom'),
  }),
]

function dependenciesOver(stdin: PassThrough, stderr: FakeTarget, serverTransport: InMemoryTransport): McpServeDependencies {
  return {
    createServer: options => createMcpServer(TOOLS, options),
    createTransport: () => serverTransport,
    installStdoutGuard: () => new Writable(),
    stdin,
    stderr,
    environment: {},
    cwd: () => process.cwd(),
    changeDirectory: vi.fn(),
    onShutdown: [],
    signals: { on: vi.fn(), exit: vi.fn() },
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
  it('クライアントがツールを呼び出すと、その結果を返す', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。クライアントからツールを呼び出した場合に、コマンドの出力を含む成功の結果を返すことを確認します。')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    runMcpServe(dependenciesOver(new PassThrough(), fakeTarget(), serverTransport))
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'hello', arguments: {} })
    expect(toolOutcomeOf(result)).toEqual({ isError: false, text: 'hello', structured: {} })
  })

  it('実行中に stdin が閉じたら、待っている呼び出しはコマンドの本体を実行しない', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。1 件目のツールの実行中に標準入力が閉じた場合に、待機している 2 件目の呼び出しではコマンドの本体を実行しないことを確認します。')
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
  it('コマンドが想定外の例外を投げたら、stderr に error: の行で通知する', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。コマンドが想定外の例外を投げた場合に、結果を `isError` にし、標準エラー出力へ `error: Error: boom` を出力することを確認します。')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const stderr = fakeTarget()
    runMcpServe(dependenciesOver(new PassThrough(), stderr, serverTransport))
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'bug', arguments: {} })
    expect(result.isError).toBe(true)
    expect(stderr.chunks.join('')).toContain('error: Error: boom')
    expect(stderr.chunks.join('')).not.toContain('so far')
  })
})

describe('runMcpServe の途中までの出力', () => {
  it('想定外の例外のときは、途中まで集めた stdout と stderr も stderr に出力する', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。標準出力と標準エラー出力に書いた後でコマンドが想定外の例外を投げた場合に、それまでに集めた出力も標準エラー出力へ出力することを確認します。')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const stderr = fakeTarget()
    runMcpServe(dependenciesOver(new PassThrough(), stderr, serverTransport))
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    await client.callTool({ name: 'noisy_bug', arguments: {} })
    const text = stderr.chunks.join('')
    expect(text).toContain('error: stdout so far: half')
    expect(text).toContain('error: stderr so far: warn')
  })
})

describe('runMcpServe の失敗', () => {
  it('サーバーを作成できなければ、終了コードを 1 にして接続を閉じる', async () => {
    await explains('MCP サーバーを起動する `runMcpServe` のテストです。サーバーの作成で例外が発生した場合に、クライアントの接続が失敗し、終了コードが 1 になることを確認します。')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    runMcpServe({
      ...dependenciesOver(new PassThrough(), fakeTarget(), serverTransport),
      createServer: () => {
        throw new Error('no server')
      },
    })
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await expect(client.connect(clientTransport, { timeout: 2000 })).rejects.toThrow()
    expect(process.exitCode).toBe(1)
  })
})

describe('defaultDependencies', () => {
  it('実際の stdio のトランスポートとサーバーを作成する', async () => {
    await explains('既定の依存を返す `defaultDependencies` のテストです。サーバーの作成で `McpServer` を、トランスポートの作成で `StdioServerTransport` を返すことを確認します。')
    const dependencies = defaultDependencies()
    expect(dependencies.createServer({ reportUnexpected: vi.fn() })).toBeInstanceOf(McpServer)
    expect(dependencies.createTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(StdioServerTransport)
  })

  it('環境変数と cwd は実プロセスのものを使い、作業ディレクトリは process.chdir で移す', async () => {
    await explains('既定の依存を返す `defaultDependencies` のテストです。環境変数に `CLAUDE_PLUGIN_ROOT` などの 5 つのキーがあり、`cwd` が実プロセスの作業ディレクトリを返すことを確認します。')
    const dependencies = defaultDependencies()
    expect(new Set(Object.keys(dependencies.environment))).toEqual(new Set(['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'COPILOT_PLUGIN_ROOT', 'COPILOT_SESSION_CWD', 'CLAUDE_PROJECT_DIR']))
    expect(dependencies.cwd()).toBe(process.cwd())
  })

  it('changeDirectory は、実際に作業ディレクトリを移動する', async () => {
    await explains('既定の依存を返す `defaultDependencies` のテストです。`changeDirectory` を呼んだ場合に、プロセスの作業ディレクトリが指定したディレクトリに変わることを確認します。')
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
  it('待ち受けを始める前に、子プロセスの stdin を切り離す', async () => {
    await explains('MCP サーバーを起動する `executeMcpServe` のテストです。起動した場合に、終了コード 0 を返し、子プロセスの標準入力の設定が `ignore` になることを確認します。')
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const stdin = new PassThrough()
    expect(executeMcpServe(() => dependenciesOver(stdin, fakeTarget(), serverTransport))).toBe(0)
    expect(childStdin()).toBe('ignore')
    stdin.end()
  })

  it('起動に失敗したら、stderr に error: の行を出力して 1 を返す', async () => {
    await explains('MCP サーバーを起動する `executeMcpServe` のテストです。トランスポートの作成で例外が発生した場合に、標準エラー出力へ `error:` で始まる行を出力し、終了コード 1 を返すことを確認します。')
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

  it('Error でない値で失敗しても、文字列にして通知する', async () => {
    await explains('MCP サーバーを起動する `executeMcpServe` のテストです。`Error` でない値が投げられた場合に、その値を文字列にして `error:` の行で標準エラー出力へ出力することを確認します。')
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

  it('cwd がプラグインのルートの外なら、作業ディレクトリを移さずに起動する', async () => {
    await explains('セッションのディレクトリを扱う `executeMcpServe` のテストです。作業ディレクトリがプラグインのルートの外にある場合は、ディレクトリを移動せず、ツールを呼び出して成功の結果を返すことを確認します。')
    const pluginRoot = makeTemporaryDirectory()
    const changeDirectory = vi.fn()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const dependencies = { ...dependenciesOver(new PassThrough(), fakeTarget(), serverTransport), environment: environmentOf(pluginRoot, pluginRoot), cwd: () => process.cwd(), changeDirectory }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(changeDirectory).not.toHaveBeenCalled()
    expect(toolOutcomeOf(await client.callTool(hello))).toEqual({ isError: false, text: 'hello', structured: {} })
  })

  it('決まったディレクトリへ、待ち受けを始める前に 1 回だけ移動する', async () => {
    await explains('セッションのディレクトリを扱う `executeMcpServe` のテストです。作業ディレクトリがプラグインのルートにあり、セッションのディレクトリが決まっている場合に、待ち受けを始める前に 1 回だけそのディレクトリへ移動することを確認します。')
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

  it('ディレクトリを決められなくても起動し、tools/list は変えず、どのツールも理由を返してコマンドを呼ばない', async () => {
    await explains('セッションのディレクトリを扱う `executeMcpServe` のテストです。プラグインのルートで起動され、セッションのディレクトリが渡されない場合は、ツールの一覧を変えずにどのツールも理由を含む失敗を返し、コマンドを実行しないことを確認します。')
    started.length = 0
    const pluginRoot = makeTemporaryDirectory()
    const stderr = fakeTarget()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const changeDirectory = vi.fn()
    const dependencies = { ...dependenciesOver(new PassThrough(), stderr, serverTransport), environment: environmentOf(pluginRoot), cwd: () => pluginRoot, changeDirectory }
    expect(executeMcpServe(() => dependencies)).toBe(0)
    const reason = `cannot determine the target repository: the server was started in the plugin directory (${pluginRoot}) and the host passed no session directory (COPILOT_SESSION_CWD); upgrade GitHub Copilot CLI to 1.0.106 or later, or start the server in the target repository`
    expect(stderr.chunks).toEqual([`error: ${reason}\n`])
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['slow', 'hello', 'noisy_bug', 'bug'])
    const result = await client.callTool(hello)
    expect(result.isError).toBe(true)
    expect(outcomeOf(result)).toEqual({ isError: true, detail: reason, warnings: [] })
    expect(structuredOf(result)).toEqual({ kind: 'session-directory-unresolved', detail: reason })
    await client.callTool({ name: 'slow', arguments: { name: 'x' } })
    expect(started).toEqual([])
    expect(changeDirectory).not.toHaveBeenCalled()
  })

  it('移動に失敗したら、決められなかった場合として扱い、理由を返す', async () => {
    await explains('セッションのディレクトリを扱う `executeMcpServe` のテストです。セッションのディレクトリへの移動で例外が発生した場合に、ディレクトリを決められなかった場合と同じく、理由を含む失敗を返すことを確認します。')
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
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(outcomeOf(await client.callTool(hello))).toEqual({ isError: true, detail: reason, warnings: [] })
  })

  it('cwd を取得できなくても起動し、取得できない旨と元の失敗を理由にして返す', async () => {
    await explains('セッションのディレクトリを扱う `executeMcpServe` のテストです。作業ディレクトリが削除されていて `cwd` を取得できない場合に、起動を続け、取得できない旨と元の例外を含む理由で失敗を返すことを確認します。')
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
    const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    expect(outcomeOf(await client.callTool(hello))).toEqual({ isError: true, detail: CWD_READ_REASON, warnings: [] })
    expect(changeDirectory).not.toHaveBeenCalled()
  })

  it('依存の組み立てに失敗したら、stderr に error: の行を出力して 1 を返す', async () => {
    await explains('MCP サーバーを起動する `executeMcpServe` のテストです。依存の組み立てで例外が発生した場合に、標準エラー出力へ `error:` で始まる行を出力し、終了コード 1 を返すことを確認します。')
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
