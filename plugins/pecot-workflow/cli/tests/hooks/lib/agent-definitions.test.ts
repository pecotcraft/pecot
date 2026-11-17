/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはリポジトリ内の定義ファイルのみ */
// エージェント定義（agents/*.md）とスキル定義（skills/*/SKILL.md）の frontmatter の検証。
// frontmatter は YAML 1.1 で読む。
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectRoot } from '../_helpers/paths.js'
import { splitLines } from '../_helpers/text.js'
import { frontmatter } from '../../skills/_helpers/frontmatter.js'
import { compareStrings } from '../../parity/baseline.js'

const agentsDirectory = path.join(projectRoot, 'plugins', 'pecot-workflow', 'agents')
const PLUGINS = ['pecot-workflow', 'pecot-visual']
const LISTING_LIMIT = 1536
const WHEN_TO_USE_LIMIT = 80

interface AgentRow {
  readonly label: string
  readonly plugin: string
  readonly agent: string
  readonly tools: readonly string[]
  readonly window: number
  // Copilot CLI 向けの定義（com.github.copilot/agents/）の tools。Claude Code で禁じていないツールを Copilot の名前で書く。
  readonly copilotTools: readonly string[]
}

const ASK = 'AskUserQuestion'
const PLAN = ['EnterPlanMode', 'ExitPlanMode']
// 書いた名前のうち、入れていないプラグインのサーバは、Copilot が知らない名前として無視する。
// w-e2e-planner だけ '*' にする。task で起きたサブエージェントには ask_user が渡らない（1.0.112 で確認）。
const MCP = ['pecot-workflow/*', 'pecot-workflow-playwright/*', 'context7/*', 'pecot-visual/*', 'pecot-visual-playwright/*', 'pecot-tools/*', 'github/*']
const COPILOT_KEYS = ['name', 'description', 'tools', 'include-custom-instructions']
// label の昇順に並べる。
const AGENT_ROWS: readonly AgentRow[] = [
  { label: 'pecot-visual/v-diagram-creator', plugin: 'pecot-visual', agent: 'v-diagram-creator', tools: ['Agent', 'WebSearch', 'WebFetch', ...PLAN, ASK], window: 200_000, copilotTools: ['read', 'edit', 'search', 'execute', 'todo', ...MCP] },
  { label: 'pecot-workflow/w-e2e-planner', plugin: 'pecot-workflow', agent: 'w-e2e-planner', tools: [ASK, 'Monitor'], window: 400_000, copilotTools: ['*'] },
  { label: 'pecot-workflow/w-implementer', plugin: 'pecot-workflow', agent: 'w-implementer', tools: ['Agent', ...PLAN, ASK, 'Monitor'], window: 300_000, copilotTools: ['read', 'edit', 'search', 'execute', 'web', 'todo', ...MCP] },
  { label: 'pecot-workflow/w-reviewer', plugin: 'pecot-workflow', agent: 'w-reviewer', tools: ['Edit', 'Write', 'NotebookEdit', 'Agent', ...PLAN, ASK, 'Monitor'], window: 400_000, copilotTools: ['read', 'search', 'execute', 'web', 'todo', ...MCP] },
  { label: 'pecot-workflow/w-tech-advisor', plugin: 'pecot-workflow', agent: 'w-tech-advisor', tools: ['Edit', 'Write', 'NotebookEdit', 'Agent', ...PLAN, ASK, 'Monitor'], window: 400_000, copilotTools: ['read', 'search', 'execute', 'web', 'todo', ...MCP] },
]

const WORKFLOW_SKILLS = 'w-active w-backlog w-breakdown w-help w-issueize w-merge w-onboarding w-pr w-quick w-ready w-release w-repo-add w-revise w-worktree-add w-worktree-remove'.split(' ')
const EXPECTED_SKILLS = [
  ...WORKFLOW_SKILLS.map(name => `pecot-workflow/${name}`),
  ...['v-drawio', 'v-evidence', 'v-slidev'].map(name => `pecot-visual/${name}`),
]
const EXPECTED_ARGUMENT_HINTS = {
  'w-backlog': '[Epic の内容]',
  'w-quick': '[タスクの内容]',
  'w-worktree-remove': '[WT 名]',
  'v-drawio': '[図の内容]',
  'v-evidence': '[画像のパス]',
  'v-slidev': '[スライドの内容 または 既存デッキのパス]',
}

