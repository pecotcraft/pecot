/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の mutable な型を使う */

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
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
  it('成功の結果を変換すると、ツールの項目を structuredContent の最上位に置き、isError を持たない', async () => {
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。成功の結果を渡した場合に、`structuredContent` がツールの項目だけで、`isError` が未設定であることを確認します。')
    const converted = toCallToolResult(BASE_RESULT)

    expect(converted.isError).toBeUndefined()
    expect(converted.structuredContent).toStrictEqual({ Account: '123456789012' })
  })

  it('content の 2 つ目の text は、structuredContent の JSON と一致する', async (context) => {
    await verifies(context, 'PT-COMMON-10')
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。成功と失敗の両方の結果で、`content` の 2 つ目の `text` が、`structuredContent` を `JSON.stringify` した文字列と一致することを確認します。')
    for (const result of [BASE_RESULT, FAILED_RESULT]) {
      const converted = toCallToolResult(result)

      expect(textsOf(converted)[1]).toBe(JSON.stringify(converted.structuredContent))
    }
  })

  it('成功の結果を変換すると、content の 1 つ目の text にメッセージの文を入れる', async () => {
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。成功の結果を渡した場合に、`content` が、メッセージの文と、ツールの項目の JSON の 2 つの `text` になることを確認します。')
    expect(textsOf(toCallToolResult(BASE_RESULT))).toStrictEqual([
      'aws_sts_get_caller_identity succeeded',
      '{"Account":"123456789012"}',
    ])
  })

  it('メッセージが空の結果を変換すると、content は JSON の text だけになる', async () => {
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。メッセージが空の成功の結果を渡した場合に、`content` が JSON の `text` 1 つだけになることを確認します。')
    expect(textsOf(toCallToolResult({ ...BASE_RESULT, message: '' }))).toStrictEqual(['{"Account":"123456789012"}'])
  })

  it('失敗の結果を変換すると、isError を真にし、ツールの項目に kind と detail を加え、reason を持たない', async () => {
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。失敗の結果を渡した場合は、`isError` が真になり、`structuredContent` に `kind` と `detail` が加わることを確認します。')
    const converted = toCallToolResult(FAILED_RESULT)

    expect(converted.isError).toBe(true)
    expect(converted.structuredContent).toStrictEqual({
      log: 'An error occurred (AccessDenied)',
      kind: 'permission-denied',
      detail: FAILED_DETAIL,
    })
    expect(textsOf(converted)[0]).toBe(FAILED_DETAIL)
  })

  it('ツールの項目に kind と detail があるときは、共通の kind と detail で上書きする', async () => {
    await explains('ツールの実行結果を MCP の `CallToolResult` に変換する `toCallToolResult` のテストです。ツールの項目に `kind` と `detail` が含まれる失敗の結果を渡した場合に、`structuredContent` の値が共通の `kind` と `detail` になることを確認します。')
    const converted = toCallToolResult({ ok: false, kind: 'timeout', detail: 'timed out', data: { kind: 'x', detail: 'y' } })

    expect(converted.structuredContent).toStrictEqual({ kind: 'timeout', detail: 'timed out' })
  })
})

describe('limitOutput', () => {
  it('出力が上限以内のときは、そのまま返す', async () => {
    await explains('出力の大きさを上限に収める `limitOutput` のテストです。上限以内の短い文字列を渡した場合に、同じ文字列を返し、`truncated` が偽であることを確認します。')
    expect(limitOutput('{"ok":true}')).toEqual({ text: '{"ok":true}', truncated: false })
  })

  it('出力が上限ちょうどのときは、切り詰めない', async () => {
    await explains('出力の大きさを上限に収める `limitOutput` のテストです。上限と同じバイト数の文字列を渡した場合に、同じ文字列を返し、`truncated` が偽であることを確認します。')
    const text = 'a'.repeat(OUTPUT_LIMIT_BYTES)

    expect(limitOutput(text)).toEqual({ text, truncated: false })
  })

  it('出力が上限を超えたときは、先頭を残して切り詰め、truncated を真にする', async () => {
    await explains('出力の大きさを上限に収める `limitOutput` のテストです。上限を超える文字列を渡した場合は、`truncated` が真になり、先頭の `HEAD` は残り、末尾の `TAIL` は残らないことを確認します。')
    // JSON 出力は先頭を失うと構造ごと読めなくなるため、残すのは先頭側。
    const text = `HEAD${'x'.repeat(OUTPUT_LIMIT_BYTES)}TAIL`
    const limited = limitOutput(text)

    expect(limited.truncated).toBe(true)
    expect(limited.text.startsWith('HEAD')).toBe(true)
    expect(limited.text.endsWith('TAIL')).toBe(false)
    expect(Buffer.byteLength(limited.text, 'utf8')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
  })

  it('多バイト文字の途中で上限に達しても、不完全な文字を残さない', async () => {
    await explains('出力の大きさを上限に収める `limitOutput` のテストです。3 バイトの文字の途中で上限に達する文字列を渡した場合に、結果が不完全な文字を含まず、手前の文字までで切れることを確認します。')
    // 上限の直前まで ASCII で埋め、3 バイト文字の途中で境界が来るようにする。
    const text = 'a'.repeat(OUTPUT_LIMIT_BYTES - 1) + '警'.repeat(10)
    const limited = limitOutput(text)

    expect(limited.truncated).toBe(true)
    expect(limited.text.endsWith('�')).toBe(false)
    expect(limited.text).toBe('a'.repeat(OUTPUT_LIMIT_BYTES - 1))
  })
})
