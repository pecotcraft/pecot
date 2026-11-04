import { createRequire } from 'node:module'
import { moduleInterop } from '@textlint/module-interop'
import { describe, expect, it } from 'vitest'
import { buildRules, EXCLUDED_RULE_IDS, PRESET_NAMES } from '../index.js'

const load = createRequire(import.meta.url)

function keysOf(name: string, field: 'rules' | 'rulesConfig'): string[] {
  const preset: unknown = moduleInterop(load(name))
  if (typeof preset !== 'object' || preset === null) {
    throw new TypeError(`${name} は preset ではありません`)
  }
  const value: unknown = Reflect.get(preset, field)
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${name} の ${field} がオブジェクトではありません`)
  }
  return Object.keys(value)
}

function ruleIdsOf(name: string): string[] {
  return keysOf(name, 'rules')
}

describe('buildRules', () => {
  it('3 preset とも rules と rulesConfig のキー集合が一致する', () => {
    for (const name of PRESET_NAMES) {
      expect(new Set(keysOf(name, 'rulesConfig'))).toEqual(new Set(keysOf(name, 'rules')))
    }
  })

  it('全 preset の規則 ID を、除外と rulesConfig に無いものを除いて落とさない', () => {
    const expected = PRESET_NAMES.flatMap((name) => {
      const configured = new Set(keysOf(name, 'rulesConfig'))
      return ruleIdsOf(name).filter(ruleId => configured.has(ruleId) && !EXCLUDED_RULE_IDS.has(ruleId))
    })
    expect(new Set(buildRules().map(rule => rule.ruleId))).toEqual(new Set(expected))
  })

  it('除外の規則 ID はいずれかの preset に実在し、結果に含まれない', () => {
    const all = new Set(PRESET_NAMES.flatMap(name => ruleIdsOf(name)))
    const ids = buildRules().map(rule => rule.ruleId)
    for (const excluded of EXCLUDED_RULE_IDS) {
      expect(all.has(excluded)).toBe(true)
      expect(ids).not.toContain(excluded)
    }
  })
})
