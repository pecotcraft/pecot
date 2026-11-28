// pr_check。create_pull_request・update_pull_request・merge_pull_request に渡す前の引数が、pecot の決まりに合うかを返す
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
import { z } from 'zod'

import { extractIssueNumberFromBranch } from '@pecot/workflow-core/domain/branch-name.js'
import { formatHinted } from '@pecot/workflow-core/domain/command-hint.js'
import { getDevelopBranch, getReleaseBranch } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { isEpicIssue } from '@pecot/workflow-core/domain/issue-kind.js'
import type { PullRequestReadout } from '@pecot/workflow-core/domain/issue-readout.js'
import { decidePullRequestBase, describeBaseStop, formatPreflightWarning, hasClosingReference, isReleasePullRequest, parseHeadReference, pickLowerPullRequest } from '@pecot/workflow-core/domain/pull-request.js'
import type { HeadReference } from '@pecot/workflow-core/domain/pull-request.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { hasSummaryImage } from '@pecot/workflow-core/domain/sections.js'
import type { BaseReading } from '@pecot/workflow-core/domain/state.js'
import { closedHeadingGuidance, EM_DASH_HINT, templateViolations } from '@pecot/workflow-core/domain/template-violations.js'
import type { TemplateViolation, TemplateViolationCode } from '@pecot/workflow-core/domain/template-violations.js'
import { readTemplateSections } from '@pecot/workflow-core/infra/template-sections.js'
import { commandHint, hinted, joinHinted } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { templateFile } from '../infra/template-store.js'
import { configFor, unreadProblem } from './check-reads.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { parseOfficial, PULL_REQUEST_READ_GET } from './official-reads.js'
import type { PullRequestReadGet } from './official-reads.js'
import { ISSUE_KIND_READ, issueKindOf, LISTED_PULL_REQUESTS, pullRequestReadoutsOf } from './official-reads-pr.js'
import { preflightWarnings, readHeadBase, titleScopeMismatch } from './pr-preflight.js'
import type { StackedScope } from './pr-preflight.js'

const BUNDLED_PREFIX = 'pecot-template://'
const PR_PREFIX = `${BUNDLED_PREFIX}pr/`
export const PR_TEMPLATES: readonly string[] = ['create', 'release']
const CHECK_PATH = ['pr', 'check']
const LINK_PATH = ['project', 'link']

