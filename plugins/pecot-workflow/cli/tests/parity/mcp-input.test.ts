import { describe, expect, it } from 'vitest'

import { hasCliOnlyInput, readToolShape, toolInputOf } from './mcp-input.js'
import { readScenario, scenarioIds } from './scenario.js'
import { explains } from '../_helpers/explains.js'

describe('toolInputOf', () => {
  it('位置引数を、定義書の positional の順に入力へ入れる', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、位置引数の変換のテストです。`board move` の位置引数が、定義書の `positional` の順に `issue_ref` と `status` へ割り当てられることを確認します。')
    expect(toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active'])).toEqual({ issue_ref: 'acme/demo/7', status: 'active' })
  })

  it('値を取るフラグは、短い形と長い形のどちらも、入力の名前に引く', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、値を取るフラグの変換のテストです。`-D .` と `--directory=/x` のように、短い形と長い形のどちらでも、同じ入力 `directory` に変換されることを確認します。')
    expect(toolInputOf(readToolShape(['session', 'show']), ['-D', '.'])).toEqual({ directory: '.' })
    expect(toolInputOf(readToolShape(['session', 'show']), ['--directory=/x'])).toEqual({ directory: '/x' })
  })

  it('値を取らないフラグは true、否定形は false、入力 no_x の --no-x は true', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、真偽値のフラグの変換のテストです。`--checkout` は `true`、`--no-checkout` は `false` に変換され、入力名が `no_copy` の `--no-copy` は `true` に変換されることを確認します。')
    expect(toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--no-checkout'])).toMatchObject({ checkout: false })
    expect(toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--checkout'])).toMatchObject({ checkout: true })
    expect(toolInputOf(readToolShape(['worktree', 'add']), ['--no-copy'])).toMatchObject({ no_copy: true })
  })

  it('整数の入力は数にし、配列の入力は繰り返しを集める', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、整数と配列の入力の変換のテストです。`--comment-limit 3` は数値の `3` に、繰り返した `--label` は配列に変換されることを確認します。')
    expect(toolInputOf(readToolShape(['issue', 'show']), ['acme/demo/7', '--comment-limit', '3'])).toMatchObject({ comment_limit: 3 })
    expect(toolInputOf(readToolShape(['issue', 'create']), ['-t', 'task', '--label', 'a', '--label', 'b'])).toMatchObject({ label: ['a', 'b'] })
  })

  it('最後の位置引数が配列なら、残りを全部集める', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、最後の位置引数が配列の場合のテストです。残りの位置引数がすべて、`files` の配列に集められることを確認します。')
    expect(toolInputOf(readToolShape(['issue', 'create']), ['one.md', 'two.md'])).toMatchObject({ files: ['one.md', 'two.md'] })
  })

  it('グローバルの --repo は repo に入れ、後の値を使う', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、グローバルオプション `--repo` のテストです。`repo` に変換され、複数回指定した場合は後の値が使われることを確認します。')
    expect(toolInputOf(readToolShape(['session', 'show']), ['--repo', 'a/b', '--repo=c/d'])).toEqual({ repo: 'c/d' })
  })

  it('-- より後ろは位置引数にする', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、`--` 以降の引数のテストです。`-1` のように負数に見える値も含めて、すべて位置引数として扱われることを確認します。')
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', '-1', 'active'])).toEqual({ issue_ref: '-1', status: 'active' })
  })

  it('定義書に存在しないフラグと、値の指定がないフラグは例外にする', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` に、定義書に存在しないフラグと、値のないフラグを指定した場合のテストです。どちらも例外が発生し、前者のメッセージにはフラグ名が、後者には `値がありません` が含まれることを確認します。')
    expect(() => toolInputOf(readToolShape(['session', 'show']), ['--bogus'])).toThrow('--bogus')
    expect(() => toolInputOf(readToolShape(['session', 'show']), ['-D'])).toThrow('値がありません')
  })

  it('整数でない値は、数に読める文字でも例外にする', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` に、整数でない値を指定した場合のテストです。`x` や `1e3` など数値に読める文字列も含めて例外が発生し、`-3` や `007` は整数として受け付けることを確認します。')
    const shape = readToolShape(['issue', 'show'])
    for (const text of ['x', '', ' ', '1e3', '0x10', '1.5', '+1', ' 7', '7 ', '1_0']) {
      expect(() => toolInputOf(shape, ['acme/demo/7', '--comment-limit', text])).toThrow('整数')
    }
    expect(toolInputOf(shape, ['acme/demo/7', '--comment-limit', '-3'])).toMatchObject({ comment_limit: -3 })
    expect(toolInputOf(shape, ['acme/demo/7', '--comment-limit=007'])).toMatchObject({ comment_limit: 7 })
  })

  it('値を取らない真偽値のフラグに --flag=value で値を付けると、例外にする', async () => {
    await explains('`toolInputOf` の、値を取らない真偽値のフラグのテストです。`--flag=value` の形で値を指定した場合に、`値を取らない` を含む例外が発生することを確認します。')
    expect(() => toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--no-checkout=false'])).toThrow('値を取らない')
    expect(() => toolInputOf(readToolShape(['session', 'start']), ['acme/demo/7', '--checkout='])).toThrow('値を取らない')
  })

  it('位置引数が定義書より余ると、例外にする。最後が配列なら余らない', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` に、定義書の位置引数より多くの引数を指定した場合のテストです。`--` の後ろに置いた場合も含めて例外が発生し、最後が配列の入力なら、いくつ指定しても例外が発生しないことを確認します。')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', 'extra'])).toThrow('多すぎ')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', '--', 'extra'])).toThrow('多すぎ')
    expect(toolInputOf(readToolShape(['issue', 'create']), ['one.md', 'two.md', 'three.md'])).toMatchObject({ files: ['one.md', 'two.md', 'three.md'] })
  })

  it('値を取るフラグの値が -- のときは、区切りでなく値にする', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` の、値を取るフラグの値が `--` の場合のテストです。区切りではなく値として扱われ、値の後ろの `--` は位置引数の区切りとして働くことを確認します。')
    expect(toolInputOf(readToolShape(['session', 'show']), ['-D', '--'])).toEqual({ directory: '--' })
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', 'acme/demo/7', 'active'])).toEqual({ issue_ref: 'acme/demo/7', status: 'active' })
  })

  it('負数に見える語は、-- より前なら写せない入力として例外にし、理由を示す', async () => {
    await explains('CLI の引数をツールの入力へ変換する `toolInputOf` に、負数に見える語を `--` より前の位置引数として指定した場合のテストです。`負数` を含む例外が発生し、フラグの値や `--` より後ろに置いた場合は変換できることを確認します。')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['-1', 'active'])).toThrow('負数')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', '-12'])).toThrow('負数')
    // 値を取るフラグの値と、-- より後ろは、負数に見えても値・位置引数にする
    expect(toolInputOf(readToolShape(['issue', 'show']), ['acme/demo/7', '--comment-limit', '-3'])).toMatchObject({ comment_limit: -3 })
    expect(toolInputOf(readToolShape(['board', 'move']), ['--', '-1', 'active'])).toEqual({ issue_ref: '-1', status: 'active' })
  })

  it('定義書に存在しないコマンドは例外にする', async () => {
    await explains('定義書に存在しないコマンドを指定して `readToolShape` を呼び出した場合に、そのコマンド名を含む例外が発生することを確認します。')
    expect(() => readToolShape(['nope'])).toThrow('nope')
  })

  it('CLI だけの入力のフラグは、長い形・短い形のどちらも例外にする', async () => {
    await explains('`toolInputOf` の、CLI 専用の入力のフラグのテストです。`--dry-run` や `-n` を指定した場合に、`CLI だけの入力` を含む例外が発生することを確認します。')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', '--dry-run'])).toThrow('CLI だけの入力')
    expect(() => toolInputOf(readToolShape(['board', 'move']), ['acme/demo/7', 'active', '-n'])).toThrow('CLI だけの入力')
  })

  it('global・usage・CLI だけの入力を使うものを除く全シナリオの argv が、入力に写せる', async () => {
    await explains('シナリオの引数を、ツールの入力へ変換できるかのテストです。`global-` で始まるシナリオと usage のシナリオ、CLI 専用の入力を使うシナリオを除く全シナリオで、例外が発生しないことを確認します。')
    const ids = scenarioIds().filter(id => !id.startsWith('global-') && !id.includes('usage'))
    expect(ids.length).toBeGreaterThan(100)
    for (const id of ids) {
      const scenario = readScenario(id)
      const shape = readToolShape(scenario.command.path)
      if (hasCliOnlyInput(shape, scenario.command.args)) continue
      expect(() => toolInputOf(shape, scenario.command.args)).not.toThrow()
    }
  })
})

describe('hasCliOnlyInput', () => {
  it('CLI だけの入力のフラグを -- より前に含むときだけ真になる', async () => {
    await explains('`hasCliOnlyInput` のテストです。CLI 専用の入力のフラグ（`--dry-run` や `-n`）が `--` より前にある場合だけ、`true` を返すことを確認します。')
    const shape = readToolShape(['board', 'move'])
    expect([
      hasCliOnlyInput(shape, ['acme/demo/7', 'active', '--dry-run']),
      hasCliOnlyInput(shape, ['acme/demo/7', 'active', '-n']),
      hasCliOnlyInput(shape, ['acme/demo/7', 'active']),
      hasCliOnlyInput(shape, ['--', 'acme/demo/7', '--dry-run']),
    ]).toEqual([true, true, false, false])
  })
})
