import { describe, expect, it } from 'vitest'

import { readToolShape, toolInputOf } from './mcp-input.js'
import { readScenario, scenarioIds } from './scenario.js'

describe('toolInputOf', () => {
  it('位置引数を、定義書の positional の順に入力へ入れる', () => {
    expect(toolInputOf(readToolShape(['update-issue-status']), ['acme/demo/7', 'active'])).toEqual({ issue_ref: 'acme/demo/7', status: 'active' })
  })

  it('値を取るフラグは、短い形と長い形のどちらも、入力の名前に引く', () => {
    expect(toolInputOf(readToolShape(['session', 'status']), ['-D', '.'])).toEqual({ directory: '.' })
    expect(toolInputOf(readToolShape(['session', 'status']), ['--directory=/x'])).toEqual({ directory: '/x' })
  })

  it('値を取らないフラグは true、否定形は false、入力 no_x の --no-x は true', () => {
    expect(toolInputOf(readToolShape(['create-branch']), ['acme/demo/7', '--no-checkout'])).toMatchObject({ checkout: false })
    expect(toolInputOf(readToolShape(['create-branch']), ['acme/demo/7', '--checkout'])).toMatchObject({ checkout: true })
    expect(toolInputOf(readToolShape(['issue', 'quick']), ['-m', 'x', '--no-branch'])).toMatchObject({ no_branch: true })
  })

  it('整数の入力は数にし、配列の入力は繰り返しを集める', () => {
    expect(toolInputOf(readToolShape(['issue', 'read']), ['acme/demo/7', '--comment-limit', '3'])).toMatchObject({ comment_limit: 3 })
    expect(toolInputOf(readToolShape(['issue', 'create']), ['-t', 'task', '--label', 'a', '--label', 'b'])).toMatchObject({ label: ['a', 'b'] })
  })

  it('最後の位置引数が配列なら、残りを全部集める', () => {
    expect(toolInputOf(readToolShape(['issue', 'create']), ['one.md', 'two.md'])).toMatchObject({ files: ['one.md', 'two.md'] })
  })

  it('グローバルの --repo は repo に入れ、後の値を使う', () => {
    expect(toolInputOf(readToolShape(['session', 'status']), ['--repo', 'a/b', '--repo=c/d'])).toEqual({ repo: 'c/d' })
  })

  it('-- より後ろは位置引数にする', () => {
    expect(toolInputOf(readToolShape(['update-issue-status']), ['--', '-1', 'active'])).toEqual({ issue_ref: '-1', status: 'active' })
  })

  it('定義書に無いフラグと、値の無いフラグは例外にする', () => {
    expect(() => toolInputOf(readToolShape(['session', 'status']), ['--bogus'])).toThrow('--bogus')
    expect(() => toolInputOf(readToolShape(['session', 'status']), ['-D'])).toThrow('値がありません')
  })

  it('整数でない値は例外にする', () => {
    expect(() => toolInputOf(readToolShape(['issue', 'read']), ['acme/demo/7', '--comment-limit', 'x'])).toThrow('整数')
  })

  it('定義書に無いコマンドは例外にする', () => {
    expect(() => readToolShape(['nope'])).toThrow('nope')
  })

  it('global と usage を除く全シナリオの argv が、入力に写せる', () => {
    const ids = scenarioIds().filter(id => !id.startsWith('global-') && !id.includes('usage'))
    expect(ids.length).toBeGreaterThan(100)
    for (const id of ids) {
      const scenario = readScenario(id)
      const shape = readToolShape(scenario.command.path)
      expect(() => toolInputOf(shape, scenario.command.args)).not.toThrow()
    }
  })
})
