// review-finish が埋める src/templates/review-stopped.md を確かめる。埋めた本文と、冒頭のコメントの「例:」が検証を通るか。
import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { renderReviewStopped, REVIEW_STOPPED_PLACEHOLDERS } from '@pecot/workflow-core/domain/review-finish.js'
import type { ReviewStoppedValues } from '@pecot/workflow-core/domain/review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '@pecot/workflow-core/domain/sections.js'
import TEMPLATE from '../src/templates/review-stopped.md?raw'

const TEMPLATE_BODY = stripLeadingHtmlComment(stripFrontmatter(TEMPLATE))

function leadingComment(): string {
  const match = /<!--\n([\s\S]*?)\n-->/u.exec(TEMPLATE)
  if (match?.[1] === undefined) throw new Error('冒頭コメントがありません')
  return match[1]
}

describe('review-stopped.md', () => {
  const sections = extractSectionsFromTemplate(TEMPLATE)

  it('テンプレートの本文が、埋めるプレースホルダをすべて含む', async () => {
    await explains('action が埋める `src/templates/review-stopped.md` のテストです。本文に、`REVIEW_STOPPED_PLACEHOLDERS` に定義されたプレースホルダがすべて含まれていることを確認します。')
    for (const placeholder of Object.values(REVIEW_STOPPED_PLACEHOLDERS)) expect(TEMPLATE_BODY).toContain(placeholder)
  })

  it.each<ReviewStoppedValues>([
    { result: 'failed', next: 'retry', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'failed', next: 'auth', location: 'unknown', triggerPhrase: '@pecotbot review', run: { runId: '1', attempt: '1' } },
    { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '2', attempt: '3' } },
    { result: 'setup-missing', next: 'app-token', location: 'before-findings', triggerPhrase: '@pecotbot review' },
  ])('%$ 行目の $result と $next の本文が、テンプレートの検証を通る', async (values) => {
    await explains('レビューの停止を知らせるコメントを作成する `renderReviewStopped` のテストです。結果・次にすること・停止した位置・実行の情報を変えて本文を作成した場合に、テンプレートの節・見出しの要約・文体の検証を通ることを確認します。')
    const body = renderReviewStopped(TEMPLATE_BODY, values)
    expect(validateSections(body, sections)).toEqual([])
    expect(validateHeadingSummaries(body, sections)).toEqual([])
    expect(validateBodyStyle(body)).toEqual([])
  })

  it('冒頭のコメントに「読者:」と「例:」があり、例の本文がテンプレートの検証を通る', async () => {
    await explains('`src/templates/review-stopped.md` の冒頭の HTML コメントのテストです。コメントが「読者:」で始まって「例:」を持ち、例の本文がテンプレートの節・見出しの要約・文体の検証を通ることを確認します。')
    const comment = leadingComment()
    expect(comment.startsWith('読者: ')).toBe(true)
    const at = comment.indexOf('\n例:\n')
    expect(at).toBeGreaterThan(-1)
    const example = comment.slice(at + '\n例:\n'.length)
    expect(example).toMatch(/^#{2,3} /mu)
    expect(validateSections(example, sections)).toEqual([])
    expect(validateHeadingSummaries(example, sections)).toEqual([])
    expect(validateBodyStyle(example)).toEqual([])
  })
})
