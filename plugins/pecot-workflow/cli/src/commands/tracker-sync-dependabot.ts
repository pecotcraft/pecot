// `pecot tracker sync dependabot` の本体。移す元は cli/commands/dependabot.py。
// 判断を待つ dependabot の PR を、open の Tracker の一覧に反映する。載せる PR が無くなったら、一覧を none にして Tracker を閉じる。

import {
  buildTrackerTitle,
  checksLabel,
  DependabotPrError,
  parseTrackerPullRequestNumbers,
  planTracker,
  PR_LABEL,
  PRIORITY,
  renderTrackerBody,
  rollupState,
  TRACKER_PATTERN,
  waitingReasons,
} from '../domain/dependabot-pull-requests.js'
import type { PrEntry, PrPlan } from '../domain/dependabot-pull-requests.js'
import { jsonField } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { findTracker } from '../domain/tracker-body.js'
import { requireNumber } from '../infra/github/payload.js'
import type { CommandIo } from './command-definition.js'
import { CommandExit } from './command-definition.js'
import { stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { makeClient } from './github-client.js'
import { createIssue, putOnBoard } from './issue-board.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { apiErrorDetail, isBodyUnchanged, loadTarget, todayUtc, warnExtraTrackers } from './tracker-sync.js'
import type { SyncApplyContext, SyncStages, TrackerSyncData, TrackerSyncInput } from './tracker-sync.js'

interface Stages extends SyncStages {
  readonly close: readonly Operation[]
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function entryOf(pr: JsonObject): PrEntry {
  const number = jsonField(pr, 'number')
  return {
    number: requireNumber(number, 'number'),
    title: textOrEmpty(jsonField(pr, 'title')),
    url: textOrEmpty(jsonField(pr, 'url')),
    reasons: [],
    checks: checksLabel(rollupState(pr)),
  }
}

function operationsFor(plan: PrPlan, tracker: number | undefined, title: string, isUnchanged: boolean): Stages {
  if (tracker === undefined) {
    if (!plan.create) return { create: [{ verb: 'skip', target: 'Tracker creation' }], rewrite: [], close: [] }
    const created: Operation[] = [{ verb: 'create', target: `Tracker "${title}"` }]
    for (const entry of plan.entries) created.push({ verb: 'add', target: `PR #${String(entry.number)} to new Tracker (${entry.reasons.join(', ')})` })
    return { create: created, rewrite: [], close: [] }
  }
  if (isUnchanged && !plan.close) return { create: [], rewrite: [{ verb: 'unchanged', target: `Tracker #${String(tracker)}` }], close: [] }
  const rewrite: Operation[] = plan.added.map(entry => ({ verb: 'add', target: `PR #${String(entry.number)} to Tracker #${String(tracker)} (${entry.reasons.join(', ')})` }))
  for (const number of plan.removed) rewrite.push({ verb: 'remove', target: `PR #${String(number)} from Tracker #${String(tracker)}` })
  if (!isUnchanged && rewrite.length === 0) rewrite.push({ verb: 'update', target: `Tracker #${String(tracker)} body` })
  return { create: [], rewrite, close: plan.close ? [{ verb: 'close', target: `Tracker #${String(tracker)}` }] : [] }
}

// 足す行と外す行。open の Tracker が無ければ、立てる Tracker に載せる行を足す行にする
function rowsOf(plan: PrPlan, tracker: number | undefined): Pick<TrackerSyncData, 'added' | 'removed'> {
  const added = tracker === undefined ? (plan.create ? plan.entries : []) : plan.added
  return {
    added: added.map(entry => ({ kind: 'pull-request', number: entry.number })),
    removed: plan.removed.map(number => ({ kind: 'pull-request', number })),
  }
}

interface ApplyInput extends SyncApplyContext {
  readonly plan: PrPlan
  readonly stages: Stages
  readonly rows: Pick<TrackerSyncData, 'added' | 'removed'>
}

// Tracker を作る・書き直す・閉じる・ボードに載せる。失敗の数を返す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変
async function applyChanges(out: Readonly<Output<TrackerSyncData>>, input: Readonly<ApplyInput>): Promise<number> {
  const { client, config, owner, repository, plan, title, body, stages, number, isUnchanged, rows } = input
  try {
    if (number === undefined) {
      if (!plan.create) {
        for (const operation of stages.create) out.done(operation)
        return 0
      }
      const issue = await createIssue(client, owner, repository, title, body, [PR_LABEL])
      for (const operation of stages.create) out.done(operation)
      const created = requireNumber(issue['number'], 'number')
      out.result({ tracker: created, created: true, added: rows.added })
      return await putOnBoard(out, client, config, owner, repository, created, PRIORITY, { onlyIfEmpty: false })
    }
    if (!isUnchanged) {
      try {
        await client.updateIssueBody(owner, repository, number, body)
      }
      catch (error: unknown) {
        const detail = apiErrorDetail(error)
        if (detail === undefined) throw error
        // 本文が書き直されていないので、閉じずに次の実行でやり直す
        out.error(`could not update Tracker #${String(number)} body: ${detail}`)
        return 1
      }
    }
    for (const operation of stages.rewrite) out.done(operation)
    out.result(rows)
    const [closing] = stages.close
    if (closing !== undefined) {
      try {
        await client.closeIssue(owner, repository, number, 'completed')
      }
      catch (error: unknown) {
        const detail = apiErrorDetail(error)
        if (detail === undefined) throw error
        out.error(`could not close Tracker #${String(number)} after setting its list to none; will retry on the next run: ${detail}`)
        return 1
      }
      out.done(closing)
      out.result({ closed: true })
      return 0
    }
    // 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
    return await putOnBoard(out, client, config, owner, repository, number, PRIORITY, { onlyIfEmpty: true })
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    out.error(`Tracker: ${detail}`)
    return 1
  }
}

/**
tracker sync の source dependabot の本体。Tracker の Dependabot PRs waiting for a human decision の一覧を書き直す
*/
export async function runDependabotSync(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<0> {
  const out = createOutput<TrackerSyncData>(input.dry_run, io)
  const { config, owner, repository } = loadTarget(out, input.repo, input.project)
  const client = makeClient(out, config)

  let pullRequests
  let issues
  try {
    pullRequests = await client.listOpenDependabotPullRequests(owner, repository)
    issues = await client.listIssuesByLabel(owner, repository, PR_LABEL)
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    return stopWith(out, `could not list pull requests or issues: ${detail}`, kindOfFailure(error))
  }

  const { tracker, others } = findTracker(issues, TRACKER_PATTERN)
  warnExtraTrackers(out, tracker, others)
  const existingBody = tracker?.body
  let oldNumbers: readonly number[] | undefined
  try {
    oldNumbers = tracker === undefined ? undefined : parseTrackerPullRequestNumbers(existingBody)
  }
  catch (error: unknown) {
    if (tracker === undefined || !(error instanceof DependabotPrError)) throw error
    return stopWith(out, `Tracker #${String(tracker.number)}: ${error.message}`, 'content-invalid')
  }

  const now = new Date()
  const nodes = pullRequests
  const waiting = nodes.map(node => ({ node, reasons: waitingReasons(node, now) })).filter(item => item.reasons.length > 0)
  out.count('open dependabot PRs', nodes.length)
  out.count('PRs awaiting a decision', waiting.length)
  out.count('PRs awaiting a decision without check results', waiting.filter(item => rollupState(item.node) === undefined).length)
  const plan = planTracker(waiting.map(item => ({ ...entryOf(item.node), reasons: item.reasons })), oldNumbers)
  const title = buildTrackerTitle(todayUtc(now))
  const body = renderTrackerBody(plan.entries, existingBody)
  const number = tracker?.number
  const isUnchanged = isBodyUnchanged(body, existingBody)
  const stages = operationsFor(plan, number, title, isUnchanged)
  for (const operation of [...stages.create, ...stages.rewrite, ...stages.close]) out.planned(operation)

  const rows = rowsOf(plan, number)
  const synced: Pick<TrackerSyncData, 'source' | 'tracker'> = { source: 'dependabot', ...number !== undefined && { tracker: number } }
  if (input.dry_run) {
    out.result({ ...synced, created: number === undefined && plan.create, ...rows, closed: plan.close })
    return 0
  }
  out.result({ ...synced, created: false, added: [], removed: [], closed: false })
  const failures = await applyChanges(out, { client, config, owner, repository, plan, title, body, stages, number, isUnchanged, rows })
  if (failures > 0) throw new CommandExit(1, 'partial-failure')
  return 0
}
