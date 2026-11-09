import { describe, expect, it } from 'vitest'
import { EXCLUDED_RULE_IDS, PRESET_NAMES } from '../index.js'

describe('公開 API の定数', () => {
  it('PRESET_NAMES は契約の 3 preset をこの順で持つ', () => {
    expect(PRESET_NAMES).toEqual([
      '@textlint-ja/textlint-rule-preset-ai-writing',
      'textlint-rule-preset-ja-technical-writing',
      'textlint-rule-preset-ai-words-ja',
    ])
  })

  it('EXCLUDED_RULE_IDS は ja-no-mixed-period だけを持つ', () => {
    expect([...EXCLUDED_RULE_IDS]).toEqual(['ja-no-mixed-period'])
  })
})
