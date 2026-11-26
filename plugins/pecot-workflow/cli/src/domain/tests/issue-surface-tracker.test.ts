import { describe, expect, it } from 'vitest'

import { buildTrackerTitle, IssueSurfaceTrackerError, renderTrackerBody, TRACKER_PATTERN } from '../issue-surface-tracker.js'

const SOURCES = { graphql: 'https://example.com/schema.graphql', rest: 'openapi.json', rest_api_version: '2022-11-28' }

const LIST_BEGIN = '<!-- pecot-issue-surface: list-begin -->'
const LIST_END = '<!-- pecot-issue-surface: list-end -->'

describe('renderTrackerBody', () => {
  it('既存の本文が無いと、Tracker の印・説明・比べたスキーマ・一覧の順に並べる', () => {
    const body = renderTrackerBody({ added: ['graphql:A.b', 'graphql:A.c'], removed: [] }, SOURCES)
    expect(body.startsWith('<!-- pecot-issue-surface: tracker -->\n\n')).toBe(true)
    expect(TRACKER_PATTERN.test(body)).toBe(true)
    expect(body).toContain('- SDL: https://example.com/schema.graphql\n- OpenAPI: openapi.json\n- REST API の版: 2022-11-28')
    expect(body).toContain('「4. GitHub の Issue の機能の写しと担保の一覧」')
    expect(body.endsWith(`${LIST_BEGIN}\n## Added\n\n- \`graphql:A.b\`\n- \`graphql:A.c\`\n\n## Removed\n\nnone\n${LIST_END}\n`)).toBe(true)
  })

  it('既存の本文があると、list-begin と list-end の間だけを書き直し、外の文と改行を残す', () => {
    const existing = `前の文\r\n\r\n${LIST_BEGIN}\r\n## Added\r\n\r\n- \`graphql:A.b\`\r\n${LIST_END}\r\n後の文\r\n`
    expect(renderTrackerBody({ added: [], removed: ['graphql:A.a'] }, SOURCES, existing))
      .toBe(`前の文\n\n${LIST_BEGIN}\n## Added\n\nnone\n\n## Removed\n\n- \`graphql:A.a\`\n${LIST_END}\n後の文\n`)
  })

  it.for([
    { name: 'list-end が無い', body: `${LIST_BEGIN}\n` },
    { name: 'list-begin が 2 つある', body: `${LIST_BEGIN}\n${LIST_BEGIN}\n${LIST_END}\n` },
    { name: '順序が逆', body: `${LIST_END}\n${LIST_BEGIN}\n` },
  ])('既存の本文の $name と、IssueSurfaceTrackerError を投げる', ({ body }) => {
    expect(() => renderTrackerBody({ added: [], removed: [] }, SOURCES, body)).toThrow(IssueSurfaceTrackerError)
  })
})

describe('buildTrackerTitle', () => {
  it('立てた日を、ほかの Tracker と同じ形で題に入れる', () => {
    expect(buildTrackerTitle('2026-11-26')).toBe('[Tracker] GitHub issue surface — 2026-11-26')
  })
})
