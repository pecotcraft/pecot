// Tracker に反映するコマンドと、PR の後片付けが共有する出力の補助。

import type { ProjectConfig } from '../domain/config.js'
import type { TrackerIssue } from '../domain/tracker-body.js'
import { TransportFailure } from '../infra/github/client.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { CommandExit } from './command-definition.js'
import { NO_ACTIVE_PROJECT_SHORT, requireActiveConfig } from './command-stop.js'
import type { Operation, Output } from './output.js'
import { resolveReleaseTargetRepository } from './release.js'

/**
API を呼ばない操作の行を出す。dry-run では計画、実行では結果になる
*/
export function settle(out: Output, operation: Operation): void {
  out.planned(operation)
  out.done(operation)
}

export interface SyncTarget {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
}

/**
対象のリポ（--repo、主の remote の順）とアクティブな設定を決める。決められなければ error の行を出して終了コード 1 で止める。
設定が無いときの文は Python の sync と同じ 1 行で、案内の行を付けない
*/
export function loadTarget(out: Readonly<Output>, explicitRepository: string | undefined): SyncTarget {
  const target = resolveReleaseTargetRepository(undefined, explicitRepository, out)
  if (target === undefined) throw new CommandExit(1)
  const config = requireActiveConfig(out, NO_ACTIVE_PROJECT_SHORT)
  return { config, owner: target.owner, repository: target.repository }
}

/**
複数の Tracker が open のときに警告する（番号が最小のものを使い、ほかは閉じない）
*/
export function warnExtraTrackers(out: Readonly<Output>, tracker: Readonly<TrackerIssue> | undefined, others: readonly number[]): void {
  if (others.length === 0) return
  const listed = others.map(number => `#${String(number)}`).join(', ')
  const used = tracker === undefined ? 'none' : `#${String(tracker.number)}`
  out.warning(`multiple open Trackers; using ${used} (lowest number) and leaving ${listed} open`)
}

/**
API エラーと通信エラーの文。ほかの例外なら undefined
*/
export function apiErrorDetail(error: unknown): string | undefined {
  return error instanceof GitHubAPIError || error instanceof TransportFailure ? error.message : undefined
}

/**
書き直した本文が今の本文と同じか。比べるのは改行を `\n` に直したものどうし
*/
export function isBodyUnchanged(body: string, existingBody: string | undefined): boolean {
  return existingBody?.replaceAll('\r\n', '\n') === body
}

/**
Tracker の題に入れる、立てた日（UTC）の YYYY-MM-DD
*/
export function todayUtc(now: Readonly<Date>): string {
  return now.toISOString().slice(0, 10)
}

/**
操作を段ごとに分けたもの。作る段と書き直す段は 2 つの sync に共通
*/
export interface SyncStages {
  readonly create: readonly Operation[]
  readonly rewrite: readonly Operation[]
}

/**
Tracker を反映する処理に渡す共通の入力
*/
export interface SyncApplyContext {
  readonly client: GitHubClient
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
  readonly title: string
  readonly body: string
  /**
  使う Tracker の番号。open の Tracker が無ければ undefined
  */
  readonly number: number | undefined
  readonly isUnchanged: boolean
}
