/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは actions/ の下のファイルだけ */
// actions/ が AI に向けたものを持たないことを確かめる（FR-011）。雛形の claude-code-action の行だけは AI を呼ぶ。
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

const ACTIONS_ROOT = path.resolve(import.meta.dirname, '..')
const AGENT_FILES = new Set(['SKILL.md', 'plugin.json', '.mcp.json', 'mcp.json'])
const SKIPPED = new Set(['node_modules', 'coverage', 'test-results', 'tests'])

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return []
    const full = path.join(directory, entry.name)
    return !entry.isDirectory() || entry.name === 'agents' ? full : files(full)
  })
}

const ALL = files(ACTIONS_ROOT)
const relative = (file: string): string => path.relative(ACTIONS_ROOT, file)
// action の中身。src・action.yml・dist・package.json
const SHIPPED = ALL.filter(file => /^(?:src\/|[a-z-]+\/(?:action\.yml|dist\/)|package\.json$)/u.test(relative(file)))

describe('actions/ の中身', () => {
  it('SKILL.md・agents/・plugin.json・.mcp.json・mcp.json を持たない', async () => {
    await explains('`actions/` の下のファイルの一覧のテストです。エージェントに向けた `SKILL.md`・`agents/`・`plugin.json`・`.mcp.json`・`mcp.json` が存在しないことを確認します。')
    expect(ALL.filter(file => AGENT_FILES.has(path.basename(file)) || path.basename(file) === 'agents').map(file => relative(file))).toEqual([])
  })

  it('action の中身と package.json に、MCP の SDK と mcp__ のツール名が無い', async () => {
    await explains('action として配る `src/`・`action.yml`・`dist/`・`package.json` のテストです。MCP の SDK（`@modelcontextprotocol/`）と `mcp__` で始まるツール名が含まれないことを確認します。')
    const found = SHIPPED.filter(file => /@modelcontextprotocol\/|\bmcp__/u.test(readFileSync(file, 'utf8')))
    expect(found.map(file => relative(file))).toEqual([])
  })

  it('雛形の mcp__ のツール名は、claude-code-action の --allowedTools の行にだけ出る', async () => {
    await explains('利用者のリポに置くワークフローの雛形（`templates/`）のテストです。`mcp__` のツール名が 1 行以上あり、どれも claude-code-action の `--allowedTools` の行にだけ現れることを確認します。')
    const lines = ALL.filter(file => relative(file).startsWith('templates'))
      .flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('mcp__')).map(line => `${relative(file)}: ${line.trim()}`))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter(line => !line.includes('--allowedTools'))).toEqual([])
  })
})
