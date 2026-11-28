// session_start。link-branch で作ったブランチの着手の記録（.pecot-base・作業ディレクトリ・セッション名）を手元に書く。GitHub を読まず書かない
import { z } from 'zod'

import { ReferenceParseError, parseIssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { repositoryFullName } from '@pecot/workflow-core/domain/repository-resolver.js'
import { issuePath } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { recordWorkTarget } from './work-target.js'
import { checkLeftovers } from './session-leftovers.js'

const LEFTOVER_DATA = z.strictObject({
  pullRequest: z.string().describe('Merged PR of the current branch whose local cleanup with session_finish is left (owner/repo/N)'),
})

const SESSION_START_OUTPUT = z.strictObject({
  repository: z.string().describe('Repository of the branch (owner/repo)'),
  base: z.string().describe('Base branch the branch starts from'),
  stackedOn: z.int().optional().describe('Issue number whose branch this one is stacked on (omitted when not stacked)'),
  issue: z.string().describe('Work Issue (owner/repo/N)'),
  workDirectory: z.string().optional().describe('Absolute path of the work directory (omitted when it could not be created)'),
  leftovers: z.array(LEFTOVER_DATA).optional().describe('Earlier merged PRs whose local cleanup is left undone (omitted when there is none)'),
})

const SESSION_START_INPUT = z.strictObject({
  issue_ref: z.string().describe('Work Issue (owner/repo/123)'),
  base: z.string().min(1).describe('Base branch the branch was created from (base in the link-branch result)'),
  sha: z.string().refine(value => /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(value), 'a full commit SHA').describe('Commit the branch was created from (sha in the link-branch result)'),
  stacked_on: z.string().optional().describe('Prerequisite Issue the branch stacks on (owner/repo/N, stacked_on in the branch_check result; omitted when not stacked)'),
  title: z.string().describe('Title of the work Issue, for the session name'),
  reads: z.object({
    pull_requests: z.unknown().optional().describe('Result of list_pull_requests with head <owner>:<current branch> and state all, to find a merged PR whose local cleanup is left'),
  }).optional().describe('Results of the official GitHub MCP reads'),
})

function parseReference(out: Readonly<Output>, value: string, field: string): IssueReference {
  try {
    return parseIssueReference(value)
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    return stopWith(out, `${field}: ${error.message}`, 'invalid-input', USAGE_EXIT_CODE)
  }
}

const sessionStartCommand = defineTool({
  name: 'session_start',
  title: 'Record Issue branch',
  writes: { destructive: false, idempotent: true },
  description: 'Record the start of work on a branch created with the link-branch operation: the base (.pecot-base), the work directory and the session name. Also reports a merged PR of the current branch whose local cleanup is left',
  input: SESSION_START_INPUT,
  output: SESSION_START_OUTPUT,
  run: (input, io) => {
    const out = createOutput<z.input<typeof SESSION_START_OUTPUT>>(false, io)
    const issue = parseReference(out, input.issue_ref, 'issue_ref')
    const stackedOn = input.stacked_on === undefined ? undefined : parseReference(out, input.stacked_on, 'stacked_on')
    const { owner, repository } = issue.repository
    out.result({ repository: repositoryFullName(issue.repository), base: input.base, ...stackedOn !== undefined && { stackedOn: stackedOn.number }, issue: issuePath(owner, repository, issue.number) })
    const leftovers = checkLeftovers(out, input.reads?.pull_requests, issue.repository, process.cwd())
    if (leftovers.length > 0) out.result({ leftovers })
    const recorded = recordWorkTarget(out, owner, repository, issue.number, input.title, { base: { branch: input.base, sha: input.sha, stackedOn } })
    if (recorded.workDirectory !== undefined) out.result({ workDirectory: recorded.workDirectory })
    return Promise.resolve(0)
  },
})

export const SESSION_START_TOOLS: readonly ToolDefinition[] = [sessionStartCommand]
