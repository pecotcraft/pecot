/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// pr merge。単独の PR もスタックの PR も、非同期のマージ API（merge-async）でマージする。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '../infra/github/errors.js'
import type { AsyncMergeResult, PullRequestForMerge } from '../infra/github/pulls.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Output } from './output.js'
import { parseReference, PR_REFERENCE_DESCRIPTION } from './pr-reference.js'

// 要求を送らずに止める（ドラフト、スタックの最下段でない）
const NOT_MERGEABLE_EXIT_CODE = 2
const POLL_INTERVAL_MILLISECONDS = 2000
// R14 では 3〜8 秒で終わった。時刻でなく回数で数え、偽のタイマーでも同じに動かす
const POLL_LIMIT = 30
const POLL_LIMIT_SECONDS = (POLL_INTERVAL_MILLISECONDS * POLL_LIMIT) / 1000

const MergeInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  dry_run: z.boolean().default(false).describe('Read the PR and its stack, and show what would happen without merging'),
})

const PR_MERGE_OUTPUT = z.strictObject({
  pullRequest: z.string().describe('PR (owner/repo/N)'),
  base: z.string().describe('Base branch the PR is merged into'),
  status: z.enum(['merged', 'enqueued']).optional().describe('merged, or enqueued when the PR was added to the merge queue (absent on dry_run)'),
  stack: z.strictObject({
    number: z.int().describe('Stack number'),
    size: z.int().describe('Number of PRs in the stack from this PR upward (K of "1 of K")'),
  }).optional().describe('Stack the PR is the bottom of (absent for a PR outside a stack)'),
  dryRun: DRY_RUN_FIELD,
})

type PrMergeData = z.input<typeof PR_MERGE_OUTPUT>

interface Target {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

interface MergeContext {
  readonly out: Output<PrMergeData>
  readonly client: GitHubClient
  readonly target: Target
  readonly name: string
  readonly base: string
  readonly suffix: string
}

function pathOf(target: Readonly<Target>): string {
  return `${target.owner}/${target.repository}/${String(target.number)}`
}

async function readPullRequest(out: Readonly<Output<PrMergeData>>, client: GitHubClient, target: Readonly<Target>): Promise<PullRequestForMerge> {
  try {
    return await client.getPullRequestForMerge(target.owner, target.repository, target.number)
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return stopWith(out, `PR not found: ${pathOf(target)}`, 'github-not-found')
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read PR ${pathOf(target)}: ${describeApiError(error)}`, kindOfFailure(error))
  }
}

// 下の段に open の PR があれば止める。マージ済みで並びに残る PR は飛ばす。スタックの機能が無いリポは単独の PR として扱う
async function bottomOfStack(out: Readonly<Output<PrMergeData>>, client: GitHubClient, target: Readonly<Target>): Promise<PrMergeData['stack']> {
  let stack
  try {
    stack = await client.getStackOfPullRequest(target.owner, target.repository, target.number)
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return undefined
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read the stack of PR ${pathOf(target)}: ${describeApiError(error)}`, kindOfFailure(error))
  }
  if (stack === undefined) return undefined
  const index = stack.pullRequests.indexOf(target.number)
  for (const lower of stack.pullRequests.slice(0, index)) {
    const pullRequest = await readPullRequest(out, client, { ...target, number: lower })
    if (pullRequest.state === 'OPEN') {
      stopWith(out, `PR #${String(target.number)} is not the bottom of stack #${String(stack.number)}. Merge PR #${String(lower)} first`, 'pr-state', NOT_MERGEABLE_EXIT_CODE)
    }
  }
  return { number: stack.number, size: stack.pullRequests.length - index }
}

function finishMerged(context: Readonly<MergeContext>): 0 {
  context.out.done({ verb: 'merge', target: `${context.name} into ${context.base}${context.suffix}` })
  context.out.result({ status: 'merged' })
  return 0
}

function finishEnqueued(context: Readonly<MergeContext>): 0 {
  context.out.done({ verb: 'add', target: `${context.name} to merge queue of ${context.base}` })
  context.out.result({ status: 'enqueued' })
  return 0
}

