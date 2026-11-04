// Issue 種別判定（GitHub の Issue 種別の取得結果に対する純関数）。

import { pythonStrip } from './python-format.js'

export const EPIC_TYPE_NAME = 'Epic'

/**
Issue 種別の取得結果。キー名は Python の CLI が返していた辞書と同じ
*/
export interface IssueKind {
  readonly issue_type?: string | null | undefined
  readonly sub_issues_total?: number | undefined
}

/**
Issue Type=Epic、または subIssues.totalCount > 0 を Epic とみなす。
1. issue_type が `Epic` なら true（大文字小文字は区別しない）。
2. issue_type が空・未設定で sub_issues_total > 0 なら true（Issue Type が無かった頃のフォールバック）。
3. それ以外は false。
*/
export function isEpicIssue(issueKind: IssueKind): boolean {
  const issueType = pythonStrip(issueKind.issue_type ?? '')
  const isEpicType = issueType.toLowerCase() === EPIC_TYPE_NAME.toLowerCase()
  const isFallback = issueType === '' && (issueKind.sub_issues_total ?? 0) > 0
  return isEpicType || isFallback
}
