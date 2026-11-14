// 3 つのプラグインの MCP ツールは、同じ項目の結果を返す。定義書の mcp.output で、その名前がそろっている。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'

const REQUIRED = ['ok', 'exitCode', 'kind', 'data', 'artifacts', 'message']
const ALLOWED = new Set([...REQUIRED, 'stdout', 'stderr'])
const plugins = ['pecot-tools', 'pecot-visual', 'pecot-workflow']

describe.each(plugins)('%s の mcp.output', (plugin) => {
  const file = path.resolve(import.meta.dirname, '../../../plugins', plugin, 'interface/generated.json')
  const generated = generatedFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const tools = generated.entries.filter(entry => entry.surfaces.mcp !== undefined)

  it('MCP の面を持つ項目がある', () => {
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の最上位の項目が、決まった名前だけで、必須の 6 つを持つ', (_id, output) => {
    const names = Object.keys(output?.properties ?? {})
    expect(names.filter(name => !ALLOWED.has(name))).toEqual([])
    expect(REQUIRED.filter(name => !names.includes(name))).toEqual([])
  })
})
