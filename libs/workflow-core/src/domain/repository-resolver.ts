// リポジトリ解決: --repo、無ければ git の origin（無ければ先頭の remote）、どちらも無ければ AmbiguousRepositoryError。
// 検証エラーの文は Python の CLI の書式（表題は RepoRef・ResolvedRepo）に揃える。

import { formatHinted, globalRepositoryHint, hinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { PecotError, InvalidValueError } from './errors.js'
import type { GitRunner } from './git-runner.js'
import { parseRemoteUrl, RemoteUrlFormatError } from './git-url.js'
import { pythonStringRepr, ValidationFailure } from './python-format.js'
import type { ValidationIssue } from './python-format.js'

const SEGMENT_PATTERN = /^[\w.-]+$/u

export interface RepositoryReference {
  readonly owner: string
  readonly repository: string
}

export type ResolveSource = 'explicit' | 'current-git'

/**
解決の結果。source が explicit のとき remoteName は undefined、current-git のとき remoteName は空でない文字列
*/
export interface ResolvedRepository {
  readonly repository: RepositoryReference
  readonly source: ResolveSource
  readonly remoteName: string | undefined
}

export class AmbiguousRepositoryError extends PecotError {}

// `.` と `..` は、REST の URL に文字列で連結すると別のパスを指すので拒否する（Python は通していた）
function segmentIssue(field: string, value: string): readonly ValidationIssue[] {
  if (value !== '.' && value !== '..' && SEGMENT_PATTERN.test(value)) return []
  return [{
    type: 'value_error',
    location: [field],
    message: `Value error, invalid owner/repo segment: ${pythonStringRepr(value)} (allowed: [A-Za-z0-9_.-]+)`,
    input: value,
  }]
}

/**
owner と repository の各セグメントを検証して作る。両方が不正なら 2 件を 1 つの例外にまとめる
*/
export function createRepositoryReference(owner: string, repository: string): RepositoryReference {
  const issues = [...segmentIssue('owner', owner), ...segmentIssue('repo', repository)]
  if (issues.length > 0) throw new ValidationFailure('RepoRef', issues)
  return Object.freeze({ owner, repository })
}

export function repositoryFullName(reference: RepositoryReference): string {
  return `${reference.owner}/${reference.repository}`
}

export function isSameRepository(left: RepositoryReference, right: RepositoryReference): boolean {
  return repositoryFullName(left).toLowerCase() === repositoryFullName(right).toLowerCase()
}

/**
`/` で分けてちょうど 2 つなら owner と repository を返し、違えば undefined。
中身は検証しない（`a/` や `/b` も通る）。検証は parseOwnerRepository の側
*/
export function splitOwnerRepository(raw: string): { readonly owner: string, readonly repository: string } | undefined {
  const [owner, repository, ...rest] = raw.split('/')
  return owner === undefined || repository === undefined || rest.length > 0 ? undefined : { owner, repository }
}

/**
`owner/repo` 形式の文字列を分ける。形式が違えば InvalidValueError
*/
export function parseOwnerRepository(raw: string): RepositoryReference {
  const parts = splitOwnerRepository(raw)
  if (parts === undefined) {
    throw new InvalidValueError(`invalid owner/repo form: ${pythonStringRepr(raw)} (expected: 'owner/repo')`)
  }
  return createRepositoryReference(parts.owner, parts.repository)
}

/**
source と remoteName の整合を検証して作る
*/
export function createResolvedRepository(resolved: ResolvedRepository): ResolvedRepository {
  const input = {
    repo: { owner: resolved.repository.owner, repo: resolved.repository.repository },
    source: resolved.source,
    remote_name: resolved.remoteName ?? 'None',
  }
  if (resolved.source === 'current-git' && (resolved.remoteName === undefined || resolved.remoteName === '')) {
    throw new ValidationFailure('ResolvedRepo', [{ type: 'value_error', location: [], message: 'Value error, remote_name is required when source=CURRENT_GIT', input }])
  }
  if (resolved.source === 'explicit' && resolved.remoteName !== undefined) {
    throw new ValidationFailure('ResolvedRepo', [{ type: 'value_error', location: [], message: 'Value error, remote_name must be None when source=EXPLICIT', input }])
  }
  return Object.freeze({ ...resolved })
}

/**
remote 名の一覧から主の remote を選ぶ（origin、無ければ最初）。一覧が空なら undefined
*/
export function pickPrimaryRemote(remotes: readonly string[]): string | undefined {
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
主の remote はあるが、その URL から `owner/repo` を読めないこと
*/
export interface UnreadableRemote {
  readonly source: 'unreadable-remote'
  readonly remoteName: string
}

// 主の remote の名前と URL。git の外・remote 無し・URL を取れないときは undefined
function readPrimaryRemoteUrl(git: GitRunner): { readonly remoteName: string, readonly url: string } | undefined {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return undefined

  const remotesResult = git(['remote'])
  if (remotesResult.exitCode !== 0) return undefined
  const remotes = remotesResult.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const remoteName = pickPrimaryRemote(remotes)
  if (remoteName === undefined) return undefined
  const url = git(['remote', 'get-url', remoteName])
  return url.exitCode === 0 ? { remoteName, url: url.stdout.trim() } : undefined
}

/**
remote の URL から owner/repo を読めない理由の文
*/
export function unreadableRemoteReason(remote: UnreadableRemote): string {
  return `could not read the repository from the URL of the Git remote ${remote.remoteName}`
}

/**
remote の URL から owner/repo を読めず、リポジトリを決められないこと。message は理由の文
*/
export class UnreadableRemoteError extends PecotError {}

/**
git の remote を読む。git の外・remote 無しは undefined、URL から `owner/repo` を読めなければ UnreadableRemote
*/
export function readCurrentGitRemote(git: GitRunner): ResolvedRepository | UnreadableRemote | undefined {
  const primary = readPrimaryRemoteUrl(git)
  if (primary === undefined) return undefined
  let location
  try {
    location = parseRemoteUrl(primary.url)
  }
  catch (error: unknown) {
    if (error instanceof RemoteUrlFormatError) return { source: 'unreadable-remote', remoteName: primary.remoteName }
    throw error
  }
  return createResolvedRepository({
    repository: createRepositoryReference(location.owner, location.repository),
    source: 'current-git',
    remoteName: primary.remoteName,
  })
}

/**
短い参照を補うリポジトリ（決められなければ base は undefined）と、remote の URL を読めなかったこと。明示値の形が不正なら InvalidValueError
*/
export function resolveShortReferenceBase(explicit: string | undefined, git: GitRunner): { readonly base: RepositoryReference | undefined, readonly unreadable: UnreadableRemote | undefined } {
  if (explicit !== undefined) return { base: parseOwnerRepository(explicit), unreadable: undefined }
  const current = readCurrentGitRemote(git)
  return current?.source === 'unreadable-remote'
    ? { base: undefined, unreadable: current }
    : { base: current?.repository, unreadable: undefined }
}

/**
短い参照の案内に、remote の URL を読めなかった理由の行を足す
*/
export function withUnreadableReason(text: string | HintedText, unreadable: UnreadableRemote | undefined): string | HintedText {
  if (unreadable === undefined) return text
  const reason = `\n${unreadableRemoteReason(unreadable)}`
  return typeof text === 'string' ? text + reason : [...text, reason]
}

/**
リポジトリを解決する。明示値があれば git を呼ばずにそれを使う。remote の URL を読めなければ UnreadableRemoteError
*/
export function resolveRepository(explicit: string | undefined, git: GitRunner): ResolvedRepository {
  if (explicit !== undefined) {
    return createResolvedRepository({ repository: parseOwnerRepository(explicit), source: 'explicit', remoteName: undefined })
  }
  const current = readCurrentGitRemote(git)
  if (current?.source === 'unreadable-remote') throw new UnreadableRemoteError(unreadableRemoteReason(current))
  if (current !== undefined) return current
  // 文を出すのはツールの最上位だけ。ほかの呼び手は捕まえて undefined にする
  const repositoryHint = globalRepositoryHint(placeholder('owner/repo'))
  throw new AmbiguousRepositoryError(formatHinted(hinted`repository is ambiguous: pass ${repositoryHint}`))
}
