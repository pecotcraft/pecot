// tools/list に載る 26 ツールの契約テスト。入力・出力・annotations の期待値は interface/generated.json が持つ。
// ここでは、generated.json に写らない性質と、全ツール共通の規約を確かめる。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import type { Tool } from '@modelcontextprotocol/client'
import { isRecord } from '../../../tests/_helpers/records.js'
import { SSO_TOOL_NAMES } from '../../../tests/_helpers/sso-tool-names.js'
import { ALLOWLIST } from '../../domain/allowlist.js'
import { allTools } from '../tools/index.js'
import { TOOL_OUTPUT_SCHEMA } from '../tools/_shared.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'
import { compareStrings } from '../../../tests/_helpers/compare-strings.js'

const PROFILE_SCHEMA_PATTERN = String.raw`^[\w.-]+$`
const REGION_SCHEMA_PATTERN = String.raw`^[a-z]{2,4}(?:-[a-z]+)+-\d$`

const generatedPath = path.resolve(import.meta.dirname, '../../../../interface/generated.json')

interface GeneratedEntry {
  readonly name: string
  readonly surfaces: { readonly mcp: { readonly tool: string } }
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

const GENERATED_TOOLS = readGeneratedEntries().map(entry => ({ name: entry.surfaces.mcp.tool }))
const REGION_TOOLS = GENERATED_TOOLS.filter(tool => !SSO_TOOL_NAMES.includes(tool.name))

function patternOf(properties: Readonly<Record<string, unknown>>, name: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの定数
  const property = properties[name]
  return isRecord(property) ? property['pattern'] : undefined
}

function descriptionOf(property: unknown): unknown {
  return isRecord(property) ? property['description'] : undefined
}

describe('MCP ツール契約 (tools/list)', () => {
  let listed: readonly Tool[] = []
  let connected: ConnectedMcp | undefined

  beforeAll(async () => {
    connected = await connectMcp(allTools())
    const result = await connected.client.listTools()
    listed = result.tools
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
  })

  function toolOf(name: string): Tool {
    const found = listed.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`tools/list に ${name} が載っていません`)
    return found
  }

  it('tools/list のツール名の集合が generated.json の項目と一致する', () => {
    expect(listed).toHaveLength(26)
    const listedNames = listed.map(tool => tool.name)
    const generatedNames = GENERATED_TOOLS.map(tool => tool.name)

    expect(sorted(listedNames)).toEqual(sorted(generatedNames))
  })

  it('許可リストの並びが tools/list の尾部と一致する', () => {
    // 許可リストは SSO の 2 件を持たず、tools/list は SSO の 2 件を先頭に置く。
    const names = listed.map(tool => tool.name)

    expect(names.slice(0, SSO_TOOL_NAMES.length)).toEqual(SSO_TOOL_NAMES)
    expect(ALLOWLIST.map(entry => entry.toolName)).toEqual(names.slice(SSO_TOOL_NAMES.length))
  })

  it('SSO の 2 件は許可リストに載せない', () => {
    // 載せると tests/integration/real-awscli.test.ts が実行のたびに本物のデバイス認証を発行する。
    const allowlisted = new Set(ALLOWLIST.map(entry => entry.toolName))

    for (const name of SSO_TOOL_NAMES) expect(allowlisted.has(name)).toBe(false)
  })

  it.each(GENERATED_TOOLS)('$name のツール名は aws_ で始まる', ({ name }) => {
    expect(name).toMatch(/^aws_/)
  })

  it.each(GENERATED_TOOLS)('$name の全パラメータが空でない description を持つ', ({ name }) => {
    const properties = propertiesOf(toolOf(name).inputSchema)
    const described = Object.values(properties).map(property => descriptionOf(property))
    const itemFields = Object.values(properties)
      .map(property => (isRecord(property) ? property['items'] : undefined))
      .flatMap(items => Object.values(propertiesOf(isRecord(items) ? items : undefined)))
      .map(property => descriptionOf(property))

    for (const description of [...described, ...itemFields]) {
      expect(description).toEqual(expect.stringMatching(/\S/))
    }
  })

  it.each(GENERATED_TOOLS)('$name の profile が共通規約の書式を公開する', ({ name }) => {
    const properties = propertiesOf(toolOf(name).inputSchema)

    expect(patternOf(properties, 'profile')).toBe(PROFILE_SCHEMA_PATTERN)
  })

  it.each(REGION_TOOLS)('$name の region が共通規約の書式を公開する', ({ name }) => {
    const properties = propertiesOf(toolOf(name).inputSchema)

    expect(patternOf(properties, 'region')).toBe(REGION_SCHEMA_PATTERN)
  })

  it('SSO の 2 件は region を公開しない', () => {
    for (const name of SSO_TOOL_NAMES) {
      const properties = propertiesOf(toolOf(name).inputSchema)

      expect(Object.keys(properties)).not.toContain('region')
    }
  })

  it.each(GENERATED_TOOLS)('$name が配列の要素に宣言外のキーを許さない', ({ name }) => {
    const items = Object.values(propertiesOf(toolOf(name).inputSchema))
      .map(property => (isRecord(property) ? property['items'] : undefined))
      .filter(item => isRecord(item) && item['type'] === 'object')
      .map(item => (isRecord(item) ? item['additionalProperties'] : undefined))

    expect(items.every(value => value === false)).toBe(true)
  })

  it.each(GENERATED_TOOLS)('$name が ExecutionResult 同形の outputSchema を公開する', ({ name }) => {
    const outputSchema = toolOf(name).outputSchema

    const exposedKeys = Object.keys(propertiesOf(outputSchema))

    expect(sorted(exposedKeys)).toEqual(sorted(Object.keys(TOOL_OUTPUT_SCHEMA.shape)))
    // category / stderr は失敗時のみ載るため必須にしない。
    expect(sorted(asStringArray(outputSchema?.['required']))).toEqual(['artifacts', 'data', 'exitCode', 'message', 'ok'])
  })

  it.each(GENERATED_TOOLS)('$name が title と description を持ち openWorldHint が true', ({ name }) => {
    const tool = toolOf(name)

    expect(tool.title).toEqual(expect.stringMatching(/\S/))
    expect(tool.description).toEqual(expect.stringMatching(/\S/))
    expect(tool.annotations?.openWorldHint).toBe(true)
  })
})
