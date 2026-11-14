/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者が指定する */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// `pecot pr` の 4 コマンド（create・read・preflight・cleanup）。cli/commands/pr.py の移植。
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
import {
  appendIssueCloseIfNeeded,
  collectPreflightWarnings,
  describePushStatus,
  extractClosingIssueNumbers,
  formatPreflightWarning,
  formatPullRequestMarkdown,
  formatPullRequestWithReviewsMarkdown,
  isReleasePullRequest,
  validatePullRequestContent,
} from '../domain/pull-request.js'
import type { PreflightWarning, PushStatus } from '../domain/pull-request.js'
import { parsePythonInteger, pythonStrip } from '../domain/python-format.js'
import { ReferenceParseError, parsePullRequestReference } from '../domain/reference-parser.js'
import { AmbiguousRepositoryError, resolveRepository, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { FLAG_MERGE_SLASH_PENDING, FLAG_PECOT_ACTIVE, FLAG_PECOT_BASE, FLAG_PECOT_QUICK_MODE, FLAG_PECOT_SESSION_TITLE, FLAG_PR_CREATE_SLASH_PENDING, FLAG_WIP_BRANCH_LINKED } from '../domain/state.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { parsePullRequestFile } from '../infra/frontmatter-file.js'
import { gitCurrentBranch, GitCommandError, gitRemoteUrl, gitRunnerFor, gitStdout, gitToplevel, primaryRemoteName, runGit } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError, isClosedByAnotherRequest, isMissingReferenceError } from '../infra/github/errors.js'
import type { PullRequestSlim } from '../infra/github/pulls.js'
import { changedFiles, expectedScope, nxProjects, parseTitleScope } from '../infra/nx-scope.js'
import { isFileNotFound } from '../infra/os-error.js'
import { outputDirectory, OutputPathReservationError, resolveRealPath, withReservedOutputPath } from '../infra/paths.js'
import { consumeFlag, readFlag, removeFlag } from '../infra/state-store.js'
import { readTemplateSections, templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'
import { getCurrentWorktreeName, isWorktreeEnvironment } from '../infra/worktree.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './command-definition.js'
import { settle } from './tracker-sync.js'

const PR_REFERENCE_DESCRIPTION = 'PR reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)'

// 本文の検証の失敗。1（通信・設定・引数）と 2（preflight）と区別する
const VALIDATION_EXIT_CODE = 3
const PREFLIGHT_EXIT_CODE = 2

// Python の `{e}` に当たる、例外の文
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function templateKindOf(template: string): 'create' | 'release' {
  return template === 'release' ? 'release' : 'create'
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

// 主の remote

interface PrimaryRemote {
  readonly name: string
  readonly url: string
  /**
  URL が読めなければ undefined
  */
  readonly location: RemoteLocation | undefined
}

function primaryRemote(directory: string): PrimaryRemote | undefined {
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
  readonly remote: string
}

// scope を nx のプロジェクトと比べる対象か。release_type が nx、base が develop、remote と作業ツリーが対象に合うときだけ
function nxScopeTarget(config: Readonly<ProjectConfig>, owner: string, repository: string, base: string, directory: string): ScopeTarget | undefined {
  const configured = findRepository(config, owner, repository)
  if (configured === undefined || effectiveReleaseType(configured) !== 'nx' || (base !== getDevelopBranch(config, owner, repository))) return undefined
  const found = primaryRemote(directory)
  const location = found?.location
  const isSameRepository = location?.owner.toLowerCase() === owner.toLowerCase() && location.repository.toLowerCase() === repository.toLowerCase()
  if (found === undefined || !isSameRepository) return undefined
  const toplevel = gitToplevel({ cwd: directory })
  return toplevel === undefined || !isRegularFile(path.join(toplevel, 'nx.json')) ? undefined : { toplevel, remote: found.name }
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

function expectedTitleScope(target: Readonly<ScopeTarget>, base: string, head: string, out: Readonly<Output>): readonly string[] | undefined {
  const projects = nxProjects(target.toplevel)
  const files = projects === undefined ? undefined : changedFiles(target.toplevel, `${target.remote}/${base}`, head)
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
}

function titleScopeErrors(query: Readonly<TitleScopeQuery>, out: Readonly<Output>): readonly string[] {
  const { config, owner, repository, title, base, head, directory, template, developBranch, releaseBranch } = query
  if (isReleasePullRequest(template, base, head, developBranch, releaseBranch)) return []
  const target = nxScopeTarget(config, owner, repository, base, directory)
  if (target === undefined) return []
  const expected = expectedTitleScope(target, base, head, out)
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
    stopWith(out, 'release_branch is not set\nset it with: pecot repo set owner/repo --release-branch main')
  }
  if (!isRelease && (developBranch === undefined || developBranch === '')) {
    stopWith(out, 'develop_branch is not set\nset it with: pecot repo set owner/repo --develop-branch develop')
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

// pr create の早い確認と pr preflight が共有する前提。満たさなければ終了コード 1
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

async function submitPullRequest(config: Readonly<ProjectConfig>, directory: string, draft: Readonly<PullRequestDraft>, out: Readonly<Output>): Promise<void> {
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
  if (!draft.isRelease) await updateIssueStatusToInReview(config, client, draft.location, draft.head, out)
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
}

// 検証して、dry-run なら計画を出し、そうでなければ投稿する。file と -m の両方がここを通る
async function validateAndSubmit(input: Readonly<ValidatedInput>, out: Readonly<Output>): Promise<void> {
  const { config, directory, template, location, title, base, head } = input
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  const releaseBranch = getReleaseBranch(config, location.owner, location.repository)
  exitOnUnsetBranch(template, base, head, developBranch, releaseBranch, out)
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
    }),
    ...titleScopeErrors({ config, owner: location.owner, repository: location.repository, title, base, head, directory, template, developBranch, releaseBranch }, out),
  ]
  exitOnValidationErrors(errors, out)

  const isRelease = template === 'release'
  const draft: PullRequestDraft = { location, title, body: input.body, head, base, isDraft: input.isDraft, isRelease }
  if (!input.dryRun) {
    await submitPullRequest(config, directory, draft, out)
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
  }, out)
}

