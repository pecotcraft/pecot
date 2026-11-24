import { describe, expect, it } from 'vitest'

import { hasMergeDiffMarker, mergeDiffMarker, withMergeDiffMarker } from '../merge-diff-marker.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { formatMergedRecord, interpretMergedRecord, sessionTitleNumber } from '../state.js'

const PR_21 = createIssueReference(createRepositoryReference('acme', 'demo'), 21)
const PR_3 = createIssueReference(createRepositoryReference('acme', 'demo'), 3)

describe('mergeDiffMarker', () => {
  it('PR を owner/repo#N の形で HTML のコメントに入れる', () => {
    expect(mergeDiffMarker(PR_21)).toBe('<!-- pecot-merge-diff: pr=acme/demo#21 -->')
  })

  it('印を付けると本文の先頭に置き、前の印は除く', () => {
    expect(withMergeDiffMarker('<!-- pecot-merge-diff: pr=acme/demo#3 -->\n\n## Merge — 本文', PR_21)).toBe('<!-- pecot-merge-diff: pr=acme/demo#21 -->\n\n## Merge — 本文')
  })

  it('印を探すとき、owner と repo の大文字小文字を区別せず、別の PR の印は数えない', () => {
    expect(hasMergeDiffMarker('<!-- pecot-merge-diff: pr=Acme/Demo#21 -->\n本文', PR_21)).toBe(true)
    expect(hasMergeDiffMarker('<!-- pecot-merge-diff: pr=acme/demo#211 -->\n本文', PR_21)).toBe(false)
  })
})

describe('interpretMergedRecord', () => {
  it('1 行に 1 つの PR を読み、形の誤った行を読み飛ばす', () => {
    expect(interpretMergedRecord('acme/demo#3\nこわれた行\nacme/demo#21\n')).toEqual([PR_3, PR_21])
    expect(interpretMergedRecord(undefined)).toEqual([])
  })

  it('組み立てると、同じ PR を 1 つにまとめる', () => {
    expect(formatMergedRecord([PR_3, PR_21, PR_3])).toBe('acme/demo#3\nacme/demo#21')
  })
})

describe('sessionTitleNumber', () => {
  it('先頭の #番号 を読み、読めなければ undefined を返す', () => {
    expect(sessionTitleNumber('#30 次の作業')).toBe(30)
    expect(sessionTitleNumber('x')).toBeUndefined()
    expect(sessionTitleNumber(undefined)).toBeUndefined()
  })
})
