/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
/* eslint-disable security/detect-non-literal-fs-filename -- パスは GitHub Actions が渡すイベントと GITHUB_OUTPUT */
// auto gate。ワークフローの先の job が呼び、イベントから、自動処理を進めるかと種類を決める。
import { appendFileSync } from 'node:fs'

import { z } from 'zod'

import { autoContextOf, permissionCandidates } from '../domain/auto-context.js'
import { decideGate, screenIssues, screenWorkflowRun } from '../domain/auto-gate.js'
import type { AutoRun, GateDecision, IssueGateFacts, IssuesScreenInput, WorkflowRunScreenInput } from '../domain/auto-gate.js'
import { AUTO_RESULTS } from '../domain/auto-result.js'
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import type { ProjectConfig } from '../domain/config.js'
import { isJsonObject, jsonField, tryParseJsonText } from '../domain/json.js'
import type { JsonValue } from '../domain/python-format.js'
import { describeReadiness } from '../domain/readiness.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '../infra/github/errors.js'
import { asArray } from '../infra/github/payload.js'
import { isFileNotFound } from '../infra/os-error.js'
import { readTextFile } from '../infra/text-file.js'
import { writeAutoResult } from './auto-result-write.js'
import { issueDisplay, readOrStop, requireAutoConfig, writersAmong } from './auto-shared.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { hinted, inputNameHint } from './command-hint.js'
import { PROJECT_INPUT, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createReadinessCache, judgeSnapshot, readIssueSnapshotWithReadout } from './issue-readiness.js'
import type { IssueSnapshot } from './issue-readiness.js'
import type { IssueTarget } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'

const PATH = ['auto', 'gate']
const DEFAULT_MAX_CI_ATTEMPTS = 3

const InputSchema = z.object({
  event_name: z.enum(['issues', 'workflow_run']).describe('Name of the GitHub Actions event (issues or workflow_run)'),
  event_path: z.string().describe('Path of the event JSON (GITHUB_EVENT_PATH)'),
  max_ci_attempts: z.int().min(0).default(DEFAULT_MAX_CI_ATTEMPTS).describe('Maximum number of CI fixes on one branch'),
  project: PROJECT_INPUT,
  dry_run: z.boolean().default(false).describe('Decide without writing the result comment; put the body that would be posted in the comment field of the JSON'),
})

const KIND_SCHEMA = z.enum(['start', 'resume', 'ci-fix', 'ci-passed', ''])

const RUN_JSON = z.strictObject({
  issue: z.string().describe('Issue (owner/repo/N); empty when the branch of the workflow run does not end with an Issue number'),
  number: z.int().describe('Issue number; 0 when unknown'),
  kind: KIND_SCHEMA.describe('Kind of the run (start/resume/ci-fix/ci-passed); empty when it is not decided'),
  proceed: z.boolean().describe('Whether the agent runs'),
  reason: z.string().describe('Why the agent does not run; empty when it runs'),
  branch: z.string().describe('Existing branch of the Issue; empty when none'),
  pr: z.int().describe('Existing PR number; 0 when none'),
  ci_attempts: z.int().describe('Number of CI fixes so far on the branch'),
})

// 実行の欄は run の中に入れる。kind と reason は、MCP の data の共通の項目と名前が重なる
const OUTPUT = z.strictObject({
  run: RUN_JSON.describe('The run: the same fields as the JSON on stdout and GITHUB_OUTPUT'),
  result: z.enum(AUTO_RESULTS).optional().describe('Result written in the comment (absent when no comment was written)'),
  commentUrl: z.string().optional().describe('URL of the comment written (absent when none was written, or when GitHub returned no URL)'),
})

type GateOutput = Output<z.input<typeof OUTPUT>>
type Input = z.output<typeof InputSchema>

function stopInvalid(out: GateOutput, message: string | ReturnType<typeof hinted>): never {
  return stopWith(out, message, 'invalid-input')
}

function readEvent(out: GateOutput, file: string): JsonValue {
  let text: string
  try {
    text = readTextFile(file)
  }
  catch (error: unknown) {
    if (!isFileNotFound(error)) throw error
    return stopInvalid(out, hinted`${inputNameHint(PATH, 'event_path')} does not exist: ${file}`)
  }
  return tryParseJsonText(text) ?? stopInvalid(out, hinted`${inputNameHint(PATH, 'event_path')} is not JSON: ${file}`)
}

