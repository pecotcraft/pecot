// release_check が読む手元の git。タグ・前のリリースのタグ・commit の数。
import { gitStdout } from '@pecot/workflow-core/infra/git.js'

export function hasLocalTag(cwd: string, tag: string): boolean {
  return (gitStdout(['tag', '-l', tag], { cwd }) ?? '').split('\n').map(line => line.trim()).includes(tag)
}

export function hasCommit(cwd: string, sha: string): boolean {
  return gitStdout(['cat-file', '-e', `${sha}^0`], { cwd }) !== undefined
}

/**
sha から辿れる、いちばん近いリリースのタグ。prefix があれば `<prefix>-v*`、無ければ `v*`。無ければ undefined
*/
export function previousReleaseTag(cwd: string, sha: string, prefix: string | undefined): string | undefined {
  const pattern = prefix === undefined ? 'v[0-9]*' : `${prefix}-v[0-9]*`
  const tag = gitStdout(['describe', '--tags', '--abbrev=0', '--match', pattern, sha], { cwd })?.trim()
  return tag === undefined || tag === '' ? undefined : tag
}

/**
from から to までの commit の数。数えられなければ undefined
*/
export function commitsBetween(cwd: string, from: string, to: string): number | undefined {
  const count = gitStdout(['rev-list', '--count', `${from}..${to}`], { cwd })?.trim()
  return count === undefined || !/^\d+$/u.test(count) ? undefined : Number(count)
}
