import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createOutputCapture,
  parsePathArguments,
  toCallToolResult,
  truncateCapturedText,
  type ToolResult,
} from '../result.js'

/**
createOutputCapture が保持する上限 (src/mcp/result.ts の OUTPUT_CAPTURE_LIMIT_BYTES と同値)。
*/
const LIMIT_BYTES = 64 * 1024

const BASE_RESULT: ToolResult = {
  ok: true,
  exitCode: 0,
  artifacts: ['/tmp/out.drawio'],
  data: { url: 'https://example.invalid/x' },
  message: 'done',
}

describe('toCallToolResult', () => {
  it('成功時は isError を持たず structuredContent と同内容の JSON テキストを載せる', () => {
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toEqual({
      ok: true,
      exitCode: 0,
      artifacts: ['/tmp/out.drawio'],
      data: { url: 'https://example.invalid/x' },
      message: 'done',
    })
    const [block] = converted.content
    expect(block).toMatchObject({ type: 'text' })
    expect(JSON.parse(block?.type === 'text' ? block.text : '')).toEqual(converted.structuredContent)
  })

  it('exitCode を保持しつつ ok: false を isError: true に連動させる', () => {
    const converted = toCallToolResult({ ...BASE_RESULT, ok: false, exitCode: 3, message: 'warnings' })

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toMatchObject({ ok: false, exitCode: 3, message: 'warnings' })
  })

  it('stdout / stderr は与えられたときだけ structuredContent に現れる', () => {
    const without = toCallToolResult(BASE_RESULT)
    expect(without.structuredContent).not.toHaveProperty('stdout')
    expect(without.structuredContent).not.toHaveProperty('stderr')

    const with_ = toCallToolResult({ ...BASE_RESULT, stdout: 'out', stderr: 'err' })
    expect(with_.structuredContent).toMatchObject({ stdout: 'out', stderr: 'err' })
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

  it('相対パスが 1 件でもあれば exitCode 2 の拒否結果を返す', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: '/a/b.drawio', out_path: 'relative/c.png' },
      ['input_path', 'out_path'],
    )

    expect(parsed.input).toBeUndefined()
    expect(parsed.rejected).toMatchObject({
      ok: false,
      exitCode: 2,
      artifacts: [],
      data: { invalidPaths: ['out_path=relative/c.png'] },
    })
    expect(parsed.rejected?.message).toContain('must be an absolute path')
    // 変換が 1 件も起きていないので convertedPaths は載せない。
    expect(parsed.rejected?.data).not.toHaveProperty('convertedPaths')
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

  it('変換できない Windows 形式は専用の文言で弾く', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: String.raw`\\wsl.localhost\Debian\home\a.drawio`, out_path: String.raw`C:\deck\a.png` },
      ['input_path', 'out_path'],
    )

    expect(parsed.rejected).toMatchObject({
      ok: false,
      exitCode: 2,
      artifacts: [],
      data: {
        invalidPaths: [String.raw`input_path=\\wsl.localhost\Debian\home\a.drawio`],
        convertedPaths: { out_path: { from: String.raw`C:\deck\a.png`, to: `${MOUNT_ROOT}/c/deck/a.png` } },
      },
    })
    expect(parsed.rejected?.message).toContain('Windows-style')
    expect(parsed.rejected?.message).toContain('Debian')
  })

  it('解決不能と相対パスが両方含まれるときはそれぞれを invalidPaths に列挙し、解決不能側を message の主文にする', () => {
    const parsed = parsePathArguments(
      PATH_SCHEMA,
      { input_path: 'C:relative', out_path: 'b.png' },
      ['input_path', 'out_path'],
    )

    // 旧仕様 (解決不能があると相対パス側の違反を隠す) から、両方を列挙する形へ変えた (#1094 F-06)。
    expect(parsed.rejected?.data['invalidPaths']).toEqual(['input_path=C:relative', 'out_path=b.png'])
    expect(parsed.rejected?.message).toContain('cannot resolve Windows-style path')
    expect(parsed.rejected?.message).toContain('C:relative')
    expect(parsed.rejected?.message).toContain('must be an absolute path')
    expect(parsed.rejected?.message).toContain('out_path=b.png')
    // 解決不能側を主文にする: message の先頭がそちらであること。
    expect(parsed.rejected?.message.startsWith('cannot resolve Windows-style')).toBe(true)
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

  it('上限を超えたら先頭を捨てて末尾を残し、切り詰めをマーカー行で明示する', async () => {
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

  it('上限を超えたら末尾だけを残し、切り詰めたことを冒頭で明示する', () => {
    const retained = truncateCapturedText('z'.repeat(LIMIT_BYTES * 2) + 'END')
    const body = retained.split('\n').slice(1).join('\n')

    expect(retained.startsWith('[pecotv]')).toBe(true)
    expect(body).toHaveLength(LIMIT_BYTES)
    // 失敗の直接原因は末尾に出るので、残すのは新しい方。
    expect(body.endsWith('END')).toBe(true)
  })
})
