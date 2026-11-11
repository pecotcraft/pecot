import { describe, expect, it } from 'vitest'
import { hasJapanese, isPatternMatch } from '../src/domain/ears.js'
import type { Pattern } from '../src/domain/schema.js'

const ACCEPTED: readonly (readonly [Pattern, string])[] = [
  ['ubiquitous', '常に、結果の行を標準エラーに出す'],
  ['event', '--dry-run を付けて呼ぶと、GitHub へ書かずに予定の行を出す'],
  ['state', '作業中の Issue がある間、別の Issue のブランチを作らない'],
  ['unwanted', 'もし認証が切れているなら、失敗の種別 auth-expired を返す'],
  ['optional', 'ロードマップリポの設定が有効なら、Epic をそのリポに作る'],
  ['event', 'ファイルが存在すると、10 秒間、待つ'],
  ['event', 'ファイルがあると、設定が有効なら、出す'],
  ['state', '作業中の間、ファイルがあると、出さない'],
]

const REJECTED: readonly (readonly [Pattern, string])[] = [
  ['ubiquitous', '結果の行を標準エラーに出す'],
  ['ubiquitous', '常に、'],
  ['event', 'もし認証が切れていると、失敗を返す'],
  ['event', '常に、渡すと、出す'],
  ['event', '作業中の間、渡すと、出す'],
  ['state', 'ファイルが存在すると、10 秒間、待つ'],
  ['optional', 'ファイルがあると、設定が有効なら、出す'],
  ['event', 'Epic の設定が有効なら、渡すと、出す'],
  ['event', '結果の行を標準エラーに出す'],
  ['state', '作業中の Issue があると、別の Issue のブランチを作らない'],
  ['state', '間、作らない'],
  ['unwanted', '認証が切れているなら、失敗を返す'],
  ['unwanted', 'もし認証が切れているので、失敗を返す'],
  ['optional', 'もし設定が有効なら、Epic を作る'],
  ['optional', '設定があると、Epic を作る'],
]

describe('isPatternMatch', () => {
  it.each(ACCEPTED)('パターン %s は、自分の形の文 %s を受け入れる', (pattern, statement) => {
    expect(isPatternMatch(pattern, statement)).toBe(true)
  })

  it.each(REJECTED)('パターン %s は、文 %s を受け入れない', (pattern, statement) => {
    expect(isPatternMatch(pattern, statement)).toBe(false)
  })

  it('各例を他のパターンで試すと、形が重なる場合を除いて受け入れない', () => {
    for (const [pattern, statement] of ACCEPTED) {
      const others = (['ubiquitous', 'event', 'state', 'unwanted', 'optional'] as const).filter(other => other !== pattern && isPatternMatch(other, statement))
      expect({ statement, others }).toEqual({ statement, others: [] })
    }
  })
})

describe('hasJapanese', () => {
  it.each([['ひらがな', true], ['カタカナ', true], ['漢字', true], ['English only 123', false], ['', false]])('%j のとき、hasJapanese は %s を返す', (text, expected) => {
    expect(hasJapanese(text)).toBe(expected)
  })
})
