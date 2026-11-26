/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはプラグインのリポジトリ内のファイルのみ */
// hooks 定義 4 本の timeout・matcher・イベントの構成と、command が指すファイルの実在を固定する。
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../../parity/baseline.js'
import { isFile } from '../_helpers/files.js'
import { toArray, toRecord } from '../_helpers/json.js'
import { projectRoot } from '../_helpers/paths.js'
import { parseJson } from '../_helpers/text.js'

const WORKFLOW = 'pecot-workflow'
const VISUAL = 'pecot-visual'

const COPILOT_HOOKS = 'com.github.copilot/hooks/hooks.json'
const COPILOT_VISUAL = COPILOT_HOOKS

interface Definition {
  readonly label: string
  readonly plugin: string
  readonly name: string
}

function definition(plugin: string, name: string): Definition {
  return { label: `${plugin}/${name}`, plugin, name }
}

const DEFINITIONS = [
  definition(WORKFLOW, 'hooks.json'),
  definition(WORKFLOW, COPILOT_HOOKS),
  definition(VISUAL, 'hooks.json'),
  definition(VISUAL, COPILOT_VISUAL),
]
const CLAUDE_DEFINITIONS = [definition(WORKFLOW, 'hooks.json'), definition(VISUAL, 'hooks.json')]
const COPILOT_DEFINITIONS = [definition(WORKFLOW, COPILOT_HOOKS), definition(VISUAL, COPILOT_VISUAL)]

// 撤廃したエントリの matcher に入っていたツール名（spec 025 FR-010〜FR-014）。
const REMOVED_PRE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'EnterPlanMode', 'WebSearch'])
const REMOVED_POST_TOOLS: ReadonlySet<string> = new Set(['Skill', 'skill', 'Bash'])
const QUOTED_COMMAND = /^"\$\{CLAUDE_PLUGIN_ROOT\}"\/hooks\/(?<file>[\w.-]+\.sh)$/u
// ファイル名の抽出用。クォートの有無は問わない。
const FILE = /\/hooks\/(?<file>[\w.-]+\.sh)$/u
const PASCAL_CASE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'])

const pluginsDirectory = path.join(projectRoot, 'plugins')

interface Hook {
  readonly type: unknown
  // `type: "mcp_tool"` のフックは command を持たず、tool を持つ
  readonly command: string | undefined
  readonly tool: string | undefined
  readonly hasTimeout: boolean
  readonly timeout: unknown
}

interface Entry {
  readonly hasMatcher: boolean
  readonly matcher: string | undefined
  readonly hooks: readonly Hook[]
}

type Hooks = ReadonlyMap<string, readonly Entry[]>

function toHook(value: unknown): Hook {
  const record = toRecord(value, 'hook')
  const base = { type: record['type'], hasTimeout: 'timeout' in record, timeout: record['timeout'] }
  if (record['type'] === 'mcp_tool') {
    if (typeof record['tool'] !== 'string') throw new TypeError('tool が文字列ではありません')
    return { ...base, command: undefined, tool: record['tool'] }
  }
  if (typeof record['command'] !== 'string') throw new TypeError('command が文字列ではありません')
  return { ...base, command: record['command'], tool: undefined }
}

function isCommand(hook: Hook): boolean {
  return hook.command !== undefined
}

function toEntry(value: unknown): Entry {
  const record = toRecord(value, 'entry')
  const matcher = record['matcher']
  return {
    hasMatcher: 'matcher' in record,
    matcher: typeof matcher === 'string' ? matcher : undefined,
    hooks: toArray(record['hooks'], 'hooks').map(hook => toHook(hook)),
  }
}

function toEntries(value: unknown): Entry[] {
  return toArray(value, 'entries').map(entry => toEntry(entry))
}

function definitionPath(plugin: string, name: string): string {
  return name.includes('/') ? path.join(pluginsDirectory, plugin, name) : path.join(pluginsDirectory, plugin, 'hooks', name)
}

function load(plugin: string, name: string): Hooks {
  const text = readFileSync(definitionPath(plugin, name), 'utf8')
  const root = toRecord(parseJson(text), '定義')
  const pairs = Object.entries(toRecord(root['hooks'], 'hooks'))
  const converted = pairs.map(([event, entries]): [string, Entry[]] => [event, toEntries(entries)])
  return new Map(converted)
}

function eventsOf(hooks: Hooks): string[] {
  return Array.from(hooks, ([event]) => event)
}

function entriesOf(hooks: Hooks, event: string): readonly Entry[] {
  return hooks.get(event) ?? []
}

interface FlatHook {
  readonly event: string
  readonly matcher: string | undefined
  readonly hook: Hook
}

