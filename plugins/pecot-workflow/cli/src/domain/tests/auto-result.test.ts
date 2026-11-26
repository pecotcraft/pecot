// 配布テンプレートの comment/auto-result.md を、lib の renderAutoResult で埋めた本文を確かめる。埋め方は lib の auto-result.test.ts が確かめる
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { AUTO_RESULT_PLACEHOLDERS, AUTO_RESULTS, autoMarker, renderAutoResult } from '@pecot/workflow-core/domain/auto-result.js'
import type { AutoNext } from '@pecot/workflow-core/domain/auto-result.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '@pecot/workflow-core/domain/sections.js'

const TEMPLATE = readFileSync(path.resolve(import.meta.dirname, '../../../templates/comment/auto-result.md'), 'utf8')
const TEMPLATE_BODY = stripLeadingHtmlComment(stripFrontmatter(TEMPLATE))
const RUN_URL = 'https://github.com/acme/demo/actions/runs/500'

function isValid(body: string): boolean {
  const sections = extractSectionsFromTemplate(TEMPLATE)
  return validateSections(body, sections).length === 0 && validateHeadingSummaries(body, sections).length === 0 && validateBodyStyle(body).length === 0
}

describe('comment/auto-result.md', () => {
  it('テンプレートの本文が、埋めるプレースホルダをすべて含む', async () => {
    await explains('配布テンプレートの `comment/auto-result.md` のテストです。本文に、`AUTO_RESULT_PLACEHOLDERS` に定義されたプレースホルダがすべて含まれていることを確認します。')
    for (const placeholder of Object.values(AUTO_RESULT_PLACEHOLDERS)) expect(TEMPLATE_BODY).toContain(placeholder)
  })

  it.for(AUTO_RESULTS)('%s の本文は、マーカーと不足している設定を指定しても、テンプレートの検証を通る', async (result) => {
    await explains('自動処理の結果コメントを作成する `renderAutoResult` のテストです。結果ごとに、マーカーと不足している設定（`Status option Needs Attention`）を指定して本文を作成した場合に、テンプレートの節・見出しの要約・文体の検証を通ることを確認します。')
    const marker = autoMarker(result, { runId: '500', attempt: '1' }, 'feat/x/7')

    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result, label: 'pecot-auto', body: '理由を書く。', missing: ['Status option Needs Attention'], runUrl: RUN_URL, marker }))).toBe(true)
  })

  it.for(['ready', 'prerequisites', 'hand-over', 'subtask', 'tracker', 'issue-only', 'reopen'] satisfies AutoNext[])('次にすることが %s の本文は、テンプレートの検証を通る', async (next) => {
    await explains('自動処理の結果コメントを作成する `renderAutoResult` のテストです。次にすることを `ready` や `hand-over` などの各値にして本文を作成した場合に、テンプレートの節・見出しの要約・文体の検証を通ることを確認します。')
    expect(isValid(renderAutoResult(TEMPLATE_BODY, { result: 'out-of-scope', label: 'pecot-auto', next }))).toBe(true)
  })
})
