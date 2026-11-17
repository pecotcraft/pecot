/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者が指定する */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// pr create・pr show・pr check。cli/commands/pr.py の移植。
// 途中で抜ける箇所は CommandExit を投げ、defineCommand が終了コードにする。
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { activeIssueFromBranch, extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { effectiveReleaseType, findRepository, getDevelopBranch, getFieldId, getOptionId, getReleaseBranch } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { InvalidValueError } from '../domain/errors.js'
import { FrontmatterError } from '../domain/frontmatter.js'
import type { ParsedPullRequest } from '../domain/frontmatter.js'
import { parseRemoteUrl } from '../domain/git-url.js'
import type { RemoteLocation } from '../domain/git-url.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import { jsonField } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { appendIssueCloseIfNeeded, collectPreflightWarnings, decidePullRequestBase, describeBaseStop, describePushStatus, DIVERGED_FIX_HINT, formatPreflightWarning, formatPullRequestMarkdown, formatPullRequestWithReviewsMarkdown, isReleasePullRequest, pickLowerPullRequest, pushFixHintOf, validatePullRequestContent } from '../domain/pull-request.js'
import type { PreflightWarning, PullRequestBaseDecision, PullRequestBaseUse, PushStatus } from '../domain/pull-request.js'
import { parsePythonInteger, pythonStrip } from '../domain/python-format.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import { RESTACK_PATH } from '../domain/restack.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import type { BaseReading } from '../domain/state.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { parsePullRequestFile } from '../infra/frontmatter-file.js'
import { gitCurrentBranch, gitRemoteUrl, gitStdout, gitToplevel, isAncestor, primaryRemoteName, remoteBranchHead, resolveCommit, runGit } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { PullRequestSlim, PullRequestWithReviews } from '../infra/github/pulls.js'
import { TransportFailure } from '../infra/github/client.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { changedFiles, expectedScope, nxProjects, parseTitleScope } from '../infra/nx-scope.js'
import { isFileNotFound } from '../infra/os-error.js'
import { outputDirectory, OutputPathReservationError, resolveRealPath, withReservedOutputPath } from '../infra/paths.js'
import { readTemplateSections, templateFile } from '../infra/template-store.js'
import { readBaseOrInfer, warnUnresolved } from './base-reading.js'
import { readTextFile } from '../infra/text-file.js'
import { commandHint, hinted, inputHint, inputNameHint, joinHinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Operation, Output } from './output.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './command-definition.js'
import { BOARD_MOVE_JSON, moveJson } from './issue-board.js'
import type { BoardMoveLine } from './issue-board.js'
import { PR_MERGE_COMMAND } from './pr-merge.js'
import { parseReference, PR_REFERENCE_DESCRIPTION } from './pr-reference.js'
import { readRestackDecision } from './restack-reading.js'
import type { KnownLowerPullRequest } from './restack-reading.js'
import { moveWaitingIssues } from './pr-waiting.js'

export { parseReference, PR_REFERENCE_DESCRIPTION } from './pr-reference.js'

// 本文の検証の失敗。1（通信・設定・引数）と 2（preflight）と区別する
const VALIDATION_EXIT_CODE = 3
const PREFLIGHT_EXIT_CODE = 2
// 下の段の PR が開いておらず、マージもされていない
const NO_OPEN_BASE_EXIT_CODE = 2

// Python の `{e}` に当たる、例外の文
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function templateKindOf(template: string): 'create' | 'release' {
  return template === 'release' ? 'release' : 'create'
}

export function isPositive(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

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

// タイトルの scope

interface ScopeTarget {
  readonly toplevel: string
  /**
  変更したファイルを求める差分の起点
  */
  readonly from: string
}

/**
積んだ base のときの題の scope の差分の起点。記録のコミット（下の段がマージ済みのときと --prepare）か、下の段のブランチ（開いている間）
*/
type StackedScope = { readonly sha: string } | { readonly branch: string }

// scope を nx のプロジェクトと比べる対象か。release_type が nx で、base が develop か積んだ base で、remote と作業ツリーが対象に合うときだけ。
// 下の段を squash でマージした後は、開発ブランチとの差分がその段のファイルも含むので、記録のコミットから比べる
function nxScopeTarget(config: Readonly<ProjectConfig>, owner: string, repository: string, base: string, directory: string, stacked: StackedScope | undefined): ScopeTarget | undefined {
  const configured = findRepository(config, owner, repository)
  if (configured === undefined || effectiveReleaseType(configured) !== 'nx' || (stacked === undefined && base !== getDevelopBranch(config, owner, repository))) return undefined
  const found = primaryRemote(directory)
  const location = found?.location
  const isSameRepository = location?.owner.toLowerCase() === owner.toLowerCase() && location.repository.toLowerCase() === repository.toLowerCase()
  if (found === undefined || !isSameRepository) return undefined
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined || !isRegularFile(path.join(toplevel, 'nx.json'))) return undefined
  if (stacked === undefined) return { toplevel, from: `${found.name}/${base}` }
  return { toplevel, from: 'sha' in stacked ? stacked.sha : `${found.name}/${stacked.branch}` }
}

// Python の Path.is_file() と同じく、stat の失敗は「無い」と扱う
function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

function expectedTitleScope(target: Readonly<ScopeTarget>, head: string, out: Readonly<Output>): readonly string[] | undefined {
  const projects = nxProjects(target.toplevel)
  const files = projects === undefined ? undefined : changedFiles(target.toplevel, target.from, head)
  if (projects === undefined || files === undefined) {
    out.warning('cannot read nx projects or the diff; skipped the PR title scope check')
    return undefined
  }
  return expectedScope(files, projects)
}

interface TitleScopeQuery {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
  readonly title: string
  readonly base: string
  readonly head: string
  readonly directory: string
  readonly template: string
  readonly developBranch: string | undefined
  readonly releaseBranch: string | undefined
  readonly stacked: StackedScope | undefined
}

function titleScopeErrors(query: Readonly<TitleScopeQuery>, out: Readonly<Output>): readonly string[] {
  const { config, owner, repository, title, base, head, directory, template, developBranch, releaseBranch } = query
  if (isReleasePullRequest(template, base, head, developBranch, releaseBranch)) return []
  const target = nxScopeTarget(config, owner, repository, base, directory, query.stacked)
  if (target === undefined) return []
  const expected = expectedTitleScope(target, head, out)
  if (expected === undefined || expected.length === 0) return []
  const given = parseTitleScope(title)
  if (given !== undefined && new Set(given).size === new Set(expected).size && given.every(scope => expected.includes(scope))) return []
  const shown = given === undefined ? 'none' : given.join(',')
  return [`PR title scope must be ${expected.join(',')} (given: ${shown}; computed from the tags of the changed nx projects)`]
}

// pr create

const PR_CREATE_OUTPUT = z.strictObject({
  url: z.string().optional().describe('URL of the created PR (omitted on dry_run and prepare)'),
  number: z.int().optional().describe('Number of the created PR (omitted on dry_run and prepare, or when the response has none)'),
  head: z.string().optional().describe('Head branch of the PR (omitted on prepare)'),
  base: z.string().optional().describe('Base branch of the PR. On prepare, the base filled into the draft (omitted when it was not filled)'),
  title: z.string().optional().describe('Title of the PR (omitted on prepare)'),
  inReview: z.int().optional().describe('Issue number whose status was set to In Review (omitted when not set)'),
  stack: z.strictObject({
    lower: z.int().describe('PR number of the lower stage the new PR is stacked on'),
    registered: z.boolean().optional().describe('Whether the new PR was registered to the stack (omitted on dry_run)'),
    number: z.int().optional().describe('Stack number (omitted when not registered)'),
  }).optional().describe('Stack of the PR (omitted when the PR is not stacked)'),
  moves: z.array(BOARD_MOVE_JSON).optional().describe('Issues waiting for this PR whose column or Status was written (omitted on dry_run and prepare)'),
  file: z.string().optional().describe('Absolute path of the draft file written on prepare'),
  dryRun: DRY_RUN_FIELD,
})

type PrCreateData = z.input<typeof PR_CREATE_OUTPUT>

function inReviewOperation(issueNumber: number): Operation {
  return { verb: 'set', target: `Issue #${String(issueNumber)} status to In Review` }
}

// Status を In Review にした Issue の番号を返す。書かなかったら undefined
async function updateIssueStatusToInReview(config: Readonly<ProjectConfig>, client: GitHubClient, location: RepositoryReference, headBranch: string, out: Readonly<Output>): Promise<number | undefined> {
  const issueNumber = extractIssueNumberFromBranch(headBranch)
  if (issueNumber === undefined) return undefined
  const label = `Issue #${String(issueNumber)}`

  let itemId: string | undefined
  try {
    itemId = await client.getItemIdByIssue(config.project.id, location.owner, location.repository, issueNumber)
  }
  catch (error: unknown) {
    out.warning(`board item lookup for ${label} failed: ${reasonOf(error)}`)
    return
  }
  if (itemId === undefined) {
    out.warning(`${label} is not on the board; status not updated`)
    return
  }
  const optionId = getOptionId(config, 'workflow', 'in_review')
  if (optionId === undefined) {
    out.warning('workflow field has no in_review status; status not updated')
    return
  }
  const fieldId = getFieldId(config, 'workflow')
  if (fieldId === undefined) {
    out.warning('workflow field not found; status not updated')
    return
  }
  try {
    await client.updateProjectItemField(config.project.id, itemId, fieldId, optionId)
  }
  catch (error: unknown) {
    out.warning(`status update of ${label} failed: ${reasonOf(error)}`)
    return
  }
  out.done(inReviewOperation(issueNumber))
  return issueNumber
}

const LINK_PATH = ['project', 'link']
const PR_CREATE_PATH = ['pr', 'create']

function exitOnUnsetBranch(template: string, base: string, head: string, developBranch: string | undefined, releaseBranch: string | undefined, out: Readonly<Output>): void {
  const isRelease = isReleasePullRequest(template, base, head, developBranch, releaseBranch)
  if (isRelease && (releaseBranch === undefined || releaseBranch === '')) {
    stopWith(out, hinted`release_branch is not set\nset it with: ${commandHint(LINK_PATH, { repo: 'owner/repo', release_branch: 'main' })}`, 'repo-setting-missing')
  }
  if (!isRelease && (developBranch === undefined || developBranch === '')) {
    stopWith(out, hinted`develop_branch is not set\nset it with: ${commandHint(LINK_PATH, { repo: 'owner/repo', develop_branch: 'develop' })}`, 'repo-setting-missing')
  }
}

function resolveHeadBranch(head: string | undefined, directory: string, out: Readonly<Output>): string {
  if (head !== undefined && head !== '') return head
  const current = gitCurrentBranch(directory)
  return current === undefined || current === '' ? stopWith(out, 'cannot determine the head branch', 'git-unresolved') : current
}

async function appendCloseUnlessEpic(config: Readonly<ProjectConfig>, location: RepositoryReference, body: string, issueNumber: number, out: Readonly<Output>): Promise<string> {
  try {
    const kind = await createGitHubClient(out, config.host).getIssueKind(location.owner, location.repository, issueNumber)
    if (!isEpicIssue(kind)) return appendIssueCloseIfNeeded(body, issueNumber)
    out.warning(`Issue #${String(issueNumber)} at the end of the branch is an Epic; Closes not added`)
    return body
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return appendIssueCloseIfNeeded(body, issueNumber)
    throw error
  }
}

function exitOnValidationErrors(errors: readonly (string | HintedText)[], out: Readonly<Output>): void {
  if (errors.length === 0) return
  for (const error of errors) out.error(error)
  throw new CommandExit(VALIDATION_EXIT_CODE, 'content-invalid')
}

interface PullRequestDraft {
  readonly location: RepositoryReference
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly isDraft: boolean
  readonly isRelease: boolean
}

function createOperation(draft: Readonly<PullRequestDraft>): Operation {
  const kind = draft.isDraft ? 'draft PR' : 'PR'
  const suffix = draft.isRelease ? ' (release template)' : ''
  return { verb: 'create', target: `${kind} ${draft.location.owner}/${draft.location.repository} ${draft.head} -> ${draft.base}: ${draft.title}${suffix}` }
}

function printPreflightWarnings(out: Readonly<Output>, warnings: readonly PreflightWarning[]): void {
  for (const warning of warnings) out.warning(formatPreflightWarning(warning))
}

// git の読み取り。失敗は Python の文字列の印にする

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

interface PullRequestContext {
  readonly remoteUrl: string
  readonly currentBranch: string
  readonly location: RemoteLocation
  readonly remoteName: string
}

// pr create の早い確認と pr check が共有する前提。満たさなければ終了コード 1
export function validatePullRequestContext(directory: string, out: Readonly<Output>): PullRequestContext {
  if (gitToplevel({ cwd: directory }) === undefined) stopWith(out, 'not a git repository', 'git-unresolved')
  const found = primaryRemote(directory)
  if (found === undefined) return stopWith(out, 'git remote not found', 'git-unresolved')
  const currentBranch = gitCurrentBranch(directory)
  if (currentBranch === undefined) return stopWith(out, 'cannot determine the current branch', 'git-unresolved')
  if (found.location === undefined) return stopWith(out, 'cannot read repository info from the remote URL\ncheck it with: git remote -v', 'git-unresolved')
  return { remoteUrl: found.url, currentBranch, location: found.location, remoteName: found.name }
}

interface PushFixTarget {
  readonly config: Readonly<ProjectConfig>
  readonly location: Readonly<RemoteLocation>
  readonly directory: string
  readonly remote: string
  readonly client: () => GitHubClient
  /**
  呼び出し側が既に読んだ下の段の PR。あれば読み直さない
  */
  readonly lowerPullRequest?: KnownLowerPullRequest | undefined
}

// diverged のときの Push Status の直し方。積んでいれば載せ直しが要るかを読んで決める。diverged でなければ undefined（git push）
async function pushFixHintFor(push: PushStatus, reading: BaseReading | undefined, target: Readonly<PushFixTarget>): Promise<HintedText | undefined> {
  if (!push.isDiverged) return undefined
  if (reading?.kind !== 'stacked') return DIVERGED_FIX_HINT
  const { config, location, directory, remote, client, lowerPullRequest } = target
  const developBranch = getDevelopBranch(config, location.owner, location.repository) ?? ''
  try {
    const read = await readRestackDecision({ client, owner: location.owner, repository: location.repository, cwd: directory, remote, reading, developBranch, lowerPullRequest })
    return pushFixHintOf(read.kind === 'decided' ? read.decision : undefined)
  }
  catch (error: unknown) {
    if (error instanceof TransportFailure) return pushFixHintOf(undefined)
    throw error
  }
}

interface PreflightBase {
  readonly reading: BaseReading | undefined
  readonly lowerPullRequest: KnownLowerPullRequest | undefined
}

async function runPreflightChecksOrExit(directory: string, base: Readonly<PreflightBase>, config: Readonly<ProjectConfig>, client: () => GitHubClient, out: Readonly<Output>): Promise<void> {
  const context = validatePullRequestContext(directory, out)
  const push = getPushStatus(context.currentBranch, directory, context.remoteName)
  const pushFixHint = await pushFixHintFor(push, base.reading, { config, location: context.location, directory, remote: context.remoteName, client, lowerPullRequest: base.lowerPullRequest })
  const warnings = collectPreflightWarnings({ gitStatus: getGitStatus(directory), stashList: getStashList(directory), isPushed: push.isPushed, pushMessage: push.message, pushFixHint })
  if (warnings.length === 0) return
  out.error('preflight found warnings; fix them before creating a PR')
  printPreflightWarnings(out, warnings)
  throw new CommandExit(PREFLIGHT_EXIT_CODE, 'preflight-failed')
}

// PR を作った後の処理の失敗は warning にとどめ、URL の出力まで進める
function isRequestFailure(error: unknown): error is GitHubAPIError | TransportFailure {
  return error instanceof GitHubAPIError || error instanceof TransportFailure
}

function describeRequestFailure(error: GitHubAPIError | TransportFailure): string {
  return error instanceof GitHubAPIError ? describeApiError(error) : error.message
}

// 1 回の pr create で、クライアントを作るのは要るときの 1 回だけにする
function lazyClient(config: Readonly<ProjectConfig>, out: Readonly<Output>): () => GitHubClient {
  let client: GitHubClient | undefined
  return () => {
    client ??= createGitHubClient(out, config.host)
    return client
  }
}

type StackResult = NonNullable<PrCreateData['stack']>

// 下の段の PR が入っているスタックに足す。無ければ下の段と新しい PR で作る。失敗は warning にとどめる
async function registerStack(client: GitHubClient, location: RepositoryReference, lower: number, created: number | undefined, out: Readonly<Output>): Promise<StackResult> {
  const unregistered: StackResult = { lower, registered: false }
  if (created === undefined) {
    out.warning('could not register stack: the PR creation response has no PR number')
    return unregistered
  }
  try {
    const stack = await client.getStackOfPullRequest(location.owner, location.repository, lower)
    const top = stack?.pullRequests.at(-1)
    // GitHub は一番上にしか足せないので、同じ下の段に 2 つ目を積んだときは 422 を待たずに知らせる
    if (stack !== undefined && top !== lower) {
      out.warning(`could not register stack: PR #${String(lower)} is not the top of stack #${String(stack.number)} (top: PR #${String(top)}); PR #${String(created)} was not added`)
      return unregistered
    }
    const registered = stack === undefined
      ? await client.createStack(location.owner, location.repository, [lower, created])
      : await client.addToStack(location.owner, location.repository, stack.number, [created])
    out.done({ verb: 'add', target: `PR #${String(created)} to stack #${String(registered.number)}` })
    return { lower, registered: true, number: registered.number }
  }
  catch (error: unknown) {
    if (!isRequestFailure(error)) throw error
    out.warning(`could not register stack: ${describeRequestFailure(error)}`)
    return unregistered
  }
}

// moves に、書けた列と札を足していく。例外で止まっても、それまでの分が残る
async function moveWaitingIssuesSafely(client: GitHubClient, config: Readonly<ProjectConfig>, location: RepositoryReference, issueNumber: number, pullRequest: number | undefined, out: Readonly<Output>, moves: BoardMoveLine[]): Promise<void> {
  try {
    await moveWaitingIssues(out, client, config, { repository: location, issueNumber, pullRequest }, moves)
  }
  catch (error: unknown) {
    if (!isRequestFailure(error)) throw error
    out.warning(`could not move the Issues waiting for #${String(issueNumber)}: ${describeRequestFailure(error)}`)
  }
}

async function submitPullRequest(config: Readonly<ProjectConfig>, client: () => GitHubClient, directory: string, draft: Readonly<PullRequestDraft>, stackOn: number | undefined, base: Readonly<PreflightBase>, out: Readonly<Output<PrCreateData>>): Promise<void> {
  await runPreflightChecksOrExit(directory, base, config, client, out)
  let created: JsonObject
  try {
    created = await client().createPullRequest(draft.location.owner, draft.location.repository, draft.title, draft.body, draft.head, draft.base, draft.isDraft)
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, `PR creation failed: ${error.message}`, kindOfFailure(error))
    throw error
  }
  out.done(createOperation(draft))
  const createdNumber = jsonField(created, 'number')
  const pullRequest = typeof createdNumber === 'number' ? createdNumber : undefined
  const url = jsonField(created, 'html_url')
  // url は先に渡す。後の処理が例外で止まっても、作った PR を結果から読める
  out.result({ head: draft.head, base: draft.base, title: draft.title, ...pullRequest !== undefined && { number: pullRequest }, ...typeof url === 'string' && { url } })
  const inReview = draft.isRelease ? undefined : await updateIssueStatusToInReview(config, client(), draft.location, draft.head, out)
  if (inReview !== undefined) out.result({ inReview })
  if (stackOn !== undefined) out.result({ stack: await registerStack(client(), draft.location, stackOn, pullRequest, out) })
  const issueNumber = extractIssueNumberFromBranch(draft.head)
  const moves: BoardMoveLine[] = []
  try {
    if (!draft.isRelease && isPositive(issueNumber)) await moveWaitingIssuesSafely(client(), config, draft.location, issueNumber, pullRequest, out, moves)
  }
  finally {
    out.result({ moves: moves.map(move => moveJson(move)) })
  }
  if (typeof url !== 'string') return stopWith(out, 'PR was created, but the response has no html_url; find it on GitHub', 'other')
  out.data(url)
}

