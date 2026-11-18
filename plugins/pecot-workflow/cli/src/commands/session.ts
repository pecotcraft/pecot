// session show。cli/commands/session.py の移植。
import { z } from 'zod'

import { ConfigError, getDevelopBranch } from '../domain/config.js'
import type { RemoteLocation } from '../domain/git-url.js'
import type { ProjectConfig } from '../domain/config.js'
import type { PullRequestReadout } from '../domain/issue-readout.js'
import { describeReadiness } from '../domain/readiness.js'
import { describeNeedsRestack, needsRestack } from '../domain/restack.js'
import type { RestackDecision } from '../domain/restack.js'
import { issueReferenceToCliReference, issueReferenceToString } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { describeStackBase } from '../domain/work-start.js'
import { configLookupFailure, findConfigFor } from '../infra/config-store.js'
import { activeIssueOf, gitCurrentBranch, primaryRemoteName, primaryRemoteRepository } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { readBaseOrInfer, warnUnresolved } from './base-reading.js'
import { defineCommand } from './command-definition.js'
import { joinHinted } from './command-hint.js'
import { PROJECT_INPUT } from './command-stop.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import type { IssueReadiness } from './issue-readiness.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { readRestackDecision } from './restack-reading.js'
import { SESSION_FINISH_COMMANDS } from './session-finish.js'
import { SESSION_START_COMMANDS } from './session-start.js'

const ACTIVE_ISSUE_DATA = z.strictObject({
  reference: z.string().describe('Work Issue found from the git remote and the number that ends the branch name (owner/repo/N, the form issue_ref takes)'),
  title: z.string().optional().describe('Title of the Issue (omitted when it cannot be read from GitHub)'),
  state: z.string().optional().describe('State of the Issue, OPEN or CLOSED (omitted when it cannot be read from GitHub)'),
})

const BASE_PULL_REQUEST_DATA = z.strictObject({
  number: z.int().describe('PR number'),
  state: z.string().describe('State of the PR'),
})

const STACK_DATA = z.strictObject({
  branch: z.string().describe('Base branch the work branch is stacked on'),
  stackedOn: z.string().describe('Issue stacked on (owner/repo/N)'),
  pullRequest: BASE_PULL_REQUEST_DATA.optional().describe('PR of the base branch (omitted when there is none or it cannot be read)'),
  needsRestack: z.boolean().optional().describe('Whether the branch needs pr restack: the base branch moved or its PR is merged (omitted when it cannot be decided)'),
  readiness: z.string().optional().describe('Readiness of the active Issue (only when blocked)'),
})

const STACKED_ABOVE_DATA = z.strictObject({
  number: z.int().describe('PR number'),
  branch: z.string().describe('Head branch of the PR'),
})

const SESSION_SHOW_OUTPUT = z.strictObject({
  branch: z.string().optional().describe('Current branch (omitted when it cannot be read)'),
  repository: z.string().optional().describe('Repository of the git remote (owner/repo; omitted when it cannot be read)'),
  activeIssue: ACTIVE_ISSUE_DATA.optional().describe('Work Issue of the session (omitted when there is none)'),
  stack: STACK_DATA.optional().describe('Base the work was stacked on (omitted when not stacked)'),
  stackedAbove: z.array(STACKED_ABOVE_DATA).optional().describe('Open PRs whose base is the current branch (omitted when there are none or they cannot be read)'),
})

type SessionShowData = z.input<typeof SESSION_SHOW_OUTPUT>

/**
GitHub から読めた作業中の Issue。積んだ記録と上の段の PR は、これがあるときだけ読む
*/
interface ActiveIssue {
  readonly reference: IssueReference
  readonly config: Readonly<ProjectConfig>
  readonly client: Readonly<GitHubClient>
  readonly lines: readonly string[]
}

interface ActiveIssueReading {
  /**
  Markdown の Active Issue の行に出す owner/repo#N
  */
  readonly label: string
  readonly data: Readonly<z.input<typeof ACTIVE_ISSUE_DATA>>
  readonly read?: ActiveIssue
}

