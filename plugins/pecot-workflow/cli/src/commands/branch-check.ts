/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
// branch_check。github-ops の link-branch に渡す前の params が、着手の決まり（前提・base・ブランチ名・作業ディレクトリのリポ）に合うかを返す
import { z } from 'zod'

import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { formatHinted } from '@pecot/workflow-core/domain/command-hint.js'
import { displayReference } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey, issueReferenceToCliReference } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { isSameRepository, repositoryFullName } from '@pecot/workflow-core/domain/repository-resolver.js'
import { decideStart } from '@pecot/workflow-core/domain/work-start.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { LINK_BRANCH_PARAMS } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { resolveCurrentRepository } from '@pecot/workflow-core/commands-shared/repository-match.js'
import { configFor, developmentBranchOf, parseReads, READ_BLOCKED_BY, READ_ISSUES, READ_PROJECT_FIELDS, READ_PROJECT_ITEMS, READ_PULL_REQUESTS, stackUndecidedHint, boardShapeOf } from './check-reads.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { referenceOf } from './official-reads.js'
import { dependencyReads, judgeFromReads } from './readiness-reads.js'

const CHECK_PATH = ['branch', 'check']

const BRANCH_CHECK_INPUT = z.object({
  owner: z.string().min(1).describe('Owner of the repository of the Issue, where the link-branch operation runs'),
  repo: z.string().min(1).describe('Name of the repository of the Issue'),
  issue: LINK_BRANCH_PARAMS.shape.issue.describe('Same as params.issue of link-branch: number of the work Issue'),
  branch: LINK_BRANCH_PARAMS.shape.branch.describe('Same as params.branch of link-branch: the full branch name, ending with /<Issue number>'),
  base: LINK_BRANCH_PARAMS.shape.base.describe('Same as params.base of link-branch: the branch to start from'),
  project: PROJECT_INPUT,
  reads: z.object({
    issues: READ_ISSUES.describe('Results of issue_read with method get (the structuredContent, { issue: ... }): the work Issue and each prerequisite'),
    blocked_by: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocked_by: the work Issue'),
    pull_requests: READ_PULL_REQUESTS,
    project_items: READ_PROJECT_ITEMS.describe('Results of projects_list with method list_project_items (optional): the cards of the prerequisites, to tell a prerequisite in Pending'),
    project_fields: READ_PROJECT_FIELDS.describe('Result of projects_list with method list_project_fields (optional, with project_items)'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type CheckInput = z.output<typeof BRANCH_CHECK_INPUT>

const BRANCH_CHECK_OUTPUT = z.strictObject({
  ...CHECK_RESULT_SHAPE,
  stacked_on: z.string().optional().describe('Prerequisite Issue the branch stacks on (owner/repo/N); pass it to session_start. Omitted when the branch starts from the develop branch'),
})

type CheckOutput = z.input<typeof BRANCH_CHECK_OUTPUT>

// 作業ディレクトリの git remote が Issue のリポと違えば、ブランチを作る前に止める
function repositoryMismatch(target: IssueReference): CheckProblem | undefined {
  const resolved = resolveCurrentRepository(process.cwd())
  if (resolved?.source !== 'current-git' || isSameRepository(resolved.repository, target.repository)) return undefined
  const name = target.repository.repository
  return {
    field: 'repo',
    code: 'repository-mismatch',
    message: `the repository of the work Issue (${repositoryFullName(target.repository)}) differs from the CWD git remote (${repositoryFullName(resolved.repository)})\nmove to the worktree of the target repository and call the tool again:\n<project-root>/base/${name}/ or <project-root>/<wtN>/${name}/\ncreate one with /pecot-w:w-worktree-add only if the repository has no worktree`,
  }
}

function branchNameProblem(branch: string, issue: number): CheckProblem | undefined {
  const suffix = `/${String(issue)}`
  return branch.length > suffix.length && branch.endsWith(suffix)
    ? undefined
    : { field: 'branch', code: 'branch-name', message: `the branch name must end with ${suffix} after a prefix, such as feat${suffix}` }
}

function baseProblem(base: string | undefined, expected: string | undefined, stackedOn: IssueReference | undefined, target: IssueReference): CheckProblem | undefined {
  if (stackedOn !== undefined && expected !== undefined) {
    const via = `the branch stacks on ${displayReference(stackedOn, target.repository)}`
    if (base === undefined) return { field: 'base', code: 'required', message: `${via}: give base ${expected}`, candidates: [expected] }
    return base === expected ? undefined : { field: 'base', code: 'base-mismatch', message: `${via}: base must be ${expected}, not ${base}`, candidates: [expected] }
  }
  if (base !== undefined) return undefined
  // base を省くと link-branch はリポの既定のブランチから作るので、開発ブランチを明示させる
  if (expected === undefined) return { field: 'base', code: 'required', message: `develop_branch is not set for ${repositoryFullName(target.repository)} in the project config: set it with project_link, or give base` }
  return { field: 'base', code: 'required', message: `give base ${expected} (the develop branch); without it, link-branch starts from the default branch of the repository`, candidates: [expected] }
}

interface Judged {
  readonly problems: readonly CheckProblem[]
  readonly stackedOn: IssueReference | undefined
}

function judgeStart(output: Readonly<Output>, input: Readonly<CheckInput>, target: IssueReference, config: ProjectConfig | undefined): Judged {
  const reads = parseReads(output, input.reads, config)
  const issue = reads.issues.get(issueReferenceKey(target))
  if (issue?.state === 'closed') return { problems: [{ field: 'issue', code: 'issue-closed', message: `${displayReference(target, target.repository)} is closed: reopen it before starting work` }], stackedOn: undefined }
  const dependencies = dependencyReads(output, input.reads?.blocked_by ?? [])
  const board = reads.board ?? boardShapeOf([], config)
  const developmentBranch = developmentBranchOf(config, target.repository)
  const judgment = judgeFromReads({ ref: target, reads, blockedBy: dependencies.reads, board, developmentBranch })
  if (judgment.kind === 'unread') return { problems: [...dependencies.problems, ...judgment.problems], stackedOn: undefined }
  const { judged, prerequisites } = judgment
  const problems: CheckProblem[] = [...dependencies.problems]
  const { stackUndecided } = judged
  if (stackUndecided !== undefined) {
    const code = stackUndecided.kind === 'no-develop-branch' ? 'required' : 'read-required'
    return { problems: [...problems, { field: 'base', code, message: `whether the branch can stack on its prerequisites is not decided: ${stackUndecidedHint(stackUndecided)}` }], stackedOn: undefined }
  }
  const decision = decideStart(judged.readiness, prerequisites, target)
  if (decision.kind === 'blocked') return { problems: [...problems, { field: 'issue', code: 'prerequisite-open', message: formatHinted(decision.message) }], stackedOn: undefined }
  const stackedOn = decision.kind === 'stack' ? decision.issue : undefined
  const expected = decision.kind === 'stack' ? decision.branch : developmentBranch
  const base = baseProblem(input.base, expected === '' ? undefined : expected, stackedOn, target)
  return { problems: base === undefined ? problems : [...problems, base], stackedOn }
}

function runCheck(output: Readonly<Output<CheckOutput>>, input: Readonly<CheckInput>): void {
  const problems: CheckProblem[] = []
  const target = referenceOf(`${input.owner}/${input.repo}`, input.issue)
  if (target === undefined) problems.push({ field: 'repo', code: 'value', message: `${input.owner}/${input.repo} is not a repository name` })
  let config: ProjectConfig | undefined
  if (target !== undefined) {
    const chosen = configFor(target.repository, input.project, CHECK_PATH)
    if (chosen.kind === 'problem') problems.push({ field: 'repo', code: 'not-in-project', message: chosen.message })
    else config = chosen.config
    const mismatch = repositoryMismatch(target)
    if (mismatch !== undefined) problems.push(mismatch)
  }
  const name = branchNameProblem(input.branch, input.issue)
  if (name !== undefined) problems.push(name)
  const judged = target === undefined ? undefined : judgeStart(output, input, target, config)
  const all = [...problems, ...judged?.problems ?? []]
  const stackedOn = judged?.stackedOn
  output.result({ problems: all, ...stackedOn !== undefined && { stacked_on: issueReferenceToCliReference(stackedOn) } })
  const lines = all.length === 0 ? ['ok'] : all.map(problem => `${problem.field}: ${problem.message}`)
  if (stackedOn !== undefined) lines.push(`stacked on: ${issueReferenceToCliReference(stackedOn)}`)
  output.data(lines.join('\n'))
}

const BRANCH_CHECK = defineTool({
  name: 'branch_check',
  title: 'Check Issue branch',
  description: 'Check the params for the link-branch operation of pecot-github-ops against the pecot rules before creating the branch: the Issue is open and its prerequisites allow starting, the base is the stack branch or the develop branch, the branch name ends with the Issue number, and the working directory is in the repository of the Issue. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  openWorld: false,
  input: BRANCH_CHECK_INPUT,
  output: BRANCH_CHECK_OUTPUT,
  run: (input, io) => {
    runCheck(createOutput<CheckOutput>(false, io), input)
    return Promise.resolve(0)
  },
})

export const BRANCH_CHECK_TOOLS: readonly ToolDefinition[] = [BRANCH_CHECK]
