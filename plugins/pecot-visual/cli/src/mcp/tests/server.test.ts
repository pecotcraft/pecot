import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import type { Progress } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { toCallToolResult } from '../result.js'
import { createMcpServer, MCP_SERVER_NAME, type ToolCallContext, type ToolDefinition } from '../server.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { rejectionOf } from '../../../tests/_helpers/rejection.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { resetPluginRoot, stubPluginRoot } from '../../../tests/_helpers/plugin-root-stub.js'
import { closeMcp, connectMcp, PROTOCOL_ERAS } from './_client.js'
import { explains } from '../../../tests/_helpers/explains.js'

vi.mock('../../infra/_shared/plugin-root.js', async (importOriginal) => {
  const { pluginRootMock } = await import('../../../tests/_helpers/plugin-root-stub.js')
  return await pluginRootMock(importOriginal)
})

/**
プラグインルートを既知 version の plugin.json に向けて function_ を実行する。
*/
async function withPluginRoot(version: string, function_: () => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'pecotv-test-plugin-root-'))
  // path is constructed from tmpdir() and a known suffix.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  // path is constructed from tmpdir() and a known suffix.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pecot-v', version }))
  stubPluginRoot(root)
  try {
    await function_()
  }
  finally {
    resetPluginRoot()
    rmSync(root, { recursive: true, force: true })
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
text ブロック 1 件だけを返す最小のツール定義。
*/
function echoTool(name: string): ToolDefinition {
  return {
    name,
    config: { title: 'Test tool', description: `${name} テスト用`, inputSchema: z.object({}) },
    handler: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
  }
}

describe('createMcpServer', () => {
  it('サーバー名とプラグインの版を、serverInfo として公開する', async () => {
    await explains('MCP サーバーを作成する `createMcpServer` のテストです。`CLAUDE_PLUGIN_ROOT` に指定したプラグインの版（`1.2.3`）が、サーバー名とともに `serverInfo` としてクライアントから取得できることを確認します。')
    await withPluginRoot('1.2.3', async () => {
      const connected = await connectMcp()
      try {
        expect(connected.client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME, version: '1.2.3' })
      }
      finally {
        await closeMcp(connected)
      }
    })
  })

  it('サーバー名は、.mcp.json の登録キーと一致する', async () => {
    // initialize の serverInfo.name と .mcp.json のキーが食い違うと、クライアント側の表示が噛み合わなくなる。
    // ツール名の名前空間 (mcp__plugin_pecot-v_<サーバ名>__*) も同様。
    // src/mcp/tests → cli/ → plugins/pecot-visual
    await explains('プラグインの `.mcp.json` のテストです。`mcpServers` の登録キーに、サーバー名（`MCP_SERVER_NAME`）が含まれることを確認します。')
    const manifestPath = path.resolve(import.meta.dirname, '..', '..', '..', '..', '.mcp.json')
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isRecord(parsed)) throw new Error('.mcp.json がオブジェクトではありません')
    const servers = parsed['mcpServers']
    if (!isRecord(servers)) throw new Error('.mcp.json に mcpServers がありません')

    expect(Object.keys(servers)).toContain(MCP_SERVER_NAME)
  })

  it('呼び出すたびに、新しいインスタンスを返す', async () => {
    await explains('`createMcpServer` を 2 回呼び出した場合のテストです。毎回新しいインスタンスが作られ、同じインスタンスにならないことを確認します。')
    expect(createMcpServer()).not.toBe(createMcpServer())
  })

  it('ツールが 0 件でも、tools/list は空の配列を返す', async () => {
    // 0 件の McpServer は tools capability と一覧ハンドラを持たず -32601 を返す。
    // そのため 0 件専用の明示登録でこの応答を作っている。v2 の Client は tools capability を持たない
    // サーバへ listTools の要求を送らず空振りするので、要求を直接発行して応答を見る。
    await explains('ツールを 1 つも登録していないサーバーのテストです。`tools` の capability を持ち、`tools/list` が空の配列を返すことを確認します。')
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

  it('渡したツールの定義が、tools/list に含まれ、呼び出せる', async () => {
    // #980 が 11 ツールを載せる登録シームの証明。inputSchema の z.object({}) は「引数なし」を表す。
    await explains('ツールの定義を 1 つ渡してサーバーを作成した場合のテストです。`tools/list` にそのツールが含まれ、説明が一致し、呼び出すと定義どおりの結果が返ることを確認します。')
    const connected = await connectMcp([echoTool('dummy')])
    try {
      const listed = await connected.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(['dummy'])
      expect(listed.tools[0]).toMatchObject({ description: 'dummy テスト用' })

      const called = await connected.client.callTool({ name: 'dummy', arguments: {} })
      expect(called.content).toEqual([{ type: 'text', text: 'ok' }])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('outputSchema と annotations を、tools/list に含める', async () => {
    await explains('`outputSchema` と `annotations` を持つツールを登録した場合のテストです。`tools/list` に、題名、`annotations`、`outputSchema` が含まれることを確認します。')
    const annotated: ToolDefinition = {
      name: 'annotated',
      config: {
        title: '注釈つき',
        description: 'annotations / outputSchema の受け渡し検証',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      handler: () => Promise.resolve({ content: [], structuredContent: {} }),
    }

    const connected = await connectMcp([annotated])
    try {
      const tools = await connected.client.listTools()
      const [listed] = tools.tools
      expect(listed).toMatchObject({
        name: 'annotated',
        title: '注釈つき',
        annotations: { readOnlyHint: true, idempotentHint: true },
      })
      expect(listed?.outputSchema).toBeDefined()
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('ハンドラに、signal を含む呼び出しの情報を渡す', async () => {
    await explains('ツールを呼び出した場合のテストです。ハンドラに渡された呼び出しの情報に、中断されていない `AbortSignal` が含まれることを確認します。')
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

  describe.each(PROTOCOL_ERAS)('クライアントのキャンセル [%s]', (era) => {
    it('クライアントがキャンセルした場合は、ハンドラの signal を中断する', async () => {
      await explains('処理中のツールの呼び出しを、クライアントがキャンセルした場合のテストです。クライアントの呼び出しが失敗し、ハンドラに渡された `signal` が中断されることを確認します。')
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
        const pending = connected.client.callTool({ name: 'hanging', arguments: {} }, { signal: controller.signal })
        const signal = await started.promise
        expect(signal.aborted).toBe(false)

        controller.abort()

        await expect(pending).rejects.toThrow()
        await vi.waitFor(() => {
          expect(signal.aborted).toBe(true)
        })
      }
      finally {
        await closeMcp(connected)
      }
    })

    it('実行中のツールをキャンセルしても、直後に呼び出した別のツールが完了する', async () => {
      // キャンセルされたハンドラが終わるまでキューは空かない。signal を見て抜けるハンドラなら
      // 後続の呼び出しが詰まらない、という直列化とキャンセルの組み合わせを固定する。
      await explains('実行中のツールをキャンセルした直後に、別のツールを呼び出した場合のテストです。キャンセルされたツールが終了した後に、別のツールが実行され、結果を返すことを確認します。')
      const started: PromiseWithResolvers<void> = Promise.withResolvers()
      const hanging: ToolDefinition = {
        name: 'hanging',
        config: { title: 'Test tool', description: 'キュー占有側', inputSchema: z.object({}) },
        handler: async (_arguments, call) => {
          started.resolve()
          await new Promise<void>((resolve) => {
            call.signal.addEventListener('abort', () => {
              resolve()
            }, { once: true })
          })
          return { content: [] }
        },
      }

      const connected = await connectMcp([hanging, echoTool('after')], { era })
      try {
        const controller = new AbortController()
        const pending = connected.client.callTool({ name: 'hanging', arguments: {} }, { signal: controller.signal })
        const outcome = rejectionOf(pending)
        await started.promise

        controller.abort()
        expect(await outcome).toBeInstanceOf(Error)

        const called = await connected.client.callTool({ name: 'after', arguments: {} })
        expect(called.content).toEqual([{ type: 'text', text: 'ok' }])
      }
      finally {
        await closeMcp(connected)
      }
    })
  })

  it('並行して届いた tools/call は、1 件ずつ実行する', async (context) => {
    await verifies(context, 'PV-COMMON-08')
    // 直列化は createMcpServer 側の enqueue 包装で構造的に保証する。
    // ハンドラ側で enqueue しない (= ツール実装の善意に依存しない) ことがこのテストの主眼。
    await explains('同じツールの `tools/call` を並行して 2 回呼び出した場合のテストです。同時に実行される数が最大 1 で、開始と終了が交互に記録されることを確認します。')
    let running = 0
    let peak = 0
    // ハンドラの出入りを記録する。直列なら start/end が交互に並ぶ。
    const events: string[] = []
    const slow: ToolDefinition = {
      name: 'slow',
      config: { title: 'Test tool', description: '直列性の検証', inputSchema: z.object({}) },
      handler: async () => {
        events.push('start')
        running += 1
        peak = Math.max(peak, running)
        await delay(20)
        running -= 1
        events.push('end')
        return { content: [{ type: 'text', text: 'done' }] }
      },
    }

    const connected = await connectMcp([slow])
    try {
      await Promise.all([
        connected.client.callTool({ name: 'slow', arguments: {} }),
        connected.client.callTool({ name: 'slow', arguments: {} }),
      ])

      expect(peak).toBe(1)
      expect(running).toBe(0)
      // 直列なら start/end が交互に並び、並行に動いていれば start が 2 つ続く。
      // peak の観測が偶然 1 になっただけのケースと判別するための assert。
      // 経過時間 (delay(20) 2 件で 40ms 以上) では、タイマーの発火が数十 us 早いだけで
      // 落ちるフレークになるため、時間ではなく順序で判別する。
      expect(events).toEqual(['start', 'end', 'start', 'end'])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('フックが呼ぶツールは、ほかのツールの実行中でもキューで待たずに返る', async () => {
    await explains('ツールの直列実行のキューのテストです。ほかのツールが実行中でも、フックが呼ぶツール（`isForHook`）がキューで待たずに応答を返すことを確認します。')
    const gate = Promise.withResolvers<undefined>()
    const slow: ToolDefinition = {
      name: 'slow',
      config: { title: 'Test tool', inputSchema: z.object({}) },
      handler: async () => {
        await gate.promise
        return { content: [{ type: 'text', text: 'slow' }] }
      },
    }
    const hook: ToolDefinition = {
      name: 'hook',
      config: { title: 'Test hook tool', inputSchema: z.object({}) },
      handler: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
      isForHook: true,
    }

    const connected = await connectMcp([slow, hook])
    try {
      const slowCall = connected.client.callTool({ name: 'slow', arguments: {} })
      const hookResult = await connected.client.callTool({ name: 'hook', arguments: {} })
      gate.resolve(undefined)
      await slowCall

      expect(hookResult.content).toEqual([{ type: 'text', text: '{}' }])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('フックが呼ぶツールの outputSchema には、共通の 4 項目を足さない', async () => {
    await explains('フックが呼ぶツール（`isForHook`）の `outputSchema` のテストです。共通の 4 項目が追加されず、宣言した `hookSpecificOutput` だけが含まれることを確認します。')
    const hook: ToolDefinition = {
      name: 'hook',
      config: { title: 'Test hook tool', inputSchema: z.object({}), outputSchema: z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }).optional() }) },
      handler: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }], structuredContent: {} }),
      isForHook: true,
    }

    const connected = await connectMcp([hook])
    try {
      const { tools } = await connected.client.listTools()
      const properties = tools[0]?.outputSchema?.['properties'] ?? {}

      expect(Object.keys(properties)).toEqual(['hookSpecificOutput'])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('toCallToolResult で変換した結果が、クライアントの callTool まで同じ内容で届く', async (context) => {
    await verifies(context, 'PV-COMMON-06')
    await explains('失敗の結果を `toCallToolResult` で変換して返すツールのテストです。クライアントが受け取る `isError`、`structuredContent`、`content` が、変換した内容と一致することを確認します。')
    const failing: ToolDefinition = {
      name: 'failing',
      config: { title: 'Test tool', description: 'ToolResult 変換の往復検証', inputSchema: z.object({}) },
      handler: () => Promise.resolve(toCallToolResult({
        ok: false,
        kind: 'export-failed',
        detail: 'export failed',
        data: { file: '/tmp/out.png', log: 'error: export failed' },
      })),
    }

    // toCallToolResult が組み立てるキー順と同じ順で書く (content の JSON テキストと比べるため)。
    const expectedStructured = {
      file: '/tmp/out.png',
      log: 'error: export failed',
      kind: 'export-failed',
      detail: 'export failed',
    }

    const connected = await connectMcp([failing])
    try {
      const called = await connected.client.callTool({ name: 'failing', arguments: {} })

      expect(called.isError).toBe(true)
      expect(called.structuredContent).toEqual(expectedStructured)
      expect(called.content).toEqual([
        { type: 'text', text: 'export failed' },
        { type: 'text', text: JSON.stringify(expectedStructured) },
      ])
    }
    finally {
      await closeMcp(connected)
    }
  })
})

describe('createMcpServer の progress ハートビート', () => {
  const QUEUED = 'gated: waiting in queue'
  const RUNNING = 'gated: running'

  /**
  周期は 5ms に縮め、進行条件を「経過時間」ではなく「受信数」に置いて決定論化する。
  */
  const INTERVAL_MS = 5

  it('progressToken 付きの呼び出しには、キューへの追加直後と、一定の周期で進捗を通知する', async (context) => {
    await verifies(context, 'PV-COMMON-09')
    await explains('`progressToken` を付けてツールを呼び出した場合のテストです。1 回目はキュー待機中、2 回目以降は実行中のメッセージで、進捗の値が 1 から 1 ずつ増えて通知されることを確認します。')
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

      // 1 発目は enqueue 前に送るため必ず「キュー待機中」、以降はデキュー済みで「実行中」。
      expect(received[0]).toMatchObject({ progress: 1, message: QUEUED })
      expect(received[1]).toMatchObject({ progress: 2, message: RUNNING })
      expect(received.length).toBeGreaterThanOrEqual(3)
      // progress は 1 から単調増加する (MCP は同一トークン内での増加を要求する)。
      expect(received.map(item => item.progress)).toEqual(received.map((_item, index) => index + 1))
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('キューで待機している間も、進捗の通知を送り続ける', async (context) => {
    await verifies(context, 'PV-COMMON-09')
    await explains('別のツールがキューを占有していて、待機している場合のテストです。待機中のメッセージの通知が、実行が始まる前に 2 回以上届くことを確認します。')
    const received: Progress[] = []
    const queuedCount = (): number => received.filter(item => item.message === 'waiter: waiting in queue').length
    const occupied: PromiseWithResolvers<void> = Promise.withResolvers()

    // occupier がキューを占有し、waiter はデキュー待ちに回る。待機中の通知が 2 発届いた
    // 時点で占有を解くため、「デキュー前に 2 発以上」が実時間に依存せず決まる。
    const occupier: ToolDefinition = {
      name: 'occupier',
      config: { title: 'Test tool', description: 'キュー占有側', inputSchema: z.object({}) },
      handler: async () => {
        await occupied.promise
        return { content: [] }
      },
    }
    // 万一 2 件の到着順が入れ替わっても占有が解けるようにしておく (ハングではなく assert で落とす)。
    const waiter: ToolDefinition = {
      name: 'waiter',
      config: { title: 'Test tool', description: 'キュー待機側', inputSchema: z.object({}) },
      handler: () => {
        occupied.resolve()
        return Promise.resolve({ content: [] })
      },
    }

    const connected = await connectMcp([occupier, waiter], { progressIntervalMs: INTERVAL_MS })
    try {
      const occupying = connected.client.callTool({ name: 'occupier', arguments: {} })
      const waiting = connected.client.callTool({ name: 'waiter', arguments: {} }, {
        onprogress: (progress) => {
          received.push(progress)
          if (queuedCount() >= 2) occupied.resolve()
        },
      })
      await Promise.all([occupying, waiting])

      expect(queuedCount()).toBeGreaterThanOrEqual(2)
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('周期を指定しない場合は、既定の 10 秒ごとに進捗を通知する', async (context) => {
    await verifies(context, 'PV-COMMON-09')
    await explains('進捗の周期を指定せずにツールを呼び出した場合のテストです。タイマーを進め、10 秒に達するまでは 1 回だけで、10 秒に達すると 2 回目が通知されることを確認します。')
    const received: Progress[] = []
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const gated: ToolDefinition = {
      name: 'gated',
      config: { title: 'Test tool', description: '既定の周期の検証', inputSchema: z.object({}) },
      handler: async () => {
        await gate.promise
        return { content: [] }
      },
    }

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const connected = await connectMcp([gated])
    try {
      const pending = connected.client.callTool({ name: 'gated', arguments: {} }, {
        onprogress: (progress) => {
          received.push(progress)
        },
      })
      // vi.waitFor は偽の setInterval で止まるので、実タイマーの delay で待つ。
      while (received.length === 0) await delay(5)

      await vi.advanceTimersByTimeAsync(9999)
      await delay(20)
      expect(received).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1)
      while (received.length < 2) await delay(5)
      expect(received).toHaveLength(2)
      expect(received[1]).toMatchObject({ progress: 2, message: 'gated: running' })

      gate.resolve()
      await pending
    }
    finally {
      vi.useRealTimers()
      await closeMcp(connected)
    }
  })

  it('reportProgress で報告したメッセージを即座に通知し、以降の定期的な通知でも同じメッセージを使う', async () => {
    await explains('ハンドラが `reportProgress` でメッセージを報告した場合のテストです。報告したメッセージが周期を待たずに通知され、その後の通知でも「実行中」に戻らず、同じメッセージが使われることを確認します。')
    const received: Progress[] = []
    const reported = 'gated: 変換 3/10 (30%)'
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const reporter: ToolDefinition = {
      name: 'gated',
      config: { title: 'Test tool', description: 'reportProgress の検証', inputSchema: z.object({}) },
      handler: async (_arguments, _call, context) => {
        context?.reportProgress('変換 3/10 (30%)')
        await gate.promise
        return { content: [] }
      },
    }

    const connected = await connectMcp([reporter], { progressIntervalMs: INTERVAL_MS })
    try {
      await connected.client.callTool({ name: 'gated', arguments: {} }, {
        onprogress: (progress) => {
          received.push(progress)
          if (received.filter(item => item.message === reported).length >= 2) gate.resolve()
        },
      })

      // 1 発目はキュー待機中、2 発目は報告の即時送出（周期を待たない）。
      expect(received[0]).toMatchObject({ progress: 1, message: QUEUED })
      expect(received[1]).toMatchObject({ progress: 2, message: reported })
      // 報告後に「実行中」へ戻らない。
      expect(received.slice(1).every(item => item.message === reported)).toBe(true)
      expect(received.map(item => item.progress)).toEqual(received.map((_item, index) => index + 1))
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('ツールの完了後に reportProgress が呼び出されても、通知を送らない', async () => {
    await explains('ツールが完了した後に、保持していた `reportProgress` を呼び出した場合のテストです。進捗が通知されず、クライアントにもエラーが届かないことを確認します。')
    const errors: Error[] = []
    let late: ((message: string) => void) | undefined
    const probe: ToolDefinition = {
      name: 'probe',
      config: { title: 'Test tool', description: '完了後の報告の検証', inputSchema: z.object({}) },
      handler: (_arguments, _call, context) => {
        late = context?.reportProgress
        return Promise.resolve({ content: [] })
      },
    }

    const connected = await connectMcp([probe], { progressIntervalMs: 60_000 })
    // 応答済みトークン宛の progress 通知はクライアント側の onerror に届く。
    // SDK の Protocol は EventTarget ではなく onerror プロパティで通知する。
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    connected.client.onerror = (error: Readonly<Error>) => {
      errors.push(error)
    }
    try {
      // onprogress を渡すと progressToken を付与する。報告が送られうる呼び出しにするため。
      const received: Progress[] = []
      await connected.client.callTool({ name: 'probe', arguments: {} }, {
        onprogress: (progress) => { received.push(progress) },
      })
      const beforeLate = received.length
      late?.('遅れた報告')
      await delay(20)

      expect(late).toBeDefined()
      expect(received).toHaveLength(beforeLate)
      expect(errors).toEqual([])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it.for(PROTOCOL_ERAS)('キャンセルした後は、定期的な通知と reportProgress のどちらでも、通知を送らない [%s]', async (era, context) => {
    await verifies(context, 'PV-COMMON-10')
    await explains('ツールの呼び出しをキャンセルした後に、ハンドラが `reportProgress` を呼び出し、周期の時間が経過した場合のテストです。どちらの場合も進捗が通知されず、クライアントにエラーが届かないことを確認します。')
    const errors: Error[] = []
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    const finished: PromiseWithResolvers<void> = Promise.withResolvers()
    const hanging: ToolDefinition = {
      name: 'hanging',
      config: { title: 'Test tool', description: 'キャンセル後の通知の検証', inputSchema: z.object({}) },
      handler: async (_arguments, call, context) => {
        started.resolve()
        await new Promise<void>((resolve) => {
          call.signal.addEventListener('abort', () => {
            resolve()
          }, { once: true })
        })
        // キャンセル済みのリクエストへ報告しても送らない。周期送出が回りうる時間も置く。
        context?.reportProgress('キャンセル後の報告')
        await delay(INTERVAL_MS * 6)
        context?.reportProgress('キャンセル後の報告 2')
        finished.resolve()
        return { content: [] }
      },
    }

    const connected = await connectMcp([hanging], { era, progressIntervalMs: INTERVAL_MS })
    // キャンセル済みトークン宛の progress 通知はクライアント側の onerror に届く (SDK の _onprogress)。
    // SDK の Protocol は EventTarget ではなく onerror プロパティで通知する。
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    connected.client.onerror = (error: Readonly<Error>) => {
      errors.push(error)
    }
    try {
      const controller = new AbortController()
      const pending = connected.client.callTool(
        { name: 'hanging', arguments: {} },
        { signal: controller.signal, onprogress: () => { /* 受信数ではなく onerror 側を見る */ } },
      )
      const outcome = rejectionOf(pending)
      await started.promise

      controller.abort()
      expect(await outcome).toBeInstanceOf(Error)
      await finished.promise
      await delay(INTERVAL_MS * 4)

      expect(errors).toEqual([])
    }
    finally {
      await closeMcp(connected)
    }
  })

  it('progressToken が無い呼び出しには、通知を送らない', async () => {
    await explains('`progressToken` を付けずにツールを呼び出した場合のテストです。ハンドラが `reportProgress` を呼び出しても通知されず、クライアントにエラーが届かないことを確認します。')
    const errors: Error[] = []
    const probe: ToolDefinition = {
      name: 'probe',
      config: { title: 'Test tool', description: 'progressToken 不在時の検証', inputSchema: z.object({}) },
      handler: (_arguments, _call, context) => {
        // token が無ければ報告しても何も送らない。
        context?.reportProgress('送られない報告')
        return Promise.resolve({ content: [] })
      },
    }

    const connected = await connectMcp([probe], { progressIntervalMs: INTERVAL_MS })
    // 未知トークン宛の progress 通知はクライアント側の onerror に届く (SDK の _onprogress)。
    // 送ってはいけない通知を送った場合の観測点はここになる。
    // SDK の Protocol は EventTarget ではなく onerror プロパティで通知する。
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    connected.client.onerror = (error: Readonly<Error>) => {
      errors.push(error)
    }
    try {
      const called = await connected.client.callTool({ name: 'probe', arguments: {} })

      expect(errors).toEqual([])
      expect(called.isError).toBeUndefined()
    }
    finally {
      await closeMcp(connected)
    }
  })
})
