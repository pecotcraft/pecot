/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue block / unblock。既存の Issue の前提（blocked by）と種類（stack / merge）を後から直し、判定・列・札・本文の節をそろえる。
import { z } from 'zod'

import { hasExpectedPrerequisites, decideBlock, decideUnblock, searchCycle } from '@pecot/workflow-core/domain/blocked-by-change.js'
import type { ExpectedPrerequisites } from '@pecot/workflow-core/domain/blocked-by-change.js'
import { decideBoardMove } from '@pecot/workflow-core/domain/board-move.js'
import type { BoardMoveInput, MissingValue } from '@pecot/workflow-core/domain/board-move.js'
import { getOptionId } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { BlockedByReference } from '@pecot/workflow-core/domain/issue-readout.js'
import { describeReadiness, displayReference, hasStarted } from '@pecot/workflow-core/domain/readiness.js'
import type { Wait } from '@pecot/workflow-core/domain/readiness.js'
import { createIssueReference, issueReferenceKey, issueReferenceToCliReference } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { MAX_BLOCKED_BY } from '@pecot/workflow-core/infra/github/issues.js'
import { defineCommand } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, inputHint, inputNameHint, joinHinted, RUN, surfaceText } from '@pecot/workflow-core/commands-shared/command-hint.js'
import type { HintedText } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { apiFailureMessage, createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { applyBoardMove, BOARD_MOVE_JSON, moveJson } from '@pecot/workflow-core/commands-shared/issue-board.js'
import type { BoardMoveLine } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { createReadinessCache, readIssueReadiness } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import type { JudgedIssue } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import { ensureRepositoryInProject, ISSUE_REF_DESCRIPTION, parseIssueReferenceOrExit, runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import type { IssueTarget } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const CONTENT_EXIT_CODE = 3
// たどる Issue の数の上限。大きな連鎖で止まらないことより、確かめずに付けないことを優先する
const MAX_CYCLE_ISSUES = 200
const BLOCK_PATH = ['issue', 'block']
const UNBLOCK_PATH = ['issue', 'unblock']

const ISSUE_FIELD = z.string().describe('The waiting Issue (owner/repo/N)')
const BY_FIELD = z.string().describe('The prerequisite Issue (owner/repo/N)')
const MOVES_FIELD = z.array(BOARD_MOVE_JSON).describe('The waiting Issue when its column or Status was written (at most one; empty when nothing was written)')

const ISSUE_BLOCK_OUTPUT = z.strictObject({
  issue: ISSUE_FIELD,
  by: BY_FIELD,
  wait: z.enum(['stack', 'merge']).describe('Wait kind of the blocked-by after the command'),
  change: z.enum(['added', 'updated', 'unchanged']).describe('added (new blocked-by), updated (wait kind or reason changed), or unchanged'),
  moves: MOVES_FIELD,
})

const ISSUE_UNBLOCK_OUTPUT = z.strictObject({
  issue: ISSUE_FIELD,
  by: BY_FIELD,
  change: z.enum(['removed', 'unchanged']).describe('removed, or unchanged when it was not a blocked-by'),
  moves: MOVES_FIELD,
})

type BlockOutput = Output<z.input<typeof ISSUE_BLOCK_OUTPUT>>
type UnblockOutput = Output<z.input<typeof ISSUE_UNBLOCK_OUTPUT>>

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

async function wrapped<T>(out: Output, context: string | HintedText, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error: unknown) {
    return stopWith(out, hinted`${context}: ${apiFailureMessage(error)}`, kindOfFailure(error))
  }
}

function isOptionAvailable(config: ProjectConfig, field: string, key: string): boolean {
  const option = getOptionId(config, field, key)
  return option !== undefined && option !== ''
}

function hintFor(value: MissingValue): HintedText {
  return hinted`hint: ${RUN} ${commandHint(['project', 'init'])} to add the ${value} option to the board`
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
    labelWrittenByAutomation: judged.labelWrittenByAutomation,
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
    const result = await readIssueReadiness(context.client, context.config, context.target, createReadinessCache(), undefined, undefined, true)
    if (result.kind === 'unreadable') return { failure: `could not judge readiness of ${name}: ${result.reason}` }
    if (hasExpectedPrerequisites(result.prerequisites, expected)) return { judged: result }
  }
  return { failure: `could not confirm that GitHub reflects the blocked-by change of ${name}` }
}

