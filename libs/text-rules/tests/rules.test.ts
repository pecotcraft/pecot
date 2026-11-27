import { createRequire } from 'node:module'
import { moduleInterop } from '@textlint/module-interop'
import { describe, expect, it } from 'vitest'
import { buildRules, EXCLUDED_RULE_IDS, PRESET_NAMES } from '../index.js'
import { stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

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
  it('3 つの preset の rules と rulesConfig は、同じ規則の ID を持つ', async () => {
    await explains('textlint の preset が持つ規則の定義を検証するテストです。3 つの preset のすべてで、`rules` と `rulesConfig` のキーの集合が一致することを確認します。')
    stepSync('preset ごとの rules と rulesConfig のキー集合を比べる', () => {
      for (const name of PRESET_NAMES) {
        expect(new Set(keysOf(name, 'rulesConfig'))).toEqual(new Set(keysOf(name, 'rules')))
      }
    })
  })

  it('buildRules は、3 つの preset の規則を、除外した規則と未設定の規則を除いてすべて返す', async () => {
    await explains('規則の一覧を作成する `buildRules` のテストです。3 つの preset の規則のうち、除外した規則と `rulesConfig` にない規則を除いたものが、すべて返ることを確認します。')
    const expected = PRESET_NAMES.flatMap((name) => {
      const configured = new Set(keysOf(name, 'rulesConfig'))
      return ruleIdsOf(name).filter(ruleId => configured.has(ruleId) && !EXCLUDED_RULE_IDS.has(ruleId))
    })
    stepSync('規則の一覧を作って期待と比べる', () => {
      expect(new Set(buildRules().map(rule => rule.ruleId))).toEqual(new Set(expected))
    })
  })

  it('除外する規則の ID は、いずれかの preset に存在し、buildRules の結果に含まれない', async () => {
    await explains('規則の一覧を作成する `buildRules` のテストです。`EXCLUDED_RULE_IDS` の各 ID が、いずれかの preset に存在し、返された一覧には含まれないことを確認します。')
    const all = new Set(PRESET_NAMES.flatMap(name => ruleIdsOf(name)))
    const ids = stepSync('規則の一覧を作る', () => buildRules().map(rule => rule.ruleId))
    stepSync('除外した規則 ID を比べる', () => {
      for (const excluded of EXCLUDED_RULE_IDS) {
        expect(all.has(excluded)).toBe(true)
        expect(ids).not.toContain(excluded)
      }
    })
  })
})
