// hooks が shell に持つツール名の一覧を、定義書（interface/generated.json）の項目と比べる。
// 一覧の変更で hooks の pytest を動かさないよう、この突合は test-hooks でなく test-cli に置く。
// 「cli 側のテストからは hooks/ を読まない」(tests/hooks/baseline-scripts.test.ts) の例外。
// 読む hooks/lib/core/pecot-tool-names.sh だけを project.json の test-cli の inputs に置いている。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const pluginRoot = path.resolve(import.meta.dirname, '../..')
const toolNamesScript = path.join(pluginRoot, 'hooks/lib/core/pecot-tool-names.sh')

function compareText(a: string, b: string): number {
  return a.localeCompare(b)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

// 定義書の項目の cli.path を `_` でつなぎ、`-` を `_` にした名前。
function namesFromDefinitions(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(pluginRoot, 'interface/generated.json'), 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) throw new TypeError('generated.json の entries が配列でない')
  const entries: readonly unknown[] = parsed['entries']
  return entries.map((entry) => {
    const surfaces = isRecord(entry) ? entry['surfaces'] : undefined
    const cli = isRecord(surfaces) ? surfaces['cli'] : undefined
    const segments = isRecord(cli) ? cli['path'] : undefined
    if (!Array.isArray(segments)) throw new TypeError('項目に surfaces.cli.path が無い')
    return segments.join('_').replaceAll('-', '_')
  })
}

function runShell(script: string): string {
  const result = spawnSync('bash', ['-c', `source "${toolNamesScript}"; ${script}`], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  })
  expect(result.status).toBe(0)
  return result.stdout
}

describe('hooks のツール名の一覧', () => {
  it('定義書の 34 項目と一致する', () => {
    const fromShell = runShell('printf "%s\\n" $PECOT_TOOL_NAMES').split('\n').filter(Boolean)
    const fromDefinitions = namesFromDefinitions()
    expect(fromDefinitions).toHaveLength(34)
    expect(fromShell.toSorted(compareText)).toEqual(fromDefinitions.toSorted(compareText))
  })

  it.for([
    { label: '接頭辞が長い形', prefix: 'mcp__plugin_pecot-w_pecot-workflow__' },
    { label: '接頭辞が短い形', prefix: 'pecot-workflow-' },
  ])('$label の名前から、一覧にある名前を取り出す', ({ prefix }) => {
    const names = namesFromDefinitions()
    const extracted = names.map(name => runShell(`pecot_tool_from_hook_name "${prefix}${name}"`))
    expect(extracted).toEqual(names)
  })
})
