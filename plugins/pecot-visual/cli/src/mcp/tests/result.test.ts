/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の mutable な型を使う */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { verifies } from '../../../tests/_helpers/verifies.js'
import {
  createOutputCapture,
  parsePathArguments,
  toCallToolResult,
  toolOutputSchema,
  truncateCapturedText,
  withoutCommonFailureFields,
  type ToolResult,
} from '../result.js'
import { allTools } from '../tools/index.js'

/**
createOutputCapture が保持する上限 (src/mcp/result.ts の OUTPUT_CAPTURE_LIMIT_BYTES と同値)。
*/
const LIMIT_BYTES = 64 * 1024

const BASE_RESULT: ToolResult = {
  ok: true,
  data: { url: 'https://example.invalid/x', file: '/tmp/out.drawio' },
  message: 'done',
}

const FAILED_RESULT: ToolResult = {
  ok: false,
  kind: 'invalid-path',
  detail: 'relative path',
  data: { invalidPaths: ['a=b'] },
}

function textsOf(result: Readonly<ReturnType<typeof toCallToolResult>>): string[] {
  return result.content.map(block => (block.type === 'text' ? block.text : ''))
}

describe('toCallToolResult', () => {
  it('成功のとき、ツールの項目を structuredContent の最上位に置き、入れ物の項目と isError を持たない', () => {
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toStrictEqual({ url: 'https://example.invalid/x', file: '/tmp/out.drawio' })
  })

  it('content の 2 つ目の text が、structuredContent の JSON と 1 字も違わない', async (context) => {
    await verifies(context, 'PV-COMMON-06')
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const converted = toCallToolResult(result)

      expect(textsOf(converted)).toHaveLength(2)
      expect(textsOf(converted)[1]).toBe(JSON.stringify(converted.structuredContent))
    }
  })

  it('成功のとき、content の 1 つ目の text に文を入れ、文が空なら JSON の text だけにする', () => {
    expect(textsOf(toCallToolResult(BASE_RESULT))[0]).toBe('done')
    expect(textsOf(toCallToolResult({ ...BASE_RESULT, message: '' })))
      .toStrictEqual(['{"url":"https://example.invalid/x","file":"/tmp/out.drawio"}'])
  })

  it('失敗のとき、isError を立て、ツールの項目に kind と detail を重ね、reason を持たない', async (context) => {
    await verifies(context, 'PV-COMMON-07')
    const converted = toCallToolResult(FAILED_RESULT)

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toStrictEqual({ invalidPaths: ['a=b'], kind: 'invalid-path', detail: 'relative path' })
    expect(textsOf(converted)[0]).toBe('relative path')
  })

  it('ツールの項目に kind と detail があると、共通の値で上書きする', () => {
    const converted = toCallToolResult({ ok: false, kind: 'export-failed', detail: 'export failed', data: { kind: 'x', detail: 'theme is broken' } })

    expect(converted.structuredContent).toStrictEqual({ kind: 'export-failed', detail: 'export failed' })
  })

  it('stdout・stderr・exitCode を持たない', () => {
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const content = toCallToolResult(result).structuredContent
      for (const key of ['ok', 'exitCode', 'artifacts', 'data', 'message', 'stdout', 'stderr']) expect(content).not.toHaveProperty(key)
    }
  })
})

describe('withoutCommonFailureFields', () => {
  it('CLI の失敗の payload から reason と detail を外し、ほかの項目を残す', () => {
    expect(withoutCommonFailureFields({ event: 'x.error', reason: 'invalid-theme', detail: 'broken', file: '/a' }))
      .toStrictEqual({ event: 'x.error', file: '/a' })
  })
})

describe('toolOutputSchema', () => {
  it.for(['kind', 'detail', 'log', 'warnings'])('output が共通の項目の名前 %s を持つと、例外を投げる', (key) => {
    expect(() => toolOutputSchema(z.strictObject({ file: z.string(), [key]: z.string() })))
      .toThrow(new TypeError(`output keys reserved for the common fields of the MCP result: ${key}`))
  })

  it('全ツールの output は、共通の項目の名前を持たず、例外を投げない', () => {
    const outputs = allTools().flatMap(tool => tool.config.outputSchema === undefined ? [] : [tool.config.outputSchema])
    expect(outputs).toHaveLength(allTools().length)
    for (const output of outputs) expect(() => toolOutputSchema(output)).not.toThrow()
  })
})

/**
パス引数を 2 件持つ、代表的なツールと同形のスキーマ。
*/
const PATH_SCHEMA = z.object({
  input_path: z.string(),
  out_path: z.string().optional(),
  png: z.boolean().default(true),
})