function valueAt(value: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined {
  let current = value
  for (const key of keys) current = jsonField(current, key)
  return current
}

function textAt(value: JsonValue | undefined, ...keys: readonly string[]): string | undefined {
  const found = valueAt(value, keys)
  return typeof found === 'string' ? found : undefined
}

function numberAt(value: JsonValue | undefined, ...keys: readonly string[]): number | undefined {
  const found = valueAt(value, keys)
  return typeof found === 'number' && Number.isSafeInteger(found) ? found : undefined
}

function required<T>(out: GateOutput, value: T | undefined, name: string): T {
  return value ?? stopInvalid(out, `the event has no ${name}`)
}

function repositoryOf(out: GateOutput, event: JsonValue): RepositoryReference {
  return { owner: required(out, textAt(event, 'repository', 'owner', 'login'), 'repository.owner.login'), repository: required(out, textAt(event, 'repository', 'name'), 'repository.name') }
}

function issuesEventOf(out: GateOutput, event: JsonValue): Omit<IssuesScreenInput, 'permission'> {
  const state = textAt(event, 'issue', 'state')
  if (state !== 'open' && state !== 'closed') return stopInvalid(out, 'the event has no issue.state of open or closed')
  return {
    repository: repositoryOf(out, event),
    number: required(out, numberAt(event, 'issue', 'number'), 'issue.number'),
    sender: required(out, textAt(event, 'sender', 'login'), 'sender.login'),
    isPullRequest: isJsonObject(jsonField(jsonField(event, 'issue'), 'pull_request')),
    state,
  }
}

function workflowRunEventOf(out: GateOutput, event: JsonValue): WorkflowRunScreenInput {
  const repository = repositoryOf(out, event)
  const pullRequests = valueAt(event, ['workflow_run', 'pull_requests'])
  const first = asArray(pullRequests).at(0)
  return {
    repository,
    action: required(out, textAt(event, 'action'), 'action'),
    // 終わっていない run の conclusion は null
    conclusion: textAt(event, 'workflow_run', 'conclusion') ?? '',
    headBranch: required(out, textAt(event, 'workflow_run', 'head_branch'), 'workflow_run.head_branch'),
    headSha: required(out, textAt(event, 'workflow_run', 'head_sha'), 'workflow_run.head_sha'),
    headCommitTime: textAt(event, 'workflow_run', 'head_commit', 'timestamp'),
    isFork: textAt(event, 'workflow_run', 'head_repository', 'full_name') !== textAt(event, 'repository', 'full_name'),
    pullRequest: numberAt(first, 'number') ?? 0,
  }
}

// ラベルを付けた人の権限。[bot] と読めないときは undefined で、判定が何も書かずに止める
async function senderPermission(client: GitHubClient, repository: Readonly<RepositoryReference>, sender: string): Promise<string | undefined> {
  if (sender.endsWith('[bot]')) return undefined
  try {
    return await client.getCollaboratorPermission(repository.owner, repository.repository, sender)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return undefined
  }
}

async function blockedTextOf(client: GitHubClient, snapshot: Readonly<IssueSnapshot>): Promise<string | undefined> {
  const judged = await judgeSnapshot(client, snapshot, createReadinessCache())
  return judged.kind === 'judged' && judged.readiness !== undefined ? describeReadiness(judged.readiness, judged.prerequisites, snapshot.ref.repository) : undefined
}

async function readIssueFacts(out: GateOutput, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>): Promise<IssueGateFacts> {
  const repository = { owner: target.owner, repository: target.repository }
  const display = issueDisplay(target)
  try {
    const read = await readIssueSnapshotWithReadout(client, config, { repository, number: target.number })
    if (read.kind === 'unreadable') return stopWith(out, `could not read ${display}: ${read.reason}`, 'github-api')
    const { snapshot, issue } = read
    const comments = await client.listIssueCommentRecords(target.owner, target.repository, target.number)
    const writers = await writersAmong(client, repository, permissionCandidates(comments, 'plan'))
    const { column } = snapshot.target
    return {
      title: snapshot.title,
      kind: snapshot.target.kind,
      subIssues: issue.subIssuesTotal,
      column,
      blockedText: column === 'Blocked' ? await blockedTextOf(client, snapshot) : undefined,
      branches: snapshot.target.branches,
      pullRequests: snapshot.target.pullRequests,
      comments,
      hasPlan: autoContextOf(comments, writers).plan !== '',
    }
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read ${display}: ${error.message}`, kindOfFailure(error))
  }
}

async function decideIssues(out: GateOutput, client: GitHubClient, config: ProjectConfig, event: JsonValue): Promise<GateDecision> {
  const read = issuesEventOf(out, event)
  const permission = await senderPermission(client, read.repository, read.sender)
  const screen = { ...read, permission }
  const screened = screenIssues(screen)
  if (screened !== undefined) return screened
  const facts = await readIssueFacts(out, client, config, { ...read.repository, number: read.number })
  return decideGate({ event: 'issues', ...screen, facts })
}

async function branchShaOf(out: GateOutput, client: GitHubClient, repository: Readonly<RepositoryReference>, branch: string): Promise<string | undefined> {
  try {
    return await client.getBranchSha(repository.owner, repository.repository, branch)
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return undefined
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read the branch ${branch}: ${error.message}`, kindOfFailure(error))
  }
}

