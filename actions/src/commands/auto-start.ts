/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// auto-start。AI の前の step。ボードに載せるか待ちの値を戻し、続きに要る文脈を JSON のファイルに書く。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { setOutput } from '@actions/core'
import { z } from 'zod'

import { autoContextOf, permissionCandidates } from '@pecot/workflow-core/domain/auto-context.js'
import { isLabelWrittenByAutomation, markerBranch, NO_BRANCH } from '@pecot/workflow-core/domain/auto-result.js'
import { getOptionId } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { decideStart } from '@pecot/workflow-core/domain/work-start.js'
import type { IssueSnapshot } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import type { IssueFacts } from '@pecot/workflow-core/domain/readiness.js'
import type { IssueCommentRecord } from '@pecot/workflow-core/domain/review-finish.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { issueDisplay, readOrStop, requireAutoConfig, writersAmong } from './auto-shared.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, RUN_COLON } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { boardFieldsHint } from '@pecot/workflow-core/commands-shared/project-sync.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { addIssueToBoard, isStatusConfigured, setIssueField } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createReadinessCache, judgeSnapshot, readIssueSnapshotWithReadout } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { linkIssueBranch } from '@pecot/workflow-core/commands-shared/link-branch.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'

const PATH = ['auto', 'start']

/**
文脈のファイルの置き場所。RUNNER_TEMP の下で、auto-finish が読む結果のファイルと同じディレクトリ
*/
export const AUTO_DIRECTORY = 'pecot-auto'
const CONTEXT_FILE = 'context.json'
// 末尾に Issue 番号を付けた名前でブランチを作る
const WORK_BRANCH_PREFIX = 'feat/auto'

export const AUTO_START_INPUT = z.object({
  issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
  project: PROJECT_INPUT,
})

type Input = z.output<typeof AUTO_START_INPUT>

interface StartContext {
  readonly issue: { readonly ref: string, readonly title: string, readonly body: string }
  readonly plan: string
  readonly results: readonly string[]
  readonly answers: readonly { readonly author: string, readonly body: string }[]
  readonly withheld: number
  readonly branch: string
  readonly base: string
  readonly pr: number
}

// 待ちの値から戻す札。PR があれば In Progress、無ければ Todo
type RestoredStatus = 'todo' | 'in_progress'

function statusName(key: RestoredStatus): string {
  return key === 'todo' ? 'Todo' : 'In Progress'
}

function openPullRequestOf(facts: Readonly<IssueFacts>, branch: string): number {
  return facts.pullRequests.find(pullRequest => pullRequest.state === 'open' && pullRequest.headRefName === branch)?.number ?? 0
}

async function putOnBoard(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>): Promise<void> {
  const display = issueDisplay(target)
  if (!isStatusConfigured(config, 'ready')) stopWith(out, hinted`the board has no option Ready for the column\n${RUN_COLON}${boardFieldsHint({ owner: config.owner, number: config.project.number })}`, 'status-not-configured')
  try {
    const { itemId } = await addIssueToBoard(client, config, target.owner, target.repository, target.number, undefined)
    await setIssueField(client, config, itemId, 'workflow', 'ready')
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(out, `could not add ${display} to the board: ${error.message}`, kindOfFailure(error))
  }
  out.done({ verb: 'add', target: `${display} to the board in Ready` })
}

async function restoreStatus(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, item: string, key: RestoredStatus): Promise<void> {
  const display = issueDisplay(target)
  const name = statusName(key)
  const optionId = getOptionId(config, 'status', key)
  if (optionId === undefined || optionId === '') stopWith(out, hinted`the board has no option ${name} for Status\n${RUN_COLON}${boardFieldsHint({ owner: config.owner, number: config.project.number })}`, 'status-not-configured')
  try {
    await setIssueField(client, config, item, 'status', key)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(out, `could not set the Status of ${display} to ${name}: ${error.message}`, kindOfFailure(error))
  }
  out.done({ verb: 'set', target: `Status of ${display} to ${name}` })
}

