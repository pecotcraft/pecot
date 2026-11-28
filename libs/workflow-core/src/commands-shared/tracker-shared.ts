// Tracker を書き直す処理（actions の tracker-sync の各 source）が共有する補助。
import type { ProjectConfig } from '../domain/config.js'
import type { TrackerIssue } from '../domain/tracker-body.js'
import { TransportFailure } from '../infra/github/client.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { requireConfigFor } from './command-stop.js'
import type { Output } from './output.js'

export interface SyncTarget {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
}

/**
対象のリポを含むプロジェクトの設定を決める。決められなければ error の行を出して終了コード 1 で止める
*/
export function syncTargetOf(out: Readonly<Output>, target: Readonly<{ owner: string, repository: string }>, project: string | undefined): SyncTarget {
  const config = requireConfigFor(out, target, project, ['tracker', 'sync']).config
  return { config, owner: target.owner, repository: target.repository }
}

/**
複数の Tracker が open のときに警告する（番号が最小のものを使い、ほかは閉じない）
*/
export function warnExtraTrackers(out: Readonly<Output>, tracker: Readonly<TrackerIssue> | undefined, others: readonly number[]): void {
  if (tracker === undefined || others.length === 0) return
  const listed = others.map(number => `#${String(number)}`).join(', ')
  out.warning(`multiple open Trackers; using #${String(tracker.number)} (lowest number) and leaving ${listed} open`)
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
