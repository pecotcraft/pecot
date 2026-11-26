// tracker-sync の source security の本体。open の Tracker の一覧を、open の security alert に書き直す。
// 途中で抜ける箇所は CommandExit を投げ、runAction が終了コードにする。

import { ALERT_KINDS, kindLabel, listOpenAlerts, SecurityAlertError } from '@pecot/workflow-core/domain/security-alerts.js'
import type { AlertKind, AlertSources } from '@pecot/workflow-core/domain/security-alerts.js'
import { ALERT_LABEL, buildTrackerTitle, normalizeAlerts, parseTrackerEntries, planTracker, renderTrackerBody, TRACKER_PATTERN } from '@pecot/workflow-core/domain/security-tracker.js'
import type { Alert, TrackerEntry, TrackerPlan } from '@pecot/workflow-core/domain/security-tracker.js'
import { findTracker } from '@pecot/workflow-core/domain/tracker-body.js'
import type { TrackerIssue } from '@pecot/workflow-core/domain/tracker-body.js'
import { createDependabotSource } from '@pecot/workflow-core/infra/github/dependabot-source.js'
import { requireNumber } from '@pecot/workflow-core/infra/github/payload.js'
import { createScanAlertSource } from '@pecot/workflow-core/infra/github/security-alerts-source.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createIssue, putOnBoard } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { apiErrorDetail, isBodyUnchanged, todayUtc, warnExtraTrackers } from '@pecot/workflow-core/commands-shared/tracker-shared.js'
import { loadTarget } from './tracker-sync.js'
import type { SyncApplyContext, SyncStages, TrackerSyncInput } from './tracker-sync.js'

interface FetchedAlerts {
  readonly alerts: ReadonlyMap<AlertKind, readonly Alert[]>
  readonly failed: ReadonlySet<AlertKind>
  readonly disabled: ReadonlySet<AlertKind>
}

// 一覧を取れなかった種類と無効の種類は行を触らず、足さない。終了コード 1 にするのは取れなかった種類だけ
async function fetchOpenAlerts(out: Readonly<Output>, sources: AlertSources, host: string, owner: string, repository: string): Promise<FetchedAlerts> {
  const alerts = new Map<AlertKind, readonly Alert[]>()
  const failed = new Set<AlertKind>()
  const disabled = new Set<AlertKind>()
  for (const kind of ALERT_KINDS) {
    let raws
    try {
      raws = await listOpenAlerts(sources, kind, owner, repository)
    }
    catch (error: unknown) {
      if (!(error instanceof SecurityAlertError)) throw error
      failed.add(kind)
      out.error(`could not list ${kindLabel(kind)} alerts (leaving its rows untouched): ${error.message}`)
      continue
    }
    if (raws === undefined) {
      disabled.add(kind)
      settle(out, { verb: 'skip', target: `${kindLabel(kind)} alerts (feature disabled)` })
      continue
    }
    alerts.set(kind, normalizeAlerts(kind, raws, host, owner, repository))
  }
  return { alerts, failed, disabled }
}

function operationsOf(plan: TrackerPlan, tracker: number | undefined, title: string, isUnchanged: boolean): SyncStages {
  if (tracker === undefined) {
    if (!plan.create) return { create: [{ verb: 'skip', target: 'Tracker creation' }], rewrite: [] }
    const created: Operation[] = [{ verb: 'create', target: `Tracker "${title}"` }]
    for (const entry of plan.entries) created.push({ verb: 'add', target: `${entry.kind} #${String(entry.number)} to new Tracker` })
    return { create: created, rewrite: [] }
  }
  const label = `#${String(tracker)}`
  if (isUnchanged) return { create: [], rewrite: [{ verb: 'unchanged', target: `Tracker ${label}` }] }
  const rewrite: Operation[] = [
    ...plan.added.map((entry): Operation => ({ verb: 'add', target: `${entry.kind} #${String(entry.number)} to Tracker ${label}` })),
    ...plan.removed.map((entry): Operation => ({ verb: 'remove', target: `${entry.kind} #${String(entry.number)} from Tracker ${label}` })),
  ]
  return { create: [], rewrite: rewrite.length === 0 ? [{ verb: 'update', target: `Tracker ${label} body` }] : rewrite }
}

