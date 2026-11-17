// 積んだ記録（.pecot-base）を読む。無ければ、作業中の Issue の判定と git から積んだ先を求める。
import { getDevelopBranch } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { ProjectRootNotFoundError } from '../domain/errors.js'
import type { BaseReading } from '../domain/state.js'
import { inferStackedBase } from '../domain/work-start.js'
import type { LowerProbe } from '../domain/work-start.js'
import { activeIssueOf, changesSharedWith, forkPoint, gitToplevel, mergeBase, primaryRemoteName, resolveCommit } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { projectRoot, resolveRealPath } from '../infra/paths.js'
import { readBaseRecord } from '../infra/state-store.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import type { IssueReadiness } from './issue-readiness.js'
import type { Output } from './output.js'

const NO_RECORD: BaseReading = { kind: 'development', record: undefined }

/**
directory がプロジェクトのルートの worktree か。.pecot-base はプロジェクトのルートの作業の記録なので、別の worktree には当てない
*/
export function isProjectRootWorktree(directory: string): boolean {
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined) return false
  try {
    return resolveRealPath(toplevel) === resolveRealPath(projectRoot())
  }
  catch (error: unknown) {
    if (error instanceof ProjectRootNotFoundError) return false
    throw error
  }
}

export interface BaseQuery {
  readonly directory: string
  readonly config: Readonly<ProjectConfig> | undefined
  readonly client: () => Readonly<GitHubClient>
  readonly output: Readonly<Output>
}

export interface BaseResult {
  readonly reading: BaseReading
  /**
  求めるときに読んだ作業中の Issue の判定。読まなければ undefined
  */
  readonly readiness: IssueReadiness | undefined
}

function probeLower(directory: string, remote: string, developReference: string): (stackOn: Readonly<{ branch: string }>) => LowerProbe {
  return ({ branch }) => {
    const lower = `${remote}/${branch}`
    const missing = [lower, developReference].find(reference => resolveCommit(directory, reference) === undefined)
    if (missing !== undefined) return { kind: 'untracked', reference: missing }
    const shared = changesSharedWith(directory, 'HEAD', lower, developReference)
    // pr restack の rebaseStartOf と同じく fork-point を先に使う。reflog の無い clone では、載せ直す前の下の段の先頭を patch-id で見つける
    const sha = forkPoint(directory, lower, 'HEAD') ?? shared.lastEquivalent ?? mergeBase(directory, 'HEAD', lower)
    return { kind: 'probed', isShared: shared.isShared, sha }
  }
}

async function inferBase(query: Readonly<BaseQuery>): Promise<BaseResult> {
  const { directory, config, output } = query
  const issue = activeIssueOf(directory)
  const remote = primaryRemoteName(directory)
  if (config === undefined || issue === undefined || remote === undefined) return { reading: NO_RECORD, readiness: undefined }
  const developBranch = getDevelopBranch(config, issue.repository.owner, issue.repository.repository)
  if (developBranch === undefined || developBranch === '') return { reading: NO_RECORD, readiness: undefined }
  let readiness: IssueReadiness | undefined
  try {
    readiness = await readIssueReadinessIfSupported(query.client(), config, issue, createReadinessCache())
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`cannot infer the stacked base: ${error.message}`)
    return { reading: NO_RECORD, readiness: undefined }
  }
  if (readiness === undefined) return { reading: NO_RECORD, readiness }
  if (readiness.kind === 'unreadable') {
    output.warning(`cannot infer the stacked base: ${readiness.reason}`)
    return { reading: NO_RECORD, readiness }
  }
  const inferred = inferStackedBase(readiness.readiness, readiness.prerequisites, issue, probeLower(directory, remote, `${remote}/${developBranch}`))
  if (inferred.kind === 'unknown') output.warning(`cannot infer the stacked base: ${inferred.reason}`)
  return { reading: inferred.kind === 'stacked' ? { kind: 'stacked', record: inferred.record, stackedOn: inferred.stackedOn } : NO_RECORD, readiness }
}

/**
プロジェクトのルートの worktree なら .pecot-base を読む。ファイルが無いか、別の worktree なら、判定と git から求める
*/
export async function readBaseOrInfer(query: Readonly<BaseQuery>): Promise<BaseResult> {
  if (isProjectRootWorktree(query.directory)) {
    const reading = readBaseRecord()
    if (reading.kind !== 'development' || reading.record !== undefined) return { reading, readiness: undefined }
  }
  return await inferBase(query)
}
