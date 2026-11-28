// tracker-sync の source issue-surface の本体。GitHub の今のスキーマを写し（surface-file）と比べ、差を Tracker 1 件に書き直す。差が無くなれば閉じる。
// 途中で抜ける箇所は CommandExit を投げ、runAction が終了コードにする。
import { readFileSync } from 'node:fs'

import { diffIssueSurface, hasIssueSurfaceDifference, issueSurfaceSchema } from '@pecot/workflow-core/domain/issue-surface.js'
import type { IssueSurface, IssueSurfaceDiff } from '@pecot/workflow-core/domain/issue-surface.js'
import { buildTrackerTitle, IssueSurfaceTrackerError, renderTrackerBody, SURFACE_LABEL, TRACKER_PATTERN } from '@pecot/workflow-core/domain/issue-surface-tracker.js'
import type { IssueSurfaceSourceNames } from '@pecot/workflow-core/domain/issue-surface-tracker.js'
import { parseJsonText } from '@pecot/workflow-core/domain/json.js'
import { findTracker } from '@pecot/workflow-core/domain/tracker-body.js'
import type { TrackerIssue } from '@pecot/workflow-core/domain/tracker-body.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { requireNumber } from '@pecot/workflow-core/infra/github/payload.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createIssue, putOnBoard } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { apiErrorDetail, isBodyUnchanged, todayUtc, warnExtraTrackers } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import type { SyncTarget } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import { extractIssueSurface, fetchIssueSurfaceSources } from '../infra/issue-surface.js'
import { loadTarget } from './tracker-sync.js'
import type { TrackerSyncInput } from './tracker-sync.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 読めないファイルは other、写しの形でないファイルは content-invalid で止める
function readSnapshot(out: Readonly<Output>, file: string): IssueSurface {
  let text
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読む先はワークフローが input で渡す写し
    text = readFileSync(file, 'utf8')
  }
  catch (error: unknown) {
    return stopWith(out, `could not read surface-file ${file}: ${messageOf(error)}`, 'other')
  }
  try {
    return issueSurfaceSchema.parse(parseJsonText(text))
  }
  catch (error: unknown) {
    return stopWith(out, `surface-file ${file} is not an issue surface: ${messageOf(error)}`, 'content-invalid')
  }
}

// 今のスキーマから抜いた項目と、本文に載せる取得元。取れない・読めないときは other で止める
async function currentSurface(out: Readonly<Output>): Promise<{ items: string[], names: IssueSurfaceSourceNames }> {
  try {
    const { sdl, openapi, sources } = await fetchIssueSurfaceSources(DEFAULT_API_VERSION)
    return { items: extractIssueSurface(sdl, openapi), names: { graphql: sources.graphql, rest: sources.rest } }
  }
  catch (error: unknown) {
    if (!(error instanceof Error)) throw error
    return stopWith(out, `could not read the current GitHub schema: ${error.message}`, 'other')
  }
}

interface SyncContext {
  readonly out: Readonly<Output>
  readonly client: GitHubClient
  readonly target: SyncTarget
  readonly diff: IssueSurfaceDiff
  readonly names: IssueSurfaceSourceNames
  readonly isDryRun: boolean
}

// open の Tracker が無いとき。差があれば作ってボードに載せる。失敗の数を返す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は書き換わる
async function createTracker(context: Readonly<SyncContext>): Promise<number> {
  const { out, client, target, diff, names, isDryRun } = context
  if (!hasIssueSurfaceDifference(diff)) {
    settle(out, { verb: 'skip', target: 'Tracker creation' })
    return 0
  }
  const title = buildTrackerTitle(todayUtc(new Date()))
  const operation: Operation = { verb: 'create', target: `Tracker "${title}"` }
  out.planned(operation)
  if (isDryRun) return 0
  const issue = await createIssue(client, target.owner, target.repository, title, renderTrackerBody(diff, names), [SURFACE_LABEL])
  out.done(operation)
  return await putOnBoard(out, client, target.config, target.owner, target.repository, requireNumber(issue['number'], 'number'), { onlyIfEmpty: false })
}

function bodyOf(out: Readonly<Output>, diff: Readonly<IssueSurfaceDiff>, names: Readonly<IssueSurfaceSourceNames>, tracker: Readonly<TrackerIssue>): string {
  try {
    return renderTrackerBody(diff, names, tracker.body)
  }
  catch (error: unknown) {
    if (!(error instanceof IssueSurfaceTrackerError)) throw error
    return stopWith(out, `Tracker #${String(tracker.number)}: ${error.message}`, 'content-invalid')
  }
}

// open の Tracker があるとき。一覧を書き直し、差が無くなっていれば閉じる。失敗の数を返す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は書き換わる
async function rewriteTracker(context: Readonly<SyncContext>, tracker: Readonly<TrackerIssue>): Promise<number> {
  const { out, client, target, diff, names, isDryRun } = context
  const label = `Tracker #${String(tracker.number)}`
  const body = bodyOf(out, diff, names, tracker)
  const isUnchanged = isBodyUnchanged(body, tracker.body)
  const rewrite: Operation = isUnchanged ? { verb: 'unchanged', target: label } : { verb: 'update', target: `${label} body` }
  const closing: Operation | undefined = hasIssueSurfaceDifference(diff) ? undefined : { verb: 'close', target: label }
  out.planned(rewrite)
  if (closing !== undefined) out.planned(closing)
  if (isDryRun) return 0
  if (!isUnchanged) await client.updateIssueBody(target.owner, target.repository, tracker.number, body)
  out.done(rewrite)
  if (closing !== undefined) {
    await client.closeIssue(target.owner, target.repository, tracker.number, 'completed')
    out.done(closing)
    return 0
  }
  // 作った後にボード登録が失敗した実行を直す。Status は空のときだけ入れる
  return await putOnBoard(out, client, target.config, target.owner, target.repository, tracker.number, { onlyIfEmpty: true })
}

/**
tracker-sync の source issue-surface の本体。今のスキーマを写しと比べ、Tracker を作る・書き直す・閉じる
*/
export async function runIssueSurfaceSync(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<0> {
  const out = createOutput(input.dry_run, io)
  // 入力の schema が、source が issue-surface のときに surface_file を求める
  const snapshot = readSnapshot(out, input.surface_file ?? '')
  const target = loadTarget(out, input.project)
  const client = await makeClient(out, target.config)
  const current = await currentSurface(out)

  let issues
  try {
    issues = await client.listIssuesByLabel(target.owner, target.repository, SURFACE_LABEL)
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    return stopWith(out, `could not list issues: ${detail}`, kindOfFailure(error))
  }
  const { tracker, others } = findTracker(issues, TRACKER_PATTERN)
  warnExtraTrackers(out, tracker, others)

  const context: SyncContext = { out, client, target, diff: diffIssueSurface(snapshot.items, current.items), names: current.names, isDryRun: input.dry_run }
  let failures
  try {
    failures = tracker === undefined ? await createTracker(context) : await rewriteTracker(context, tracker)
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    out.error(`Tracker: ${detail}`)
    failures = 1
  }
  if (failures > 0) throw new CommandExit(1, 'partial-failure')
  return 0
}
