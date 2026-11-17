// 積んだ記録（.pecot-base）を読む。無ければ、作業中の Issue の判定と git から積んだ先を求める。
import { getDevelopBranch } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import type { BaseReading } from '../domain/state.js'
import { inferStackedBase } from '../domain/work-start.js'
import type { LowerProbe } from '../domain/work-start.js'
import { activeIssueOf, changesSharedWith, forkPoint, gitToplevel, mergeBase, primaryRemoteName, resolveCommit } from '../infra/git.js'
import { TransportFailure } from '../infra/github/client.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { readBaseRecordAt } from '../infra/state-store.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import type { IssueReadiness } from './issue-readiness.js'
import type { Output } from './output.js'

const NO_RECORD: BaseReading = { kind: 'development', record: undefined }

export interface BaseProject {
  readonly config: Readonly<ProjectConfig>
  readonly client: () => Readonly<GitHubClient>
}

export interface BaseQuery {
  readonly directory: string
  /**
  アクティブなプロジェクト。無ければ求めない
  */
  readonly project: Readonly<BaseProject> | undefined
  /**
  求める前に一度だけ呼ぶ。pr restack が追跡参照を新しくするのに使う
  */
  readonly beforeInfer?: (() => void) | undefined
}

export interface BaseResult {
  readonly reading: BaseReading
  /**
  求めるときに読んだ作業中の Issue の判定。読まなければ undefined
  */
  readonly readiness: IssueReadiness | undefined
  /**
  積んだ先を求められなかった理由。求められたか、求めなかったときは undefined
  */
  readonly unresolved: string | undefined
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

function notInferred(readiness: IssueReadiness | undefined, unresolved: string | undefined): BaseResult {
  return { reading: NO_RECORD, readiness, unresolved }
}

async function inferBase(query: Readonly<BaseQuery>): Promise<BaseResult> {
  const { directory, project } = query
  const issue = activeIssueOf(directory)
  const remote = primaryRemoteName(directory)
  if (project === undefined || issue === undefined || remote === undefined) return notInferred(undefined, undefined)
  const { config } = project
  const developBranch = getDevelopBranch(config, issue.repository.owner, issue.repository.repository)
  if (developBranch === undefined || developBranch === '') return notInferred(undefined, undefined)
  query.beforeInfer?.()
  let readiness: IssueReadiness | undefined
  try {
    readiness = await readIssueReadinessIfSupported(project.client(), config, issue, createReadinessCache())
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError || error instanceof TransportFailure) return notInferred(undefined, error.message)
    throw error
  }
  if (readiness === undefined) return notInferred(undefined, undefined)
  if (readiness.kind === 'unreadable') return notInferred(readiness, readiness.reason)
  const inferred = inferStackedBase(readiness.readiness, readiness.prerequisites, issue, probeLower(directory, remote, `${remote}/${developBranch}`))
  if (inferred.kind === 'stacked') return { reading: { kind: 'stacked', record: inferred.record, stackedOn: inferred.stackedOn }, readiness, unresolved: undefined }
  return notInferred(readiness, inferred.kind === 'unknown' ? inferred.reason : undefined)
}

/**
directory の worktree の .pecot-base を読む。無ければ、判定と git から求める
*/
export async function readBaseOrInfer(query: Readonly<BaseQuery>): Promise<BaseResult> {
  const toplevel = gitToplevel({ cwd: query.directory })
  if (toplevel !== undefined) {
    const reading = readBaseRecordAt(toplevel)
    if (reading.kind !== 'development' || reading.record !== undefined) return { reading, readiness: undefined, unresolved: undefined }
  }
  return await inferBase(query)
}

export function warnUnresolved(result: Readonly<BaseResult>, output: Readonly<Output>): void {
  if (result.unresolved !== undefined) output.warning(`cannot infer the stacked base: ${result.unresolved}`)
}
