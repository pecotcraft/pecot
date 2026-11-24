// フック状態の規則（フラグ名・セッション名・作業ディレクトリ名）。ファイルの読み書きは infra/state-store.ts が行う。

import { InvalidValueError } from './errors.js'
import { parsePythonInteger, pythonRightStrip, pythonStrip, pythonStringRepr, truncateCodePoints } from './python-format.js'
import { createIssueReference, issueReferenceToString } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { createRepositoryReference } from './repository-resolver.js'

// フラグファイル名
// セッション名のキャッシュ（hooks の session-title.sh が Claude Code の sessionTitle に流す）。session start がブランチを作るときに書く
export const FLAG_PECOT_SESSION_TITLE = '.pecot-session-title'
// 着手のときに選んだ base（ブランチ・位置・スタック先の Issue）。session start が書き、session finish が消す
export const FLAG_PECOT_BASE = '.pecot-base'
// 衝突で止まったスタックし直しの途中の記録。pr restack が書き、続行か取りやめで消す
export const FLAG_PECOT_RESTACK = '.pecot-restack'
// 片付けを終えた PR（1 行に 1 つ）。session finish が足し、merge-diff を確かめた session start が消す
export const FLAG_PECOT_MERGED = '.pecot-merged'

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
  スタック先の Issue。開発ブランチから着手したときは undefined
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
.pecot-base の 1 行。`<branch> <sha>` に、スタックしたときは ` <owner/repo#N>` を続ける
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

/**
.pecot-session-title の先頭の `#<番号>`。読めなければ undefined
*/
export function sessionTitleNumber(content = ''): number | undefined {
  const digits = /^#(\d+)/u.exec(content)?.[1]
  return digits === undefined ? undefined : Number(digits)
}

/**
.pecot-merged の内容。1 行に 1 つの `owner/repo#N`。形の誤った行は読み飛ばす
*/
export function interpretMergedRecord(content = ''): IssueReference[] {
  const references = content.split('\n').map(line => parseStackedOn(pythonStrip(line)))
  return references.filter(reference => reference !== undefined)
}

/**
.pecot-merged の内容を組み立てる。同じ PR は 1 つにまとめる
*/
export function formatMergedRecord(references: readonly IssueReference[]): string {
  return [...new Set(references.map(reference => issueReferenceToString(reference)))].join('\n')
}

export interface RestackProgress {
  readonly remote: string
  /**
  スタックし直しているブランチ。rebase の途中は HEAD が detached なので、ここから読む
  */
  readonly branch: string
  /**
  スタックし直す前のブランチの先頭。remote にだけある変更が見つかったときに、ここへ戻す
  */
  readonly originalSha: string
  readonly ontoBranch: string
  readonly ontoSha: string
  /**
  push の `--force-with-lease` に渡す、fetch した時点の remote の SHA。remote にブランチが無ければ undefined
  */
  readonly leaseSha: string | undefined
  /**
  スタックし直した後もスタックの記録を保つなら、スタック先の Issue。開発ブランチへスタックし直すなら undefined
  */
  readonly stackedOn: IssueReference | undefined
  /**
  スタックし直す前のスタックの記録の位置。`--continue` が remote にだけある変更を数えるときに除く。古い版の途中の記録には無い
  */
  readonly recordSha: string | undefined
}

export type RestackProgressReading
  = | { readonly kind: 'none' }
    | { readonly kind: 'progress', readonly progress: RestackProgress }
    | { readonly kind: 'malformed', readonly content: string }

const ABSENT = '-'

/**
.pecot-restack の 1 行。項目は `<remote> <branch> <originalSha> <ontoBranch> <ontoSha> <leaseSha> <owner/repo#N> <recordSha>`。
無い項目は `-`
*/
export function formatRestackProgress(progress: Readonly<RestackProgress>): string {
  const stackedOn = progress.stackedOn === undefined ? ABSENT : issueReferenceToString(progress.stackedOn)
  return [progress.remote, progress.branch, progress.originalSha, progress.ontoBranch, progress.ontoSha, progress.leaseSha ?? ABSENT, stackedOn, progress.recordSha ?? ABSENT].join(' ')
}

// 無い項目の `-` か SHA
function optionalSha(text: string | undefined): { readonly isValid: boolean, readonly sha: string | undefined } {
  if (text === undefined || text === ABSENT) return { isValid: true, sha: undefined }
  return BASE_SHA_PATTERN.test(text) ? { isValid: true, sha: text } : { isValid: false, sha: undefined }
}

/**
.pecot-restack を読む。ファイルが無ければ none、形が誤っていれば malformed。
古い版が書いた 7 項目の行も読み、recordSha を undefined にする
*/
export function interpretRestackProgress(content: string | undefined): RestackProgressReading {
  if (content === undefined) return { kind: 'none' }
  const malformed: RestackProgressReading = { kind: 'malformed', content }
  const [remote, branch, originalSha, ontoBranch, ontoSha, lease, issue, record, ...rest] = content.split(' ')
  if (remote === undefined || branch === undefined || originalSha === undefined || ontoBranch === undefined || ontoSha === undefined || lease === undefined || issue === undefined || rest.length > 0 || [remote, branch, ontoBranch].includes('') || !BASE_SHA_PATTERN.test(ontoSha) || !BASE_SHA_PATTERN.test(originalSha)) return malformed
  const leaseSha = optionalSha(lease)
  const recordSha = optionalSha(record)
  if (!leaseSha.isValid || !recordSha.isValid) return malformed
  const stackedOn = issue === ABSENT ? undefined : parseStackedOn(issue)
  return issue !== ABSENT && stackedOn === undefined ? malformed : { kind: 'progress', progress: { remote, branch, originalSha, ontoBranch, ontoSha, leaseSha: leaseSha.sha, stackedOn, recordSha: recordSha.sha } }
}
