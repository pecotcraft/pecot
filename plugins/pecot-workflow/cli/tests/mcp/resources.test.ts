// テンプレートの resource（resources/list・resources/read）と、initialize で返す capabilities・instructions を確かめる。
import { ProtocolError } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { templateFile } from '../../src/infra/template-store.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'
import { createMcpServer, MCP_INSTRUCTIONS } from '../../src/mcp/server.js'
import { connectInMemory } from '../_helpers/mcp-client.js'
import type { ConnectedClient } from '../_helpers/mcp-client.js'

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
  const connected = await connectInMemory(createMcpServer(COMMANDS, { unavailableReason }))
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
    const { client } = await connect()
    expect(client.getServerCapabilities()).toHaveProperty('resources')
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)
    expect(MCP_INSTRUCTIONS).toContain('pecot-template://')
  })
})

describe('resources/list', () => {
  it('一覧を読むと、12 本のテンプレートの URI・名前・Markdown の MIME 型を返す', async () => {
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
    const { client } = await connect()
    const uri = `pecot-template://${kind}/${name}`
    const { contents } = await client.readResource({ uri })
    expect(contents).toEqual([{ uri, mimeType: 'text/markdown', text: readTextFile(templateFile(kind, name)) }])
  })

  it('無い URI を読むと、-32602 のエラーを返す', async () => {
    const { client } = await connect()
    const reading = client.readResource({ uri: 'pecot-template://comment/none' })
    await expect(reading).rejects.toBeInstanceOf(ProtocolError)
    await expect(reading).rejects.toMatchObject({ code: INVALID_PARAMS })
  })

  it('ツールを使えない状態でも、テンプレートは読める', async () => {
    const { client } = await connect('the workspace is not trusted')
    const { contents } = await client.readResource({ uri: 'pecot-template://comment/plan' })
    expect(contents).toEqual([{ uri: 'pecot-template://comment/plan', mimeType: 'text/markdown', text: readTextFile(templateFile('comment', 'plan')) }])
  })
})
