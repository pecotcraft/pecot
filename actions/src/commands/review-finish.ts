/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// review-finish の本体。自動レビューが止まったときだけ、止まったことを知らせるコメントを PR に 1 つ書く。
import { z } from 'zod'

import { isJsonObject, jsonField } from '@pecot/workflow-core/domain/json.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { decideReviewFinish, hasStoppedMarker, renderReviewStopped, stopLocationOf } from '@pecot/workflow-core/domain/review-finish.js'
import { isWritePermission } from '@pecot/workflow-core/domain/write-permission.js'
import type { ExecutionReading, FinishDecision, FinishInput, ReviewCommentReading, RunIdentity, StopLocation } from '@pecot/workflow-core/domain/review-finish.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { hinted, inputNameHint } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { COMMENT_VALIDATION_EXIT_CODE, hasReportedTemplateTextViolations } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { parseReference } from '@pecot/workflow-core/commands-shared/pr-reference.js'
import { nonEmpty, readExecutionFile } from './execution-file.js'
import REVIEW_STOPPED_TEMPLATE from '../templates/review-stopped.md?raw'

const PATH = ['review', 'finish']
const TEMPLATE_NAME = 'review-stopped'
const DEFAULT_TRIGGER_PHRASE = '@pecotbot review'

type SkipReason = 'reviewed' | 'job-succeeded' | 'workflow-mismatch' | 'closed' | 'already-written' | 'actor-without-write'

function skipText(reason: SkipReason): string {
  switch (reason) {
    case 'reviewed': { return 'the review finished' }
    case 'job-succeeded': { return 'the job succeeded' }
    case 'workflow-mismatch': { return 'the workflow file differs from the default branch, so the action skipped the review; a review started by a comment does not run on this PR either' }
    case 'closed': { return 'the PR is closed' }
    case 'already-written': { return 'this run already posted one' }
    case 'actor-without-write': { return 'the actor has no write permission' }
  }
}

/**
review-finish の action の入力。キーは action の input の名前の - を _ にしたもの
*/
export const REVIEW_FINISH_INPUT = z.strictObject({
  pr_ref: z.string(),
  job_status: z.enum(['success', 'failure', 'cancelled']),
  execution_file: z.string().optional(),
  since: z.string().optional(),
  review_outcome: z.enum(['success', 'failure', 'cancelled', 'skipped']),
  // Claude Code が動かなかった run では空
  review_conclusion: z.string(),
  review_has_token: z.enum(['true', 'false']),
})

type Input = z.output<typeof REVIEW_FINISH_INPUT>
type FinishOutput = Output

interface Target {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

function displayOf(target: Readonly<Target>): string {
  return `PR ${target.owner}/${target.repository}#${String(target.number)}`
}

function parseSince(out: FinishOutput, since: string | undefined): Date | undefined {
  // 雛形の出力が空のときも、止まった場所が分からないとして書く
  const value = nonEmpty(since)
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (Number.isNaN(time)) stopWith(out, hinted`${inputNameHint(PATH, 'since')} is not an ISO 8601 time: ${value}`, 'invalid-input')
  return new Date(time)
}

function finishInputOf(input: Readonly<Input>): FinishInput {
  const absent: ExecutionReading = { kind: 'absent' }
  return {
    kind: 'ensure',
    jobStatus: input.job_status,
    reviewOutcome: input.review_outcome,
    reviewConclusion: input.review_conclusion.trim(),
    hasToken: input.review_has_token === 'true',
    execution: input.job_status === 'failure' ? readExecutionFile(input.execution_file) : absent,
  }
}

function runIdentity(): RunIdentity | undefined {
  const runId = nonEmpty(process.env['GITHUB_RUN_ID'])
  return runId === undefined ? undefined : { runId, attempt: nonEmpty(process.env['GITHUB_RUN_ATTEMPT']) ?? '1' }
}

function skip(out: FinishOutput, target: Readonly<Target>, reason: SkipReason): void {
  const line: Operation = { verb: 'skip', target: `stopped-review comment on ${displayOf(target)} (${skipText(reason)})` }
  out.done(line)
}

async function readOrStop<T>(out: FinishOutput, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read ${what}: ${error.message}`, kindOfFailure(error))
  }
}

// 読めないときは書く側に倒す。止まったことが PR に残らないほうが困る
async function canActorWrite(out: FinishOutput, client: GitHubClient, target: Readonly<Target>): Promise<boolean> {
  const actor = nonEmpty(process.env['GITHUB_ACTOR'])
  // claude-code-action の checkWritePermissions と同じく、名前が [bot] で終わる起動者は API を読まずに書ける側とみなす
  if (actor === undefined || actor.endsWith('[bot]')) return true
  try {
    return isWritePermission(await client.getCollaboratorPermission(target.owner, target.repository, actor))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not read the permission of ${actor}: ${error.message}`)
    return true
  }
}

