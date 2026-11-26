import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { JSON_NULL } from '../json-null.js'
import { EPIC_TYPE_NAME, isEpicIssue } from '../issue-kind.js'

describe('isEpicIssue', () => {
  it('Issue Type が Epic の場合は、Epic と判定する', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が `Epic` の場合に、`true` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: 'Epic', sub_issues_total: 0 })).toBe(true)
  })

  it('Issue Type の大文字と小文字を区別せずに判定する', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が小文字の `epic` の場合でも、`true` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: 'epic', sub_issues_total: 0 })).toBe(true)
  })

  it('Issue Type が未設定で sub-issue がある場合は、Epic と判定する（フォールバック）', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が未設定（`null`）で sub-issue が 1 件以上ある場合に、フォールバックとして `true` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: JSON_NULL, sub_issues_total: 3 })).toBe(true)
  })

  it('Issue Type が空文字で sub-issue がある場合は、Epic と判定する', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が空文字で sub-issue が 1 件以上ある場合に、未設定と同じく `true` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: '', sub_issues_total: 2 })).toBe(true)
  })

  it('Issue Type が空白だけの場合は、未設定として扱い、前後の空白は無視する', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が空白だけの場合は未設定として扱い、` epic ` のように前後に空白がある場合は空白を除いて判定することを確認します。')
    expect(isEpicIssue({ issue_type: ' \t', sub_issues_total: 2 })).toBe(true)
    expect(isEpicIssue({ issue_type: ' epic ', sub_issues_total: 0 })).toBe(true)
  })

  it('Issue Type が Task の場合は、Epic と判定しない', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が `Task` で sub-issue がない場合に、`false` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: 'Task', sub_issues_total: 0 })).toBe(false)
  })

  it('Issue Type を設定している場合は、sub-issue があってもフォールバックを使わない', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が `Task` で sub-issue が 5 件ある場合に、フォールバックを使わず `false` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: 'Task', sub_issues_total: 5 })).toBe(false)
  })

  it('Issue Type が未設定で sub-issue が 0 件の場合は、判定できないため Epic と判定しない（既知の制約）', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type が未設定で sub-issue も 0 件の場合に、判定できないため（既知の制約です）`false` を返すことを確認します。')
    expect(isEpicIssue({ issue_type: JSON_NULL, sub_issues_total: 0 })).toBe(false)
  })

  it('Issue Type と sub-issue の件数のキーが存在しない場合は、Epic と判定しない', async () => {
    await explains('Issue が Epic かどうかを判定する、`isEpicIssue` のテストです。Issue Type と sub-issue の件数のキーがどちらも存在しない場合に、`false` を返すことを確認します。')
    expect(isEpicIssue({})).toBe(false)
  })

  it('Epic の Issue Type の名前に、Epic を使用する', async () => {
    await explains('Epic の Issue Type の名前を表す定数 `EPIC_TYPE_NAME` のテストです。値が `Epic` であることを確認します。')
    expect(EPIC_TYPE_NAME).toBe('Epic')
  })
})
