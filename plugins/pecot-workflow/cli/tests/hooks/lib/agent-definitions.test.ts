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
import { explains } from '../../_helpers/explains.js'

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
const MCP = ['pecot-workflow/*', 'pecot-workflow-playwright/*', 'context7/*', 'pecot-visual/*', 'pecot-visual-playwright/*', 'pecot-tools/*', 'github/*']
const COPILOT_KEYS = ['name', 'description', 'tools', 'include-custom-instructions']
// label の昇順に並べる。
const AGENT_ROWS: readonly AgentRow[] = [
  { label: 'pecot-visual/v-diagram-creator', plugin: 'pecot-visual', agent: 'v-diagram-creator', tools: ['Agent', 'WebSearch', 'WebFetch', ...PLAN, ASK], window: 200_000, copilotTools: ['read', 'edit', 'search', 'execute', 'todo', ...MCP] },
  { label: 'pecot-workflow/w-implementer', plugin: 'pecot-workflow', agent: 'w-implementer', tools: ['Agent', ...PLAN, ASK, 'Monitor'], window: 300_000, copilotTools: ['read', 'edit', 'search', 'execute', 'web', 'todo', ...MCP] },
  { label: 'pecot-workflow/w-plan-reviewer', plugin: 'pecot-workflow', agent: 'w-plan-reviewer', tools: ['Edit', 'Write', 'NotebookEdit', 'Agent', ...PLAN, ASK, 'Monitor'], window: 400_000, copilotTools: ['read', 'search', 'execute', 'web', 'todo', ...MCP] },
]

const WORKFLOW_SKILLS = 'w-active w-auto w-backlog w-breakdown w-handoff w-help w-issueize w-onboarding w-pr w-quick w-ready w-release w-repo-add w-review w-worktree-add w-worktree-remove'.split(' ')
const EXPECTED_SKILLS = [
  ...WORKFLOW_SKILLS.map(name => `pecot-workflow/${name}`),
  ...['v-drawio', 'v-evidence', 'v-slidev'].map(name => `pecot-visual/${name}`),
]
const EXPECTED_ARGUMENT_HINTS = {
  'w-active': '[Issue]',
  'w-auto': '<種類> <owner/repo/N> context=<パス> result=<パス> [project=<名前>]',
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
  it('w-implementer.md が実在する', async () => {
    await explains('エージェント定義ファイルの存在のテストです。`agents` ディレクトリに `w-implementer.md` がファイルとして存在することを確認します。')
    expect(statSync(path.join(agentsDirectory, 'w-implementer.md')).isFile()).toBe(true)
  })

  it('w-worker.md は削除済みになっている', async () => {
    await explains('エージェント定義ファイルの削除のテストです。廃止した `w-worker.md` が `agents` ディレクトリに存在しないことを確認します。')
    expect(existsSync(path.join(agentsDirectory, 'w-worker.md'))).toBe(false)
  })

  it('w-e2e-planner.md は削除済みになっている', async () => {
    await explains('エージェント定義ファイルの削除のテストです。廃止した `w-e2e-planner.md` が `agents` ディレクトリに存在しないことを確認します。')
    expect(existsSync(path.join(agentsDirectory, 'w-e2e-planner.md'))).toBe(false)
  })

  it('w-e2e-tester.md は削除済みになっている', async () => {
    await explains('エージェント定義ファイルの削除のテストです。廃止した `w-e2e-tester.md` が `agents` ディレクトリに存在しないことを確認します。')
    expect(existsSync(path.join(agentsDirectory, 'w-e2e-tester.md'))).toBe(false)
  })

  it('w-plan-reviewer.md が実在する', async () => {
    await explains('エージェント定義ファイルの存在のテストです。`agents` ディレクトリに `w-plan-reviewer.md` がファイルとして存在することを確認します。')
    expect(statSync(path.join(agentsDirectory, 'w-plan-reviewer.md')).isFile()).toBe(true)
  })

  it('w-plan-reviewer の [cuj] は、流す先の欠け・作業中のリポで流す計画・-p で動かない CUJ を挙げる', async () => {
    await explains('`w-plan-reviewer.md` の本文のテストです。CUJ に関する 3 つの規則（流す先の欠け、作業中のリポで流す計画、`-p` で動かない CUJ を挙げること）が、本文に記載されていることを確認します。')
    const body = readFileSync(path.join(agentsDirectory, 'w-plan-reviewer.md'), 'utf8')
    for (const rule of [
      '- 「流す先」の項目が無い CUJ は、欠けとして CUJ の番号を挙げる',
      '作業中のリポで流す計画として CUJ の番号を挙げる。指示に検証用の場所が無いリポでは挙げない',
      '「誰が」の項目が `-p` のものは、対話のセッションに書き直させる',
    ]) expect(body).toContain(rule)
  })

  it('pecot-visual の v-slide-creator.md は削除済みになっている', async () => {
    await explains('エージェント定義ファイルの削除のテストです。廃止した pecot-visual の `v-slide-creator.md` が、`agents` ディレクトリに存在しないことを確認します。')
    expect(existsSync(path.join(projectRoot, 'plugins', 'pecot-visual', 'agents', 'v-slide-creator.md'))).toBe(false)
  })
})

