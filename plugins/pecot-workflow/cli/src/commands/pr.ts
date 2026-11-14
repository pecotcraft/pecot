/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者が指定する */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// pr create・pr show・pr check。cli/commands/pr.py の移植。
// 途中で抜ける箇所は CommandExit を投げ、defineCommand が終了コードにする。
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
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
import { appendIssueCloseIfNeeded, collectPreflightWarnings, decidePullRequestBase, describeBaseStop, describePushStatus, formatPreflightWarning, formatPullRequestMarkdown, formatPullRequestWithReviewsMarkdown, isReleasePullRequest, validatePullRequestContent } from '../domain/pull-request.js'
import type { PreflightWarning, PullRequestBaseDecision, PullRequestBaseUse, PushStatus } from '../domain/pull-request.js'
import { parsePythonInteger, pythonStrip } from '../domain/python-format.js'
import { ReferenceParseError, parsePullRequestReference } from '../domain/reference-parser.js'
import { AmbiguousRepositoryError, resolveRepository, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { FLAG_PECOT_ACTIVE, FLAG_PR_CREATE_SLASH_PENDING } from '../domain/state.js'
import type { BaseReading } from '../domain/state.js'
import { pickBasePullRequest } from '../domain/work-start.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { parsePullRequestFile } from '../infra/frontmatter-file.js'
import { gitCurrentBranch, gitRemoteUrl, gitRunnerFor, gitStdout, gitToplevel, primaryRemoteName, runGit } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { changedFiles, expectedScope, nxProjects, parseTitleScope } from '../infra/nx-scope.js'
import { isFileNotFound } from '../infra/os-error.js'
import { outputDirectory, OutputPathReservationError, resolveRealPath, withReservedOutputPath } from '../infra/paths.js'
import { consumeFlag, readBaseRecord, readFlag } from '../infra/state-store.js'
import { readTemplateSections, templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './command-definition.js'
import { moveWaitingIssues } from './pr-waiting.js'

export const PR_REFERENCE_DESCRIPTION = 'PR reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)'

// 本文の検証の失敗。1（通信・設定・引数）と 2（preflight）と区別する
const VALIDATION_EXIT_CODE = 3
const PREFLIGHT_EXIT_CODE = 2
// 下の段の PR が開いておらず、マージもされていない
const NO_OPEN_BASE_EXIT_CODE = 2
// git ls-remote --exit-code が、一致する参照が無いときに返す
const LS_REMOTE_NOT_FOUND = 2

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

// scope を nx のプロジェクトと比べる対象か。release_type が nx で、base が develop か積んだ記録があり、remote と作業ツリーが対象に合うときだけ。
// 積んだ記録があれば記録の位置から比べる。下の段を squash でマージした後、開発ブランチとの差分はその段のファイルも含むため
function nxScopeTarget(config: Readonly<ProjectConfig>, owner: string, repository: string, base: string, directory: string, recordSha: string | undefined): ScopeTarget | undefined {
  const configured = findRepository(config, owner, repository)
  if (configured === undefined || effectiveReleaseType(configured) !== 'nx' || (recordSha === undefined && base !== getDevelopBranch(config, owner, repository))) return undefined
  const found = primaryRemote(directory)
  const location = found?.location
  const isSameRepository = location?.owner.toLowerCase() === owner.toLowerCase() && location.repository.toLowerCase() === repository.toLowerCase()
  if (found === undefined || !isSameRepository) return undefined
  const toplevel = gitToplevel({ cwd: directory })
  return toplevel === undefined || !isRegularFile(path.join(toplevel, 'nx.json')) ? undefined : { toplevel, from: recordSha ?? `${found.name}/${base}` }
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
  readonly recordSha: string | undefined
}

function titleScopeErrors(query: Readonly<TitleScopeQuery>, out: Readonly<Output>): readonly string[] {
  const { config, owner, repository, title, base, head, directory, template, developBranch, releaseBranch } = query
  if (isReleasePullRequest(template, base, head, developBranch, releaseBranch)) return []
  const target = nxScopeTarget(config, owner, repository, base, directory, query.recordSha)
  if (target === undefined) return []
  const expected = expectedTitleScope(target, head, out)
  if (expected === undefined || expected.length === 0) return []
  const given = parseTitleScope(title)
  if (given !== undefined && new Set(given).size === new Set(expected).size && given.every(scope => expected.includes(scope))) return []
  const shown = given === undefined ? 'none' : given.join(',')
  return [`PR title scope must be ${expected.join(',')} (given: ${shown}; computed from the tags of the changed nx projects)`]
}

// pr create

function inReviewOperation(issueNumber: number): Operation {
  return { verb: 'set', target: `Issue #${String(issueNumber)} status to In Review` }
}

async function updateIssueStatusToInReview(config: Readonly<ProjectConfig>, client: GitHubClient, location: RepositoryReference, headBranch: string, out: Readonly<Output>): Promise<void> {
  const issueNumber = extractIssueNumberFromBranch(headBranch)
  if (issueNumber === undefined) return
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
}

function exitOnUnsetBranch(template: string, base: string, head: string, developBranch: string | undefined, releaseBranch: string | undefined, out: Readonly<Output>): void {
  const isRelease = isReleasePullRequest(template, base, head, developBranch, releaseBranch)
  if (isRelease && (releaseBranch === undefined || releaseBranch === '')) {
    stopWith(out, 'release_branch is not set\nset it with: pecot project link owner/repo --release-branch main')
  }
  if (!isRelease && (developBranch === undefined || developBranch === '')) {
    stopWith(out, 'develop_branch is not set\nset it with: pecot project link owner/repo --develop-branch develop')
  }
}

function resolveHeadBranch(head: string | undefined, directory: string, out: Readonly<Output>): string {
  if (head !== undefined && head !== '') return head
  const current = gitCurrentBranch(directory)
  return current === undefined || current === '' ? stopWith(out, 'cannot determine the head branch') : current
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

function exitOnValidationErrors(errors: readonly string[], out: Readonly<Output>): void {
  if (errors.length === 0) return
  for (const error of errors) out.error(error)
  throw new CommandExit(VALIDATION_EXIT_CODE)
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
  const failed: PushStatus = { isPushed: false, message: '(git rev-list failed)' }
  try {
    if (runGit(['rev-parse', '--verify', `${remote}/${branch}`], { cwd }).exitCode !== 0) {
      return { isPushed: false, message: `${remote}/${branch} does not exist (not pushed)` }
    }
  }
  catch (error: unknown) {
    if (isFileNotFound(error)) return { isPushed: false, message: '(git rev-parse failed)' }
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
function validatePullRequestContext(directory: string, out: Readonly<Output>): PullRequestContext {
  if (gitToplevel({ cwd: directory }) === undefined) stopWith(out, 'not a git repository')
  const found = primaryRemote(directory)
  if (found === undefined) return stopWith(out, 'git remote not found')
  const currentBranch = gitCurrentBranch(directory)
  if (currentBranch === undefined) return stopWith(out, 'cannot determine the current branch')
  if (found.location === undefined) return stopWith(out, 'cannot read repository info from the remote URL\ncheck it with: git remote -v')
  return { remoteUrl: found.url, currentBranch, location: found.location, remoteName: found.name }
}

function runPreflightChecksOrExit(directory: string, out: Readonly<Output>): void {
  const context = validatePullRequestContext(directory, out)
  const push = getPushStatus(context.currentBranch, directory, context.remoteName)
  const warnings = collectPreflightWarnings({ gitStatus: getGitStatus(directory), stashList: getStashList(directory), isPushed: push.isPushed, pushMessage: push.message })
  if (warnings.length === 0) return
  out.error('preflight found warnings; fix them before creating a PR')
  printPreflightWarnings(out, warnings)
  throw new CommandExit(PREFLIGHT_EXIT_CODE)
}

// 下の段の PR が入っているスタックに足す。無ければ下の段と新しい PR で作る。失敗は warning にとどめる
async function registerStack(client: GitHubClient, location: RepositoryReference, lower: number, created: number | undefined, out: Readonly<Output>): Promise<void> {
  if (created === undefined) {
    out.warning('could not register stack: the PR creation response has no PR number')
    return
  }
  try {
    const stack = await client.getStackOfPullRequest(location.owner, location.repository, lower)
    const registered = stack === undefined
      ? await client.createStack(location.owner, location.repository, [lower, created])
      : await client.addToStack(location.owner, location.repository, stack.number, [created])
    out.done({ verb: 'add', target: `PR #${String(created)} to stack #${String(registered.number)}` })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not register stack: ${describeApiError(error)}`)
  }
}

async function submitPullRequest(config: Readonly<ProjectConfig>, directory: string, draft: Readonly<PullRequestDraft>, stackOn: number | undefined, out: Readonly<Output>): Promise<void> {
  runPreflightChecksOrExit(directory, out)
  const client = createGitHubClient(out, config.host)
  let created: JsonObject
  try {
    created = await client.createPullRequest(draft.location.owner, draft.location.repository, draft.title, draft.body, draft.head, draft.base, draft.isDraft)
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, `PR creation failed: ${error.message}`)
    throw error
  }
  out.done(createOperation(draft))
  const createdNumber = jsonField(created, 'number')
  const pullRequest = typeof createdNumber === 'number' ? createdNumber : undefined
  if (!draft.isRelease) await updateIssueStatusToInReview(config, client, draft.location, draft.head, out)
  if (stackOn !== undefined) await registerStack(client, draft.location, stackOn, pullRequest, out)
  const issueNumber = extractIssueNumberFromBranch(draft.head)
  if (!draft.isRelease && isPositive(issueNumber)) await moveWaitingIssues(out, client, config, { repository: draft.location, issueNumber, pullRequest })
  consumeFlag(FLAG_PR_CREATE_SLASH_PENDING)
  const url = jsonField(created, 'html_url')
  if (typeof url !== 'string') return stopWith(out, 'PR was created, but the response has no html_url; find it on GitHub')
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

function stopOnMalformedRecord(reading: BaseReading, out: Readonly<Output>): void {
  if (reading.kind === 'malformed') stopWith(out, describeBaseStop({ kind: 'stop', reason: 'malformed', content: reading.content }).join('\n'))
}

// 記録を使うのは、head が今のブランチで、release のテンプレートでないときだけ。形が誤っていれば終了コード 1 で止める
function readBaseRecordFor(head: string, template: string, directory: string, out: Readonly<Output>): BaseReading | undefined {
  if (template === 'release' || head !== gitCurrentBranch(directory)) return undefined
  const reading = readBaseRecord()
  stopOnMalformedRecord(reading, out)
  return reading
}

// 積んだ記録なら、PR を作るリポで下の段の PR を読み、base を決める
async function decideBase(input: Readonly<ValidatedInput>, developBranch: string, out: Readonly<Output>): Promise<PullRequestBaseDecision> {
  const { reading, base, location } = input
  if (reading === undefined) return { kind: 'use', base, stackOn: undefined, stackedBase: undefined }
  if (reading.kind !== 'stacked') return decidePullRequestBase({ reading, base, developBranch })
  const { branch } = reading.record
  try {
    const found = await createGitHubClient(out, input.config.host).listPullRequestsByHead(location.owner, location.repository, branch)
    return decidePullRequestBase({ reading, base, developBranch, lowerPullRequest: pickBasePullRequest(found.pullRequests) })
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, `cannot read the PR of the base branch ${branch}: ${error.message}`)
    throw error
  }
}

// 下の段の PR が開いているのに開発ブランチを渡したときは、内容の検証の失敗と一緒に出す（終了コード 3）
function useOrStop(decision: PullRequestBaseDecision, out: Readonly<Output>): { readonly use: PullRequestBaseUse | undefined, readonly errors: readonly string[] } {
  if (decision.kind === 'use') return { use: decision, errors: [] }
  const lines = describeBaseStop(decision)
  if (decision.reason === 'lower-open') return { use: undefined, errors: lines }
  if (decision.reason === 'malformed') return stopWith(out, lines.join('\n'))
  out.error(lines.join('\n'))
  throw new CommandExit(NO_OPEN_BASE_EXIT_CODE)
}

// 検証して、dry-run なら計画を出し、そうでなければ投稿する。file と -m の両方がここを通る
async function validateAndSubmit(input: Readonly<ValidatedInput>, out: Readonly<Output>): Promise<void> {
  const { config, directory, template, location, title, head } = input
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  const releaseBranch = getReleaseBranch(config, location.owner, location.repository)
  exitOnUnsetBranch(template, input.base, head, developBranch, releaseBranch, out)
  const { use, errors: baseErrors } = useOrStop(await decideBase(input, developBranch ?? '', out), out)
  const base = use?.base ?? input.base
  const recordSha = input.reading?.kind === 'stacked' ? input.reading.record.sha : undefined
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
    ...titleScopeErrors({ config, owner: location.owner, repository: location.repository, title, base, head, directory, template, developBranch, releaseBranch, recordSha }, out),
  ]
  exitOnValidationErrors(errors, out)

  const isRelease = template === 'release'
  const draft: PullRequestDraft = { location, title, body: input.body, head, base, isDraft: input.isDraft, isRelease }
  if (!input.dryRun) {
    await submitPullRequest(config, directory, draft, use?.stackOn, out)
    return
  }
  out.planned(createOperation(draft))
  const issueNumber = extractIssueNumberFromBranch(head)
  if (!isRelease && issueNumber !== undefined) out.planned(inReviewOperation(issueNumber))
}

function requireRepository(value: string, out: Readonly<Output>): RepositoryReference {
  return splitOwnerRepository(value) ?? stopWith(out, `invalid repository format: ${value} (expected: owner/repo)`)
}

interface FileModeInput {
  readonly file: string
  readonly template: string
  readonly noIssueRef: boolean
  readonly dryRun: boolean
}

async function createFromFile(input: Readonly<FileModeInput>, directory: string, out: Readonly<Output>): Promise<void> {
  const config = requireActiveConfigPlain(out)
  let parsed: ParsedPullRequest
  try {
    parsed = parsePullRequestFile(input.file)
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return stopWith(out, error.message)
    throw error
  }
  const { frontmatter } = parsed
  if (frontmatter.repository === '' || !frontmatter.repository.includes('/')) return stopWith(out, 'repository is required (e.g. owner/repo)')
  const location = requireRepository(frontmatter.repository, out)
  const head = resolveHeadBranch(frontmatter.head, directory, out)
  const reading = readBaseRecordFor(head, input.template, directory, out)

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

async function createDirect(input: Readonly<DirectModeInput>, directory: string, out: Readonly<Output>): Promise<void> {
  const config = requireActiveConfigPlain(out)
  let location: RepositoryReference
  if (input.repository === undefined || input.repository === '') {
    const [only] = config.repositories
    if (only === undefined || config.repositories.length !== 1) return stopWith(out, 'specify the repository (-r owner/repo)')
    location = { owner: only.owner, repository: only.name }
  }
  else {
    location = requireRepository(input.repository, out)
  }
  const head = resolveHeadBranch(input.head, directory, out)
  const reading = readBaseRecordFor(head, input.template, directory, out)

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

function addScopeHint(content: string, config: Readonly<ProjectConfig>, location: RepositoryReference, base: string, directory: string, recordSha: string | undefined, out: Readonly<Output>): string {
  const target = nxScopeTarget(config, location.owner, location.repository, base, directory, recordSha)
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
  let target: { readonly owner: string, readonly repository: string, readonly number: number } | undefined
  const segments = readFlag(FLAG_PECOT_ACTIVE)?.split('/')
  if (segments?.length === 3) {
    const [activeOwner, activeRepository, digits] = segments
    const activeNumber = digits !== undefined && /^\p{Nd}+$/u.test(digits) ? parsePythonInteger(digits) : undefined
    if (activeOwner !== undefined && activeRepository !== undefined && activeNumber !== undefined) target = { owner: activeOwner, repository: activeRepository, number: activeNumber }
  }
  if (target === undefined && location !== undefined) {
    const branch = gitCurrentBranch(directory)
    const branchNumber = branch === undefined || branch === '' ? undefined : extractIssueNumberFromBranch(branch)
    if (isPositive(branchNumber)) target = { owner: location.owner, repository: location.repository, number: branchNumber }
  }
  if (target === undefined || target.owner === '' || target.repository === '') return content

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

async function prepareTemplate(directory: string, out: Readonly<Output>, template: string): Promise<void> {
  const templatePath = templateFile('pr', templateKindOf(template))
  if (!existsSync(templatePath)) stopWith(out, `template not found: ${templatePath}`)
  let content = readTextFile(templatePath)

  // release テンプレートは、base をテンプレートの既定（main）のままにする
  if (template !== 'release') {
    // 下の段の PR がマージ済みかは、準備と投稿の間に変わりうるので、ここでは読まずに投稿のときに見る
    const reading = readBaseRecord()
    stopOnMalformedRecord(reading, out)
    const record = reading.kind === 'stacked' ? reading.record : undefined
    const location = primaryRemote(directory)?.location
    const config = loadActiveConfig()
    if (location !== undefined) {
      const developBranch = config === undefined ? undefined : getDevelopBranch(config, location.owner, location.repository)
      if (config !== undefined && developBranch !== undefined && developBranch !== '') {
        const base = record?.branch ?? developBranch
        content = content.replace(/^base:\s*"[^"]*"/mu, () => `base: "${base}"`)
        out.done({ verb: 'set', target: `base to ${base}` })
        content = addScopeHint(content, config, { owner: location.owner, repository: location.repository }, base, directory, record?.sha, out)
      }
    }
    content = await fillClosesInTemplate(content, config, directory, location, out)
  }

  const prefix = template === 'release' ? 'pr-release' : 'pr-create'
  try {
    withReservedOutputPath(outputDirectory(), timestamp => `${prefix}-${timestamp}.md`, (reserved) => {
      writeFileSync(reserved, content, 'utf8')
      out.data(reserved)
    })
  }
  catch (error: unknown) {
    if (error instanceof OutputPathReservationError) return stopWith(out, error.message)
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
  const out = createOutput(input.dry_run, io)
  if (input.template !== 'default' && input.template !== 'release') stopWith(out, `--template must be 'default' or 'release' (given: ${input.template})`)

  if (input.prepare) {
    await prepareTemplate(directory, createOutput(false, io), input.template)
  }
  else if (input.file !== undefined) {
    if (input.screenshot !== undefined) stopWith(out, '--screenshot is for -m; write the reason in the `screenshot` frontmatter field instead')
    await createFromFile({ file: input.file, template: input.template, noIssueRef: input.no_issue_ref, dryRun: input.dry_run }, directory, out)
  }
  else if (input.message === undefined) {
    stopWith(out, 'missing arguments\nusage:\npecot pr create --prepare\npecot pr create <path>\npecot pr create -m "<body>" -t "<title>" -b <base-branch>')
  }
  else {
    if (input.title === undefined || input.title === '' || input.base === undefined || input.base === '') stopWith(out, '-t (title) and -b (base branch) are required with -m')
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

// グローバルの --repo か、いまの git の repository。決められなければ undefined
function resolveBaseRepository(globalRepository: string | undefined): RepositoryReference | undefined {
  try {
    return resolveRepository(globalRepository, gitRunnerFor(process.cwd())).repository
  }
  catch (error: unknown) {
    if (error instanceof AmbiguousRepositoryError) return undefined
    throw error
  }
}

export function parseReference(reference: string, globalRepository: string | undefined, out: Readonly<Output>): { readonly owner: string, readonly repository: string, readonly number: number } {
  try {
    const parsed = parsePullRequestReference(reference, resolveBaseRepository(globalRepository), { repositoryFlag: true })
    return { owner: parsed.repository.owner, repository: parsed.repository.repository, number: parsed.number }
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return stopWith(out, error.message, USAGE_EXIT_CODE)
    throw error
  }
}

const ShowInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  json: z.boolean().default(false).describe('Output as JSON'),
  reviews: z.boolean().default(false).describe('Include review details (bodies and line comments)'),
})

async function runShow(input: Readonly<z.output<typeof ShowInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput(false, io)
  const config = requireActiveConfigPlain(out)
  const { owner, repository, number } = parseReference(input.pr_ref, input.repo, out)
  try {
    const client = createGitHubClient(out, config.host)
    if (input.reviews) {
      const pr = await client.getPullRequestWithReviews(owner, repository, number)
      out.data(`${input.json ? JSON.stringify(pr, undefined, 2) : formatPullRequestWithReviewsMarkdown(pr, owner, repository)}\n`)
    }
    else {
      const pr = await client.getPullRequestSlim(owner, repository, number)
      out.data(`${input.json ? JSON.stringify(pr, undefined, 2) : formatPullRequestMarkdown(pr)}\n`)
    }
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, error.message)
    throw error
  }
}

// pr check

function hasBranch(branch: string, cwd: string): boolean {
  return runGit(['rev-parse', '--verify', branch], { cwd }).exitCode === 0
}

// 下の段のブランチがマージで消えた後は、開発ブランチと比べる。追跡参照は fetch --prune まで残るので、
// remote に尋ね、無い（終了コード 2）ときだけ消えたとみなす。届かなければ追跡参照で決める
function isOnRemote(branch: string, cwd: string, remote: string): boolean {
  const listed = runGit(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], { cwd })
  return listed.exitCode !== LS_REMOTE_NOT_FOUND && hasBranch(`${remote}/${branch}`, cwd)
}

function determineBaseBranch(location: Readonly<RemoteLocation>, cwd: string, remote: string, out: Readonly<Output>): string {
  const config = loadActiveConfig()
  if (config === undefined) return stopWith(out, 'project config not found\nactivate a project with: pecot project activate <PROJECT>')
  const reading = readBaseRecord()
  stopOnMalformedRecord(reading, out)
  if (reading.kind === 'stacked' && isOnRemote(reading.record.branch, cwd, remote)) return `${remote}/${reading.record.branch}`
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    return stopWith(out, `develop_branch is not set for ${location.owner}/${location.repository}\nset it with: pecot project link ${location.owner}/${location.repository} --develop-branch develop`)
  }
  const branchName = `${remote}/${developBranch}`
  return hasBranch(branchName, cwd) ? branchName : stopWith(out, `branch ${branchName} does not exist\ncheck the remote branches with: git branch -r`)
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

function getWorktreeInfo(cwd: string): string {
  const listed = gitStdout(['worktree', 'list'], { cwd })
  const lines = [listed === undefined ? '(git worktree list failed)' : pythonStrip(listed), '', `Current directory name: ${path.basename(cwd)}`]
  const gitDirectory = gitStdout(['rev-parse', '--git-dir'], { cwd })
  const commonDirectory = gitDirectory === undefined ? undefined : gitStdout(['rev-parse', '--git-common-dir'], { cwd })
  if (gitDirectory === undefined || commonDirectory === undefined) {
    lines.push('Is worktree environment: (unknown)')
  }
  else {
    const isWorktree = resolveRealPath(path.resolve(cwd, pythonStrip(gitDirectory))) !== resolveRealPath(path.resolve(cwd, pythonStrip(commonDirectory)))
    lines.push(`Is worktree environment: ${isWorktree ? 'true' : 'false'}`)
  }
  return lines.join('\n')
}

const CheckInputSchema = z.strictObject({
  directory: directorySchema,
})

function runCheck(input: Readonly<z.output<typeof CheckInputSchema>>, io: Readonly<CommandIo>): void {
  const out = createOutput(false, io)
  const directory = input.directory
  const context = validatePullRequestContext(directory, out)
  const baseBranch = determineBaseBranch(context.location, directory, context.remoteName, out)

  const gitStatus = getGitStatus(directory)
  const commits = gitStdout(['log', '--oneline', `${baseBranch}..HEAD`], { cwd: directory })
  const diffSummary = gitStdout(['diff', '--stat', `${baseBranch}...HEAD`], { cwd: directory })
  const push = getPushStatus(context.currentBranch, directory, context.remoteName)
  const stashList = getStashList(directory)

  const sections: readonly (readonly [string, string])[] = [
    ['=== Git Remote ===', context.remoteUrl],
    ['=== Current Branch ===', context.currentBranch],
    ['=== Push Status ===', push.message],
    ['=== Base Branch ===', baseBranch],
    ['=== Git Status ===', gitStatus],
    ['=== .gitignore ===', readGitignore(directory)],
    ['=== Git Exclude ===', readGitExclude(directory)],
    [`=== Commits (vs ${baseBranch}) ===`, commits === undefined ? '(git log failed)' : pythonStrip(commits) || '(no commits)'],
    [`=== Diff Summary (vs ${baseBranch}) ===`, diffSummary === undefined ? '(git diff failed)' : pythonStrip(diffSummary) || '(no diff)'],
    ['=== Worktree Info ===', getWorktreeInfo(directory)],
    ['=== Stash List ===', stashList],
  ]
  for (const [index, [heading, content]] of sections.entries()) {
    if (index > 0) out.data('\n')
    out.data(`${heading}\n`)
    out.data(`${content}\n`)
  }

  const warnings = collectPreflightWarnings({ gitStatus, stashList, isPushed: push.isPushed, pushMessage: push.message })
  out.count('preflight warnings', warnings.length)
  printPreflightWarnings(out, warnings)
  if (warnings.length > 0) throw new CommandExit(PREFLIGHT_EXIT_CODE)
}

const prCreate = defineCommand({
  path: ['pr', 'create'],
  description: 'Create a PR (pull request)',
  input: CreateInputSchema,
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
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: (input, io) => {
    runCheck(input, io)
    return Promise.resolve(0)
  },
})

export const PR_COMMANDS: readonly CommandDefinition[] = [prCreate, prShow, prCheck]
