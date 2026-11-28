/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// Issue につないだブランチを作る。github-ops の link-branch と、auto-start が使う。
import type { GitHubClient } from '../infra/github/index.js'

export interface LinkBranchTarget {
  readonly owner: string
  readonly repository: string
  readonly issue: number
  readonly branch: string
  readonly base?: string | undefined
}

export interface LinkedBranch {
  readonly issue: number
  readonly branch: string
  readonly base: string
  readonly sha: string
}

/**
base を省くと、リポの既定のブランチから作る。ブランチ名は GitHub が付けた名前を返す
*/
export async function linkIssueBranch(client: GitHubClient, target: Readonly<LinkBranchTarget>): Promise<LinkedBranch> {
  const { owner, repository } = target
  const settings = target.base === undefined ? await client.getRepositorySettings(owner, repository) : undefined
  const base = target.base ?? settings?.defaultBranch ?? ''
  const sha = await client.getBranchSha(owner, repository, base)
  const issueId = await client.getIssueNodeId(owner, repository, target.issue)
  const branch = await client.createLinkedBranch(issueId, sha, target.branch)
  return { issue: target.issue, branch, base, sha }
}
