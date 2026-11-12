/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// scripts/compare-junit.ts が、2 つの JUnit を (classname, name) ごとの結果で比べることを確かめる。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareJunit, main, parseJunit } from '../scripts/compare-junit.js'
import { makeTemporaryDirectory } from '../src/tests/_helpers/temporary.js'

function suite(body: string): string {
  return `<?xml version="1.0"?>\n<testsuites>\n<testsuite name="a.test.ts">\n${body}\n</testsuite>\n</testsuites>\n`
}

const PASSED = '<testcase classname="a.test.ts" name="通る" time="0.1">\n</testcase>'
const SELF_CLOSING = '<testcase classname="a.test.ts" name="自己閉じ" time="0.1" />'
const FAILED = '<testcase classname="a.test.ts" name="落ちる &gt; 入れ子" time="0.1">\n<failure message="x" type="AssertionError">&lt;failure&gt;</failure>\n</testcase>'
const ERRORED = '<testcase classname="a.test.ts" name="落ちる" time="0.1"><error message="x"/></testcase>'
const SKIPPED = '<testcase classname="a.test.ts" name="飛ばす" time="0"><skipped/></testcase>'

function files(first: string, second: string): readonly [string, string] {
  const directory = makeTemporaryDirectory()
  const firstPath = path.join(directory, 'one.xml')
  const secondPath = path.join(directory, 'two.xml')
  writeFileSync(firstPath, first)
  writeFileSync(secondPath, second)
  return [firstPath, secondPath]
}

function run(argv: readonly string[]): { readonly code: number, readonly stderr: string } {
  let stderr = ''
  const code = main(argv, {
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stderr }
}

describe('parseJunit', () => {
  it('子の要素から 4 つの結果を読み、属性の escape を戻す', () => {
    const cases = parseJunit(suite([PASSED, SELF_CLOSING, FAILED, ERRORED, SKIPPED].join('\n')))
    expect(Object.fromEntries(cases)).toEqual({
      'a.test.ts::通る': 'passed',
      'a.test.ts::自己閉じ': 'passed',
      'a.test.ts::落ちる > 入れ子': 'failed',
      'a.test.ts::落ちる': 'error',
      'a.test.ts::飛ばす': 'skipped',
    })
  })

  it('CDATA の中の要素の文字は、結果に影響しない', () => {
    const cases = parseJunit(suite('<testcase classname="c" name="n"><system-out><![CDATA[<failure>]]></system-out></testcase>'))
    expect(cases.get('c::n')).toBe('passed')
  })
})

describe('compareJunit', () => {
  it('同じ結果なら差が無い', () => {
    const cases = parseJunit(suite(`${PASSED}\n${FAILED}`))
    expect(compareJunit(cases, cases)).toEqual({ onlyFirst: [], onlySecond: [], changed: [] })
  })

  it('片方にだけあるケースと、結果の違うケースを分けて返す', () => {
    const first = parseJunit(suite(`${PASSED}\n${FAILED}`))
    const second = parseJunit(suite(`${PASSED}\n${SKIPPED}\n${FAILED.replace('<failure', '<skipped').replace('</failure>', '</skipped>')}`))
    expect(compareJunit(first, second)).toEqual({
      onlyFirst: [],
      onlySecond: ['a.test.ts::飛ばす'],
      changed: ['a.test.ts::落ちる > 入れ子'],
    })
  })
})

describe('main', () => {
  it('一致すれば 0 を返し、何も出さない', () => {
    const [one, two] = files(suite(PASSED), suite(PASSED))
    expect(run([one, two])).toEqual({ code: 0, stderr: '' })
  })

  it('結果の差は 1 を返し、2 回の結果を並べて出す', () => {
    const [one, two] = files(suite(PASSED), suite(PASSED.replace('</testcase>', '<failure/></testcase>')))
    const result = run([one, two])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('結果が違うケース:\n  a.test.ts::通る  1 回目=passed  2 回目=failed\n')
  })

  it('片方にだけあるケースは、どちらのファイルにあるかを出す', () => {
    const [one, two] = files(suite(`${PASSED}\n${SKIPPED}`), suite(`${PASSED}\n${ERRORED}`))
    const result = run([one, two])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${one} にだけあるケース:\n  a.test.ts::飛ばす [skipped]\n${two} にだけあるケース:\n  a.test.ts::落ちる [error]\n`)
  })

  it('1 つ目の JUnit が無ければ、理由を出して非 0 を返す', () => {
    const [, two] = files(suite(PASSED), suite(PASSED))
    const missing = path.join(path.dirname(two), 'none.xml')
    expect(run([missing, two])).toEqual({ code: 2, stderr: `JUnit がありません: ${missing}\n` })
  })

  it('引数が足りなければ使い方を出して 2 を返す', () => {
    expect(run(['one.xml'])).toEqual({ code: 2, stderr: 'usage: compare-junit.ts <junit1.xml> <junit2.xml>\n' })
  })
})
