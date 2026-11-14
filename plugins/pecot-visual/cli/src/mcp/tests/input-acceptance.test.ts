// 入力の受理・拒否の特性テスト (#1228)。
//
// MCP SDK の入力検証層を全 11 ツールで通し、受理する入力・拒否する入力・ハンドラへ届く値
// (既定値の適用と宣言外キーの除去) が SDK の版に依らず同じであることを pin する。
// 本番の createMcpServer に、実ツール定義の handler だけを spy に差し替えて渡す。
// そのため awscli と Slidev は起動しない。
//
// 起動ルートは本番と同じ serveStdio で、2025 系と 2026-07-28 系のクライアントそれぞれから回す。
//
// 拒否は 2 種に分けて見る。スキーマ拒否は isError 結果・structuredContent なし・spy 未到達で、
// 本文に `Input validation error` を含む。未知ツールは JSON-RPC エラー (-32602) になり、
// どちらも spy に届かない。

import type { CallToolResult } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isRecord } from '../../../tests/_helpers/records.js'
import { rejectionOf } from '../../../tests/_helpers/rejection.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { toCallToolResult } from '../result.js'
import { allTools } from '../tools/index.js'
import {
  classifyCall,
  closeMcp,
  connectMcp,
  connectSpied,
  INVALID_PARAMS_CODE,
  negotiatedVersionOf,
  PROTOCOL_ERAS,
  SPY_RESULT,
  type ProtocolEra,
  type SpiedMcp,
} from './_client.js'

type Arguments = Readonly<Record<string, unknown>>

interface ToolTable {
  readonly tool: string
  /**
  必須パラメータだけの入力。
  */
  readonly minimal: Arguments
  /**
  minimal を受理したとき、ハンドラへ届く値 (既定値の適用後)。
  */
  readonly delivered: Arguments
  /**
  全パラメータを指定した入力。既定値と異なる値を使い、そのままハンドラへ届くことを見る。
  */
  readonly full: Arguments
  /**
  スキーマ違反の入力。ラベルは拒否の理由。
  */
  readonly rejects: readonly (readonly [label: string, arguments_: Arguments])[]
}

