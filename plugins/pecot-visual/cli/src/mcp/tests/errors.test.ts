// T007: 異常系の応答形テスト。
//
// 4 ケースの組み合わせ: inputSchema 違反と未捕捉例外は structuredContent を伴わず、相対パス (invalid-path) と実行失敗は kind つきで返す。
// SC-005 (サーバ稼働継続) は、エラーの後に正常呼び出しが通ることで見る。

import path from 'node:path'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'

import { allTools } from '../tools/index.js'
import type { ToolDefinition } from '../server.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'

// src/mcp/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
// cli/ → plugins/pecot-visual (既定 deps ファクトリが要求する CLAUDE_PLUGIN_ROOT)
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
// 警告 0 件で URL を返す既存 fixture。out_path を省略するので、PNG 生成とネットワークのどちらにも触れない。
const MINIMAL_DRAWIO = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio')
const MISSING_DRAWIO = path.join(PLUGIN_ROOT, 'no-such-dir-980', 'missing.drawio')

// 引数を Record で受けるのは、client.callTool の戻り型が CallToolResult と互換応答型の union だから。
// 片側に content / structuredContent が無い。どちらも文字列キーの index signature は持つ。
function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function firstTextOf(result: Readonly<Record<string, unknown>>): string {
  const content = result['content']
  if (!Array.isArray(content)) throw new TypeError('content が配列ではありません')
  const block: unknown = content[0]
  if (!isRecord(block) || typeof block['text'] !== 'string') throw new Error('text ブロックが返っていません')
  return block['text']
}

describe('MCP ツールの異常系応答', () => {
  let previousPluginRoot: string | undefined
  let connected: ConnectedMcp | undefined

  beforeAll(async () => {
    previousPluginRoot = process.env['CLAUDE_PLUGIN_ROOT']
    process.env['CLAUDE_PLUGIN_ROOT'] = PLUGIN_ROOT
    connected = await connectMcp(allTools())
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
    if (previousPluginRoot === undefined) {
      // interface-env: none
      Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
    }
    else {
      process.env['CLAUDE_PLUGIN_ROOT'] = previousPluginRoot
    }
  })

  function client(): ConnectedMcp['client'] {
    if (connected === undefined) throw new Error('サーバへ接続できていません')
    return connected.client
  }

  it('必須パラメータ欠落は入力検証で弾き、structuredContent を返さない', async (context) => {
    await verifies(context, 'PV-COMMON-01')
    const called = await client().callTool({ name: 'drawio_create', arguments: {} })

    expect(called.isError).toBe(true)
    expect(called.structuredContent).toBeUndefined()
    expect(firstTextOf(called)).toContain('Input validation error:')
  })

  it('型不一致も同じく入力検証で弾く', async () => {
    const called = await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: MINIMAL_DRAWIO, png: 'yes' },
    })

    expect(called.isError).toBe(true)
    expect(called.structuredContent).toBeUndefined()
    expect(firstTextOf(called)).toContain('Input validation error:')
  })

  it('相対パスは実処理を呼ばずに invalid-path で返す', async () => {
    // 存在しない相対パスを渡す。実処理まで進んでいれば「入力不在」の input-not-found になるため、
    // invalid-path が返ること自体、「実行前に弾いた」証拠になる。
    const called = await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: 'no-such-dir-980/missing.drawio' },
    })
    const structured = structuredOf(called)

    expect(called.isError).toBe(true)
    expect(structured['kind']).toBe('invalid-path')
    expect(firstTextOf(called)).toContain('must be an absolute path')
  })

  it('入力ファイル不在は実行失敗として input-not-found で返す', async () => {
    const called = await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: MISSING_DRAWIO },
    })
    const structured = structuredOf(called)

    expect(called.isError).toBe(true)
    expect(structured['kind']).toBe('input-not-found')
    expect(structured).not.toHaveProperty('reason')
    expect(firstTextOf(called)).toBe(structured['detail'])
  })

  it('エラー 2 連投のあとでも同じ接続で正常呼び出しが通る', async (context) => {
    await verifies(context, 'PV-COMMON-12')
    // 入力検証エラー (キューに載る前で弾かれる) と実行エラー (キューを通る) を 1 件ずつ挟み、
    // どちらのルートもサーバとキューを壊さないことを見る。
    const invalid = await client().callTool({ name: 'drawio_create', arguments: {} })
    const failed = await client().callTool({ name: 'drawio_create', arguments: { input_path: MISSING_DRAWIO } })
    const succeeded = await client().callTool({ name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO } })
    const structured = structuredOf(succeeded)

    expect(invalid.isError).toBe(true)
    expect(failed.isError).toBe(true)
    expect(succeeded.isError).toBeUndefined()
    expect(structured).not.toHaveProperty('kind')
    expect(structured['url'])
      .toEqual(expect.stringContaining('https://'))
  })

  it('ハンドラ内の未捕捉例外は当該呼び出しだけを失敗させ、サーバは受け付け続ける (SC-005)', async (context) => {
    await verifies(context, 'PV-COMMON-14')
    // 実ツールのハンドラは例外を捕捉して ok:false を返す設計なので、未捕捉例外のルートは
    // 意図的に throw するツールを登録して直接作る。
    const exploding: ToolDefinition = {
      name: 'exploding',
      config: { description: '未捕捉例外の検証用', inputSchema: z.object({}) },
      handler: () => {
        throw new Error('意図的な失敗')
      },
    }
    const survivor: ToolDefinition = {
      name: 'survivor',
      config: { description: '後続呼び出しの検証用', inputSchema: z.object({}) },
      handler: () => Promise.resolve({ content: [{ type: 'text', text: 'alive' }] }),
    }

    const local = await connectMcp([exploding, survivor])
    try {
      const exploded = await local.client.callTool({ name: 'exploding', arguments: {} })
      const alive = await local.client.callTool({ name: 'survivor', arguments: {} })

      expect(exploded.isError).toBe(true)
      expect(firstTextOf(exploded)).toContain('意図的な失敗')
      expect(alive.isError).toBeUndefined()
      expect(alive.content).toEqual([{ type: 'text', text: 'alive' }])
    }
    finally {
      await closeMcp(local)
    }
  })
})
