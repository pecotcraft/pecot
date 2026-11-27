import { describe, expect, it } from 'vitest'

import { COMMON_OUTPUT_KEYS } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { outputSchemaIssues } from '../../../tests/_helpers/mcp-client.js'
import { z } from 'zod'

import { COMMON_OUTPUT_PROPERTIES, collectIo, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from '../result.js'

describe('collectIo', () => {
  it('stdout と stderr に書いた文字列を、書いた順につなげて返す', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。標準出力と標準エラー出力へ交互に書いた場合は、それぞれ書いた順に連結した文字列を返すことを確認します。')
    const collected = collectIo()
    collected.io.stdout('a')
    collected.io.stderr('x')
    collected.io.stdout('b\n')
    collected.io.stderr('y\n')
    expect(collected.stdout()).toBe('ab\n')
    expect(collected.stderr()).toBe('xy\n')
  })

  it('標準入力を読む関数を持たない', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。集めた入出力の `readLine` が存在せず、`undefined` になることを確認します。')
    expect(collectIo().io.readLine).toBeUndefined()
  })

  it('失敗の種別は、最初に受け取ったものを残す', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。失敗の種別を 2 回受け取った場合に、最初の `not-on-board` を残し、受け取る前は `undefined` になることを確認します。')
    const collected = collectIo()
    expect(collected.kind()).toBeUndefined()
    collected.io.failureKind?.('not-on-board')
    collected.io.failureKind?.('other')
    expect(collected.kind()).toBe('not-on-board')
  })

  it('結果の行は、後始末の行を除いた最初のものを残す', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。後始末の行と通常の結果の行を続けて出力した場合に、後始末を除いた最初の `created: branch b/1` を結果の行にし、標準エラー出力にはすべて書くことを確認します。')
    const collected = collectIo()
    const out = createOutput(false, collected.io)
    out.done({ verb: 'delete', target: '1 archived items', aside: true })
    out.done({ verb: 'create', target: 'branch b/1' })
    out.done({ verb: 'set', target: 'x' })
    expect(collected.resultLine()).toBe('created: branch b/1')
    expect(collected.stderr()).toBe('deleted: 1 archived items\ncreated: branch b/1\nset: x\n')
  })

  it('dry-run の行は、結果の行として残す', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。dry-run の出力を受け取った場合に、`dry-run: would add y` を結果の行にすることを確認します。')
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
  it('成功の場合は、ツールの項目を structuredContent の最上位に置き、結果の行を text にして、isError を付けない', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コードが 0 の場合に、ツールの項目を `structuredContent` の最上位に置き、結果の行を文の `text` にして、`isError` を付けないことを確認します。')
    const result = toToolResult({ exitCode: 0, stdout: '', resultLine: 'created: branch b/1', data: { name: 'n' } })
    expect(result).toEqual({ content: contentOf('created: branch b/1', { name: 'n' }), structuredContent: { name: 'n' } })
  })

  it('成功で結果の行が存在しなければ、標準出力の最初の空でない行を文にする', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コードが 0 で結果の行がない場合に、標準出力の最初の空でない行を文の `text` にすることを確認します。')
    const result = toToolResult({ exitCode: 0, stdout: '\n  Board: Demo\nrow\n' })
    expect(result.content).toEqual(contentOf('Board: Demo', {}))
  })

  it('成功で、結果の行と標準出力が存在しない場合は、文の text を省き、JSON の text だけを返す', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コード 0 で結果の行と標準出力が存在しない場合は、文の `text` を省き、JSON の `text` だけを返すことを確認します。')
    const result = toToolResult({ exitCode: 0, stdout: '', warnings: ['w'] })
    expect(result).toEqual({ content: contentOf(undefined, { warnings: ['w'] }), structuredContent: { warnings: ['w'] } })
  })

  it('成功の structuredContent には、ok・exitCode・data・artifacts・message・kind・detail の項目を含めない', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コードが 0 の場合に、`structuredContent` のキーがツールの項目だけになり、`ok` や `exitCode` などの項目を含まないことを確認します。')
    const result = toToolResult({ exitCode: 0, stdout: 'x\n', data: { name: 'n' } })
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['name'])
  })

  it('失敗の場合は、kind と detail を最上位に置き、detail を text にして、isError を付ける', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コードが 0 以外の場合に、`kind` と、失敗の文を改行でつないだ `detail` を最上位に置き、`detail` を `text` にして `isError` を付けることを確認します。')
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['not found\n  hint: x', 'second'], kind: 'not-on-board', warnings: ['w'] })
    const structured = { kind: 'not-on-board', detail: 'not found\n  hint: x\nsecond', warnings: ['w'] }
    expect(result).toEqual({ content: contentOf(structured.detail, structured), structuredContent: structured, isError: true })
  })

  it('失敗で子プロセスの出力があれば、log に置く', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。失敗した結果に子プロセスの出力がある場合に、その出力を `log` に置くことを確認します。')
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['failed: fatal: x'], log: 'Preparing\nfatal: x\n', kind: 'other' })
    expect(result.structuredContent).toEqual({ kind: 'other', detail: 'failed: fatal: x', log: 'Preparing\nfatal: x\n' })
  })

  it('成功の場合は、log を置かない', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。終了コードが 0 の結果に `log` を渡した場合に、`structuredContent` に `log` を含めないことを確認します。')
    expect(toToolResult({ exitCode: 0, stdout: '', log: 'x' }).structuredContent).toEqual({})
  })

  it('失敗の場合は、途中まで進んだ項目を kind と detail に並べて置き、reason を置かない', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。失敗した結果に途中まで進んだ項目がある場合に、`kind` と `detail` に並べて置き、`reason` を置かないことを確認します。')
    const result = toToolResult({ exitCode: 1, stdout: '', errors: ['half'], kind: 'github-api', data: { name: 'x' } })
    expect(result.structuredContent).toEqual({ kind: 'github-api', detail: 'half', name: 'x' })
  })

  it('失敗の種別が存在しなければ other にし、detail と文が空なら JSON の text だけを返す', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。失敗の種別も失敗の文もない場合に、`kind` を `other`、`detail` を空文字にし、JSON の `text` だけを返すことを確認します。')
    const result = toToolResult({ exitCode: 3, stdout: '' })
    expect(result).toEqual({ content: contentOf(undefined, { kind: 'other', detail: '' }), structuredContent: { kind: 'other', detail: '' }, isError: true })
  })

  it('失敗の文が存在しなければ、渡された message を detail にする', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。失敗の文はなく `message` がある場合は、`message` を `detail` にすることを確認します。')
    expect(toToolResult({ exitCode: 2, stdout: '', kind: 'invalid-input', message: 'Missing argument' }).structuredContent).toEqual({ kind: 'invalid-input', detail: 'Missing argument' })
  })

  it('失敗の文があれば、message より優先して detail にする', async () => {
    await explains('ツールの呼び出し結果を作る `toToolResult` のテストです。失敗の文と `message` の両方がある場合に、失敗の文を `detail` にすることを確認します。')
    expect(toToolResult({ exitCode: 1, stdout: '', errors: ['e'], message: 'm' }).structuredContent).toEqual({ kind: 'other', detail: 'e' })
  })

  it('成功と失敗の structuredContent は outputSchema に合い、どちらでもない値と未知の項目は合わない', async () => {
    await explains('ツールの出力スキーマ `toolOutputSchema` のテストです。成功と失敗の `structuredContent` がスキーマに一致し、空の値と未知の項目を含む値は一致しないことを確認します。')
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
  it('最上位は type が object で、properties にツールの項目と共通の 4 項目を並べ、閉じた型にする', async () => {
    await explains('ツールの出力スキーマ `toolOutputSchema` のテストです。ツールの出力から生成したスキーマが、最上位を `object` にし、ツールの項目と共通の項目を `properties` に並べ、未知の項目を認めないことを確認します。')
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

  it('成功の必須項目が存在しなければ、anyOf を置かない', async () => {
    await explains('ツールの出力スキーマ `toolOutputSchema` のテストです。ツールの出力の項目がすべて省略できる場合に、スキーマに `anyOf` を置かず、`properties` の並びが期待どおりになることを確認します。')
    const schema = toolOutputSchema(z.strictObject({ file: z.string().optional() }))
    expect(schema).not.toHaveProperty('anyOf')
    const { properties } = PropertiesSchema.parse(schema)
    expect(Object.keys(properties)).toEqual(['file', 'kind', 'detail', 'log', 'warnings'])
  })

  it('スキーマに $schema の項目を持たない', async () => {
    await explains('ツールの出力スキーマ `toolOutputSchema` のテストです。生成したスキーマに `$schema` が含まれないことを確認します。')
    expect(toolOutputSchema(OUTPUT)).not.toHaveProperty('$schema')
  })

  it('共通の項目は、コマンドの定義が予約する名前と同じ集合になる', async () => {
    await explains('ツールの出力スキーマ `toolOutputSchema` のテストです。共通の項目の名前が、コマンドの定義で予約している名前と同じ集合で、重複もないことを確認します。')
    expect(new Set(Object.keys(COMMON_OUTPUT_PROPERTIES))).toEqual(new Set(COMMON_OUTPUT_KEYS))
    expect(COMMON_OUTPUT_KEYS).toHaveLength(new Set(COMMON_OUTPUT_KEYS).size)
  })
})

describe('toRejectedResult', () => {
  it('入力エラーの結果は、kind を invalid-input にし、断りの文を detail と text にする', async () => {
    await explains('入力エラーの結果を作る `toRejectedResult` のテストです。断りの文を渡した場合に、`kind` が `invalid-input` で、文が `detail` と `text` になり、`isError` が付くことを確認します。')
    const structured = { kind: 'invalid-input', detail: 'invalid input: x' }
    expect(toRejectedResult('invalid input: x')).toEqual({ content: contentOf('invalid input: x', structured), structuredContent: structured, isError: true })
  })
})

describe('toAbortedResult', () => {
  it('中断の結果は、kind を aborted、detail を cancelled にする', async () => {
    await explains('中断の結果を作る `toAbortedResult` のテストです。`structuredContent` が `kind` を `aborted`、`detail` を `cancelled` にすることを確認します。')
    expect(toAbortedResult().structuredContent).toEqual({ kind: 'aborted', detail: 'cancelled' })
  })
})

describe('collectIo の項目・warnings・errors・log', () => {
  it('error の文は、前置きなしで続きの行の字下げを残して集め、標準エラーの行は拾わない', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。複数行の error を出力した場合に、前置きを除いて続きの行の字下げを残して集め、標準エラー出力の行は集めないことを確認します。')
    const collected = collectIo()
    const out = createOutput(false, collected.io)
    out.error('first\nhint: x')
    out.done({ verb: 'add', target: 'y' })
    out.error('second')
    expect(collected.errors()).toEqual(['first\n  hint: x', 'second'])
    expect(collected.stderr()).toBe('error: first\n  hint: x\nadded: y\nerror: second\n')
  })

  it('detail と log は、標準エラーへ書かずに集める', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。`detail` と `log` を出力した場合に、標準エラー出力へは書かず、それぞれ集めた値として返すことを確認します。')
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

  it('log を受け取っていなければ、undefined を返す', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。`log` を一度も受け取っていない場合に、`log()` が `undefined` を返すことを確認します。')
    expect(collectIo().log()).toBeUndefined()
  })

  it('result の項目を浅く重ねて集め、warning の文を前置きなしで、続きの行の字下げを残して集める', async () => {
    await explains('MCP の呼び出し中の入出力を集める `collectIo` のテストです。`result` を 2 回受け取った場合に、後から受け取った項目で浅く上書きし、`warning` は前置きを除いて字下げを残して集めることを確認します。')
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
