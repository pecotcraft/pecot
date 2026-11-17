// リポジトリ解決: --repo、無ければ git の origin（無ければ先頭の remote）、どちらも無ければ AmbiguousRepositoryError。
// 検証エラーの文は Python の CLI の書式（表題は RepoRef・ResolvedRepo）に揃える。

import { formatHinted, globalRepositoryHint, hinted, placeholder } from './command-hint.js'
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
git の remote のリポジトリ。git の外・remote 無しは undefined、URL を読めなければ InvalidValueError（Python の `_detect_current_git_repo` と同じ）。
読めないことを値で受けるなら readCurrentGitRemote を使う
*/
export function detectCurrentGitRepository(git: GitRunner): { readonly repository: RepositoryReference, readonly remoteName: string } | undefined {
  const primary = readPrimaryRemoteUrl(git)
  if (primary === undefined) return undefined
  const { owner, repository } = parseRemoteUrl(primary.url)
  return { repository: createRepositoryReference(owner, repository), remoteName: primary.remoteName }
}

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
短い参照を補うリポジトリ。明示値か git の remote で、決められなければ undefined。明示値の形が不正なら InvalidValueError
*/
export function resolveRepositoryIfKnown(explicit: string | undefined, git: GitRunner): RepositoryReference | undefined {
  if (explicit !== undefined) return parseOwnerRepository(explicit)
  const current = readCurrentGitRemote(git)
  return current?.source === 'current-git' ? current.repository : undefined
}

/**
リポジトリを解決する。明示値があれば git を呼ばずにそれを使う
*/
export function resolveRepository(explicit: string | undefined, git: GitRunner): ResolvedRepository {
  if (explicit !== undefined) {
    return createResolvedRepository({ repository: parseOwnerRepository(explicit), source: 'explicit', remoteName: undefined })
  }
  const detected = detectCurrentGitRepository(git)
  if (detected !== undefined) {
    return createResolvedRepository({ repository: detected.repository, source: 'current-git', remoteName: detected.remoteName })
  }
  // 文を出すのは CLI の最上位（src/cli.ts）だけ。ほかの呼び手は捕まえて undefined にする
  const repositoryHint = globalRepositoryHint(placeholder('owner/repo'))
  throw new AmbiguousRepositoryError(formatHinted(hinted`repository is ambiguous: pass ${repositoryHint}`, 'cli'))
}
