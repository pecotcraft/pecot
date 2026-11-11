import { describe, expect, it } from 'vitest'

import { verifies } from '../../../tests/_helpers/verifies.js'
import { OUTPUT_LIMIT_BYTES } from '../../infra/awscli.js'
import { limitOutput, toCallToolResult, type ExecutionResult } from '../result.js'

const BASE_RESULT: ExecutionResult = {
  ok: true,
  exitCode: 0,
  artifacts: [],
  data: { Account: '123456789012' },
  message: 'aws_sts_get_caller_identity が成功しました',
}

describe('toCallToolResult', () => {
  it('成功時は isError と category を持たない', () => {
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toEqual({
      ok: true,
      exitCode: 0,
      data: { Account: '123456789012' },
      artifacts: [],
      message: 'aws_sts_get_caller_identity が成功しました',
    })
  })

  it('content の JSON テキストと structuredContent が同値になる', async (context) => {
    await verifies(context, 'PT-COMMON-10')
    const converted = toCallToolResult(BASE_RESULT)
    const [block] = converted.content

    expect(block).toMatchObject({ type: 'text' })
    expect(JSON.parse(block?.type === 'text' ? block.text : '')).toEqual(converted.structuredContent)
  })

  it('ok: false を isError: true に連動させ、category と stderr を載せる', () => {
    const converted = toCallToolResult({
      ...BASE_RESULT,
      ok: false,
      exitCode: 254,
      category: 'permission-denied',
      message: '権限が不足しています',
      stderr: 'An error occurred (AccessDenied)',
    })

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toMatchObject({
      category: 'permission-denied',
      exitCode: 254,
      stderr: 'An error occurred (AccessDenied)',
    })
  })

  it('artifacts を複製して載せる', () => {
    const converted = toCallToolResult({ ...BASE_RESULT, artifacts: ['/var/data/out.json'] })

    expect(converted.structuredContent).toMatchObject({ artifacts: ['/var/data/out.json'] })
  })
})

describe('limitOutput', () => {
  it('上限以内はそのまま返す', () => {
    expect(limitOutput('{"ok":true}')).toEqual({ text: '{"ok":true}', truncated: false })
  })

  it('上限ちょうどは切り詰めない', () => {
    const text = 'a'.repeat(OUTPUT_LIMIT_BYTES)

    expect(limitOutput(text)).toEqual({ text, truncated: false })
  })

  it('上限を超えたら先頭を残して truncated を立てる', () => {
    // JSON 出力は先頭を失うと構造ごと読めなくなるため、残すのは先頭側。
    const text = `HEAD${'x'.repeat(OUTPUT_LIMIT_BYTES)}TAIL`
    const limited = limitOutput(text)

    expect(limited.truncated).toBe(true)
    expect(limited.text.startsWith('HEAD')).toBe(true)
    expect(limited.text.endsWith('TAIL')).toBe(false)
    expect(Buffer.byteLength(limited.text, 'utf8')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
  })

  it('多バイト文字の途中で切れても不完全な 1 文字を残さない', () => {
    // 上限の直前まで ASCII で埋め、3 バイト文字の途中で境界が来るようにする。
    const text = 'a'.repeat(OUTPUT_LIMIT_BYTES - 1) + '警'.repeat(10)
    const limited = limitOutput(text)

    expect(limited.truncated).toBe(true)
    expect(limited.text.endsWith('�')).toBe(false)
    expect(limited.text).toBe('a'.repeat(OUTPUT_LIMIT_BYTES - 1))
  })
})
