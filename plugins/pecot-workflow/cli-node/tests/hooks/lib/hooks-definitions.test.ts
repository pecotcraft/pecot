/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはプラグインのリポジトリ内のファイルのみ */
// hooks 定義 4 本の timeout・matcher・イベントの構成と、command が指すファイルの実在を固定する。
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isFile } from '../_helpers/files.js'
import { toArray, toRecord } from '../_helpers/json.js'
import { projectRoot } from '../_helpers/paths.js'
import { parseJson } from '../_helpers/text.js'

const WORKFLOW = 'pecot-workflow'
const VISUAL = 'pecot-visual'

const COPILOT_VISUAL = 'com.github.copilot/hooks/hooks.json'

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
  definition(WORKFLOW, 'hooks-copilot.json'),
  definition(VISUAL, 'hooks.json'),
  definition(VISUAL, COPILOT_VISUAL),
]
const CLAUDE_DEFINITIONS = [definition(WORKFLOW, 'hooks.json'), definition(VISUAL, 'hooks.json')]
const COPILOT_DEFINITIONS = [definition(WORKFLOW, 'hooks-copilot.json'), definition(VISUAL, COPILOT_VISUAL)]

const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode'
const NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt|elicitation_dialog'
const QUOTED_COMMAND = /^"\$\{CLAUDE_PLUGIN_ROOT\}"\/hooks\/(?<file>[\w.-]+\.sh)$/u
// ファイル名の抽出用。クォートの有無は問わない。
const FILE = /\/hooks\/(?<file>[\w.-]+\.sh)$/u
const PASCAL_CASE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'])

const pluginsDirectory = path.join(projectRoot, 'plugins')

interface Hook {
  readonly type: unknown
  readonly command: string
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
  if (typeof record['command'] !== 'string') throw new TypeError('command が文字列ではありません')
  return { type: record['type'], command: record['command'], hasTimeout: 'timeout' in record, timeout: record['timeout'] }
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
  const found = FILE.exec(hook.command)?.groups?.['file']
  if (found === undefined) throw new Error(`command が hooks/<file>.sh を指していない: ${hook.command}`)
  return found
}

// 期待の timeout の表。キーは `プラグイン|イベント|matcher`（matcher 無しは空）。
const EXPECTED_TIMEOUTS = new Map([
  ['pecot-workflow|SessionStart|', 120],
  ['pecot-workflow|PreToolUse|', 10],
  ['pecot-workflow|PostToolUse|Bash', 30],
  ['pecot-workflow|PostToolUse|Skill', 10],
  ['pecot-workflow|PostToolUse|Skill|skill', 10],
  ['pecot-workflow|PostToolUse|EnterPlanMode', 10],
  ['pecot-workflow|PostToolUse|ExitPlanMode', 90],
  ['pecot-workflow|Stop|', 10],
  ['pecot-workflow|UserPromptSubmit|', 10],
  ['pecot-workflow|Notification|', 10],
  ['pecot-visual|SessionStart|', 120],
  ['pecot-visual|UserPromptSubmit|', 10],
  ['pecot-visual|PreToolUse|', 10],
  ['pecot-visual|PostToolUse|Write', 80],
  ['pecot-visual|PostToolUse|Edit', 80],
])

function expectedTimeout(plugin: string, event: string, matcher: string | undefined): number {
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
      expect(hook.hasTimeout, `timeout が無い: ${event} ${String(matcher)} ${hook.command}`).toBe(true)
      expect(hook.timeout, `${event} ${String(matcher)} ${hook.command}`).toBe(expectedTimeout(row.plugin, event, matcher))
    }
    expect(seen).toBeGreaterThan(0)
  })

  it.for(DEFINITIONS)('$label の command は、プラグインルートの変数をクォートする', (row) => {
    const flat = allHooks(load(row.plugin, row.name))
    for (const { event, matcher, hook } of flat) {
      expect(hook.type).toBe('command')
      expect(hook.command, `${event} ${String(matcher)}: "\${CLAUDE_PLUGIN_ROOT}"/hooks/<file> の形にする`).toMatch(QUOTED_COMMAND)
    }
  })

  it.for(DEFINITIONS)('$label の command が指すファイルは、実在し実行できる', (row) => {
    const flat = allHooks(load(row.plugin, row.name))
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

// PreToolUse の matcher（pecot-workflow）。
describe('PreToolUse の matcher', () => {
  it.for([
    { label: 'Claude', plugin: WORKFLOW, name: 'hooks.json' },
    { label: 'Copilot', plugin: WORKFLOW, name: 'hooks-copilot.json' },
  ])('$label の編集系エントリの matcher は、絞り込まれている', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'PreToolUse').filter(entry => entry.hooks.some(hook => fileOf(hook) === 'pre-tool-use.sh'))
    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.matcher).toBe(EDIT_MATCHER)
  })
})