// 作業中の Issue（remote とブランチ名から求める）を GitHub から読んで、Markdown の行にする。
// 作業中の Issue が無ければ undefined。読めなければ warning を出し、参照だけを返す
async function readActiveIssue(directory: string, output: Output, project: string | undefined): Promise<ActiveIssueReading | undefined> {
  const reference = activeIssueOf(directory)
  if (reference === undefined) return undefined
  const label = issueReferenceToString(reference)
  const data = { reference: issueReferenceToCliReference(reference) }

  let issue
  let config
  let client
  try {
    const lookup = findConfigFor(reference.repository, project)
    if (lookup.kind !== 'found') {
      output.warning(joinHinted(['cannot read the active Issue: ', configLookupFailure(lookup, reference.repository, ['session', 'show']).message], ''))
      return { label, data }
    }
    config = lookup.found.config
    client = createGitHubClient(output, config.host)
    issue = await client.getIssueSlim(reference.repository.owner, reference.repository.repository, reference.number, 0)
  }
  catch (error: unknown) {
    if (error instanceof ConfigError || error instanceof GitHubAPIError) {
      output.warning(`cannot read the active Issue: ${error.message}`)
      return { label, data }
    }
    throw error
  }

  const lines = ['', '## Active Issue', '', `#${String(issue.number)} ${issue.title} (${issue.state})`]
  if (issue.body !== '') lines.push('', issue.body)
  return { label, data: { ...data, title: issue.title, state: issue.state }, read: { reference, config, client, lines } }
}

interface StackSection {
  readonly lines: readonly string[]
  readonly data?: SessionShowData['stack']
}

// 積んで着手した作業ディレクトリの `## Stack` の節。積んでいなければ空
async function stackSection(active: Readonly<ActiveIssue>, origin: Readonly<RemoteLocation> | undefined, directory: string, output: Output): Promise<StackSection> {
  const base = await readBaseOrInfer({ directory, project: { config: active.config, client: () => active.client } })
  warnUnresolved(base, output)
  const { reading, readiness: known } = base
  if (reading.kind === 'malformed') output.warning(`.pecot-base is malformed: ${reading.content}`)
  if (reading.kind !== 'stacked') return { lines: [] }
  const { record, stackedOn } = reading
  // ブランチは作業ディレクトリのリポにあるので、PR もそこで探す（pr restack と同じ）
  const { owner, repository } = origin ?? stackedOn.repository
  // 載せ直す先は、fetch せずに、下の段の remote の先頭を尋ねて記録と比べる
  const read = await readRestackDecision({ client: () => active.client, owner, repository, cwd: directory, remote: primaryRemoteName(directory), reading, developBranch: getDevelopBranch(active.config, owner, repository) ?? '', signal: output.signal })
  if (read.kind === 'pull-request-unreadable') output.warning(`cannot read the PR of the base branch: ${read.error.message}`)
  const pullRequest: PullRequestReadout | undefined | 'unknown' = read.kind === 'pull-request-unreadable' ? 'unknown' : read.lowerPullRequest
  const restack: RestackDecision | undefined = read.kind === 'decided' ? read.decision : undefined
  const readiness = await blockedReadiness(active, known, output)
  const needsLine = restack === undefined ? undefined : describeNeedsRestack(restack)
  const needed = restack === undefined ? undefined : needsRestack(restack)
  return {
    lines: ['', '## Stack', describeStackBase(record.branch, stackedOn, pullRequest), ...needsLine === undefined ? [] : [needsLine], ...readiness === undefined ? [] : [`- readiness: ${readiness}`]],
    data: {
      branch: record.branch,
      stackedOn: issueReferenceToCliReference(stackedOn),
      ...pullRequest !== 'unknown' && pullRequest !== undefined && { pullRequest: { number: pullRequest.number, state: pullRequest.state } },
      ...needed !== undefined && { needsRestack: needed },
      ...readiness !== undefined && { readiness },
    },
  }
}

