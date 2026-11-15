import { describe, expect, it } from 'vitest'

import { createOutput } from '../../commands/output.js'
import { z } from 'zod'

import { collectIo, detailOf, splitWarnings, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from '../result.js'

const ENVELOPE = toolOutputSchema(z.strictObject({ name: z.string() }))

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
  it('成功は ok と結果の行を message にし、stdout・stderr を載せず、isError を付けない', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', stderr: 'warning: w\ncreated: branch b/1\nset: x\n', resultLine: 'created: branch b/1' })
    const expected = { ok: true, exitCode: 0, artifacts: [], data: {}, message: 'created: branch b/1' }
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

  it('失敗は kind と最初の error の行の文を持ち、data に reason と、warning を除いた error の行から後の全文を入れ、isError を付ける', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', stderr: 'warning: w\nerror: not found\n  hint: x\nerror: second\n', kind: 'not-on-board' })
    expect(result.structuredContent).toEqual({ ok: false, exitCode: 1, kind: 'not-on-board', artifacts: [], data: { reason: 'not-on-board', detail: 'not found\n  hint: x\nerror: second' }, message: 'not found' })
    expect(result.isError).toBe(true)
  })

  it('失敗で名前が無ければ other にする', () => {
    expect(toToolResult({ exitCode: 3, stdout: '', stderr: '' }).structuredContent).toEqual({ ok: false, exitCode: 3, kind: 'other', artifacts: [], data: { reason: 'other', detail: '' }, message: '' })
  })

  it('失敗で error の行が無ければ、stderr の最初の行を message にする', () => {
    expect(toToolResult({ exitCode: 1, stdout: '', stderr: 'Aborted.\n', kind: 'aborted' }).structuredContent).toMatchObject({ message: 'Aborted.' })
  })

  it('渡された message を、stderr の行より先に使う', () => {
    expect(toToolResult({ exitCode: 2, stdout: '', stderr: '╭ Error ╮\n', kind: 'invalid-input', message: 'Missing argument' }).structuredContent).toMatchObject({ message: 'Missing argument' })
  })

  it('content の本文は structuredContent と同じ JSON で、成功と失敗のどちらも outputSchema に合う', () => {
    const result = toToolResult({ exitCode: 1, stdout: 'a', stderr: 'error: b\n', kind: 'github-api' })
    const [block] = result.content
    expect(block?.type === 'text' ? JSON.parse(block.text) : undefined).toEqual(result.structuredContent)
    expect(ENVELOPE.parse(result.structuredContent)).toEqual(result.structuredContent)
    const success = toToolResult({ exitCode: 0, stdout: '', stderr: '', data: { name: 'n' }, warnings: ['w'], artifacts: ['/a'] })
    expect(ENVELOPE.parse(success.structuredContent)).toEqual(success.structuredContent)
  })
})

describe('toRejectedResult', () => {
  it('終了コード 2・invalid-input と、断りの文を message にした結果', () => {
    const expected = { ok: false, exitCode: 2, kind: 'invalid-input', artifacts: [], data: { reason: 'invalid-input', detail: 'invalid input: x' }, message: 'invalid input: x' }
    expect(toRejectedResult('invalid input: x')).toEqual({ content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected, isError: true })
  })
})

describe('toAbortedResult', () => {
  it('終了コード 1・aborted の結果', () => {
    expect(toAbortedResult().structuredContent).toEqual({ ok: false, exitCode: 1, kind: 'aborted', artifacts: [], data: { reason: 'aborted', detail: 'cancelled' }, message: 'cancelled' })
  })
})

describe('collectIo の data・artifacts・warnings', () => {
  it('result の項目を浅く重ね、artifact のパスを絶対パスにして重ねずに残し、warning の文を前置きなしで残す', () => {
    const collected = collectIo()
    const first = createOutput<{ a: number, b: string[] }>(false, collected.io)
    first.result({ a: 1, b: ['x'] })
    createOutput<{ b: string[] }>(false, collected.io).result({ b: ['y'] })
    first.artifact('/w/out.md')
    first.artifact('/w/out.md')
    first.warning('two\nlines')
    expect(collected.data()).toEqual({ a: 1, b: ['y'] })
    expect(collected.artifacts()).toEqual(['/w/out.md'])
    expect(collected.warnings()).toEqual(['two\nlines'])
    expect(collected.stderr()).toBe('warning: two\n  lines\n')
  })
})

describe('splitWarnings', () => {
  it('warning の行と、その後の空白 2 つで始まる行を 1 つの文にし、ほかの行と分ける', () => {
    expect(splitWarnings('created: x\nwarning: a\n  b\nerror: e\n  hint: h\nwarning: c\n')).toEqual({
      warnings: ['a\nb', 'c'],
      rest: ['created: x', 'error: e', '  hint: h', ''],
    })
  })
})

describe('detailOf', () => {
  it('error の行が無ければ、warning を除いた stderr の全部を返し、それも空なら message を返す', () => {
    expect(detailOf('warning: w\n╭ Usage ╮\n│ x │\n', 'm')).toBe('╭ Usage ╮\n│ x │')
    expect(detailOf('warning: w\n', 'm')).toBe('m')
  })

  it('error の行の前に結果の行があると、error の行から後だけを返す', () => {
    expect(detailOf('created: issue #12\nadded: issue #12 to the board\nerror: cannot set the status\n', 'm')).toBe('cannot set the status')
  })

  it('error の行の後に片付けの行があると、片付けの行も返す', () => {
    expect(detailOf('error: push failed\nremoved: worktree /w/a\n', 'm')).toBe('push failed\nremoved: worktree /w/a')
  })

  it('error の続きに hint の行があると、字下げを保って返す', () => {
    expect(detailOf('error: not ready\n  hint: run pecot board show\n', 'm')).toBe('not ready\n  hint: run pecot board show')
  })

  it('warning が error の行の間に挟まると、warning とその続きの行だけを除く', () => {
    expect(detailOf('error: first\nwarning: slow API\n  retrying\nerror: second\n', 'm')).toBe('first\nerror: second')
  })
})