function finishResult(context: Readonly<MergeContext>, result: Readonly<AsyncMergeResult>): 0 {
  if (result.status === 'merged') return finishMerged(context)
  if (result.status === 'enqueued') return finishEnqueued(context)
  return stopWith(context.out, `merge was rejected: ${result.message ?? 'GitHub gave no reason'}`, 'pr-state')
}

// 結果を読めないときは、PR の状態から決める
async function finishFromState(context: Readonly<MergeContext>): Promise<0> {
  const pullRequest = await readPullRequest(context.out, context.client, context.target)
  if (pullRequest.state === 'MERGED') return finishMerged(context)
  if (pullRequest.isInMergeQueue) return finishEnqueued(context)
  return stopWith(context.out, `could not confirm the merge of ${context.name}: it is neither merged nor in the merge queue`, 'pr-state')
}

async function pollResult(context: Readonly<MergeContext>, uuid: string): Promise<0> {
  const { owner, repository, number } = context.target
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    await delay(POLL_INTERVAL_MILLISECONDS)
    let result
    try {
      result = await context.client.getAsyncMergeResult(owner, repository, number, uuid)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(context.out, `could not read the merge result of PR ${pathOf(context.target)}: ${describeApiError(error)}`, kindOfFailure(error))
    }
    if (result === undefined) return finishFromState(context)
    if (result.status !== 'pending') return finishResult(context, result)
  }
  return stopWith(context.out, `merge did not finish in ${String(POLL_LIMIT_SECONDS)}s. Check ${context.name}`, 'github-api')
}

async function requestMerge(context: Readonly<MergeContext>, pullRequest: Readonly<PullRequestForMerge>): Promise<0> {
  const { owner, repository, number } = context.target
  let requested
  try {
    requested = await context.client.requestAsyncMerge(owner, repository, number, { sha: pullRequest.headRefOid, mergeQueue: pullRequest.isMergeQueueEnabled })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(context.out, `could not merge PR ${pathOf(context.target)}: ${describeApiError(error)}`, kindOfFailure(error))
  }
  switch (requested.outcome) {
    case 'rejected': { return stopWith(context.out, `merge was rejected: ${requested.message}`, 'pr-state') }
    // 文書は 409 の本文の形を示していない。uuid が無ければ PR の状態から決める
    case 'conflict': { return requested.uuid === undefined ? finishFromState(context) : pollResult(context, requested.uuid) }
    case 'accepted': {
      const { result } = requested
      return result.status === 'pending' && result.uuid !== undefined ? pollResult(context, result.uuid) : finishResult(context, result)
    }
  }
}

export const PR_MERGE_COMMAND: CommandDefinition = defineCommand({
  path: ['pr', 'merge'],
  description: 'Merge a PR with the asynchronous merge API (a PR in a stack must be the bottom one)',
  input: MergeInputSchema,
  output: PR_MERGE_OUTPUT,
  positional: ['pr_ref'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<PrMergeData>(input.dry_run, io)
    const config = requireActiveConfigPlain(out)
    const target = parseReference(input.pr_ref, input.repo, out)
    const client = createGitHubClient(out, config.host)
    const name = `PR #${String(target.number)}`

    const pullRequest = await readPullRequest(out, client, target)
    if (pullRequest.isDraft) stopWith(out, `${name} is a draft`, 'pr-state', NOT_MERGEABLE_EXIT_CODE)
    const stack = await bottomOfStack(out, client, target)
    out.result({ pullRequest: pathOf(target), base: pullRequest.baseRefName, ...stack !== undefined && { stack } })

    const suffix = stack === undefined ? '' : ` (stack #${String(stack.number)}, 1 of ${String(stack.size)})`
    if (input.dry_run) {
      out.planned({ verb: 'merge', target: `${name} into ${pullRequest.baseRefName}${suffix}` })
      return 0
    }
    return requestMerge({ out, client, target, name, base: pullRequest.baseRefName, suffix }, pullRequest)
  },
})
