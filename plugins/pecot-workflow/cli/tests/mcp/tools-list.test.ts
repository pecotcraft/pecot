// tools/list が、COMMANDS の 35 個と定義書の入力に一致し、入力の検証の誤りがコマンドを呼ばずに返ることを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { normalizeInput } from '../../src/commands/input-schema.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { parseJson } from '../../src/tests/_helpers/json.js'
import { connectInMemory, outcomeOf, structuredOf } from '../_helpers/mcp-client.js'
import type { ConnectedClient } from '../_helpers/mcp-client.js'

const GENERATED = path.resolve(import.meta.dirname, '../../../interface/generated.json')
const ToolSchema = z.object({ tool: z.string() })
const EntrySchema = z.object({
  surfaces: z.object({ mcp: ToolSchema }),
  input: z.looseObject({}),
  mcp: z.object({ output: z.looseObject({}) }),
})
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })
const RepositorySchema = z.looseObject({ type: z.literal('string') })
const WithRepositorySchema = z.object({ properties: z.object({ repo: RepositorySchema }) })

const OutputSchemaShape = z.looseObject({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), additionalProperties: z.unknown() })
const ENVELOPE_NAMES: ReadonlySet<string> = new Set(['ok', 'exitCode', 'data', 'artifacts', 'message', 'reason'])

// properties・items・anyOf などの下の schema の位置に、真偽値の true があるか（Claude Code がツールを拒む）
function hasTrueSchema(schema: unknown): boolean {
  if (schema === true) return true
  if (Array.isArray(schema)) return schema.some(item => hasTrueSchema(item))
  if (typeof schema !== 'object' || schema === null) return false
  const entries: [string, unknown][] = Object.entries(schema)
  return entries.some(([key, value]) => key === 'properties' && typeof value === 'object' && value !== null
    ? Object.values(value).some(item => hasTrueSchema(item))
    : ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties'].includes(key) && hasTrueSchema(value))
}

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

  it('全ツールの outputSchema は、$schema を除いて定義書の mcp.output に一致する', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const outputs = tools.map(({ outputSchema }) => Object.fromEntries(Object.entries(outputSchema ?? {}).filter(([key]) => key !== '$schema')))
    const expected = tools.map(tool => generated.entries.find(item => item.surfaces.mcp.tool === tool.name)?.mcp.output)
    expect(outputs).toEqual(expected)
  })

  it.for(COMMANDS.map(command => ({ name: command.toolName, command })))('$name の outputSchema は、最上位が type: object の閉じた型で、properties にツールの項目と共通の 4 項目を持ち、入れ物の名前を持たない', async ({ command }) => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const schema = OutputSchemaShape.parse(tools.find(tool => tool.name === command.toolName)?.outputSchema)
    const names = Object.keys(schema.properties)
    expect(names).toEqual([...Object.keys(command.output.shape), 'kind', 'detail', 'log', 'warnings'])
    expect(names.filter(name => ENVELOPE_NAMES.has(name))).toEqual([])
    expect(schema.additionalProperties).toBe(false)
  })

  it('全ツールの outputSchema に、真偽値の true の schema が無い', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.filter(tool => hasTrueSchema(tool.outputSchema)).map(tool => tool.name)).toEqual([])
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
    const result = await client.callTool({ name: 'issue_create', arguments: { message: 'm', repo: 'acme/demo', bogus: true } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown key \'bogus\'' })
  })

  it('改名前の入力名を渡すと、新しい名前を添えて、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'issue_comment', arguments: { issue: 'acme/demo/7', message: 'm', template: 'plan' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown key \'issue\' (\'issue\' was renamed to \'issue_ref\')' })
  })

  it('真偽値に文字列の "true" を渡すと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', force: 'true' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('force')
  })

  it('必須の入力が無いと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: {} })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('directory')
  })

  it('repo の形が owner/repo でないと、コマンドを呼ばずに isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', repo: 'not-a-repo' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('repo')
  })
})