/**
注入する mount root。実在しない合成パスで、この層は文字列の組み立てしか見ない。
*/
const MOUNT_ROOT = '/pecotv-1094-mount'

/**
拒否結果の detail。拒否でなければテストを落とす。
*/
function detailOf(result: Readonly<ToolResult> | undefined): string {
  if (result === undefined || result.ok) throw new Error('expected a rejection')
  return result.detail
}

describe('parsePathArguments', () => {
  beforeEach(() => {
    vi.stubEnv('PECOTV_WSL_MOUNT_ROOT', MOUNT_ROOT)
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('全て絶対パスなら検証済みの引数をそのまま返す', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: '/a/b.drawio', out_path: '/a/c.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected).toBeUndefined()
    expect(parsed.input).toEqual({ input_path: '/a/b.drawio', out_path: '/a/c.png', png: true })
  })

  it('省略された任意パスは素通しする', () => {
    const parsed = parsePathArguments(PATH_SCHEMA, { input_path: '/a/b.drawio' }, ['input_path', 'out_path'])

    expect(parsed.rejected).toBeUndefined()
    expect(parsed.input).toEqual({ input_path: '/a/b.drawio', png: true })
  })

  it('Windows 形式のパスを変換した値をハンドラへ渡す', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: String.raw`C:\deck\a.drawio`, out_path: String.raw`\\wsl.localhost\Ubuntu\home\a.png` },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected).toBeUndefined()
    expect(parsed.input).toEqual({
      input_path: `${MOUNT_ROOT}/c/deck/a.drawio`,
      out_path: '/home/a.png',
      png: true,
    })
  })

  it('相対パスが 1 件でもあれば invalid-path の拒否結果を返す', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: '/a/b.drawio', out_path: 'relative/c.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.input).toBeUndefined()
    expect(parsed.rejected).toMatchObject({
      ok: false,
      kind: 'invalid-path',
      data: { invalidPaths: ['out_path=relative/c.png'] },
    })
    expect(detailOf(parsed.rejected)).toContain('must be an absolute path')
    // 変換が 1 件も起きていないので convertedPaths は載せない。
    expect(parsed.rejected?.data).not.toHaveProperty('convertedPaths')
  })

  it('拒否結果の structuredContent は最上位に kind: invalid-path を持つ', () => {
    const parsed = parsePathArguments(PATH_SCHEMA, { input_path: 'talks/demo' }, ['input_path'])
    if (parsed.rejected === undefined) throw new Error('相対パスが受理された')

    expect(toCallToolResult(parsed.rejected).structuredContent).toMatchObject({
      kind: 'invalid-path',
      invalidPaths: ['input_path=talks/demo'],
    })
  })

  it('複数の相対パスを全件列挙する', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: './a.drawio', out_path: 'b.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected?.data['invalidPaths']).toEqual(['input_path=./a.drawio', 'out_path=b.png'])
  })

  it('拒否結果には利用者が渡した元の値と、変換した項目の対応をパラメータ名で載せる', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: String.raw`C:\deck\a.drawio`, out_path: 'relative/c.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected?.data).toEqual({
      invalidPaths: ['out_path=relative/c.png'],
      convertedPaths: { input_path: { from: String.raw`C:\deck\a.drawio`, to: `${MOUNT_ROOT}/c/deck/a.drawio` } },
    })
  })

  it('変換できない Windows 形式は専用の文言で弾く', async (context) => {
    await verifies(context, 'PV-COMMON-05')
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: String.raw`\\wsl.localhost\Debian\home\a.drawio`, out_path: String.raw`C:\deck\a.png` },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected).toMatchObject({
      ok: false,
      kind: 'invalid-path',
      data: {
        invalidPaths: [String.raw`input_path=\\wsl.localhost\Debian\home\a.drawio`],
        convertedPaths: { out_path: { from: String.raw`C:\deck\a.png`, to: `${MOUNT_ROOT}/c/deck/a.png` } },
      },
    })
    expect(detailOf(parsed.rejected)).toContain('Windows-style')
    expect(detailOf(parsed.rejected)).toContain('Debian')
  })

  it('解決不能と相対パスが両方含まれるときはそれぞれを invalidPaths に列挙し、解決不能側を detail の主文にする', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: 'C:relative', out_path: 'b.png' },
      ['input_path', 'out_path'],
    )

    // 旧仕様 (解決不能があると相対パス側の違反を隠す) から、両方を列挙する形へ変えた (#1094 F-06)。
    expect(parsed.rejected?.data['invalidPaths']).toEqual(['input_path=C:relative', 'out_path=b.png'])
    expect(detailOf(parsed.rejected)).toContain('cannot resolve Windows-style path')
    expect(detailOf(parsed.rejected)).toContain('C:relative')
    expect(detailOf(parsed.rejected)).toContain('must be an absolute path')
    expect(detailOf(parsed.rejected)).toContain('out_path=b.png')
    // 解決不能側を主文にする: detail の先頭がそちらであること。
    expect(detailOf(parsed.rejected).startsWith('cannot resolve Windows-style')).toBe(true)
  })
})

