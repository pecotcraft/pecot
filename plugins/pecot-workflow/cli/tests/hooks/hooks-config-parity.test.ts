/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下の設定のみ */
// hooks.json と com.github.copilot/hooks/hooks.json の plan 系エントリが同じ構成であることの確認。
// matcher の文字列そのものの固定は lib/hooks-definitions.test.ts に任せる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { toArray, toRecord } from './_helpers/json.js'
import { hooksDirectory } from './_helpers/paths.js'
import { parseJson } from './_helpers/text.js'

const PLAN_TOKENS: ReadonlySet<string> = new Set(['EnterPlanMode', 'ExitPlanMode', 'exit_plan_mode'])
const PLAN_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse']
// plan 系のトークンを含むが、plan 専用ではない既知の複合 matcher。
const MIXED_MATCHER_ALLOWLIST: ReadonlySet<string> = new Set([
  'PreToolUse\tEdit|Write|MultiEdit|NotebookEdit|EnterPlanMode',
])
// Copilot 側だけが足す名前。Claude の名前を同じにするため、キーから除く。
const COPILOT_ONLY_TOKEN = 'exit_plan_mode'

interface PlanEntry {
  readonly command: string
  readonly timeout: unknown
}

// plan 系エントリを、「イベントと Claude の名前」のキーから {command, timeout} への写像にする。
function planEntryMap(configName: string): Map<string, PlanEntry> {
  const parsed = parseJson(readFileSync(path.join(hooksDirectory, configName), 'utf8'))
  const data = toRecord(parsed, configName)
  const events = toRecord(data['hooks'], 'hooks')
  const result = new Map<string, PlanEntry>()
  for (const event of PLAN_EVENTS) {
    const entries = toArray(Reflect.get(events, event) ?? [], event)
    for (const entry of entries) {
      const record = toRecord(entry, 'エントリ')
      const matcher = record['matcher']
      if (typeof matcher !== 'string') continue
      const tokens = matcher.split('|')
      if (tokens.every(token => !PLAN_TOKENS.has(token)) || MIXED_MATCHER_ALLOWLIST.has(`${event}\t${matcher}`)) continue
      const foreign = tokens.filter(token => !PLAN_TOKENS.has(token))
      expect(foreign, `${configName} の ${event}/${matcher} に plan 系でない名前が含まれています`).toEqual([])
      const hooks = toArray(record['hooks'], 'エントリの hooks')
      expect(hooks, `${event}/${matcher} に複数コマンド`).toHaveLength(1)
      const hook = toRecord(hooks[0], 'hook')
      const command = hook['command']
      if (typeof command !== 'string') throw new TypeError('command が文字列ではありません')
      const key = `${event}\t${tokens.filter(token => token !== COPILOT_ONLY_TOKEN).toSorted((a, b) => a.localeCompare(b)).join('|')}`
      // 同じキーの重複が後勝ちで隠れるのを防ぐ。
      expect(result.has(key), `重複エントリ: ${event}/${matcher}`).toBe(false)
      result.set(key, { command, timeout: hook['timeout'] })
    }
  }
  return result
}

describe('hooks 設定の plan 系エントリ', () => {
  const claude = planEntryMap('hooks.json')
  const copilot = planEntryMap('../com.github.copilot/hooks/hooks.json')

  it('2 つの定義で、イベントと Claude の名前のキーの集合が同じになる', () => {
    expect(claude.size).toBeGreaterThan(0)
    expect(new Set(copilot.keys())).toEqual(new Set(claude.keys()))
  })

  it('同じキーの command と timeout が 2 つの定義で同じになる', () => {
    for (const [key, claudeEntry] of claude) {
      const copilotEntry = copilot.get(key)
      if (copilotEntry === undefined) throw new Error(`Copilot にキーがありません: ${key}`)
      expect(copilotEntry).toEqual(claudeEntry)
    }
  })
})
