/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の mutable な型を使う */

import { describe, expect, it } from 'vitest'

import { verifies } from '../../../tests/_helpers/verifies.js'
import { OUTPUT_LIMIT_BYTES } from '../../infra/awscli.js'
import { limitOutput, toCallToolResult, type ExecutionResult } from '../result.js'

const BASE_RESULT: ExecutionResult = {
  ok: true,
  data: { Account: '123456789012' },
  message: 'aws_sts_get_caller_identity succeeded',
}

const FAILED_DETAIL = 'aws_sts_get_caller_identity failed (permission-denied). Permission denied. Check the profile / role'

const FAILED_RESULT: ExecutionResult = {
  ok: false,
  kind: 'permission-denied',
  detail: FAILED_DETAIL,
  data: { log: 'An error occurred (AccessDenied)' },
}

function textsOf(result: Readonly<ReturnType<typeof toCallToolResult>>): string[] {
  return result.content.map(block => (block.type === 'text' ? block.text : ''))
}

describe('toCallToolResult', () => {
  it('成功のとき、ツールの項目を structuredContent の最上位に置き、入れ物の項目と isError を持たない', () => {
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toStrictEqual({ Account: '123456789012' })
  })

  it('content の 2 つ目の text が、structuredContent の JSON と 1 字も違わない', async (context) => {
    await verifies(context, 'PT-COMMON-10')
    expect('CUJ 590').toBe('わざと失敗させる')
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const converted = toCallToolResult(result)

      expect(textsOf(converted)[1]).toBe(JSON.stringify(converted.structuredContent))
    }
  })

  it('成功のとき、content の 1 つ目の text に文を入れる', () => {
    expect(textsOf(toCallToolResult(BASE_RESULT))).toStrictEqual([
      'aws_sts_get_caller_identity succeeded',
      '{"Account":"123456789012"}',
    ])
  })

  it('文が空のとき、content は JSON の text だけになる', () => {
    expect(textsOf(toCallToolResult({ ...BASE_RESULT, message: '' }))).toStrictEqual(['{"Account":"123456789012"}'])
  })

  it('失敗のとき、isError を立て、ツールの項目に kind と detail を重ね、reason を持たない', () => {
    const converted = toCallToolResult(FAILED_RESULT)

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toStrictEqual({
      log: 'An error occurred (AccessDenied)',
      kind: 'permission-denied',
      detail: FAILED_DETAIL,
    })
    expect(textsOf(converted)[0]).toBe(FAILED_DETAIL)
  })

  it('ツールの項目に kind と detail があると、共通の値で上書きする', () => {
    const converted = toCallToolResult({ ok: false, kind: 'timeout', detail: 'timed out', data: { kind: 'x', detail: 'y' } })

    expect(converted.structuredContent).toStrictEqual({ kind: 'timeout', detail: 'timed out' })
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
