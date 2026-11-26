// ブランチ名の読み取り。pecot session start が作る名前は、末尾が `/Issue番号` になる。
import { parsePythonInteger, ValidationFailure } from './python-format.js'
import { createIssueReference } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { createRepositoryReference } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

/**
ブランチ名の末尾の Issue 番号。末尾が数字だけの区切りでなければ undefined
*/
export function extractIssueNumberFromBranch(branch: string): number | undefined {
  const last = branch.split('/').at(-1) ?? ''
  return /^\p{Nd}+$/u.test(last) ? parsePythonInteger(last) : undefined
}

/**
作業中の Issue。remote のリポとブランチ名の末尾の番号から決める。
remote かブランチが無いとき、末尾が数字だけの区切りでないとき、番号が 0 のときは undefined。detached HEAD の `HEAD` も undefined になる
*/
export function activeIssueFromBranch(remote: Readonly<RepositoryReference> | undefined, branch: string | undefined): IssueReference | undefined {
  if (remote === undefined || branch === undefined) return undefined
  const number = extractIssueNumberFromBranch(branch)
  if (number === undefined || number <= 0) return undefined
  try {
    return createIssueReference(createRepositoryReference(remote.owner, remote.repository), number)
  }
  catch (error: unknown) {
    // owner・repo に使えない文字が入った remote は、形の合わない remote として扱う
    if (error instanceof ValidationFailure) return undefined
    throw error
  }
}
