// vitest 5 は coverage.include が実在ファイルに当たらないと、閾値を判定せずに成功する。
// include の空振りで、行カバレッジの閾値が判定されないまま通るのを、ここで止める。
import { globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import config from '../vitest.config.js'
import { readBaseline } from './parity/baseline.js'

const cliRoot = path.resolve(import.meta.dirname, '..')

describe('coverage', () => {
  const coverage = config.test?.coverage

  it('include の各パターンが、tests 以外の実在ファイルに当たる', () => {
    const include = coverage?.include ?? []
    expect(include.length).toBeGreaterThan(0)
    const unmatched = include.filter(
      // 当たるファイルが 0 件の場合も、every は真になり unmatched に入る。
      pattern => globSync(pattern, { cwd: cliRoot }).every(file => file.includes('/tests/')),
    )
    expect(unmatched).toEqual([])
  })

  it('lines の閾値は baseline の行カバレッジと 90 の大きいほう', () => {
    expect(coverage?.thresholds?.lines).toBe(Math.max(readBaseline().cli.lineCoverage, 90))
  })
})