// --prepare

function addScopeHint(content: string, config: Readonly<ProjectConfig>, location: RepositoryReference, base: string, directory: string, out: Readonly<Output>): string {
  const target = nxScopeTarget(config, location.owner, location.repository, base, directory)
  if (target === undefined) return content
  const head = gitCurrentBranch(directory)
  const expected = head === undefined || head === '' ? undefined : expectedTitleScope(target, base, head, out)
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
    const location = primaryRemote(directory)?.location
    const config = loadActiveConfig()
    if (location !== undefined) {
      const developBranch = config === undefined ? undefined : getDevelopBranch(config, location.owner, location.repository)
      if (config !== undefined && developBranch !== undefined && developBranch !== '') {
        content = content.replace(/^base:\s*"[^"]*"/mu, () => `base: "${developBranch}"`)
        out.done({ verb: 'set', target: `base to ${developBranch}` })
        content = addScopeHint(content, config, { owner: location.owner, repository: location.repository }, developBranch, directory, out)
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

// pr read

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

function parseReference(reference: string, globalRepository: string | undefined, out: Readonly<Output>): { readonly owner: string, readonly repository: string, readonly number: number } {
  try {
    const parsed = parsePullRequestReference(reference, resolveBaseRepository(globalRepository), { repositoryFlag: true })
    return { owner: parsed.repository.owner, repository: parsed.repository.repository, number: parsed.number }
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return stopWith(out, error.message, USAGE_EXIT_CODE)
    throw error
  }
}

const ReadInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  json: z.boolean().default(false).describe('Output as JSON'),
  reviews: z.boolean().default(false).describe('Include review details (bodies and line comments)'),
})

async function runRead(input: Readonly<z.output<typeof ReadInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
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

// pr preflight

function hasBranch(branch: string, cwd: string): boolean {
  return runGit(['rev-parse', '--verify', branch], { cwd }).exitCode === 0
}

function determineBaseBranch(location: Readonly<RemoteLocation>, cwd: string, remote: string, out: Readonly<Output>): string {
  const config = loadActiveConfig()
  if (config === undefined) return stopWith(out, 'project config not found\nactivate a project with: pecot project activate <PROJECT>')
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    return stopWith(out, `develop_branch is not set for ${location.owner}/${location.repository}\nset it with: pecot repo set ${location.owner}/${location.repository} --develop-branch develop`)
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

const PreflightInputSchema = z.strictObject({
  directory: directorySchema,
})

function runPreflight(input: Readonly<z.output<typeof PreflightInputSchema>>, io: Readonly<CommandIo>): void {
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

// pr cleanup

interface Cleanup {
  readonly out: Output
  readonly isDryRun: boolean
}

async function fetchPullRequestForCleanup(config: Readonly<ProjectConfig>, location: Readonly<RepositoryReference & { readonly number: number }>, out: Readonly<Output>): Promise<{ readonly client: GitHubClient, readonly pr: PullRequestSlim }> {
  try {
    const client = createGitHubClient(out, config.host)
    return { client, pr: await client.getPullRequestSlim(location.owner, location.repository, location.number) }
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return stopWith(out, `PR not found: ${location.owner}/${location.repository}/${String(location.number)}`)
    if (error instanceof GitHubAPIError) return stopWith(out, error.message)
    throw error
  }
}

function collectClosingIssueNumbers(pr: Readonly<{ readonly closing_issues: readonly { readonly number: number }[], readonly body: string, readonly head_ref: string }>): Set<number> {
  const numbers = new Set<number>(pr.closing_issues.map(issue => issue.number))
  for (const number of extractClosingIssueNumbers(pr.body)) numbers.add(number)
  const branchNumber = extractIssueNumberFromBranch(pr.head_ref)
  if (isPositive(branchNumber)) numbers.add(branchNumber)
  return numbers
}

// Epic 保護。Issue Type が Epic か、sub-issue を持つ Issue
async function findEpicProtectedNumbers(client: GitHubClient, location: RepositoryReference, issueNumbers: ReadonlySet<number>, out: Readonly<Output>): Promise<Set<number>> {
  const protectedNumbers = new Set<number>()
  const ordered = [...issueNumbers].toSorted((a, b) => a - b)
  for (const number of ordered) {
    try {
      if (isEpicIssue(await client.getIssueKind(location.owner, location.repository, number))) protectedNumbers.add(number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) continue
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(`kind check of Issue #${String(number)} failed: ${error.message}; not protected`)
    }
  }
  return protectedNumbers
}

async function closeRelatedIssues(context: Readonly<Cleanup>, client: GitHubClient, location: RepositoryReference, closing: ReadonlySet<number>, epicProtected: ReadonlySet<number>): Promise<void> {
  const { out, isDryRun } = context
  const protectedOrdered = [...epicProtected].toSorted((a, b) => a - b)
  const closingOrdered = [...closing].toSorted((a, b) => a - b)
  for (const number of protectedOrdered) settle(out, { verb: 'skip', target: `closing Issue #${String(number)} (Epic)` })
  for (const number of closingOrdered) {
    const operation: Operation = { verb: 'close', target: `Issue #${String(number)}` }
    out.planned(operation)
    if (isDryRun) continue
    try {
      await client.closeIssue(location.owner, location.repository, number)
      out.done(operation)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) {
        out.warning(`Issue #${String(number)} not found; skipped`)
      }
      else if (error instanceof GitHubAPIError) {
        if (isClosedByAnotherRequest(error)) out.done({ verb: 'unchanged', target: `Issue #${String(number)} (already closed)` })
        else out.warning(`closing Issue #${String(number)} failed: ${describeApiError(error)}`)
      }
      else {
        throw error
      }
    }
  }
}

// head ブランチを消し、続けて wip ブランチを消す。head が無くても wip は試す
async function deleteMergedBranch(context: Readonly<Cleanup>, client: GitHubClient, location: RepositoryReference, headBranch: string): Promise<void> {
  const { out, isDryRun } = context
  const operation: Operation = { verb: 'delete', target: `remote branch ${headBranch}` }
  out.planned(operation)
  if (isDryRun) return
  try {
    await client.deleteBranch(location.owner, location.repository, headBranch)
    out.done(operation)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    if (!isMissingReferenceError(error)) {
      out.warning(`deleting remote branch ${headBranch} failed: ${describeApiError(error)}`)
      return
    }
    out.done({ verb: 'unchanged', target: `remote branch ${headBranch} (already deleted)` })
  }
  const wipBranch = `wip/${headBranch}`
  try {
    await client.deleteBranch(location.owner, location.repository, wipBranch)
    out.done({ verb: 'delete', target: `remote branch ${wipBranch}` })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    if (!isMissingReferenceError(error)) out.warning(`deleting remote branch ${wipBranch} failed: ${describeApiError(error)}`)
  }
}

// 手元と PR の repository が同じなら主の remote 名。違えば警告を出して undefined
function sameRepositoryRemote(cwd: string, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  const skipped = 'skipped local cleanup'
  try {
    const found = primaryRemote(cwd)
    if (found === undefined) {
      out.warning(`cannot read the remote URL; ${skipped}`)
      return undefined
    }
    if (found.location === undefined) {
      out.warning(`cannot read the repository from the remote URL; ${skipped}`)
      return undefined
    }
    if (found.location.owner !== location.owner || found.location.repository !== location.repository) {
      out.warning(`current repository (${found.location.owner}/${found.location.repository}) differs from the PR's (${location.owner}/${location.repository}); ${skipped}`)
      return undefined
    }
    return found.name
  }
  catch {
    out.warning(`cannot determine the repository; ${skipped}`)
    return undefined
  }
}

// worktree では worktree 名、そうでなければ develop ブランチ
function resolveCheckoutTarget(cwd: string, config: Readonly<ProjectConfig>, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  try {
    if (isWorktreeEnvironment(cwd)) return getCurrentWorktreeName(cwd) ?? 'main'
    const developBranch = getDevelopBranch(config, location.owner, location.repository)
    if (developBranch !== undefined && developBranch !== '') return developBranch
    out.warning('develop_branch is not set; skipped local cleanup')
    return undefined
  }
  catch {
    out.warning('cannot determine the worktree; skipped local cleanup')
    return undefined
  }
}

function didRunLocalStep(context: Readonly<Cleanup>, operation: Operation, cwd: string, arguments_: readonly string[], failure: string): boolean {
  const { out, isDryRun } = context
  out.planned(operation)
  if (isDryRun) return true
  try {
    runGit(arguments_, { cwd, check: true })
  }
  catch (error: unknown) {
    if (!(error instanceof GitCommandError) && !isFileNotFound(error)) throw error
    out.warning(`${failure} failed: ${reasonOf(error)}`)
    return false
  }
  out.done(operation)
  return true
}

function localCleanupAfterMerge(context: Readonly<Cleanup>, headBranch: string, config: Readonly<ProjectConfig>, location: RepositoryReference): void {
  const { out } = context
  const cwd = process.cwd()
  const remote = sameRepositoryRemote(cwd, location, out)
  if (remote === undefined) return
  const currentBranch = gitCurrentBranch(cwd)
  const checkoutTarget = resolveCheckoutTarget(cwd, config, location, out)
  if (checkoutTarget === undefined) return
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    out.warning('develop_branch is not set; skipped local cleanup')
    return
  }

  if (currentBranch === checkoutTarget) {
    settle(out, { verb: 'unchanged', target: `current branch ${checkoutTarget}` })
  }
  else if (!didRunLocalStep(context, { verb: 'set', target: `current branch to ${checkoutTarget}` }, cwd, ['checkout', checkoutTarget], `checking out ${checkoutTarget}`)) {
    // checkout が失敗したら、pull と branch -D は別のブランチに当たるので止める
    return
  }
  didRunLocalStep(context, { verb: 'update', target: `${checkoutTarget} from ${remote}/${developBranch}` }, cwd, ['pull', remote, developBranch], `pulling ${developBranch}`)
  if (headBranch === checkoutTarget) {
    settle(out, { verb: 'skip', target: `deleting local branch ${headBranch} (it is the checkout target)` })
  }
  else {
    didRunLocalStep(context, { verb: 'delete', target: `local branch ${headBranch}` }, cwd, ['branch', '-D', headBranch], `deleting local branch ${headBranch}`)
  }
}

function removeActiveFlags(out: Readonly<Output>): void {
  try {
    for (const flag of [FLAG_PECOT_ACTIVE, FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE, FLAG_PECOT_QUICK_MODE, FLAG_WIP_BRANCH_LINKED]) removeFlag(flag)
  }
  catch (error: unknown) {
    out.warning(`removing flag files failed: ${reasonOf(error)}`)
  }
}

const CleanupInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  dry_run: z.boolean().default(false).describe('Dry-run (do not actually clean up)'),
  delete_branch: z.boolean().default(false).describe('Delete the branch'),
  skip_local_cleanup: z.boolean().default(false).describe('Skip the local branch switch and deletion'),
})

