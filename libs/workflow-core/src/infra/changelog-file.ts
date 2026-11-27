/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。ここでは存在確認と読み取りだけ */
// CHANGELOG.md を読む。内容の解釈は domain/changelog.ts にある。

import { existsSync } from 'node:fs'
import path from 'node:path'

import { CHANGELOG_FALLBACK_FILES, changelogFileName, changelogNotFoundMessage, ChangelogFileNotFoundError, DEFAULT_CHANGELOG_FILE, extractVersionReleaseNotes, getLatestVersion } from '../domain/changelog.js'
import { readTextFile } from './text-file.js'

/**
CHANGELOG ファイルのパスを解決する。存在しない場合もパスだけ返す。
明示指定（空でない文字列）があればそれ、無ければ CHANGELOG.md → AIST-CHANGELOG.md の順に存在を確かめ、どちらも無ければ CHANGELOG.md。
明示指定が絶対パスならそのまま返す（pathlib の / と同じ）
*/
export function resolveChangelogPath(gitRoot: string, changelogFile?: string): string {
  if (changelogFile !== undefined && changelogFile !== '') {
    return path.isAbsolute(changelogFile) ? changelogFile : path.join(gitRoot, changelogFile)
  }
  const found = CHANGELOG_FALLBACK_FILES.map(candidate => path.join(gitRoot, candidate)).find(candidate => existsSync(candidate))
  return found ?? path.join(gitRoot, DEFAULT_CHANGELOG_FILE)
}

/**
ファイルがあれば内容、無ければ undefined
*/
export function readChangelogIfExists(changelogPath: string): string | undefined {
  return existsSync(changelogPath) ? readTextFile(changelogPath) : undefined
}

function readChangelog(changelogPath: string): string {
  const content = readChangelogIfExists(changelogPath)
  if (content === undefined) throw new ChangelogFileNotFoundError(changelogNotFoundMessage(changelogPath))
  return content
}

/**
ファイルから最新バージョンを取る。ファイルが無ければ ChangelogFileNotFoundError
*/
export function readLatestVersionFromFile(changelogPath: string): string {
  return getLatestVersion(readChangelog(changelogPath), changelogFileName(changelogPath))
}

/**
ファイルから指定バージョンのリリースノートを抽出する。ファイルが無ければ ChangelogFileNotFoundError
*/
export function extractReleaseNotesFromFile(changelogPath: string, version: string): string {
  return extractVersionReleaseNotes(readChangelog(changelogPath), version, changelogFileName(changelogPath))
}
