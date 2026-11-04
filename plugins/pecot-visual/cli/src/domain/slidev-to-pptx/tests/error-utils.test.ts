/* eslint-disable unicorn/name-replacements -- 対象ファイル名 error-utils.ts の踏襲 */
import { describe, expect, it } from 'vitest'

import { errorMessage, sanitizeErrorMessage } from '../error-utils.js'

describe('errorMessage', () => {
  it('Error インスタンスは message を返す', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('Error サブクラスも message を返す', () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError('custom'))).toBe('custom')
  })

  it('文字列はそのまま String() 化する', () => {
    expect(errorMessage('plain')).toBe('plain')
  })

  it('null / undefined は String 変換結果を返す', () => {
    // eslint-disable-next-line unicorn/no-null -- 仕様確認のため null を明示的に渡す
    expect(errorMessage(null)).toBe('null')

    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('object は String() 変換した値を返す', () => {
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

  it('call log 以降を落とし、API 名と timeout 値を持つ 1 行目を残す', () => {
    expect(sanitizeErrorMessage(new Error(playwrightTimeoutMessage)))
      .toBe('elementHandle.screenshot: Timeout 30000ms exceeded.')
  })

  it('call log が字下げされていても切り落とす', () => {
    expect(sanitizeErrorMessage(new Error('boom\n  Call log:\n  - step')))
      .toBe('boom')
  })

  it('残した範囲の ANSI 制御文字を除去する', () => {
    expect(sanitizeErrorMessage(new Error('\u{1B}[31mfatal\u{1B}[39m: ENOENT'))).toBe('fatal: ENOENT')
  })

  it('call log を持たない複数行 message は行構成を保つ', () => {
    expect(sanitizeErrorMessage(new Error('line1\nline2'))).toBe('line1\nline2')
  })

  it('Error 以外は errorMessage と同じ規則で文字列化する', () => {
    expect(sanitizeErrorMessage('plain')).toBe('plain')
  })
})
/* eslint-enable unicorn/name-replacements */
