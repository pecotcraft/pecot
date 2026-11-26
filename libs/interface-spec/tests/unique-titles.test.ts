import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachOutput } from '../src/vitest/attach.js'
import { duplicateTitles } from '../src/vitest/unique-titles.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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
  const result = spawnSync(process.execPath, [VITEST, 'run', '--config', path.join(FIXTURES, 'vitest.config.mjs'), file], {
    cwd: FIXTURES,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
  })
  attachOutput(`vitest run ${file}`, result.status ?? undefined, result.stdout, result.stderr)
  return result
}

describe('duplicateTitles', () => {
  it('入れ子の describe の題を > でつないだ名前が重なると、その名前を 1 つ返す', async () => {
    await explains('テストの題の重なりを探す `duplicateTitles` のテストです。入れ子の `describe` の題を `>` でつないだ名前が 3 回重なる場合に、その名前を 1 つだけ返すことを確認します。')
    const file = { tasks: [suite('読む', [suite('表', [test('a'), test('b'), test('a'), test('a')])])] }
    stepSync('重なる題を求めて比べる', () => {
      expect(duplicateTitles(file)).toEqual(['読む > 表 > a'])
    })
  })

  it('別の describe にある同じ題は、重なりとしない', async () => {
    await explains('テストの題の重なりを探す `duplicateTitles` のテストです。別の `describe` の中に同じ題の `it` がある場合に、重なりとして扱わず、空の配列を返すことを確認します。')
    const file = { tasks: [suite('読む', [test('a')]), suite('書く', [test('a')]), test('a')] }
    stepSync('重なる題を求めて比べる', () => {
      expect(duplicateTitles(file)).toEqual([])
    })
  })

  it('いちばん外の題が重なると、その題を返す', async () => {
    await explains('テストの題の重なりを探す `duplicateTitles` のテストです。いちばん外に同じ題の `it` が 2 つある場合に、その題を返すことを確認します。')
    stepSync('重なる題を求めて比べる', () => {
      expect(duplicateTitles({ tasks: [test('a'), test('a')] })).toEqual(['a'])
    })
  })
})

describe('setupFiles', () => {
  it('同じ題のテストが重なるファイルを実行すると、失敗して重なった名前を出力する', async () => {
    await explains('vitest の setupFiles が題の重なりを止める仕組みのテストです。同じ題のテストを含むファイルを実行した場合に、終了コード 1 で失敗し、`同じ題のテストが重なる` と重なった名前を出力することを確認します。')
    const result = stepSync('fixture を動かす', () => runFixture('duplicated.fixture.ts'))
    stepSync('結果を比べる', () => {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain('同じ題のテストが重なる')
      expect(result.stdout + result.stderr).toContain('読む > a を読む')
    })
  })

  it('題が重ならないファイルを実行すると、成功する', async () => {
    await explains('vitest の setupFiles が題の重なりを止める仕組みのテストです。題が重ならないファイルを実行した場合に、終了コード 0 で成功し、重なりを示す文言が出力されないことを確認します。')
    const result = stepSync('fixture を動かす', () => runFixture('unique.fixture.ts'))
    stepSync('結果を比べる', () => {
      expect(result.stdout + result.stderr).not.toContain('同じ題のテストが重なる')
      expect(result.status).toBe(0)
    })
  })
})
