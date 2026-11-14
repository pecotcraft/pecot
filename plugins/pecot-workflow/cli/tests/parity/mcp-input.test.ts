import { describe, expect, it } from 'vitest'

import { readToolShape, toolInputOf } from './mcp-input.js'
import { readScenario, scenarioIds } from './scenario.js'

describe('toolInputOf', () => {
  it('位置引数を、定義書の positional の順に入力へ入れる', () => {
    expect(toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active'])).toEqual({ issue_ref: 'acme/demo/7', status: 'active' })
  })

  it('値を取るフラグは、短い形と長い形のどちらも、入力の名前に引く', () => {
    expect(toolInputOf(readToolShape(['session', 'show']), ['-D', '.'])).toEqual({ directory: '.' })
    expect(toolInputOf(readToolShape(['session', 'show']), ['--directory=/x'])).toEqual({ directory: '/x' })
  })

  it('値を取らないフラグは true、否定形は false、入力 no_x の --no-x は true', () => {
    expect(toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--no-checkout'])).toMatchObject({ checkout: false })
    expect(toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--checkout'])).toMatchObject({ checkout: true })
    expect(toolInputOf(readToolShape(['worktree', 'add']), ['--no-copy'])).toMatchObject({ no_copy: true })
  })

  it('整数の入力は数にし、配列の入力は繰り返しを集める', () => {
    expect(toolInputOf(readToolShape(['issue', 'show']), ['acme/demo/7', '--comment-limit', '3'])).toMatchObject({ comment_limit: 3 })
    expect(toolInputOf(readToolShape(['issue', 'create']), ['-t', 'task', '--label', 'a', '--label', 'b'])).toMatchObject({ label: ['a', 'b'] })
  })

  it('最後の位置引数が配列なら、残りを全部集める', () => {
    expect(toolInputOf(readToolShape(['issue', 'create']), ['one.md', 'two.md'])).toMatchObject({ files: ['one.md', 'two.md'] })
  })

  it('グローバルの --repo は repo に入れ、後の値を使う', () => {
    expect(toolInputOf(readToolShape(['session', 'show']), ['--repo', 'a/b', '--repo=c/d'])).toEqual({ repo: 'c/d' })
  })

  it('-- より後ろは位置引数にする', () => {
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', '-1', 'active'])).toEqual({ issue_ref: '-1', status: 'active' })
  })

  it('定義書に無いフラグと、値の無いフラグは例外にする', () => {
    expect(() => toolInputOf(readToolShape(['session', 'show']), ['--bogus'])).toThrow('--bogus')
    expect(() => toolInputOf(readToolShape(['session', 'show']), ['-D'])).toThrow('値がありません')
  })

  it('整数でない値は、数に読める文字でも例外にする', () => {
    const shape = readToolShape(['issue', 'show'])
    for (const text of ['x', '', ' ', '1e3', '0x10', '1.5', '+1', ' 7', '7 ', '1_0']) {
      expect(() => toolInputOf(shape, ['acme/demo/7', '--comment-limit', text])).toThrow('整数')
    }
    expect(toolInputOf(shape, ['acme/demo/7', '--comment-limit', '-3'])).toMatchObject({ comment_limit: -3 })
    expect(toolInputOf(shape, ['acme/demo/7', '--comment-limit=007'])).toMatchObject({ comment_limit: 7 })
  })

  it('値を取らない真偽値のフラグに --flag=value で値を付けると、例外にする', () => {
    expect(() => toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--no-checkout=false'])).toThrow('値を取らない')
    expect(() => toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--checkout='])).toThrow('値を取らない')
  })

  it('位置引数が定義書より余ると、例外にする。最後が配列なら余らない', () => {
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', 'extra'])).toThrow('多すぎ')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', '--', 'extra'])).toThrow('多すぎ')
    expect(toolInputOf(readToolShape(['issue', 'create']), ['one.md', 'two.md', 'three.md'])).toMatchObject({ files: ['one.md', 'two.md', 'three.md'] })
  })

  it('値を取るフラグの値が -- のときは、区切りでなく値にする', () => {
    expect(toolInputOf(readToolShape(['session', 'show']), ['-D', '--'])).toEqual({ directory: '--' })
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', 'acme/demo/7', 'active'])).toEqual({ issue_ref: 'acme/demo/7', status: 'active' })
  })

  it('負数に見える語は、-- より前なら写せない入力として例外にし、理由を示す', () => {
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['-1', 'active'])).toThrow('負数')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', '-12'])).toThrow('負数')
    // 値を取るフラグの値と、-- より後ろは、負数に見えても値・位置引数にする
    expect(toolInputOf(readToolShape(['issue', 'show']), ['acme/demo/7', '--comment-limit', '-3'])).toMatchObject({ comment_limit: -3 })
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', '-1', 'active'])).toEqual({ issue_ref: '-1', status: 'active' })
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