describe('createOutputCapture', () => {
  it('書き込まれた文字列と Buffer を連結して取り出せる', async () => {
    const capture = createOutputCapture()

    // 文字列で write しても decodeStrings 既定 true により _write には Buffer で届く。
    capture.stream.write('hello ')
    capture.stream.write(Buffer.from('world', 'utf8'))
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    expect(capture.text()).toBe('hello world')
  })

  it('未書き込みなら空文字を返す', () => {
    expect(createOutputCapture().text()).toBe('')
  })

  it('上限ちょうどまでは切り詰めずに全量を返す', async () => {
    const capture = createOutputCapture()

    capture.stream.write('a'.repeat(LIMIT_BYTES))
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const text = capture.text()
    expect(text).toHaveLength(LIMIT_BYTES)
    expect(text).not.toContain('truncated')
  })

  it('上限を超えたら先頭を捨てて末尾を残し、切り詰めをマーカー行で明示する', async (context) => {
    await verifies(context, 'PV-COMMON-11')
    // 失敗の直接原因は末尾に出るため、残すのは新しい側。
    const capture = createOutputCapture()

    capture.stream.write('x'.repeat(LIMIT_BYTES))
    capture.stream.write('tail-marker')
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const text = capture.text()
    const [marker, ...rest] = text.split('\n')
    expect(marker).toContain(String(LIMIT_BYTES))
    expect(marker).toContain('truncated')
    // 残るのは上限ちょうど分の末尾で、捨てられたのは先頭 'tail-marker'.length バイト。
    const retained = rest.join('\n')
    expect(retained).toHaveLength(LIMIT_BYTES)
    expect(retained.endsWith('tail-marker')).toBe(true)
    expect(retained.startsWith('x')).toBe(true)
  })

  it('小さな write の積み重ねでは、上限を超えた分を chunk ごと捨てる', async () => {
    // 実際の捕捉は 1 行ずつの write が積み上がる形なので、境界にかからない古い chunk は
    // 丸ごと落ちる (部分切り出しが起きるのは境界にかかった 1 件だけ)。
    const capture = createOutputCapture()
    const line = 'x'.repeat(1024)

    for (let index = 0; index < (LIMIT_BYTES / 1024) * 2; index += 1) {
      capture.stream.write(line)
    }
    capture.stream.write('END')
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const retained = capture.text().split('\n').slice(1).join('\n')
    expect(retained).toHaveLength(LIMIT_BYTES)
    expect(retained.endsWith('END')).toBe(true)
  })

  it('1 回の write が上限を超えても、その chunk の末尾だけを残す', async () => {
    const capture = createOutputCapture()

    capture.stream.write('y'.repeat(LIMIT_BYTES * 2) + 'END')
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const retained = capture.text().split('\n').slice(1).join('\n')
    expect(retained).toHaveLength(LIMIT_BYTES)
    expect(retained.endsWith('END')).toBe(true)
  })

  it('chunk 境界で分割されたマルチバイト文字を壊さない', async () => {
    const capture = createOutputCapture()
    const source = Buffer.from('警告', 'utf8')

    capture.stream.write(source.subarray(0, 2))
    capture.stream.write(source.subarray(2))
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    expect(capture.text()).toBe('警告')
  })
})

describe('truncateCapturedText', () => {
  // 子プロセスの結果 (SpawnResult) は Writable を経由しないため、上限は別エントリで働かせる。
  // `playwright install` は非 TTY でも進捗を stdout へ書くので、素通しするとエージェントの
  // コンテキストを際限なく食う。

  it('上限以内はそのまま返す', () => {
    expect(truncateCapturedText('download failed')).toBe('download failed')
  })

  it('上限を超えたら末尾だけを残し、切り詰めたことを冒頭で明示する', async (context) => {
    await verifies(context, 'PV-COMMON-11')
    const retained = truncateCapturedText('z'.repeat(LIMIT_BYTES * 2) + 'END')
    const body = retained.split('\n').slice(1).join('\n')

    expect(retained.startsWith('[pecotv]')).toBe(true)
    expect(body).toHaveLength(LIMIT_BYTES)
    // 失敗の直接原因は末尾に出るので、残すのは新しい方。
    expect(body.endsWith('END')).toBe(true)
  })
})