interface ValidatedInput {
  readonly config: ProjectConfig
  readonly directory: string
  readonly template: string
  readonly noIssueRef: boolean
  readonly dryRun: boolean
  readonly location: RepositoryReference
  readonly title: string
  readonly base: string
  readonly head: string
  readonly isDraft: boolean
  readonly body: string
  readonly screenshot: string | undefined
  /**
  base の記録。head が今のブランチでないときとリリース PR では読まず undefined
  */
  readonly reading: BaseReading | undefined
}

export function stopOnMalformedRecord(reading: BaseReading, out: Readonly<Output>): void {
  if (reading.kind === 'malformed') stopWith(out, describeBaseStop({ kind: 'stop', reason: 'malformed', content: reading.content }).join('\n'), 'content-invalid')
}

// 記録を使うのは、head が今のブランチで、release のテンプレートでないときだけ。形が誤っていれば終了コード 1 で止める。
// 記録のコミットが head の履歴に無ければ、別のブランチの記録か、手で載せ直した後の古い記録なので止める。開発ブランチ向けに作ると下の段の差分が入りうるため。
// 記録が無く積んだ先を求められないときも、同じ理由で投稿を止める
async function readBaseRecordFor(head: string, input: Readonly<{ template: string, dryRun: boolean }>, directory: string, target: Readonly<RecordTarget>, out: Readonly<Output>): Promise<BaseReading | undefined> {
  if (input.template === 'release' || head !== gitCurrentBranch(directory)) return undefined
  const base = await readBaseOrInfer({ directory, project: { config: target.config, client: lazyClient(target.config, out) } })
  if (base.unresolved !== undefined && !input.dryRun) {
    return stopWith(out, joinHinted([
      `cannot infer the stacked base: ${base.unresolved}`,
      'the PR is not created, since a PR to the develop branch can include the changes of the layer below',
      'fix the cause and run again, or run pr create in the work directory where session start wrote .pecot/state/.pecot-base',
    ]), 'git-unresolved')
  }
  warnUnresolved(base, out)
  const { reading } = base
  stopOnMalformedRecord(reading, out)
  if (reading.kind !== 'stacked') return reading
  const { branch, sha } = reading.record
  // 手元が知らないコミットは、履歴に無いと決められないので止めない
  if (resolveCommit(directory, sha) === undefined || isAncestor(directory, sha, head)) return reading
  const isRestacked = await isRestackedLocally(reading, directory, target, out)
  return stopWith(out, joinHinted([
    `.pecot-base records ${branch} at ${sha.slice(0, 7)}, which is not in the history of ${head}`,
    ...isRestacked ? [hinted`${head} is already restacked; rewrite the record with: ${commandHint(RESTACK_PATH)}`] : [],
    hinted`run pr create on the branch the record was written for, or pass ${inputHint(PR_CREATE_PATH, 'head', head)} to create the PR without the record`,
  ]), 'git-unresolved')
}

