import { describe, expect, it } from 'vitest'

import { createOutput } from '../../commands/output.js'
import { outputSchemaIssues } from '../../../tests/_helpers/mcp-client.js'
import { z } from 'zod'

import { COMMON_OUTPUT_PROPERTIES, collectIo, detailOf, splitWarnings, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from '../result.js'

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

// 結果の content が、文の text（あれば）と structuredContent の JSON の text であること
function contentOf(text: string | undefined, structured: Readonly<Record<string, unknown>>): { type: 'text', text: string }[] {
  const json = { type: 'text', text: JSON.stringify(structured) } satisfies { type: 'text', text: string }
  return text === undefined ? [json] : [{ type: 'text', text }, json]
}

const PropertiesSchema = z.looseObject({ properties: z.record(z.string(), z.unknown()) })

const OUTPUT = z.strictObject({ name: z.string() })

describe('toToolResult', () => {
  it('成功はツールの項目を structuredContent の最上位に置き、結果の行を文の text にし、isError を付けない', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', stderr: 'warning: w\ncreated: branch b/1\nset: x\n', resultLine: 'created: branch b/1', data: { name: 'n' } })
    expect(result).toEqual({ content: contentOf('created: branch b/1', { name: 'n' }), structuredContent: { name: 'n' } })
  })

  it('成功で結果の行が無ければ、stdout の最初の空でない行を文にする', () => {
    const result = toToolResult({ exitCode: 0, stdout: '\n  Board: Demo\nrow\n', stderr: 'deleted: 1 archived items\n' })
    expect(result.content).toEqual(contentOf('Board: Demo', {}))
  })

  it('成功で結果の行と stdout のどちらも無ければ、文の text を省き、JSON の text だけを返す', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', stderr: 'warning: w\n', warnings: ['w'] })
    expect(result).toEqual({ content: contentOf(undefined, { warnings: ['w'] }), structuredContent: { warnings: ['w'] } })
  })

  it('成功の structuredContent に、ok・exitCode・data・artifacts・message・kind・detail が無い', () => {
    const result = toToolResult({ exitCode: 0, stdout: 'x\n', stderr: '', data: { name: 'n' } })
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['name'])
  })

  it('失敗は kind と、warning を除いた error の行から後の全文の detail を最上位に置き、detail を文の text にして、isError を付ける', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', stderr: 'warning: w\nerror: not found\n  hint: x\nerror: second\n', kind: 'not-on-board', warnings: ['w'] })
    const structured = { kind: 'not-on-board', detail: 'not found\n  hint: x\nerror: second', warnings: ['w'] }
    expect(result).toEqual({ content: contentOf(structured.detail, structured), structuredContent: structured, isError: true })
  })

  it('失敗では、途中まで進んだ項目を kind・detail と並べて置き、reason を置かない', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', stderr: 'error: half\n', kind: 'github-api', data: { name: 'x' } })
    expect(result.structuredContent).toEqual({ kind: 'github-api', detail: 'half', name: 'x' })
  })

  it('失敗で名前が無ければ other にし、detail と文が空なら JSON の text だけを返す', () => {
    const result = toToolResult({ exitCode: 3, stdout: '', stderr: '' })
    expect(result).toEqual({ content: contentOf(undefined, { kind: 'other', detail: '' }), structuredContent: { kind: 'other', detail: '' }, isError: true })
  })

  it('失敗で error の行が無ければ、warning を除いた stderr の全部を detail にする', () => {
    expect(toToolResult({ exitCode: 1, stdout: '', stderr: 'Aborted.\n', kind: 'aborted' }).structuredContent).toEqual({ kind: 'aborted', detail: 'Aborted.' })
  })

  it('warning を除いた stderr が空なら、渡された message を detail にする', () => {
    expect(toToolResult({ exitCode: 2, stdout: '', stderr: 'warning: w\n', kind: 'invalid-input', message: 'Missing argument' }).structuredContent).toEqual({ kind: 'invalid-input', detail: 'Missing argument' })
  })

  it('成功と失敗の structuredContent は、どちらも outputSchema に合い、どちらでもない値と未知の項目は合わない', async () => {
    const schema = toolOutputSchema(OUTPUT)
    const failure = toToolResult({ exitCode: 1, stdout: 'a', stderr: 'error: b\n', kind: 'github-api' })
    const success = toToolResult({ exitCode: 0, stdout: '', stderr: '', data: { name: 'n' }, warnings: ['w'] })
    expect(await outputSchemaIssues(schema, failure.structuredContent)).toEqual([])
    expect(await outputSchemaIssues(schema, success.structuredContent)).toEqual([])
    expect(await outputSchemaIssues(schema, {})).not.toEqual([])
    expect(await outputSchemaIssues(schema, { name: 'n', ok: true })).not.toEqual([])
  })
})

describe('toolOutputSchema', () => {
  it('最上位は type: object で、properties にツールの項目と共通の 4 項目を並べ、閉じた型にする', () => {
    const output = z.strictObject({ name: z.string(), count: z.int().optional() })
    expect(toolOutputSchema(output)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
        ...COMMON_OUTPUT_PROPERTIES,
      },
      additionalProperties: false,
      anyOf: [{ required: ['name'] }, { required: ['kind', 'detail'] }],
    })
  })

  it('成功の必須項目が無ければ、anyOf を置かない', () => {
    const schema = toolOutputSchema(z.strictObject({ file: z.string().optional() }))
    expect(schema).not.toHaveProperty('anyOf')
    const { properties } = PropertiesSchema.parse(schema)
    expect(Object.keys(properties)).toEqual(['file', 'kind', 'detail', 'log', 'warnings'])
  })

  it('$schema を持たない', () => {
    expect(toolOutputSchema(OUTPUT)).not.toHaveProperty('$schema')
  })
})

describe('toRejectedResult', () => {
  it('invalid-input と、断りの文を detail と文の text にした失敗', () => {
    const structured = { kind: 'invalid-input', detail: 'invalid input: x' }
    expect(toRejectedResult('invalid input: x')).toEqual({ content: contentOf('invalid input: x', structured), structuredContent: structured, isError: true })
  })
})

describe('toAbortedResult', () => {
  it('aborted と cancelled の失敗', () => {
    expect(toAbortedResult().structuredContent).toEqual({ kind: 'aborted', detail: 'cancelled' })
  })
})

describe('collectIo の項目・warnings', () => {
  it('result の項目を浅く重ね、warning の文を前置きなしで残す', () => {
    const collected = collectIo()
    const first = createOutput<{ a: number, b: string[] }>(false, collected.io)
    first.result({ a: 1, b: ['x'] })
    createOutput<{ b: string[] }>(false, collected.io).result({ b: ['y'] })
    first.warning('two\nlines')
    expect(collected.data()).toEqual({ a: 1, b: ['y'] })
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
