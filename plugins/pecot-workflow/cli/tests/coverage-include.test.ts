// vitest 5 は coverage.include が実在ファイルに当たらないと、閾値を判定せずに成功する。
// include の空振りで、行カバレッジの閾値が判定されないまま通るのを、ここで止める。
import { globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'
import config from '../vitest.config.js'
import { readBaseline } from './parity/baseline.js'

const cliRoot = path.resolve(import.meta.dirname, '..')

describe('coverage', () => {
  const coverage = config.test?.coverage

  it('include の各パターンが、tests 以外の実在ファイルに当たる', async () => {
    await explains('vitest のカバレッジの設定のテストです。`include` の各パターンが、`tests` 以外の実在するファイルに当たることを確認します。')
    const unmatched = stepSync('当たるファイルが無いパターンを集める', () => {
      const include = coverage?.include ?? []
      return {
        count: include.length,
        unmatched: include.filter(
          // 当たるファイルが 0 件の場合も、every は真になり unmatched に入る。
          pattern => globSync(pattern, { cwd: cliRoot }).every(file => file.includes('/tests/')),
        ),
      }
    })
    stepSync('パターンの数と当たらないパターンを比べる', () => {
      expect(unmatched.count).toBeGreaterThan(0)
      expect(unmatched.unmatched).toEqual([])
    })
  })

  it('cli project の include が、tests/mcp/ の実在するテストに当たる', async () => {
    await explains('vitest のカバレッジの設定のテストです。`cli` project の `include` が、`tests/mcp/` の実在するテストのファイルに当たることを確認します。')
    const matched = stepSync('cli project の include に当たる tests/mcp/ のファイルを集める', () => {
      const project = config.test?.projects?.find(entry => typeof entry === 'object' && 'test' in entry && entry.test.name === 'cli')
      const include = typeof project === 'object' && 'test' in project ? project.test.include ?? [] : []
      return include.flatMap(pattern => globSync(pattern, { cwd: cliRoot })).filter(file => file.startsWith('tests/mcp/'))
    })
    stepSync('当たったファイルを比べる', () => {
      expect(matched).toContain('tests/mcp/tools-list.test.ts')
      expect(matched).toContain('tests/mcp/resources.test.ts')
    })
  })

  it('skills project の include が、tests/skills/ の実在するテストに当たる', async () => {
    await explains('vitest のカバレッジの設定のテストです。`skills` project の `include` が、`tests/skills/` の実在するテストのファイルに当たることを確認します。')
    const matched = stepSync('skills project の include に当たるファイルを集める', () => {
      const project = config.test?.projects?.find(entry => typeof entry === 'object' && 'test' in entry && entry.test.name === 'skills')
      const include = typeof project === 'object' && 'test' in project ? project.test.include ?? [] : []
      return include.flatMap(pattern => globSync(pattern, { cwd: cliRoot }))
    })
    stepSync('当たったファイルを比べる', () => {
      expect(matched).toContain('tests/skills/tool-names.test.ts')
      expect(matched).toContain('tests/skills/skill-scripts.test.ts')
    })
  })

  it('lines の閾値は baseline の行カバレッジと 90 の大きいほう', async () => {
    await explains('vitest のカバレッジの設定のテストです。行カバレッジの閾値が、`baseline` の行カバレッジと 90 のうち大きいほうの値になっていることを確認します。')
    const baseline = stepSync('baseline の行カバレッジを読む', () => readBaseline().cli.lineCoverage)
    stepSync('lines の閾値を比べる', () => {
      expect(coverage?.thresholds?.lines).toBe(Math.max(baseline, 90))
    })
  })
})
