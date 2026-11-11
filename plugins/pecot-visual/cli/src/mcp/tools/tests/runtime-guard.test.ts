// 実行時依存 (永続層) の実行時ガード (src/mcp/tools/_shared.ts の ensureRuntimeDependencies)
// の単体テスト。
//
// 単体配布ルートでは @slidev/cli / dom-to-pptx / @slidev/parser を起動層に載せられない。
// `@slidev/types` 経由で monaco-editor / mermaid が乗り、起動が MCP の接続タイムアウトを超えるため。
// そのため `setup` を呼ぶまで解決できない。
// そのとき slide_convert が例外で止まらず、ToolResult 契約 (reason 付きで `setup` を案内する) で返ることを固定する。
//
// プラグインルートでは実行時依存が同梱されているため、このガードは常に通過する。

// SDK の CallToolResult は mutable メンバを持つ。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'

import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { snapshotTree } from './tree-snapshot.js'
import type { ToolCallContext } from '../../server.js'
import { slideDevTool } from '../slide-dev.js'
import { slideConvertTool, slideCreateTool, slideSyncTool } from '../slide.js'
import { ensureRuntimeDependencies, RUNTIME_ROOT_PLACEHOLDER, type RuntimeDependencies } from '../_shared.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const RUNTIME_ROOT = '/fake/pecotv-runtime'
// ガードで止まるため中身は読まれない。絶対パスの file: で、取得の前に止まることを表す。
const THEME_SPEC = `file:${path.join(CLI_ROOT, 'tests', 'fixtures', 'themes', 'with-declaration')}`

const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
}

function fakeRuntimeDependencies(
  isInstalled: boolean,
  root: () => string | undefined = () => RUNTIME_ROOT,
): RuntimeDependencies {
  return {
    isInstalled: () => isInstalled,
    root,
    install: () => {
      throw new Error('ガードは取得を試みない (取得は setup ツールの責務)')
    },
  }
}

describe('ensureRuntimeDependencies', () => {
  it('解決できるなら undefined を返し、実処理を止めない', () => {
    expect(ensureRuntimeDependencies('slide_convert', fakeRuntimeDependencies(true))).toBeUndefined()
  })

  it('未取得なら取得を試みず、reason 付きで setup を案内する', () => {
    // 600MB 級の npm install は、モデルが呼ぶツールの側から通知なしに始めてよい規模ではない。
    const result = ensureRuntimeDependencies('slide_convert', fakeRuntimeDependencies(false))

    expect(result?.ok).toBe(false)
    expect(result?.exitCode).toBe(1)
    expect(result?.artifacts).toEqual([])
    expect(result?.data).toMatchObject({
      event: 'runtime-dependencies.unavailable',
      reason: 'runtime-dependencies-not-installed',
      expectedAt: RUNTIME_ROOT,
    })
    expect(String(result?.message)).toContain('setup')
  })

  it('取得先を特定できなくても期待場所を文言で示す', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- root は場所を特定できないとき undefined を返す契約
    const dependencies = fakeRuntimeDependencies(false, () => undefined)
    const result = ensureRuntimeDependencies('slide_convert', dependencies)

    expect(result?.data['expectedAt']).toBe(RUNTIME_ROOT_PLACEHOLDER)
  })
})

/**
ガードで止まる前提のツールに渡す deps ファクトリ。呼ばれたら設計が崩れている。
*/
function buildFailingDependencies(): never {
  throw new Error('ガードで止まるので既定 deps は組み立てない')
}

