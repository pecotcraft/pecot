// REST の URL に連結するパスの符号化。owner・リポジトリ名・ブランチ名は、セグメントごとに符号化する。
// `.` と `..` のセグメントは、`%2E` で書いても URL の解釈でパスを辿る意味になる。
// だから送らず、GitHubAPIError で止める。

import { GitHubAPIError } from './errors.js'
import { splitCodePoints } from '../../domain/python-format.js'

// encodeURIComponent が符号化しない記号のうち、httpx が符号化するもの
const EXTRA_RESERVED: ReadonlyMap<string, string> = new Map([['!', '%21'], ['\'', '%27'], ['(', '%28'], [')', '%29'], ['*', '%2A']])

/**
パスの 1 セグメントを符号化する。encodeURIComponent が残す `!'()*` も符号化する。
`.` と `..` は GitHubAPIError
*/
export function encodePathSegment(segment: string): string {
  if (segment === '.' || segment === '..') throw new GitHubAPIError(`URL のパスに使えない名前です: ${segment}`)
  return splitCodePoints(encodeURIComponent(segment))
    .map(character => EXTRA_RESERVED.get(character) ?? character)
    .join('')
}

/**
`/repos/<owner>/<repository>`
*/
export function repositoryPath(owner: string, repository: string): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repository)}`
}

/**
スラッシュ区切りのパス（ブランチ名など）を、セグメントごとに符号化する。スラッシュは残す
*/
export function encodePath(path: string): string {
  return path.split('/').map(segment => encodePathSegment(segment)).join('/')
}
