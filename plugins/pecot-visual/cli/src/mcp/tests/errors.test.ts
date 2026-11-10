// T007: 異常系の応答形テスト。
//
// 契約基準は aist-roadmap の specs/011-aistv-mcp-server/contracts/mcp-tools.md 「エラー契約」。
// その 4 ケースを、応答の形として pin する。
// ケースごとに isError / structuredContent / exitCode の組み合わせが異なる。
// とくに inputSchema 違反だけは structuredContent を伴わない。
// SDK v2 は JSON-RPC エラーにせず、`isError: true` の結果として本文に接頭辞なしの `Input validation error: ...` を載せて返す。
// 本文は部分一致で見る。
//
// 4 ケースの組み合わせは次のとおり。
// - inputSchema 違反: isError は true。structuredContent と exitCode は無し。
// - 相対パス: isError は true。structuredContent は有り。exitCode は 2。
// - 実行失敗 (入力不在): isError は true。structuredContent は有り。exitCode は 1。
// - ハンドラ内未捕捉例外: isError は true。structuredContent と exitCode は無し (SDK が包む)。
//
// SC-005 (サーバ稼働継続) は 2 段で見る。
// 1 段目は、実ツールのエラー 2 連投後に正常呼び出しが通ること。
// 2 段目は、意図的に throw するツールを登録したサーバで後続呼び出しが通ること。

import path from 'node:path'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'

import { allTools } from '../tools/index.js'
import type { ToolDefinition } from '../server.js'
import { isRecord } from '../../../tests/_helpers/records.js'
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

  it('必須パラメータ欠落は入力検証で弾き、structuredContent を返さない', async () => {
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

  it('相対パスは実処理を呼ばずに exitCode 2 で返す', async () => {
    // 存在しない相対パスを渡す。実処理まで進んでいれば「入力不在」の exitCode 1 になるため、
    // exitCode 2 が返ること自体、「実行前に弾いた」証拠になる。
    const called = await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: 'no-such-dir-980/missing.drawio' },
    })
    const structured = structuredOf(called)

    expect(called.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(structured['artifacts']).toEqual([])
    expect(structured['message']).toContain('must be an absolute path')
  })

  it('入力ファイル不在は実行失敗として exitCode 1 で返す', async () => {
    const called = await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: MISSING_DRAWIO },
    })
    const structured = structuredOf(called)

    expect(called.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['artifacts']).toEqual([])
    expect(typeof structured['message']).toBe('string')
    expect(structured['message']).not.toBe('')
  })

  it('エラー 2 連投のあとでも同じ接続で正常呼び出しが通る', async () => {
    // 入力検証エラー (キューに載る前で弾かれる) と実行エラー (キューを通る) を 1 件ずつ挟み、
    // どちらのルートもサーバとキューを壊さないことを見る。
    const invalid = await client().callTool({ name: 'drawio_create', arguments: {} })
    const failed = await client().callTool({ name: 'drawio_create', arguments: { input_path: MISSING_DRAWIO } })
    const succeeded = await client().callTool({ name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO } })
    const structured = structuredOf(succeeded)

    expect(invalid.isError).toBe(true)
    expect(failed.isError).toBe(true)
    expect(succeeded.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(isRecord(structured['data']) ? structured['data']['url'] : undefined)
      .toEqual(expect.stringContaining('https://'))
  })

  it('ハンドラ内の未捕捉例外は当該呼び出しだけを失敗させ、サーバは受け付け続ける (SC-005)', async () => {
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