// 書いた後の判定で、列と札を動かし、書けた列と札を返す。読めない・確かめられないときは動かさず warning にする（前提の変更は済んでいる）
async function moveBoard(context: Context, expected: ExpectedPrerequisites, hasPrerequisites: boolean): Promise<BoardMoveLine | undefined> {
  const { out, client, config, home, target } = context
  const name = displayReference(target, home)
  const read = await readConfirmed(context, expected)
  if ('failure' in read) {
    out.warning(`${read.failure}; the column and label of ${name} were not moved`)
    return undefined
  }
  const { judged } = read
  if (judged.readiness === undefined) return undefined
  const move = decideBoardMove(boardMoveInput(judged, config, hasPrerequisites))
  if (move === undefined) return undefined
  const hasWrite = move.column !== undefined || move.label !== undefined
  let itemId = ''
  try {
    if (hasWrite) itemId = await client.getItemIdByIssue(config.project.id, target.repository.owner, target.repository.repository, target.number) ?? ''
  }
  catch (error: unknown) {
    out.warning(`could not move ${name}: ${apiFailureMessage(error)}`)
    return undefined
  }
  if (hasWrite && itemId === '') return undefined
  const { missing, written } = await applyBoardMove(out, client, config, itemId, { ref: target, home }, move, describeReadiness(judged.readiness, judged.prerequisites, home))
  for (const value of missing) {
    out.warning(joinHinted([`the ${value} option is not on the board, so ${name} was not moved`, hintFor(value)]))
  }
  return written
}

function movesOf(written: BoardMoveLine | undefined): z.input<typeof BOARD_MOVE_JSON>[] {
  return written === undefined ? [] : [moveJson(written)]
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
  readonly project?: string | undefined
  readonly repo?: string | undefined
}

