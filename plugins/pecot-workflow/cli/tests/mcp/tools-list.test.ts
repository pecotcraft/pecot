// tools/list が、COMMANDS の 35 個と定義書の入力に一致し、入力の検証の誤りがコマンドを呼ばずに返ることを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { normalizeInput } from '../../src/commands/input-schema.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { parseJson } from '../../src/tests/_helpers/json.js'
import { connectInMemory } from '../_helpers/mcp-client.js'
import type { ConnectedClient } from '../_helpers/mcp-client.js'

const GENERATED = path.resolve(import.meta.dirname, '../../../interface/generated.json')
const ToolSchema = z.object({ tool: z.string() })
const EntrySchema = z.object({
  surfaces: z.object({ mcp: ToolSchema }),
  input: z.looseObject({}),
})
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })
const RepositorySchema = z.looseObject({ type: z.literal('string') })
const WithRepositorySchema = z.object({ properties: z.object({ repo: RepositorySchema }) })

const generated = GeneratedSchema.parse(parseJson(readFileSync(GENERATED, 'utf8')))

const opened: ConnectedClient[] = []

async function connect(): Promise<ConnectedClient> {
  const connected = await connectInMemory(createMcpServer())
  opened.push(connected)
  return connected
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (connected) => {
    await connected.close()
  }))
})

describe('tools/list', () => {
  it('COMMANDS と同じ 35 個の名前を、同じ並びで返す', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(35)
    expect(tools.map(tool => tool.name)).toEqual(COMMANDS.map(command => command.toolName))
  })

  it('mcp という名前のツールは無い', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).not.toContain('mcp')
  })

  it('説明は、コマンド定義の description の 1 行になる', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.description)).toEqual(COMMANDS.map(command => command.description))
  })

  it.for(COMMANDS.map(command => ({ name: command.toolName, command })))('$name の入力は、定義書の同じ項目の input に一致する', async ({ command }) => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const tool = tools.find(entry => entry.name === command.toolName)
    const entry = generated.entries.find(item => item.surfaces.mcp.tool === command.toolName)
    expect(tool).toBeDefined()
    expect(entry).toBeDefined()
    expect(normalizeInput(tool?.inputSchema ?? {}, command.toolName, command.hasOwnRepo)).toEqual(entry?.input)
  })

  it('全ツールの生の入力が、additionalProperties: false を持つ', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.inputSchema['additionalProperties'])).toEqual(COMMANDS.map(() => false))
  })

  it('全ツールが入力 repo（文字列）を持つ', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const shapes = tools.map(tool => WithRepositorySchema.safeParse(tool.inputSchema).success)
    expect(shapes).toEqual(COMMANDS.map(() => true))
  })
})

describe('入力の検証の誤り', () => {
  it('定義書に無いキーを渡すと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'issue_quick', arguments: { message: 'm', repo: 'acme/demo', prepare: true } })
    expect(result.isError).toBe(true)
    expect(result._meta).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'invalid input: unknown key \'prepare\'' }])
  })

  it('真偽値に文字列の "true" を渡すと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', force: 'true' } })
    expect(result.isError).toBe(true)
    expect(result._meta).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('force')
  })

  it('必須の入力が無いと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result._meta).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('directory')
  })

  it('repo の形が owner/repo でないと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', repo: 'not-a-repo' } })
    expect(result.isError).toBe(true)
    expect(result._meta).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('repo')
  })
})
