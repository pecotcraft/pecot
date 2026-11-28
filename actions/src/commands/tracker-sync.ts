// tracker-sync の source が共有する入力と、ワークフローが動くリポの決め方。
import process from 'node:process'

import { z } from 'zod'

import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { splitOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { syncTargetOf } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import type { SyncTarget } from '@pecot/workflow-core/commands-shared/tracker-shared.js'

export const TRACKER_SYNC_INPUT = z.strictObject({
  source: z.enum(['dependabot', 'security', 'issue-surface']),
  dry_run: z.boolean().default(false),
  project: z.string().optional(),
  surface_file: z.string().optional(),
}).refine(input => input.source !== 'issue-surface' || input.surface_file !== undefined, {
  error: 'surface-file is required when source is issue-surface',
  path: ['surface_file'],
})

export type TrackerSyncInput = z.output<typeof TRACKER_SYNC_INPUT>

/**
ワークフローが動くリポ（GITHUB_REPOSITORY）と、それを含むプロジェクトの設定を決める。決められなければ error の行を出して終了コード 1 で止める
*/
export function loadTarget(out: Readonly<Output>, project: string | undefined): SyncTarget {
  const raw = process.env['GITHUB_REPOSITORY'] ?? ''
  const target = splitOwnerRepository(raw) ?? stopWith(out, `GITHUB_REPOSITORY is not owner/repo: '${raw}'`, 'other')
  return syncTargetOf(out, target, project)
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