interface RecordTarget {
  readonly config: Readonly<ProjectConfig>
  readonly location: RepositoryReference
}

// pr restack と同じ判断で、載せ直し済み（rebased）か。下の段の PR か remote を読めなければ false
async function isRestackedLocally(reading: Extract<BaseReading, { kind: 'stacked' }>, directory: string, target: Readonly<RecordTarget>, out: Readonly<Output>): Promise<boolean> {
  const { config, location } = target
  const developBranch = getDevelopBranch(config, location.owner, location.repository) ?? ''
  try {
    const read = await readRestackDecision({ client: lazyClient(config, out), owner: location.owner, repository: location.repository, cwd: directory, remote: primaryRemoteName(directory), reading, developBranch })
    return read.kind === 'decided' && read.decision.kind === 'rebased'
  }
  catch (error: unknown) {
    if (error instanceof TransportFailure) return false
    throw error
  }
}

interface BaseDecided {
  readonly decision: PullRequestBaseDecision
  /**
  読んだ下の段の PR。積んだ記録でなければ読まず undefined
  */
  readonly lowerPullRequest: KnownLowerPullRequest | undefined
}

// 積んだ記録なら、PR を作るリポで下の段の PR を読み、base を決める
async function decideBase(input: Readonly<ValidatedInput>, client: () => GitHubClient, developBranch: string, out: Readonly<Output>): Promise<BaseDecided> {
  const { reading, base, location } = input
  if (reading === undefined) return { decision: { kind: 'use', base, stackOn: undefined, stackedBase: undefined, isLowerMerged: false }, lowerPullRequest: undefined }
  if (reading.kind !== 'stacked') return { decision: decidePullRequestBase({ reading, base, developBranch }), lowerPullRequest: undefined }
  const { branch } = reading.record
  try {
    const found = await client().listPullRequestsByHead(location.owner, location.repository, branch)
    const lower = pickLowerPullRequest(found.pullRequests)
    return { decision: decidePullRequestBase({ reading, base, developBranch, lowerPullRequest: lower }), lowerPullRequest: { pullRequest: lower } }
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, `cannot read the PR of the base branch ${branch}: ${describeApiError(error)}`, kindOfFailure(error))
    throw error
  }
}

