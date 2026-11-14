/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue block / unblock。既存の Issue の前提（blocked by）と種類（stack / merge）を後から直し、判定・列・札・本文の節をそろえる。
import { z } from 'zod'

import { hasExpectedPrerequisites, decideBlock, decideUnblock, searchCycle } from '../domain/blocked-by-change.js'
import type { ExpectedPrerequisites } from '../domain/blocked-by-change.js'
import { decideBoardMove } from '../domain/board-move.js'
import type { BoardMoveInput, MissingValue } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import type { BlockedByReference } from '../domain/issue-readout.js'
import { describeReadiness, displayReference, hasStarted } from '../domain/readiness.js'
import type { Wait } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { GitHubClient } from '../infra/github/index.js'
import { MAX_BLOCKED_BY } from '../infra/github/issues.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, inputHint, inputNameHint, joinHinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { apiFailureMessage, createGitHubClient } from './github-client.js'
import { applyBoardMove } from './issue-board.js'
import { createReadinessCache, readIssueReadiness } from './issue-readiness.js'
import type { JudgedIssue } from './issue-readiness.js'
import { ensureRepositoryInProject, ISSUE_REF_DESCRIPTION, parseIssueReferenceOrExit, runWithExit } from './issue-shared.js'
import type { IssueTarget } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const CONTENT_EXIT_CODE = 3
// たどる Issue の数の上限。大きな連鎖で止まらないことより、確かめずに付けないことを優先する
const MAX_CYCLE_ISSUES = 200
const BLOCK_PATH = ['issue', 'block']

interface Context {
  readonly out: Output
  readonly client: GitHubClient
  readonly config: ProjectConfig
  readonly home: RepositoryReference
  readonly target: IssueReference
  readonly by: IssueReference
}

function toReference(target: IssueTarget): IssueReference {
  return createIssueReference(createRepositoryReference(target.owner, target.repository), target.number)
}

async function ensureLinked(out: Output, config: ProjectConfig, client: GitHubClient, { owner, repository }: IssueTarget): Promise<void> {
  await ensureRepositoryInProject(out, config, client, owner, repository, `repository ${owner}/${repository} is not in the project`)
}

async function wrapped<T>(out: Output, context: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error: unknown) {
    return stopWith(out, `${context}: ${apiFailureMessage(error)}`)
  }
}

function isOptionAvailable(config: ProjectConfig, field: string, key: string): boolean {
  const option = getOptionId(config, field, key)
  return option !== undefined && option !== ''
}

function hintFor(value: MissingValue): HintedText {
  return hinted`hint: run ${commandHint(['project', 'init'])} to add the ${value} option to the board`
}

function boardMoveInput(judged: JudgedIssue, config: ProjectConfig, hasPrerequisites: boolean): BoardMoveInput {
  const { target } = judged
  return {
    eligible: target.state === 'open' && target.kind === 'task',
    column: target.column,
    label: target.label,
    hasStarted: hasStarted(target),
    hasPrerequisites,
    readiness: judged.readiness,
    // spec 023 が入るまで、札はこの機能が書いたものとして扱う
    labelWrittenByAutomation: false,
    available: {
      blocked: isOptionAvailable(config, 'workflow', 'blocked'),
      needsAttention: isOptionAvailable(config, 'status', 'needs_attention'),
      todo: isOptionAvailable(config, 'status', 'todo'),
    },
  }
}

// 書いた内容が読み直しに出るまで 1 回だけ読み直す。GitHub は書いた直後の読み取りの一致を保証しない
async function readConfirmed(context: Context, expected: ExpectedPrerequisites): Promise<{ readonly judged: JudgedIssue } | { readonly failure: string }> {
  const name = displayReference(context.target, context.home)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await readIssueReadiness(context.client, context.config, context.target, createReadinessCache())
    if (result.kind === 'unreadable') return { failure: `could not judge readiness of ${name}: ${result.reason}` }
    if (hasExpectedPrerequisites(result.prerequisites, expected)) return { judged: result }
  }
  return { failure: `could not confirm that GitHub reflects the blocked-by change of ${name}` }
}

// 書いた後の判定で、列と札を動かす。読めない・確かめられないときは動かさず warning にする（前提の変更は済んでいる）
async function moveBoard(context: Context, expected: ExpectedPrerequisites, hasPrerequisites: boolean): Promise<void> {
  const { out, client, config, home, target } = context
  const name = displayReference(target, home)
  const read = await readConfirmed(context, expected)
  if ('failure' in read) {
    out.warning(`${read.failure}; the column and label of ${name} were not moved`)
    return
  }
  const { judged } = read
  if (judged.readiness === undefined) return
  const move = decideBoardMove(boardMoveInput(judged, config, hasPrerequisites))
  if (move === undefined) return
  const hasWrite = move.column !== undefined || move.label !== undefined
  let itemId = ''
  try {
    if (hasWrite) itemId = await client.getItemIdByIssue(config.project.id, target.repository.owner, target.repository.repository, target.number) ?? ''
  }
  catch (error: unknown) {
    out.warning(`could not move ${name}: ${apiFailureMessage(error)}`)
    return
  }
  if (hasWrite && itemId === '') return
  const { missing } = await applyBoardMove(out, client, config, itemId, { ref: target, home }, move, describeReadiness(judged.readiness, judged.prerequisites, home))
  for (const value of missing) {
    out.warning(joinHinted([`the ${value} option is not on the board, so ${name} was not moved`, hintFor(value)]))
  }
}

