import { describe, expect, it } from 'vitest'

import { extractIssueNumberFromBranch } from '../branch-name.js'

describe('extractIssueNumberFromBranch', () => {
  it.each([
    ['feat/description/470', 470],
    ['fix/bug-fix/123', 123],
    ['feat/module/sub-feature/999', 999],
    ['123', 123],
  ])('ブランチ %s の末尾の番号 %i を返す', (branch, expected) => {
    expect(extractIssueNumberFromBranch(branch)).toBe(expected)
  })

  it.each(['main', 'develop-aist', 'feat/no-issue-number', 'feat/12a', 'feat/123/', ''])('末尾が数字だけの区切りでない %j は undefined を返す', (branch) => {
    expect(extractIssueNumberFromBranch(branch)).toBeUndefined()
  })
})