// (event, matcher, hook) を全件返す。
function allHooks(hooks: Hooks): FlatHook[] {
  return [...hooks].flatMap(([event, entries]) => entries.flatMap(entry => entry.hooks.map(hook => ({ event, matcher: entry.matcher, hook }))))
}

function fileOf(hook: Hook): string {
  const found = FILE.exec(hook.command ?? '')?.groups?.['file']
  if (found === undefined) throw new Error(`command が hooks/<file>.sh を指していない: ${String(hook.command)}`)
  return found
}

// timeout の表を引く名前。command のフックはファイル名、mcp_tool のフックは `mcp:<ツール名>`。
function nameOf(hook: Hook): string {
  return hook.tool === undefined ? fileOf(hook) : `mcp:${hook.tool}`
}

// 期待の timeout の表。キーは `プラグイン|イベント|matcher`（matcher 無しは空）。
const EXPECTED_TIMEOUTS = new Map([
  ['pecot-workflow|SessionStart|', 120],
  ['pecot-workflow|PreToolUse|', 10],
  ['pecot-workflow|UserPromptSubmit|', 10],
  ['pecot-visual|SessionStart|', 120],
  ['pecot-visual|UserPromptSubmit|', 10],
  ['pecot-visual|PreToolUse|', 10],
  ['pecot-visual|PostToolUse|Write|Edit', 80],
])

// setup の時間切れで session-title の出力が捨てられないよう、別エントリで長く取る。
const LONG_TIMEOUT_SCRIPTS = new Map([['pecot-workflow|session-start-worktree-setup.sh', 600]])

function expectedTimeout(plugin: string, event: string, matcher: string | undefined, file: string): number {
  const long = LONG_TIMEOUT_SCRIPTS.get(`${plugin}|${file}`)
  if (long !== undefined) return long
  // matcher で timeout が変わるのは PostToolUse だけなので、ほかのイベントは matcher を畳んで引く。
  const collapsed = event === 'PostToolUse' ? (matcher ?? '') : ''
  const found = EXPECTED_TIMEOUTS.get(`${plugin}|${event}|${collapsed}`)
  if (found === undefined) throw new Error(`期待値の表に無い組: ${plugin} ${event} ${String(matcher)}`)
  return found
}

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

// 全定義共通。
describe('全定義共通', () => {
  it.for(DEFINITIONS)('$label の全 hook が、期待の timeout を持つ', (row) => {
    const hooks = load(row.plugin, row.name)
    let seen = 0
    for (const { event, matcher, hook } of allHooks(hooks)) {
      seen += 1
      expect(hook.hasTimeout, `timeout が無い: ${event} ${String(matcher)} ${nameOf(hook)}`).toBe(true)
      expect(hook.timeout, `${event} ${String(matcher)} ${nameOf(hook)}`).toBe(expectedTimeout(row.plugin, event, matcher, nameOf(hook)))
    }
    expect(seen).toBeGreaterThan(0)
  })

  it.for(DEFINITIONS)('$label の command は、プラグインルートの変数をクォートする', (row) => {
    const flat = allHooks(load(row.plugin, row.name)).filter(({ hook }) => isCommand(hook))
    for (const { event, matcher, hook } of flat) {
      expect(hook.type).toBe('command')
      expect(hook.command, `${event} ${String(matcher)}: "\${CLAUDE_PLUGIN_ROOT}"/hooks/<file> の形にする`).toMatch(QUOTED_COMMAND)
    }
  })

  it.for(DEFINITIONS)('$label の command が指すファイルは、実在し実行できる', (row) => {
    const flat = allHooks(load(row.plugin, row.name)).filter(({ hook }) => isCommand(hook))
    for (const { event, matcher, hook } of flat) {
      const target = path.join(pluginsDirectory, row.plugin, 'hooks', fileOf(hook))
      expect(isFile(target), `${event} ${String(matcher)}: ${target} が無い`).toBe(true)
      expect(isExecutable(target), `${target} に実行権が無い`).toBe(true)
    }
  })

  it.for(DEFINITIONS)('$label の PreToolUse は、すべて matcher を持つ', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'PreToolUse')
    for (const entry of entries) {
      expect(entry.matcher, `matcher 無しの PreToolUse: ${JSON.stringify(entry)}`).toBeTruthy()
    }
  })

  // camelCase のイベント名は camelCase の入力を送る形式になり、hooks が読めない。
  it.for(COPILOT_DEFINITIONS)('$label のイベント名は、PascalCase になっている', (row) => {
    const events = eventsOf(load(row.plugin, row.name))
    expect(events.filter(event => !PASCAL_CASE_EVENTS.has(event))).toEqual([])
  })
})

// matcher を `|` で分けたツール名。
function toolsOf(matcher = ''): string[] {
  return matcher.split('|')
}

