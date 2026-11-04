// CUJ: MCP クライアントが `pecotv mcp` へ stdio で接続する。
//
// 利用者が使う起動手順 (`plugins/pecot-visual/bin/pecotv mcp`) を、実際に spawn して検証する。
// unit テストは InMemoryTransport 越しにしか見られない。
// そのため、stdout 汚染 (bootstrap ログや console.log の混入) と、終了処理の退行を見つけられるのは、このテストだけになる。
//
// 起動条件 (env・transport・stderr の扱い) は tests/_helpers/mcp-stdio.ts に集約する。
// ツール呼び出しを見る mcp-tools.test.ts と共有する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { Client } from '@modelcontextprotocol/client'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  BIN_PECOTV,
  CLI_DIST,
  CLI_ROOT,
  PLUGIN_MANIFEST,
  drainStderr,
  isReaped,
  makeTransport,
  serverEnvironment,
} from '../_helpers/mcp-stdio.js'
import { MCP_SERVER_NAME } from '../../src/mcp/server.js'
import { loadVersionFromPluginJson } from '../../src/version.js'
import { isRecord } from '../_helpers/records.js'

/**
SDK の request timeout。既定の 60s だと hang したときに it の timeout まで待たされる。
*/
const REQUEST_TIMEOUT_MS = 15_000

/**
client.close() が、SIGTERM の掃除を使わずに終わる上限 (SDK の close は 2000ms 待ってから kill する)。
*/
const SELF_EXIT_BUDGET_MS = 2000

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`pnpm build\` を実行してください`)
  }
})

/**
子プロセスの stdout を 1 行 1 JSON として読み、id ごとの応答を溜める。
*/
function createResponseCollector(): { readonly responses: Map<number, Record<string, unknown>>, readonly push: (chunk: string) => void } {
  const responses = new Map<number, Record<string, unknown>>()
  let buffer = ''
  return {
    responses,
    push: (chunk) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed: unknown = JSON.parse(line)
        if (isRecord(parsed) && typeof parsed['id'] === 'number') responses.set(parsed['id'], parsed)
      }
    },
  }
}

/**
server/discover に続けて initialize が届く順序。応答を待つ場合と待たない場合の両方を通す。
*/
const DISCOVER_THEN_INITIALIZE: readonly (readonly [label: string, waitForDiscover: boolean])[] = [
  ['discover の応答を待たずに', false],
  ['discover の応答を待ってから', true],
]