// 下の段の PR が開いているのに開発ブランチを渡したときは、内容の検証の失敗と一緒に出す（終了コード 3）
function useOrStop(decision: PullRequestBaseDecision, out: Readonly<Output>): { readonly use: PullRequestBaseUse | undefined, readonly errors: readonly string[] } {
  if (decision.kind === 'use') return { use: decision, errors: [] }
  const lines = describeBaseStop(decision)
  if (decision.reason === 'lower-open') return { use: undefined, errors: lines }
  if (decision.reason === 'malformed') return stopWith(out, lines.join('\n'), 'content-invalid')
  return stopWith(out, lines.join('\n'), 'pr-state', NO_OPEN_BASE_EXIT_CODE)
}

// 下の段がマージ済みなら記録のコミットから、開いていてそのブランチへ作るならそのブランチから、題の scope を比べる
function stackedScopeOf(reading: BaseReading | undefined, use: Readonly<PullRequestBaseUse> | undefined): StackedScope | undefined {
  if (use === undefined || reading?.kind !== 'stacked') return undefined
  if (use.isLowerMerged) return { sha: reading.record.sha }
  return use.stackOn === undefined ? undefined : { branch: reading.record.branch }
}

// 検証して、dry-run なら計画を出し、そうでなければ投稿する。file と -m の両方がここを通る
async function validateAndSubmit(input: Readonly<ValidatedInput>, out: Readonly<Output<PrCreateData>>): Promise<void> {
  const { config, directory, template, location, title, head } = input
  const client = lazyClient(config, out)
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  const releaseBranch = getReleaseBranch(config, location.owner, location.repository)
  exitOnUnsetBranch(template, input.base, head, developBranch, releaseBranch, out)
  const decided = await decideBase(input, client, developBranch ?? '', out)
  const { use, errors: baseErrors } = useOrStop(decided.decision, out)
  const base = use?.base ?? input.base
  const stacked = stackedScopeOf(input.reading, use)
  const requiredSections = readTemplateSections(templateFile('pr', templateKindOf(template)))
  const errors = [
    ...validatePullRequestContent({
      body: input.body,
      base,
      developBranch,
      releaseBranch,
      head,
      template,
      skipIssueReferenceCheck: input.noIssueRef,
      screenshot: input.screenshot,
      requiredSections,
      stackedBase: use?.stackedBase,
    }),
    ...baseErrors,
    ...titleScopeErrors({ config, owner: location.owner, repository: location.repository, title, base, head, directory, template, developBranch, releaseBranch, stacked }, out),
  ]
  exitOnValidationErrors(errors, out)

  const isRelease = template === 'release'
  const draft: PullRequestDraft = { location, title, body: input.body, head, base, isDraft: input.isDraft, isRelease }
  if (!input.dryRun) {
    await submitPullRequest(config, client, directory, draft, use?.stackOn, { reading: input.reading, lowerPullRequest: decided.lowerPullRequest }, out)
    return
  }
  out.planned(createOperation(draft))
  const issueNumber = extractIssueNumberFromBranch(head)
  if (!isRelease && issueNumber !== undefined) out.planned(inReviewOperation(issueNumber))
  if (use?.stackOn !== undefined) out.planned({ verb: 'add', target: `the new PR to the stack of PR #${String(use.stackOn)}` })
  out.result({ head, base, title, ...use?.stackOn !== undefined && { stack: { lower: use.stackOn } } })
}

