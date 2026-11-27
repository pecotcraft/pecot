import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { Progress } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { toCallToolResult } from '../result.js'
import { createMcpServer, MCP_SERVER_NAME, type ToolCallContext, type ToolDefinition } from '../server.js'
import { readVersion } from '../../version.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { closeMcp, connectMcp, PROTOCOL_ERAS, waitIntervals } from './_client.js'
import { explains } from '../../../tests/_helpers/explains.js'

/**
text ブロック 1 件だけを返す最小のツール定義。
*/
function echoTool(name: string, text: string): ToolDefinition {
  return {
    name,
    config: { title: 'Test tool', description: `${name} テスト用`, inputSchema: z.object({}) },
    handler: () => Promise.resolve({ content: [{ type: 'text', text }] }),
  }
}

describe('createMcpServer', () => {
  it('サーバ名とプラグインの版を、serverInfo として公開する', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。クライアントを接続した場合に、`serverInfo` の名前が `MCP_SERVER_NAME`、版が `readVersion()` の値と一致することを確認します。')
    const connected = await connectMcp()
    try {
      // 版数はリテラル固定にしない（リリースの bump でテストを壊さない）。
      expect(connected.client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: readVersion(),
      })
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('サーバ名は、.mcp.json に登録したキーと一致する', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。`MCP_SERVER_NAME` が、プラグインの `.mcp.json` の `mcpServers` のキーに含まれることを確認します。')
    // initialize の serverInfo.name と .mcp.json のキーが食い違うと、クライアント側の表示が合わなくなる。
    // ツール名の名前空間 (mcp__plugin_pecot-t_<サーバ名>__*) も同様。
    // src/mcp/tests → src/mcp → src → cli → plugins/pecot-tools
    const manifestPath = path.resolve(import.meta.dirname, '..', '..', '..', '..', '.mcp.json')
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isRecord(parsed)) throw new Error('.mcp.json がオブジェクトではありません')
    const servers = parsed['mcpServers']
    if (!isRecord(servers)) throw new Error('.mcp.json に mcpServers がありません')

    expect(Object.keys(servers)).toContain(MCP_SERVER_NAME)
  })

  it('呼び出すたびに、新しいサーバのインスタンスを返す', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。`createMcpServer` を 2 回呼び出した場合に、返される 2 つのインスタンスが異なることを確認します。')
    expect(createMcpServer()).not.toBe(createMcpServer())
  })

  it('ツールが 0 件でも、tools/list は空の配列を返す', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。ツールを登録しない場合に、`tools` の capability が空のオブジェクトで、`tools/list` の応答が空の配列になることを確認します。')
    // 0 件の McpServer は tools capability と一覧ハンドラを持たず -32601 を返す。
    // そこで 0 件専用の明示登録でこの応答を作っている。v2 の Client は tools capability を持たない
    // サーバへ listTools の要求を送らず空振りする。そのため、要求を直接発行して応答を見る。
    const connected = await connectMcp()
    try {
      expect(connected.client.getServerCapabilities()?.tools).toEqual({})
      const listed = await connected.client.request({ method: 'tools/list', params: {} })
      expect(listed).toMatchObject({ tools: [] })
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('渡したツール定義は registerTool を経由して tools/list に載り、呼び出せる', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。1 件のツール定義を渡した場合に、`tools/list` にそのツール名だけが載り、呼び出すと定義した `text` が返ることを確認します。')
    const connected = await connectMcp([echoTool('dummy', 'ok')])
    try {
      const listed = await connected.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(['dummy'])

      const called = await connected.client.callTool({ name: 'dummy', arguments: {} })
      expect(called.content).toEqual([{ type: 'text', text: 'ok' }])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('ツール定義の outputSchema と annotations を、tools/list に反映する', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。`outputSchema` と `annotations` を持つツール定義を渡した場合は、`tools/list` の結果にもそれらが含まれることを確認します。')
    const annotated: ToolDefinition = {
      name: 'annotated',
      config: {
        title: '注釈つき',
        description: 'annotations / outputSchema の受け渡し検証',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: () => Promise.resolve({ content: [], structuredContent: {} }),
    }

    const connected = await connectMcp([annotated])
    try {
      const listedTools = await connected.client.listTools()
      const [listed] = listedTools.tools
      expect(listed).toMatchObject({
        name: 'annotated',
        title: '注釈つき',
        annotations: { readOnlyHint: true, openWorldHint: true },
      })
      expect(listed?.outputSchema).toBeDefined()
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('ハンドラに、signal を含む呼び出しの情報を渡す', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。ツールを呼び出した場合に、ハンドラが受け取る呼び出しの情報に `AbortSignal` が含まれ、中断されていない状態であることを確認します。')
    let received: ToolCallContext | undefined
    const probe: ToolDefinition = {
      name: 'probe',
      config: { title: 'Test tool', description: '呼び出し文脈の受け渡しの検証', inputSchema: z.object({}) },
      handler: (_arguments, call) => {
        received = call
        return Promise.resolve({ content: [] })
      },
    }

    const connected = await connectMcp([probe])
    try {
      await connected.client.callTool({ name: 'probe', arguments: {} })
      expect(received?.signal).toBeInstanceOf(AbortSignal)
      expect(received?.signal.aborted).toBe(false)
    }
    finally {
      await closeMcp(connected)
    }
  })

  it.each(PROTOCOL_ERAS)('クライアントがキャンセルしたときは、ハンドラの signal を中断する [%s]', async (era) => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。実行中のツールの呼び出しをクライアントが中断した場合に、呼び出しが拒否され、ハンドラの `signal` が中断状態になることを、プロトコルの版ごとに確認します。')
    const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const hanging: ToolDefinition = {
      name: 'hanging',
      config: { title: 'Test tool', description: 'キャンセル伝播の検証', inputSchema: z.object({}) },
      handler: async (_arguments, call) => {
        started.resolve(call.signal)
        await new Promise<void>((resolve) => {
          call.signal.addEventListener('abort', () => {
            resolve()
          }, { once: true })
        })
        return { content: [] }
      },
    }

    const connected = await connectMcp([hanging], { era })
    try {
      const controller = new AbortController()
      const call = connected.client.callTool({ name: 'hanging', arguments: {} }, { signal: controller.signal })
      const signal = await started.promise
      expect(signal.aborted).toBe(false)

      controller.abort()
      await expect(call).rejects.toThrow()
      await vi.waitFor(() => {
        expect(signal.aborted).toBe(true)
      })
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('並行して届いた tools/call は、同時に 4 件までしか実行しない', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。5 件の呼び出しを同時に送った場合に、4 件だけが開始され、1 件が完了した後で 5 件目が開始し、同時に実行した最大の数が 4 であることを確認します。')
    // 上限は createMcpServer 側の実行器で構造的に保証する。
    // ハンドラ側で待ち合わせない (= ツール実装の善意に依存しない) ことがこのテストの主眼。
    const gates: PromiseWithResolvers<void>[] = []
    let started = 0
    let running = 0
    let peak = 0
    const slow: ToolDefinition = {
      name: 'slow',
      config: { title: 'Test tool', description: '並行上限の検証', inputSchema: z.object({}) },
      handler: async () => {
        const gate: PromiseWithResolvers<void> = Promise.withResolvers()
        gates.push(gate)
        started += 1
        running += 1
        peak = Math.max(peak, running)
        await gate.promise
        running -= 1
        return { content: [{ type: 'text', text: 'done' }] }
      },
    }

    const connected = await connectMcp([slow])
    try {
      const calls = Array.from({ length: 5 }, async () =>
        connected.client.callTool({ name: 'slow', arguments: {} }))

      await vi.waitFor(() => {
        expect(started).toBe(4)
      })
      expect(peak).toBe(4)

      gates[0]?.resolve()
      await vi.waitFor(() => {
        expect(started).toBe(5)
      })

      for (const gate of gates) gate.resolve()
      await Promise.all(calls)
      expect(peak).toBe(4)
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('toCallToolResult で変換した結果が、client.callTool まで同じ内容で届く', async () => {
    await explains('MCP サーバを作る `createMcpServer` のテストです。`permission-denied` の失敗を返すツールを呼び出した場合は、`isError` が真になり、`kind` と `detail` が含まれることを確認します。')
    const failing: ToolDefinition = {
      name: 'failing',
      config: { title: 'Test tool', description: 'ExecutionResult 変換の往復検証', inputSchema: z.object({}) },
      handler: () => Promise.resolve(toCallToolResult({
        ok: false,
        kind: 'permission-denied',
        detail: '権限が不足しています',
        data: { log: 'An error occurred (AccessDenied)' },
      })),
    }

    const connected = await connectMcp([failing])
    try {
      const called = await connected.client.callTool({ name: 'failing', arguments: {} })

      expect(called.isError).toBe(true)
      expect(called.structuredContent).toStrictEqual({ log: 'An error occurred (AccessDenied)', kind: 'permission-denied', detail: '権限が不足しています' })
    }
    finally {
      await closeMcp(connected)
    }
  })
})

describe('createMcpServer の progress ハートビート', () => {
  /**
  周期は 5ms に縮め、進行条件を「経過時間」ではなく「受信数」に置いて決定論化する。
  */
  const INTERVAL_MS = 5

  it('progressToken を付けた呼び出しには、待機中と実行中の通知を送る', async () => {
    await explains('ツールの実行中に進捗を通知する仕組み（progress のハートビート）のテストです。周期を短くして `progressToken` 付きで呼び出した場合は、進捗が `gated: queued`、`gated: running` の順に連番で届くことを確認します。')
    const received: Progress[] = []
    // ハンドラはここが解放するまで返らない。解放条件が「3 発受信」なので、
    // 実時間の待ち合わせを入れずにハートビートの反復を観測できる。
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const gated: ToolDefinition = {
      name: 'gated',
      config: { title: 'Test tool', description: 'progress 通知の検証', inputSchema: z.object({}) },
      handler: async () => {
        await gate.promise
        return { content: [] }
      },
    }

    const connected = await connectMcp([gated], { progressIntervalMs: INTERVAL_MS })
    try {
      await connected.client.callTool({ name: 'gated', arguments: {} }, {
        onprogress: (progress) => {
          received.push(progress)
          if (received.length >= 3) gate.resolve()
        },
      })

      // 1 発目は実行枠を取る前に送るため必ず「順番待ち中」、以降は枠を得ていて「実行中」。
      expect(received[0]).toMatchObject({ progress: 1, message: 'gated: queued' })
      expect(received[1]).toMatchObject({ progress: 2, message: 'gated: running' })
      expect(received.map(item => item.progress)).toEqual(received.map((_item, index) => index + 1))
    }
    finally {
      await closeMcp(connected)
    }
  })

  it.each(PROTOCOL_ERAS)('キャンセルした後は、progress の通知を送らない [%s]', async (era) => {
    await explains('ツールの実行中に進捗を通知する仕組み（progress のハートビート）のテストです。ツールの実行中に呼び出しを中断してから周期の 20 回分を待った場合に、破棄済みのトークン宛の通知が届かず、クライアントの `errors` が空であることを、プロトコルの版ごとに確認します。')
    const firstProgress: PromiseWithResolvers<void> = Promise.withResolvers()
    // ハンドラは abort 後も返らない。ハートビートが abort で止まらなければ、
    // 破棄済みのトークン宛の通知がクライアントの onerror に届く。
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const hanging: ToolDefinition = {
      name: 'hanging',
      config: { title: 'Test tool', description: 'キャンセル後の progress 停止の検証', inputSchema: z.object({}) },
      handler: async () => {
        await gate.promise
        return { content: [] }
      },
    }

    const connected = await connectMcp([hanging], { progressIntervalMs: INTERVAL_MS, era })
    try {
      const controller = new AbortController()
      const call = connected.client.callTool({ name: 'hanging', arguments: {} }, {
        signal: controller.signal,
        onprogress: () => {
          firstProgress.resolve()
        },
      })
      await firstProgress.promise

      controller.abort()
      await expect(call).rejects.toThrow()
      // 周期 5ms の 20 回分。止まっていなければ、破棄済みのトークン宛の progress が onerror に届く。
      await waitIntervals(INTERVAL_MS, 20)

      expect(connected.errors).toEqual([])
    }
    finally {
      gate.resolve()
      await closeMcp(connected)
    }
  })

  it('progressToken を付けない呼び出しには、通知を送らない', async () => {
    await explains('ツールの実行中に進捗を通知する仕組み（progress のハートビート）のテストです。`progressToken` を付けずに呼び出した場合は、クライアントの `errors` が空で、`isError` が未設定であることを確認します。')
    const probe: ToolDefinition = {
      name: 'probe',
      config: { title: 'Test tool', description: 'progressToken 不在時の検証', inputSchema: z.object({}) },
      handler: () => Promise.resolve({ content: [] }),
    }

    const connected = await connectMcp([probe], { progressIntervalMs: INTERVAL_MS })
    // 未知トークン宛の progress 通知は、クライアント側で onerror に届く (SDK の _onprogress)。
    // 送ってはいけない通知を送った場合の観測点はここになる。
    try {
      const called = await connected.client.callTool({ name: 'probe', arguments: {} })

      expect(connected.errors).toEqual([])
      expect(called.isError).toBeUndefined()
    }
    finally {
      await closeMcp(connected)
    }
  })

  it.each(PROTOCOL_ERAS)('ツールの呼び出しより先にキャンセルが届いたときは、progress の通知を 1 回も送らない [%s]', async (era) => {
    await explains('ツールの実行中に進捗を通知する仕組み（progress のハートビート）のテストです。入力の検証を止めている間に呼び出しを中断し、検証の再開後に周期の 20 回分を待った場合に、クライアントの `errors` が空であることを、プロトコルの版ごとに確認します。')
    // 入力の検証はツールの呼び出しより前に実行される。検証を止めておけば、キャンセルを呼び出しの前に確実に届けられる。
    const validating: PromiseWithResolvers<void> = Promise.withResolvers()
    const releaseValidation: PromiseWithResolvers<void> = Promise.withResolvers()
    const cancelled: ToolDefinition = {
      name: 'cancelled',
      config: {
        title: 'Test tool',
        description: '呼び出し前のキャンセルの検証',
        inputSchema: z.object({}).refine(async () => {
          validating.resolve()
          await releaseValidation.promise
          return true
        }),
      },
      handler: () => Promise.resolve({ content: [] }),
    }

    const connected = await connectMcp([cancelled], { progressIntervalMs: INTERVAL_MS, era })
    try {
      const controller = new AbortController()
      const call = connected.client.callTool({ name: 'cancelled', arguments: {} }, {
        signal: controller.signal,
        // progressToken を付けさせるために必要。abort 後の通知は SDK がハンドラを消すため onprogress には入らない。
        onprogress: () => { /* 受信数ではなく onerror 側を見る */ },
      })
      await validating.promise
      controller.abort()
      await expect(call).rejects.toThrow()
      // 後続の要求の往復が済めば、先に送ったキャンセルはサーバが処理し終えている (ping は modern では使えない)。
      await connected.client.listTools()
      releaseValidation.resolve()
      // 周期 5ms の 20 回分。周期送出が始まっていれば、最初の 1 発が破棄済みのトークン宛に届き、onerror に届く。
      await waitIntervals(INTERVAL_MS, 20)

      expect(connected.errors).toEqual([])
    }
    finally {
      releaseValidation.resolve()
      await closeMcp(connected)
    }
  })
})
