// 3 つのプラグインの MCP ツールは、仕様の structuredContent の最上位にツールの項目を置く。定義書の mcp.output で、入れ物の名前が無く、共通の項目がそろっている。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'

// #436 で外した、pecot 独自の入れ物の名前
const ENVELOPE = new Set(['ok', 'exitCode', 'data', 'artifacts', 'message', 'reason'])
// ツールの項目と並べて最上位に置く、全ツールに共通の項目
const COMMON = ['kind', 'detail', 'log', 'warnings']
const plugins = ['pecot-tools', 'pecot-visual', 'pecot-workflow']

describe.each(plugins)('%s の mcp.output', (plugin) => {
  const file = path.resolve(import.meta.dirname, '../../../plugins', plugin, 'interface/generated.json')
  const generated = generatedFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const tools = generated.entries.filter(entry => entry.surfaces.mcp !== undefined)

  it('MCP の面を持つ項目がある', () => {
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の最上位に、入れ物の名前が無い', (_id, output) => {
    expect(Object.keys(output?.properties ?? {}).filter(name => ENVELOPE.has(name))).toEqual([])
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の最上位が type: object で、properties に共通の 4 項目を持つ', (_id, output) => {
    expect(output?.type).toBe('object')
    const names = Object.keys(output?.properties ?? {})
    expect(COMMON.filter(name => !names.includes(name))).toEqual([])
  })
})