function requireRepository(value: string, out: Readonly<Output>): RepositoryReference {
  return splitOwnerRepository(value) ?? stopWith(out, `invalid repository format: ${value} (expected: owner/repo)`, 'invalid-input')
}

interface FileModeInput {
  readonly file: string
  readonly template: string
  readonly noIssueRef: boolean
  readonly dryRun: boolean
}

async function createFromFile(input: Readonly<FileModeInput>, directory: string, out: Readonly<Output<PrCreateData>>): Promise<void> {
  const config = requireActiveConfigPlain(out)
  let parsed: ParsedPullRequest
  try {
    parsed = parsePullRequestFile(input.file)
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return stopWith(out, error.message, 'content-invalid')
    throw error
  }
  const { frontmatter } = parsed
  if (frontmatter.repository === '' || !frontmatter.repository.includes('/')) return stopWith(out, 'repository is required (e.g. owner/repo)', 'content-invalid')
  const location = requireRepository(frontmatter.repository, out)
  const head = resolveHeadBranch(frontmatter.head, directory, out)
  const reading = await readBaseRecordFor(head, input, directory, { config, location }, out)

  let body = parsed.body
  const issueNumber = extractIssueNumberFromBranch(head)
  if (input.template !== 'release' && !input.noIssueRef && isPositive(issueNumber)) {
    body = await appendCloseUnlessEpic(config, location, body, issueNumber, out)
  }
  await validateAndSubmit({
    config,
    directory,
    template: input.template,
    noIssueRef: input.noIssueRef,
    dryRun: input.dryRun,
    location,
    title: frontmatter.title,
    base: frontmatter.base,
    head,
    isDraft: frontmatter.draft,
    body,
    screenshot: frontmatter.screenshot,
    reading,
  }, out)
}

interface DirectModeInput {
  readonly message: string
  readonly title: string
  readonly base: string
  readonly head: string | undefined
  readonly isDraft: boolean
  readonly dryRun: boolean
  readonly repository: string | undefined
  readonly noIssueRef: boolean
  readonly template: string
  readonly screenshot: string | undefined
}

async function createDirect(input: Readonly<DirectModeInput>, directory: string, out: Readonly<Output<PrCreateData>>): Promise<void> {
  const config = requireActiveConfigPlain(out)
  let location: RepositoryReference
  if (input.repository === undefined || input.repository === '') {
    const [only] = config.repositories
    if (only === undefined || config.repositories.length !== 1) return stopWith(out, hinted`specify the repository (${inputHint(PR_CREATE_PATH, 'repo', placeholder('owner/repo'))})`, 'invalid-input')
    location = { owner: only.owner, repository: only.name }
  }
  else {
    location = requireRepository(input.repository, out)
  }
  const head = resolveHeadBranch(input.head, directory, out)
  const reading = await readBaseRecordFor(head, input, directory, { config, location }, out)

  let body = input.message
  const issueNumber = extractIssueNumberFromBranch(head)
  if (input.template !== 'release' && !input.noIssueRef && isPositive(issueNumber)) {
    body = appendIssueCloseIfNeeded(body, issueNumber)
  }
  await validateAndSubmit({
    config,
    directory,
    template: input.template,
    noIssueRef: input.noIssueRef,
    dryRun: input.dryRun,
    location,
    title: input.title,
    base: input.base,
    head,
    isDraft: input.isDraft,
    body,
    screenshot: input.screenshot,
    reading,
  }, out)
}

// --prepare

