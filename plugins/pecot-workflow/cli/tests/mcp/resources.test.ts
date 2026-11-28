// テンプレートの resource（resources/list・resources/read）と、initialize で返す capabilities・instructions を確かめる。
import { ProtocolError } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'

import { TOOLS } from '../../src/commands/registry.js'
import { templateFile } from '../../src/infra/template-store.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'
import { createMcpServer, MCP_INSTRUCTIONS } from '../../src/mcp/server.js'
import { connectInMemory } from '../_helpers/mcp-client.js'
import type { ConnectedClient } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'

const INVALID_PARAMS = -32_602

type TemplateKind = 'comment' | 'issue' | 'pr'

const TEMPLATES: readonly { readonly kind: TemplateKind, readonly name: string }[] = [
  { kind: 'comment', name: 'plan' },
  { kind: 'comment', name: 'merge-diff' },
  { kind: 'comment', name: 'review-findings' },
  { kind: 'comment', name: 'review-resolution' },
  { kind: 'comment', name: 'precede-notify' },
  { kind: 'issue', name: 'task' },
  { kind: 'issue', name: 'bug' },
  { kind: 'issue', name: 'epic' },
  { kind: 'issue', name: 'tracker' },
  { kind: 'issue', name: 'task-implement' },
  { kind: 'pr', name: 'create' },
  { kind: 'pr', name: 'release' },
]

const opened: ConnectedClient[] = []

async function connect(unavailableReason?: string): Promise<ConnectedClient> {
  const connected = await connectInMemory(createMcpServer(TOOLS, { unavailableReason }))
  opened.push(connected)
  return connected
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (connected) => {
    await connected.close()
  }))
})

describe('initialize', () => {
  it('つなぐと、capabilities に resources を持ち、テンプレートの使い方を instructions に返す', async () => {
    await explains('MCP サーバへ接続したときに返す、capabilities と instructions のテストです。capabilities に `resources` が含まれることを確認します。instructions に、テンプレートの URI と、書く前に通すツール・公式の GitHub MCP のツールの名前が含まれることも確認します。')
    const { client } = await connect()
    expect(client.getServerCapabilities()).toHaveProperty('resources')
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)
    const named = ['pecot-template://', 'issue_check', 'issue_dependency_check', 'issue_comment_check', 'issue_write', 'issue_dependency_write', 'add_issue_comment', 'update_issue_comment', 'pr_check', 'create_pull_request', 'update_pull_request', 'merge_pull_request']
    expect(named.filter(name => !MCP_INSTRUCTIONS.includes(name))).toEqual([])
  })
})

describe('resources/list', () => {
  it('一覧を読むと、12 本のテンプレートの URI・名前・Markdown の MIME 型を返す', async () => {
    await explains('テンプレートの一覧を取得する（`resources/list`）テストです。12 本のテンプレートの URI・名前・MIME 型（`text/markdown`）が返り、すべてに説明が付いていることを確認します。')
    const { client } = await connect()
    const { resources } = await client.listResources()
    expect(resources.map(resource => ({ uri: resource.uri, name: resource.name, mimeType: resource.mimeType }))).toEqual(
      TEMPLATES.map(({ kind, name }) => ({ uri: `pecot-template://${kind}/${name}`, name: `${kind}/${name}`, mimeType: 'text/markdown' })),
    )
    expect(resources.every(resource => (resource.description ?? '') !== '')).toBe(true)
  })
})

describe('resources/read', () => {
  it.for(TEMPLATES)('$kind の $name を読むと、配布するテンプレートのファイルと同じ中身を返す', async ({ kind, name }) => {
    await explains(`テンプレート（\`pecot-template://${kind}/${name}\`）を読み取る（\`resources/read\`）テストです。返る内容が、配布するテンプレートのファイルの中身と一致することを確認します。`)
    const { client } = await connect()
    const uri = `pecot-template://${kind}/${name}`
    const { contents } = await client.readResource({ uri })
    expect(contents).toEqual([{ uri, mimeType: 'text/markdown', text: readTextFile(templateFile(kind, name)) }])
  })

  it('存在しない URI を読むと、-32602 のエラーを返す', async () => {
    await explains('存在しない URI を読み取ろうとした場合に、エラーコード `-32602` の `ProtocolError` が返ることを確認します。')
    const { client } = await connect()
    const reading = client.readResource({ uri: 'pecot-template://comment/none' })
    await expect(reading).rejects.toBeInstanceOf(ProtocolError)
    await expect(reading).rejects.toMatchObject({ code: INVALID_PARAMS })
  })

  it('ツールを使えない状態でも、テンプレートは読める', async () => {
    await explains('ツールを使えない状態（ワークスペースが信頼されていない状態）で接続した場合のテストです。それでもテンプレートを読み取れ、配布するテンプレートの中身が返ることを確認します。')
    const { client } = await connect('the workspace is not trusted')
    const { contents } = await client.readResource({ uri: 'pecot-template://comment/plan' })
    expect(contents).toEqual([{ uri: 'pecot-template://comment/plan', mimeType: 'text/markdown', text: readTextFile(templateFile('comment', 'plan')) }])
  })
})