function checkBlockUsage(out: Output, input: BlockInput, target: IssueReference, by: IssueReference): string | undefined {
  const reason = input.reason?.trim()
  const reasonFlag = inputNameHint(BLOCK_PATH, 'reason')
  const waitMerge = inputHint(BLOCK_PATH, 'wait', 'merge')
  if (input.wait === 'merge' && (reason === undefined || reason === '')) stopWith(out, hinted`${reasonFlag} is required with ${waitMerge}`, 'invalid-input', USAGE_EXIT_CODE)
  if (input.wait === 'stack' && input.reason !== undefined) stopWith(out, hinted`${reasonFlag} is only valid with ${waitMerge}`, 'invalid-input', USAGE_EXIT_CODE)
  if (reason !== undefined && /[\r\n]/u.test(reason)) stopWith(out, hinted`${reasonFlag} must be a single line`, 'invalid-input', USAGE_EXIT_CODE)
  if (issueReferenceKey(target) === issueReferenceKey(by)) {
    const name = displayReference(target, target.repository)
    stopWith(out, `blocked-by would form a cycle: ${name} -> ${name}`, 'dependency-rejected', USAGE_EXIT_CODE)
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
  if (result.kind === 'cycle') stopWith(out, `blocked-by would form a cycle: ${result.path.map(reference => displayReference(reference, home)).join(' -> ')}`, 'dependency-rejected', USAGE_EXIT_CODE)
  else if (result.kind === 'unverifiable') stopWith(out, `could not check blocked-by cycle of ${displayReference(target, home)}: ${result.reason}`, 'dependency-unreadable')
}

async function runBlock(out: BlockOutput, input: BlockInput): Promise<void> {
  const targetIssue = parseIssueReferenceOrExit(out, input.repo, input.issue_ref)
  const byIssue = parseIssueReferenceOrExit(out, input.repo, input.by)
  const { config } = requireConfigFor(out, targetIssue, input.project, BLOCK_PATH)
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
  if (read.blockedBy.kind === 'read-failed') stopWith(out, `could not read blocked-by of ${name}: ${read.blockedBy.reason}`, 'dependency-unreadable')
  const { issues, total } = read.blockedBy
  const linked = issues.find(issue => issueReferenceKey({ repository: issue.repository, number: issue.number }) === issueReferenceKey(by))
  if (linked === undefined && total >= MAX_BLOCKED_BY) stopWith(out, `${name} already has ${String(MAX_BLOCKED_BY)} blocked-by issues`, 'dependency-rejected')

  const decision = decideBlock({ body: read.body, home, by, wait: input.wait, reason, isLinked: linked !== undefined })
  const result: Omit<z.input<typeof ISSUE_BLOCK_OUTPUT>, 'change' | 'moves'> = { issue: issueReferenceToCliReference(target), by: issueReferenceToCliReference(by), wait: input.wait }
  if (decision.kind === 'malformed') {
    stopWith(out, hinted`Waits for merge of ${name} is malformed: ${decision.reason}; fix the section in the Issue body and ${surfaceText('run the command again', 'call the tool again')}`, 'content-invalid', CONTENT_EXIT_CODE)
  }
  else if (decision.kind === 'unchanged') {
    out.result({ ...result, change: 'unchanged', moves: [] })
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
  const change = decision.kind === 'add' ? 'added' : 'updated'
  if (input.dry_run) {
    out.result({ ...result, change })
    return
  }

  if (byId !== undefined && decision.kind === 'add') {
    const blockingId = byId
    await wrapped(out, `could not add blocked-by ${byName} to ${name}`, async () => {
      await client.addBlockedBy(read.id, blockingId)
    })
    out.done(operation)
  }
  if (decision.body !== read.body) {
    const message = hinted`could not update the body of ${name}${decision.kind === 'add' ? hinted`; blocked-by ${byName} was added, ${surfaceText('run the command again', 'call the tool again')} to write the section` : ''}`
    await wrapped(out, message, async () => {
      await client.updateIssueBody(targetIssue.owner, targetIssue.repository, targetIssue.number, decision.body)
    })
  }
  if (decision.kind === 'update') out.done(operation)
  out.result({ ...result, change })

  const keys = new Set([...keysOf(issues), issueReferenceKey(by)])
  const written = await moveBoard(context, { keys, by, wait: { wait: input.wait, reason } }, true)
  out.result({ moves: movesOf(written) })
}

interface UnblockInput {
  readonly issue_ref: string
  readonly by: string
  readonly dry_run: boolean
  readonly project?: string | undefined
  readonly repo?: string | undefined
}

async function runUnblock(out: UnblockOutput, input: UnblockInput): Promise<void> {
  const targetIssue = parseIssueReferenceOrExit(out, input.repo, input.issue_ref)
  const byIssue = parseIssueReferenceOrExit(out, input.repo, input.by)
  const { config } = requireConfigFor(out, targetIssue, input.project, UNBLOCK_PATH)
  const target = toReference(targetIssue)
  const by = toReference(byIssue)

  const client = createGitHubClient(out, config.host)
  await ensureLinked(out, config, client, targetIssue)
  const home = target.repository
  const context: Context = { out, client, config, home, target, by }
  const name = displayReference(target, home)
  const byName = displayReference(by, home)

  const read = await wrapped(out, `could not read blocked-by of ${name}`, async () => await client.getIssueBlockedByReferences(targetIssue.owner, targetIssue.repository, targetIssue.number))
  if (read.blockedBy.kind === 'read-failed') stopWith(out, `could not read blocked-by of ${name}: ${read.blockedBy.reason}`, 'dependency-unreadable')
  const { issues, total } = read.blockedBy
  const linked = issues.find(issue => issueReferenceKey({ repository: issue.repository, number: issue.number }) === issueReferenceKey(by))
  if (linked === undefined && total > issues.length) stopWith(out, `could not read blocked-by of ${name}: ${String(issues.length)} of ${String(total)} issues were read`, 'dependency-unreadable')

  const decision = decideUnblock({ body: read.body, home, by, isLinked: linked !== undefined })
  const result: Omit<z.input<typeof ISSUE_UNBLOCK_OUTPUT>, 'change' | 'moves'> = { issue: issueReferenceToCliReference(target), by: issueReferenceToCliReference(by) }
  if (linked === undefined || decision.kind === 'unchanged') {
    out.result({ ...result, change: 'unchanged', moves: [] })
    out.planned({ verb: 'unchanged', target: `${name} is not blocked by ${byName}` })
    out.done({ verb: 'unchanged', target: `${name} is not blocked by ${byName}` })
    return
  }
  const operation: Operation = { verb: 'remove', target: `blocked-by ${byName} from ${name}` }
  out.planned(operation)
  if (input.dry_run) {
    out.result({ ...result, change: 'removed' })
    return
  }

  await wrapped(out, `could not remove blocked-by ${byName} from ${name}`, async () => {
    await client.removeBlockedBy(read.id, linked.id)
  })
  out.done(operation)
  out.result({ ...result, change: 'removed' })
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
  const written = await moveBoard(context, { keys: keysOf(remaining), by, wait: undefined }, hasPrerequisites)
  out.result({ moves: movesOf(written) })
}

const ISSUE_BLOCK = defineCommand({
  path: BLOCK_PATH,
  title: 'Set Issue blocker',
  description: 'Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one',
  input: z.object({
    issue_ref: z.string().describe(`The waiting Issue. ${ISSUE_REF_DESCRIPTION}`),
    by: z.string().describe('The Issue to wait for (`owner/repo/N`; another repository is allowed)'),
    wait: z.enum(['stack', 'merge']).default('stack').describe('stack (build on its branch) or merge (wait until it is merged)'),
    reason: z.string().optional().describe('Why it waits for the merge (required when `wait` is merge)'),
    project: PROJECT_INPUT,
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  output: ISSUE_BLOCK_OUTPUT,
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof ISSUE_BLOCK_OUTPUT>>(input.dry_run, io)
    return await runWithExit(async () => {
      await runBlock(out, input)
    })
  },
})

const ISSUE_UNBLOCK = defineCommand({
  path: UNBLOCK_PATH,
  title: 'Remove Issue blocker',
  description: 'Remove a blocked-by (prerequisite) from an Issue',
  input: z.object({
    issue_ref: z.string().describe(`The waiting Issue. ${ISSUE_REF_DESCRIPTION}`),
    by: z.string().describe('The prerequisite Issue to remove (`owner/repo/N`; another repository is allowed)'),
    project: PROJECT_INPUT,
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  output: ISSUE_UNBLOCK_OUTPUT,
  positional: ['issue_ref'],
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof ISSUE_UNBLOCK_OUTPUT>>(input.dry_run, io)
    return await runWithExit(async () => {
      await runUnblock(out, input)
    })
  },
})

export const ISSUE_DEPENDENCY_COMMANDS: readonly CommandDefinition[] = [ISSUE_BLOCK, ISSUE_UNBLOCK]
