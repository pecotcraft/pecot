/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはリポ内の固定のパスのみ */
// CUJ の定義段落が、plan テンプレと w-e2e-planner.md の 2 箇所で一致することの固定。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectRoot } from './_helpers/paths.js'

const SOURCES: readonly string[] = [
  'plugins/pecot-workflow/cli/templates/comment/plan.md',
  'plugins/pecot-workflow/agents/w-e2e-planner.md',
]

// `CUJ = ` で始まる行から、次の空行の手前までを 1 段落として返す。
function extractDefinition(file: string): string {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => line.startsWith('CUJ = '))
  if (start === -1) throw new Error(`\`CUJ = \` で始まる定義段落が見つからない: ${file}`)
  const rest = lines.slice(start)
  const blank = rest.findIndex(line => line.trim() === '')
  return (blank === -1 ? rest : rest.slice(0, blank)).join('\n')
}

describe('CUJ の定義段落', () => {
  it('配布物の 2 箇所で一致する', () => {
    const definitions = new Map<string, string>()
    for (const relative of SOURCES) {
      const file = path.join(projectRoot, relative)
      expect(existsSync(file), `定義の複製先が移動している: ${relative}`).toBe(true)
      definitions.set(relative, extractDefinition(file))
    }
    const joined = [...definitions].map(([relative, text]) => `--- ${relative} ---\n${text}`).join('\n')
    expect(new Set(definitions.values()).size, `CUJ 定義段落が 2 箇所で一致していない:\n${joined}`).toBe(1)
  })
})