function addScopeHint(content: string, config: Readonly<ProjectConfig>, location: RepositoryReference, base: string, directory: string, stacked: StackedScope | undefined, out: Readonly<Output>): string {
  const target = nxScopeTarget(config, location.owner, location.repository, base, directory, stacked)
  if (target === undefined) return content
  const head = gitCurrentBranch(directory)
  const expected = head === undefined || head === '' ? undefined : expectedTitleScope(target, head, out)
  if (expected === undefined || expected.length === 0) return content
  const scope = expected.join(',')
  // コメントは閉じの引用符の後ろに置き、YAML の title を "" のままにする
  const hinted = content.replace(/^(title:\s*"[^"]*")/mu, (_matched, title: string) => `${title}  # expected scope: ${scope}`)
  out.done({ verb: 'set', target: `title scope hint to ${scope}` })
  return hinted
}

async function fillClosesInTemplate(content: string, config: Readonly<ProjectConfig> | undefined, directory: string, location: RemoteLocation | undefined, out: Readonly<Output>): Promise<string> {
  // 作業中の Issue は remote とブランチ名から決める。古い .pecot-active は読まない
  const active = activeIssueFromBranch(location, gitCurrentBranch(directory))
  if (active === undefined) return content
  const target = { owner: active.repository.owner, repository: active.repository.repository, number: active.number }

  const label = `Issue #${String(target.number)}`
  try {
    const kind = await createGitHubClient(out, config?.host).getIssueKind(target.owner, target.repository, target.number)
    if (isEpicIssue(kind)) {
      out.warning(`${label} is an Epic; Closes left empty`)
      return content
    }
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) {
      out.warning(`kind check of ${label} failed: ${error.message}; fill Closes by hand`)
      return content
    }
    throw error
  }
  const pattern = /^Closes #\s*$/mu
  if (!pattern.test(content)) return content
  out.done({ verb: 'set', target: `Closes to #${String(target.number)}` })
  return content.replace(pattern, () => `Closes #${String(target.number)}`)
}

async function prepareTemplate(directory: string, out: Readonly<Output<PrCreateData>>, template: string): Promise<void> {
  const templatePath = templateFile('pr', templateKindOf(template))
  if (!existsSync(templatePath)) stopWith(out, `template not found: ${templatePath}`, 'other')
  let content = readTextFile(templatePath)

  // release テンプレートは、base をテンプレートの既定（main）のままにする
  if (template !== 'release') {
    // 下の段の PR がマージ済みかは、準備と投稿の間に変わりうるので、ここでは読まずに投稿のときに見る
    const config = loadActiveConfig()
    const base = await readBaseOrInfer({ directory, project: config === undefined ? undefined : { config, client: lazyClient(config, out) } })
    warnUnresolved(base, out)
    const { reading } = base
    stopOnMalformedRecord(reading, out)
    const record = reading.kind === 'stacked' ? reading.record : undefined
    const location = primaryRemote(directory)?.location
    if (location !== undefined) {
      const developBranch = config === undefined ? undefined : getDevelopBranch(config, location.owner, location.repository)
      if (config !== undefined && developBranch !== undefined && developBranch !== '') {
        const base = record?.branch ?? developBranch
        content = content.replace(/^base:\s*"[^"]*"/mu, () => `base: "${base}"`)
        out.done({ verb: 'set', target: `base to ${base}` })
        out.result({ base })
        content = addScopeHint(content, config, { owner: location.owner, repository: location.repository }, base, directory, record === undefined ? undefined : { sha: record.sha }, out)
      }
    }
    content = await fillClosesInTemplate(content, config, directory, location, out)
  }

  const prefix = template === 'release' ? 'pr-release' : 'pr-create'
  try {
    withReservedOutputPath(outputDirectory(), timestamp => `${prefix}-${timestamp}.md`, (reserved) => {
      writeFileSync(reserved, content, 'utf8')
      out.result({ file: path.resolve(reserved) })
      out.data(reserved)
    })
  }
  catch (error: unknown) {
    if (error instanceof OutputPathReservationError) return stopWith(out, error.message, 'other')
    throw error
  }
}

const CreateInputSchema = z.strictObject({
  file: z.string().optional().describe('Path to a Markdown file with front matter'),
  message: z.string().optional().describe('PR body, given directly'),
  title: z.string().optional().describe('PR title (required with -m)'),
  base: z.string().optional().describe('Base branch (required with -m)'),
  head: z.string().optional().describe('Head branch (default: the current branch)'),
  draft: z.boolean().default(false).describe('Create as a draft PR'),
  prepare: z.boolean().default(false).describe('Copy the template to the work directory'),
  dry_run: z.boolean().default(false).describe('Validate only (skip the early preflight check, do not create the PR)'),
  repo: z.string().optional().describe('Repository in owner/repo form (with -m)'),
  no_issue_ref: z.boolean().default(false).describe('Skip the automatic related-Issue setup (extraction from the branch name, adding it to the body, and the validation check)'),
  template: z.string().default('default').describe('PR template kind (default / release)'),
  screenshot: z.string().optional().describe('Reason to omit an image from Summary (with -m)'),
})

async function runCreate(input: Readonly<z.output<typeof CreateInputSchema>>, io: Readonly<CommandIo>): Promise<void> {
  const directory = process.cwd()
  const out = createOutput<PrCreateData>(input.dry_run, io)
  if (input.template !== 'default' && input.template !== 'release') stopWith(out, hinted`${inputNameHint(PR_CREATE_PATH, 'template')} must be 'default' or 'release' (given: ${input.template})`, 'invalid-input')

  if (input.prepare) {
    await prepareTemplate(directory, createOutput<PrCreateData>(false, io), input.template)
  }
  else if (input.file !== undefined) {
    if (input.screenshot !== undefined) stopWith(out, hinted`${inputNameHint(PR_CREATE_PATH, 'screenshot')} is for ${inputNameHint(PR_CREATE_PATH, 'message')}; write the reason in the \`screenshot\` frontmatter field instead`, 'invalid-input')
    await createFromFile({ file: input.file, template: input.template, noIssueRef: input.no_issue_ref, dryRun: input.dry_run }, directory, out)
  }
  else if (input.message === undefined) {
    stopWith(out, hinted`missing arguments\nusage:\n${commandHint(PR_CREATE_PATH, { prepare: true })}\n${commandHint(PR_CREATE_PATH, { file: placeholder('path') })}\n${commandHint(PR_CREATE_PATH, { message: placeholder('body'), title: placeholder('title'), base: placeholder('base-branch') })}`, 'invalid-input')
  }
  else {
    if (input.title === undefined || input.title === '' || input.base === undefined || input.base === '') stopWith(out, hinted`${inputNameHint(PR_CREATE_PATH, 'title')} and ${inputNameHint(PR_CREATE_PATH, 'base')} (base branch) are required with ${inputNameHint(PR_CREATE_PATH, 'message')}`, 'invalid-input')
    await createDirect({
      message: input.message,
      title: input.title,
      base: input.base,
      head: input.head,
      isDraft: input.draft,
      dryRun: input.dry_run,
      repository: input.repo,
      noIssueRef: input.no_issue_ref,
      template: input.template,
      screenshot: pythonStrip(input.screenshot ?? '') || undefined,
    }, directory, out)
  }
}

// pr show

const ShowInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  json: z.boolean().default(false).describe('Output as JSON'),
  reviews: z.boolean().default(false).describe('Include review details (bodies and line comments)'),
})