async function runCleanup(input: Readonly<z.output<typeof CleanupInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput(input.dry_run, io)
  const context: Cleanup = { out, isDryRun: input.dry_run }
  const config = requireActiveConfigPlain(out)
  const reference = parseReference(input.pr_ref, input.repo, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }

  const { client, pr } = await fetchPullRequestForCleanup(config, reference, out)
  if (pr.state !== 'MERGED') stopWith(out, `PR #${String(reference.number)} is not merged yet (state: ${pr.state}); merge it with gh pr merge first`)

  const closing = collectClosingIssueNumbers(pr)
  const epicProtected = await findEpicProtectedNumbers(client, location, closing, out)
  for (const number of epicProtected) closing.delete(number)

  out.count('Issues to close', closing.size)
  await closeRelatedIssues(context, client, location, closing, epicProtected)
  if (input.delete_branch) await deleteMergedBranch(context, client, location, pr.head_ref)
  if (input.skip_local_cleanup) return
  localCleanupAfterMerge(context, pr.head_ref, config, location)
  if (input.dry_run) {
    return
  }

  removeActiveFlags(out)
  consumeFlag(FLAG_MERGE_SLASH_PENDING)
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

const prRead = defineCommand({
  path: ['pr', 'read'],
  description: 'Get PR details efficiently (GraphQL, only the needed fields)',
  input: ReadInputSchema,
  positional: ['pr_ref'],
  shortFlags: { json: '-j', reviews: '-r' },
  interactive: false,
  run: async (input, io) => {
    await runRead(input, io)
    return 0
  },
})

const prPreflight = defineCommand({
  path: ['pr', 'preflight'],
  description: 'Show all the information to check before creating a PR',
  input: PreflightInputSchema,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: (input, io) => {
    runPreflight(input, io)
    return Promise.resolve(0)
  },
})

const prCleanup = defineCommand({
  path: ['pr', 'cleanup'],
  description: 'Clean up after a merged PR (close related Issues, delete branches, local cleanup)',
  input: CleanupInputSchema,
  positional: ['pr_ref'],
  shortFlags: { dry_run: '-n', delete_branch: '-d' },
  interactive: false,
  run: async (input, io) => {
    await runCleanup(input, io)
    return 0
  },
})

export const PR_COMMANDS: readonly CommandDefinition[] = [prCleanup, prCreate, prPreflight, prRead]
