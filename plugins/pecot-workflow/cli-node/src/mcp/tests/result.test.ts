import { describe, expect, it } from 'vitest'

import { collectIo, toRejectedResult, toToolResult } from '../result.js'

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
  it('終了コードが 0 なら、isError を付けず、stdout を本文にする', () => {
    expect(toToolResult({ exitCode: 0, stdout: 'ok\n', stderr: 'note\n' })).toEqual({
      content: [{ type: 'text', text: 'ok\n' }],
      structuredContent: { exitCode: 0, stdout: 'ok\n', stderr: 'note\n' },
    })
  })

  it('終了コードが 0 でなければ、isError を付ける', () => {
    expect(toToolResult({ exitCode: 2, stdout: '', stderr: 'bad\n' })).toEqual({
      content: [{ type: 'text', text: '' }],
      isError: true,
      structuredContent: { exitCode: 2, stdout: '', stderr: 'bad\n' },
    })
  })
})

describe('toRejectedResult', () => {
  it('誤りの文を本文にし、structuredContent を付けない', () => {
    expect(toToolResult({ exitCode: 1, stdout: '', stderr: '' }).isError).toBe(true)
    expect(toRejectedResult('invalid input: x')).toEqual({ content: [{ type: 'text', text: 'invalid input: x' }], isError: true })
  })
})
