// tools/list が、COMMANDS の全ツールと定義書の入力に一致し、入力の検証の誤りがコマンドを呼ばずに返ることを確かめる。
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
  mcp: z.object({ title: z.string(), output: z.looseObject({}) }),
})
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })
const RepositorySchema = z.looseObject({ type: z.literal('string') })
const WithRepositorySchema = z.object({ properties: z.object({ repo: RepositorySchema }) })

const OutputSchemaShape = z.looseObject({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), additionalProperties: z.unknown() })
const ENVELOPE_NAMES: ReadonlySet<string> = new Set(['ok', 'exitCode', 'data', 'artifacts', 'message', 'reason'])

// CLI のフラグ（--name・-m）。前は行頭・空白・括弧・バッククォート
const CLI_FLAG = /(?:^|[\s(`])--?[a-z]/u

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

// schema の中の文字列の値を全部集める
function stringsOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(item => stringsOf(item))
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
  it('COMMANDS と同じ 41 個の名前を、同じ並びで返す', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(41)
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

  it.for([
    { name: 'バッククォートの中の --repo', text: 'of `--repo`', expected: true },
    { name: '括弧の中の -m', text: '(required with -m)', expected: true },
    { name: '引数名', text: 'of `repo`, with `message`', expected: false },
    { name: '語の中のハイフン', text: 'a non-empty owner/repo-name', expected: false },
  ])('フラグの検出は、$name に $expected を返す', ({ text, expected }) => {
    expect(CLI_FLAG.test(text)).toBe(expected)
  })

  it('全ツールの説明・入力・出力の文に、CLI のフラグ（--name・-m）が無い', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const flagged = tools.flatMap(({ name, description, inputSchema, outputSchema }) =>
      stringsOf({ description, inputSchema, outputSchema }).filter(text => CLI_FLAG.test(text)).map(text => `${name}: ${text}`))
    expect(flagged).toEqual([])
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

  it('全ツールが最上位の title を持ち、値は定義書の mcp.title に一致し、annotations に title を持たない', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const expected = tools.map(tool => generated.entries.find(item => item.surfaces.mcp.tool === tool.name)?.mcp.title)
    expect(tools.map(tool => tool.title)).toEqual(expected)
    expect(expected.every(title => typeof title === 'string' && title !== '')).toBe(true)
    expect(tools.filter(tool => tool.annotations?.title !== undefined).map(tool => tool.name)).toEqual([])
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

  it.for([
    { name: 'issue_comment', required: ['issue', 'change'] },
    { name: 'issue_create', required: ['issues'] },
    { name: 'issue_check', required: ['plan'] },
    { name: 'pr_create', required: ['url', 'head', 'base', 'title', 'moves'] },
    { name: 'project_activate', required: ['configPath', 'change'] },
  ])('$name の outputSchema は、成功の結果の項目を anyOf で必須にする', async ({ name, required }) => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const schema = tools.find(tool => tool.name === name)?.outputSchema
    expect(schema).toMatchObject({ anyOf: [{ required }, { required: ['kind', 'detail'] }] })
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

  it('どのツールの入力にも dry_run が無く、どの outputSchema にも dryRun が無い', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.filter(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, 'dry_run')).map(tool => tool.name)).toEqual([])
    expect(tools.filter(tool => Object.hasOwn(OutputSchemaShape.parse(tool.outputSchema).properties, 'dryRun')).map(tool => tool.name)).toEqual([])
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

  it('CLI だけの入力 dry_run を渡すと、コマンドを呼ばずに、dry_run を名指しして isError で返す', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'board_move', arguments: { issue_ref: 'acme/demo/7', status: 'active', dry_run: true } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown key \'dry_run\'' })
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
