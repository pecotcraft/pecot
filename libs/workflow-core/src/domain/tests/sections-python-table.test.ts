import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { sectionsOutputs } from '../../../tests/_helpers/python-output.js'
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

// 期待値は、Python の CLI の実出力（tests/python-output/sections.json。作り直さない記録）。
// 改行（\r\n・\r・U+2028）・全角や非改行の空白・絵文字・コードポイントの数え方など、
// 正規表現の書き方（lint が書き換えた形を含む）で結果が変わりやすい本文を選んでいる。
// 空白の範囲（U+0085・U+FEFF・U+001C〜U+001F）だけは Python と違うため、その本文は含めない。
const { required, closedHeadingsByTemplate, cases } = sectionsOutputs()

describe('Python の出力との一致', () => {
  describe.each(cases)('%$ 件目の本文 $body', (result) => {
    it('本文の書式の検証が Python の結果と一致する', async () => {
      await explains('本文の書式を検証する `validateBodyStyle` のテストです。記録した Python の実際の出力と同じ検証結果を返すことを、改行や空白、絵文字などを含む本文ごとに確認します。')
      stepSync('結果を比べる', () => {
        expect(validateBodyStyle(result.body)).toEqual(result.style)
      })
    })

    it('必須の節の検証が Python の結果と一致する', async () => {
      await explains('必須の節を検証する `validateSections` のテストです。記録した Python の実際の出力と同じ検証結果を、必須の見出しの組み合わせごとに返すことを、本文ごとに確認します。')
      stepSync('結果を比べる', () => {
        expect(required.map(headings => validateSections(result.body, headings))).toEqual(result.sections)
      })
    })

    it('見出しの要約の検証が Python の結果と一致する', async () => {
      await explains('見出しの要約を検証する `validateHeadingSummaries` のテストです。記録した Python の実際の出力と同じ検証結果を、必須の見出しの組み合わせごとに返すことを、本文ごとに確認します。')
      stepSync('結果を比べる', () => {
        expect(required.map(headings => validateHeadingSummaries(result.body, headings))).toEqual(result.summaries)
      })
    })

    it('折りたたみの対応の検証が Python の結果と一致する', async () => {
      await explains('折りたたみの開始と終了の対応を検証する `validateFoldBalance` のテストです。記録した Python の実際の出力と同じ検証結果を、本文ごとに返すことを確認します。')
      stepSync('結果を比べる', () => {
        expect(validateFoldBalance(result.body)).toEqual(result.balance)
      })
    })

    it('閉じる見出しの検証が Python の結果と一致する', async () => {
      await explains('閉じておく見出しを検証する `validateClosedHeadings` のテストです。記録した Python の実際の出力と同じ検証結果を、必須の見出しの組み合わせごとに返すことを、本文ごとに確認します。')
      stepSync('結果を比べる', () => {
        expect(required.map(headings => validateClosedHeadings(result.body, headings))).toEqual(result.closed)
      })
    })

    it('折りたたみの要約の検証が Python の結果と一致する', async () => {
      await explains('折りたたみの要約を検証する `validateFoldSummaries` のテストです。記録した Python の実際の出力と同じ検証結果を、本文ごとに返すことを確認します。')
      stepSync('結果を比べる', () => {
        expect(validateFoldSummaries(result.body, PLAN_FOLD_SUMMARY)).toEqual(result.fold)
      })
    })
  })
})

describe('CLOSED_HEADINGS_BY_TEMPLATE', () => {
  it('Python の定数と同じ値を持つ', async () => {
    await explains('テンプレートごとの閉じる見出しの定数 `CLOSED_HEADINGS_BY_TEMPLATE` のテストです。記録した Python の実際の出力と同じ内容を持つことを確認します。')
    stepSync('結果を比べる', () => {
      expect(Object.fromEntries(CLOSED_HEADINGS_BY_TEMPLATE)).toEqual(closedHeadingsByTemplate)
    })
  })
})