// awk '/^---$/{c++} c==1 && /^model:/' 相当。
function modelOf(file: string): string | undefined {
  let blocks = 0
  const lines = splitLines(readFileSync(file, 'utf8'))
  for (const raw of lines) {
    if (raw === '---') blocks += 1
    else if (blocks === 1 && raw.startsWith('model:')) {
      return raw.slice('model:'.length).trim()
    }
  }
  return undefined
}

// コードポイント数。
function codePoints(text: string): number {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- コードポイント単位で数える
  return [...text].length
}

function keysOf<V>(map: ReadonlyMap<string, V>): string[] {
  return Array.from(map, ([key]) => key).toSorted(compareStrings)
}

function keyed(kind: string, pattern: string, name: (found: string) => string): Map<string, string> {
  const entries = PLUGINS.flatMap((plugin) => {
    const base = path.join(projectRoot, 'plugins', plugin, kind)
    return globSync(pattern, { cwd: base }).toSorted(compareStrings).map((found): [string, string] => [`${plugin}/${name(found)}`, path.join(base, found)])
  })
  return new Map(entries)
}

const agentFiles = () => keyed('agents', '*.md', found => path.basename(found, '.md'))
const copilotAgentFiles = () => keyed('com.github.copilot/agents', '*.md', found => path.basename(found, '.md'))
const skillFiles = () => keyed('skills', '*/SKILL.md', found => path.dirname(found))

function fileOf(files: Map<string, string>, key: string): string {
  const found = files.get(key)
  if (found === undefined) throw new Error(`定義が無い: ${key}`)
  return found
}

describe('エージェントファイルの存在', () => {
  it('w-implementer.md が実在する', () => {
    expect(statSync(path.join(agentsDirectory, 'w-implementer.md')).isFile()).toBe(true)
  })

  it('w-tech-advisor.md が実在する', () => {
    expect(statSync(path.join(agentsDirectory, 'w-tech-advisor.md')).isFile()).toBe(true)
  })

  it('w-worker.md は削除済みになっている', () => {
    expect(existsSync(path.join(agentsDirectory, 'w-worker.md'))).toBe(false)
  })

  it('w-e2e-planner.md が実在する', () => {
    expect(statSync(path.join(agentsDirectory, 'w-e2e-planner.md')).isFile()).toBe(true)
  })

  it('w-e2e-tester.md は削除済みになっている', () => {
    expect(existsSync(path.join(agentsDirectory, 'w-e2e-tester.md'))).toBe(false)
  })

  it('w-reviewer.md が実在する', () => {
    expect(statSync(path.join(agentsDirectory, 'w-reviewer.md')).isFile()).toBe(true)
  })

  it('pecot-visual の v-slide-creator.md は削除済みになっている', () => {
    expect(existsSync(path.join(projectRoot, 'plugins', 'pecot-visual', 'agents', 'v-slide-creator.md'))).toBe(false)
  })
})

describe('model フィールド', () => {
  it.for(['w-implementer', 'w-tech-advisor', 'w-e2e-planner', 'w-reviewer'])('%s は、空でない model を持つ', (agent) => {
    const model = modelOf(path.join(agentsDirectory, `${agent}.md`))
    expect(model).toBeDefined()
    expect(model).not.toBe('')
  })

  it.for([
    { label: 'w-implementer', agent: 'w-implementer', expected: 'sonnet' },
    { label: 'w-tech-advisor', agent: 'w-tech-advisor', expected: 'opus' },
    { label: 'w-e2e-planner', agent: 'w-e2e-planner', expected: 'opus' },
    { label: 'w-reviewer', agent: 'w-reviewer', expected: 'opus' },
  ])('$label の model は $expected になっている', (row) => {
    expect(modelOf(path.join(agentsDirectory, `${row.agent}.md`))).toBe(row.expected)
  })

  it.for(['w-tech-advisor', 'w-e2e-planner', 'w-reviewer'])('%s の model は、agent-models.md の「役ごとのモデル」の表と一致する', (agent) => {
    const text = readFileSync(path.join(agentsDirectory, '..', 'skills', 'w-help', 'references', 'agent-models.md'), 'utf8')
    const lines = splitLines(text)
    const start = lines.indexOf('## 役ごとのモデル')
    expect(start, '「## 役ごとのモデル」の節が無い').toBeGreaterThanOrEqual(0)
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
    const section = lines.slice(start, next === -1 ? lines.length : next)
    const cells = section
      .filter(line => line.startsWith('|'))
      .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
      .find(row => row[1] === agent)
    expect(cells, `${agent} の行が表に無い`).toBeDefined()
    expect(cells?.[2]).toBe(`\`${modelOf(path.join(agentsDirectory, `${agent}.md`)) ?? ''}\``)
  })
})

