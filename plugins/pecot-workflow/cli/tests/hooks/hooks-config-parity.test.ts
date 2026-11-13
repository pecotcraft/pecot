/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下の設定のみ */
// hooks.json と com.github.copilot/hooks/hooks.json の plan 系エントリが同じ構成であることの確認。
// plan 系エントリは PostToolUse の ExitPlanMode の 1 本だけ。配列順に依存せず比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { toArray, toRecord } from './_helpers/json.js'
import { hooksDirectory } from './_helpers/paths.js'
import { parseJson } from './_helpers/text.js'

const PLAN_TOKENS: ReadonlySet<string> = new Set(['EnterPlanMode', 'ExitPlanMode', 'exit_plan_mode'])
const PLAN_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse']

interface PlanEntry {
  readonly command: string
  readonly timeout: unknown
  readonly tokens: ReadonlySet<string>
}

function isPlanOnly(tokens: ReadonlySet<string>): boolean {
  for (const token of tokens) if (!PLAN_TOKENS.has(token)) return false
  return true
}

// plan 系エントリを、イベントから {command, timeout, matcher のトークン集合} への写像にする。
// matcher は `|` で分けたトークンがすべて plan 系の名前のエントリだけを対象にする（Edit|Write|…|EnterPlanMode の複合 matcher は除く）。
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
      const tokens = new Set(matcher.split('|'))
      if (!isPlanOnly(tokens)) continue
      const hooks = toArray(record['hooks'], 'エントリの hooks')
      expect(hooks, `${event}/${matcher} に複数コマンド`).toHaveLength(1)
      const hook = toRecord(hooks[0], 'hook')
      const command = hook['command']
      if (typeof command !== 'string') throw new TypeError('command が文字列ではありません')
      // 同じイベントの重複が後勝ちで隠れるのを防ぐ。
      expect(result.has(event), `重複エントリ: ${event}`).toBe(false)
      result.set(event, { command, timeout: hook['timeout'], tokens })
    }
  }
  return result
}

describe('hooks 設定の plan 系エントリ', () => {
  const claude = planEntryMap('hooks.json')
  const copilot = planEntryMap('../com.github.copilot/hooks/hooks.json')

  it('hooks.json と com.github.copilot/hooks/hooks.json の両方に、PostToolUse の ExitPlanMode だけがある', () => {
    expect(new Set(claude.keys())).toEqual(new Set(['PostToolUse']))
    expect(new Set(copilot.keys())).toEqual(new Set(['PostToolUse']))
    expect(claude.get('PostToolUse')?.tokens).toEqual(new Set(['ExitPlanMode']))
  })

  it('command と timeout が同じで、Copilot の matcher は Claude の名前に exit_plan_mode を足した集合になる', () => {
    const claudeEntry = claude.get('PostToolUse')
    const copilotEntry = copilot.get('PostToolUse')
    expect(copilotEntry?.command).toBe(claudeEntry?.command)
    expect(copilotEntry?.timeout).toBe(claudeEntry?.timeout)
    expect(copilotEntry?.tokens).toEqual(new Set([...(claudeEntry?.tokens ?? []), 'exit_plan_mode']))
  })
})
