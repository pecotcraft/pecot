// 本文を同梱のテンプレートと比べ、外れた所を 1 つずつ返す。出し方は呼ぶ側が決める
import {
  CLOSED_HEADINGS_BY_TEMPLATE,
  FOLD_SUMMARY_BY_TEMPLATE,
  validateBodyStyle,
  validateClosedHeadings,
  validateFoldBalance,
  validateFoldSummaries,
  validateHeadingSummaries,
  validateSections,
} from './sections.js'
import type { SectionHeading } from './sections.js'

export type TemplateViolationCode = 'missing-section' | 'heading-summary' | 'body-style' | 'fold' | 'extra-heading'

/**
テンプレートから外れた 1 か所。detail は sections.ts の検証が返す文のまま
*/
export interface TemplateViolation {
  readonly code: TemplateViolationCode
  readonly detail: string
}

/**
比べる相手のテンプレート。stem はファイル名から拡張子を除いたもの（plan など）で、折りたたみと閉じた見出しの決まりを選ぶ
*/
export interface TemplateShape {
  readonly stem: string
  readonly required: readonly SectionHeading[]
}

export const EM_DASH_HINT = 'the em dash must be U+2014; hyphen-minus (-) and EN DASH (U+2013) are not allowed'

function tagged(code: TemplateViolationCode, details: readonly string[]): readonly TemplateViolation[] {
  return details.map(detail => ({ code, detail }))
}

/**
本文がテンプレートから外れた所を、種類の順（不足の見出し・見出しの要約・書式・折りたたみ・テンプレートに無い見出し）に返す。合えば空
*/
export function templateViolations(body: string, template: Readonly<TemplateShape>): readonly TemplateViolation[] {
  const { stem, required } = template
  const hasRequired = required.length > 0
  const isClosed = CLOSED_HEADINGS_BY_TEMPLATE.has(stem)
  const foldSummary = FOLD_SUMMARY_BY_TEMPLATE.get(stem)
  return [
    ...tagged('missing-section', hasRequired ? validateSections(body, required) : []),
    ...tagged('heading-summary', hasRequired ? validateHeadingSummaries(body, required) : []),
    ...tagged('body-style', validateBodyStyle(body)),
    ...tagged('fold', [
      ...isClosed ? validateFoldBalance(body) : [],
      ...foldSummary === undefined ? [] : validateFoldSummaries(body, foldSummary),
    ]),
    ...tagged('extra-heading', isClosed && hasRequired ? validateClosedHeadings(body, required) : []),
  ]
}

/**
テンプレートに無い見出しを拒むテンプレートの、拒んだときに添える案内。拒まないテンプレートは undefined
*/
export function closedHeadingGuidance(stem: string): string | undefined {
  return CLOSED_HEADINGS_BY_TEMPLATE.get(stem)
}
