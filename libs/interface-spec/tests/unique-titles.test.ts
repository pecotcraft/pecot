import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { duplicateTitles } from '../src/vitest/unique-titles.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'unique-titles')
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')

interface Node {
  type: string
  name: string
  tasks?: readonly Node[]
}

function test(name: string): Node {
  return { type: 'test', name }
}

function suite(name: string, tasks: readonly Node[]): Node {
  return { type: 'suite', name, tasks }
}

function runFixture(file: string) {
  return spawnSync(process.execPath, [VITEST, 'run', '--config', path.join(FIXTURES, 'vitest.config.mjs'), file], {
    cwd: FIXTURES,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
  })
}

describe('duplicateTitles', () => {
  it('入れ子の describe の題を > でつないだ名前が重なると、その名前を 1 つ返す', () => {
    const file = { tasks: [suite('読む', [suite('表', [test('a'), test('b'), test('a'), test('a')])])] }
    expect(duplicateTitles(file)).toEqual(['読む > 表 > a'])
  })

  it('別の describe にある同じ題は、重なりとしない', () => {
    const file = { tasks: [suite('読む', [test('a')]), suite('書く', [test('a')]), test('a')] }
    expect(duplicateTitles(file)).toEqual([])
  })

  it('いちばん外の題が重なると、その題を返す', () => {
    expect(duplicateTitles({ tasks: [test('a'), test('a')] })).toEqual(['a'])
  })
})

describe('setupFiles', () => {
  it('同じ題のケースが重なるファイルは失敗し、重なった名前を出す', () => {
    const result = runFixture('duplicated.fixture.ts')
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('同じ題のテストが重なる')
    expect(result.stdout + result.stderr).toContain('読む > a を読む')
  })

  it('題が重ならないファイルは通る', () => {
    const result = runFixture('unique.fixture.ts')
    expect(result.stdout + result.stderr).not.toContain('同じ題のテストが重なる')
    expect(result.status).toBe(0)
  })
})