function reviewCommentOf(value: JsonValue): ReviewCommentReading {
  const body = jsonField(value, 'body')
  const createdAt = jsonField(value, 'created_at')
  return { body: typeof body === 'string' ? body : '', createdAt: typeof createdAt === 'string' ? createdAt : '' }
}

async function stopLocation(out: FinishOutput, client: GitHubClient, target: Readonly<Target>, since: Date | undefined): Promise<StopLocation> {
  if (since === undefined) return 'unknown'
  const comments = await readOrStop(out, `the review comments of ${displayOf(target)}`, async () => await client.listPullRequestReviewComments(target.owner, target.repository, target.number))
  return stopLocationOf(comments.filter(comment => isJsonObject(comment)).map(comment => reviewCommentOf(comment)), since)
}

function renderBody(out: FinishOutput, decision: Extract<FinishDecision, { action: 'write' }>, location: StopLocation, run: RunIdentity | undefined): string {
  const templateBody = stripLeadingHtmlComment(stripFrontmatter(REVIEW_STOPPED_TEMPLATE))
  const body = renderReviewStopped(templateBody, {
    result: decision.result,
    next: decision.next,
    location,
    triggerPhrase: nonEmpty(process.env['PECOT_REVIEW_TRIGGER_PHRASE']) ?? DEFAULT_TRIGGER_PHRASE,
    ...run !== undefined && { run },
  })
  if (hasReportedTemplateTextViolations(out, body, TEMPLATE_NAME, REVIEW_STOPPED_TEMPLATE)) throw new CommandExit(COMMENT_VALIDATION_EXIT_CODE, 'content-invalid')
  return body
}

// プロジェクトの設定を読まない。ホストは既定の github.com
function makeDefaultClient(out: FinishOutput): GitHubClient {
  try {
    return createGitHubClient(out, undefined)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, error.message, kindOfFailure(error))
  }
}

async function finish(out: FinishOutput, input: Readonly<Input>): Promise<void> {
  const since = parseSince(out, input.since)
  const target = parseReference(input.pr_ref, undefined, out)
  const decision = decideReviewFinish(finishInputOf(input))
  if (decision.action === 'skip') {
    skip(out, target, decision.reason)
    return
  }

  const client = makeDefaultClient(out)
  const state = await readOrStop(out, displayOf(target), async () => await client.getPullRequestState(target.owner, target.repository, target.number))
  if (state !== 'open') {
    skip(out, target, 'closed')
    return
  }
  if (decision.shouldCheckActor && !await canActorWrite(out, client, target)) {
    skip(out, target, 'actor-without-write')
    return
  }
  const run = runIdentity()
  if (run !== undefined) {
    const comments = await readOrStop(out, `the comments of ${displayOf(target)}`, async () => await client.listIssueCommentReadings(target.owner, target.repository, target.number))
    if (hasStoppedMarker(comments, run)) {
      skip(out, target, 'already-written')
      return
    }
  }
  const location = await stopLocation(out, client, target, since)
  const body = renderBody(out, decision, location, run)
  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, body)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not create a comment on ${displayOf(target)}: ${error.message}`, kindOfFailure(error))
  }
  out.done({ verb: 'create', target: `stopped-review comment (${decision.result}) on ${displayOf(target)}` })
  const url = jsonField(comment, 'html_url')
  if (typeof url === 'string') out.data(url)
}

/**
自動レビューの後始末。job の結果から止まったかを決め、止まっていれば PR にコメントを 1 つ書く
*/
export async function runReviewFinish(input: Readonly<Input>, io: CommandIo): Promise<number> {
  await finish(createOutput(false, io), input)
  return 0
}
