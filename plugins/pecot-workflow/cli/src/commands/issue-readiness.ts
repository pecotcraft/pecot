// Issue の着手の可否の読み取り。前提を読み、判定する。project info と issue read が使う。
// 流れは getIssuePrerequisites → readWaitsForMerge → toIssueFacts → judgeReadiness。
import { findRepository, workflowFieldName } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import type { IssuePrerequisitesReadout, PullRequestReadout } from '../domain/issue-readout.js'
import { readWaitsForMerge } from '../domain/prerequisites.js'
import type { WaitsForMergeReadout } from '../domain/prerequisites.js'
import { judgeReadiness, toIssueFacts } from '../domain/readiness.js'
import type { FactsMismatch, IssueFacts, IssuePullRequest, Prerequisite, Readiness } from '../domain/readiness.js'
import { issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { repositoryFullName } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { MAX_BLOCKED_BY } from '../infra/github/issues.js'
import { STATUS_FIELD_NAME } from './project-sync.js'

/**
順 8 で base をたどる段数の上限
*/
const MAX_STACK_TRACE_STEPS = 10

/**
前提を読む件数の下限。一覧を読んでから足された前提も取りこぼさない
*/
const MIN_BLOCKED_BY_READ = 8

/**
一覧の前提の件数から、個別に読む前提の件数を決める。件数が一覧に無ければ undefined（上限で読む）
*/
export function blockedByReadCount(listed: number | undefined): number | undefined {
  return listed === undefined ? undefined : Math.min(Math.max(listed, MIN_BLOCKED_BY_READ), MAX_BLOCKED_BY)
}

/**
head のブランチ名で引いた PR の取得結果を、1 回の実行の中で使い回す入れ物。キーは `owner/repo:head`
*/
export type ReadinessCache = Map<string, Promise<IssuePullRequest | undefined>>

export function createReadinessCache(): ReadinessCache {
  return new Map()
}

/**
前提まで読んだ Issue。判定の前の段階で、輪の検出に使う辺を取り出せる
*/
export interface IssueSnapshot {
  readonly kind: 'snapshot'
  readonly ref: IssueReference
  readonly title: string
  readonly target: IssueFacts
  /**
  読めた前提。blockedBy の読み取りが失敗した Issue は、ここまで来ずに読めない理由で返る
  */
  readonly prerequisites: readonly Prerequisite[]
  /**
  前提の title（issueReferenceKey → title）
  */
  readonly titles: ReadonlyMap<string, string>
  readonly mismatches: readonly FactsMismatch[]
  /**
  本文の `## Waits for merge` の節が読めないときの理由
  */
  readonly malformedReason: string | undefined
  readonly parent: IssueReference | undefined
  /**
  対象のリポジトリの develop_branch。未設定なら undefined
  */
  readonly developmentBranch: string | undefined
}

export interface UnreadableIssue {
  readonly kind: 'unreadable'
  readonly reason: string
  /**
  前提まで読めていたときの読み取り結果。判定だけが読めなかった（develop_branch が無い、PR の引き足しに失敗した）ときに付く
  */
  readonly snapshot?: IssueSnapshot
}

export interface JudgedIssue extends Omit<IssueSnapshot, 'developmentBranch' | 'kind'> {
  readonly kind: 'judged'
  /**
  Epic と Tracker は undefined
  */
  readonly readiness: Readiness | undefined
}

export type IssueReadiness = JudgedIssue | UnreadableIssue

function unreadable(reason: string, snapshot?: IssueSnapshot): UnreadableIssue {
  return snapshot === undefined ? { kind: 'unreadable', reason } : { kind: 'unreadable', reason, snapshot }
}

function titlesOf(readout: IssuePrerequisitesReadout): ReadonlyMap<string, string> {
  return readout.blockedBy.kind === 'ok' ? new Map(readout.blockedBy.issues.map(issue => [issueReferenceKey({ repository: issue.repository, number: issue.number }), issue.title])) : new Map()
}

/**
対象の Issue と前提を読む。API の失敗と blockedBy の読み取りの失敗は、読めない理由で返す。
DependenciesUnsupportedError は GitHubAPIError だが、対応しない GHES を呼ぶ側で見分けるため、そのまま投げる
*/
export async function readIssueSnapshot(client: Readonly<GitHubClient>, config: ProjectConfig, reference: IssueReference, blockedByFirst?: number): Promise<IssueSnapshot | UnreadableIssue> {
  const { owner, repository } = reference.repository
  let readout: IssuePrerequisitesReadout
  try {
    readout = await client.getIssuePrerequisites(owner, repository, reference.number, config.project.id, {
      columnFieldName: workflowFieldName(config),
      labelFieldName: STATUS_FIELD_NAME,
    }, blockedByFirst)
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError && !(error instanceof DependenciesUnsupportedError)) return unreadable(error.message)
    throw error
  }
  const section: WaitsForMergeReadout = readWaitsForMerge(readout.issue.body, reference.repository)
  const result = toIssueFacts(readout, section, { columnFieldName: workflowFieldName(config), labelFieldName: STATUS_FIELD_NAME })
  if (result.prerequisites === 'read-failed') {
    return unreadable(readout.blockedBy.kind === 'read-failed' ? readout.blockedBy.reason : 'could not read blocked-by')
  }
  const { parent } = readout.issue
  return {
    kind: 'snapshot',
    ref: reference,
    title: readout.issue.title,
    target: result.target,
    prerequisites: result.prerequisites,
    titles: titlesOf(readout),
    mismatches: result.mismatches,
    malformedReason: section.kind === 'malformed' ? section.reason : undefined,
    parent: parent === null ? undefined : { repository: parent.repository, number: parent.number },
    developmentBranch: findRepository(config, owner, repository)?.develop_branch,
  }
}

