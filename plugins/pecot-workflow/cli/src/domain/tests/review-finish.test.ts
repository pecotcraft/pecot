// 配布テンプレートの comment/review-stopped.md を、lib の renderReviewStopped で埋めた本文を確かめる。埋め方は lib の review-finish.test.ts が確かめる
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { renderReviewStopped, REVIEW_STOPPED_PLACEHOLDERS } from '@pecot/workflow-core/domain/review-finish.js'
import type { ReviewStoppedValues } from '@pecot/workflow-core/domain/review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '@pecot/workflow-core/domain/sections.js'

const TEMPLATE = readFileSync(path.resolve(import.meta.dirname, '../../../templates/comment/review-stopped.md'), 'utf8')
const TEMPLATE_BODY = stripLeadingHtmlComment(stripFrontmatter(TEMPLATE))

describe('comment/review-stopped.md', () => {
  const sections = extractSectionsFromTemplate(TEMPLATE)

  it('テンプレートの本文が、埋めるプレースホルダをすべて含む', async () => {
    await explains('配布テンプレートの `comment/review-stopped.md` のテストです。本文に、`REVIEW_STOPPED_PLACEHOLDERS` に定義されたプレースホルダがすべて含まれていることを確認します。')
    for (const placeholder of Object.values(REVIEW_STOPPED_PLACEHOLDERS)) expect(TEMPLATE_BODY).toContain(placeholder)
  })

  it.each<ReviewStoppedValues>([
    { result: 'failed', next: 'retry', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'failed', next: 'auth', location: 'unknown', triggerPhrase: '@pecotbot review', run: { runId: '1', attempt: '1' } },
    { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '2', attempt: '3' } },
    { result: 'setup-missing', next: 'app-token', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret <X> `Y`' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret X\nと変数 Y' },
  ])('%$ 行目の $result と $next の本文が、テンプレートの検証を通る', async (values) => {
    await explains('レビューの停止を知らせるコメントを作成する `renderReviewStopped` のテストです。結果・次にすること・停止した位置・実行の情報・詳細の文を変えて本文を作成した場合に、テンプレートの節・見出しの要約・文体の検証を通ることを確認します。')
    const body = renderReviewStopped(TEMPLATE_BODY, values)
    expect(validateSections(body, sections)).toEqual([])
    expect(validateHeadingSummaries(body, sections)).toEqual([])
    expect(validateBodyStyle(body)).toEqual([])
  })
})
