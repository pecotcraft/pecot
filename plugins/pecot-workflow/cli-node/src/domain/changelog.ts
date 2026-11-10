// CHANGELOG.md の検証ロジック。Keep a Changelog 形式とセマンティックバージョニングに準拠する。
// ファイルは読まない。内容（文字列）を受けて値を返す。ファイルを読む側は infra/changelog-file.ts にある。
// Python の re と同じ判定にする（\d は Unicode の 10 進数字、\s は str.isspace、$ は末尾の改行 1 つの前でも合う）。

import { PecotError, BaseError } from './errors.js'
import { pythonStrip, splitCodePoints } from './python-format.js'

export class ChangelogError extends PecotError {}

/**
セマンティックバージョニング形式（X.Y.Z）に準拠していない
*/
export class InvalidVersionError extends ChangelogError {}

/**
CHANGELOG.md にバージョン情報が存在しない
*/
export class VersionNotFoundError extends ChangelogError {}

/**
CHANGELOG.md が存在しない。Python の FileNotFoundError に当たるので、PecotError ではない
*/
export class ChangelogFileNotFoundError extends BaseError {}

export const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md'
export const CHANGELOG_FALLBACK_FILES: readonly string[] = ['CHANGELOG.md', 'AIST-CHANGELOG.md']

// X.Y.Z 形式。先頭に `v` は付けない
const SEMVER_PATTERN = /^\p{Nd}+\.\p{Nd}+\.\p{Nd}+\n?$/u

// バージョン行の見出し記号と空白より後ろを見る。行の形は `## [X.Y.Z] - YYYY-MM-DD`。
const VERSION_PATTERN = /^\[(\p{Nd}+\.\p{Nd}+\.\p{Nd}+)\]/u

// str.splitlines() の区切り。U+001C〜U+001E も含む。量指定子は無く、unsafe-regex は誤検知。
// eslint-disable-next-line no-control-regex, security/detect-unsafe-regex -- 区切りの制御文字と誤検知
const LINE_BREAK = /[\n\r\v\f\u{1C}-\u{1E}\u{85}\u{2028}\u{2029}]/u

function splitLines(content: string): readonly string[] {
  // 改行コードの \r\n は区切り 1 つと数えるため、先に \n へ揃える
  const lines = content.replaceAll('\r\n', '\n').split(LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
`##` + 空白 1 つ以上で始まる行の、空白の後ろを返す。そうでなければ undefined。
空白は Python の `\s`（str.isspace）と同じ。pythonStrip で先頭の空白を落として確かめる
*/
function headingRest(line: string): string | undefined {
  if (!line.startsWith('##')) return undefined
  const body = line.slice(2)
  return body === '' || pythonStrip(splitCodePoints(body)[0] ?? '') !== '' ? undefined : pythonStrip(body)
}

/**
パス末尾のファイル名。エラー文に、実際に探したファイルの名前を出すために使う
*/
export function changelogFileName(changelogPath: string): string {
  return changelogPath.slice(changelogPath.lastIndexOf('/') + 1)
}

/**
CHANGELOG が無いときの文
*/
export function changelogNotFoundMessage(changelogPath: string): string {
  return `${changelogFileName(changelogPath)} not found: ${changelogPath}`
}

/**
セマンティックバージョニング形式を検証する。形式違反は InvalidVersionError
*/
export function validateSemver(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new InvalidVersionError(
      `invalid version format: ${version}\n`
      + 'use semantic versioning (X.Y.Z)',
    )
  }
}

/**
## [X.Y.Z] 形式の最初のバージョンを返す。Unreleased は飛ばす。無ければ VersionNotFoundError。
fileName は、エラー文に出す CHANGELOG のファイル名
*/
export function getLatestVersion(content: string, fileName = DEFAULT_CHANGELOG_FILE): string {
  for (const line of splitLines(content)) {
    const version = VERSION_PATTERN.exec(headingRest(line) ?? '')?.[1]
    if (version !== undefined) return version
  }
  throw new VersionNotFoundError(
    `no version found in ${fileName}\n`
    + 'for a first release, specify the version manually',
  )
}

/**
## [X.Y.Z] の次の行から次の `## ` セクションまでの内容を返す。無ければ VersionNotFoundError。
fileName は、エラー文に出す CHANGELOG のファイル名
*/
export function extractVersionReleaseNotes(content: string, version: string, fileName = DEFAULT_CHANGELOG_FILE): string {
  const heading = `[${version}]`
  let isInVersion = false
  const versionLines: string[] = []

  for (const line of splitLines(content)) {
    if (headingRest(line)?.startsWith(heading) === true) {
      isInVersion = true
      continue
    }
    if (!isInVersion) continue
    // 次の ## セクションが来たら終了
    if (line.startsWith('## ')) break
    versionLines.push(line)
  }

  if (!isInVersion) throw new VersionNotFoundError(`version not found in ${fileName}: ${version}`)
  return pythonStrip(versionLines.join('\n'))
}
