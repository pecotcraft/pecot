/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { PassThrough, Writable } from 'node:stream'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { childStdin, setChildStdin } from '../../infra/child-stdin.js'
import { defineCommand } from '../../commands/registry.js'
import { exitWith, failWith } from '../../commands/tests/support.js'
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

const COMMANDS = [
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
    createServer: reportUnexpected => createMcpServer(COMMANDS, { reportUnexpected }),
    createTransport: () => serverTransport,
    installStdoutGuard: () => new Writable(),
    stdin,
    stderr,
  }
}

describe('runMcpServe', () => {
  it('クライアントのツールの呼び出しに答え、stdin が閉じたら接続を閉じる', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const stdin = new PassThrough()
    runMcpServe(dependenciesOver(stdin, fakeTarget(), serverTransport))
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'hello', arguments: {} })
    expect(outcomeOf(result)).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' })
    const closed = new Promise<void>((resolve) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Client は onclose 経由で通知する
      client.onclose = resolve
    })
    // 実際は stdio の transport が stdin を読む。ここでは読み手がいないので、流れを起こして end を出す
    stdin.resume()
    stdin.end()
    await closed
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
    expect(dependencies.createServer(vi.fn())).toBeInstanceOf(McpServer)
    expect(dependencies.createTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(StdioServerTransport)
  })
})

describe('executeMcpServe', () => {
  it('待ち受けを始める前に、子プロセスの stdin を切り離す', () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    const stdin = new PassThrough()
    executeMcpServe(() => dependenciesOver(stdin, fakeTarget(), serverTransport))
    expect(childStdin()).toBe('ignore')
    stdin.end()
  })

  it('起動に失敗したら、stderr に error: の行を出して終了コードを 1 にする', () => {
    const stderr = fakeTarget()
    executeMcpServe(() => ({
      ...dependenciesOver(new PassThrough(), stderr, InMemoryTransport.createLinkedPair()[1]),
      createTransport: () => {
        throw new Error('no transport')
      },
    }))
    expect(stderr.chunks).toEqual(['error: no transport\n'])
    expect(process.exitCode).toBe(1)
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
