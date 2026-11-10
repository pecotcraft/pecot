// talk-dir の package.json が書くテーマの取得元（spec）を解釈する。
//
// 受けるのは次の 2 形式。
// - `git+https://<host>/<owner>/<repo>.git#<tag>`（`git+ssh://` も可。テストはローカルの bare リポジトリを `git+file://` で指す）
// - `file:<path>`
//
// タグは semver.org 公式の正規表現に合うものだけを通す（先頭の `v` を許す）。
// 同名のブランチは書式で区別できない。取得側（#1343）が `refs/tags/<tag>` を明示して解決する。
// ブランチ名・短縮 SHA・40 桁 SHA は、いずれもタグの書式でないため拒む。

export type ThemeSpec
  = | { readonly kind: 'git', readonly url: string, readonly tag: string }
    | { readonly kind: 'file', readonly path: string }

export type ThemeSpecErrorReason = 'tag-required' | 'tag-format' | 'semver-range' | 'unsupported-spec'

export class ThemeSpecError extends Error {
  constructor(message: string, readonly reason: ThemeSpecErrorReason) {
    super(message)
    this.name = 'ThemeSpecError'
  }
}

// semver.org 公式の正規表現（2.0.0）を、意味を変えずに 3 つの正規表現へ分けたもの。先頭の `v` だけ許す。
const SEMVER_CORE = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const SEMVER_PRERELEASE_IDENTIFIER = /^(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)$/iu
const SEMVER_BUILD_IDENTIFIER = /^[\da-z-]+$/iu

const GIT_PREFIX = /^git\+(?:https|ssh|file):\/\//u
const FILE_PREFIX = 'file:'
const SEMVER_RANGE_PREFIX = 'semver:'

/**
テーマの取得元の文字列を ThemeSpec にする。
解釈できないものは ThemeSpecError で拒む。
*/
export function parseThemeSpec(text: string): ThemeSpec {
  if (text.startsWith(FILE_PREFIX)) {
    const filePath = text.slice(FILE_PREFIX.length)
    if (filePath === '') {
      throw new ThemeSpecError(`theme spec has no path: ${text}`, 'unsupported-spec')
    }
    return { kind: 'file', path: filePath }
  }

  if (!GIT_PREFIX.test(text)) {
    throw new ThemeSpecError(
      `cannot parse the theme spec: ${text} (fix: write git+https://<host>/<owner>/<repo>.git#<tag> or file:<path>)`,
      'unsupported-spec',
    )
  }

  const hashIndex = text.indexOf('#')
  if (hashIndex === -1 || hashIndex === text.length - 1) {
    throw new ThemeSpecError(`theme spec has no tag: ${text} (fix: add #<tag>)`, 'tag-required')
  }

  const tag = text.slice(hashIndex + 1)
  if (tag.startsWith(SEMVER_RANGE_PREFIX)) {
    throw new ThemeSpecError(`semver ranges (#semver:) are not allowed in the theme spec: ${text} (fix: write a single tag)`, 'semver-range')
  }
  if (!isSemverTag(tag)) {
    throw new ThemeSpecError(`invalid tag format in the theme spec: ${tag} in ${text} (e.g. 1.2.3 or v1.2.3)`, 'tag-format')
  }

  const url = text.slice('git+'.length, hashIndex)
  return { kind: 'git', url, tag }
}

function isSemverTag(tag: string): boolean {
  const [withoutBuild = '', ...buildParts] = tag.split('+')
  if (buildParts.length > 1) return false
  if (buildParts.length === 1 && (buildParts[0] ?? '').split('.').some(part => !SEMVER_BUILD_IDENTIFIER.test(part))) return false

  const dashIndex = withoutBuild.indexOf('-')
  if (dashIndex === -1) return SEMVER_CORE.test(withoutBuild)
  const prerelease = withoutBuild.slice(dashIndex + 1)
  return SEMVER_CORE.test(withoutBuild.slice(0, dashIndex))
    && prerelease.split('.').every(part => SEMVER_PRERELEASE_IDENTIFIER.test(part))
}