interface ApplyInput extends SyncApplyContext {
  readonly plan: TrackerPlan
  readonly stages: SyncStages
}

// Tracker を作る・書き直す・ボードに載せる。失敗の数を返す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変
async function applyChanges(out: Readonly<Output>, input: Readonly<ApplyInput>): Promise<number> {
  const { client, config, owner, repository, plan, title, body, stages, number, isUnchanged } = input
  try {
    if (number === undefined) {
      if (!plan.create) {
        for (const operation of stages.create) out.done(operation)
        return 0
      }
      const issue = await createIssue(client, owner, repository, title, body, [ALERT_LABEL])
      for (const operation of stages.create) out.done(operation)
      const created = requireNumber(issue['number'], 'number')
      return await putOnBoard(out, client, config, owner, repository, created, { onlyIfEmpty: false })
    }
    let failures = 0
    let isUpdated = true
    if (!isUnchanged) {
      try {
        await client.updateIssueBody(owner, repository, number, body)
      }
      catch (error: unknown) {
        const text = apiErrorDetail(error)
        if (text === undefined) throw error
        // 422 を含む。本文は書き直されていないので、次の実行でやり直す
        failures += 1
        isUpdated = false
        out.error(`could not update Tracker #${String(number)} body: ${text}`)
      }
    }
    if (isUpdated) for (const operation of stages.rewrite) out.done(operation)
    // 作った後にボード登録が失敗した実行を直す。Status は空のときだけ入れる
    failures += await putOnBoard(out, client, config, owner, repository, number, { onlyIfEmpty: true })
    return failures
  }
  catch (error: unknown) {
    const text = apiErrorDetail(error)
    if (text === undefined) throw error
    out.error(`Tracker: ${text}`)
    return 1
  }
}

function entriesOf(out: Readonly<Output>, tracker: Readonly<TrackerIssue>): readonly TrackerEntry[] {
  try {
    return parseTrackerEntries(tracker.body)
  }
  catch (error: unknown) {
    if (!(error instanceof SecurityAlertError)) throw error
    return stopWith(out, `Tracker #${String(tracker.number)}: ${error.message}`, 'content-invalid')
  }
}

/**
tracker-sync の source security の本体。Tracker の open security alerts の一覧を書き直す
*/
export async function runSecuritySync(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<0> {
  const out = createOutput(input.dry_run, io)
  const { config, owner, repository } = loadTarget(out, input.project)
  const client = await makeClient(out, config)

  const sources: AlertSources = { scan: createScanAlertSource(client), dependabot: createDependabotSource(client) }
  const { alerts, failed, disabled } = await fetchOpenAlerts(out, sources, config.host, owner, repository)

  let issues
  try {
    issues = await client.listIssuesByLabel(owner, repository, ALERT_LABEL)
  }
  catch (error: unknown) {
    const text = apiErrorDetail(error)
    if (text === undefined) throw error
    return stopWith(out, `could not list issues: ${text}`, kindOfFailure(error))
  }

  const { tracker, others } = findTracker(issues, TRACKER_PATTERN)
  if (tracker !== undefined) warnExtraTrackers(out, tracker, others)
  const existingBody = tracker?.body
  const entries = tracker === undefined ? undefined : entriesOf(out, tracker)

  const plan = planTracker(alerts, entries, failed, disabled)
  const title = buildTrackerTitle(todayUtc(new Date()))
  const body = renderTrackerBody(plan.entries, config.host, owner, repository, { existingBody, disabledKinds: disabled, failedKinds: failed })
  const number = tracker?.number
  const isUnchanged = isBodyUnchanged(body, existingBody)
  const stages = operationsOf(plan, number, title, isUnchanged)
  for (const operation of [...stages.create, ...stages.rewrite]) out.planned(operation)

  const failures = input.dry_run ? 0 : await applyChanges(out, { client, config, owner, repository, plan, title, body, stages, number, isUnchanged })
  if (failed.size > 0 || failures > 0) throw new CommandExit(1, 'partial-failure')
  return 0
}
