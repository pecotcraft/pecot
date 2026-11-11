import { describe, expect, it } from 'vitest'

import { extractIssueNumberFromBranch } from '../branch-issue.js'

describe('extractIssueNumberFromBranch', () => {
  it.each([
    ['feat/description/470', 470],
    ['fix/bug-fix/123', 123],
    ['123', 123],
    ['feat/x/007', 7],
    ['feat/x/１２', 12],
  ])('末尾が数字の %j から Issue 番号を取り出す', (branch, expected) => {
    expect(extractIssueNumberFromBranch(branch)).toBe(expected)
  })

  it.each([
    ['main'],
    ['feat/no-issue-number'],
    ['feat/123/x'],
    ['feat/x/12a'],
    ['feat/x/'],
    [''],
    ['feat/x/²'],
  ])('末尾が数字でない %j は undefined', (branch) => {
    expect(extractIssueNumberFromBranch(branch)).toBeUndefined()
  })
})
