import { describe, expect, it } from 'vitest'
import { EXCLUDED_RULE_IDS, PRESET_NAMES } from '../index.js'
import { stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

describe('公開 API の定数', () => {
  it('公開 API の PRESET_NAMES は、契約で決めた 3 つの preset を、決めた順で含む', async () => {
    await explains('公開 API の定数 `PRESET_NAMES` のテストです。契約で決めた 3 つの textlint の preset 名が、決めた順で含まれることを確認します。')
    stepSync('公開の preset 名を比べる', () => {
      expect(PRESET_NAMES).toEqual([
        '@textlint-ja/textlint-rule-preset-ai-writing',
        'textlint-rule-preset-ja-technical-writing',
        'textlint-rule-preset-ai-words-ja',
      ])
    })
  })

  it('公開 API の EXCLUDED_RULE_IDS は、ja-no-mixed-period だけを含む', async () => {
    await explains('公開 API の定数 `EXCLUDED_RULE_IDS` のテストです。除外する規則の ID が `ja-no-mixed-period` だけであることを確認します。')
    stepSync('除外する規則 ID を比べる', () => {
      expect([...EXCLUDED_RULE_IDS]).toEqual(['ja-no-mixed-period'])
    })
  })
})
