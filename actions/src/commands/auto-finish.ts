// auto-finish。AI の後の step（always()）と setup job が呼ぶ。結果を決めてコメントを書き、待ちの値を書き、起動ラベルを外す。
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { AUTO_RESULTS, decideAutoEnsure, markerBranch, runResultOf } from '@pecot/workflow-core/domain/auto-result.js'
import type { AutoResult } from '@pecot/workflow-core/domain/auto-result.js'
import { stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'
import { applyResultEffects, waitingTargetOf, writeAutoResult } from './auto-result-write.js'
import { issueDisplay, readOrStop, requireAutoConfig, runIdentity } from './auto-shared.js'
import { readExecutionFile } from './execution-file.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { readIssueSnapshot } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import { ISSUE_REF_DESCRIPTION, parseIssueReferenceOrExit, runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'

const PATH = ['auto', 'finish']

export const AUTO_FINISH_INPUT = z.object({
  issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
  result: z.enum(AUTO_RESULTS).optional().describe('Result to write as it is, for a step that decided it (setup-missing in the setup job)'),
  body_file: z.string().optional().describe('Path of a file with the text for result'),
  result_file: z.string().optional().describe('Path of the result file the skill writes (frontmatter result and the text)'),
  job_status: z.enum(['success', 'failure', 'cancelled']).optional().describe('Status of the job (required without result)'),
  execution_file: z.string().optional().describe('Path of the execution_file output of claude-code-action (may be empty)'),
  start_outcome: z.enum(['success', 'failure', 'cancelled', 'skipped']).optional().describe('Outcome of the auto-start step (required without result)'),
  project: PROJECT_INPUT,
})

type Input = z.output<typeof AUTO_FINISH_INPUT>

/**
結果と、コメントに書く本文
*/
interface Decided {
  readonly result: AutoResult
  readonly body?: string
}

export const START_FAILED_TEXT = '自動処理の準備（Start の step）が成功しなかったので、自動処理を始めなかった。失敗の理由は、実行の記録の Start の step に出ている。'
export const NO_RESULT_TEXT = 'スキルが結果のファイルを書かずに終わった。'

function invalidResultText(reason: string): string {
  return `スキルが書いた結果のファイルを読めなかった（${reason}）。`
}

const ResultFrontmatter = z.object({ result: z.enum(AUTO_RESULTS) })

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

function stopInvalid(out: Output, message: string): never {
  return stopWith(out, message, 'invalid-input')
}

/**
渡された結果をそのまま書く決め方
*/
interface DirectMode {
  readonly kind: 'direct'
  readonly result: AutoResult
  readonly bodyFile: string | undefined
}

/**
job の様子から結果を決める決め方
*/
interface EnsureMode {
  readonly kind: 'ensure'
  readonly jobStatus: NonNullable<Input['job_status']>
  readonly startOutcome: string
  readonly resultFile: string | undefined
  readonly executionFile: string | undefined
}

type Mode = DirectMode | EnsureMode

// result の直接の指定と、job から決める入力は組まない
function modeOf(out: Output, input: Readonly<Input>): Mode {
  if (input.result !== undefined) {
    const given = { 'job-status': input.job_status, 'execution-file': input.execution_file, 'start-outcome': input.start_outcome, 'result-file': input.result_file }
    const extra = Object.entries(given).find(([, value]) => value !== undefined)?.[0]
    if (extra !== undefined) stopInvalid(out, `${extra} is not used with result`)
    return { kind: 'direct', result: input.result, bodyFile: input.body_file }
  }
  if (input.body_file !== undefined) stopInvalid(out, 'body-file is only for result')
  if (input.job_status === undefined) return stopInvalid(out, 'job-status is required without result')
  if (input.start_outcome === undefined) return stopInvalid(out, 'start-outcome is required without result')
  return { kind: 'ensure', jobStatus: input.job_status, startOutcome: input.start_outcome, resultFile: input.result_file, executionFile: input.execution_file }
}

function readOptionalText(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  try {
    return readTextFile(file)
  }
  catch (error: unknown) {
    if (!isFileNotFound(error)) throw error
    return undefined
  }
}

function bodyOf(text: string): string | undefined {
  const body = text.trim()
  return body === '' ? undefined : body
}

// スキルが書いた結果のファイル。frontmatter の result が決まった値でなければ、読めた本文を添えて failed にする
function resultFileOf(out: Output, text: string): Decided {
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    out.warning('the result file has no frontmatter; writing failed')
    return { result: 'failed', body: invalidResultText('frontmatter が無い') }
  }
  let data: unknown
  try {
    data = parseYaml(match[1] ?? '')
  }
  catch {
    data = undefined
  }
  const parsed = ResultFrontmatter.safeParse(data)
  if (!parsed.success) {
    out.warning('the result file has no result of a known kind; writing failed')
    return { result: 'failed', body: invalidResultText('frontmatter の `result` が決まった値でない') }
  }
  const body = bodyOf(stripLeadingHtmlComment(text.slice(match[0].length)))
  return { result: parsed.data.result, ...body !== undefined && { body } }
}

