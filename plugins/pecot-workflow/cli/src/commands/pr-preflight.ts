// pr_check・pr_restack が使う、手元の git と nx の読み取り。GitHub を読まない
import { statSync } from 'node:fs'
import path from 'node:path'

import { effectiveReleaseType, findRepository, getDevelopBranch } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { parseRemoteUrl } from '@pecot/workflow-core/domain/git-url.js'
import type { RemoteLocation } from '@pecot/workflow-core/domain/git-url.js'
import type { PullRequestReadout } from '@pecot/workflow-core/domain/issue-readout.js'
import { collectPreflightWarnings, describeBaseStop, describePushStatus, DIVERGED_FIX_HINT, forkPushFixHint, pushFixHintOf } from '@pecot/workflow-core/domain/pull-request.js'
import type { HeadReference, PreflightWarning, PushStatus } from '@pecot/workflow-core/domain/pull-request.js'
import { parsePythonInteger, pythonStrip } from '@pecot/workflow-core/domain/python-format.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { RESTACK_PATH } from '@pecot/workflow-core/domain/restack.js'
import type { BaseReading } from '@pecot/workflow-core/domain/state.js'
import { gitCurrentBranch, gitRemoteUrl, gitStdout, gitToplevel, isAncestor, primaryRemoteName, resolveCommit, runGit } from '@pecot/workflow-core/infra/git.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { commandHint, hinted, joinHinted } from '@pecot/workflow-core/commands-shared/command-hint.js'
import type { HintedText } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { changedFiles, expectedScope, nxProjects, parseTitleScope } from '../infra/nx-scope.js'
import { readRemoteLocations } from '../infra/remote-config.js'
import { readBaseRecordAt } from '../infra/state-store.js'
import { readRestackDecision } from './restack-reading.js'

// 主の remote

export interface PrimaryRemote {
  readonly name: string
  readonly url: string
  /**
  URL が読めなければ undefined
  */
  readonly location: RemoteLocation | undefined
}

export function primaryRemote(directory: string): PrimaryRemote | undefined {
  const name = primaryRemoteName(directory)
  if (name === undefined) return undefined
  const url = gitRemoteUrl(directory, name)
  if (url === undefined) return undefined
  try {
    return { name, url, location: parseRemoteUrl(url) }
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return { name, url, location: undefined }
    throw error
  }
}

interface PullRequestContext {
  readonly toplevel: string
  readonly currentBranch: string
  readonly location: RemoteLocation
  readonly remoteName: string
}

/**
git のリポジトリ・主の remote・今のブランチを読む。どれかが無ければ git-unresolved で止める
*/
export function validatePullRequestContext(directory: string, out: Readonly<Output>): PullRequestContext {
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined) return stopWith(out, 'not a git repository', 'git-unresolved')
  const found = primaryRemote(directory)
  if (found === undefined) return stopWith(out, 'git remote not found', 'git-unresolved')
  const currentBranch = gitCurrentBranch(directory)
  if (currentBranch === undefined) return stopWith(out, 'cannot determine the current branch', 'git-unresolved')
  if (found.location === undefined) return stopWith(out, 'cannot read repository info from the remote URL\ncheck it with: git remote -v', 'git-unresolved')
  return { toplevel, currentBranch, location: found.location, remoteName: found.name }
}

export function stopOnMalformedRecord(reading: BaseReading, out: Readonly<Output>): void {
  if (reading.kind === 'malformed') stopWith(out, joinHinted(describeBaseStop({ kind: 'stop', reason: 'malformed', content: reading.content })), 'content-invalid')
}

// base の記録

/**
head が今のブランチなら、その worktree の base の記録を読む。今のブランチでなければ undefined。
形が誤っているか、記録の位置が head の履歴に無ければ止める（別のブランチの記録か、手でスタックし直した後の古い記録）
*/
export function readHeadBase(directory: string, head: string, out: Readonly<Output>): BaseReading | undefined {
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined || head !== gitCurrentBranch(directory)) return undefined
  const reading = readBaseRecordAt(toplevel)
  stopOnMalformedRecord(reading, out)
  if (reading.kind !== 'stacked') return reading
  const { branch, sha } = reading.record
  // 手元が知らないコミットは、履歴に無いと決められないので止めない
  if (resolveCommit(directory, sha) === undefined || isAncestor(directory, sha, head)) return reading
  return stopWith(out, joinHinted([
    `.pecot-base records ${branch} at ${sha.slice(0, 7)}, which is not in the history of ${head}`,
    hinted`if ${head} was restacked by hand, rewrite the record with: ${commandHint(RESTACK_PATH)}`,
    'otherwise, check the PR in the work directory where session_start wrote .pecot/state/.pecot-base for the branch',
  ]), 'git-unresolved')
}

