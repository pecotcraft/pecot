/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// auto-gate。ワークフローの先の job が呼び、イベントから、自動処理を進めるかと種類を決めて outputs に出す。
import { setOutput } from '@actions/core'
import { z } from 'zod'

import { autoContextOf, permissionCandidates } from '@pecot/workflow-core/domain/auto-context.js'
import { decideGate, isFailedConclusion, screenIssues, screenWorkflowRun } from '@pecot/workflow-core/domain/auto-gate.js'
import type { AutoRun, GateDecision, IssueGateFacts, IssuesScreenInput, WorkflowRunScreenInput } from '@pecot/workflow-core/domain/auto-gate.js'
import { extractIssueNumberFromBranch } from '@pecot/workflow-core/domain/branch-name.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { isJsonObject, jsonField, tryParseJsonText } from '@pecot/workflow-core/domain/json.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import { describeReadiness } from '@pecot/workflow-core/domain/readiness.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '@pecot/workflow-core/infra/github/errors.js'
import { asArray } from '@pecot/workflow-core/infra/github/payload.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readTextFile } from '@pecot/workflow-core/infra/text-file.js'
import { writeAutoResult } from './auto-result-write.js'
import { issueDisplay, readOrStop, requireAutoConfig, writersAmong } from './auto-shared.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createReadinessCache, judgeSnapshot, readIssueSnapshotWithReadout } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import type { IssueSnapshot } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'

const PATH = ['auto', 'gate']
const DEFAULT_MAX_CI_ATTEMPTS = 3

export const AUTO_GATE_INPUT = z.object({
  event_name: z.enum(['issues', 'workflow_run']).describe('Name of the GitHub Actions event (GITHUB_EVENT_NAME)'),
  event_path: z.string().describe('Path of the event JSON (GITHUB_EVENT_PATH)'),
  max_ci_attempts: z.int().min(0).default(DEFAULT_MAX_CI_ATTEMPTS).describe('Maximum number of CI fixes on one branch'),
  project: PROJECT_INPUT,
})

type Input = z.output<typeof AUTO_GATE_INPUT>

function stopInvalid(out: Output, message: string): never {
  return stopWith(out, message, 'invalid-input')
}

