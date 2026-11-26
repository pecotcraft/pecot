// tools/list に載る 24 ツールの契約テスト。入力・出力・annotations の期待値は interface/generated.json が持つ。
// ここでは、generated.json に写らない性質と、全ツール共通の規約を確かめる。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import type { Tool } from '@modelcontextprotocol/client'
import { attachJson } from '../../../../../../libs/interface-spec/src/vitest/attach.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { SSO_TOOL_NAMES } from '../../../tests/_helpers/sso-tool-names.js'
import { ALLOWLIST } from '../../domain/allowlist.js'
import { allTools } from '../tools/index.js'
import { COMMON_OUTPUT_SHAPE } from '../tools/_shared.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'
import { compareStrings } from '../../../tests/_helpers/compare-strings.js'
import { explains } from '../../../tests/_helpers/explains.js'

const PROFILE_SCHEMA_PATTERN = String.raw`^[\w.-]+$`
const REGION_SCHEMA_PATTERN = String.raw`^[a-z]{2,4}(?:-[a-z]+)+-\d$`

const generatedPath = path.resolve(import.meta.dirname, '../../../../interface/generated.json')

interface GeneratedEntry {
  readonly name: string
  readonly surfaces: { readonly mcp: { readonly tool: string } }
  readonly mcp?: { readonly title?: string }
}

function readGeneratedEntries(): readonly GeneratedEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(generatedPath, 'utf8'))
  const entries = isRecord(parsed) ? parsed['entries'] : undefined
  if (!Array.isArray(entries)) throw new TypeError('generated.json に entries がありません')
  return entries.filter((entry): entry is GeneratedEntry => isRecord(entry) && isRecord(entry['surfaces']))
}

function sorted(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings)
}

function propertiesOf(schema: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const properties = schema?.['properties']
  return isRecord(properties) ? { ...properties } : {}
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter(element => typeof element === 'string') : []
}

const AWSCLI_OUTPUT_REQUIRED: readonly (readonly string[])[] = [['lines'], ['output', 'truncated']]

/**
anyOf を持つツールと、成功の形ごとの必須項目。ほかの JSON のツールは AWS の応答に必ず返るキーが無く、anyOf を持たない。
*/
const SUCCESS_REQUIRED: Readonly<Record<string, readonly (readonly string[])[]>> = {
  aws_sso_login: [['state', 'profile']],
  aws_sso_login_status: [['state']],
  aws_s3_ls: AWSCLI_OUTPUT_REQUIRED,
  // 根拠は awscli 同梱の botocore のモデルで、ListSchedules の出力の shape が Schedules を required に持つ。
  aws_scheduler_list_schedules: [['Schedules'], ...AWSCLI_OUTPUT_REQUIRED],
}

const GENERATED_TOOLS = readGeneratedEntries().map(entry => ({ name: entry.surfaces.mcp.tool, title: entry.mcp?.title }))
const REGION_TOOLS = GENERATED_TOOLS.filter(tool => !SSO_TOOL_NAMES.includes(tool.name))

function patternOf(properties: Readonly<Record<string, unknown>>, name: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの定数
  const property = properties[name]
  return isRecord(property) ? property['pattern'] : undefined
}

function itemsOf(property: unknown): Readonly<Record<string, unknown>> | undefined {
  const items = isRecord(property) ? property['items'] : undefined
  return isRecord(items) ? items : undefined
}

function descriptionOf(property: unknown): unknown {
  return isRecord(property) ? property['description'] : undefined
}

