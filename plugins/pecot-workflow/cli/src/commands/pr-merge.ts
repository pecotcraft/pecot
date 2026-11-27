/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// pr merge。単独の PR もスタックの PR も、非同期のマージ API（merge-async）でマージする。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { describeApiError } from '@pecot/workflow-core/domain/api-error-detail.js'
import { jsonField, tryParseJsonText } from '@pecot/workflow-core/domain/json.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '@pecot/workflow-core/infra/github/errors.js'
import type { AsyncMergeResult, PullRequestForMerge } from '@pecot/workflow-core/infra/github/pulls.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createAuthenticatedGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { parseReference, PR_REFERENCE_DESCRIPTION } from '@pecot/workflow-core/commands-shared/pr-reference.js'

// 要求を送らずに止める（ドラフト、閉じている、スタックの一番下でない）
const NOT_MERGEABLE_EXIT_CODE = 2
const POLL_INTERVAL_MILLISECONDS = 2000
// R14 では 3〜8 秒で終わった。時刻でなく回数で数え、偽のタイマーでも同じに動かす
const POLL_LIMIT = 30
const POLL_LIMIT_SECONDS = (POLL_INTERVAL_MILLISECONDS * POLL_LIMIT) / 1000
// 同期のマージ API が、マージできない（405）・head が sha と違う（409）ときに返す状態コード
const SYNC_MERGE_REJECTED_STATUSES: ReadonlySet<number> = new Set([405, 409])

const MergeInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  project: PROJECT_INPUT,
})

const PR_MERGE_OUTPUT = z.strictObject({
  pullRequest: z.string().describe('PR (owner/repo/N)'),
  base: z.string().describe('Base branch the PR is merged into'),
  status: z.enum(['merged', 'enqueued']).describe('merged, or enqueued when the PR was added to the merge queue'),
  stack: z.strictObject({
    number: z.int().describe('Stack number'),
    size: z.int().describe('Number of PRs in the stack from this PR upward (K of "1 of K")'),
  }).optional().describe('Stack the PR is the bottom of (absent for a PR outside a stack)'),
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
  readonly isInStack: boolean
}

function pathOf(target: Readonly<Target>): string {
  return `${target.owner}/${target.repository}/${String(target.number)}`
}

function stopNotMergeable(out: Readonly<Output<PrMergeData>>, message: string): never {
  return stopWith(out, message, 'pr-state', NOT_MERGEABLE_EXIT_CODE)
}

// 印は残す。呼ぶ側は必須チェックを待って同じ PR に呼び直せる
function stopRejected(out: Readonly<Output<PrMergeData>>, reason: string): never {
  return stopWith(out, `merge was rejected: ${reason}`, 'pr-state')
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

function checkState(out: Readonly<Output<PrMergeData>>, name: string, pullRequest: Readonly<PullRequestForMerge>): void {
  if (pullRequest.state === 'MERGED') stopNotMergeable(out, `${name} is already merged`)
  if (pullRequest.state !== 'OPEN') stopNotMergeable(out, `${name} is closed`)
  if (pullRequest.isDraft) stopNotMergeable(out, `${name} is a draft`)
}

// スタックでこの PR より下に open の PR があれば止める。マージ済みで並びに残る PR は飛ばす。スタックの機能が無いリポは単独の PR として扱う
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
      stopNotMergeable(out, `PR #${String(target.number)} is not the bottom of stack #${String(stack.number)}. Merge PR #${String(lower)} first`)
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
  return stopRejected(context.out, result.message ?? 'GitHub gave no reason')
}

// PR の状態から決める。マージ済みでもキューの中でもなければ undefined
async function finishIfSettled(context: Readonly<MergeContext>): Promise<0 | undefined> {
  const pullRequest = await readPullRequest(context.out, context.client, context.target)
  if (pullRequest.state === 'MERGED') return finishMerged(context)
  if (pullRequest.isInMergeQueue) return finishEnqueued(context)
  return undefined
}

function stopUnconfirmed(context: Readonly<MergeContext>): never {
  return stopWith(context.out, `could not confirm the merge of ${context.name}: it is neither merged nor in the merge queue`, 'pr-state')
}

async function finishFromState(context: Readonly<MergeContext>): Promise<0> {
  return await finishIfSettled(context) ?? stopUnconfirmed(context)
}

// 結果の 404 は、消えた結果のほか、書いた直後の読み取りの遅れでも返る。そのときは期限まで読み直す
async function pollResult(context: Readonly<MergeContext>, uuid: string): Promise<0> {
  const { owner, repository, number } = context.target
  let isResultMissing = false
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
    if (result === undefined) {
      isResultMissing = true
      const settled = await finishIfSettled(context)
      if (settled !== undefined) return settled
      continue
    }
    isResultMissing = false
    if (result.status !== 'pending') return finishResult(context, result)
  }
  return isResultMissing
    ? stopUnconfirmed(context)
    : stopWith(context.out, `merge did not finish in ${String(POLL_LIMIT_SECONDS)}s. Check ${context.name}`, 'github-api')
}