function readEvent(out: Output, file: string): JsonValue {
  let text: string
  try {
    text = readTextFile(file)
  }
  catch (error: unknown) {
    if (!isFileNotFound(error)) throw error
    return stopInvalid(out, `the event file (GITHUB_EVENT_PATH) does not exist: ${file}`)
  }
  return tryParseJsonText(text) ?? stopInvalid(out, `the event file (GITHUB_EVENT_PATH) is not JSON: ${file}`)
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

function required<T>(out: Output, value: T | undefined, name: string): T {
  return value ?? stopInvalid(out, `the event has no ${name}`)
}

function repositoryOf(out: Output, event: JsonValue): RepositoryReference {
  return { owner: required(out, textAt(event, 'repository', 'owner', 'login'), 'repository.owner.login'), repository: required(out, textAt(event, 'repository', 'name'), 'repository.name') }
}

function issuesEventOf(out: Output, event: JsonValue): Omit<IssuesScreenInput, 'permission'> {
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

function workflowRunEventOf(out: Output, event: JsonValue): WorkflowRunScreenInput {
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
    actorType: textAt(event, 'workflow_run', 'actor', 'type'),
    createdAt: textAt(event, 'workflow_run', 'created_at'),
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

async function readIssueFacts(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>): Promise<IssueGateFacts> {
  const repository = { owner: target.owner, repository: target.repository }
  const display = issueDisplay(target)
  try {
    const read = await readIssueSnapshotWithReadout(client, config, { repository, number: target.number })
    if (read.kind === 'unreadable') return stopWith(out, `could not read ${display}: ${read.reason}`, 'github-api')
    const { snapshot, issue } = read
    const comments = await client.listIssueCommentRecords(target.owner, target.repository, target.number)
    const writers = await writersAmong(out, client, repository, permissionCandidates(comments, 'plan'))
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

async function decideIssues(out: Output, client: GitHubClient, config: ProjectConfig, event: JsonValue): Promise<GateDecision> {
  const read = issuesEventOf(out, event)
  const permission = await senderPermission(client, read.repository, read.sender)
  const screen = { ...read, permission }
  const screened = screenIssues(screen)
  if (screened !== undefined) return screened
  const facts = await readIssueFacts(out, client, config, { ...read.repository, number: read.number })
  return decideGate({ event: 'issues', ...screen, facts })
}

async function branchShaOf(out: Output, client: GitHubClient, repository: Readonly<RepositoryReference>, branch: string): Promise<string | undefined> {
  try {
    return await client.getBranchSha(repository.owner, repository.repository, branch)
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return undefined
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read the branch ${branch}: ${error.message}`, kindOfFailure(error))
  }
}

async function hasFailedRunOf(out: Output, client: GitHubClient, read: Readonly<WorkflowRunScreenInput>): Promise<boolean> {
  if (read.conclusion !== 'success') return false
  const runs = await readOrStop(out, `the workflow runs of ${read.headSha}`, async () => await client.listWorkflowRunConclusions(read.repository.owner, read.repository.repository, read.headSha))
  return runs.some(run => isFailedConclusion(run.conclusion))
}

async function decideWorkflowRun(out: Output, client: GitHubClient, event: JsonValue, maxCiAttempts: number): Promise<GateDecision> {
  const read = workflowRunEventOf(out, event)
  const screened = screenWorkflowRun(read)
  if (screened !== undefined) return screened
  // screenWorkflowRun を抜けたブランチは、末尾が Issue 番号
  const number = extractIssueNumberFromBranch(read.headBranch) ?? 0
  const display = issueDisplay({ ...read.repository, number })
  const comments = await readOrStop(out, `the comments of ${display}`, async () => await client.listIssueCommentRecords(read.repository.owner, read.repository.repository, number))
  const branchSha = await branchShaOf(out, client, read.repository, read.headBranch)
  const hasFailedRun = await hasFailedRunOf(out, client, read)
  return decideGate({ event: 'workflow_run', ...read, comments, branchSha, hasFailedRun, maxCiAttempts })
}

function runFields(run: Readonly<AutoRun>): Record<string, string | number | boolean> {
  return { issue: run.issue, number: run.number, kind: run.kind, proceed: run.proceed, reason: run.reason, branch: run.branch, pr: run.pr, ci_attempts: run.ciAttempts }
}

// 後の job が needs.<job>.outputs で読む値。理由・PR・回数はログの JSON にだけ出す
function setRunOutputs(run: Readonly<AutoRun>): void {
  setOutput('proceed', run.proceed)
  setOutput('kind', run.kind)
  setOutput('issue', run.issue)
  setOutput('number', run.number)
  setOutput('branch', run.branch)
}

async function gate(out: Output, input: Readonly<Input>): Promise<void> {
  const event = readEvent(out, input.event_path)
  const repository = repositoryOf(out, event)
  const config = requireAutoConfig(out, repository, input.project, PATH)
  const client = createGitHubClient(out, config.host)
  const decision = input.event_name === 'issues'
    ? await decideIssues(out, client, config, event)
    : await decideWorkflowRun(out, client, event, input.max_ci_attempts)
  const { write, run } = decision
  const target = { ...repository, number: run.number }
  if (write === undefined && !run.proceed) settle(out, { verb: 'skip', target: `automated fix${target.number > 0 ? ` for ${issueDisplay(target)}` : ''} (${run.reason})` })
  if (write !== undefined) await writeAutoResult(out, client, config, target, { result: write.result, next: write.next, branch: write.branch, ...write.text !== '' && { body: write.text } })
  out.data(JSON.stringify(runFields(run)))
  setRunOutputs(run)
}

/**
イベントから自動処理を進めるかを決め、outputs に出す。進めないときに結果のコメントが要るなら書く
*/
export async function runAutoGate(input: Readonly<Input>, io: CommandIo): Promise<number> {
  await gate(createOutput(false, io), input)
  return 0
}