const ISSUE_LINK_JSON = z.strictObject({
  number: z.int().describe('Issue number'),
  title: z.string().describe('Title of the Issue (empty for referenced_issues)'),
})

const REVIEW_JSON = z.strictObject({
  state: z.string().describe('State of the review'),
  author: z.string().nullable().describe('Login of the reviewer (null when deleted)'),
  body: z.string().optional().describe('Body of the review (only with reviews)'),
  submitted_at: z.string().nullable().optional().describe('Submission time (only with reviews)'),
})

const REVIEW_COMMENT_JSON = z.strictObject({
  author: z.string().nullable().describe('Login of the author (null when deleted)'),
  body: z.string().describe('Body of the comment'),
  created_at: z.string().nullable().describe('Creation time'),
})

const REVIEW_THREAD_JSON = z.strictObject({
  is_resolved: z.boolean().describe('Whether the thread is resolved'),
  path: z.string().nullable().describe('File path of the thread'),
  line: z.int().nullable().describe('Line of the thread'),
  comments: z.array(REVIEW_COMMENT_JSON).describe('Comments in the thread'),
})

const PR_SHOW_OUTPUT = z.strictObject({
  number: z.int().describe('PR number'),
  state: z.string().describe('State of the PR (OPEN, CLOSED or MERGED)'),
  title: z.string().describe('Title of the PR'),
  body: z.string().describe('Body of the PR'),
  head_ref: z.string().describe('Head branch'),
  base_ref: z.string().describe('Base branch'),
  is_draft: z.boolean().describe('Whether the PR is a draft'),
  mergeable: z.string().describe('Mergeability (MERGEABLE, CONFLICTING or UNKNOWN)'),
  comments: z.int().describe('Number of comments'),
  closing_issues: z.array(ISSUE_LINK_JSON).describe('Issues the PR closes'),
  referenced_issues: z.array(ISSUE_LINK_JSON).describe('Issues referenced by Refs in the body and not in closing_issues'),
  reviews: z.array(REVIEW_JSON).describe('Reviews'),
  review_threads: z.array(REVIEW_THREAD_JSON).optional().describe('Line comment threads (only with reviews)'),
})

type PrShowJson = z.input<typeof PR_SHOW_OUTPUT>

/**
--json の標準出力と MCP の data の中身。キーを並べた順が --json の出力の順になる
*/
function pullRequestJson(pr: Readonly<PullRequestSlim> | Readonly<PullRequestWithReviews>): PrShowJson {
  // 項目を手で並べるので、satisfies で PR の型の項目の過不足を tsc に止めさせる
  const base = {
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head_ref: pr.head_ref,
    base_ref: pr.base_ref,
    is_draft: pr.is_draft,
    mergeable: pr.mergeable,
    comments: pr.comments,
    closing_issues: pr.closing_issues.map(issue => ({ ...issue })),
    referenced_issues: pr.referenced_issues.map(issue => ({ ...issue })),
    reviews: pr.reviews.map(review => ({ ...review })),
  } satisfies Record<keyof PullRequestSlim, unknown>
  return 'review_threads' in pr ? { ...base, review_threads: pr.review_threads.map(thread => ({ ...thread, comments: thread.comments.map(comment => ({ ...comment })) })) } satisfies Record<keyof PullRequestWithReviews, unknown> : base
}

async function runShow(input: Readonly<z.output<typeof ShowInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<PrShowJson>(false, io)
  const config = requireActiveConfigPlain(out)
  const { owner, repository, number } = parseReference(input.pr_ref, input.repo, out)
  try {
    const client = createGitHubClient(out, config.host)
    if (input.reviews) {
      const pr = await client.getPullRequestWithReviews(owner, repository, number)
      const json = pullRequestJson(pr)
      out.result(json)
      out.data(`${input.json ? JSON.stringify(json, undefined, 2) : formatPullRequestWithReviewsMarkdown(pr, owner, repository)}\n`)
    }
    else {
      const pr = await client.getPullRequestSlim(owner, repository, number)
      const json = pullRequestJson(pr)
      out.result(json)
      out.data(`${input.json ? JSON.stringify(json, undefined, 2) : formatPullRequestMarkdown(pr)}\n`)
    }
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, error.message, kindOfFailure(error))
    throw error
  }
}

// pr check

function hasBranch(branch: string, cwd: string): boolean {
  return runGit(['rev-parse', '--verify', branch], { cwd }).exitCode === 0
}

// 下の段のブランチがマージで消えた後は、開発ブランチと比べる。追跡参照は fetch --prune まで残るので、
// remote に尋ね、無いと答えたときだけ消えたとみなす。届かないか時間切れなら追跡参照で決める
function isOnRemote(branch: string, cwd: string, remote: string, out: Readonly<Output>): boolean {
  const head = remoteBranchHead(cwd, remote, branch)
  if (head.isReachable && head.sha === undefined) return false
  const isTracked = hasBranch(`${remote}/${branch}`, cwd)
  if (!isTracked && head.isReachable) out.warning(`base branch ${branch} is on ${remote}, but ${remote}/${branch} is not fetched; compared with the develop branch\nrun: git fetch ${remote} ${branch}`)
  return isTracked
}

function determineBaseBranch(config: Readonly<ProjectConfig>, reading: BaseReading, location: Readonly<RemoteLocation>, cwd: string, remote: string, out: Readonly<Output>): string {
  if (reading.kind === 'stacked' && isOnRemote(reading.record.branch, cwd, remote, out)) return `${remote}/${reading.record.branch}`
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    return stopWith(out, hinted`develop_branch is not set for ${location.owner}/${location.repository}\nset it with: ${commandHint(LINK_PATH, { repo: `${location.owner}/${location.repository}`, develop_branch: 'develop' })}`, 'repo-setting-missing')
  }
  const branchName = `${remote}/${developBranch}`
  return hasBranch(branchName, cwd) ? branchName : stopWith(out, `branch ${branchName} does not exist\ncheck the remote branches with: git branch -r`, 'git-unresolved')
}

function readGitignore(cwd: string): string {
  const root = gitToplevel({ cwd })
  if (root === undefined) return '(not a git repository)'
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return '(no .gitignore)'
  try {
    return readTextFile(file)
  }
  catch {
    return '(read error)'
  }
}

function readGitExclude(cwd: string): string {
  try {
    const common = gitStdout(['rev-parse', '--git-common-dir'], { cwd })
    if (common === undefined) return '(read error)'
    const file = path.join(path.resolve(cwd, pythonStrip(common)), 'info', 'exclude')
    return existsSync(file) ? readTextFile(file) : '(no exclude)'
  }
  catch {
    return '(read error)'
  }
}

