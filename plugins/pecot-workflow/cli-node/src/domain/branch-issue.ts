// ブランチ名の末尾から Issue 番号を取り出す。入出力を持たない。

import { parsePythonInteger } from './python-format.js'

/**
`/` で区切った最後の部分が数字だけなら、その整数を返す。そうでなければ undefined。
Unicode の 10 進数字（全角・アラビア数字など）も受ける。上付き数字のように Python では int() が例外になる文字は undefined にする
*/
export function extractIssueNumberFromBranch(branch: string): number | undefined {
  const last = branch.slice(branch.lastIndexOf('/') + 1)
  return /^\p{Nd}+$/u.test(last) ? parsePythonInteger(last) : undefined
}