describe('slide_create / slide_sync / slide_dev への接続', () => {
  // 4 ツールとも、依存ルートの実体が要る。
  // create / sync は node_modules symlink、convert は pipeline の実行時解決、dev は @slidev/cli の bin を使う。
  // 接続が欠けると fs.ts の symlink-failed で失敗する。
  // 同じ「未取得」でも、reason と event がツールごとに別物となる。

  it('slide_create は生成を始めず ToolResult 契約で返す', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-09')
    // ガードが実処理の後ろにあると、テーマの取得 (git) を終えた後で symlink-failed になり、
    // setup を案内する reason が返らない。
    const projectDirectory = path.join(CLI_ROOT, 'tests', 'fixtures', 'not-created-yet')
    const tool = slideCreateTool(buildFailingDependencies, () => fakeRuntimeDependencies(false))

    const result = await tool.handler({ project_dir: projectDirectory, theme: THEME_SPEC, force: false }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('runtime-dependencies-not-installed')
    expect(dataOf(result)['event']).toBe('runtime-dependencies.unavailable')
    expect(existsSync(projectDirectory), '半作成の talk-dir を残さない').toBe(false)
    expect(String(structuredOf(result)['message'])).toContain('call the `setup` tool')
  })

  it('slide_sync も同じ reason / event で返す', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-09')
    const tool = slideSyncTool(buildFailingDependencies, () => fakeRuntimeDependencies(false))

    const talk = path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev')
    const before = snapshotTree(talk)

    const result = await tool.handler({ dir: talk, node_modules_only: false }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('runtime-dependencies-not-installed')
    expect(dataOf(result)['event']).toBe('runtime-dependencies.unavailable')
    expect(String(structuredOf(result)['message'])).toContain('call the `setup` tool')
    expect(snapshotTree(talk)).toEqual(before)
  })

  it('slide_dev はレジストリに触れず同じ reason / event で返す', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-09')
    // ガードが後ろにあると、@slidev/cli を解決できない環境で子プロセスの起動エラーに化ける。
    const tool = slideDevTool(buildFailingDependencies, () => fakeRuntimeDependencies(false))

    const result = await tool.handler({ dir: path.join(CLI_ROOT, 'tests', 'fixtures'), stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('runtime-dependencies-not-installed')
    expect(dataOf(result)['event']).toBe('runtime-dependencies.unavailable')
    expect(String(structuredOf(result)['message'])).toContain('call the `setup` tool')
  })

  it('4 ツールの応答はツール名だけが違う同じ形になる', async () => {
    const calls: readonly [string, Record<string, unknown>][] = [
      ['slide_create', { project_dir: path.join(CLI_ROOT, 'tests', 'fixtures', 'not-created-yet'), theme: THEME_SPEC }],
      ['slide_convert', { project_dir: path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev') }],
      ['slide_sync', { dir: path.join(CLI_ROOT, 'tests', 'fixtures') }],
      ['slide_dev', { dir: path.join(CLI_ROOT, 'tests', 'fixtures') }],
    ]
    const tools = [
      slideCreateTool(buildFailingDependencies, () => fakeRuntimeDependencies(false)),
      slideConvertTool(buildFailingDependencies, () => fakeRuntimeDependencies(false)),
      slideSyncTool(buildFailingDependencies, () => fakeRuntimeDependencies(false)),
      slideDevTool(buildFailingDependencies, () => fakeRuntimeDependencies(false)),
    ]

    const normalized = new Set<string>()
    for (const [index, [name, toolArguments]] of calls.entries()) {
      const tool = tools.at(index)
      if (tool === undefined) throw new Error('calls と tools の対応が崩れている')
      const result = await tool.handler(toolArguments, CALL)

      expect(structuredOf(result)['exitCode']).toBe(1)
      expect(dataOf(result)['reason']).toBe('runtime-dependencies-not-installed')
      const message = String(structuredOf(result)['message'])
      expect(message, `${name} の名前が message に出ない`).toContain(name)
      normalized.add(message.replaceAll(name, '<tool>'))
    }
    expect(normalized.size, 'ツール名を伏せると 4 件とも同じ文言').toBe(1)
  })
})

describe('slide_convert への接続', () => {
  const projectDirectory = path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev')

  it('実行時依存が未取得なら変換を始めず ToolResult 契約で返す', async (context) => {
    await verifies(context, 'PV-SLIDE-CONVERT-06')
    // 静的 import のままだと、@slidev/parser が無い環境では本モジュールの読み込み時点で
    // 落ちる。動的 import 化 + ガードで「例外」ではなく「理由付きの応答」になる。
    const tool = slideConvertTool(
      () => {
        throw new Error('ガードで止まるので既定 deps は組み立てない')
      },
      () => fakeRuntimeDependencies(false),
    )

    const result = await tool.handler({ project_dir: projectDirectory }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('runtime-dependencies-not-installed')
    expect(String(structuredOf(result)['message'])).toContain('call the `setup` tool')
  })

  it('相対パスの拒否はガードより先に働く', async () => {
    // 引数の検証を飛ばして依存の話に倒すと、どちらが原因か分からない応答になる。
    const tool = slideConvertTool(
      () => {
        throw new Error('ガードで止まるので既定 deps は組み立てない')
      },
      () => fakeRuntimeDependencies(false),
    )

    const result = await tool.handler({ project_dir: 'relative/dir' }, CALL)

    expect(dataOf(result)).toHaveProperty('invalidPaths')
    expect(dataOf(result)['reason']).toBeUndefined()
  })
})