describe('MCP ツール契約 (tools/list)', () => {
  let listedResult: unknown
  let listed: readonly Tool[] = []
  let connected: ConnectedMcp | undefined

  beforeAll(async () => {
    connected = await connectMcp(allTools())
    const result = await connected.client.listTools()
    listedResult = result
    listed = result.tools
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
  })

  // 全体を見るテストは tools/list の全体を、1 つのツールを見るテストはその項目だけを添付する。
  function allListed(): readonly Tool[] {
    attachJson('tools/list の結果', listedResult)
    return listed
  }

  function toolOf(name: string): Tool {
    const found = listed.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`tools/list に ${name} が載っていません`)
    attachJson(`${name} の tools/list の項目`, found)
    return found
  }

  it('tools/list のツール名の集合が、interface/generated.json の項目と一致する', async () => {
    // 24 はツールを足す人が直す値。generated.json を書き出し直しても、直し忘れはここで止まる。
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。返されたツールが 24 件で、ツール名の集合が `interface/generated.json` の項目名の集合と一致することを確認します。')
    const all = allListed()
    expect(all).toHaveLength(24)
    const listedNames = all.map(tool => tool.name)
    const generatedNames = GENERATED_TOOLS.map(tool => tool.name)

    expect(sorted(listedNames)).toEqual(sorted(generatedNames))
  })

  it('tools/list の SSO の 2 件に続くツールの並びが、許可リストの並びと一致する', async () => {
    // 許可リストは SSO の 2 件を持たず、tools/list は SSO の 2 件を先頭に置く。
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。先頭の 2 件が SSO のツールで、その後ろのツール名が `ALLOWLIST` のツール名と同じ順序であることを確認します。')
    const names = allListed().map(tool => tool.name)

    expect(names.slice(0, SSO_TOOL_NAMES.length)).toEqual(SSO_TOOL_NAMES)
    expect(ALLOWLIST.map(entry => entry.toolName)).toEqual(names.slice(SSO_TOOL_NAMES.length))
  })

  it('SSO の 2 件のツールは、許可リストに含めない', async () => {
    // 載せると tests/integration/real-awscli.test.ts が実行のたびに本物のデバイス認証を発行する。
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。SSO のツール 2 件のどちらも、`ALLOWLIST` のツール名に含まれないことを確認します。')
    const allowlisted = new Set(ALLOWLIST.map(entry => entry.toolName))

    for (const name of SSO_TOOL_NAMES) expect(allowlisted.has(name)).toBe(false)
  })

  it.each(GENERATED_TOOLS)('ツール $name の名前は、aws_ で始まる', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。`interface/generated.json` にあるすべてのツールの名前が、`aws_` で始まることを確認します。')
    expect(name).toMatch(/^aws_/)
  })

  it.each(GENERATED_TOOLS)('ツール $name のすべてのパラメータは、空でない description を持つ', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。入力スキーマのすべてのパラメータと、配列の要素の項目が、空白以外の文字を含む `description` を持つことを確認します。')
    const properties = propertiesOf(toolOf(name).inputSchema)
    const described = Object.values(properties).map(property => descriptionOf(property))
    const itemFields = Object.values(properties)
      .map(property => itemsOf(property))
      .flatMap(items => Object.values(propertiesOf(items)))
      .map(property => descriptionOf(property))

    for (const description of [...described, ...itemFields]) {
      expect(description).toEqual(expect.stringMatching(/\S/))
    }
  })

  it.each(GENERATED_TOOLS)('ツール $name の profile は、共通規約の書式を公開する', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。すべてのツールで、入力スキーマの `profile` の `pattern` が、共通規約の `^[\\w.-]+$` と一致することを確認します。')
    const properties = propertiesOf(toolOf(name).inputSchema)

    expect(patternOf(properties, 'profile')).toBe(PROFILE_SCHEMA_PATTERN)
  })

  it.each(REGION_TOOLS)('ツール $name の region は、共通規約の書式を公開する', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。SSO 以外のすべてのツールで、入力スキーマの `region` の `pattern` が、共通規約の書式と一致することを確認します。')
    const properties = propertiesOf(toolOf(name).inputSchema)

    expect(patternOf(properties, 'region')).toBe(REGION_SCHEMA_PATTERN)
  })

  it('SSO の 2 件のツールは、入力スキーマに region を含めない', async () => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。SSO のツール 2 件の入力スキーマのプロパティに、`region` が含まれないことを確認します。')
    for (const name of SSO_TOOL_NAMES) {
      const properties = propertiesOf(toolOf(name).inputSchema)

      expect(Object.keys(properties)).not.toContain('region')
    }
  })

  it.each(GENERATED_TOOLS)('ツール $name は、配列の要素のオブジェクトに宣言外のキーを許可しない', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。入力スキーマの配列の要素が `object` の場合に、`additionalProperties` が `false` であることを確認します。')
    const items = Object.values(propertiesOf(toolOf(name).inputSchema))
      .map(property => itemsOf(property))
      .filter(item => item?.['type'] === 'object')
      .map(item => item?.['additionalProperties'])

    expect(items.every(value => value === false)).toBe(true)
  })

  it.each(GENERATED_TOOLS)('ツール $name の outputSchema は、共通の 4 項目を持ち、必須の項目を持たない閉じた object になる', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。出力スキーマが `object` で共通の出力の項目をすべて含み、`required` が空、`additionalProperties` が `false` で、真偽値のスキーマを含まないことを確認します。')
    const outputSchema = toolOf(name).outputSchema

    const names = Object.keys(propertiesOf(outputSchema))

    expect(outputSchema?.['type']).toBe('object')
    expect(names).toEqual(expect.arrayContaining(Object.keys(COMMON_OUTPUT_SHAPE)))
    expect(asStringArray(outputSchema?.['required'])).toEqual([])
    expect(outputSchema?.['additionalProperties']).toBe(false)
    // JSON Schema の boolean スキーマ（true）を出さない。
    expect(JSON.stringify(outputSchema)).not.toMatch(/:true[,}]/)
  })

  it.each(GENERATED_TOOLS)('ツール $name の outputSchema の anyOf は、成功の必須項目か kind と detail を求める', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。出力スキーマの `anyOf` が、成功時の必須項目の表と、失敗時の `kind` と `detail` から作った条件と一致し、表にないツールには `anyOf` がないことを確認します。')
    const outputSchema = toolOf(name).outputSchema
    // eslint-disable-next-line security/detect-object-injection -- name は generated.json 由来のツール名
    const success = SUCCESS_REQUIRED[name]
    const expected = success === undefined ? undefined : [...success, ['kind', 'detail']].map(required => ({ required }))

    expect(outputSchema?.['anyOf']).toEqual(expected)
  })

  it('成功の必須項目の表に載せたツールは、すべて tools/list に含まれる', async () => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。成功時の必須項目の表に挙げたツール名が、すべて `tools/list` の結果に含まれることを確認します。')
    const names = new Set(allListed().map(tool => tool.name))

    expect(Object.keys(SUCCESS_REQUIRED).filter(name => !names.has(name))).toEqual([])
  })

  it.each(REGION_TOOLS)('ツール $name の outputSchema は、awscli の出力から作る項目を持つ', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。SSO 以外のすべてのツールの出力スキーマが、`lines`、`output`、`truncated` の項目を持つことを確認します。')
    const names = Object.keys(propertiesOf(toolOf(name).outputSchema))

    expect(names).toEqual(expect.arrayContaining(['lines', 'output', 'truncated']))
  })

  it.each(REGION_TOOLS)('ツール $name の outputSchema は、max-items で分割するツールだけが nextToken を持つ', async ({ name }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。許可リストでページ分割の方式が `max-items` のツールだけが、出力スキーマに `nextToken` と `NextToken` を持つことを確認します。')
    const entry = ALLOWLIST.find(item => item.toolName === name)
    const names = Object.keys(propertiesOf(toolOf(name).outputSchema))

    expect(names.includes('nextToken')).toBe(entry?.pagination === 'max-items')
    expect(names.includes('NextToken')).toBe(entry?.pagination === 'max-items')
  })

  it.each(GENERATED_TOOLS)('ツール $name の title は定義書の mcp.title と一致し、description は空でなく、openWorldHint は true になる', async ({ name, title }) => {
    await explains('MCP サーバの `tools/list` が返すツールの契約のテストです。定義書の `mcp.title` が最上位の `title` と一致し、`description` が空でなく、`openWorldHint` が `true` であることを確認します。')
    const tool = toolOf(name)

    expect(title).toEqual(expect.stringMatching(/\S/))
    expect(tool.title).toBe(title)
    expect(tool.annotations?.title).toBeUndefined()
    expect(tool.description).toEqual(expect.stringMatching(/\S/))
    expect(tool.annotations?.openWorldHint).toBe(true)
  })
})
