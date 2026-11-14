import { describe, expect, it } from 'vitest'

import { createOutput } from '../../commands/output.js'
import { collectIo, TOOL_OUTPUT_SCHEMA, toAbortedResult, toRejectedResult, toToolResult } from '../result.js'

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

  it('原因の名前は最初に受けたものを残す', () => {
    const collected = collectIo()
    expect(collected.kind()).toBeUndefined()
    collected.io.failureKind?.('not-on-board')
    collected.io.failureKind?.('other')
    expect(collected.kind()).toBe('not-on-board')
  })

  it('結果の行は、片付けの行を除いた最初のものを残す', () => {
    const collected = collectIo()
    const out = createOutput(false, collected.io)
    out.done({ verb: 'delete', target: '1 archived items', aside: true })
    out.done({ verb: 'create', target: 'branch b/1' })
    out.done({ verb: 'set', target: 'x' })
    expect(collected.resultLine()).toBe('created: branch b/1')
    expect(collected.stderr()).toBe('deleted: 1 archived items\ncreated: branch b/1\nset: x\n')
  })

  it('dry-run の行は、結果の行として残す', () => {
    const collected = collectIo()
    createOutput(true, collected.io).planned({ verb: 'add', target: 'y' })
    expect(collected.resultLine()).toBe('dry-run: would add y')
  })
})

describe('toToolResult', () => {
  it('成功は ok と結果の行を message にし、空の出力のキーを省き、isError を付けない', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', stderr: 'warning: w\ncreated: branch b/1\nset: x\n', resultLine: 'created: branch b/1' })
    const expected = { ok: true, exitCode: 0, artifacts: [], data: {}, message: 'created: branch b/1', stderr: 'warning: w\ncreated: branch b/1\nset: x\n' }
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected })
  })

  it('成功で結果の行が無ければ、stdout の最初の空でない行を message にする', () => {
    const result = toToolResult({ exitCode: 0, stdout: '\n  Board: Demo\nrow\n', stderr: 'deleted: 1 archived items\n' })
    expect(result.structuredContent).toMatchObject({ message: 'Board: Demo' })
  })

  it('成功で結果の行と stdout のどちらも無ければ、message は空', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', stderr: 'warning: w\n' })
    expect(result.structuredContent).toMatchObject({ ok: true, message: '' })
  })

  it('失敗は kind と最初の error の行の文を持ち、isError を付ける', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', stderr: 'warning: w\nerror: not found\n  hint: x\nerror: second\n', kind: 'not-on-board' })
    expect(result.structuredContent).toEqual({ ok: false, exitCode: 1, kind: 'not-on-board', artifacts: [], data: {}, message: 'not found', stderr: 'warning: w\nerror: not found\n  hint: x\nerror: second\n' })
    expect(result.isError).toBe(true)
  })

  it('失敗で名前が無ければ other にする', () => {
    expect(toToolResult({ exitCode: 3, stdout: '', stderr: '' }).structuredContent).toEqual({ ok: false, exitCode: 3, kind: 'other', artifacts: [], data: {}, message: '' })
  })

  it('失敗で error の行が無ければ、stderr の最初の行を message にする', () => {
    expect(toToolResult({ exitCode: 1, stdout: '', stderr: 'Aborted.\n', kind: 'aborted' }).structuredContent).toMatchObject({ message: 'Aborted.' })
  })

  it('渡された message を、stderr の行より先に使う', () => {
    expect(toToolResult({ exitCode: 2, stdout: '', stderr: '╭ Error ╮\n', kind: 'invalid-input', message: 'Missing argument' }).structuredContent).toMatchObject({ message: 'Missing argument' })
  })

  it('content の本文は structuredContent と同じ JSON で、outputSchema に合う', () => {
    const result = toToolResult({ exitCode: 1, stdout: 'a', stderr: 'error: b\n', kind: 'github-api' })
    const [block] = result.content
    expect(block?.type === 'text' ? JSON.parse(block.text) : undefined).toEqual(result.structuredContent)
    expect(TOOL_OUTPUT_SCHEMA.parse(result.structuredContent)).toEqual(result.structuredContent)
  })
})

describe('toRejectedResult', () => {
  it('終了コード 2・invalid-input と、断りの文を message にした結果', () => {
    const expected = { ok: false, exitCode: 2, kind: 'invalid-input', artifacts: [], data: {}, message: 'invalid input: x' }
    expect(toRejectedResult('invalid input: x')).toEqual({ content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected, isError: true })
  })
})

describe('toAbortedResult', () => {
  it('終了コード 1・aborted の結果', () => {
    expect(toAbortedResult().structuredContent).toEqual({ ok: false, exitCode: 1, kind: 'aborted', artifacts: [], data: {}, message: 'cancelled' })
  })
})