function keysOf(issues: readonly BlockedByReference[]): ReadonlySet<string> {
  return new Set(issues.map(issue => issueReferenceKey({ repository: issue.repository, number: issue.number })))
}

interface BlockInput {
  readonly issue_ref: string
  readonly by: string
  readonly wait: Wait
  readonly reason?: string | undefined
  readonly dry_run: boolean
  readonly repo?: string | undefined
}

function checkBlockUsage(out: Output, input: BlockInput, target: IssueReference, by: IssueReference): string | undefined {
  const reason = input.reason?.trim()
  const reasonFlag = inputNameHint(BLOCK_PATH, 'reason')
  const waitMerge = inputHint(BLOCK_PATH, 'wait', 'merge')
  if (input.wait === 'merge' && (reason === undefined || reason === '')) stopWith(out, hinted`${reasonFlag} is required with ${waitMerge}`, USAGE_EXIT_CODE)
  if (input.wait === 'stack' && input.reason !== undefined) stopWith(out, hinted`${reasonFlag} is only valid with ${waitMerge}`, USAGE_EXIT_CODE)
  if (reason !== undefined && /[\r\n]/u.test(reason)) stopWith(out, hinted`${reasonFlag} must be a single line`, USAGE_EXIT_CODE)
  if (issueReferenceKey(target) === issueReferenceKey(by)) {
    const name = displayReference(target, target.repository)
    stopWith(out, `blocked-by would form a cycle: ${name} -> ${name}`, USAGE_EXIT_CODE)
  }
  return reason
}

async function checkNoCycle(context: Context, byId: string): Promise<void> {
  const { out, client, target, home } = context
  const result = await wrapped(out, `could not check blocked-by cycle of ${displayReference(target, home)}`, async () => await searchCycle({
    target,
    by: context.by,
    byId,
    read: async ids => await client.getBlockedByOfNodes(ids),
    limit: MAX_CYCLE_ISSUES,
  }))
  if (result.kind === 'cycle') stopWith(out, `blocked-by would form a cycle: ${result.path.map(reference => displayReference(reference, home)).join(' -> ')}`, USAGE_EXIT_CODE)
  else if (result.kind === 'unverifiable') stopWith(out, `could not check blocked-by cycle of ${displayReference(target, home)}: ${result.reason}`)
}

async function runBlock(out: Output, input: BlockInput): Promise<void> {
  const config = requireActiveConfigPlain(out)
  const targetIssue = parseIssueReferenceOrExit(out, input.repo, input.issue_ref)
  const byIssue = parseIssueReferenceOrExit(out, input.repo, input.by)
  const target = toReference(targetIssue)
  const by = toReference(byIssue)
  const reason = checkBlockUsage(out, input, target, by)

  const client = createGitHubClient(out, config.host)
  await ensureLinked(out, config, client, targetIssue)
  const home = target.repository
  const context: Context = { out, client, config, home, target, by }
  const name = displayReference(target, home)
  const byName = displayReference(by, home)

  const read = await wrapped(out, `could not read blocked-by of ${name}`, async () => await client.getIssueBlockedByReferences(targetIssue.owner, targetIssue.repository, targetIssue.number))
  if (read.blockedBy.kind === 'read-failed') stopWith(out, `could not read blocked-by of ${name}: ${read.blockedBy.reason}`)
  const { issues, total } = read.blockedBy
  const linked = issues.find(issue => issueReferenceKey({ repository: issue.repository, number: issue.number }) === issueReferenceKey(by))
  if (linked === undefined && total >= MAX_BLOCKED_BY) stopWith(out, `${name} already has ${String(MAX_BLOCKED_BY)} blocked-by issues`)

  const decision = decideBlock({ body: read.body, home, by, wait: input.wait, reason, isLinked: linked !== undefined })
  if (decision.kind === 'malformed') {
    stopWith(out, `Waits for merge of ${name} is malformed: ${decision.reason}; fix the section in the Issue body and run the command again`, CONTENT_EXIT_CODE)
  }
  else if (decision.kind === 'unchanged') {
    out.planned({ verb: 'unchanged', target: `blocked-by ${byName} on ${name}` })
    out.done({ verb: 'unchanged', target: `blocked-by ${byName} on ${name}` })
    return
  }

  let byId = linked?.id
  if (decision.kind === 'add') {
    byId = await wrapped(out, `could not read ${displayReference(by, home)}`, async () => await client.getIssueNodeId(byIssue.owner, byIssue.repository, byIssue.number))
    await checkNoCycle(context, byId)
  }
  const operation: Operation = decision.kind === 'add'
    ? { verb: 'add', target: `blocked-by ${byName} to ${name}` }
    : { verb: 'update', target: `blocked-by ${byName} on ${name} (wait: ${input.wait})` }
  out.planned(operation)
  if (input.dry_run) return

  if (byId !== undefined && decision.kind === 'add') {
    const blockingId = byId
    await wrapped(out, `could not add blocked-by ${byName} to ${name}`, async () => {
      await client.addBlockedBy(read.id, blockingId)
    })
    out.done(operation)
  }
  if (decision.body !== read.body) {
    const message = `could not update the body of ${name}${decision.kind === 'add' ? `; blocked-by ${byName} was added, run the command again to write the section` : ''}`
    await wrapped(out, message, async () => {
      await client.updateIssueBody(targetIssue.owner, targetIssue.repository, targetIssue.number, decision.body)
    })
  }
  if (decision.kind === 'update') out.done(operation)

  const keys = new Set([...keysOf(issues), issueReferenceKey(by)])
  await moveBoard(context, { keys, by, wait: { wait: input.wait, reason } }, true)
}

