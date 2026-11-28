// tools/list が、TOOLS の全ツールと定義書の入力に一致し、入力の検証の誤りがコマンドを呼ばずに返ることを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { normalizeInput } from '../../src/commands/input-schema.js'
import { byName } from '@pecot/workflow-core/commands-shared/names.js'
import { TOOLS } from '../../src/commands/registry.js'
import { createMcpServer } from '../../src/mcp/server.js'
import type { Tool } from '@modelcontextprotocol/client'
import { attachJson } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { parseJson } from '../../../../../libs/workflow-core/tests/_helpers/json.js'
import { connectInMemory, outcomeOf, structuredOf } from '../_helpers/mcp-client.js'
import type { ConnectedClient } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'

const GENERATED = path.resolve(import.meta.dirname, '../../../interface/generated.json')
const ToolSchema = z.object({ tool: z.string() })
const EntrySchema = z.object({
  surfaces: z.object({ mcp: ToolSchema }),
  input: z.looseObject({}),
  mcp: z.object({ title: z.string(), output: z.looseObject({}), annotations: z.looseObject({}) }),
})
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })
const RepositorySchema = z.looseObject({ type: z.literal('string') })
const WithRepositorySchema = z.object({ properties: z.object({ repo: RepositorySchema }) })

const OutputSchemaShape = z.looseObject({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), additionalProperties: z.unknown() })
// Issue #771 の、interface/authored.yaml の effects がすべて read のツール
const READ_ONLY_TOOLS = ['board_check', 'board_show', 'branch_check', 'issue_check', 'issue_comment_check', 'issue_dependency_check', 'pr_check', 'project_check', 'project_get', 'project_list', 'release_check', 'session_show', 'workflow_doctor']
// 書き込むツールのうち、authored.yaml の effects に destructive が無いものと、idempotent が true のもの
const ADDITIVE_TOOLS = ['session_start', 'worktree_init']
const IDEMPOTENT_WRITE_TOOLS = ['pr_restack', 'project_activate', 'project_link', 'project_set', 'project_unset', 'session_finish', 'session_start', 'worktree_link']
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
  let shared: ConnectedClient | undefined
  let listed: readonly Tool[] = []

  beforeAll(async () => {
    shared = await connectInMemory(createMcpServer())
    const { tools } = await shared.client.listTools()
    listed = tools
  })

  afterAll(async () => {
    await shared?.close()
  })

  // 1 つのツールを見るテストは、tools/list の全体でなく、そのツールの項目だけを添付する。
  function toolOf(name: string): Tool {
    const found = listed.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`tools/list に ${name} が載っていません`)
    attachJson(`${name} の tools/list の項目`, found)
    return found
  }

  it('TOOLS と同じ 25 個の名前を、同じ並びで返す', async () => {
    await explains('MCP サーバのツール一覧（`tools/list`）の件数と並びのテストです。ツールの定義（`TOOLS`）と同じ 25 個の名前が、同じ並びで返ることを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(25)
    expect(tools.map(tool => tool.name)).toEqual(TOOLS.map(definition => definition.name))
  })

  it('mcp という名前のツールは存在しない', async () => {
    await explains('`tools/list` が返すツール名のテストです。`mcp` という名前のツールが含まれないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).not.toContain('mcp')
  })

  it('説明は、コマンド定義の description の 1 行になる', async () => {
    await explains('`tools/list` が返すツールの説明のテストです。各ツールの説明が、コマンド定義の `description`（1 行の文）と一致することを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.description)).toEqual(TOOLS.map(command => command.description))
  })

  it.for([
    { name: 'バッククォートの中の --repo', text: 'of `--repo`', expected: true },
    { name: '括弧の中の -m', text: '(required with -m)', expected: true },
    { name: '引数名', text: 'of `repo`, with `message`', expected: false },
    { name: '語の中のハイフン', text: 'a non-empty owner/repo-name', expected: false },
  ])('フラグの検出は、$name に $expected を返す', async ({ text, expected }) => {
    await explains('CLI のフラグを検出する正規表現（`CLI_FLAG`）のテストです。バッククォートや括弧の中のフラグは検出し、引数名や語の中のハイフンは検出しないことを確認します。')
    expect(CLI_FLAG.test(text)).toBe(expected)
  })

  it('全ツールの説明・入力・出力の文に、CLI のフラグ（--name・-m）が含まれない', async () => {
    await explains('ツールの説明・入力・出力に含まれる文のテストです。CLI のフラグ（`--name` や `-m` の形）が、どのツールの文にも含まれないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const flagged = tools.flatMap(({ name, description, inputSchema, outputSchema }) =>
      stringsOf({ description, inputSchema, outputSchema }).filter(text => CLI_FLAG.test(text)).map(text => `${name}: ${text}`))
    expect(flagged).toEqual([])
  })

  it.for(TOOLS.map(command => ({ name: command.name, command })))('$name の入力は、定義書の同じ項目の input に一致する', async ({ command }) => {
    await explains(`\`${command.name}\` の入力のテストです。\`tools/list\` が返す入力のスキーマを正規化した結果が、定義書（\`generated.json\`）の同じ項目の \`input\` と一致することを確認します。`)
    const tool = toolOf(command.name)
    const entry = generated.entries.find(item => item.surfaces.mcp.tool === command.name)
    expect(entry).toBeDefined()
    expect(normalizeInput(tool.inputSchema, command.name, command.hasOwnRepo)).toEqual(entry?.input)
  })

  it('全ツールが最上位の title を持ち、値は定義書の mcp.title に一致し、annotations に title を持たない', async () => {
    await explains('ツールの `title` のテストです。全ツールが最上位の `title` を持ち、その値が定義書の `mcp.title` と一致し、`annotations` には `title` が含まれないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const expected = tools.map(tool => generated.entries.find(item => item.surfaces.mcp.tool === tool.name)?.mcp.title)
    expect(tools.map(tool => tool.title)).toEqual(expected)
    expect(expected.every(title => typeof title === 'string' && title !== '')).toBe(true)
    expect(tools.filter(tool => tool.annotations?.title !== undefined).map(tool => tool.name)).toEqual([])
  })

  it('readOnlyHint: true を返すのは読むだけの 13 個だけで、ほかのツールは false を返す', async () => {
    await explains('ツールの `readOnlyHint` のテストです。`true` を返すのは読み取り専用の 13 個のツールだけで、ほかのツールは `false` を返すことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name).toSorted(byName)).toEqual(READ_ONLY_TOOLS)
    expect(tools.filter(tool => tool.annotations?.readOnlyHint !== true).every(tool => tool.annotations?.readOnlyHint === false)).toBe(true)
  })

  it('destructiveHint: false を返すのは足すだけの 2 個だけで、ほかの書き込むツールは true を返す', async () => {
    await explains('書き込むツールの `destructiveHint` のテストです。`false` を返すのは足すだけの `session_start` と `worktree_init` だけで、ほかの書き込むツールは `true` を返すことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const writing = tools.filter(tool => tool.annotations?.readOnlyHint === false)
    expect(writing.filter(tool => tool.annotations?.destructiveHint === false).map(tool => tool.name).toSorted(byName)).toEqual(ADDITIVE_TOOLS)
    expect(writing.filter(tool => tool.annotations?.destructiveHint !== false).every(tool => tool.annotations?.destructiveHint === true)).toBe(true)
  })

  it('idempotentHint: true を返すのは呼び直しても作用が増えない書き込むツールの 8 個だけで、ほかの書き込むツールは false を返す', async () => {
    await explains('書き込むツールの `idempotentHint` のテストです。`true` を返すのは定義書の `idempotent` が `true` の 8 個だけで、ほかの書き込むツールは `false` を返すことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const writing = tools.filter(tool => tool.annotations?.readOnlyHint === false)
    expect(writing.filter(tool => tool.annotations?.idempotentHint === true).map(tool => tool.name).toSorted(byName)).toEqual(IDEMPOTENT_WRITE_TOOLS)
    expect(writing.filter(tool => tool.annotations?.idempotentHint !== true).every(tool => tool.annotations?.idempotentHint === false)).toBe(true)
  })

  it('読むだけのツールは、destructiveHint と idempotentHint を返さない', async () => {
    await explains('読み取り専用のツールの `annotations` のテストです。`readOnlyHint` が `true` のツールが、`destructiveHint` と `idempotentHint` のどちらも持たないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const hinted = tools.filter(tool => tool.annotations?.readOnlyHint === true && (Object.hasOwn(tool.annotations, 'destructiveHint') || Object.hasOwn(tool.annotations, 'idempotentHint')))
    expect(hinted.map(tool => tool.name)).toEqual([])
  })

  it('全ツールの annotations は、定義書の mcp.annotations に一致する', async () => {
    await explains('ツールの `annotations` のテストです。全ツールの `annotations` が、定義書の `mcp.annotations` と一致することを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const expected = tools.map(tool => generated.entries.find(item => item.surfaces.mcp.tool === tool.name)?.mcp.annotations)
    expect(tools.map(tool => tool.annotations)).toEqual(expected)
  })

  it('全ツールの outputSchema は、$schema を除いて定義書の mcp.output に一致する', async () => {
    await explains('ツールの `outputSchema` のテストです。`$schema` を除いた `outputSchema` が、定義書の `mcp.output` と一致することを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const outputs = tools.map(({ outputSchema }) => Object.fromEntries(Object.entries(outputSchema ?? {}).filter(([key]) => key !== '$schema')))
    const expected = tools.map(tool => generated.entries.find(item => item.surfaces.mcp.tool === tool.name)?.mcp.output)
    expect(outputs).toEqual(expected)
  })

  it.for(TOOLS.map(command => ({ name: command.name, command })))('$name の outputSchema は、最上位が type: object の閉じた型で、properties にツールの項目と共通の 4 項目を持ち、入れ物の名前を持たない', async ({ command }) => {
    await explains(`\`${command.name}\` の \`outputSchema\` の形のテストです。最上位が \`type: object\` で、ツール固有の項目と共通の 4 項目だけを持ち、\`ok\` や \`data\` などの名前を持たない閉じた型であることを確認します。`)
    const schema = OutputSchemaShape.parse(toolOf(command.name).outputSchema)
    const names = Object.keys(schema.properties)
    expect(names).toEqual([...Object.keys(command.output.shape), 'kind', 'detail', 'log', 'warnings'])
    expect(names.filter(name => ENVELOPE_NAMES.has(name))).toEqual([])
    expect(schema.additionalProperties).toBe(false)
  })

  it.for([
    { name: 'issue_check', required: ['problems'] },
    { name: 'issue_dependency_check', required: ['problems'] },
    { name: 'issue_comment_check', required: ['problems'] },
    { name: 'pr_check', required: ['problems'] },
    { name: 'project_activate', required: ['configPath', 'change', 'config_moved'] },
  ])('$name の outputSchema は、成功の結果の項目を anyOf で必須にする', async ({ name, required }) => {
    await explains(`\`${name}\` の \`outputSchema\` のテストです。成功の結果の必須の項目が \`anyOf\` の 1 つ目に指定され、2 つ目にエラーの項目（\`kind\` と \`detail\`）が指定されていることを確認します。`)
    const schema = toolOf(name).outputSchema
    expect(schema).toMatchObject({ anyOf: [{ required }, { required: ['kind', 'detail'] }] })
  })

  it('全ツールの outputSchema に、真偽値の true の schema が含まれない', async () => {
    await explains('ツールの `outputSchema` のテストです。どのツールの `outputSchema` にも、真偽値の `true` の schema が含まれないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.filter(tool => hasTrueSchema(tool.outputSchema)).map(tool => tool.name)).toEqual([])
  })

  it('全ツールの生の入力が、additionalProperties: false を持つ', async () => {
    await explains('ツールの入力のスキーマのテストです。全ツールの入力が `additionalProperties: false` を持つことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.inputSchema['additionalProperties'])).toEqual(TOOLS.map(() => false))
  })

  it('どのツールの入力にも dry_run が存在せず、どの outputSchema にも dryRun が存在しない', async () => {
    await explains('ツールの入出力から CLI 専用の項目を除いたことのテストです。入力に `dry_run` が、`outputSchema` に `dryRun` が存在するツールがないことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.filter(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, 'dry_run')).map(tool => tool.name)).toEqual([])
    expect(tools.filter(tool => Object.hasOwn(OutputSchemaShape.parse(tool.outputSchema).properties, 'dryRun')).map(tool => tool.name)).toEqual([])
  })

  it('全ツールが入力 repo（文字列）を持つ', async () => {
    await explains('ツールの入力のテストです。全ツールが、文字列型の入力 `repo` を持つことを確認します。')
    const { client } = await connect()
    const { tools } = await client.listTools()
    const shapes = tools.map(tool => WithRepositorySchema.safeParse(tool.inputSchema).success)
    expect(shapes).toEqual(TOOLS.map(() => true))
  })
})

describe('入力の検証の誤り', () => {
  it('定義書に存在しないキーを渡すと、コマンドを呼ばずに isError で返す', async () => {
    await explains('定義書に存在しないキー（`bogus`）を指定して `issue_check` を呼び出した場合のテストです。コマンドを呼ばずに、`invalid-input` のエラーを `isError` 付きで返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'issue_check', arguments: { method: 'create', issues: [{ kind: 'task' }], bogus: true } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown key \'bogus\'' })
  })

  it('CLI だけの入力 dry_run を渡すと、コマンドを呼ばずに、dry_run を名指しして isError で返す', async () => {
    await explains('CLI 専用の入力 `dry_run` を指定して `project_get` を呼び出した場合のテストです。コマンドを呼ばずに、`dry_run` を示した `invalid-input` のエラーを返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'project_get', arguments: { key: 'aggregation_repo', dry_run: true } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toEqual({ kind: 'invalid-input', detail: 'invalid input: unknown key \'dry_run\'' })
  })

  it('真偽値に文字列の "true" を渡すと、コマンドを呼ばずに isError で返す', async () => {
    await explains('真偽値の入力 `force` に文字列の `\'true\'` を指定して `worktree_link` を呼び出した場合のテストです。コマンドを呼ばずに、`force` を示した `invalid-input` のエラーを返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', force: 'true' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('force')
  })

  it('必須の入力を指定しないと、コマンドを呼ばずに isError で返す', async () => {
    await explains('必須の入力 `directory` を指定せずに `worktree_link` を呼び出した場合のテストです。コマンドを呼ばずに、`directory` を示した `invalid-input` のエラーを返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: {} })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('directory')
  })

  it('repo の形が owner/repo でないと、コマンドを呼ばずに isError で返す', async () => {
    await explains('`repo` に `owner/repo` の形式でない値を指定して `worktree_link` を呼び出した場合のテストです。コマンドを呼ばずに、`repo` を示した `invalid-input` のエラーを返すことを確認します。')
    const { client } = await connect()
    const result = await client.callTool({ name: 'worktree_link', arguments: { directory: '.', repo: 'not-a-repo' } })
    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ kind: 'invalid-input' })
    expect(outcomeOf(result).detail).toContain('repo')
  })
})
