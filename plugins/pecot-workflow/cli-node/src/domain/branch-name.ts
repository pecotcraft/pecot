// ブランチ名の読み取り。pecot create-branch が作る名前は、末尾が `/Issue番号` になる。
import { parsePythonInteger } from './python-format.js'

/**
ブランチ名の末尾の Issue 番号。末尾が数字だけの区切りでなければ undefined
*/
export function extractIssueNumberFromBranch(branch: string): number | undefined {
  const last = branch.split('/').at(-1) ?? ''
  return /^\p{Nd}+$/u.test(last) ? parsePythonInteger(last) : undefined
}
