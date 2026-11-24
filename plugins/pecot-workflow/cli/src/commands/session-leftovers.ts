/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// session start が、前の PR の後片付けの取りこぼし（手元の片付けと merge-diff）を確かめる。
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import { hasMergeDiffMarker } from '../domain/merge-diff-marker.js'
import { createIssueReference, issueReferenceToCliReference, issueReferenceToString } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, isSameRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { gitCurrentBranch, primaryRemoteRepository } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { hasErrorCode } from '../infra/os-error.js'
import { readMergedRecord } from '../infra/state-store.js'
import { commandHint, hinted, RUN } from './command-hint.js'
import type { Output } from './output.js'
import { reasonOf } from './pr.js'
import { collectClosingIssueNumbers } from './session-finish.js'

export interface Leftover {
  readonly pullRequest: string
  readonly cleanup: boolean
  readonly mergeDiff: readonly string[]
}

export interface LeftoverCheck {
  readonly leftovers: readonly Leftover[]
  /**
  .pecot-merged から消してよい PR。merge-diff が要らないか、印が見つかったもの
  */
  readonly settledRecords: readonly IssueReference[]
}

interface Candidate {
  readonly pullRequest: IssueReference
  cleanup: boolean
  isRecorded: boolean
}

// 今のブランチの PR がマージ済みで、開いた PR が無ければ、手元が片付いていない
async function findUncleanedPullRequest(out: Readonly<Output>, client: GitHubClient, repository: RepositoryReference, cwd: string): Promise<IssueReference | undefined> {
  const remote = primaryRemoteRepository(cwd)
  if (remote === undefined || !isSameRepository(remote, repository)) return undefined
  const branch = gitCurrentBranch(cwd)
  if (branch === undefined || extractIssueNumberFromBranch(branch) === undefined) return undefined
  const { pullRequests } = await client.listPullRequestsByHead(repository.owner, repository.repository, branch)
  const own = pullRequests.filter(pullRequest => !pullRequest.isCrossRepository)
  if (own.some(pullRequest => pullRequest.state === 'OPEN')) return undefined
  const merged = own.find(pullRequest => pullRequest.state === 'MERGED')
  if (merged === undefined) return undefined
  const reference = createIssueReference(repository, merged.number)
  const finish = commandHint(['session', 'finish'], { pr_ref: issueReferenceToCliReference(reference), delete_branch: true })
  out.warning(hinted`PR ${issueReferenceToString(reference)} of the current branch ${branch} is merged but not cleaned up; ${RUN} ${finish}`)
  return reference
}

// PR の closing Issue の親 Epic のうち、この PR の merge-diff の印を持たないもの
async function findEpicsWithoutMergeDiff(client: GitHubClient, pullRequest: IssueReference): Promise<IssueReference[]> {
  const { owner, repository } = pullRequest.repository
  const pr = await client.getPullRequestForFinish(owner, repository, pullRequest.number)
  const epics = new Map<string, IssueReference>()
  const closingNumbers = [...collectClosingIssueNumbers(pr, pullRequest.repository)].toSorted((a, b) => a - b)
  for (const number of closingNumbers) {
    const { parent } = await client.getIssueSlim(owner, repository, number, 0)
    if (parent === null) continue
    const parentRepository = parent.owner === null || parent.repo === null ? pullRequest.repository : createRepositoryReference(parent.owner, parent.repo)
    const reference = createIssueReference(parentRepository, parent.number)
    if (epics.has(issueReferenceToString(reference))) continue
    if (isEpicIssue(await client.getIssueKind(parentRepository.owner, parentRepository.repository, parent.number))) epics.set(issueReferenceToString(reference), reference)
  }
  const missing: IssueReference[] = []
  for (const epic of epics.values()) {
    const comments = await client.listIssueCommentReadings(epic.repository.owner, epic.repository.repository, epic.number)
    if (comments.every(comment => !hasMergeDiffMarker(comment.body, pullRequest))) missing.push(epic)
  }
  return missing
}

function readRecordedPullRequests(out: Readonly<Output>): IssueReference[] {
  try {
    return readMergedRecord()
  }
  catch (error: unknown) {
    // 状態ディレクトリが無い（ENOTDIR）なら記録も無い。書くほうの失敗が別に出る
    if (hasErrorCode(error) && error.code === 'ENOTDIR') return []
    out.warning(`could not check leftovers: reading the merged PRs failed: ${reasonOf(error)}`)
    return []
  }
}

function addCandidate(candidates: Map<string, Candidate>, pullRequest: IssueReference, origin: 'branch' | 'record'): void {
  const key = issueReferenceToString(pullRequest).toLowerCase()
  const found = candidates.get(key) ?? { pullRequest, cleanup: false, isRecorded: false }
  if (origin === 'branch') found.cleanup = true
  else found.isRecorded = true
  candidates.set(key, found)
}

/**
前の PR の後片付けの取りこぼしを確かめ、あれば warning を出す。読む失敗も warning にして、確かめられた分だけを返す
*/
export async function checkLeftovers(out: Readonly<Output>, client: GitHubClient, repository: RepositoryReference, cwd: string): Promise<LeftoverCheck> {
  const candidates = new Map<string, Candidate>()
  try {
    const uncleaned = await findUncleanedPullRequest(out, client, repository, cwd)
    if (uncleaned !== undefined) addCandidate(candidates, uncleaned, 'branch')
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not check leftovers: reading the PR of the current branch failed: ${error.message}`)
  }
  for (const recorded of readRecordedPullRequests(out)) addCandidate(candidates, recorded, 'record')

  const leftovers: Leftover[] = []
  const settledRecords: IssueReference[] = []
  for (const candidate of candidates.values()) {
    const name = issueReferenceToString(candidate.pullRequest)
    let missing: IssueReference[] = []
    try {
      missing = await findEpicsWithoutMergeDiff(client, candidate.pullRequest)
      if (candidate.isRecorded && missing.length === 0) settledRecords.push(candidate.pullRequest)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(`could not check leftovers: reading the merge-diff of PR ${name} failed: ${error.message}`)
    }
    for (const epic of missing) {
      out.warning(`Epic ${issueReferenceToString(epic)} has no merge-diff for PR ${name}; post a merge-diff comment on it with pr_ref ${issueReferenceToCliReference(candidate.pullRequest)} in the frontmatter`)
    }
    if (candidate.cleanup || missing.length > 0) {
      leftovers.push({ pullRequest: issueReferenceToCliReference(candidate.pullRequest), cleanup: candidate.cleanup, mergeDiff: missing.map(epic => issueReferenceToCliReference(epic)) })
    }
  }
  return { leftovers, settledRecords }
}