interface UnblockInput {
  readonly issue_ref: string
  readonly by: string
  readonly dry_run: boolean
  readonly repo?: string | undefined
}

async function runUnblock(out: Output, input: UnblockInput): Promise<void> {
  const config = requireActiveConfigPlain(out)
  const targetIssue = parseIssueReferenceOrExit(out, input.repo, input.issue_ref)
  const byIssue = parseIssueReferenceOrExit(out, input.repo, input.by)
  const target = toReference(targetIssue)
  const by = toReference(byIssue)

  const client = createGitHubClient(out, config.host)
  await ensureLinked(out, config, client, targetIssue)
  const home = target.repository
  const context: Context = { out, client, config, home, target, by }
  const name = displayReference(target, home)
  const byName = displayReference(by, home)

  const read = await wrapped(out, `could not read blocked-by of ${name}`, async () => await client.getIssueBlockedByReferences(targetIssue.owner, targetIssue.repository, targetIssue.number))
  if (read.blockedBy.kind === 'read-failed') stopWith(out, `could not read blocked-by of ${name}: ${read.blockedBy.reason}`)
  const { issues, total } = read.blockedBy
  const linked = issues.find(issue => issueReferenceKey({ repository: issue.repository, number: issue.number }) === issueReferenceKey(by))
  if (linked === undefined && total > issues.length) stopWith(out, `could not read blocked-by of ${name}: ${String(issues.length)} of ${String(total)} issues were read`)

  const decision = decideUnblock({ body: read.body, home, by, isLinked: linked !== undefined })
  if (linked === undefined || decision.kind === 'unchanged') {
    out.planned({ verb: 'unchanged', target: `${name} is not blocked by ${byName}` })
    out.done({ verb: 'unchanged', target: `${name} is not blocked by ${byName}` })
    return
  }
  const operation: Operation = { verb: 'remove', target: `blocked-by ${byName} from ${name}` }
  out.planned(operation)
  if (input.dry_run) return

  await wrapped(out, `could not remove blocked-by ${byName} from ${name}`, async () => {
    await client.removeBlockedBy(read.id, linked.id)
  })
  out.done(operation)
  if (decision.malformedReason !== undefined) {
    out.warning(`Waits for merge of ${name} is malformed: ${decision.malformedReason}; the section was not changed`)
  }
  else if (decision.body !== read.body) {
    await wrapped(out, `could not update the body of ${name}; blocked-by ${byName} was removed`, async () => {
      await client.updateIssueBody(targetIssue.owner, targetIssue.repository, targetIssue.number, decision.body)
    })
  }

  const remaining = issues.filter(issue => issue.id !== linked.id)
  // 人が別の理由で付けた札を、最後の前提を外しただけで戻さない
  const hasPrerequisites = remaining.length > 0 || linked.state === 'CLOSED'
  await moveBoard(context, { keys: keysOf(remaining), by, wait: undefined }, hasPrerequisites)
}

const ISSUE_BLOCK = defineCommand({
  path: BLOCK_PATH,
  description: 'Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one',
  input: z.object({
    issue_ref: z.string().describe(`The waiting Issue. ${ISSUE_REF_DESCRIPTION}`),
    by: z.string().describe('The Issue to wait for (`owner/repo/N`; another repository is allowed)'),
    wait: z.enum(['stack', 'merge']).default('stack').describe('stack (build on its branch) or merge (wait until it is merged)'),
    reason: z.string().optional().describe('Why it waits for the merge (required with --wait merge)'),
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(input.dry_run, io)
    return await runWithExit(async () => {
      await runBlock(out, input)
    })
  },
})

const ISSUE_UNBLOCK = defineCommand({
  path: ['issue', 'unblock'],
  description: 'Remove a blocked-by (prerequisite) from an Issue',
  input: z.object({
    issue_ref: z.string().describe(`The waiting Issue. ${ISSUE_REF_DESCRIPTION}`),
    by: z.string().describe('The prerequisite Issue to remove (`owner/repo/N`; another repository is allowed)'),
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(input.dry_run, io)
    return await runWithExit(async () => {
      await runUnblock(out, input)
    })
  },
})

export const ISSUE_DEPENDENCY_COMMANDS: readonly CommandDefinition[] = [ISSUE_BLOCK, ISSUE_UNBLOCK]
