/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// review finish。自動レビューが止まったときだけ、止まったことを知らせるコメントを PR に 1 つ書く。
import { z } from 'zod'

import { isJsonObject, jsonField } from '../domain/json.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '../domain/frontmatter.js'
import { decideReviewFinish, hasStoppedMarker, readExecution, renderReviewStopped, stopLocationOf } from '../domain/review-finish.js'
import type { ExecutionReading, FinishDecision, FinishInput, IssueCommentReading, ReviewCommentReading, RunIdentity, StopLocation } from '../domain/review-finish.js'
import type { JsonValue } from '../domain/python-format.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { isFileNotFound } from '../infra/os-error.js'
import { templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { hinted, inputNameHint } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { COMMENT_VALIDATION_EXIT_CODE, hasReportedTemplateViolations } from './issue-shared.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Operation, Output } from './output.js'
import { parseReference, PR_REFERENCE_DESCRIPTION } from './pr-reference.js'

const PATH = ['review', 'finish']
const DEFAULT_TRIGGER_PHRASE = '@pecotbot review'
// action の checkWritePermissions と同じ。collaborators の permission で maintain は write になる
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'write'])

const SKIP_REASON_SCHEMA = z.enum(['reviewed', 'job-succeeded', 'closed', 'already-written', 'actor-without-write'])
type SkipReason = z.infer<typeof SKIP_REASON_SCHEMA>

function skipText(reason: SkipReason): string {
  switch (reason) {
    case 'reviewed': { return 'the review finished' }
    case 'job-succeeded': { return 'the job succeeded' }
    case 'closed': { return 'the PR is closed' }
    case 'already-written': { return 'this run already posted one' }
    case 'actor-without-write': { return 'the actor has no write permission' }
  }
}

const InputSchema = z.object({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  result: z.enum(['reviewed', 'failed', 'limit', 'setup-missing']).optional().describe('Result of the review, passed by the skill (reviewed/failed/limit/setup-missing)'),
  detail: z.string().optional().describe('Name of the missing setting (only with result setup-missing)'),
  ensure: z.boolean().default(false).describe('Called from the cleanup step of the workflow: decide the result from the job and write only if this run has not'),
  job_status: z.enum(['success', 'failure', 'cancelled']).optional().describe('Status of the job (required with ensure)'),
  execution_file: z.string().optional().describe('Path of the execution_file output of claude-code-action (only with ensure)'),
  since: z.string().optional().describe('Start time of the run in ISO 8601, to find the inline comments it posted (only with ensure)'),
  app_token_missing: z.boolean().default(false).describe('The action could not get the token of the Claude GitHub App (only with ensure)'),
  dry_run: z.boolean().default(false).describe('Read the PR and show the comment that would be posted without posting it'),
})

const OUTPUT = z.strictObject({
  pullRequest: z.string().describe('PR (owner/repo/N)'),
  result: z.enum(['failed', 'limit', 'setup-missing']).optional().describe('Result written in the comment (absent when skipped)'),
  location: z.enum(['before-findings', 'after-inline', 'unknown']).optional().describe('Where the review stopped (absent when skipped)'),
  skipped: SKIP_REASON_SCHEMA.optional().describe('Why no comment was written (absent when written)'),
  commentUrl: z.string().optional().describe('URL of the comment written (absent when skipped or on dry_run)'),
  dryRun: DRY_RUN_FIELD,
})

type FinishOutput = Output<z.input<typeof OUTPUT>>
type Input = z.output<typeof InputSchema>

