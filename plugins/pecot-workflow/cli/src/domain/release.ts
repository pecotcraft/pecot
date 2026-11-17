// リリース前チェック（preflight）。git は GitRunner を受けて呼ぶ。CHANGELOG は内容（文字列）を受ける。

import { changelogFileName, changelogNotFoundMessage, extractVersionReleaseNotes, getLatestVersion, validateSemver, VersionNotFoundError } from './changelog.js'
import { PecotError } from './errors.js'
import type { GitRunner } from './git-runner.js'
import { pythonStrip } from './python-format.js'

export class ReleaseError extends PecotError {}

export interface PreflightResult {
  readonly version: string
  readonly releaseNotes: string
  readonly developBranch: string
  readonly releaseBranch: string
  /**
  release→develop の差分コミット数
  */
  readonly diffCount: number
  /**
  作成予定のタグ名（`v0.6.1` または `pecot-workflow-v0.6.1`）
  */
  readonly tagName: string
}

export interface PreflightOptions {
  /**
  エラー文に出す CHANGELOG.md のパス
  */
  readonly changelogPath: string
  /**
  CHANGELOG.md の内容。ファイルが無ければ undefined
  */
  readonly changelogContent: string | undefined
  readonly developBranch: string
  readonly releaseBranch: string
  /**
  リリースバージョン。省略すると CHANGELOG から検出する
  */
  readonly version: string | undefined
  /**
  タグの prefix（monorepo 用）。空でなければ `<prefix>-v<ver>`、省略か空なら `v<ver>`
  */
  readonly tagPrefix: string | undefined
  /**
  ls-remote と文に使う remote 名。省略すると origin
  */
  readonly remote?: string | undefined
}

/**
base より head が進んでいる commit の数。GitHub の compare で数え、手元の ref は動かさない
*/
export type CountCommitsAhead = (base: string, head: string) => Promise<number>

/**
remote のタグの有無。尋ねられなければ failure に git の stderr
*/
export type RemoteTagLookup = { readonly isFound: boolean } | { readonly failure: string }

export type LookUpRemoteTag = (remote: string, tagName: string) => Promise<RemoteTagLookup>

/**
git を実行して標準出力を返す。非 0 終了は ReleaseError
*/
function runGit(git: GitRunner, arguments_: readonly string[]): string {
  const result = git(arguments_)
  if (result.exitCode !== 0) throw gitFailed(arguments_, result.stderr)
  return pythonStrip(result.stdout)
}

function gitFailed(arguments_: readonly string[], stderr: string): ReleaseError {
  return new ReleaseError(`git command failed: git ${arguments_.join(' ')}\n${pythonStrip(stderr)}`)
}

function determineVersion(options: PreflightOptions, changelogContent: string): string {
  if (options.version === undefined) {
    try {
      return getLatestVersion(changelogContent, changelogFileName(options.changelogPath))
    }
    catch (error: unknown) {
      if (error instanceof VersionNotFoundError) throw new ReleaseError(error.message, { cause: error })
      throw error
    }
  }
  validateSemver(options.version)
  return options.version
}

/**
リリース前チェックを実行する。
1. CHANGELOG.md の存在、2. バージョンの検出または検証、3. タグが無いこと（ローカル・リモート）、
4. release→develop の差分（countAhead）、5. リリースノートの抽出、の順に確かめる。失敗は ReleaseError
*/
export async function runPreflight(options: PreflightOptions, git: GitRunner, lookUpRemoteTag: LookUpRemoteTag, countAhead: CountCommitsAhead): Promise<PreflightResult> {
  const { changelogContent, developBranch, releaseBranch } = options
  if (changelogContent === undefined) throw new ReleaseError(changelogNotFoundMessage(options.changelogPath))
  const remote = options.remote ?? 'origin'

  const version = determineVersion(options, changelogContent)

  const tagName = options.tagPrefix === undefined || options.tagPrefix === '' ? `v${version}` : `${options.tagPrefix}-v${version}`
  const localTags = runGit(git, ['tag', '-l', tagName])
  if (localTags.split('\n').includes(tagName)) throw new ReleaseError(`tag already exists locally: ${tagName}`)

  const remoteTag = await lookUpRemoteTag(remote, tagName)
  if ('failure' in remoteTag) throw gitFailed(['ls-remote', '--tags', remote, `refs/tags/${tagName}`], remoteTag.failure)
  if (remoteTag.isFound) throw new ReleaseError(`tag already exists on the remote: ${tagName}`)

  const diffCount = await countAhead(releaseBranch, developBranch)
  if (diffCount === 0) {
    throw new ReleaseError(
      `no difference between ${remote}/${releaseBranch} and ${remote}/${developBranch}: `
      + 'there is nothing to release',
    )
  }

  let releaseNotes: string
  try {
    releaseNotes = extractVersionReleaseNotes(changelogContent, version, changelogFileName(options.changelogPath))
  }
  catch (error: unknown) {
    if (error instanceof VersionNotFoundError) throw new ReleaseError(error.message, { cause: error })
    throw error
  }

  return { version, releaseNotes, developBranch, releaseBranch, diffCount, tagName }
}
