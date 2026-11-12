import { describe, expect, it } from 'vitest'

import { collectIo, OUTCOME_META_KEY, toRejectedResult, toToolResult } from '../result.js'

describe('collectIo', () => {
  it('stdout と stderr に書いた文字列を、書いた順につなげて返す', () => {
    const collected = collectIo()
    collected.io.stdout('a')
    collected.io.stderr('x')
    collected.io.stdout('b\n')
    collected.io.stderr('y\n')
    expect(collected.stdout()).toBe('ab\n')
    expect(collected.stderr()).toBe('xy\n')
  })

  it('標準入力を読む口を持たない', () => {
    expect(collectIo().io.readLine).toBeUndefined()
  })
})

describe('toToolResult', () => {
  it('stdout だけなら、本文は 1 個で、isError を付けない', () => {
    expect(toToolResult({ exitCode: 0, stdout: 'ok\n', stderr: '' })).toEqual({
      content: [{ type: 'text', text: 'ok\n' }],
      _meta: { [OUTCOME_META_KEY]: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
    })
  })

  it('成功でも stderr があれば、2 個目の本文に付ける', () => {
    const result = toToolResult({ exitCode: 0, stdout: 'ok\n', stderr: 'warning: x\n' })
    expect(result.content).toEqual([{ type: 'text', text: 'ok\n' }, { type: 'text', text: 'warning: x\n' }])
    expect(result.isError).toBeUndefined()
  })

  it('失敗なら、2 個目の本文の末尾に exit code の行を足し、isError を付ける', () => {
    const result = toToolResult({ exitCode: 2, stdout: '', stderr: 'bad\n' })
    expect(result.content).toEqual([{ type: 'text', text: 'bad\nexit code: 2\n' }])
    expect(result.isError).toBe(true)
  })

  it('stderr が改行で終わっていなければ、改行を挟む', () => {
    expect(toToolResult({ exitCode: 1, stdout: ' ', stderr: 'Aborted.' }).content).toEqual([{ type: 'text', text: ' ' }, { type: 'text', text: 'Aborted.\nexit code: 1\n' }])
  })

  it('失敗で stderr が空なら、exit code の行だけにする', () => {
    expect(toToolResult({ exitCode: 3, stdout: '', stderr: '' }).content).toEqual([{ type: 'text', text: 'exit code: 3\n' }])
  })

  it('stdout と stderr が空で終了コード 0 なら、本文は空', () => {
    expect(toToolResult({ exitCode: 0, stdout: '', stderr: '' }).content).toEqual([])
  })

  it('structuredContent を付けず、_meta に終了コードと 2 つの出力を載せる', () => {
    const result = toToolResult({ exitCode: 3, stdout: 'a', stderr: 'b' })
    expect(result.structuredContent).toBeUndefined()
    expect(result._meta).toEqual({ [OUTCOME_META_KEY]: { exitCode: 3, stdout: 'a', stderr: 'b' } })
  })
})

describe('toRejectedResult', () => {
  it('誤りの文を本文にし、_meta を付けない', () => {
    expect(toRejectedResult('invalid input: x')).toEqual({ content: [{ type: 'text', text: 'invalid input: x' }], isError: true })
  })
})
