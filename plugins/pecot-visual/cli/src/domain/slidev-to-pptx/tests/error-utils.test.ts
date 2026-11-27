/* eslint-disable unicorn/name-replacements -- 対象ファイル名 error-utils.ts の踏襲 */
import { describe, expect, it } from 'vitest'

import { errorMessage, sanitizeErrorMessage } from '../error-utils.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('errorMessage', () => {
  it('Error のインスタンスを渡した場合は、message を返す', async () => {
    await explains('例外からメッセージを取り出す `errorMessage` のテストです。`new Error(\'boom\')` を渡した場合に、`boom` を返すことを確認します。')
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('Error のサブクラスを渡した場合も、message を返す', async () => {
    await explains('例外からメッセージを取り出す `errorMessage` のテストです。`Error` を継承したクラスのインスタンスを渡した場合に、その `message` を返すことを確認します。')
    class CustomError extends Error {}
    expect(errorMessage(new CustomError('custom'))).toBe('custom')
  })

  it('文字列を渡した場合は、そのまま返す', async () => {
    await explains('例外からメッセージを取り出す `errorMessage` のテストです。文字列 `plain` を渡した場合に、同じ文字列を返すことを確認します。')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('null と undefined を渡した場合は、文字列に変換した結果を返す', async () => {
    await explains('例外からメッセージを取り出す `errorMessage` のテストです。`null` と `undefined` を渡した場合に、`null` と `undefined` の文字列を返すことを確認します。')
    // eslint-disable-next-line unicorn/no-null -- 仕様確認のため null を明示的に渡す
    expect(errorMessage(null)).toBe('null')

    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('オブジェクトを渡した場合は、文字列に変換した結果を返す', async () => {
    await explains('例外からメッセージを取り出す `errorMessage` のテストです。`{ code: 1 }` を渡した場合に、`[object Object]` を返すことを確認します。')
    expect(errorMessage({ code: 1 })).toBe('[object Object]')
  })
})

describe('sanitizeErrorMessage', () => {
  // Playwright の timeout error が実際に返す形（dim 装飾つきの call log をぶら下げる）。
  const playwrightTimeoutMessage = [
    'elementHandle.screenshot: Timeout 30000ms exceeded.',
    'Call log:',
    '\u{1B}[2m  - taking element screenshot\u{1B}[22m',
    '\u{1B}[2m    2 x waiting for element to be stable\u{1B}[22m',
    '\u{1B}[2m      - element is not visible\u{1B}[22m',
    '',
  ].join('\n')

  it('call log から後ろを取り除き、API 名とタイムアウト値を含む 1 行目だけを残す', async () => {
    await explains('例外のメッセージを整える `sanitizeErrorMessage` のテストです。Playwright のタイムアウトのメッセージを渡した場合に、`Call log:` 以降が取り除かれ、1 行目だけが返ることを確認します。')
    expect(sanitizeErrorMessage(new Error(playwrightTimeoutMessage)))
      .toBe('elementHandle.screenshot: Timeout 30000ms exceeded.')
  })

  it('call log が字下げされていても、そこから後ろを取り除く', async () => {
    await explains('例外のメッセージを整える `sanitizeErrorMessage` のテストです。`Call log:` の行が字下げされている場合でも、それ以降が取り除かれ、`boom` だけが返ることを確認します。')
    expect(sanitizeErrorMessage(new Error('boom\n  Call log:\n  - step')))
      .toBe('boom')
  })

  it('残したメッセージから、ANSI の制御文字を取り除く', async () => {
    await explains('例外のメッセージを整える `sanitizeErrorMessage` のテストです。色を付ける制御文字を含むメッセージを渡した場合に、制御文字が取り除かれて `fatal: ENOENT` が返ることを確認します。')
    expect(sanitizeErrorMessage(new Error('\u{1B}[31mfatal\u{1B}[39m: ENOENT'))).toBe('fatal: ENOENT')
  })

  it('call log を含まない複数行のメッセージは、行の構成をそのまま保つ', async () => {
    await explains('例外のメッセージを整える `sanitizeErrorMessage` のテストです。`call log` を含まない 2 行のメッセージを渡した場合に、改行を含めて同じ内容が返ることを確認します。')
    expect(sanitizeErrorMessage(new Error('line1\nline2'))).toBe('line1\nline2')
  })

  it('Error 以外の値は、errorMessage と同じ規則で文字列にする', async () => {
    await explains('例外のメッセージを整える `sanitizeErrorMessage` のテストです。文字列 `plain` を渡した場合に、`errorMessage` と同じ `plain` が返ることを確認します。')
    expect(sanitizeErrorMessage('plain')).toBe('plain')
  })
})
/* eslint-enable unicorn/name-replacements */
