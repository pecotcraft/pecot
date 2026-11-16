// フック状態の規則（フラグ名・セッション名・作業ディレクトリ名）。ファイルの読み書きは infra/state-store.ts が行う。

import { InvalidValueError } from './errors.js'
import { parsePythonInteger, pythonRightStrip, pythonStrip, pythonStringRepr, truncateCodePoints } from './python-format.js'
import { createIssueReference, issueReferenceToString } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { createRepositoryReference } from './repository-resolver.js'

// フラグファイル名
// セッション名のキャッシュ（hooks の session-title.sh が Claude Code の sessionTitle に流す）。session start がブランチを作るときに書く
export const FLAG_PECOT_SESSION_TITLE = '.pecot-session-title'
// 着手のときに選んだ base（ブランチ・位置・積んだ先の Issue）。session start が書き、session finish が消す
export const FLAG_PECOT_BASE = '.pecot-base'
// 衝突で止まった載せ直しの途中の記録。pr restack が書き、続行か取りやめで消す
export const FLAG_PECOT_RESTACK = '.pecot-restack'
export const FLAG_PECOT_QUICK_MODE = '.pecot-quick-mode'
export const FLAG_WIP_BRANCH_LINKED = '.wip-branch-linked'

// スラッシュコマンド起点の外部反映免除フラグ。
// 設置は hooks の create-slash-flag.sh が行う。
// 確認は mcp-handlers/pecot-post-ask.sh（merge は pr_merge も。gh pr merge は core/external-post-check.sh）が行う。
// MCP ツールが実投稿成功時に削除する。
export const FLAG_PR_CREATE_SLASH_PENDING = 'pr-create-slash-pending'
export const FLAG_ISSUE_CREATE_SLASH_PENDING = 'issue-create-slash-pending'
export const FLAG_MERGE_SLASH_PENDING = 'merge-slash-pending'

// 起票未完了のリマインド用フラグ。設置は hooks、確認は pecot-issue-pending-reminder.sh。MCP ツールが起票成功時に削除する
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

/**
作業対象のセッション名（.pecot-session-title に書く内容）を決める。参照の末尾が整数でなければ InvalidValueError
*/
export function planWorkTarget(issueReference: string, title: string): string {
  const text = lastSegment(issueReference)
  const number = parsePythonInteger(text)
  if (number === undefined) throw new InvalidValueError(`invalid literal for int() with base 10: ${pythonStringRepr(text)}`)
  return formatSessionTitle(number, title)
}

export interface BaseRecord {
  readonly branch: string
  readonly sha: string
  /**
  積んだ先の Issue。開発ブランチから着手したときは undefined
  */
  readonly stackedOn: IssueReference | undefined
}

export type BaseReading
  = | { readonly kind: 'development', readonly record: BaseRecord | undefined }
    | { readonly kind: 'stacked', readonly record: BaseRecord, readonly stackedOn: IssueReference }
    | { readonly kind: 'malformed', readonly content: string }

// ブランチ名に空白は入らないので、空白で区切る
const BASE_SHA_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u
const BASE_ISSUE_PATTERN = /^([^\s#/]+)\/([^\s#/]+)#(\d+)$/u

/**
.pecot-base の 1 行。`<branch> <sha>` に、積んだときは ` <owner/repo#N>` を続ける
*/
export function formatBaseRecord(record: Readonly<BaseRecord>): string {
  const fields = [record.branch, record.sha]
  if (record.stackedOn !== undefined) fields.push(issueReferenceToString(record.stackedOn))
  return fields.join(' ')
}

function parseStackedOn(text: string): IssueReference | undefined {
  const match = BASE_ISSUE_PATTERN.exec(text)
  const [, owner, repository, digits] = match ?? []
  if (owner === undefined || repository === undefined || digits === undefined) return undefined
  const number = Number(digits)
  return number > 0 ? createIssueReference(createRepositoryReference(owner, repository), number) : undefined
}

/**
.pecot-base の内容を読む。ファイルが無いのは、この機能の前に着手したものも含めて、開発ブランチから着手したものとして扱う。
形が誤っていれば malformed
*/
export function interpretBaseRecord(content: string | undefined): BaseReading {
  if (content === undefined) return { kind: 'development', record: undefined }
  const [branch, sha, issue, ...rest] = content.split(' ')
  if (branch === undefined || branch === '' || sha === undefined || !BASE_SHA_PATTERN.test(sha) || rest.length > 0) return { kind: 'malformed', content }
  if (issue === undefined) return { kind: 'development', record: { branch, sha, stackedOn: undefined } }
  const stackedOn = parseStackedOn(issue)
  return stackedOn === undefined ? { kind: 'malformed', content } : { kind: 'stacked', record: { branch, sha, stackedOn }, stackedOn }
}

export interface RestackProgress {
  readonly remote: string
  /**
  載せ直しているブランチ。rebase の途中は HEAD が detached なので、ここから読む
  */
  readonly branch: string
  /**
  載せ直す前のブランチの先頭。remote にだけある変更が見つかったときに、ここへ戻す
  */
  readonly originalSha: string
  readonly ontoBranch: string
  readonly ontoSha: string
  /**
  push の `--force-with-lease` に渡す、fetch した時点の remote の SHA。remote にブランチが無ければ undefined
  */
  readonly leaseSha: string | undefined
  /**
  載せ直した後も積んだ記録を保つなら、積んだ先の Issue。開発ブランチへ載せ直すなら undefined
  */
  readonly stackedOn: IssueReference | undefined
}

export type RestackProgressReading
  = | { readonly kind: 'none' }
    | { readonly kind: 'progress', readonly progress: RestackProgress }
    | { readonly kind: 'malformed', readonly content: string }

const ABSENT = '-'

/**
.pecot-restack の 1 行。`<remote> <branch> <originalSha> <ontoBranch> <ontoSha> <leaseSha> <owner/repo#N>` で、無い項目は `-`
*/
export function formatRestackProgress(progress: Readonly<RestackProgress>): string {
  const stackedOn = progress.stackedOn === undefined ? ABSENT : issueReferenceToString(progress.stackedOn)
  return [progress.remote, progress.branch, progress.originalSha, progress.ontoBranch, progress.ontoSha, progress.leaseSha ?? ABSENT, stackedOn].join(' ')
}

/**
.pecot-restack の内容を読む。ファイルが無ければ none、形が誤っていれば malformed
*/
export function interpretRestackProgress(content: string | undefined): RestackProgressReading {
  if (content === undefined) return { kind: 'none' }
  const malformed: RestackProgressReading = { kind: 'malformed', content }
  const [remote, branch, originalSha, ontoBranch, ontoSha, lease, issue, ...rest] = content.split(' ')
  if (remote === undefined || branch === undefined || originalSha === undefined || ontoBranch === undefined || ontoSha === undefined || lease === undefined || issue === undefined || rest.length > 0 || [remote, branch, ontoBranch].includes('') || !BASE_SHA_PATTERN.test(ontoSha) || !BASE_SHA_PATTERN.test(originalSha)) return malformed
  if (lease !== ABSENT && !BASE_SHA_PATTERN.test(lease)) return malformed
  const stackedOn = issue === ABSENT ? undefined : parseStackedOn(issue)
  if (issue !== ABSENT && stackedOn === undefined) return malformed
  return { kind: 'progress', progress: { remote, branch, originalSha, ontoBranch, ontoSha, leaseSha: lease === ABSENT ? undefined : lease, stackedOn } }
}