// 判定の順: Start の失敗、結果のファイル、ファイルの無い成功、job の失敗の中身
function decideEnsure(out: Output, mode: Readonly<EnsureMode>): Decided {
  if (mode.startOutcome !== 'success') return { result: 'setup-missing', body: START_FAILED_TEXT }
  const written = readOptionalText(mode.resultFile)
  if (written !== undefined) return resultFileOf(out, written)
  const { jobStatus } = mode
  const decision = decideAutoEnsure({ jobStatus, execution: jobStatus === 'failure' ? readExecutionFile(mode.executionFile) : { kind: 'absent' } })
  // job の成功は、スキルが結果を書いた印にならない。ファイルが無ければ書かずに終わった
  return decision.action === 'skip' ? { result: 'failed', body: NO_RESULT_TEXT } : { result: decision.result }
}

function decideDirect(out: Output, mode: Readonly<DirectMode>): Decided {
  const { result, bodyFile } = mode
  if (bodyFile === undefined) return { result }
  const text = readOptionalText(bodyFile)
  return text === undefined ? stopInvalid(out, `body-file does not exist: ${bodyFile}`) : { result, body: text }
}

function skipWritten(out: Output, target: Readonly<IssueTarget>): void {
  settle(out, { verb: 'skip', target: `auto result comment on ${issueDisplay(target)} (this run already posted one)` })
}

async function finish(out: Output, input: Readonly<Input>): Promise<void> {
  const mode = modeOf(out, input)
  const target = parseIssueReferenceOrExit(out, undefined, input.issue_ref)
  const repository = { owner: target.owner, repository: target.repository }
  const config = requireAutoConfig(out, repository, input.project, PATH)
  const decided = mode.kind === 'ensure' ? decideEnsure(out, mode) : decideDirect(out, mode)
  const client = createGitHubClient(out, config.host)
  const display = issueDisplay(target)
  const run = runIdentity()
  if (run !== undefined) {
    const comments = await readOrStop(out, `the comments of ${display}`, async () => await client.listIssueCommentRecords(target.owner, target.repository, target.number))
    const written = runResultOf(comments, run)
    if (written !== undefined) {
      // 途中で失敗した書き込みを、呼び直しで直す
      const waiting = await waitingTargetOf(out, client, config, target, written)
      await applyResultEffects(out, client, config, target, written, waiting)
      skipWritten(out, target)
      return
    }
  }
  const snapshot = await readOrStop(out, display, async () => await readIssueSnapshot(client, config, { repository, number: target.number }))
  if (snapshot.kind === 'unreadable') return stopWith(out, `could not read ${display}: ${snapshot.reason}`, 'github-api')
  const branch = markerBranch(snapshot.target.branches, snapshot.target.pullRequests, target.number)
  const url = await writeAutoResult(out, client, config, target, { result: decided.result, branch, ...decided.body !== undefined && { body: decided.body } })
  if (url !== undefined) out.data(url)
}

/**
自動処理の結果を決めて、Issue に結果のコメントを書く。同じ run・同じ試行で書いたものがあれば、書き直さない
*/
export async function runAutoFinish(input: Readonly<Input>, io: CommandIo): Promise<number> {
  const out = createOutput(false, io)
  return await runWithExit(async () => {
    await finish(out, input)
  })
}
