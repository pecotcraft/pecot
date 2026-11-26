import { describe, expect, it } from 'vitest'

import { COMMON_OUTPUT_KEYS } from '../../commands/command-definition.js'
import { createOutput } from '../../commands/output.js'
import { outputSchemaIssues } from '../../../tests/_helpers/mcp-client.js'
import { z } from 'zod'

import { COMMON_OUTPUT_PROPERTIES, collectIo, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from '../result.js'

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
    const result = toToolResult({ exitCode: 0, stdout: '', resultLine: 'created: branch b/1', data: { name: 'n' } })
    expect(result).toEqual({ content: contentOf('created: branch b/1', { name: 'n' }), structuredContent: { name: 'n' } })
  })

  it('成功で結果の行が無ければ、stdout の最初の空でない行を文にする', () => {
    const result = toToolResult({ exitCode: 0, stdout: '\n  Board: Demo\nrow\n' })
    expect(result.content).toEqual(contentOf('Board: Demo', {}))
  })

  it('成功で結果の行と stdout のどちらも無ければ、文の text を省き、JSON の text だけを返す', () => {
    const result = toToolResult({ exitCode: 0, stdout: '', warnings: ['w'] })
    expect(result).toEqual({ content: contentOf(undefined, { warnings: ['w'] }), structuredContent: { warnings: ['w'] } })
  })

  it('成功の structuredContent に、ok・exitCode・data・artifacts・message・kind・detail が無い', () => {
    const result = toToolResult({ exitCode: 0, stdout: 'x\n', data: { name: 'n' } })
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['name'])
  })

  it('失敗は kind と、失敗の文を改行でつないだ detail を最上位に置き、detail を文の text にして、isError を付ける', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['not found\n  hint: x', 'second'], kind: 'not-on-board', warnings: ['w'] })
    const structured = { kind: 'not-on-board', detail: 'not found\n  hint: x\nsecond', warnings: ['w'] }
    expect(result).toEqual({ content: contentOf(structured.detail, structured), structuredContent: structured, isError: true })
  })

  it('失敗で子プロセスの出力があれば、log に置く', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['failed: fatal: x'], log: 'Preparing\nfatal: x\n', kind: 'other' })
    expect(result.structuredContent).toEqual({ kind: 'other', detail: 'failed: fatal: x', log: 'Preparing\nfatal: x\n' })
  })

  it('成功では、log を置かない', () => {
    expect(toToolResult({ exitCode: 0, stdout: '', log: 'x' }).structuredContent).toEqual({})
  })

  it('失敗では、途中まで進んだ項目を kind・detail と並べて置き、reason を置かない', () => {
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['half'], kind: 'github-api', data: { name: 'x' } })
    expect(result.structuredContent).toEqual({ kind: 'github-api', detail: 'half', name: 'x' })
  })

  it('失敗で名前が無ければ other にし、detail と文が空なら JSON の text だけを返す', () => {
    const result = toToolResult({ exitCode: 3, stdout: '' })
    expect(result).toEqual({ content: contentOf(undefined, { kind: 'other', detail: '' }), structuredContent: { kind: 'other', detail: '' }, isError: true })
  })

  it('失敗の文が無ければ、渡された message を detail にする', () => {
    expect(toToolResult({ exitCode: 2, stdout: '', kind: 'invalid-input', message: 'Missing argument' }).structuredContent).toEqual({ kind: 'invalid-input', detail: 'Missing argument' })
  })

  it('失敗の文があれば、message より先に使う', () => {
    expect(toToolResult({ exitCode: 1, stdout: '', errors: ['e'], message: 'm' }).structuredContent).toEqual({ kind: 'other', detail: 'e' })
  })

  it('成功と失敗の structuredContent は、どちらも outputSchema に合い、どちらでもない値と未知の項目は合わない', async () => {
    const schema = toolOutputSchema(OUTPUT)
    const failure = toToolResult({ exitCode: 1, stdout: 'a', errors: ['b'], kind: 'github-api' })
    const success = toToolResult({ exitCode: 0, stdout: '', data: { name: 'n' }, warnings: ['w'] })
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

  it('共通の項目は、コマンドの定義が予約名にする名前と同じ集合になる', () => {
    expect(new Set(Object.keys(COMMON_OUTPUT_PROPERTIES))).toEqual(new Set(COMMON_OUTPUT_KEYS))
    expect(COMMON_OUTPUT_KEYS).toHaveLength(new Set(COMMON_OUTPUT_KEYS).size)
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

describe('collectIo の項目・warnings・errors・log', () => {
  it('error の文を、前置きなしで、続きの行の字下げを残して集め、標準エラーの行は拾わない', () => {
    const collected = collectIo()
    const out = createOutput(false, collected.io)
    out.error('first\nhint: x')
    out.done({ verb: 'add', target: 'y' })
    out.error('second')
    expect(collected.errors()).toEqual(['first\n  hint: x', 'second'])
    expect(collected.stderr()).toBe('error: first\n  hint: x\nadded: y\nerror: second\n')
  })

  it('detail と log は、標準エラーへ書かずに集める', () => {
    const collected = collectIo()
    const out = createOutput(false, collected.io)
    out.detail('only for mcp')
    out.log('a\n')
    out.log('  ')
    out.log('b\n')
    expect(collected.errors()).toEqual(['only for mcp'])
    expect(collected.log()).toBe('a\n\nb\n')
    expect(collected.stderr()).toBe('')
  })

  it('log を受けていなければ、undefined を返す', () => {
    expect(collectIo().log()).toBeUndefined()
  })

  it('result の項目を浅く重ね、warning の文を前置きなしで、続きの行の字下げを残して集める', () => {
    const collected = collectIo()
    const first = createOutput<{ a: number, b: string[] }>(false, collected.io)
    first.result({ a: 1, b: ['x'] })
    createOutput<{ b: string[] }>(false, collected.io).result({ b: ['y'] })
    first.warning('two\nlines')
    expect(collected.data()).toEqual({ a: 1, b: ['y'] })
    expect(collected.warnings()).toEqual(['two\n  lines'])
    expect(collected.stderr()).toBe('warning: two\n  lines\n')
  })
})