// 撤廃したエントリ（pecot-workflow）。
describe('撤廃したエントリ', () => {
  it.for([
    { label: 'Claude', name: 'hooks.json' },
    { label: 'Copilot', name: COPILOT_HOOKS },
  ])('$label の PreToolUse の matcher に、Edit 系と WebSearch が無い', (row) => {
    const tools = entriesOf(load(WORKFLOW, row.name), 'PreToolUse').flatMap(entry => toolsOf(entry.matcher))
    expect(tools.filter(tool => REMOVED_PRE_TOOLS.has(tool))).toEqual([])
  })

  it.for([
    { label: 'Claude', name: 'hooks.json' },
    { label: 'Copilot', name: COPILOT_HOOKS },
  ])('$label の PostToolUse の matcher に、Skill と Bash が無い', (row) => {
    const tools = entriesOf(load(WORKFLOW, row.name), 'PostToolUse').flatMap(entry => toolsOf(entry.matcher))
    expect(tools.filter(tool => REMOVED_POST_TOOLS.has(tool))).toEqual([])
  })

  it.for([
    { label: 'Claude', name: 'hooks.json' },
    { label: 'Copilot', name: COPILOT_HOOKS },
  ])('$label の定義に、Stop と Notification のエントリが無い', (row) => {
    const events = eventsOf(load(WORKFLOW, row.name))
    expect(events.filter(event => event === 'Stop' || event === 'Notification')).toEqual([])
  })

  it.for([
    { label: 'Claude', name: 'hooks.json' },
    { label: 'Copilot', name: COPILOT_HOOKS },
  ])('$label の定義の description に、通知の言及が無い', (row) => {
    const text = readFileSync(definitionPath(WORKFLOW, row.name), 'utf8')
    const root = toRecord(parseJson(text), '定義')
    expect(String(root['description'])).not.toMatch(/notification/iu)
  })
})

// SessionStart
// setup は時間切れで出力が捨てられても session-title を巻き込まないよう、別のエントリにする。
const WORKTREE_SETUP_ENTRY = 'session-start-worktree-setup.sh'

describe('SessionStart', () => {
  it.for(CLAUDE_DEFINITIONS)('$label の Claude 定義は、SessionStart を 1 エントリにまとめ、pecot-workflow だけ setup のエントリを別に持つ', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'SessionStart')
    const expected = row.plugin === WORKFLOW ? 'startup|clear|resume|fork|compact' : 'startup|clear|resume'
    expect(entries.at(0)?.matcher).toBe(expected)
    expect(entries.at(0)?.hooks.map(hook => fileOf(hook))).toEqual(['session-start.sh'])
    const rest = entries.slice(1).map(entry => ({ matcher: entry.matcher, files: entry.hooks.map(hook => fileOf(hook)) }))
    expect(rest).toEqual(row.plugin === WORKFLOW ? [{ matcher: 'startup|clear|resume|fork', files: [WORKTREE_SETUP_ENTRY] }] : [])
  })

  // データ置き場は wrapper が決めるので、CLAUDE_ENV_FILE へ書く hook は無い（#1258）。
  it.for(DEFINITIONS)('$label に、データ置き場を受け渡す hook は無い', (row) => {
    const text = readFileSync(definitionPath(row.plugin, row.name), 'utf8')
    expect(text).not.toContain('session-start-data-dir')
    expect(text).not.toContain('CLAUDE_ENV_FILE')
  })

  it('pecot-tools は、hooks ディレクトリを持たない', () => {
    expect(existsSync(path.join(pluginsDirectory, 'pecot-tools', 'hooks'))).toBe(false)
  })

  // sessionTitle は Claude Code 専用の出力項目なので、com.github.copilot/hooks/hooks.json には載せない。
  it('セッション名のエントリは、Claude の定義にだけ置く', () => {
    const claude = entriesOf(load(WORKFLOW, 'hooks.json'), 'UserPromptSubmit').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(claude).toEqual(['user-prompt-submit.sh', 'user-prompt-submit-title.sh'])
    const copilot = entriesOf(load(WORKFLOW, COPILOT_HOOKS), 'UserPromptSubmit').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(copilot).not.toContain('user-prompt-submit-title.sh')
  })

  it.for(COPILOT_DEFINITIONS)('$label の Copilot 定義は、matcher の無い SessionStart を持ち、pecot-workflow だけ setup のエントリを別に持つ', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'SessionStart')
    expect(entries.every(entry => !entry.hasMatcher)).toBe(true)
    const files = entries.map(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(files).toEqual(row.plugin === WORKFLOW ? [['session-start.sh'], [WORKTREE_SETUP_ENTRY]] : [['session-start.sh']])
  })
})