function reasonOf(error: Readonly<GitHubAPIError>): string {
  const message = jsonField(tryParseJsonText(error.responseBody ?? ''), 'message')
  return typeof message === 'string' && message !== '' ? message : describeApiError(error)
}

// merge-async の無い GHES 向け。sha を渡し、読んだ後に push された PR をマージしない
async function mergeSynchronously(context: Readonly<MergeContext>, pullRequest: Readonly<PullRequestForMerge>): Promise<0> {
  const { owner, repository, number } = context.target
  try {
    await context.client.mergePullRequest(owner, repository, number, 'squash', pullRequest.headRefOid)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return error.statusCode !== undefined && SYNC_MERGE_REJECTED_STATUSES.has(error.statusCode)
      ? stopRejected(context.out, reasonOf(error))
      : stopWith(context.out, `could not merge PR ${pathOf(context.target)}: ${describeApiError(error)}`, kindOfFailure(error))
  }
  return finishMerged(context)
}

async function requestMerge(context: Readonly<MergeContext>, pullRequest: Readonly<PullRequestForMerge>): Promise<0> {
  const { owner, repository, number } = context.target
  let requested
  try {
    requested = await context.client.requestAsyncMerge(owner, repository, number, { sha: pullRequest.headRefOid, mergeQueue: pullRequest.isMergeQueueEnabled })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    // 同期の API はスタックの PR を 403 で拒むので、スタックの中では戻さない
    return error instanceof GitHubNotFoundError && !context.isInStack
      ? mergeSynchronously(context, pullRequest)
      : stopWith(context.out, `could not merge PR ${pathOf(context.target)}: ${describeApiError(error)}`, kindOfFailure(error))
  }
  switch (requested.outcome) {
    case 'rejected': { return stopRejected(context.out, requested.message) }
    // 文書は 409 の本文の形を示していない。uuid が無ければ PR の状態から決める
    case 'conflict': { return requested.uuid === undefined ? finishFromState(context) : pollResult(context, requested.uuid) }
    case 'accepted': {
      const { result } = requested
      return result.status === 'pending' && result.uuid !== undefined ? pollResult(context, result.uuid) : finishResult(context, result)
    }
  }
}

export const PR_MERGE_COMMAND: ToolDefinition = defineTool({
  name: 'pr_merge',
  title: 'Merge PR',
  description: 'Merge a PR with the asynchronous merge API (a PR in a stack must be the bottom one)',
  input: MergeInputSchema,
  output: PR_MERGE_OUTPUT,
  run: async (input, io) => {
    const out = createOutput<PrMergeData>(false, io)
    const target = parseReference(input.pr_ref, input.repo, out)
    const config = requireConfigFor(out, target, input.project, ['pr', 'merge']).config
    // 認証の失敗を、PR を読めない文に包まないため
    const client = await createAuthenticatedGitHubClient(out, config.host)
    const name = `PR #${String(target.number)}`

    const pullRequest = await readPullRequest(out, client, target)
    checkState(out, name, pullRequest)
    const stack = await bottomOfStack(out, client, target)
    out.result({ pullRequest: pathOf(target), base: pullRequest.baseRefName, ...stack !== undefined && { stack } })

    const suffix = stack === undefined ? '' : ` (stack #${String(stack.number)}, 1 of ${String(stack.size)})`
    return requestMerge({ out, client, target, name, base: pullRequest.baseRefName, suffix, isInStack: stack !== undefined }, pullRequest)
  },
})
