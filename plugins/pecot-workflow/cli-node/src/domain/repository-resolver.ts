// マルチリポ対応のリポジトリ解決。
//
// 決定木:
//   1. 明示値（--repo）があれば、それを owner/repo として使う（source=explicit）。
//   2. git のワークツリー内なら、origin の URL から取る（source=current-git）。
//      origin が無ければ、先頭の remote を使う。
//   3. どちらも成り立たなければ、AmbiguousRepositoryError を投げる。
//
// 検証エラーの文は、Python の CLI の書式に揃える。
// 表題は元のクラス名（RepoRef・ResolvedRepo）を使う。

import { PecotError, InvalidValueError } from './errors.js'
import type { GitRunner } from './git-runner.js'
import { parseRemoteUrl } from './git-url.js'
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

/**
`owner/repo` 形式の文字列を分ける。形式が違えば InvalidValueError
*/
export function parseOwnerRepository(raw: string): RepositoryReference {
  const parts = raw.split('/')
  const [owner, repository] = parts
  if (owner === undefined || repository === undefined || parts.length !== 2) {
    throw new InvalidValueError(`invalid owner/repo form: ${pythonStringRepr(raw)} (expected: 'owner/repo')`)
  }
  return createRepositoryReference(owner, repository)
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
remote 名の一覧から主の remote を選ぶ。origin、無ければ最初の remote。一覧が空なら undefined
*/
export function pickPrimaryRemote(remotes: readonly string[]): string | undefined {
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
現在の git の remote からリポジトリを取り出す。git の外・remote 無しは undefined。
URL の形式が不正なときは、InvalidValueError をそのまま伝える（バグ扱い）。
Python の `_detect_current_git_repo` と同じで、infra/git.ts の originRepository（不正なら undefined を返す）とは契約が違う。
解決の失敗を利用者に見せたい resolveRepository は例外にする。
値が取れなくてもよい originRepository は undefined にする
*/
export function detectCurrentGitRepository(git: GitRunner): { readonly repository: RepositoryReference, readonly remoteName: string } | undefined {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return undefined

  const remotesResult = git(['remote'])
  if (remotesResult.exitCode !== 0) return undefined
  const remotes = remotesResult.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const remoteName = pickPrimaryRemote(remotes)
  if (remoteName === undefined) return undefined

  const url = git(['remote', 'get-url', remoteName])
  if (url.exitCode !== 0) return undefined
  const { owner, repository } = parseRemoteUrl(url.stdout.trim())
  return { repository: createRepositoryReference(owner, repository), remoteName }
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
  throw new AmbiguousRepositoryError('repository is ambiguous: pass --repo <owner/repo>')
}