async function decideWorkflowRun(out: GateOutput, client: GitHubClient, event: JsonValue, maxCiAttempts: number): Promise<GateDecision> {
  const read = workflowRunEventOf(out, event)
  const screened = screenWorkflowRun(read)
  if (screened !== undefined) return screened
  // screenWorkflowRun を抜けたブランチは、末尾が Issue 番号
  const number = extractIssueNumberFromBranch(read.headBranch) ?? 0
  const display = issueDisplay({ ...read.repository, number })
  const comments = await readOrStop(out, `the comments of ${display}`, async () => await client.listIssueCommentRecords(read.repository.owner, read.repository.repository, number))
  const branchSha = await branchShaOf(out, client, read.repository, read.headBranch)
  return decideGate({ event: 'workflow_run', ...read, comments, branchSha, maxCiAttempts })
}

type RunFields = z.input<typeof RUN_JSON>

function runFields(run: Readonly<AutoRun>): RunFields {
  return { issue: run.issue, number: run.number, kind: run.kind, proceed: run.proceed, reason: run.reason, branch: run.branch, pr: run.pr, ci_attempts: run.ciAttempts }
}

// GITHUB_OUTPUT は key=value の行。値の改行は、次の行を別の出力として読ませないよう空白にする
function appendGithubOutput(fields: Readonly<RunFields>): void {
  const file = process.env['GITHUB_OUTPUT']?.trim()
  if (file === undefined || file === '') return
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${String(value).replaceAll(/[\r\n]+/gu, ' ')}\n`)
  appendFileSync(file, lines.join(''), 'utf8')
}

async function gate(out: GateOutput, input: Readonly<Input>): Promise<void> {
  const event = readEvent(out, input.event_path)
  const repository = repositoryOf(out, event)
  const config = requireAutoConfig(out, repository, input.project, PATH)
  const client = createGitHubClient(out, config.host)
  const decision = input.event_name === 'issues'
    ? await decideIssues(out, client, config, event)
    : await decideWorkflowRun(out, client, event, input.max_ci_attempts)
  const fields = runFields(decision.run)
  const { write } = decision
  const target = { ...repository, number: decision.run.number }
  if (write === undefined && !decision.run.proceed) {
    const skipped: Operation = { verb: 'skip', target: `automated fix${target.number > 0 ? ` for ${issueDisplay(target)}` : ''} (${decision.run.reason})` }
    out.planned(skipped)
    out.done(skipped)
  }
  const written = write === undefined
    ? undefined
    : await writeAutoResult(out, client, config, target, { result: write.result, next: write.next, branch: write.branch, ...write.text !== '' && { body: write.text } }, input.dry_run)
  out.result({ run: fields, ...write !== undefined && { result: write.result }, ...written?.commentUrl !== undefined && { commentUrl: written.commentUrl } })
  out.data(JSON.stringify(written !== undefined && input.dry_run ? { ...fields, comment: written.body } : fields))
  appendGithubOutput(fields)
}

const AUTO_GATE = defineCommand({
  path: PATH,
  title: 'Gate automated fix',
  description: 'Decide from a GitHub Actions event whether the automated fix runs, and of what kind',
  input: InputSchema,
  output: OUTPUT,
  positional: [],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof OUTPUT>>(input.dry_run, io)
    await gate(out, input)
    return 0
  },
})

export const AUTO_GATE_COMMANDS: readonly CommandDefinition[] = [AUTO_GATE]