// Copilot CLI の matcher は全体一致 `^(?:PATTERN)$` で、skill と MCP に Claude の名前が無い。
function matchersOf(hooks: Hooks, entryFile: string): (string | undefined)[] {
  return entriesOf(hooks, 'PreToolUse').filter(entry => entry.hooks.some(hook => fileOf(hook) === entryFile)).map(entry => entry.matcher)
}

describe('Copilot CLI の matcher', () => {
  it('pecot-workflow の PreToolUse の skill の matcher は、生の tool 名を含む', () => {
    expect(matchersOf(load(WORKFLOW, COPILOT_HOOKS), 'pre-tool-use-skill.sh')).toEqual(['Skill|skill'])
  })

  it('pecot-workflow の 2 つの定義は、PostToolUse のキーを持たない', () => {
    expect(eventsOf(load(WORKFLOW, COPILOT_HOOKS))).not.toContain('PostToolUse')
    expect(eventsOf(load(WORKFLOW, 'hooks.json'))).not.toContain('PostToolUse')
  })

  it('pecot-visual の skill の matcher は、生の tool 名を含む', () => {
    const matchers = matchersOf(load(VISUAL, COPILOT_VISUAL), 'pre-tool-use-skill.sh')
    expect(matchers).toEqual(['Skill|skill'])
  })

  it('Claude の skill の matcher は、変えない', () => {
    const workflow = load(WORKFLOW, 'hooks.json')
    expect(matchersOf(workflow, 'pre-tool-use-skill.sh')).toEqual(['Skill'])
    expect(matchersOf(load(VISUAL, 'hooks.json'), 'pre-tool-use-skill.sh')).toEqual(['Skill'])
  })
})

// 残すフックの一覧（spec 025 の research.md R1）。#466 で exit-plan-remind を置き換えたら一覧も直す。
const REGISTERED_SCRIPTS = new Map([
  ['hooks.json', ['pre-tool-use-bash.sh', 'pre-tool-use-skill.sh', 'session-start-worktree-setup.sh', 'session-start.sh', 'user-prompt-submit-title.sh', 'user-prompt-submit.sh']],
  [COPILOT_HOOKS, ['pre-tool-use-bash.sh', 'pre-tool-use-skill.sh', 'session-start-worktree-setup.sh', 'session-start.sh', 'user-prompt-submit.sh']],
])
const CONFIG_KEYS = [
  'claude-bash-guards',
  'exit-plan-remind',
  'gh-issue-create-check',
  'gh-pr-create-check',
  'gh-stack-check',
  'git-no-verify-check',
  'git-sync',
  'git-worktree-branch-check',
  'reviewer-clone-allow',
  'session-start-common',
  'session-title',
  'tmp-path-warner',
  'worktree-setup',
]

describe('残すフックの一覧', () => {
  it.for([...REGISTERED_SCRIPTS].map(([name, scripts]) => ({ name, scripts })))('$name に登録したスクリプトは、一覧と同じ集合になる', (row) => {
    const files = new Set(allHooks(load(WORKFLOW, row.name)).map(({ hook }) => fileOf(hook)))
    expect([...files].toSorted(compareStrings)).toEqual(row.scripts)
  })

  it('sample の設定キーは、一覧と同じ集合になる', () => {
    const text = readFileSync(path.join(pluginsDirectory, WORKFLOW, 'hooks', 'hooks-config.json.sample'), 'utf8')
    const sample = toRecord(parseJson(text), 'sample')
    expect(Object.keys(sample).toSorted(compareStrings)).toEqual(CONFIG_KEYS)
  })

  it('Copilot 定義の Bash の PreToolUse は、Claude と同じエントリを指す', () => {
    expect(matchersOf(load(WORKFLOW, COPILOT_HOOKS), 'pre-tool-use-bash.sh')).toEqual(['Bash'])
  })
})

// MCP ツールの呼び出しにはフックを付けない（spec 025 FR-001〜FR-008）。
describe('MCP の PreToolUse', () => {
  it.for([
    { label: 'Claude Code', file: 'hooks.json' },
    { label: 'Copilot CLI', file: COPILOT_HOOKS },
  ])('$label の pecot-workflow の定義に、MCP ツールに当たる PreToolUse のエントリが無い', (row) => {
    const matchers = entriesOf(load(WORKFLOW, row.file), 'PreToolUse').map(entry => entry.matcher ?? '')
    expect(matchers.filter(matcher => /mcp__|create_pull_request|pecot-workflow-/u.test(matcher))).toEqual([])
    expect(matchersOf(load(WORKFLOW, row.file), 'pre-tool-use-mcp.sh')).toEqual([])
  })
})