describe('pecotv mcp (stdio)', () => {
  // 2025 系の握手 (initialize) を直接見るテスト。2026-07-28 での接続は下の別ケースが担う。
  it('initialize が成功し serverInfo が pecotv + plugin.json の版数を返す', async () => {
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const transportErrors: Readonly<Error>[] = []
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Transport は onerror で通知する
    transport.onerror = (error: Readonly<Error>) => {
      transportErrors.push(error)
    }
    const client = new Client({ name: 'pecotv-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

      // 版数はリテラル固定にせず plugin.json から読む (リリース bump で壊さない)。
      expect(client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: loadVersionFromPluginJson(PLUGIN_MANIFEST),
      })
      expect(transportErrors, `子プロセス stderr: ${readStderr()}`).toEqual([])
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it('2026-07-28 で接続でき、tools/list が 11 件返る', async () => {
    // serveStdio は、2025 系と 2026-07-28 系の両方に応答する。
    // 上の initialize のテストは 2025 系の握手専用。
    // そこで、pin した 2026-07-28 のクライアントで、実プロセスへの接続を別に確かめる。
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new Client(
      { name: 'pecotv-e2e-2026', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

      expect(client.getNegotiatedProtocolVersion(), `子プロセス stderr: ${readStderr()}`).toBe('2026-07-28')
      expect(client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: loadVersionFromPluginJson(PLUGIN_MANIFEST),
      })
      const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })
      expect(listed.tools).toHaveLength(11)
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it('client.close() で SIGTERM 待ちに入らず自力終了する', async () => {
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new Client({ name: 'pecotv-e2e', version: '0.0.0' })
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

    const { pid } = transport
    expect(typeof pid).toBe('number')

    const start = performance.now()
    await client.close()
    const elapsed = performance.now() - start

    // SDK の close は stdin を閉じてから 2000ms 待ち、生きていれば SIGTERM を撃つ。
    // 2000ms 未満で返る = stdin の EOF だけで自力終了したということ。
    expect(elapsed, `子プロセス stderr: ${readStderr()}`).toBeLessThan(SELF_EXIT_BUDGET_MS)
    expect(typeof pid === 'number' && isReaped(pid)).toBe(true)
  }, 30_000)

  // initialize を生で送る 2025 系専用のテスト (2026-07-28 は initialize を使わない)。
  it('stdout に JSON-RPC 以外が混入しない', async () => {
    // SDK Client 経由では非 JSON 行が捨てられて検出できないため、生 spawn で stdout を丸ごと回収する。
    const child = spawn(BIN_PECOTV, ['mcp'], {
      env: serverEnvironment(),
      cwd: CLI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    const readStderr = drainStderr(child.stderr)
    const exited = new Promise<number | undefined>((resolve) => {
      child.once('close', (code: number | null) => {
        resolve(code ?? undefined)
      })
    })

    let exitCode: number | undefined
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'pecotv-e2e-raw', version: '0.0.0' },
        },
      })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

      await vi.waitFor(() => {
        expect(stdout).toContain('\n')
      }, { timeout: REQUEST_TIMEOUT_MS })
    }
    finally {
      child.stdin.end()
      exitCode = await exited
    }

    // serve.ts の exit code 規約は、0 が正常終了。
    // stdin の EOF だけで 0 終了することを pin する。
    expect(exitCode, `子プロセス stderr: ${readStderr()}`).toBe(0)

    // 空白のみの行も汚染として扱うため trim() では判定しない (JSON.parse('  ') は throw する)。
    // 落とすのは改行のみで生じる空文字列だけ。
    const lines = stdout.split('\n').filter(line => line !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // 非 JSON 行があればここで throw する = stdout 汚染の検知。
      const parsed: unknown = JSON.parse(line)
      expect(parsed).toMatchObject({ jsonrpc: '2.0' })
    }
  }, 30_000)

  // Claude Code は server/discover の応答が待ち時間を超えると、同じ接続で initialize (2025-11-25) を送る。
  // 2026-07-28 の探索で始まった接続でも、2025 系の握手と tools/call に応答できなければならない。
  describe.each(DISCOVER_THEN_INITIALIZE)('server/discover に続けて同じ接続で initialize が来る (%s)', (_label, waitForDiscover) => {
    it('initialize と tools/call に応答する', async () => {
      const child = spawn(BIN_PECOTV, ['mcp'], {
        env: serverEnvironment(),
        cwd: CLI_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const collector = createResponseCollector()
      const { responses } = collector
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', collector.push)
      const readStderr = drainStderr(child.stderr)
      const exited = new Promise<number | undefined>((resolve) => {
        child.once('close', (code: number | null) => {
          resolve(code ?? undefined)
        })
      })
      const send = (message: Readonly<Record<string, unknown>>): void => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      }
      const clientInfo = { name: 'pecotv-e2e-discover', version: '0.0.0' }
      const responseOf = async (id: number): Promise<Record<string, unknown>> => {
        await vi.waitFor(() => {
          expect(responses.has(id), `id ${String(id)} の応答がありません。子プロセス stderr: ${readStderr()}`).toBe(true)
        }, { timeout: REQUEST_TIMEOUT_MS })
        return responses.get(id) ?? {}
      }

      let exitCode: number | undefined
      try {
        send({
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': clientInfo,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        })
        if (waitForDiscover) await responseOf(1)
        send({
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo },
        })
        const initialized = await responseOf(2)
        expect(initialized['result']).toMatchObject({
          protocolVersion: '2025-11-25',
          serverInfo: { name: MCP_SERVER_NAME },
        })

        send({ method: 'notifications/initialized' })
        send({ id: 3, method: 'tools/call', params: { name: 'slide_lint', arguments: { dir: path.join(CLI_ROOT, 'no-such-dir-1228') } } })
        const called = await responseOf(3)
        expect(called['result']).toMatchObject({
          isError: true,
          structuredContent: { ok: false, data: { reason: 'dir-not-found' } },
        })
      }
      finally {
        child.stdin.end()
        exitCode = await exited
      }
      expect(exitCode, `子プロセス stderr: ${readStderr()}`).toBe(0)
    }, 30_000)
  })
})
