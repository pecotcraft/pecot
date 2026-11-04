import { describe, expect, it } from 'vitest'

import { sectionsOutputs } from '../../tests/_helpers/python-output.js'
import {
  CLOSED_HEADINGS_BY_TEMPLATE,
  PLAN_FOLD_SUMMARY,
  validateBodyStyle,
  validateClosedHeadings,
  validateFoldBalance,
  validateFoldSummaries,
  validateHeadingSummaries,
  validateSections,
} from '../sections.js'

// 期待値は、Python の CLI の実出力（tests/python-output/sections.json。record.py が Python で記録する）。
// 改行（\r\n・\r・U+2028）・全角や非改行の空白・絵文字・コードポイントの数え方など、
// 正規表現の書き方（lint が書き換えた形を含む）で結果が変わりやすい本文を選んでいる。
// 空白の範囲（U+0085・U+FEFF・U+001C〜U+001F）だけは Python と違うため、その本文は含めない。
const { required, closedHeadingsByTemplate, cases } = sectionsOutputs()

describe('Python の出力との一致', () => {
  describe.each(cases)('本文 $body', (result) => {
    it('validateBodyStyle', () => {
      expect(validateBodyStyle(result.body)).toEqual(result.style)
    })

    it('validateSections', () => {
      expect(required.map(headings => validateSections(result.body, headings))).toEqual(result.sections)
    })

    it('validateHeadingSummaries', () => {
      expect(required.map(headings => validateHeadingSummaries(result.body, headings))).toEqual(result.summaries)
    })

    it('validateFoldBalance', () => {
      expect(validateFoldBalance(result.body)).toEqual(result.balance)
    })

    it('validateClosedHeadings', () => {
      expect(required.map(headings => validateClosedHeadings(result.body, headings))).toEqual(result.closed)
    })

    it('validateFoldSummaries', () => {
      expect(validateFoldSummaries(result.body, PLAN_FOLD_SUMMARY)).toEqual(result.fold)
    })
  })
})

describe('CLOSED_HEADINGS_BY_TEMPLATE', () => {
  it('Python の定数と一致する', () => {
    expect(Object.fromEntries(CLOSED_HEADINGS_BY_TEMPLATE)).toEqual(closedHeadingsByTemplate)
  })
})
