/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// auto start。スキルが最初に呼ぶ。ボードに載せるか待ちの値を戻し、続きに要る文脈を出す。
import { z } from 'zod'

import { autoContextOf, permissionCandidates } from '../domain/auto-context.js'
import { isLabelWrittenByAutomation, markerBranch, NO_BRANCH } from '../domain/auto-result.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import type { IssueFacts } from '../domain/readiness.js'
import type { IssueCommentRecord } from '../domain/review-finish.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { issueDisplay, readOrStop, requireAutoConfig, writersAmong } from './auto-shared.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, RUN_COLON } from './command-hint.js'
import { PROJECT_INPUT, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { addIssueToBoard, isStatusConfigured, setIssueField } from './issue-board.js'
import { readIssueSnapshotWithReadout } from './issue-readiness.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from './issue-shared.js'
import type { IssueTarget } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'

const PATH = ['auto', 'start']

const InputSchema = z.object({
  issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
  project: PROJECT_INPUT,
  dry_run: z.boolean().default(false).describe('Read the Issue and print the context without writing to the board'),
})

const ISSUE_JSON = z.strictObject({
  ref: z.string().describe('Issue (owner/repo/N)'),
  title: z.string().describe('Title of the Issue'),
  body: z.string().describe('Body of the Issue'),
})

const ANSWER_JSON = z.strictObject({
  author: z.string().describe('Login of the person who wrote it'),
  body: z.string().describe('Body of the comment'),
})

const OUTPUT = z.strictObject({
  issue: ISSUE_JSON.describe('The Issue'),
  plan: z.string().describe('Body of the last plan comment (starting with ## Plan) by the bot or by a person with write permission; empty when none'),
  results: z.array(z.string()).describe('Bodies of the result comments of earlier runs by the bot, oldest first'),
  answers: z.array(ANSWER_JSON).describe('Comments after the last result comment by people with write permission, oldest first'),
  withheld: z.int().describe('Number of comments whose body is not shown because the writer has no write permission'),
  branch: z.string().describe('Existing branch of the Issue; empty when none'),
  pr: z.int().describe('Existing open PR of that branch; 0 when none'),
})

type StartOutput = Output<z.input<typeof OUTPUT>>
type StartData = z.input<typeof OUTPUT>

// 待ちの値から戻す札。PR があれば In Progress、無ければ Todo
type RestoredStatus = 'todo' | 'in_progress'

function statusName(key: RestoredStatus): string {
  return key === 'todo' ? 'Todo' : 'In Progress'
}

function openPullRequestOf(facts: Readonly<IssueFacts>, branch: string): number {
  return facts.pullRequests.find(pullRequest => pullRequest.state === 'open' && pullRequest.headRefName === branch)?.number ?? 0
}

async function putOnBoard(out: StartOutput, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, isDryRun: boolean): Promise<void> {
  const display = issueDisplay(target)
  if (!isStatusConfigured(config, 'ready')) stopWith(out, hinted`the board has no option Ready for the column\n${RUN_COLON}${commandHint(['project', 'init'])}`, 'status-not-configured')
  const added: Operation = { verb: 'add', target: `${display} to the board in Ready` }
  if (isDryRun) {
    out.planned(added)
    return
  }
  try {
    const { itemId } = await addIssueToBoard(client, config, target.owner, target.repository, target.number, undefined)
    await setIssueField(client, config, itemId, 'workflow', 'ready')
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(out, `could not add ${display} to the board: ${error.message}`, kindOfFailure(error))
  }
  out.done(added)
}

async function restoreStatus(out: StartOutput, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, item: string, key: RestoredStatus, isDryRun: boolean): Promise<void> {
  const display = issueDisplay(target)
  const name = statusName(key)
  const optionId = getOptionId(config, 'status', key)
  if (optionId === undefined || optionId === '') stopWith(out, hinted`the board has no option ${name} for Status\n${RUN_COLON}${commandHint(['project', 'init'])}`, 'status-not-configured')
  const status: Operation = { verb: 'set', target: `Status of ${display} to ${name}` }
  if (isDryRun) {
    out.planned(status)
    return
  }
  try {
    await setIssueField(client, config, item, 'status', key)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(out, `could not set the Status of ${display} to ${name}: ${error.message}`, kindOfFailure(error))
  }
  out.done(status)
}

// ボードに無ければ Ready で載せ、自動処理が書いた Needs Attention なら戻す。どちらでもなければ何も書かない
async function settleBoard(out: StartOutput, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, facts: Readonly<IssueFacts>, comments: readonly IssueCommentRecord[], hasPullRequest: boolean, isDryRun: boolean): Promise<void> {
  const display = issueDisplay(target)
  const itemOf = async (): Promise<string | undefined> => await readOrStop(out, `the board item of ${display}`, async () => await client.getItemIdByIssue(config.project.id, target.owner, target.repository, target.number))
  if (facts.column === undefined && facts.label === undefined && await itemOf() === undefined) {
    await putOnBoard(out, client, config, target, isDryRun)
    return
  }
  if (!isLabelWrittenByAutomation(facts.label, comments)) return
  const item = await itemOf()
  if (item === undefined) return
  await restoreStatus(out, client, config, target, item, hasPullRequest ? 'in_progress' : 'todo', isDryRun)
}

async function start(out: StartOutput, input: Readonly<z.output<typeof InputSchema>>, globalRepository: string | undefined): Promise<void> {
  const target = parseIssueReferenceOrExit(out, globalRepository, input.issue_ref)
  const repository = { owner: target.owner, repository: target.repository }
  const config = requireAutoConfig(out, repository, input.project, PATH)
  const client = createGitHubClient(out, config.host)
  const display = issueDisplay(target)
  const read = await readOrStop(out, display, async () => await readIssueSnapshotWithReadout(client, config, { repository, number: target.number }))
  if (read.kind === 'unreadable') return stopWith(out, `could not read ${display}: ${read.reason}`, 'github-api')
  const { snapshot, issue } = read
  const comments = await readOrStop(out, `the comments of ${display}`, async () => await client.listIssueCommentRecords(target.owner, target.repository, target.number))
  const writers = await writersAmong(out, client, repository, permissionCandidates(comments, 'context'))
  const context = autoContextOf(comments, writers)
  const found = markerBranch(snapshot.target.branches, snapshot.target.pullRequests, target.number)
  const branch = found === NO_BRANCH ? '' : found
  const pr = openPullRequestOf(snapshot.target, branch)
  await settleBoard(out, client, config, target, snapshot.target, comments, pr > 0, input.dry_run)
  const data: StartData = {
    issue: { ref: issuePath(target.owner, target.repository, target.number), title: snapshot.title, body: issue.body },
    plan: context.plan,
    results: [...context.results],
    answers: context.answers.map(answer => ({ ...answer })),
    withheld: context.withheld,
    branch,
    pr,
  }
  if (context.withheld > 0) out.count('withheld comments', context.withheld)
  out.result(data)
  out.data(JSON.stringify(data))
}

const AUTO_START = defineCommand({
  path: PATH,
  title: 'Start automated fix',
  description: 'Start an automated fix run: restore the Status the automation wrote and print the context to continue',
  input: InputSchema,
  output: OUTPUT,
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<StartData>(input.dry_run, io)
    return await runWithExit(async () => {
      await start(out, input, input.repo)
    })
  },
})

export const AUTO_START_COMMANDS: readonly CommandDefinition[] = [AUTO_START]