const TABLES: readonly ToolTable[] = [
  {
    tool: 'slide_create',
    minimal: { project_dir: '/work/deck', theme: 'file:/work/theme' },
    delivered: { project_dir: '/work/deck', theme: 'file:/work/theme', force: false },
    full: { project_dir: '/work/deck', theme: 'git+https://example.com/org/theme.git#v1.0.0', force: true },
    rejects: [
      ['必須の project_dir が無い', { theme: 'file:/work/theme' }],
      ['必須の theme が無い', { project_dir: '/work/deck' }],
      ['project_dir が数値', { project_dir: 1, theme: 'file:/work/theme' }],
      ['theme が数値', { project_dir: '/work/deck', theme: 1 }],
      ['force が文字列', { project_dir: '/work/deck', theme: 'file:/work/theme', force: 'true' }],
    ],
  },
  {
    tool: 'slide_convert',
    minimal: { project_dir: '/work/deck' },
    delivered: { project_dir: '/work/deck', cache: true },
    full: {
      project_dir: '/work/deck',
      out_path: '/work/out.pptx',
      theme: '@scope/theme',
      spacing_json_path: '/work/spacing.json',
      href_json_path: '/work/href.json',
      transition_type: 'morph',
      transition_duration_ms: 800,
      morph_option: 'byWord',
      cache: false,
    },
    rejects: [
      ['必須の project_dir が無い', {}],
      ['project_dir が数値', { project_dir: 1 }],
      ['transition_type が enum 外', { project_dir: '/work/deck', transition_type: 'slide' }],
      ['morph_option が enum 外', { project_dir: '/work/deck', morph_option: 'byLine' }],
      ['transition_duration_ms が 0', { project_dir: '/work/deck', transition_duration_ms: 0 }],
      ['transition_duration_ms が小数', { project_dir: '/work/deck', transition_duration_ms: 1.5 }],
      ['transition_duration_ms が文字列', { project_dir: '/work/deck', transition_duration_ms: '500' }],
      ['cache が文字列', { project_dir: '/work/deck', cache: 'false' }],
    ],
  },
  {
    tool: 'slide_sync',
    minimal: { dir: '/work/deck' },
    delivered: { dir: '/work/deck', node_modules_only: false },
    full: { dir: '/work/deck', theme: 'file:/work/theme', node_modules_only: true },
    rejects: [
      ['必須の dir が無い', {}],
      ['dir が配列', { dir: ['/work/deck'] }],
      ['theme が数値', { dir: '/work/deck', theme: 1 }],
      ['node_modules_only が数値', { dir: '/work/deck', node_modules_only: 1 }],
    ],
  },
  {
    tool: 'slide_lint',
    minimal: { dir: '/work/deck' },
    delivered: { dir: '/work/deck' },
    full: { dir: '/work/deck' },
    rejects: [
      ['必須の dir が無い', {}],
      ['dir が数値', { dir: 1 }],
    ],
  },
  {
    tool: 'slide_dev',
    minimal: { dir: '/work/deck' },
    delivered: { dir: '/work/deck', stop: false },
    full: { dir: '/work/deck', port: 3031, stop: true },
    rejects: [
      ['必須の dir が無い', {}],
      ['port が 0', { dir: '/work/deck', port: 0 }],
      ['port が 65536', { dir: '/work/deck', port: 65_536 }],
      ['port が小数', { dir: '/work/deck', port: 3030.5 }],
      ['port が文字列', { dir: '/work/deck', port: '3030' }],
      ['stop が文字列', { dir: '/work/deck', stop: 'true' }],
    ],
  },
  {
    tool: 'slide_page',
    minimal: { layout: 'cover', dir: '/work/deck', file: 'intro' },
    delivered: { layout: 'cover', dir: '/work/deck', file: 'intro', force: false },
    full: { layout: 'cover', dir: '/work/deck', file: 'intro.md', force: true },
    rejects: [
      ['必須の layout が無い', { dir: '/work/deck', file: 'intro' }],
      ['必須の dir が無い', { layout: 'cover', file: 'intro' }],
      ['必須の file が無い', { layout: 'cover', dir: '/work/deck' }],
      ['layout が数値', { layout: 1, dir: '/work/deck', file: 'intro' }],
      ['force が文字列', { layout: 'cover', dir: '/work/deck', file: 'intro', force: 'true' }],
    ],
  },
  {
    tool: 'slide_theme',
    minimal: { dir: '/work/deck' },
    delivered: { dir: '/work/deck' },
    full: { dir: '/work/deck' },
    rejects: [
      ['必須の dir が無い', {}],
      ['dir が数値', { dir: 1 }],
    ],
  },
  {
    tool: 'drawio_create',
    minimal: { input_path: '/work/a.drawio' },
    delivered: { input_path: '/work/a.drawio', mode: 'view', png: true },
    full: { input_path: '/work/a.drawio', mode: 'edit', out_path: '/work/a.html', theme: 'file:/work/theme', png: false },
    rejects: [
      ['必須の input_path が無い', {}],
      ['mode が enum 外', { input_path: '/work/a.drawio', mode: 'preview' }],
      ['png が文字列', { input_path: '/work/a.drawio', png: 'true' }],
      ['theme が数値', { input_path: '/work/a.drawio', theme: 1 }],
      ['out_path が数値', { input_path: '/work/a.drawio', out_path: 1 }],
    ],
  },
  {
    tool: 'drawio_export',
    minimal: { input_path: '/work/a.drawio' },
    delivered: { input_path: '/work/a.drawio', print_hash: false, pdf: true },
    full: { input_path: '/work/a.drawio', icons_dir: '/work/icons', out_path: '/work/a.svg', print_hash: true, pdf: false },
    rejects: [
      ['必須の input_path が無い', {}],
      ['input_path が数値', { input_path: 1 }],
      ['print_hash が文字列', { input_path: '/work/a.drawio', print_hash: 'true' }],
      ['pdf が数値', { input_path: '/work/a.drawio', pdf: 0 }],
    ],
  },
  {
    tool: 'evidence_create',
    minimal: { input_path: '/work/spec.json' },
    delivered: { input_path: '/work/spec.json' },
    full: { input_path: '/work/spec.json', out_path: '/work/evidence.xlsx' },
    rejects: [
      ['必須の input_path が無い', {}],
      ['input_path が数値', { input_path: 1 }],
      ['out_path が真偽値', { input_path: '/work/spec.json', out_path: true }],
    ],
  },
  {
    tool: 'runtime_setup',
    minimal: {},
    delivered: {},
    full: {},
    rejects: [],
  },
]

