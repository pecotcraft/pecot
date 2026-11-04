import { describe, expect, it } from 'vitest'

import { compareStrings, readBaseline } from './baseline.js'

describe('baseline.json', () => {
  it('キーが measuredAt / commit / cli / hooks だけで、各階層のキーも揃っている', () => {
    // 余分なキー・欠けたキー・型違いは readBaseline が TypeError で止める。
    expect(() => readBaseline()).not.toThrow()
    expect(Object.keys(readBaseline()).toSorted(compareStrings)).toEqual(['cli', 'commit', 'hooks', 'measuredAt'])
  })

  it('commit は 40 桁の SHA で、measuredAt は ISO 8601 の UTC', () => {
    const baseline = readBaseline()
    expect(baseline.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('行カバレッジは 0 超 100 以下で、hooks のテスト件数は正の整数', () => {
    const baseline = readBaseline()
    expect(baseline.cli.lineCoverage).toBeGreaterThan(0)
    expect(baseline.cli.lineCoverage).toBeLessThanOrEqual(100)
    expect(Number.isSafeInteger(baseline.hooks.testCount)).toBe(true)
    expect(baseline.hooks.testCount).toBeGreaterThan(0)
  })

  it('hooks.scripts は hooks/ 配下の .sh で、重複なく昇順に並ぶ', () => {
    const { scripts } = readBaseline().hooks
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(script).toMatch(/^hooks\/.+\.sh$/)
    expect(scripts).toEqual([...new Set(scripts)].toSorted(compareStrings))
  })
})
