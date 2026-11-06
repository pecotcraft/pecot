// フック状態の規則（フラグ名・セッション名・作業ディレクトリ名）。ファイルの読み書きは infra/state-store.ts が行う。

import { InvalidValueError } from './errors.js'
import { parsePythonInteger, pythonRightStrip, pythonStrip, pythonStringRepr, truncateCodePoints } from './python-format.js'

// フラグファイル名
export const FLAG_PECOT_ACTIVE = '.pecot-active'
// セッション名（hooks の session-title.sh が Claude Code の sessionTitle に流す）。.pecot-active と同じタイミングで書く
export const FLAG_PECOT_SESSION_TITLE = '.pecot-session-title'
export const FLAG_PECOT_QUICK_MODE = '.pecot-quick-mode'

// スラッシュコマンド起点の外部反映免除フラグ。設置は hooks の create-slash-flag.sh、確認は external-post-check.sh。CLI が実投稿成功時に削除する
export const FLAG_PR_CREATE_SLASH_PENDING = 'pr-create-slash-pending'
export const FLAG_ISSUE_CREATE_SLASH_PENDING = 'issue-create-slash-pending'

// 起票未完了のリマインド用フラグ。設置は hooks、確認は pecot-issue-pending-reminder.sh。CLI が起票成功時に削除する
export const FLAG_ISSUE_PENDING = 'issue-pending'

export const SESSION_TITLE_MAX_CHARS = 40
const ISSUE_TYPE_PREFIX_PATTERN = /^\[(?:Task|Bug|Epic)\]\s*/u

/**
セッション名 `#<番号> <Issue タイトル>` を組み立てる。
先頭の種別接頭辞（`[Task]` 等）を落とし、全体を SESSION_TITLE_MAX_CHARS 文字（コードポイント）で切る。
タイトルが空なら `#<番号>` だけにする
*/
export function formatSessionTitle(issueNumber: number, title: string): string {
  const body = pythonStrip(title.replace(ISSUE_TYPE_PREFIX_PATTERN, ''))
  const name = body === '' ? `#${String(issueNumber)}` : `#${String(issueNumber)} ${body}`
  return pythonRightStrip(truncateCodePoints(name, SESSION_TITLE_MAX_CHARS))
}

function lastSegment(issueReference: string): string {
  let end = issueReference.length
  while (end > 0 && issueReference.charAt(end - 1) === '/') end -= 1
  const trimmed = issueReference.slice(0, end)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
作業ディレクトリ `.pecot/work/<Issue番号>/` の番号。参照（`owner/repo/N` または `N`）の末尾が ASCII の数字でなければ undefined。
`.pecot/work` の直下は Issue 番号の数字だけにする規約のため、全角数字などは通さない
*/
export function workDirectoryName(issueReference: string): string | undefined {
  const number = lastSegment(issueReference)
  return /^\d+$/u.test(number) ? number : undefined
}

export interface WorkTarget {
  readonly active: string
  readonly sessionTitle: string
}

/**
作業対象として書く内容（.pecot-active と .pecot-session-title）を決める。参照の末尾が整数でなければ InvalidValueError
*/
export function planWorkTarget(issueReference: string, title: string): WorkTarget {
  const text = lastSegment(issueReference)
  const number = parsePythonInteger(text)
  if (number === undefined) throw new InvalidValueError(`invalid literal for int() with base 10: ${pythonStringRepr(text)}`)
  return { active: issueReference, sessionTitle: formatSessionTitle(number, title) }
}