/**
前提の無い Issue の読み取り結果。一覧の値から作るので、API は呼ばない
*/
export function snapshotWithoutPrerequisites(config: ProjectConfig, input: { readonly title: string, readonly target: IssueFacts, readonly parent: IssueReference | undefined }): IssueSnapshot {
  const { repository } = input.target.ref
  return {
    kind: 'snapshot',
    ref: input.target.ref,
    title: input.title,
    target: input.target,
    prerequisites: [],
    titles: new Map(),
    mismatches: [],
    malformedReason: undefined,
    parent: input.parent,
    developmentBranch: findRepository(config, repository.owner, repository.repository)?.develop_branch,
  }
}

/**
Issue の前提の辺（対象のキー → 前提のキー）。輪の検出に使う
*/
export function prerequisiteKeys(snapshot: Readonly<IssueSnapshot>): readonly string[] {
  return snapshot.prerequisites.map(({ issue }) => issueReferenceKey(issue.ref))
}

function toIssuePullRequest(readout: Readonly<PullRequestReadout>): IssuePullRequest {
  return {
    repository: readout.repository,
    number: readout.number,
    state: readout.state === 'OPEN' ? 'open' : (readout.state === 'MERGED' ? 'merged' : 'closed'),
    headRefName: readout.headRefName,
    baseRefName: readout.baseRefName,
    isDraft: readout.isDraft,
    isCrossRepository: readout.isCrossRepository,
  }
}

// head のブランチを持つ PR が、open で fork からでないものちょうど 1 本なら返す。2 本以上か続きがあれば足さない
async function lookUpByHead(client: Readonly<GitHubClient>, repository: RepositoryReference, head: string): Promise<IssuePullRequest | undefined> {
  const found = await client.listPullRequestsByHead(repository.owner, repository.repository, head)
  if (found.hasNextPage) return undefined
  const candidates = found.pullRequests.map(pullRequest => toIssuePullRequest(pullRequest)).filter(pullRequest => pullRequest.state === 'open' && !pullRequest.isCrossRepository)
  return candidates.length === 1 ? candidates[0] : undefined
}

function cachedLookUp(client: Readonly<GitHubClient>, cache: ReadinessCache, repository: RepositoryReference, head: string): Promise<IssuePullRequest | undefined> {
  const key = `${repositoryFullName(repository)}:${head}`.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pending = lookUpByHead(client, repository, head)
  cache.set(key, pending)
  return pending
}

// 前提の open で fork からでない PR
function prerequisitePullRequests(prerequisites: readonly Prerequisite[]): readonly IssuePullRequest[] {
  return prerequisites.flatMap(({ issue }) => issue.pullRequests).filter(pullRequest => pullRequest.state === 'open' && !pullRequest.isCrossRepository)
}