const PR_CHECK_INPUT = z.object({
  method: z.enum(['create', 'update', 'merge']).describe('create before create_pull_request, update before update_pull_request, merge before merge_pull_request'),
  owner: z.string().min(1).describe('Owner of the repository of the PR'),
  repo: z.string().min(1).describe('Name of the repository of the PR'),
  title: z.string().optional().describe('With create and update: title of the PR, as passed to the write tool'),
  head: z.string().optional().describe('With create: branch of the PR (owner:branch for a branch of a fork)'),
  base: z.string().optional().describe('With create and update: base branch of the PR'),
  draft: z.boolean().optional().describe('With create: whether the PR is a draft'),
  body: z.string().optional().describe('With create and update: body of the PR, as passed to the write tool'),
  pullNumber: z.number().int().min(1).optional().describe('With update and merge: number of the PR'),
  merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('With merge: merge method, as passed to merge_pull_request'),
  expectedHeadSha: z.string().optional().describe('With merge: head commit of the PR the merge is for, as passed to merge_pull_request'),
  template: z.string().optional().describe('Template the body follows: pecot-template://pr/<name> for a bundled one (its rules are checked); a replaced template\'s path or URL is accepted without checking the body'),
  template_text: z.string().optional().describe('Text of a replaced template; the body is not checked against it'),
  screenshot: z.string().optional().describe('With the bundled create template: reason to leave the image out of Summary'),
  project: PROJECT_INPUT,
  reads: z.object({
    pull_request: z.unknown().optional().describe('With update and merge: the result of pull_request_read with method get for the PR'),
    pull_requests: z.unknown().optional().describe('The result of list_pull_requests (head owner:<branch>) for the branch the PR is stacked on: with create and update, the base recorded for the head (state all); with merge, the base of the PR (state open)'),
    issue: z.unknown().optional().describe('With create and update: the result of issue_read with method get for the Issue in the head branch name'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type PrCheckInput = z.output<typeof PR_CHECK_INPUT>

const PR_CHECK_OUTPUT = z.strictObject(CHECK_RESULT_SHAPE)

// 本文のテンプレート

const VIOLATION_LABELS: Readonly<Record<TemplateViolationCode, string>> = {
  'missing-section': 'missing section',
  'heading-summary': 'heading summary rule',
  'body-style': 'unusable notation',
  'fold': 'collapse rule',
  'extra-heading': 'heading not in the template',
}

function violationMessage(violation: Readonly<TemplateViolation>, template: string, stem: string): string {
  const base = `${VIOLATION_LABELS[violation.code]} (${template}): ${violation.detail}`
  if (violation.code === 'missing-section' && violation.detail.includes(' — <')) return `${base}; ${EM_DASH_HINT}`
  if (violation.code === 'extra-heading') return `${base}; ${String(closedHeadingGuidance(stem))}`
  return base
}

// 同梱のテンプレートの名前。同梱でなければ undefined
function bundledStem(template: string | undefined): string | undefined {
  if (template?.startsWith(PR_PREFIX) !== true) return undefined
  const stem = template.slice(PR_PREFIX.length)
  return PR_TEMPLATES.includes(stem) ? stem : undefined
}

function templateProblems(body: string, template: string | undefined): readonly CheckProblem[] {
  if (template?.startsWith(BUNDLED_PREFIX) !== true) return []
  const stem = bundledStem(template)
  if (stem === undefined) {
    const candidates = PR_TEMPLATES.map(name => `${PR_PREFIX}${name}`)
    return [{ field: 'template', code: 'unknown-template', message: `${template} is not a bundled PR template; use one of the candidates, or the path or URL of a replaced template`, candidates }]
  }
  const required = readTemplateSections(templateFile('pr', stem))
  return [
    ...stripLeadingHtmlComment(body) === body ? [] : [{ field: 'body', code: 'guide-comment', message: 'remove the guide comment of the template from the start of the body' }],
    ...templateViolations(body, { stem, required }).map(violation => ({ field: 'body', code: violation.code, message: violationMessage(violation, template, stem) })),
  ]
}

// テンプレートの末尾の、番号の空いた `Closes #` の行
const EMPTY_CLOSES_PATTERN = /^Closes #[ \t]*$/mu

function bodyProblems(body: string | undefined, template: string | undefined): readonly CheckProblem[] {
  if (body === undefined) return []
  return [
    ...stripFrontmatter(body) === body ? [] : [{ field: 'body', code: 'frontmatter', message: 'the body still has the frontmatter of the template: pass its keys as arguments and leave them out of body' }],
    ...EMPTY_CLOSES_PATTERN.test(body) ? [{ field: 'body', code: 'empty-closes', message: 'the Closes # line has no number: write the number of the Issue the PR closes, or remove the line when the Issue is an Epic' }] : [],
    ...templateProblems(body, template),
  ]
}

// 読み取りの結果

function pullRequestOf(output: Readonly<Output>, input: Readonly<PrCheckInput>, pullNumber: number): PullRequestReadGet | CheckProblem {
  const name = `${input.owner}/${input.repo}#${String(pullNumber)}`
  const read = input.reads?.pull_request
  if (read === undefined) return unreadProblem('reads.pull_request', `read ${name} with pull_request_read (method get) and pass its result as reads.pull_request`)
  const pullRequest = parseOfficial(output, 'pull_request_read', PULL_REQUEST_READ_GET, read, 'reads.pull_request')
  return pullRequest.number === pullNumber ? pullRequest : { field: 'pullNumber', code: 'not-found', message: `reads.pull_request is PR #${String(pullRequest.number)}, not ${name}: read ${name} with pull_request_read (method get)` }
}

function isProblem(value: unknown): value is CheckProblem {
  return typeof value === 'object' && value !== null && 'code' in value && 'field' in value
}

// head を持つ PR を、list_pull_requests の結果から拾う
function pullRequestsWithHead(output: Readonly<Output>, read: unknown, head: string): readonly PullRequestReadout[] {
  const listed = parseOfficial(output, 'list_pull_requests', LISTED_PULL_REQUESTS, read, 'reads.pull_requests')
  return pullRequestReadoutsOf(listed).filter(pullRequest => pullRequest.headRefName === head)
}

interface Settings {
  readonly config: ProjectConfig
  readonly developBranch: string | undefined
  readonly releaseBranch: string | undefined
}

function settingsOf(input: Readonly<PrCheckInput>): Settings | CheckProblem {
  const chosen = configFor({ owner: input.owner, repository: input.repo }, input.project, CHECK_PATH)
  if (chosen.kind === 'problem') return { field: 'repo', code: 'not-in-project', message: chosen.message }
  const { config } = chosen
  return { config, developBranch: getDevelopBranch(config, input.owner, input.repo), releaseBranch: getReleaseBranch(config, input.owner, input.repo) }
}

function requireBranch(value: string | undefined, key: 'develop_branch' | 'release_branch', input: Readonly<PrCheckInput>, out: Readonly<Output>): string {
  if (value !== undefined && value !== '') return value
  const repository = `${input.owner}/${input.repo}`
  return stopWith(out, hinted`${key} is not set for ${repository}\nset it with: ${commandHint(LINK_PATH, { repo: repository, [key]: key === 'develop_branch' ? 'develop' : 'main' })}`, 'repo-setting-missing')
}

// create・update

interface WriteTarget {
  readonly head: HeadReference
  readonly base: string
  readonly title: string | undefined
}

function writeTargetOf(output: Readonly<Output>, input: Readonly<PrCheckInput>): WriteTarget | { readonly problems: readonly CheckProblem[] } {
  if (input.method === 'create') {
    const given = { title: input.title, head: input.head, base: input.base }
    const missing = Object.entries(given).filter(([, value]) => value === undefined || value === '').map(([key]) => key)
    const problems: CheckProblem[] = missing.map(key => ({ field: key, code: 'required', message: `create needs ${key}` }))
    if (input.pullNumber !== undefined) problems.push({ field: 'pullNumber', code: 'unexpected', message: 'create_pull_request creates a new PR and takes no pullNumber; use method update to rewrite a PR' })
    const head = parseHeadReference(input.head ?? '')
    if (head === undefined && input.head !== undefined && input.head !== '') problems.push({ field: 'head', code: 'value', message: `invalid head: ${input.head} (expected: branch or owner:branch)` })
    return head === undefined || problems.length > 0 ? { problems } : { head, base: input.base ?? '', title: input.title }
  }
  if (input.pullNumber === undefined) return { problems: [{ field: 'pullNumber', code: 'required', message: 'update needs pullNumber, the number of the PR to rewrite' }] }
  const pullRequest = pullRequestOf(output, input, input.pullNumber)
  return isProblem(pullRequest) ? { problems: [pullRequest] } : { head: { owner: undefined, branch: pullRequest.head.ref }, base: input.base ?? pullRequest.base.ref, title: input.title ?? pullRequest.title }
}

function screenshotProblems(input: Readonly<PrCheckInput>): readonly CheckProblem[] {
  const { body, screenshot = '' } = input
  return body === undefined || bundledStem(input.template) !== 'create' || hasSummaryImage(body) || screenshot.trim() !== '' ? [] : [{ field: 'screenshot', code: 'required', message: 'Summary has no image: put a screenshot of the result in Summary, or write the reason to leave it out in screenshot' }]
}

function closesProblems(output: Readonly<Output>, input: Readonly<PrCheckInput>, head: HeadReference): readonly CheckProblem[] {
  const issueNumber = extractIssueNumberFromBranch(head.branch)
  if (issueNumber === undefined || input.body === undefined || hasClosingReference(input.body)) return []
  const name = `${input.owner}/${input.repo}#${String(issueNumber)}`
  const read = input.reads?.issue
  if (read === undefined) return [unreadProblem('reads.issue', `the body closes no Issue: read ${name} with issue_read (method get) and pass its result as reads.issue; it decides whether the body must close it`)]
  const issue = parseOfficial(output, 'issue_read', ISSUE_KIND_READ, read, 'reads.issue').issue
  if (issue.number !== issueNumber) return [{ field: 'reads.issue', code: 'not-found', message: `reads.issue is Issue #${String(issue.number)}, not ${name}: read ${name} with issue_read (method get)` }]
  if (isEpicIssue(issueKindOf({ issue }))) return []
  const line = `Closes #${String(issueNumber)}`
  return [{ field: 'body', code: 'missing-closes', message: `the body closes no Issue: add ${line} at the end, so that the merge closes the Issue of the branch`, candidates: [line] }]
}

interface BaseCheck {
  readonly problems: readonly CheckProblem[]
  readonly stacked: StackedScope | undefined
  readonly lowerPullRequest: PullRequestReadout | undefined
}

function baseMismatch(base: string, expected: string, why: string): CheckProblem {
  return { field: 'base', code: 'base-mismatch', message: `base must be ${expected} (given: ${base}): ${why}`, candidates: [expected] }
}

// 記録が無いか、head が今のブランチでなければ、渡された base のまま見る（ほかの worktree のスタックを決められないため）
function stackedBaseCheck(output: Readonly<Output>, input: Readonly<PrCheckInput>, target: WriteTarget, reading: BaseReading | undefined, developBranch: string): BaseCheck {
  const { base } = target
  if (reading === undefined) return { problems: [], stacked: undefined, lowerPullRequest: undefined }
  if (reading.kind !== 'stacked') {
    const problems = base === developBranch ? [] : [baseMismatch(base, developBranch, '.pecot-base records no stacked base for the head, so the PR goes to the develop branch')]
    return { problems, stacked: undefined, lowerPullRequest: undefined }
  }
  const { branch, sha } = reading.record
  const read = input.reads?.pull_requests
  if (read === undefined) {
    const problem = unreadProblem('reads.pull_requests', `the head is stacked on ${branch}: read its PRs with list_pull_requests (owner ${input.owner}, repo ${input.repo}, head ${input.owner}:${branch}, state all) and pass its result as reads.pull_requests`)
    return { problems: [problem], stacked: { branch }, lowerPullRequest: undefined }
  }
  const lowerPullRequest = pickLowerPullRequest(pullRequestsWithHead(output, read, branch))
  const decision = decidePullRequestBase({ reading, base, developBranch, lowerPullRequest })
  if (decision.kind === 'stop') {
    const message = formatHinted(joinHinted(describeBaseStop(decision)))
    const candidates = decision.reason === 'lower-open' ? [branch] : undefined
    return { problems: [{ field: 'base', code: 'base-mismatch', message, ...candidates !== undefined && { candidates } }], stacked: { branch }, lowerPullRequest }
  }
  const isMerged = lowerPullRequest?.state === 'MERGED'
  const expected = isMerged ? developBranch : branch
  const why = isMerged ? `the PR of ${branch} is merged` : `the head is stacked on ${branch}, whose PR is open`
  return { problems: base === expected ? [] : [baseMismatch(base, expected, why)], stacked: isMerged ? { sha } : { branch }, lowerPullRequest }
}

interface BranchFacts {
  readonly config: ProjectConfig
  readonly location: RepositoryReference
  readonly directory: string
}

interface FeatureCheck {
  readonly problems: readonly CheckProblem[]
  readonly reading: BaseReading | undefined
  readonly lowerPullRequest: PullRequestReadout | undefined
}

// 題・Issue・画像・スタックの決まり。リリース PR には当てない
async function featureProblems(output: Readonly<Output>, input: Readonly<PrCheckInput>, target: WriteTarget, facts: BranchFacts, developBranch: string): Promise<FeatureCheck> {
  const { head, base, title } = target
  const { config, location, directory } = facts
  const reading = head.owner === undefined ? readHeadBase(directory, head.branch, output) : undefined
  const baseCheck = stackedBaseCheck(output, input, target, reading, developBranch)
  const mismatch = title === undefined ? undefined : await titleScopeMismatch({ config, location, title, base, headBranch: head.branch, directory, stacked: baseCheck.stacked }, output)
  const titleProblems: readonly CheckProblem[] = mismatch === undefined
    ? []
    : [{ field: 'title', code: 'title-scope', message: `PR title scope must be ${mismatch.expected.join(',')} (given: ${mismatch.given?.join(',') ?? 'none'}; computed from the tags of the changed nx projects)`, candidates: [mismatch.expected.join(',')] }]
  const problems = [...screenshotProblems(input), ...closesProblems(output, input, head), ...baseCheck.problems, ...titleProblems]
  return { problems, reading, lowerPullRequest: baseCheck.lowerPullRequest }
}

async function writeProblems(output: Readonly<Output>, input: Readonly<PrCheckInput>): Promise<readonly CheckProblem[]> {
  const fromBody = bodyProblems(input.body, input.template)
  const target = writeTargetOf(output, input)
  if ('problems' in target) return [...target.problems, ...fromBody]
  const { head, base } = target
  const settings = settingsOf(input)
  if (isProblem(settings)) return [...fromBody, settings]
  const { config, releaseBranch } = settings
  const facts: BranchFacts = { config, location: { owner: input.owner, repository: input.repo }, directory: process.cwd() }
  const isRelease = isReleasePullRequest(bundledStem(input.template) ?? '', base, head.branch, settings.developBranch, releaseBranch)
  const release = isRelease ? requireBranch(releaseBranch, 'release_branch', input, output) : undefined
  const checked: FeatureCheck = release === undefined
    ? await featureProblems(output, input, target, facts, requireBranch(settings.developBranch, 'develop_branch', input, output))
    : { problems: base === release ? [] : [baseMismatch(base, release, 'a release PR goes to the release branch')], reading: undefined, lowerPullRequest: undefined }
  const warnings = input.method === 'create' ? await preflightWarnings({ ...facts, head, reading: checked.reading, lowerPullRequest: checked.lowerPullRequest }, output) : []
  return [
    ...fromBody,
    ...checked.problems,
    ...warnings.map(warning => ({ field: 'head', code: PREFLIGHT_CODES[warning.label] ?? 'preflight', message: formatHinted(formatPreflightWarning(warning)) })),
  ]
}

const PREFLIGHT_CODES: Readonly<Partial<Record<string, string>>> = {
  'Push Status': 'unpushed-commits',
  'Git Status': 'uncommitted-changes',
  'Stash List': 'stash-left',
}

// merge

function mergeableProblems(pullRequest: PullRequestReadGet): readonly CheckProblem[] {
  const name = `PR #${String(pullRequest.number)}`
  const reasons: readonly (readonly [boolean, string])[] = [
    [pullRequest.merged, 'is already merged'],
    [pullRequest.state === 'closed', 'is closed'],
    [pullRequest.draft, 'is a draft: mark it ready for review first'],
    [pullRequest.mergeable_state === 'dirty', 'conflicts with its base: resolve the conflicts and push first'],
  ]
  const reason = reasons.find(([applies]) => applies)?.[1]
  return reason === undefined ? [] : [{ field: 'pullNumber', code: 'not-mergeable', message: `${name} ${reason}` }]
}

function headMovedProblems(pullRequest: PullRequestReadGet, expected: string | undefined): readonly CheckProblem[] {
  const actual = pullRequest.head.sha
  return expected === undefined || actual === undefined || expected === actual ? [] : [{ field: 'expectedHeadSha', code: 'head-moved', message: `the head of PR #${String(pullRequest.number)} is ${actual}, not ${expected}: new commits were pushed; check them before merging`, candidates: [actual] }]
}

// スタックした PR は、base を head に持つ PR が開いている間はマージしない
function stackBottomProblems(output: Readonly<Output>, input: Readonly<PrCheckInput>, base: string): readonly CheckProblem[] {
  const read = input.reads?.pull_requests
  if (read === undefined) {
    return [unreadProblem('reads.pull_requests', `the base ${base} is not the develop branch: read the PRs of ${base} with list_pull_requests (owner ${input.owner}, repo ${input.repo}, head ${input.owner}:${base}, state open) and pass its result as reads.pull_requests`)]
  }
  const lower = pullRequestsWithHead(output, read, base).find(pullRequest => pullRequest.state === 'OPEN' && !pullRequest.isCrossRepository)
  return lower === undefined ? [] : [{ field: 'pullNumber', code: 'not-stack-bottom', message: `the PR is stacked on PR #${String(lower.number)} (head ${base}), which is open: merge PR #${String(lower.number)} first` }]
}

function mergeProblems(output: Readonly<Output>, input: Readonly<PrCheckInput>): readonly CheckProblem[] {
  const usage: CheckProblem[] = []
  if (input.pullNumber === undefined) usage.push({ field: 'pullNumber', code: 'required', message: 'merge needs pullNumber, the number of the PR to merge' })
  if (input.expectedHeadSha === undefined || input.expectedHeadSha === '') usage.push({ field: 'expectedHeadSha', code: 'required', message: 'merge needs expectedHeadSha, the head.sha of the PR in reads.pull_request, so that commits pushed after the check are not merged' })
  if (input.pullNumber === undefined) return usage
  const pullRequest = pullRequestOf(output, input, input.pullNumber)
  if (isProblem(pullRequest)) return [...usage, pullRequest]
  const state = [...usage, ...mergeableProblems(pullRequest), ...headMovedProblems(pullRequest, input.expectedHeadSha)]
  const settings = settingsOf(input)
  if (isProblem(settings)) return [...state, settings]
  const developBranch = requireBranch(settings.developBranch, 'develop_branch', input, output)
  const { releaseBranch } = settings
  const base = pullRequest.base.ref
  const isRelease = releaseBranch !== undefined && releaseBranch !== '' && base === releaseBranch && pullRequest.head.ref === developBranch
  const isStacked = base !== developBranch && base !== releaseBranch
  const expected = isRelease ? 'merge' : 'squash'
  // merge_method を省くと、GitHub は merge commit でマージする
  const given = input.merge_method ?? 'merge'
  const why = isRelease ? 'a release PR keeps the history of the develop branch' : 'a PR to the develop branch is squashed into one commit'
  return [
    ...state,
    ...isStacked ? stackBottomProblems(output, input, base) : [],
    ...given === expected ? [] : [{ field: 'merge_method', code: 'merge-method', message: `merge_method must be ${expected} (given: ${input.merge_method ?? 'none, which merges with a merge commit'}): ${why}`, candidates: [expected] }],
  ]
}

const PR_CHECK = defineTool({
  name: 'pr_check',
  title: 'Check pull request',
  description: 'Check the arguments for create_pull_request, update_pull_request or merge_pull_request against the pecot rules before writing: the bundled PR template the body follows, the Issue the body closes, the base branch of a stacked branch, the title scope, unpushed or uncommitted work (create), and with merge, the state, head, stack position and merge method of the PR. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  openWorld: false,
  input: PR_CHECK_INPUT,
  output: PR_CHECK_OUTPUT,
  run: async (input, io) => {
    const output = createOutput<z.input<typeof PR_CHECK_OUTPUT>>(false, io)
    const problems = input.method === 'merge' ? mergeProblems(output, input) : await writeProblems(output, input)
    output.result({ problems: [...problems] })
    output.data(problems.length === 0 ? 'ok' : problems.map(problem => `${problem.field}: ${problem.message}`).join('\n'))
    return 0
  },
})

export const PR_TOOLS: readonly ToolDefinition[] = [PR_CHECK]