// ボードに無ければ Ready で載せ、自動処理が書いた Needs Attention なら戻す。どちらでもなければ何も書かない
async function settleBoard(out: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<IssueTarget>, facts: Readonly<IssueFacts>, comments: readonly IssueCommentRecord[], hasPullRequest: boolean): Promise<void> {
  const display = issueDisplay(target)
  const itemOf = async (): Promise<string | undefined> => await readOrStop(out, `the board item of ${display}`, async () => await client.getItemIdByIssue(config.project.id, target.owner, target.repository, target.number))
  if (facts.column === undefined && facts.label === undefined && await itemOf() === undefined) {
    await putOnBoard(out, client, config, target)
    return
  }
  if (!isLabelWrittenByAutomation(facts.label, comments)) return
  const item = await itemOf()
  if (item === undefined) return
  await restoreStatus(out, client, config, target, item, hasPullRequest ? 'in_progress' : 'todo')
}

function contextDirectory(out: Output): string {
  const temporary = process.env['RUNNER_TEMP']?.trim()
  return temporary === undefined || temporary === ''
    ? stopWith(out, 'RUNNER_TEMP is not set; run this action in a GitHub Actions job', 'invalid-input')
    : path.join(temporary, AUTO_DIRECTORY)
}

// 置き場所は runner の RUNNER_TEMP の下
function writeContext(directory: string, context: Readonly<StartContext>): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 上の置き場所
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, CONTEXT_FILE)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 上の置き場所
  writeFileSync(file, `${JSON.stringify(context, undefined, 2)}\n`, 'utf8')
  return file
}

/**
ブランチの無い Issue に、AI の前にブランチを作る。作る名前は feat/auto/<番号>。
base は、着手の判定がスタック先を選んだときはそのブランチ、そうでなければ開発ブランチ。
前提が済んでいないときと、開発ブランチが無いときは、作らずに止まる
*/
async function createWorkBranch(out: Output, client: GitHubClient, target: Readonly<IssueTarget>, snapshot: Readonly<IssueSnapshot>): Promise<{ readonly branch: string, readonly base: string }> {
  const display = issueDisplay(target)
  const result = await readOrStop(out, `the readiness of ${display}`, async () => await judgeSnapshot(client, snapshot, createReadinessCache()))
  if (result.kind === 'unreadable') return stopWith(out, `could not judge readiness of ${display}: ${result.reason}`, 'dependency-unreadable')
  const decision = decideStart(result.readiness, result.prerequisites, snapshot.ref)
  if (decision.kind === 'blocked') return stopWith(out, decision.message, 'not-ready')
  const base = decision.kind === 'stack' ? decision.branch : snapshot.developmentBranch
  if (base === undefined || base === '') return stopWith(out, hinted`develop_branch is not set for ${target.owner}/${target.repository}\n${RUN_COLON}${commandHint(['project', 'link'], { repo: `${target.owner}/${target.repository}`, develop_branch: 'develop' })}`, 'repo-setting-missing')
  try {
    const linked = await linkIssueBranch(client, { owner: target.owner, repository: target.repository, issue: target.number, branch: `${WORK_BRANCH_PREFIX}/${String(target.number)}`, base })
    out.done({ verb: 'create', target: `branch ${linked.branch} in ${target.owner}/${target.repository} from ${base}` })
    return { branch: linked.branch, base }
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not create the branch for ${display}: ${error.message}`, kindOfFailure(error))
  }
}

async function start(out: Output, input: Readonly<Input>): Promise<void> {
  const directory = contextDirectory(out)
  const target = parseIssueReferenceOrExit(out, undefined, input.issue_ref)
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
  // 既にあるブランチの base は分からないので、開発ブランチを渡す。PR があれば使わない
  const { branch, base } = found === NO_BRANCH ? await createWorkBranch(out, client, target, snapshot) : { branch: found, base: snapshot.developmentBranch ?? '' }
  const pr = openPullRequestOf(snapshot.target, branch)
  await settleBoard(out, client, config, target, snapshot.target, comments, pr > 0)
  if (context.withheld > 0) out.count('withheld comments', context.withheld)
  const file = writeContext(directory, {
    issue: { ref: issuePath(target.owner, target.repository, target.number), title: snapshot.title, body: issue.body },
    plan: context.plan,
    results: context.results,
    answers: context.answers,
    withheld: context.withheld,
    branch,
    base,
    pr,
  })
  setOutput('context-file', file)
}

/**
ボードの札を整え、続きに要る文脈を JSON のファイルに書いて、そのパスを outputs の context-file に出す
*/
export async function runAutoStart(input: Readonly<Input>, io: CommandIo): Promise<number> {
  const out = createOutput(false, io)
  return await runWithExit(async () => {
    await start(out, input)
  })
}
