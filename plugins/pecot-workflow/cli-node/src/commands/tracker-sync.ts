// Tracker に反映するコマンドと、PR の後片付けが共有する出力の補助。

import type { ProjectConfig } from '../domain/config.js'
import type { TrackerIssue } from '../domain/tracker-body.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { CommandExit } from './command-definition.js'
import { stopWith } from './command-stop.js'
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
  const config = loadActiveConfig() ?? stopWith(out, 'no active project')
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
