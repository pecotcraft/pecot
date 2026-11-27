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
import { explains } from '../../../tests/_helpers/explains.js'

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
  it('成功のとき、ツールの項目を structuredContent の最上位に置き、入れ物の項目と isError を持たない', async () => {
    await explains('ツールの結果を MCP の応答に変換する `toCallToolResult` の、成功時のテストです。ツールの項目が `structuredContent` の最上位に置かれ、`isError` を含まないことを確認します。')
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toStrictEqual({ url: 'https://example.invalid/x', file: '/tmp/out.drawio' })
  })

  it('content の 2 つ目の text は、structuredContent の JSON と同じ内容になる', async (context) => {
    await verifies(context, 'PV-COMMON-06')
    await explains('成功と失敗のどちらの結果についても、`toCallToolResult` を実行した場合のテストです。`content` の 2 つ目の `text` が、`structuredContent` を JSON にした文字列と同じ内容になることを確認します。')
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const converted = toCallToolResult(result)

      expect(textsOf(converted)).toHaveLength(2)
      expect(textsOf(converted)[1]).toBe(JSON.stringify(converted.structuredContent))
    }
  })

  it('成功のときは、content の 1 つ目の text にメッセージを入れ、メッセージが空なら JSON の text だけにする', async () => {
    await explains('`toCallToolResult` の成功時の `content` のテストです。メッセージがある場合は 1 つ目の `text` にメッセージが入り、メッセージが空の場合は JSON の `text` だけになることを確認します。')
    expect(textsOf(toCallToolResult(BASE_RESULT))[0]).toBe('done')
    expect(textsOf(toCallToolResult({ ...BASE_RESULT, message: '' })))
      .toStrictEqual(['{"url":"https://example.invalid/x","file":"/tmp/out.drawio"}'])
  })

  it('失敗のとき、isError を立て、ツールの項目に kind と detail を重ね、reason を持たない', async (context) => {
    await verifies(context, 'PV-COMMON-07')
    await explains('`toCallToolResult` の失敗時のテストです。`isError` が `true` になり、ツールの項目に `kind` と `detail` が加わり、`reason` を含まず、1 つ目の `text` が `detail` と同じになることを確認します。')
    const converted = toCallToolResult(FAILED_RESULT)

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toStrictEqual({ invalidPaths: ['a=b'], kind: 'invalid-path', detail: 'relative path' })
    expect(textsOf(converted)[0]).toBe('relative path')
  })

  it('ツールの項目に kind と detail がある場合は、共通の値で上書きする', async () => {
    await explains('ツールの項目に `kind` と `detail` が含まれる失敗の結果を変換した場合のテストです。ツールの項目の値ではなく、結果に指定した共通の `kind` と `detail` が使われることを確認します。')
    const converted = toCallToolResult({ ok: false, kind: 'export-failed', detail: 'export failed', data: { kind: 'x', detail: 'theme is broken' } })

    expect(converted.structuredContent).toStrictEqual({ kind: 'export-failed', detail: 'export failed' })
  })

  it('変換した結果は、stdout・stderr・exitCode を持たない', async () => {
    await explains('成功と失敗のどちらの結果についても、`toCallToolResult` を実行した場合のテストです。`structuredContent` に `ok`、`exitCode`、`stdout`、`stderr` などの項目が含まれないことを確認します。')
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const content = toCallToolResult(result).structuredContent
      for (const key of ['ok', 'exitCode', 'artifacts', 'data', 'message', 'stdout', 'stderr']) expect(content).not.toHaveProperty(key)
    }
  })
})

describe('withoutCommonFailureFields', () => {
  it('CLI の失敗の出力から reason と detail を取り除き、ほかの項目は残す', async () => {
    await explains('CLI の失敗の出力から、共通の項目を取り除く `withoutCommonFailureFields` のテストです。`reason` と `detail` が取り除かれ、`event` や `file` などのほかの項目が残ることを確認します。')
    expect(withoutCommonFailureFields({ event: 'x.error', reason: 'invalid-theme', detail: 'broken', file: '/a' }))
      .toStrictEqual({ event: 'x.error', file: '/a' })
  })
})

