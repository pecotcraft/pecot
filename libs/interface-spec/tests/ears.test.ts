import { describe, expect, it } from 'vitest'
import { hasJapanese, isPatternMatch } from '../src/domain/ears.js'
import type { Pattern } from '../src/domain/schema.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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
  it.each(ACCEPTED)('パターン %s は、その形の文 %s に一致する', async (pattern, statement) => {
    await explains(`要件の文が EARS のパターンに合うかを判定する \`isPatternMatch\` のテストです。パターン \`${pattern}\` に、その形の文「${statement}」を渡した場合に、\`true\` を返すことを確認します。`)
    stepSync('パターンに文を当てて比べる', () => {
      expect(isPatternMatch(pattern, statement)).toBe(true)
    })
  })

  it.each(REJECTED)('パターン %s は、形の違う文 %s に一致しない', async (pattern, statement) => {
    await explains(`要件の文が EARS のパターンに合うかを判定する \`isPatternMatch\` のテストです。パターン \`${pattern}\` に、形の合わない文「${statement}」を渡した場合に、\`false\` を返すことを確認します。`)
    stepSync('パターンに文を当てて比べる', () => {
      expect(isPatternMatch(pattern, statement)).toBe(false)
    })
  })

  it('受け入れる例の文は、そのパターン以外のどのパターンにも一致しない', async () => {
    await explains('要件の文が EARS のパターンに合うかを判定する `isPatternMatch` のテストです。パターンごとの受け入れる文が、ほかの 4 つのパターンのどれにも一致しないことを確認します。')
    stepSync('他のパターンに当てて、合わないかを比べる', () => {
      for (const [pattern, statement] of ACCEPTED) {
        const others = (['ubiquitous', 'event', 'state', 'unwanted', 'optional'] as const).filter(other => other !== pattern && isPatternMatch(other, statement))
        expect({ statement, others }).toEqual({ statement, others: [] })
      }
    })
  })
})

describe('hasJapanese', () => {
  it.each([['ひらがな', true], ['カタカナ', true], ['漢字', true], ['English only 123', false], ['', false]])('文字列 %j を渡すと、hasJapanese は %s を返す', async (text, expected) => {
    await explains(`文字列に日本語が含まれるかを判定する \`hasJapanese\` のテストです。文字列 \`${JSON.stringify(text)}\` を渡した場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('日本語の有無を判定して比べる', () => {
      expect(hasJapanese(text)).toBe(expected)
    })
  })
})
