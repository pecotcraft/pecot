/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下の設定のみ */
// hooks.json と com.github.copilot/hooks/hooks.json の plan 系エントリが同じ構成であることの確認。
// plan 系エントリは PostToolUse の ExitPlanMode の 1 本だけ。配列順に依存せず比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { toArray, toRecord } from './_helpers/json.js'
import { hooksDirectory } from './_helpers/paths.js'
import { parseJson } from './_helpers/text.js'

const PLAN_MATCHERS: ReadonlySet<string> = new Set(['EnterPlanMode', 'ExitPlanMode'])
const PLAN_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse']

// plan 系エントリを、キー（イベントと matcher）から command への写像にする。
function planEntryMap(configName: string): Map<string, string> {
  const parsed = parseJson(readFileSync(path.join(hooksDirectory, configName), 'utf8'))
  const data = toRecord(parsed, configName)
  const events = toRecord(data['hooks'], 'hooks')
  const result = new Map<string, string>()
  for (const event of PLAN_EVENTS) {
    const entries = toArray(Reflect.get(events, event) ?? [], event)
    for (const entry of entries) {
      const record = toRecord(entry, 'エントリ')
      const matcher = record['matcher']
      if (typeof matcher !== 'string' || !PLAN_MATCHERS.has(matcher)) continue
      const hooks = toArray(record['hooks'], 'エントリの hooks')
      const commands = hooks.map(hook => toRecord(hook, 'hook')['command'])
      expect(commands, `${event}/${matcher} に複数コマンド`).toHaveLength(1)
      const key = `${event}/${matcher}`
      // 同じ (event, matcher) の重複が後勝ちで隠れるのを防ぐ。
      expect(result.has(key), `重複エントリ: ${key}`).toBe(false)
      const command = commands[0]
      if (typeof command !== 'string') throw new TypeError('command が文字列ではありません')
      result.set(key, command)
    }
  }
  return result
}

describe('hooks 設定の plan 系エントリ', () => {
  it('hooks.json と com.github.copilot/hooks/hooks.json の両方に、PostToolUse の ExitPlanMode だけがある', () => {
    const expectedKeys = new Set(['PostToolUse/ExitPlanMode'])
    expect(new Set(planEntryMap('hooks.json').keys())).toEqual(expectedKeys)
    expect(new Set(planEntryMap('../com.github.copilot/hooks/hooks.json').keys())).toEqual(expectedKeys)
  })

  it('hooks.json と com.github.copilot/hooks/hooks.json で、配列順が違っても同じ写像になる', () => {
    expect(planEntryMap('hooks.json')).toEqual(planEntryMap('../com.github.copilot/hooks/hooks.json'))
  })
})
