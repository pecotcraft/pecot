// 3 つのプラグインの MCP ツールは、仕様の structuredContent の最上位にツールの項目を置く。定義書の mcp.output で、入れ物の名前が無く、共通の項目がそろっている。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

// #436 で外した、pecot 独自の入れ物の名前
const ENVELOPE = new Set(['ok', 'exitCode', 'data', 'artifacts', 'message', 'reason'])
// ツールの項目と並べて最上位に置く、全ツールに共通の項目
const COMMON = ['kind', 'detail', 'log', 'warnings']
const plugins = ['pecot-tools', 'pecot-visual', 'pecot-workflow']
// フックが呼ぶツールは、Claude Code のフックの出力の形（hookSpecificOutput）で返すので、共通の項目を持たない
const HOOK_OUTPUT = 'hookSpecificOutput'

describe.each(plugins)('%s の mcp.output', (plugin) => {
  const file = path.resolve(import.meta.dirname, '../../../plugins', plugin, 'interface/generated.json')
  const generated = generatedFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const tools = generated.entries.filter(entry => entry.surfaces.mcp !== undefined)
  const standardTools = tools.filter(entry => !Object.hasOwn(entry.mcp?.output?.properties ?? {}, HOOK_OUTPUT))

  it('MCP の面を持つ項目が 1 つ以上存在する', async () => {
    await explains(`${plugin} の定義書（\`generated.json\`）のテストです。MCP の面を持つ項目が 1 つ以上含まれていることを確認します。`)
    stepSync('MCP の項目の数を比べる', () => {
      expect(tools.length).toBeGreaterThan(0)
    })
  })

  it.each(tools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の mcp.output の最上位に、独自の入れ物の名前が含まれていない', async (id, output) => {
    await explains(`MCP ツールの \`mcp.output\` の最上位のプロパティのテストです。${plugin} の項目 \`${id}\` に、\`ok\`・\`exitCode\`・\`data\` など、pecot 独自の入れ物の名前が含まれないことを確認します。`)
    stepSync('最上位の入れ物の名前を比べる', () => {
      expect(Object.keys(output?.properties ?? {}).filter(name => ENVELOPE.has(name))).toEqual([])
    })
  })

  it.each(standardTools.map(entry => [entry.id, entry.mcp?.output] as const))('%s の mcp.output は、type が object で、共通の 4 項目を properties に含む', async (id, output) => {
    await explains(`MCP ツールの \`mcp.output\` の形のテストです。${plugin} の項目 \`${id}\` の最上位が \`type: object\` で、\`kind\`・\`detail\`・\`log\`・\`warnings\` を \`properties\` に含むことを確認します。`)
    stepSync('最上位の型を比べる', () => {
      expect(output?.type).toBe('object')
    })
    const names = Object.keys(output?.properties ?? {})
    stepSync('共通の項目を比べる', () => {
      expect(COMMON.filter(name => !names.includes(name))).toEqual([])
    })
  })
})
