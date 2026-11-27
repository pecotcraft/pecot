// infra/text-lint.ts の単体テスト。既定の判定器が、実物の文章規則で断片を確認する。
import { lintText } from '@pecot/text-rules'
import { describe, expect, it } from 'vitest'

import { defaultLintText } from '../../../src/infra/text-lint.js'
import { explains } from '../../_helpers/explains.js'

// 違反文を literal で持たない。語を分けて組み立てる。
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')

// 行頭が箇条書きの形。markdown では no-ai-list-formatting になる。語を分けて組み立てる。
const LIST_LINE = ['- ', '✅', ' 処理の流れ'].join('')

describe('defaultLintText', () => {
  it('違反のある断片を渡すと、規則名と指摘の文を返す', async () => {
    await explains('文章規則で断片を判定する `defaultLintText` のテストです。文章規則に違反する断片を渡した場合に、`no-ai-hype-expressions` の規則名と、空でない指摘の文を返すことを確認します。')
    const findings = await defaultLintText(HYPE)
    expect(findings.map(finding => finding.ruleId)).toContain('no-ai-hype-expressions')
    expect(findings.every(finding => finding.message !== '')).toBe(true)
  })

  it('行頭が箇条書きの形でも、断片として判定するので、指摘しない', async () => {
    await explains('`defaultLintText` のテストです。行頭が箇条書きの形の入力は、Markdown として判定すると `no-ai-list-formatting` の指摘が出ますが、同じ入力を渡した場合に、指摘が空の配列になることを確認します。')
    const asMarkdown = await lintText(LIST_LINE, 'markdown')
    expect(asMarkdown.map(finding => finding.ruleId)).toContain('no-ai-list-formatting')
    expect(await defaultLintText(LIST_LINE)).toStrictEqual([])
  })
})
