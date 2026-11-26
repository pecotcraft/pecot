// auto finish。結果のコメントを書き、待ちの値を書き、起動ラベルを外す。スキルが --result で、ワークフローの後始末が --ensure で呼ぶ。
import { z } from 'zod'

import { AUTO_RESULTS, decideAutoEnsure, markerBranch, runResultOf } from '@pecot/workflow-core/domain/auto-result.js'
import type { AutoResult } from '@pecot/workflow-core/domain/auto-result.js'
import type { ExecutionReading } from '@pecot/workflow-core/domain/review-finish.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'
import { applyResultEffects, waitingTargetOf, writeAutoResult } from './auto-result-write.js'
import { issueDisplay, readOrStop, requireAutoConfig, runIdentity } from './auto-shared.js'
import { defineCommand } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { hinted, inputNameHint } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { readIssueSnapshot } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { readExecutionFile } from './review-finish.js'

const PATH = ['auto', 'finish']

const InputSchema = z.object({
  issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
  result: z.enum(AUTO_RESULTS).optional().describe('Result of the run, passed by the skill (pr-created/ci-passed/ci-fix-pushed/question/out-of-scope/failed/limit/setup-missing)'),
  body_file: z.string().optional().describe('Path of a file with the text for the result, such as the question or the failed tests (only with result)'),
  ensure: z.boolean().default(false).describe('Called from the cleanup step of the workflow: decide the result from the job and write only if this run has not'),
  job_status: z.enum(['success', 'failure', 'cancelled']).optional().describe('Status of the job (required with ensure)'),
  execution_file: z.string().optional().describe('Path of the execution_file output of claude-code-action (only with ensure; may be empty)'),
  project: PROJECT_INPUT,
  dry_run: z.boolean().default(false).describe('Read the Issue and print the comment that would be posted without writing the comment, the Status or the label'),
})

const SKIP_REASON_SCHEMA = z.enum(['job-succeeded', 'already-written'])
type SkipReason = z.infer<typeof SKIP_REASON_SCHEMA>

const OUTPUT = z.strictObject({
  issue: z.string().describe('Issue (owner/repo/N)'),
  result: z.enum(AUTO_RESULTS).optional().describe('Result of the run (absent when the job succeeded with ensure)'),
  skipped: SKIP_REASON_SCHEMA.optional().describe('Why no comment was written (absent when written)'),
  commentUrl: z.string().optional().describe('URL of the comment written (absent when none was written, or when GitHub returned no URL)'),
})

type FinishOutput = Output<z.input<typeof OUTPUT>>
type Input = z.output<typeof InputSchema>

function skipText(reason: SkipReason): string {
  return reason === 'job-succeeded' ? 'the job succeeded and the skill wrote the result' : 'this run already posted one'
}

function stopInvalid(out: FinishOutput, message: string | ReturnType<typeof hinted>): never {
  return stopWith(out, message, 'invalid-input')
}

// --result と --ensure のどちらか 1 つ。ensure の補助の引数は ensure と、body_file は result と組む
function validateCombination(out: FinishOutput, input: Readonly<Input>): void {
  const result = inputNameHint(PATH, 'result')
  const ensure = inputNameHint(PATH, 'ensure')
  if (input.ensure === (input.result !== undefined)) stopInvalid(out, hinted`specify exactly one of ${result} and ${ensure}`)
  if (input.body_file !== undefined && input.result === undefined) stopInvalid(out, hinted`${inputNameHint(PATH, 'body_file')} is only for ${result}`)
  if (!input.ensure) {
    const given = { job_status: input.job_status, execution_file: input.execution_file }
    const ensureOnly = Object.entries(given).find(([, value]) => value !== undefined)?.[0]
    if (ensureOnly !== undefined) stopInvalid(out, hinted`${inputNameHint(PATH, ensureOnly)} is only for ${ensure}`)
    return
  }
  if (input.job_status === undefined) stopInvalid(out, hinted`${inputNameHint(PATH, 'job_status')} is required with ${ensure}`)
}

function readBodyFile(out: FinishOutput, file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  try {
    return readTextFile(file)
  }
  catch (error: unknown) {
    if (!isFileNotFound(error)) throw error
    return stopInvalid(out, hinted`${inputNameHint(PATH, 'body_file')} does not exist: ${file}`)
  }
}

// 書く結果。ensure で job が成功したときは undefined（スキルが --result で書いている）
function resultOf(input: Readonly<Input>): AutoResult | undefined {
  if (input.result !== undefined) return input.result
  const jobStatus = input.job_status ?? 'failure'
  const absent: ExecutionReading = { kind: 'absent' }
  const decision = decideAutoEnsure({ jobStatus, execution: jobStatus === 'failure' ? readExecutionFile(input.execution_file) : absent })
  return decision.action === 'skip' ? undefined : decision.result
}

function skip(out: FinishOutput, target: Readonly<IssueTarget>, reason: SkipReason, result?: AutoResult): void {
  out.result({ issue: issuePath(target.owner, target.repository, target.number), skipped: reason, ...result !== undefined && { result } })
  const line: Operation = { verb: 'skip', target: `auto result comment on ${issueDisplay(target)} (${skipText(reason)})` }
  out.planned(line)
  out.done(line)
}

async function finish(out: FinishOutput, input: Readonly<Input>, globalRepository: string | undefined): Promise<void> {
  validateCombination(out, input)
  const target = parseIssueReferenceOrExit(out, globalRepository, input.issue_ref)
  const repository = { owner: target.owner, repository: target.repository }
  const config = requireAutoConfig(out, repository, input.project, PATH)
  const result = resultOf(input)
  if (result === undefined) {
    skip(out, target, 'job-succeeded')
    return
  }
  const body = readBodyFile(out, input.body_file)
  const client = createGitHubClient(out, config.host)
  const display = issueDisplay(target)
  const run = runIdentity()
  if (run !== undefined && input.ensure) {
    const comments = await readOrStop(out, `the comments of ${display}`, async () => await client.listIssueCommentRecords(target.owner, target.repository, target.number))
    const written = runResultOf(comments, run)
    if (written !== undefined) {
      // 途中で失敗した書き込みを、呼び直しで直す
      const waiting = await waitingTargetOf(out, client, config, target, written)
      await applyResultEffects(out, client, config, target, written, waiting, input.dry_run)
      skip(out, target, 'already-written', written)
      return
    }
  }
  const snapshot = await readOrStop(out, display, async () => await readIssueSnapshot(client, config, { repository, number: target.number }))
  if (snapshot.kind === 'unreadable') return stopWith(out, `could not read ${display}: ${snapshot.reason}`, 'github-api')
  const branch = markerBranch(snapshot.target.branches, snapshot.target.pullRequests, target.number)
  const outcome = await writeAutoResult(out, client, config, target, { result, branch, ...body !== undefined && { body } }, input.dry_run)
  out.result({ issue: issuePath(target.owner, target.repository, target.number), result, ...outcome.commentUrl !== undefined && { commentUrl: outcome.commentUrl } })
  if (input.dry_run) out.data(outcome.body)
  else if (outcome.commentUrl !== undefined) out.data(outcome.commentUrl)
}

const AUTO_FINISH = defineCommand({
  path: PATH,
  title: 'Finish automated fix',
  description: 'Finish an automated fix run: post the result comment, set the waiting Status and remove the trigger label',
  input: InputSchema,
  output: OUTPUT,
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof OUTPUT>>(input.dry_run, io)
    return await runWithExit(async () => {
      await finish(out, input, input.repo)
    })
  },
})

export const AUTO_FINISH_COMMANDS: readonly CommandDefinition[] = [AUTO_FINISH]
