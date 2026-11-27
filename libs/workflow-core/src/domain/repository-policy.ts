// 入力 `repo` と今の Git remote の不一致方針（FR-009a / FR-009b）の判定。ローカル Git を壊す操作は reject、GitHub 側の操作は warn にする。
// 判定だけの純粋な関数で、stderr への出力と終了は呼ぶ側が行う。

import { globalRepositoryHint, hinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { InvalidValueError } from './errors.js'
import { pythonStringRepr } from './python-format.js'
import { parseOwnerRepository, repositoryFullName, unreadableRemoteReason } from './repository-resolver.js'
import type { RepositoryReference, ResolvedRepository, UnreadableRemote } from './repository-resolver.js'

export type PolicyMode = 'reject' | 'warn'

/**
今の git remote からリポジトリを決められないときの 1 行目。branch delete の remote の確認も同じ行を出す
*/
export const AMBIGUOUS_REPOSITORY_LINE = 'error: the repository is ambiguous'

export interface PolicyInput {
  /**
  共通の入力 `repo` の値。無ければ undefined
  */
  readonly explicit: string | undefined
  /**
  カレント Git remote からの解決結果。git の外・remote 無しは undefined
  */
  readonly resolved: ResolvedRepository | UnreadableRemote | undefined
  readonly mode: PolicyMode
}

/**
結果の種類は kind で判別する。stderr は改行を含まない行の並びで、呼ぶ側が出し先の形にして 1 行ずつ出す。
- proceed は、続行する。adopted は明示値から採用したリポジトリ（repo が無ければ undefined）。
- exit は、stderr を出して指定の終了コードで終わる。
*/
export type PolicyOutcome
  = | { readonly kind: 'proceed', readonly adopted: RepositoryReference | undefined, readonly stderr: readonly (string | HintedText)[] }
    | { readonly kind: 'exit', readonly exitCode: 1, readonly failure: PolicyFailure, readonly stderr: readonly (string | HintedText)[] }

/**
止める原因の名前。commands の FailureKind の一部
*/
export type PolicyFailure = 'git-unresolved' | 'invalid-input' | 'repo-mismatch'

function exitWith(failure: PolicyFailure, ...stderr: readonly (string | HintedText)[]): PolicyOutcome {
  return { kind: 'exit', exitCode: 1, failure, stderr }
}

function parseExplicit(explicit: string): RepositoryReference | undefined {
  try {
    return parseOwnerRepository(explicit)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return undefined
    throw error
  }
}

/**
入力 `repo` とカレント Git remote の不一致時の方針を判定する
*/
export function applyRepositoryPolicy(input: PolicyInput): PolicyOutcome {
  const { explicit, resolved, mode } = input

  if (explicit === undefined) {
    const giveRepository = hinted`  give ${globalRepositoryHint(placeholder('owner/repo'))}`
    if (resolved === undefined) return exitWith('git-unresolved', AMBIGUOUS_REPOSITORY_LINE, giveRepository)
    if (resolved.source === 'unreadable-remote') {
      return exitWith('git-unresolved', AMBIGUOUS_REPOSITORY_LINE, `  ${unreadableRemoteReason(resolved)}`, giveRepository)
    }
    return { kind: 'proceed', adopted: undefined, stderr: [] }
  }

  const explicitReference = parseExplicit(explicit)
  if (explicitReference === undefined) return exitWith('invalid-input', hinted`error: ${globalRepositoryHint()} has an invalid form: ${pythonStringRepr(explicit)}`)

  if (resolved?.source === 'unreadable-remote') {
    return {
      kind: 'proceed',
      adopted: explicitReference,
      stderr: [hinted`warning: using ${globalRepositoryHint()} ${repositoryFullName(explicitReference)} (${unreadableRemoteReason(resolved)})`],
    }
  }

  // Git 外 / remote 不在は比較対象が無いので、明示値を採用する
  if (resolved?.source !== 'current-git') return { kind: 'proceed', adopted: explicitReference, stderr: [] }

  const current = resolved.repository
  if (current.owner === explicitReference.owner && current.repository === explicitReference.repository) {
    return { kind: 'proceed', adopted: explicitReference, stderr: [] }
  }

  const explicitName = repositoryFullName(explicitReference)
  const currentName = repositoryFullName(current)
  if (mode === 'reject') {
    return exitWith(
      'repo-mismatch',
      hinted`error: ${globalRepositoryHint()} ${explicitName} differs from the current Git remote (${currentName})`,
      '  this command works only on the repository of the current Git remote',
    )
  }
  return {
    kind: 'proceed',
    adopted: explicitReference,
    stderr: [hinted`warning: using ${globalRepositoryHint()} ${explicitName} (current Git remote: ${currentName})`],
  }
}
