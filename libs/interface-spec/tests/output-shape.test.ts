// 3 つのプラグインの MCP ツールは、同じ項目の結果を返す。定義書の mcp.output で、その名前がそろっている。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'
import { compareText, isRecord } from '../src/domain/utility.js'

const TOP_LEVEL = ['ok', 'exitCode', 'kind', 'data', 'artifacts', 'message']
// data の成功側と失敗側のどちらかが持つ、全ツールに共通の項目
const COMMON_DATA = ['warnings', 'reason', 'detail', 'log']
const plugins = ['pecot-tools', 'pecot-visual', 'pecot-workflow']

// data の properties の名前。anyOf なら枝の和集合
function dataNames(data: unknown): string[] {
  if (!isRecord(data)) return []
  const branches = Array.isArray(data['anyOf']) ? data['anyOf'] : [data]
  return [...new Set(branches.flatMap(branch => isRecord(branch) && isRecord(branch['properties']) ? Object.keys(branch['properties']) : []))]
}

describe.each(plugins)('%s の mcp.output', (plugin) => {
  const file = path.resolve(import.meta.dirname, '../../../plugins', plugin, 'interface/generated.json')
  const generated = generatedFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const tools = generated.entries.filter(entry => entry.surfaces.mcp !== undefined)

  it('MCP の面を持つ項目がある', () => {
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の最上位の項目が、決まった 6 つの名前ちょうどになる', (_id, output) => {
    expect(Object.keys(output?.properties ?? {}).toSorted(compareText)).toEqual(TOP_LEVEL.toSorted(compareText))
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の data が、全ツールに共通の 4 つの項目を持つ', (_id, output) => {
    const names = dataNames(output?.properties['data'])
    expect(COMMON_DATA.filter(name => !names.includes(name))).toEqual([])
  })
})