describe('toolOutputSchema', () => {
  it.for(['kind', 'detail', 'log', 'warnings'])('output が共通の項目の名前 %s を持つ場合は、例外が発生する', async (key) => {
    await explains(`出力スキーマを作成する \`toolOutputSchema\` に、共通の項目名と同じ名前の項目を持つスキーマを渡した場合のテストです。\`${key}\` が予約された名前であることを示す \`TypeError\` が発生することを確認します。`)
    expect(() => toolOutputSchema(z.strictObject({ file: z.string(), [key]: z.string() })))
      .toThrow(new TypeError(`output keys reserved for the common fields of the MCP result: ${key}`))
  })

  it('すべてのツールの output は、共通の項目の名前を持たず、例外が発生しない', async () => {
    await explains('公開しているすべてのツールの出力スキーマについて、`toolOutputSchema` を実行した場合のテストです。出力スキーマがすべてのツールに定義されていて、例外が発生しないことを確認します。')
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

  it('すべて絶対パスの場合は、検証済みの引数をそのまま返す', async () => {
    await explains('パスの引数を検証する `parsePathArguments` のテストです。すべてのパスが絶対パスの場合に、拒否の結果を返さず、検証済みの引数（`png` の既定値を含む）をそのまま返すことを確認します。')
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: '/a/b.drawio', out_path: '/a/c.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected).toBeUndefined()
    expect(parsed.input).toEqual({ input_path: '/a/b.drawio', out_path: '/a/c.png', png: true })
  })

  it('省略された任意のパスは、検証せずに通す', async () => {
    await explains('パスの引数のうち、任意のパス（`out_path`）を省略した場合のテストです。拒否の結果を返さず、省略した項目を含まない検証済みの引数を返すことを確認します。')
    const parsed = parsePathArguments(PATH_SCHEMA, { input_path: '/a/b.drawio' }, ['input_path', 'out_path'])

    expect(parsed.rejected).toBeUndefined()
    expect(parsed.input).toEqual({ input_path: '/a/b.drawio', png: true })
  })

  it('Windows 形式のパスは、変換した値をハンドラへ渡す', async () => {
    await explains('`C:\\` で始まるパスと `\\\\wsl.localhost\\` で始まるパスを渡した場合のテストです。それぞれ、マウントルートの配下のパスと、WSL 内のパス（`/home/a.png`）に変換されることを確認します。')
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

  it('相対パスが 1 件でもある場合は、invalid-path の拒否の結果を返す', async () => {
    await explains('パスの引数に、相対パスが 1 件含まれる場合のテストです。`invalid-path` の拒否の結果を返し、`invalidPaths` に該当する項目だけが含まれることと、`convertedPaths` を含まないことを確認します。')
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

  it('拒否の結果の structuredContent は、最上位に kind として invalid-path を持つ', async () => {
    await explains('相対パスによる拒否の結果を、`toCallToolResult` で変換した場合のテストです。`structuredContent` の最上位に、`kind` が `invalid-path` であることと、`invalidPaths` が含まれることを確認します。')
    const parsed = parsePathArguments(PATH_SCHEMA, { input_path: 'talks/demo' }, ['input_path'])
    if (parsed.rejected === undefined) throw new Error('相対パスが受理された')

    expect(toCallToolResult(parsed.rejected).structuredContent).toMatchObject({
      kind: 'invalid-path',
      invalidPaths: ['input_path=talks/demo'],
    })
  })

  it('複数の相対パスは、すべて列挙する', async () => {
    await explains('複数のパスの引数が、相対パスである場合のテストです。`invalidPaths` に、該当するすべてのパスがパラメーター名とともに含まれることを確認します。')
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: './a.drawio', out_path: 'b.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected?.data['invalidPaths']).toEqual(['input_path=./a.drawio', 'out_path=b.png'])
  })

  it('拒否の結果には、変換した項目の変換前と変換後の値を、パラメータ名ごとに含める', async () => {
    await explains('Windows 形式のパスと相対パスを一緒に渡した場合のテストです。相対パスは `invalidPaths` に含まれ、変換できた Windows 形式のパスは、変換前と変換後の値が `convertedPaths` に含まれることを確認します。')
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

  it('変換できない Windows 形式のパスは、専用のメッセージで拒否する', async (context) => {
    await verifies(context, 'PV-COMMON-05')
    await explains('変換できない Windows 形式のパス（別のディストリビューションの WSL のパス）を渡した場合のテストです。`Windows-style` と、そのディストリビューション名を含むメッセージで拒否し、変換できたパスは `convertedPaths` に含めることを確認します。')
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

  it('解決できないパスと相対パスが両方ある場合は、どちらも invalidPaths に含め、解決できないパスの説明を detail の先頭にする', async () => {
    await explains('解決できない Windows 形式のパスと、相対パスを一緒に渡した場合のテストです。両方が `invalidPaths` に含まれ、`detail` は解決できないパスの説明で始まり、相対パスについての説明も含むことを確認します。')
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
  it('書き込んだ文字列と Buffer を連結して取り出せる', async () => {
    await explains('出力を捕捉する `createOutputCapture` のテストです。文字列と `Buffer` を続けて書き込んだ場合に、連結した文字列（`hello world`）を取り出せることを確認します。')
    const capture = createOutputCapture()

    // 文字列で write しても decodeStrings 既定 true により _write には Buffer で届く。
    capture.stream.write('hello ')
    capture.stream.write(Buffer.from('world', 'utf8'))
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    expect(capture.text()).toBe('hello world')
  })

  it('何も書き込んでいない場合は、空の文字列を返す', async () => {
    await explains('何も書き込んでいない `createOutputCapture` のテストです。取り出した文字列が空であることを確認します。')
    expect(createOutputCapture().text()).toBe('')
  })

  it('上限と同じ大きさまでは、切り詰めずにすべてを返す', async () => {
    await explains('上限（64 KiB）と同じ大きさの文字列を書き込んだ場合のテストです。切り詰めずにすべてを返し、切り詰めを示す表示を含まないことを確認します。')
    const capture = createOutputCapture()

    capture.stream.write('a'.repeat(LIMIT_BYTES))
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const text = capture.text()
    expect(text).toHaveLength(LIMIT_BYTES)
    expect(text).not.toContain('truncated')
  })

  it('上限を超えた場合は、先頭を捨てて末尾を残し、切り詰めたことを先頭の行で示す', async (context) => {
    await verifies(context, 'PV-COMMON-11')
    await explains('上限を超える文字列を書き込んだ場合のテストです。先頭の行に上限の値と `truncated` が表示され、その後に上限と同じ大きさの末尾が残ることを確認します。')
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

  it('小さな書き込みが積み重なって上限を超えた場合は、古い書き込みを単位として捨てる', async () => {
    await explains('1 KiB ずつの書き込みを繰り返して、上限を大きく超えた場合のテストです。残る文字列が上限と同じ大きさで、最後に書き込んだ内容（`END`）で終わることを確認します。')
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

  it('1 回の書き込みが上限を超えた場合は、その末尾だけを残す', async () => {
    await explains('1 回の書き込みで、上限の 2 倍を超える文字列を書き込んだ場合のテストです。残る文字列が上限と同じ大きさで、書き込んだ内容の末尾（`END`）で終わることを確認します。')
    const capture = createOutputCapture()

    capture.stream.write('y'.repeat(LIMIT_BYTES * 2) + 'END')
    await new Promise<void>((resolve) => {
      capture.stream.end(resolve)
    })

    const retained = capture.text().split('\n').slice(1).join('\n')
    expect(retained).toHaveLength(LIMIT_BYTES)
    expect(retained.endsWith('END')).toBe(true)
  })

  it('書き込みの区切りで分割されたマルチバイト文字を、壊さずに取り出す', async () => {
    await explains('1 つの日本語の文字列（`警告`）を、文字の途中で 2 回に分けて書き込んだ場合のテストです。取り出した文字列が、元の文字列と同じになることを確認します。')
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

  it('上限以内の文字列は、そのまま返す', async () => {
    await explains('子プロセスの出力を切り詰める `truncateCapturedText` のテストです。上限以内の文字列を渡した場合に、変更せずにそのまま返すことを確認します。')
    expect(truncateCapturedText('download failed')).toBe('download failed')
  })

  it('上限を超えた場合は、末尾だけを残し、切り詰めたことを先頭で示す', async (context) => {
    await verifies(context, 'PV-COMMON-11')
    await explains('上限を超える文字列を `truncateCapturedText` に渡した場合のテストです。先頭に `[pecotv]` で始まる行が加わり、その後に上限と同じ大きさの末尾（`END` で終わる部分）が残ることを確認します。')
    const retained = truncateCapturedText('z'.repeat(LIMIT_BYTES * 2) + 'END')
    const body = retained.split('\n').slice(1).join('\n')

    expect(retained.startsWith('[pecotv]')).toBe(true)
    expect(body).toHaveLength(LIMIT_BYTES)
    // 失敗の直接原因は末尾に出るので、残すのは新しい方。
    expect(body.endsWith('END')).toBe(true)
  })
})