const PR_CHECK_OUTPUT = z.strictObject({
  remoteUrl: z.string().describe('URL of the primary git remote'),
  currentBranch: z.string().describe('Current branch'),
  pushed: z.boolean().describe('Whether the current branch is pushed and even with its remote branch'),
  pushStatus: z.string().describe('Push status as shown in the Push Status section'),
  baseBranch: z.string().describe('Remote branch compared against (remote/branch): the lower stage when stacked, else the develop branch'),
  gitStatus: z.string().describe('Output of git status'),
  commits: z.string().describe('Commits since the base branch, as shown in the Commits section'),
  diffSummary: z.string().describe('Diff stat against the base branch, as shown in the Diff Summary section'),
  worktree: z.strictObject({
    list: z.string().describe('Output of git worktree list'),
    directoryName: z.string().describe('Name of the current directory'),
    isWorktree: z.boolean().optional().describe('Whether the directory is a linked worktree (omitted when it could not be determined)'),
  }).describe('Worktree information'),
  stashList: z.string().describe('Stash list, as shown in the Stash List section'),
})

type PrCheckData = z.input<typeof PR_CHECK_OUTPUT>

function readWorktreeInfo(cwd: string): PrCheckData['worktree'] {
  const listed = gitStdout(['worktree', 'list'], { cwd })
  const list = listed === undefined ? '(git worktree list failed)' : pythonStrip(listed)
  const directoryName = path.basename(cwd)
  const gitDirectory = gitStdout(['rev-parse', '--git-dir'], { cwd })
  const commonDirectory = gitDirectory === undefined ? undefined : gitStdout(['rev-parse', '--git-common-dir'], { cwd })
  if (gitDirectory === undefined || commonDirectory === undefined) return { list, directoryName }
  const isWorktree = resolveRealPath(path.resolve(cwd, pythonStrip(gitDirectory))) !== resolveRealPath(path.resolve(cwd, pythonStrip(commonDirectory)))
  return { list, directoryName, isWorktree }
}

function formatWorktreeInfo(info: Readonly<PrCheckData['worktree']>): string {
  const worktreeText = info.isWorktree === undefined ? '(unknown)' : String(info.isWorktree)
  return [info.list, '', `Current directory name: ${info.directoryName}`, `Is worktree environment: ${worktreeText}`].join('\n')
}

const CheckInputSchema = z.strictObject({
  directory: directorySchema,
})

async function runCheck(input: Readonly<z.output<typeof CheckInputSchema>>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<PrCheckData>(false, io)
  const directory = input.directory
  const context = validatePullRequestContext(directory, out)
  const config = loadActiveConfig()
  if (config === undefined) return stopWith(out, hinted`project config not found\nactivate a project with: ${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`, 'no-active-project')
  const base = await readBaseOrInfer({ directory, project: { config, client: lazyClient(config, out) } })
  warnUnresolved(base, out)
  const { reading } = base
  stopOnMalformedRecord(reading, out)
  const baseBranch = determineBaseBranch(config, reading, context.location, directory, context.remoteName, out)

  const gitStatus = getGitStatus(directory)
  const commits = gitStdout(['log', '--oneline', `${baseBranch}..HEAD`], { cwd: directory })
  const diffSummary = gitStdout(['diff', '--stat', `${baseBranch}...HEAD`], { cwd: directory })
  const push = getPushStatus(context.currentBranch, directory, context.remoteName)
  const stashList = getStashList(directory)
  const commitsText = commits === undefined ? '(git log failed)' : pythonStrip(commits) || '(no commits)'
  const diffText = diffSummary === undefined ? '(git diff failed)' : pythonStrip(diffSummary) || '(no diff)'
  const worktree = readWorktreeInfo(directory)
  // preflight の warning で失敗に終わっても、集めた値を data に残す
  out.result({ remoteUrl: context.remoteUrl, currentBranch: context.currentBranch, pushed: push.isPushed, pushStatus: push.message, baseBranch, gitStatus, commits: commitsText, diffSummary: diffText, worktree, stashList })

  const sections: readonly (readonly [string, string])[] = [
    ['=== Git Remote ===', context.remoteUrl],
    ['=== Current Branch ===', context.currentBranch],
    ['=== Push Status ===', push.message],
    ['=== Base Branch ===', baseBranch],
    ['=== Git Status ===', gitStatus],
    ['=== .gitignore ===', readGitignore(directory)],
    ['=== Git Exclude ===', readGitExclude(directory)],
    [`=== Commits (vs ${baseBranch}) ===`, commitsText],
    [`=== Diff Summary (vs ${baseBranch}) ===`, diffText],
    ['=== Worktree Info ===', formatWorktreeInfo(worktree)],
    ['=== Stash List ===', stashList],
  ]
  for (const [index, [heading, content]] of sections.entries()) {
    if (index > 0) out.data('\n')
    out.data(`${heading}\n`)
    out.data(`${content}\n`)
  }

  const pushFixHint = await pushFixHintFor(push, reading, { config, location: context.location, directory, remote: context.remoteName, client: lazyClient(config, out) })
  const warnings = collectPreflightWarnings({ gitStatus, stashList, isPushed: push.isPushed, pushMessage: push.message, pushFixHint })
  out.count('preflight warnings', warnings.length)
  printPreflightWarnings(out, warnings)
  if (warnings.length > 0) throw new CommandExit(PREFLIGHT_EXIT_CODE, 'preflight-failed')
}

const prCreate = defineCommand({
  path: PR_CREATE_PATH,
  description: 'Create a PR (pull request)',
  input: CreateInputSchema,
  output: PR_CREATE_OUTPUT,
  positional: ['file'],
  shortFlags: { message: '-m', title: '-t', base: '-b', draft: '-d', prepare: '-p', dry_run: '-n', repo: '-r' },
  hasOwnRepo: true,
  interactive: false,
  run: async (input, io) => {
    await runCreate(input, io)
    return 0
  },
})

const prShow = defineCommand({
  path: ['pr', 'show'],
  description: 'Get PR details efficiently (GraphQL, only the needed fields)',
  input: ShowInputSchema,
  output: PR_SHOW_OUTPUT,
  positional: ['pr_ref'],
  shortFlags: { json: '-j', reviews: '-r' },
  interactive: false,
  run: async (input, io) => {
    await runShow(input, io)
    return 0
  },
})

const prCheck = defineCommand({
  path: ['pr', 'check'],
  description: 'Show all the information to check before creating a PR',
  input: CheckInputSchema,
  output: PR_CHECK_OUTPUT,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input, io) => {
    await runCheck(input, io)
    return 0
  },
})

export const PR_COMMANDS: readonly CommandDefinition[] = [prCreate, prShow, prCheck, PR_MERGE_COMMAND]
