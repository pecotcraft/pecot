/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// scripts/compare-junit.ts が、2 つの JUnit を (classname, name) ごとの結果で比べることを確かめる。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'
import { compareJunit, main, parseJunit } from '../scripts/compare-junit.js'
import { makeTemporaryDirectory } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'

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
  it('子の要素から 4 つの結果を読み、属性の escape を戻す', async () => {
    await explains('JUnit を読み込む `parseJunit` のテストです。成功・失敗・エラー・スキップの 4 種類の `testcase` を含む JUnit を渡した場合に、属性のエスケープを戻した名前ごとに結果を返すことを確認します。')
    const cases = parseJunit(suite([PASSED, SELF_CLOSING, FAILED, ERRORED, SKIPPED].join('\n')))
    expect(Object.fromEntries(cases)).toEqual({
      'a.test.ts::通る': 'passed',
      'a.test.ts::自己閉じ': 'passed',
      'a.test.ts::落ちる > 入れ子': 'failed',
      'a.test.ts::落ちる': 'error',
      'a.test.ts::飛ばす': 'skipped',
    })
  })

  it('CDATA の中の要素の文字は、結果に影響しない', async () => {
    await explains('JUnit を読み込む `parseJunit` のテストです。`system-out` の CDATA に `<failure>` という文字列が含まれていても、そのテストの結果を `passed` のままにすることを確認します。')
    const cases = parseJunit(suite('<testcase classname="c" name="n"><system-out><![CDATA[<failure>]]></system-out></testcase>'))
    expect(cases.get('c::n')).toBe('passed')
  })
})

describe('compareJunit', () => {
  it('同じ結果なら、差を返さない', async () => {
    await explains('2 つの JUnit を比較する `compareJunit` のテストです。同じ結果を渡した場合に、片方だけのケースも結果が違うケースも空になることを確認します。')
    const cases = parseJunit(suite(`${PASSED}\n${FAILED}`))
    expect(compareJunit(cases, cases)).toEqual({ onlyFirst: [], onlySecond: [], changed: [] })
  })

  it('片方にだけあるケースと、結果の違うケースを分けて返す', async () => {
    await explains('2 つの JUnit を比較する `compareJunit` のテストです。2 回目だけにあるケースと、結果の変わったケースがある場合は、それぞれを別の一覧に分けて返すことを確認します。')
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
  it('一致すれば 0 を返し、何も出力しない', async () => {
    await explains('比較スクリプトの `main` 関数 のテストです。2 つの JUnit の結果が一致する場合に、終了コード 0 を返し、標準エラー出力に何も出力しないことを確認します。')
    const [one, two] = files(suite(PASSED), suite(PASSED))
    expect(run([one, two])).toEqual({ code: 0, stderr: '' })
  })

  it('結果に差があれば 1 を返し、1 回目と 2 回目の結果を並べて出力する', async () => {
    await explains('比較スクリプトの `main` 関数 のテストです。同じケースの結果が成功と失敗で異なる場合に、終了コード 1 を返し、1 回目と 2 回目の結果を並べて出力することを確認します。')
    const [one, two] = files(suite(PASSED), suite(PASSED.replace('</testcase>', '<failure/></testcase>')))
    const result = run([one, two])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('結果が違うケース:\n  a.test.ts::通る  1 回目=passed  2 回目=failed\n')
  })

  it('片方にだけあるケースは、どちらのファイルにあるかを出力する', async () => {
    await explains('比較スクリプトの `main` 関数 のテストです。片方のファイルにだけあるケースがある場合に、終了コード 1 を返し、ケースごとにそのファイルのパスと結果を出力することを確認します。')
    const [one, two] = files(suite(`${PASSED}\n${SKIPPED}`), suite(`${PASSED}\n${ERRORED}`))
    const result = run([one, two])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${one} にだけあるケース:\n  a.test.ts::飛ばす [skipped]\n${two} にだけあるケース:\n  a.test.ts::落ちる [error]\n`)
  })

  it('1 つ目の JUnit が存在しなければ、理由を出力して 0 以外を返す', async () => {
    await explains('比較スクリプトの `main` 関数 のテストです。1 つ目の JUnit のファイルが存在しない場合に、終了コード 2 を返し、存在しないパスを示す理由を出力することを確認します。')
    const [, two] = files(suite(PASSED), suite(PASSED))
    const missing = path.join(path.dirname(two), 'none.xml')
    expect(run([missing, two])).toEqual({ code: 2, stderr: `JUnit がありません: ${missing}\n` })
  })

  it('引数が不足していれば、使い方を出力して 2 を返す', async () => {
    await explains('比較スクリプトの `main` 関数 のテストです。引数が 1 つしかない場合に、終了コード 2 を返し、使い方を出力することを確認します。')
    expect(run(['one.xml'])).toEqual({ code: 2, stderr: 'usage: compare-junit.ts <junit1.xml> <junit2.xml>\n' })
  })
})
