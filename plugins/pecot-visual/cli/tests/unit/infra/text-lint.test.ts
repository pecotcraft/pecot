// infra/text-lint.ts の単体テスト。既定の判定器が、実物の文章規則で断片を確認する。
import { lintText } from '@pecot/text-rules'
import { describe, expect, it } from 'vitest'

import { defaultLintText } from '../../../src/infra/text-lint.js'

// 違反文を literal で持たない。語を分けて組み立てる。
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')

// 行頭が箇条書きの形。markdown では no-ai-list-formatting になる。語を分けて組み立てる。
const LIST_LINE = ['- ', '✅', ' 処理の流れ'].join('')

describe('defaultLintText', () => {
  it('違反のある断片は規則名と指摘を返す', async () => {
    const findings = await defaultLintText(HYPE)
    expect(findings.map(finding => finding.ruleId)).toContain('no-ai-hype-expressions')
    expect(findings.every(finding => finding.message !== '')).toBe(true)
  })

  it('行頭が箇条書きの形でも、断片として確かめるので指摘しない（markdown なら指摘される入力）', async () => {
    const asMarkdown = await lintText(LIST_LINE, 'markdown')
    expect(asMarkdown.map(finding => finding.ruleId)).toContain('no-ai-list-formatting')
    expect(await defaultLintText(LIST_LINE)).toStrictEqual([])
  })
})
