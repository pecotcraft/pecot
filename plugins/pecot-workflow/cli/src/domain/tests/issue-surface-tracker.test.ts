import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { buildTrackerTitle, IssueSurfaceTrackerError, renderTrackerBody, TRACKER_PATTERN } from '../issue-surface-tracker.js'

const SOURCES = { graphql: 'https://example.com/schema.graphql', rest: 'openapi.json' }

const LIST_BEGIN = '<!-- pecot-issue-surface: list-begin -->'
const LIST_END = '<!-- pecot-issue-surface: list-end -->'

describe('renderTrackerBody', () => {
  it('既存の本文が存在しない場合は、Tracker のマーカーの後ろに、取得元と増えた・消えた項目の一覧だけを置く', async () => {
    await explains('Tracker の本文を作成する `renderTrackerBody` のテストです。既存の本文を渡さない場合に、Tracker のマーカーに続けて、`Source`・`Added`・`Removed` の節だけの本文を作成することを確認します。')
    const body = renderTrackerBody({ added: ['graphql:A.b', 'graphql:A.c'], removed: [] }, SOURCES)
    expect(TRACKER_PATTERN.test(body)).toBe(true)
    expect(body).toBe([
      '<!-- pecot-issue-surface: tracker -->',
      '',
      LIST_BEGIN,
      '## Source',
      '',
      '- SDL: https://example.com/schema.graphql',
      '- OpenAPI: openapi.json',
      '',
      '## Added',
      '',
      '- `graphql:A.b`',
      '- `graphql:A.c`',
      '',
      '## Removed',
      '',
      'none',
      LIST_END,
      '',
    ].join('\n'))
  })

  it('既存の本文がある場合は、list-begin と list-end の間だけを書き換え、外側の文を残す', async () => {
    await explains('Tracker の本文を作成する `renderTrackerBody` のテストです。既存の本文を渡した場合に、`list-begin` と `list-end` の間だけを新しい一覧に置き換え、外側の文は残し、改行コードを LF にそろえることを確認します。')
    const existing = `前の文\r\n\r\n${LIST_BEGIN}\r\n## Added\r\n\r\n- \`graphql:A.b\`\r\n${LIST_END}\r\n後の文\r\n`
    expect(renderTrackerBody({ added: [], removed: ['graphql:A.a'] }, SOURCES, existing))
      .toBe(`前の文\n\n${LIST_BEGIN}\n## Source\n\n- SDL: https://example.com/schema.graphql\n- OpenAPI: openapi.json\n\n## Added\n\nnone\n\n## Removed\n\n- \`graphql:A.a\`\n${LIST_END}\n後の文\n`)
  })

  it.for([
    { name: 'list-end が存在しない', body: `${LIST_BEGIN}\n` },
    { name: 'list-begin が 2 つある', body: `${LIST_BEGIN}\n${LIST_BEGIN}\n${LIST_END}\n` },
    { name: '順序が逆', body: `${LIST_END}\n${LIST_BEGIN}\n` },
  ])('既存の本文が「$name」の場合は、IssueSurfaceTrackerError を送出する', async ({ body }) => {
    await explains('既存の本文の `list-begin` と `list-end` の位置が不正な場合の、`renderTrackerBody` のテストです。`list-end` が存在しない場合・`list-begin` が 2 つある場合・順序が逆の場合のどれでも、`IssueSurfaceTrackerError` が発生することを確認します。')
    expect(() => renderTrackerBody({ added: [], removed: [] }, SOURCES, body)).toThrow(IssueSurfaceTrackerError)
  })
})

describe('buildTrackerTitle', () => {
  it('Tracker を作成した日を、ほかの Tracker と同じ形で題に含める', async () => {
    await explains('Tracker の題を作成する `buildTrackerTitle` のテストです。日付 `2026-11-26` を渡した場合に、`[Tracker] GitHub issue surface — 2026-11-26` の題を返すことを確認します。')
    expect(buildTrackerTitle('2026-11-26')).toBe('[Tracker] GitHub issue surface — 2026-11-26')
  })
})