const UNEXPECTED = { unexpected_property: 'x' }

/**
slide_lint の handler だけを差し替えたサーバへ接続し、tools/call の結果を返す。
*/
async function callLintWith(era: ProtocolEra, handlerResult: () => CallToolResult): Promise<CallToolResult> {
  const lint = allTools().find(tool => tool.name === 'slide_lint')
  if (lint === undefined) throw new Error('slide_lint が公開されていません')
  const connected = await connectMcp([{ ...lint, handler: () => Promise.resolve(handlerResult()) }], { era })
  try {
    return await connected.client.callTool({ name: 'slide_lint', arguments: { dir: '/work/deck' } })
  }
  finally {
    await closeMcp(connected)
  }
}

describe.each(PROTOCOL_ERAS)('MCP ツールの入力の受理・拒否 (クライアントのプロトコル世代: %s)', (era: ProtocolEra) => {
  let mcp: SpiedMcp

  beforeAll(async () => {
    mcp = await connectSpied(era)
  })

  afterAll(async () => {
    await closeMcp(mcp)
  })

  it('期待したプロトコル版で接続している', () => {
    expect(mcp.client.getNegotiatedProtocolVersion()).toBe(negotiatedVersionOf(era))
  })

  it('表が全ツールを網羅している', () => {
    expect(TABLES.map(table => table.tool)).toEqual(allTools().map(tool => tool.name))
  })

  describe.each(TABLES)('$tool', (table) => {
    it('必須だけの入力を受理し、既定値を補ってハンドラへ渡す', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, table.tool, table.minimal)

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([{ name: table.tool, arguments: table.delivered }])
    })

    it('全パラメータの入力を受理し、そのままハンドラへ渡す', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, table.tool, table.full)

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([{ name: table.tool, arguments: table.full }])
    })

    it('宣言外のキーは拒否せず、ハンドラへ渡さない', async (context) => {
      await verifies(context, 'PV-COMMON-02')
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, table.tool, { ...table.minimal, ...UNEXPECTED })

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([{ name: table.tool, arguments: table.delivered }])
    })

    it('成功結果が outputSchema の検証を通ってクライアントへ届く', async () => {
      const called = await mcp.client.callTool({ name: table.tool, arguments: { ...table.minimal } })

      expect(called.isError).toBeUndefined()
      expect(called.structuredContent).toEqual(toCallToolResult(SPY_RESULT).structuredContent)
    })

    it.for(table.rejects)('スキーマ違反を拒否する: %s', async ([, arguments_], context) => {
      await verifies(context, 'PV-COMMON-01')
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, table.tool, arguments_)

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })
  })

  describe('結果の outputSchema 検証', () => {
    it('失敗結果 (isError + structuredContent) もスキーマ拒否とは区別されてクライアントへ届く', async () => {
      const failure = toCallToolResult({ ok: false, exitCode: 1, kind: 'unknown', artifacts: [], data: { event: 'x' }, message: 'failed' })

      const called = await callLintWith(era, () => failure)

      expect(called.isError).toBe(true)
      expect(called.structuredContent).toEqual(failure.structuredContent)
    })

    it('outputSchema に違反する structuredContent は拒否され、違反した値はクライアントへ届かない', async () => {
      const violating: CallToolResult = { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: 'yes' } }

      const called = await callLintWith(era, () => violating)

      expect(called.isError).toBe(true)
      expect(called.structuredContent).toBeUndefined()
      const [block] = called.content
      expect(block?.type === 'text' ? block.text : '').toContain('Output validation error')
    })
  })

  describe('未知ツール', () => {
    it('JSON-RPC エラー (-32602) で拒否し、ハンドラへ届かない', async (context) => {
      await verifies(context, 'PV-COMMON-13')
      const before = mcp.calls.length
      const error: unknown = await rejectionOf(mcp.client.callTool({ name: 'no_such_tool', arguments: {} }))

      expect(isRecord(error) && error['code']).toBe(INVALID_PARAMS_CODE)
      expect(mcp.calls).toHaveLength(before)
    })
  })
})