// diverged の間、base のブランチを head に持つ PR を引き足して判定をやり直す
async function traceStacks(
  client: Readonly<GitHubClient>,
  snapshot: Readonly<IssueSnapshot>,
  cache: ReadinessCache,
  byHead: Map<string, IssuePullRequest>,
  first: Readiness | undefined,
  judge: () => Readiness | undefined,
  branch: string,
): Promise<Readiness | undefined> {
  const { prerequisites } = snapshot
  let readiness = first
  const traced = new Set<string>()
  for (let step = 0; step < MAX_STACK_TRACE_STEPS && readiness?.reason?.code === 'diverged'; step += 1) {
    const known = new Set([...prerequisitePullRequests(prerequisites), ...byHead.values()].map(pullRequest => pullRequest.headRefName))
    const missing = [...prerequisitePullRequests(prerequisites), ...byHead.values()].filter(pullRequest => pullRequest.baseRefName !== branch && !known.has(pullRequest.baseRefName) && !traced.has(`${repositoryFullName(pullRequest.repository)}:${pullRequest.baseRefName}`.toLowerCase()))
    if (missing.length === 0) break
    for (const pullRequest of missing) {
      traced.add(`${repositoryFullName(pullRequest.repository)}:${pullRequest.baseRefName}`.toLowerCase())

      const base = await cachedLookUp(client, cache, pullRequest.repository, pullRequest.baseRefName)
      if (base !== undefined) byHead.set(base.headRefName, base)
    }
    readiness = judge()
  }
  return readiness
}

/**
前提を判定する。cycle は呼ぶ側が findCycle で求めた輪。
develop_branch が無いときと、PR の引き足しの API が失敗したときは、読み取り結果を添えた unreadable を返す。
DependenciesUnsupportedError はそのまま投げる。
前提の PR が開発ブランチに届かないときだけ、base のブランチを head に持つ PR を引き足して、判定をやり直す
*/
export async function judgeSnapshot(client: Readonly<GitHubClient>, snapshot: Readonly<IssueSnapshot>, cache: ReadinessCache, cycle?: readonly string[]): Promise<IssueReadiness> {
  const { developmentBranch, prerequisites, target } = snapshot
  const hasUnfinished = prerequisites.some(({ issue }) => !(issue.state === 'closed' && issue.pullRequests.some(pullRequest => pullRequest.state === 'merged')))
  if (hasUnfinished && (developmentBranch === undefined || developmentBranch === '')) {
    return unreadable(`develop_branch is not set for ${repositoryFullName(snapshot.ref.repository)}`, snapshot)
  }
  const branch = developmentBranch ?? ''
  const byHead = new Map<string, IssuePullRequest>()
  const judge = (): Readiness | undefined => judgeReadiness({ target, prerequisites, cycle, pullRequestsByHead: byHead, developmentBranch: branch })

  let readiness = judge()
  try {
    readiness = await traceStacks(client, snapshot, cache, byHead, readiness, judge, branch)
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError && !(error instanceof DependenciesUnsupportedError)) return unreadable(error.message, snapshot)
    throw error
  }
  return {
    kind: 'judged',
    ref: snapshot.ref,
    title: snapshot.title,
    target,
    prerequisites,
    titles: snapshot.titles,
    mismatches: snapshot.mismatches,
    malformedReason: snapshot.malformedReason,
    parent: snapshot.parent,
    readiness,
  }
}

/**
Issue 1 件の読み取りから判定までを通す。輪は呼ぶ側が渡す（issue read は輪を見ない）
*/
export async function readIssueReadiness(client: Readonly<GitHubClient>, config: ProjectConfig, reference: IssueReference, cache: ReadinessCache, cycle?: readonly string[], blockedByFirst?: number): Promise<IssueReadiness> {
  const snapshot = await readIssueSnapshot(client, config, reference, blockedByFirst)
  return snapshot.kind === 'unreadable' ? snapshot : await judgeSnapshot(client, snapshot, cache, cycle)
}

/**
JSON の出力に使う判定。reason は blocked のときだけの理由のコード、stackOn は積む先
*/
export function readinessJson(readiness: Readonly<Readiness>, text: string): JsonObject {
  const { stackOn } = readiness
  return {
    kind: readiness.kind,
    stackOn: stackOn === undefined ? JSON_NULL : { number: stackOn.issue.number, repository: repositoryFullName(stackOn.issue.repository), branch: stackOn.branch },
    reason: readiness.reason?.code ?? JSON_NULL,
    text,
  }
}

/**
readIssueReadiness の、依存関係を持たない GHES を判定なしで通す形。GHES なら undefined を返し、onUnsupported に理由を渡す
*/
export async function readIssueReadinessIfSupported(
  client: Readonly<GitHubClient>,
  config: ProjectConfig,
  reference: IssueReference,
  cache: ReadinessCache,
  onUnsupported?: (reason: string) => void,
): Promise<IssueReadiness | undefined> {
  try {
    return await readIssueReadiness(client, config, reference, cache)
  }
  catch (error: unknown) {
    if (!(error instanceof DependenciesUnsupportedError)) throw error
    onUnsupported?.(error.message)
    return undefined
  }
}