describe('model フィールド', () => {
  it.for(['w-implementer', 'w-plan-reviewer'])('%s は、空でない model を持つ', async (agent) => {
    await explains(`エージェント定義の \`model\` フィールドのテストです。\`${agent}\` の定義が、空でない \`model\` を持つことを確認します。`)
    const model = modelOf(path.join(agentsDirectory, `${agent}.md`))
    expect(model).toBeDefined()
    expect(model).not.toBe('')
  })

  it.for([
    { label: 'w-implementer', agent: 'w-implementer', expected: 'sonnet' },
    { label: 'w-plan-reviewer', agent: 'w-plan-reviewer', expected: 'opus' },
  ])('$label の model は $expected になっている', async (row) => {
    await explains(`エージェント定義の \`model\` フィールドのテストです。\`${row.label}\` の定義の \`model\` が、期待する値（\`${row.expected}\`）と一致することを確認します。`)
    expect(modelOf(path.join(agentsDirectory, `${row.agent}.md`))).toBe(row.expected)
  })

  it.for(['w-plan-reviewer'])('%s の model は、agent-models.md の「役ごとのモデル」の表と一致する', async (agent) => {
    await explains(`エージェント定義の \`model\` と、\`agent-models.md\` の「役ごとのモデル」の表のテストです。\`${agent}\` の定義の \`model\` が、表に記載された値と一致することを確認します。`)
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
  it('w-implementer の本文に、越境ガードの判定手段・パッチ退避・定義元参照が残る', async () => {
    await explains('`w-implementer.md` の本文のテストです。越境ガードの判定手段、パッチの退避先、定義元の参照（`issue-flow-rules.md §6`）が、本文に含まれていることを確認します。')
    const body = readFileSync(path.join(agentsDirectory, 'w-implementer.md'), 'utf8')
    expect(body).toContain('作業中の worktree の remote のリポジトリ')
    expect(body).toContain('越境')
    expect(body).toContain('.pecot/work/<Issue番号>/<slug>.patch')
    expect(body).toContain('issue-flow-rules.md §6')
  })
})

describe('型と内容', () => {
  it('エージェントの集合が期待どおりになっている', async () => {
    await explains('エージェント定義の一覧のテストです。`agents` ディレクトリにあるエージェントの集合が、期待する一覧と一致することを確認します。')
    expect(keysOf(agentFiles())).toEqual(AGENT_ROWS.map(row => row.label))
  })

  it.for(AGENT_ROWS)('$label の disallowedTools は、期待どおりに完全一致する', async (row) => {
    await explains(`エージェント定義の frontmatter のテストです。\`${row.label}\` の \`disallowedTools\` が、期待するツールの一覧と一致することを確認します。`)
    const fm = frontmatter(fileOf(agentFiles(), row.label))
    expect(fm['disallowedTools']).toEqual(row.tools)
  })

  it.for(AGENT_ROWS)('$label の autoCompactWindow は、期待どおりの整数になっている', async (row) => {
    await explains(`エージェント定義の frontmatter のテストです。\`${row.label}\` の \`autoCompactWindow\` が、期待する整数の値と一致することを確認します。`)
    const value = frontmatter(fileOf(agentFiles(), row.label))['autoCompactWindow']
    expect(Number.isSafeInteger(value), `${row.agent}: autoCompactWindow が int ではない`).toBe(true)
    expect(value).toBe(row.window)
  })

  it('Copilot 向けのエージェントの集合が、Claude Code 向けと同じになっている', async () => {
    await explains('Copilot 向けのエージェント定義の一覧のテストです。`com.github.copilot/agents` にあるエージェントの集合が、Claude Code 向けの一覧と一致することを確認します。')
    expect(keysOf(copilotAgentFiles())).toEqual(AGENT_ROWS.map(row => row.label))
  })

  it.for(AGENT_ROWS)('$label の Copilot 向けの frontmatter は、Copilot が読むキーだけを持つ', async (row) => {
    await explains(`Copilot 向けのエージェント定義の frontmatter のテストです。\`${row.label}\` が Copilot の読むキーだけを持ち、\`include-custom-instructions\` が \`true\` であることを確認します。`)
    const fm = frontmatter(fileOf(copilotAgentFiles(), row.label))
    expect(Object.keys(fm).toSorted(compareStrings)).toEqual(COPILOT_KEYS.toSorted(compareStrings))
    expect(fm['include-custom-instructions']).toBe(true)
  })

  it.for(AGENT_ROWS)('$label の Copilot 向けの tools は、期待どおりに完全一致する', async (row) => {
    await explains(`Copilot 向けのエージェント定義の frontmatter のテストです。\`${row.label}\` の \`tools\` が、期待するツールの一覧と一致することを確認します。`)
    const fm = frontmatter(fileOf(copilotAgentFiles(), row.label))
    expect(fm['tools']).toEqual(row.copilotTools)
  })

  it('スキルの集合が期待どおりになっている', async () => {
    await explains('スキル定義の一覧のテストです。`skills` ディレクトリにあるスキルの集合が、期待する一覧と一致することを確認します。')
    expect(keysOf(skillFiles())).toEqual(EXPECTED_SKILLS.toSorted(compareStrings))
  })

  it('どのスキルにも disable-model-invocation を付けない', async () => {
    await explains('スキル定義の frontmatter のテストです。どのスキルの frontmatter にも `disable-model-invocation` が含まれていないことを確認します。')
    const offenders = keysOf(skillFiles()).filter(key => 'disable-model-invocation' in frontmatter(fileOf(skillFiles(), key)))
    expect(offenders).toEqual([])
  })

  it('スキルの when_to_use は短い文字列で、一覧の上限に収まる', async () => {
    await explains('スキル定義の frontmatter の長さのテストです。すべてのスキルの `when_to_use` が 80 文字以内の文字列であり、`description` との合計が一覧の上限（1536 文字）に収まることを確認します。')
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

  it('argument-hint を持つスキルの集合と値は固定で、どの値も文字列になる', async () => {
    await explains('スキル定義の `argument-hint` のテストです。`argument-hint` を持つスキルの集合と値が期待する内容と一致し、どの値も文字列であることを確認します。')
    const hints: [string, unknown][] = []
    for (const [key, file] of skillFiles()) {
      const fm = frontmatter(file)
      if ('argument-hint' in fm) hints.push([path.basename(key), fm['argument-hint']])
    }
    expect(Object.fromEntries(hints)).toEqual(EXPECTED_ARGUMENT_HINTS)
    expect(hints.every(([, value]) => typeof value === 'string')).toBe(true)
  })
})
