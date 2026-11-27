import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { extractSectionsFromTemplate, HORIZONTAL_RULE_ERROR } from '../sections.js'
import { closedHeadingGuidance, templateViolations } from '../template-violations.js'

const NOTE_TEMPLATE = '## Note — <要約>\n\n- 中身 — <中身>\n'
const PLAN_TEMPLATE = '## Plan\n\n### Context\n\n### Notes\n'

describe('templateViolations', () => {
  it('テンプレートの見出しをすべて持つ本文は、外れを返さない', async () => {
    await explains('本文がテンプレートから外れた所を返す `templateViolations` のテストです。テンプレートの見出しと要約をすべて持つ本文の場合に、空の一覧を返すことを確認します。')
    expect(templateViolations('## Note — 要約を書いた\n\n- 中身 — 本文\n', { stem: 'note', required: extractSectionsFromTemplate(NOTE_TEMPLATE) })).toEqual([])
  })

  it('見出しの無い本文は、不足している見出しを missing-section として返す', async () => {
    await explains('`templateViolations` のテストです。テンプレートの見出しを持たない本文の場合に、不足している見出しを `missing-section` の種類で返すことを確認します。')
    expect(templateViolations('ただの本文', { stem: 'note', required: extractSectionsFromTemplate(NOTE_TEMPLATE) })).toEqual([
      { code: 'missing-section', detail: '## Note — <summary>' },
    ])
  })

  it('水平線を含む本文は、使えない書式を body-style として返す', async () => {
    await explains('`templateViolations` のテストです。必須の見出しの無いテンプレートでも、水平線を含む本文の場合に、`body-style` の種類で書式の誤りを返すことを確認します。')
    expect(templateViolations('本文です。\n\n---\n\n続きです。\n', { stem: 'note', required: [] })).toEqual([
      { code: 'body-style', detail: HORIZONTAL_RULE_ERROR },
    ])
  })

  it('plan のテンプレートに無い見出しは extra-heading として返し、plan だけが案内を持つ', async () => {
    await explains('`templateViolations` と `closedHeadingGuidance` のテストです。`plan` のテンプレートに無い見出しを持つ本文の場合に、`extra-heading` を返し、`plan` だけが案内の文を持つことを確認します。')
    const violations = templateViolations('## Plan\n\n本文です。\n\n### Context\n\n背景です。\n\n### Extra\n\n余分です。\n\n### Notes\n\n補足です。\n', { stem: 'plan', required: extractSectionsFromTemplate(PLAN_TEMPLATE) })
    expect(violations).toEqual([{ code: 'extra-heading', detail: '### Extra' }])
    expect(closedHeadingGuidance('plan')).toBe('put content that fits no other heading under ### Notes')
    expect(closedHeadingGuidance('merge-diff')).toBeUndefined()
  })
})
