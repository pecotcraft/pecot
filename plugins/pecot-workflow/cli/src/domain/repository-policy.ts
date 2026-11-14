// `--repo` 不一致方針（FR-009a / FR-009b）の判定。
//
// ローカル Git を破壊する操作系（worktree・branch create・branch delete など）は reject にする。
// GitHub API 側への操作が中心のもの（release など）は warn にする。
// 判定だけを純粋な関数にする。stderr への出力と終了は、呼ぶ側（commands 層）が行う。
//
// 決定木:
//   1. --repo を指定しない場合
//      - カレント Git remote を解決できたら続行する（採用値なし）。
//      - 解決できなければ「リポジトリが曖昧です」で終了コード 1。
//   2. --repo を指定した場合
//      - 形式が不正なら終了コード 1。
//      - カレント Git remote が無い場合（Git 外・remote 無し）は、比較できないので明示値を採用して続行する。
//      - 一致なら明示値を採用して続行する。
//      - 不一致で reject は終了コード 1、warn は警告を出して明示値を採用して続行する。
//
// 文言は contracts/cli-commands.md の固定文言と一致させる（stderr を e2e で確かめるため）。

import { InvalidValueError } from './errors.js'
import { pythonStringRepr } from './python-format.js'
import { parseOwnerRepository, repositoryFullName } from './repository-resolver.js'
import type { RepositoryReference, ResolvedRepository } from './repository-resolver.js'

export type PolicyMode = 'reject' | 'warn'

export interface PolicyInput {
  /**
  グローバル `--repo` の値。無ければ undefined
  */
  readonly explicit: string | undefined
  /**
  カレント Git remote からの解決結果。解決できなければ undefined
  */
  readonly resolved: ResolvedRepository | undefined
  readonly mode: PolicyMode
}

/**
結果の種類は kind で判別する。stderr は改行を含まない行の並びで、呼ぶ側が 1 行ずつ出す。
- proceed は、続行する。adopted は明示値から採用したリポジトリ（--repo が無ければ undefined）。
- exit は、stderr を出して指定の終了コードで終わる。
*/
export type PolicyOutcome
  = | { readonly kind: 'proceed', readonly adopted: RepositoryReference | undefined, readonly stderr: readonly string[] }
    | { readonly kind: 'exit', readonly exitCode: 1, readonly stderr: readonly string[] }

function exitWith(...stderr: readonly string[]): PolicyOutcome {
  return { kind: 'exit', exitCode: 1, stderr }
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
`--repo` とカレント Git remote の不一致時の方針を判定する
*/
export function applyRepositoryPolicy(input: PolicyInput): PolicyOutcome {
  const { explicit, resolved, mode } = input

  if (explicit === undefined) {
    return resolved === undefined
      ? exitWith('error: the repository is ambiguous', '  give --repo <owner/repo>')
      : { kind: 'proceed', adopted: undefined, stderr: [] }
  }

  const explicitReference = parseExplicit(explicit)
  if (explicitReference === undefined) return exitWith(`error: --repo has an invalid form: ${pythonStringRepr(explicit)}`)

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
      `error: --repo ${explicitName} differs from the current Git remote (${currentName})`,
      '  this command works only on the repository of the current Git remote',
    )
  }
  return {
    kind: 'proceed',
    adopted: explicitReference,
    stderr: [`warning: using --repo ${explicitName} (current Git remote: ${currentName})`],
  }
}