interface Target {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

function displayOf(target: Readonly<Target>): string {
  return `PR ${target.owner}/${target.repository}#${String(target.number)}`
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function stopInvalid(out: FinishOutput, message: string | ReturnType<typeof hinted>): never {
  return stopWith(out, message, 'invalid-input')
}

// --result と --ensure のどちらか 1 つ。ensure の補助の引数は ensure と、detail は setup-missing と組む
function validateCombination(out: FinishOutput, input: Readonly<Input>): void {
  const result = inputNameHint(PATH, 'result')
  const ensure = inputNameHint(PATH, 'ensure')
  if (input.ensure === (input.result !== undefined)) stopInvalid(out, hinted`specify exactly one of ${result} and ${ensure}`)
  if (input.detail !== undefined && input.result !== 'setup-missing') stopInvalid(out, hinted`${inputNameHint(PATH, 'detail')} is only for ${result} setup-missing`)
  if (!input.ensure) {
    const given = { job_status: input.job_status !== undefined, execution_file: input.execution_file !== undefined, since: input.since !== undefined, app_token_missing: input.app_token_missing }
    const ensureOnly = Object.entries(given).find(([, isGiven]) => isGiven)?.[0]
    if (ensureOnly !== undefined) stopInvalid(out, hinted`${inputNameHint(PATH, ensureOnly)} is only for ${ensure}`)
    return
  }
  if (input.job_status === undefined) stopInvalid(out, hinted`${inputNameHint(PATH, 'job_status')} is required with ${ensure}`)
}

function parseSince(out: FinishOutput, since: string | undefined): Date | undefined {
  if (since === undefined) return undefined
  const time = Date.parse(since)
  if (Number.isNaN(time)) stopInvalid(out, hinted`${inputNameHint(PATH, 'since')} is not an ISO 8601 time: ${since}`)
  return new Date(time)
}

function readExecutionFile(path: string | undefined): ExecutionReading {
  const file = nonEmpty(path)
  if (file === undefined) return { kind: 'absent' }
  try {
    return readExecution(readTextFile(file))
  }
  catch (error: unknown) {
    return isFileNotFound(error) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

function finishInputOf(input: Readonly<Input>): FinishInput {
  if (input.result !== undefined) return { kind: 'result', result: input.result }
  const jobStatus = input.job_status ?? 'failure'
  const absent: ExecutionReading = { kind: 'absent' }
  const execution = jobStatus === 'failure' ? readExecutionFile(input.execution_file) : absent
  return { kind: 'ensure', jobStatus, isAppTokenMissing: input.app_token_missing, execution }
}

function runIdentity(): RunIdentity | undefined {
  const runId = nonEmpty(process.env['GITHUB_RUN_ID'])
  return runId === undefined ? undefined : { runId, attempt: nonEmpty(process.env['GITHUB_RUN_ATTEMPT']) ?? '1' }
}

function skip(out: FinishOutput, target: Readonly<Target>, reason: SkipReason): void {
  out.result({ pullRequest: `${target.owner}/${target.repository}/${String(target.number)}`, skipped: reason })
  const line: Operation = { verb: 'skip', target: `stopped-review comment on ${displayOf(target)} (${skipText(reason)})` }
  out.planned(line)
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
  if (actor === undefined) return true
  try {
    return WRITE_PERMISSIONS.has(await client.getCollaboratorPermission(target.owner, target.repository, actor))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not read the permission of ${actor}: ${error.message}`)
    return true
  }
}

function issueCommentOf(value: JsonValue): IssueCommentReading {
  const body = jsonField(value, 'body')
  const userType = jsonField(jsonField(value, 'user'), 'type')
  return { body: typeof body === 'string' ? body : '', userType: typeof userType === 'string' ? userType : '' }
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

function renderBody(out: FinishOutput, decision: Extract<FinishDecision, { action: 'write' }>, location: StopLocation, input: Readonly<Input>, run: RunIdentity | undefined): string {
  const file = templateFile('comment', 'review-stopped')
  const templateBody = stripLeadingHtmlComment(stripFrontmatter(readTextFile(file)))
  const body = renderReviewStopped(templateBody, {
    result: decision.result,
    next: decision.next,
    location,
    triggerPhrase: nonEmpty(process.env['PECOT_REVIEW_TRIGGER_PHRASE']) ?? DEFAULT_TRIGGER_PHRASE,
    ...input.detail !== undefined && { detail: input.detail },
    ...run !== undefined && { run },
  })
  if (hasReportedTemplateViolations(out, body, file)) throw new CommandExit(COMMENT_VALIDATION_EXIT_CODE, 'content-invalid')
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

async function finish(out: FinishOutput, input: Readonly<Input>, globalRepository: string | undefined): Promise<void> {
  validateCombination(out, input)
  const since = parseSince(out, input.since)
  const target = parseReference(input.pr_ref, globalRepository, out)
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
    const comments = await readOrStop(out, `the comments of ${displayOf(target)}`, async () => await client.listIssueComments(target.owner, target.repository, target.number))
    if (hasStoppedMarker(comments.filter(comment => isJsonObject(comment)).map(comment => issueCommentOf(comment)), run)) {
      skip(out, target, 'already-written')
      return
    }
  }
  const location = await stopLocation(out, client, target, since)
  const body = renderBody(out, decision, location, input, run)
  const pullRequest = `${target.owner}/${target.repository}/${String(target.number)}`
  const created: Operation = { verb: 'create', target: `stopped-review comment (${decision.result}) on ${displayOf(target)}` }
  if (input.dry_run) {
    out.result({ pullRequest, result: decision.result, location })
    out.planned(created)
    out.data(body)
    return
  }

  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, body)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not create a comment on ${displayOf(target)}: ${error.message}`, kindOfFailure(error))
  }
  const url = jsonField(comment, 'html_url')
  out.result({ pullRequest, result: decision.result, location, ...typeof url === 'string' && { commentUrl: url } })
  out.done(created)
  if (typeof url === 'string') out.data(url)
}

const REVIEW_FINISH = defineCommand({
  path: PATH,
  description: 'Finish an automated review: post a comment on the PR only when the review stopped (failed, limit or setup-missing)',
  input: InputSchema,
  output: OUTPUT,
  positional: ['pr_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof OUTPUT>>(input.dry_run, io)
    await finish(out, input, input.repo)
    return 0
  },
})

export const REVIEW_COMMANDS: readonly CommandDefinition[] = [REVIEW_FINISH]
