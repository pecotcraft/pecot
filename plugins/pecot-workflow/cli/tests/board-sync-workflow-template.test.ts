// 配布する board sync のワークフローの雛形が、安全な形・版の追従・文書との一致を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-board-sync.yml'), 'utf8')
const document = readFileSync(path.join(pluginRoot, 'skills/w-help/references/board-sync-workflow.md'), 'utf8')
const manifest: unknown = JSON.parse(readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'))
const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  jobs: Record<string, { if?: string, steps: Step[] }>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
const steps = workflow.jobs['sync']?.steps ?? []

function pluginMajor(): string {
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new TypeError('plugin.json に version が無い')
  }
  const [major = ''] = manifest.version.split('.', 1)
  return major
}

function documentSection(heading: string): string {
  const start = document.indexOf(`\n${heading}\n`)
  expect(start, `${heading} が文書に無い`).toBeGreaterThanOrEqual(0)
  const rest = document.slice(start + heading.length + 2)
  const next = rest.search(/^#{2,3} /m)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('board sync のワークフローの雛形', () => {
  it('npx の版指定が plugin.json の major と一致する', () => {
    expect(active).toContain(`@pecot/workflow-mcp@${pluginMajor()} board sync`)
  })

  it('3 つの契機がそろっている', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request_target', 'issues', 'workflow_dispatch']))
  })

  it('pull_request_target を使い、pull_request は使わない', () => {
    expect(workflow.on).toHaveProperty('pull_request_target')
    expect(workflow.on).not.toHaveProperty('pull_request')
  })

  it('job の if が variable で飛び、Dependabot が起こした実行を除く', () => {
    const condition = workflow.jobs['sync']?.if ?? ''
    expect(condition).toContain('vars.PECOT_BOARD_SYNC_APP_CLIENT_ID != \'\'')
    expect(condition).toContain('vars.PECOT_BOARD_SYNC_USE_PAT == \'true\'')
    expect(condition).toContain('github.actor != \'dependabot[bot]\'')
    expect(condition).not.toContain('secrets.')
  })

  it('checkout は ref を指定せず、資格情報を残さない', () => {
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()
    expect(checkout?.with).not.toHaveProperty('ref')
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('permissions は contents: read だけで、cancel-in-progress は false', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  })

  it('run に式を埋め込まない', () => {
    const runs = steps.filter(step => step.run !== undefined)
    expect(runs.map(step => step.run)).toEqual(['npx -y --prefix=/ @pecot/workflow-mcp@' + pluginMajor() + ' board sync'])
    for (const step of runs) expect(step.run).not.toContain('${{')
  })

  it('すべての action を 40 桁の SHA で固定する', () => {
    const uses = steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })

  it('雛形の variable と secret の名前が、文書に出てくる', () => {
    const names = new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.(PECOT_BOARD_SYNC_[A-Z_]+)/g), match => match[1] ?? ''))
    expect([...names].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'PECOT_BOARD_SYNC_APP_CLIENT_ID',
      'PECOT_BOARD_SYNC_APP_PRIVATE_KEY',
      'PECOT_BOARD_SYNC_TOKEN',
      'PECOT_BOARD_SYNC_USE_PAT',
    ])
    for (const name of names) expect(document).toContain(`\`${name}\``)
  })

  it('App の権限が、文書の「App の権限」と食い違わない', () => {
    const appToken = steps.find(step => step.uses?.startsWith('actions/create-github-app-token@'))
    const granted = Object.entries(appToken?.with ?? {})
      .filter(([key]) => key.startsWith('permission-'))
      .map(([key, value]): [string, string] => [key.slice('permission-'.length), String(value)])
    expect(granted.length).toBeGreaterThan(0)

    const labels = new Map([
      ['organization-projects', '組織の Projects'],
      ['issues', 'Issues'],
      ['pull-requests', 'Pull requests'],
      ['contents', 'Contents'],
    ])
    const lines = documentSection('### GitHub App').split('\n')
    const permissionLines = lines.slice(lines.findIndex(line => line.includes('App の権限')) + 1).filter(line => line.startsWith('  - '))

    const fromTemplate = granted.map(([key, access]) => `${labels.get(key) ?? key}: ${access === 'write' ? 'read and write' : 'read'}`)
    const fromDocument = fromTemplate.map((entry) => {
      const label = entry.slice(0, entry.indexOf(':'))
      const line = permissionLines.find(candidate => candidate.includes(label)) ?? ''
      return `${label}: ${/: (read and write|read)$/.exec(line)?.[1] ?? '文書に無い'}`
    })
    expect(fromDocument).toEqual(fromTemplate)
    expect(permissionLines).toHaveLength(2)
  })
})