type StackedAbove = NonNullable<SessionShowData['stackedAbove']>

// 今のブランチを base にした、同じリポの開いている PR。読めなければ warning を出して undefined にする
async function readStackedAbove(active: Readonly<ActiveIssue>, origin: Readonly<RemoteLocation>, branch: string, output: Output): Promise<StackedAbove | undefined> {
  try {
    const found = await active.client.listPullRequestsByBase(origin.owner, origin.repository, branch)
    return found.pullRequests.map(pullRequest => ({ number: pullRequest.number, branch: pullRequest.headRefName }))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`cannot read the PRs stacked above: ${error.message}`)
    return undefined
  }
}

// 積んだ記録の節に上の段の行を足す。積んだ記録が無くても、上の段があれば節を出す
function withStackedAbove(stackLines: readonly string[], above: readonly Readonly<StackedAbove[number]>[] | undefined): readonly string[] {
  if (above === undefined || above.length === 0) return stackLines
  const lines = above.map(pullRequest => `- stacked above: PR #${String(pullRequest.number)} (${pullRequest.branch})`)
  return stackLines.length === 0 ? ['', '## Stack', ...lines] : [...stackLines, ...lines]
}

// 着手中の Issue の判定が blocked のときだけ、判定の文を返す。積んだ先を求めるときに読んだ判定があれば、読み直さない
async function blockedReadiness(active: Readonly<ActiveIssue>, known: IssueReadiness | undefined, output: Output): Promise<string | undefined> {
  const result = known ?? await readIssueReadinessIfSupported(active.client, active.config, active.reference, createReadinessCache())
  if (result === undefined) return undefined
  if (result.kind === 'unreadable') {
    output.warning(`cannot judge readiness of the active Issue: ${result.reason}`)
    return undefined
  }
  const { readiness } = result
  return readiness?.kind === 'blocked' ? describeReadiness(readiness, result.prerequisites, active.reference.repository) : undefined
}

const SESSION_SHOW = defineCommand({
  path: ['session', 'show'],
  title: 'Show session',
  description: 'Show the branch, repository and work Issue of the session',
  input: z.object({ directory: directorySchema, project: PROJECT_INPUT }),
  output: SESSION_SHOW_OUTPUT,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput<SessionShowData>(false, io)
    const branch = gitCurrentBranch(input.directory)
    const origin = primaryRemoteRepository(input.directory)
    const reading = await readActiveIssue(input.directory, output, input.project)
    const active = reading?.read
    const stack = active === undefined ? { lines: [] } : await stackSection(active, origin, input.directory, output)
    const above = active === undefined || origin === undefined || branch === undefined ? undefined : await readStackedAbove(active, origin, branch, output)
    output.result({
      ...branch !== undefined && { branch },
      ...origin !== undefined && { repository: `${origin.owner}/${origin.repository}` },
      ...reading !== undefined && { activeIssue: reading.data },
      ...stack.data !== undefined && { stack: stack.data },
      ...above !== undefined && above.length > 0 && { stackedAbove: above },
    })

    const lines = [
      '# Session status',
      '',
      `- Branch: ${branch ?? 'unknown'}`,
      `- Repository: ${origin === undefined ? 'unknown' : `${origin.owner}/${origin.repository}`}`,
      `- Active Issue: ${reading === undefined ? 'none' : reading.label}`,
      ...active?.lines ?? [],
      ...withStackedAbove(stack.lines, above),
    ]
    output.data(lines.join('\n'))
    return 0
  },
})

/**
session のグループのコマンド。start は session-start.ts、finish は session-finish.ts にある。並びは help の一覧に出る順
*/
export const SESSION_COMMANDS: readonly CommandDefinition[] = [...SESSION_START_COMMANDS, SESSION_SHOW, ...SESSION_FINISH_COMMANDS]