describe('本文の規則', () => {
  it('w-implementer の本文に、越境ガードの判定手段・パッチ退避・定義元参照が残る', () => {
    const body = readFileSync(path.join(agentsDirectory, 'w-implementer.md'), 'utf8')
    expect(body).toContain('作業中の worktree の remote のリポジトリ')
    expect(body).toContain('越境')
    expect(body).toContain('.pecot/work/<Issue番号>/<slug>.patch')
    expect(body).toContain('issue-flow-rules.md §6')
  })
})

describe('型と内容', () => {
  it('エージェントの集合が期待どおりになっている', () => {
    expect(keysOf(agentFiles())).toEqual(AGENT_ROWS.map(row => row.label))
  })

  it.for(AGENT_ROWS)('$label の disallowedTools は、期待どおりに完全一致する', (row) => {
    const fm = frontmatter(fileOf(agentFiles(), row.label))
    expect(fm['disallowedTools']).toEqual(row.tools)
  })

  it.for(AGENT_ROWS)('$label の autoCompactWindow は、期待どおりの整数になっている', (row) => {
    const value = frontmatter(fileOf(agentFiles(), row.label))['autoCompactWindow']
    expect(Number.isSafeInteger(value), `${row.agent}: autoCompactWindow が int ではない`).toBe(true)
    expect(value).toBe(row.window)
  })

  it('Copilot 向けのエージェントの集合が、Claude Code 向けと同じになっている', () => {
    expect(keysOf(copilotAgentFiles())).toEqual(AGENT_ROWS.map(row => row.label))
  })

  it.for(AGENT_ROWS)('$label の Copilot 向けの frontmatter は、Copilot が読むキーだけを持つ', (row) => {
    const fm = frontmatter(fileOf(copilotAgentFiles(), row.label))
    expect(Object.keys(fm).toSorted(compareStrings)).toEqual(COPILOT_KEYS.toSorted(compareStrings))
    expect(fm['include-custom-instructions']).toBe(true)
  })

  it.for(AGENT_ROWS)('$label の Copilot 向けの tools は、期待どおりに完全一致する', (row) => {
    const fm = frontmatter(fileOf(copilotAgentFiles(), row.label))
    expect(fm['tools']).toEqual(row.copilotTools)
  })

  it('スキルの集合が期待どおりになっている', () => {
    expect(keysOf(skillFiles())).toEqual(EXPECTED_SKILLS.toSorted(compareStrings))
  })

  it('どのスキルにも disable-model-invocation を付けない', () => {
    const offenders = keysOf(skillFiles()).filter(key => 'disable-model-invocation' in frontmatter(fileOf(skillFiles(), key)))
    expect(offenders).toEqual([])
  })

  it('スキルの when_to_use は短い文字列で、一覧の上限に収まる', () => {
    for (const [name, file] of skillFiles()) {
      const fm = frontmatter(file)
      const whenToUse = fm['when_to_use']
      const description = fm['description']
      expect(typeof whenToUse, `${name}: when_to_use が str ではない`).toBe('string')
      expect(typeof description, `${name}: description が str ではない`).toBe('string')
      const whenLength = codePoints(String(whenToUse))
      expect(whenLength, `${name}: when_to_use が長さ制限外`).toBeGreaterThan(0)
      expect(whenLength, `${name}: when_to_use が長さ制限外`).toBeLessThanOrEqual(WHEN_TO_USE_LIMIT)
      const total = codePoints(String(description)) + 3 + whenLength
      expect(total, `${name}: description + when_to_use が ${String(total)} 文字`).toBeLessThanOrEqual(LISTING_LIMIT)
    }
  })

  it('argument-hint を持つスキルの集合と値は固定で、どの値も文字列になる', () => {
    const hints: [string, unknown][] = []
    for (const [key, file] of skillFiles()) {
      const fm = frontmatter(file)
      if ('argument-hint' in fm) hints.push([path.basename(key), fm['argument-hint']])
    }
    expect(Object.fromEntries(hints)).toEqual(EXPECTED_ARGUMENT_HINTS)
    expect(hints.every(([, value]) => typeof value === 'string')).toBe(true)
  })
})