// タイトルの scope

/**
スタックした base のときの題の scope の差分の起点。記録のコミット（親 PR がマージ済みのとき）か、親ブランチ（開いている間）
*/
export type StackedScope = { readonly sha: string } | { readonly branch: string }

interface ScopeTarget {
  readonly toplevel: string
  /**
  変更したファイルを求める差分の起点
  */
  readonly from: string
}

// Python の Path.is_file() と同じく、stat の失敗は「無い」と扱う
function isRegularFile(file: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- git の toplevel の下の nx.json
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

// scope を nx のプロジェクトと比べる対象か。release_type が nx で、base が develop かスタックした base で、remote と作業ツリーが対象に合うときだけ。
// 親 PR を squash でマージした後は、開発ブランチとの差分が親ブランチのファイルも含むので、記録のコミットから比べる
function nxScopeTarget(query: Readonly<TitleScopeQuery>): ScopeTarget | undefined {
  const { config, location, base, directory, stacked } = query
  const configured = findRepository(config, location.owner, location.repository)
  if (configured === undefined || effectiveReleaseType(configured) !== 'nx' || (stacked === undefined && base !== getDevelopBranch(config, location.owner, location.repository))) return undefined
  const found = primaryRemote(directory)
  const remote = found?.location
  const isSameRepository = remote?.owner.toLowerCase() === location.owner.toLowerCase() && remote.repository.toLowerCase() === location.repository.toLowerCase()
  if (found === undefined || !isSameRepository) return undefined
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined || !isRegularFile(path.join(toplevel, 'nx.json'))) return undefined
  if (stacked === undefined) return { toplevel, from: `${found.name}/${base}` }
  return { toplevel, from: 'sha' in stacked ? stacked.sha : `${found.name}/${stacked.branch}` }
}

export interface TitleScopeQuery {
  readonly config: ProjectConfig
  readonly location: RepositoryReference
  readonly title: string
  readonly base: string
  /**
  差分を求める git の参照。fork の head（`owner:branch`）ではブランチ名の部分
  */
  readonly headBranch: string
  readonly directory: string
  readonly stacked: StackedScope | undefined
}

export interface TitleScopeMismatch {
  readonly expected: readonly string[]
  /**
  題の scope。無ければ undefined
  */
  readonly given: readonly string[] | undefined
}

/**
題の scope が、変更した nx のプロジェクトの scope と食い違えば、期待する scope を返す。比べる対象でないか、合えば undefined
*/
export async function titleScopeMismatch(query: Readonly<TitleScopeQuery>, out: Readonly<Output>): Promise<TitleScopeMismatch | undefined> {
  const target = nxScopeTarget(query)
  if (target === undefined) return undefined
  const projects = await nxProjects(target.toplevel, { signal: out.signal })
  const files = projects === undefined ? undefined : changedFiles(target.toplevel, target.from, query.headBranch)
  if (projects === undefined || files === undefined) {
    out.warning('cannot read nx projects or the diff; skipped the PR title scope check')
    return undefined
  }
  const expected = expectedScope(files, projects)
  if (expected.length === 0) return undefined
  const given = parseTitleScope(query.title)
  return given !== undefined && new Set(given).size === new Set(expected).size && given.every(scope => expected.includes(scope)) ? undefined : { expected, given }
}

// preflight

function getGitStatus(cwd: string): string {
  return gitStdout(['status'], { cwd }) ?? '(git status failed)'
}

function getStashList(cwd: string): string {
  const stdout = gitStdout(['stash', 'list'], { cwd })
  return stdout === undefined ? '(git stash list failed)' : pythonStrip(stdout) || '(no stash)'
}

