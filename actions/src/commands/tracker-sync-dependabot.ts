// tracker-sync の source dependabot の本体。
// 判断を待つ dependabot の PR を、open の Tracker の一覧に反映する。載せる PR が無くなったら、一覧を none にして Tracker を閉じる。

import {
  buildTrackerTitle,
  checksLabel,
  DependabotPrError,
  parseTrackerPullRequestNumbers,
  planTracker,
  PR_LABEL,
  renderTrackerBody,
  rollupState,
  TRACKER_PATTERN,
  waitingReasons,
} from '@pecot/workflow-core/domain/dependabot-pull-requests.js'
import type { PrEntry, PrPlan } from '@pecot/workflow-core/domain/dependabot-pull-requests.js'
import { jsonField } from '@pecot/workflow-core/domain/json.js'
import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { findTracker } from '@pecot/workflow-core/domain/tracker-body.js'
import type { TrackerIssue } from '@pecot/workflow-core/domain/tracker-body.js'
import { requireNumber } from '@pecot/workflow-core/infra/github/payload.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createIssue, putOnBoard } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { apiErrorDetail, isBodyUnchanged, todayUtc, warnExtraTrackers } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import { loadTarget } from './tracker-sync.js'
import type { SyncApplyContext, SyncStages, TrackerSyncInput } from './tracker-sync.js'

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

interface ApplyInput extends SyncApplyContext {
  readonly plan: PrPlan
  readonly stages: Stages
}

// Tracker を作る・書き直す・閉じる・ボードに載せる。失敗の数を返す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変
async function applyChanges(out: Readonly<Output>, input: Readonly<ApplyInput>): Promise<number> {
  const { client, config, owner, repository, plan, title, body, stages, number, isUnchanged } = input
  try {
    if (number === undefined) {
      if (!plan.create) {
        for (const operation of stages.create) out.done(operation)
        return 0
      }
      const issue = await createIssue(client, owner, repository, title, body, [PR_LABEL])
      for (const operation of stages.create) out.done(operation)
      const created = requireNumber(issue['number'], 'number')
      return await putOnBoard(out, client, config, owner, repository, created, { onlyIfEmpty: false })
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
      return 0
    }
    // 作った後にボード登録が失敗した実行を直す。Status は空のときだけ入れる
    return await putOnBoard(out, client, config, owner, repository, number, { onlyIfEmpty: true })
  }
  catch (error: unknown) {
    const detail = apiErrorDetail(error)
    if (detail === undefined) throw error
    out.error(`Tracker: ${detail}`)
    return 1
  }
}

function oldNumbersOf(out: Readonly<Output>, tracker: Readonly<TrackerIssue>): readonly number[] {
  try {
    return parseTrackerPullRequestNumbers(tracker.body)
  }
  catch (error: unknown) {
    if (!(error instanceof DependabotPrError)) throw error
    return stopWith(out, `Tracker #${String(tracker.number)}: ${error.message}`, 'content-invalid')
  }
}

/**
tracker-sync の source dependabot の本体。Tracker の Dependabot PRs waiting for a human decision の一覧を書き直す
*/
export async function runDependabotSync(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<0> {
  const out = createOutput(input.dry_run, io)
  const { config, owner, repository } = loadTarget(out, input.project)
  const client = await makeClient(out, config)

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
  if (tracker !== undefined) warnExtraTrackers(out, tracker, others)
  const existingBody = tracker?.body
  const oldNumbers = tracker === undefined ? undefined : oldNumbersOf(out, tracker)

  const now = new Date()
  const waiting = pullRequests.map(node => ({ node, reasons: waitingReasons(node, now) })).filter(item => item.reasons.length > 0)
  out.count('open dependabot PRs', pullRequests.length)
  out.count('PRs awaiting a decision', waiting.length)
  out.count('PRs awaiting a decision without check results', waiting.filter(item => rollupState(item.node) === undefined).length)
  const plan = planTracker(waiting.map(item => ({ ...entryOf(item.node), reasons: item.reasons })), oldNumbers)
  const title = buildTrackerTitle(todayUtc(now))
  const body = renderTrackerBody(plan.entries, existingBody)
  const number = tracker?.number
  const isUnchanged = isBodyUnchanged(body, existingBody)
  const stages = operationsFor(plan, number, title, isUnchanged)
  for (const operation of [...stages.create, ...stages.rewrite, ...stages.close]) out.planned(operation)

  if (input.dry_run) return 0
  const failures = await applyChanges(out, { client, config, owner, repository, plan, title, body, stages, number, isUnchanged })
  if (failures > 0) throw new CommandExit(1, 'partial-failure')
  return 0
}
