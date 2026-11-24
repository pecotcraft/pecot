// merge-diff のコメントが、どの PR のものかを示す印。issue comment が付け、session start が探す。
import { issueReferenceToString } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'

/**
本文の先頭に置く印の 1 行。PR は `owner/repo#N` の形で書く
*/
export function mergeDiffMarker(pullRequest: IssueReference): string {
  return `<!-- pecot-merge-diff: pr=${issueReferenceToString(pullRequest)} -->`
}

/**
本文の先頭に印を付ける。前の印は除いてから付ける
*/
export function withMergeDiffMarker(body: string, pullRequest: IssueReference): string {
  const rest = body.replace(/^\s*<!-- pecot-merge-diff: pr=\S+ -->\n*/u, '')
  return `${mergeDiffMarker(pullRequest)}\n\n${rest}`
}

/**
コメントの本文が、その PR の merge-diff の印を持つか。owner と repo の大文字小文字は区別しない
*/
export function hasMergeDiffMarker(body: string, pullRequest: IssueReference): boolean {
  return body.toLowerCase().includes(mergeDiffMarker(pullRequest).toLowerCase())
}