function getPushStatus(branch: string, cwd: string, remote: string): PushStatus {
  const failed: PushStatus = { isPushed: false, message: '(git rev-list failed)', isDiverged: false }
  try {
    if (runGit(['rev-parse', '--verify', `${remote}/${branch}`], { cwd }).exitCode !== 0) {
      return { isPushed: false, message: `${remote}/${branch} does not exist (not pushed)`, isDiverged: false }
    }
  }
  catch (error: unknown) {
    if (isFileNotFound(error)) return { isPushed: false, message: '(git rev-parse failed)', isDiverged: false }
    throw error
  }
  const ahead = gitStdout(['rev-list', '--count', `${remote}/${branch}..${branch}`], { cwd })
  const behind = ahead === undefined ? undefined : gitStdout(['rev-list', '--count', `${branch}..${remote}/${branch}`], { cwd })
  const aheadCount = ahead === undefined ? undefined : parsePythonInteger(pythonStrip(ahead))
  const behindCount = behind === undefined ? undefined : parsePythonInteger(pythonStrip(behind))
  return aheadCount === undefined || behindCount === undefined ? failed : describePushStatus(remote, branch, aheadCount, behindCount)
}

function isSameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

// owner のある head は、host と owner の合う remote。owner が作り先と同じなら、作り先そのものを指す remote だけ（同じ org の fork は head_repo が要るので扱わない）
function pushRemoteFor(head: Readonly<HeadReference>, target: RepositoryReference, host: string, directory: string, primary: string): string | undefined {
  const { owner } = head
  if (owner === undefined) return primary
  const isTargetOwner = isSameName(owner, target.owner)
  return readRemoteLocations(directory).find(({ location }) =>
    isSameName(location.host, host) && isSameName(location.owner, owner) && (!isTargetOwner || isSameName(location.repository, target.repository)),
  )?.remote
}

function hasLocalBranch(directory: string, branch: string): boolean {
  return gitStdout(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: directory }) !== undefined
}

export interface PreflightQuery {
  readonly config: ProjectConfig
  readonly location: RepositoryReference
  readonly directory: string
  readonly head: HeadReference
  /**
  head の base の記録。今のブランチでなければ undefined
  */
  readonly reading: BaseReading | undefined
  /**
  読み取りの結果の親 PR。スタックしていなければ undefined
  */
  readonly lowerPullRequest: PullRequestReadout | undefined
}

// diverged のときの Push Status の直し方。スタックしていれば、スタックし直しが要るかを親 PR と remote の先頭で決める
async function pushFixHintFor(push: PushStatus, query: Readonly<PreflightQuery>, remote: string, signal: Readonly<AbortSignal> | undefined): Promise<HintedText | undefined> {
  if (!push.isDiverged) return undefined
  const { reading, config, location, directory, lowerPullRequest } = query
  if (reading?.kind !== 'stacked') return DIVERGED_FIX_HINT
  const developBranch = getDevelopBranch(config, location.owner, location.repository) ?? ''
  const read = await readRestackDecision({ cwd: directory, remote, reading, developBranch, lowerPullRequest, signal })
  return pushFixHintOf(read.kind === 'decided' ? read.decision : undefined)
}

interface PushCheck {
  readonly push: PushStatus
  readonly fixHint: HintedText | undefined
}

async function checkHeadPush(query: Readonly<PreflightQuery>, primary: string, out: Readonly<Output>): Promise<PushCheck> {
  const { head, location, config, directory } = query
  const remote = pushRemoteFor(head, location, config.host, directory, primary)
  if (remote === undefined) {
    const owner = head.owner ?? ''
    return { push: { isPushed: false, message: `no git remote points to a repository of ${owner} on ${config.host}`, isDiverged: false }, fixHint: hinted`git remote add fork https://${config.host}/${owner}/${location.repository}.git` }
  }
  if (!hasLocalBranch(directory, head.branch)) {
    return { push: { isPushed: false, message: `local branch ${head.branch} does not exist`, isDiverged: false }, fixHint: hinted`git fetch ${remote} ${head.branch}:${head.branch}` }
  }
  const push = getPushStatus(head.branch, directory, remote)
  if (push.isPushed) return { push, fixHint: undefined }
  if (head.owner !== undefined) return { push, fixHint: forkPushFixHint(remote, head.branch, push.isDiverged) }
  return { push, fixHint: await pushFixHintFor(push, query, remote, out.signal) }
}

/**
PR を作る前の手元の引っかかり。push していないか remote とずれたブランチ・変更したファイル・stash の項目の順
*/
export async function preflightWarnings(query: Readonly<PreflightQuery>, out: Readonly<Output>): Promise<readonly PreflightWarning[]> {
  const context = validatePullRequestContext(query.directory, out)
  const { push, fixHint } = await checkHeadPush(query, context.remoteName, out)
  return collectPreflightWarnings({ gitStatus: getGitStatus(query.directory), stashList: getStashList(query.directory), isPushed: push.isPushed, pushMessage: push.message, pushFixHint: fixHint })
}
