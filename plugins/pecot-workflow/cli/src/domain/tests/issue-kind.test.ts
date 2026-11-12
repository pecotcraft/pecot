import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'
import { EPIC_TYPE_NAME, isEpicIssue } from '../issue-kind.js'

describe('isEpicIssue', () => {
  it('Issue Type が Epic なら Epic', () => {
    expect(isEpicIssue({ issue_type: 'Epic', sub_issues_total: 0 })).toBe(true)
  })

  it('Issue Type は大文字小文字を区別しない', () => {
    expect(isEpicIssue({ issue_type: 'epic', sub_issues_total: 0 })).toBe(true)
  })

  it('Issue Type が未設定で sub-issue があれば Epic（フォールバック）', () => {
    expect(isEpicIssue({ issue_type: JSON_NULL, sub_issues_total: 3 })).toBe(true)
  })

  it('Issue Type が空文字で sub-issue があれば Epic', () => {
    expect(isEpicIssue({ issue_type: '', sub_issues_total: 2 })).toBe(true)
  })

  it('Issue Type が空白だけでも、未設定として扱う', () => {
    expect(isEpicIssue({ issue_type: ' \t', sub_issues_total: 2 })).toBe(true)
    expect(isEpicIssue({ issue_type: ' epic ', sub_issues_total: 0 })).toBe(true)
  })

  it('Task は Epic ではない', () => {
    expect(isEpicIssue({ issue_type: 'Task', sub_issues_total: 0 })).toBe(false)
  })

  it('Issue Type を明示していれば、sub-issue があってもフォールバックを使わない', () => {
    expect(isEpicIssue({ issue_type: 'Task', sub_issues_total: 5 })).toBe(false)
  })

  it('Issue Type 未設定かつ sub-issue 0 件は判定不能なので Epic ではない（既知の制約）', () => {
    expect(isEpicIssue({ issue_type: JSON_NULL, sub_issues_total: 0 })).toBe(false)
  })

  it('キーが無ければ Epic ではない', () => {
    expect(isEpicIssue({})).toBe(false)
  })

  it('Epic の名前は Epic', () => {
    expect(EPIC_TYPE_NAME).toBe('Epic')
  })
})