// SessionStart
describe('SessionStart', () => {
  it.for(CLAUDE_DEFINITIONS)('$label の Claude 定義は、pull の SessionStart を 1 エントリにまとめる', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'SessionStart')
    expect(entries).toHaveLength(1)
    const expected = row.plugin === WORKFLOW ? 'startup|clear|resume|fork' : 'startup|clear|resume'
    expect(entries.at(0)?.matcher).toBe(expected)
    expect(entries.at(0)?.hooks).toHaveLength(1)
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

  // sessionTitle は Claude Code 専用の出力項目なので、hooks-copilot.json には載せない。
  it('セッション名のエントリは、Claude の定義にだけ置く', () => {
    const claude = entriesOf(load(WORKFLOW, 'hooks.json'), 'UserPromptSubmit').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(claude).toEqual(['user-prompt-submit.sh', 'user-prompt-submit-title.sh'])
    const copilot = entriesOf(load(WORKFLOW, 'hooks-copilot.json'), 'UserPromptSubmit').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(copilot).not.toContain('user-prompt-submit-title.sh')
  })

  it.for(COPILOT_DEFINITIONS)('$label の Copilot 定義は、matcher の無い SessionStart を 1 エントリだけ持つ', (row) => {
    const entries = entriesOf(load(row.plugin, row.name), 'SessionStart')
    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.hasMatcher).toBe(false)
    expect(entries.at(0)?.hooks).toHaveLength(1)
  })
})

// Stop / Notification（pecot-workflow）
describe('Stop と Notification', () => {
  it('Claude の Notification は matcher を絞り、Stop は stop.sh だけを呼ぶ', () => {
    const hooks = load(WORKFLOW, 'hooks.json')
    const notification = entriesOf(hooks, 'Notification')
    expect(notification).toHaveLength(1)
    expect(notification.at(0)?.matcher).toBe(NOTIFICATION_MATCHER)
    const stopFiles = entriesOf(hooks, 'Stop').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(stopFiles).toEqual(['stop.sh'])
  })

  it('Copilot の Stop は、Copilot 用のエントリを指す', () => {
    const stopFiles = entriesOf(load(WORKFLOW, 'hooks-copilot.json'), 'Stop').flatMap(entry => entry.hooks.map(hook => fileOf(hook)))
    expect(stopFiles).toEqual(['stop-copilot.sh'])
  })
})

// Copilot CLI の matcher は全体一致 `^(?:PATTERN)$` で、skill と MCP に Claude の名前が無い。
function matchersOf(hooks: Hooks, event: string, entryFile: string): (string | undefined)[] {
  return entriesOf(hooks, event).filter(entry => entry.hooks.some(hook => fileOf(hook) === entryFile)).map(entry => entry.matcher)
}

describe('Copilot CLI の matcher', () => {
  it.for([
    { label: 'PreToolUse', event: 'PreToolUse', entry: 'pre-tool-use-skill.sh' },
    { label: 'PostToolUse', event: 'PostToolUse', entry: 'post-tool-use-skill.sh' },
  ])('pecot-workflow の $label の skill の matcher は、生の tool 名を含む', (row) => {
    expect(matchersOf(load(WORKFLOW, 'hooks-copilot.json'), row.event, row.entry)).toEqual(['Skill|skill'])
  })

  it('pecot-workflow の MCP の matcher は、GitHub MCP の PR 作成を含む', () => {
    const matchers = matchersOf(load(WORKFLOW, 'hooks-copilot.json'), 'PreToolUse', 'pre-tool-use-mcp.sh')
    expect(matchers).toEqual(['mcp__.*|github-mcp-server-create_pull_request'])
  })

  it('pecot-visual の skill の matcher は、生の tool 名を含む', () => {
    const matchers = matchersOf(load(VISUAL, COPILOT_VISUAL), 'PreToolUse', 'pre-tool-use-skill.sh')
    expect(matchers).toEqual(['Skill|skill'])
  })

  it('Claude の skill と MCP の matcher は、変えない', () => {
    const workflow = load(WORKFLOW, 'hooks.json')
    expect(matchersOf(workflow, 'PreToolUse', 'pre-tool-use-skill.sh')).toEqual(['Skill'])
    expect(matchersOf(workflow, 'PreToolUse', 'pre-tool-use-mcp.sh')).toEqual(['mcp__.*'])
    expect(matchersOf(load(VISUAL, 'hooks.json'), 'PreToolUse', 'pre-tool-use-skill.sh')).toEqual(['Skill'])
  })
})
