// session show・session restore。cli/commands/session.py の移植。
import { z } from 'zod'

import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { ConfigError } from '../domain/config.js'
import type { RemoteLocation } from '../domain/git-url.js'
import type { ProjectConfig } from '../domain/config.js'
import { PecotError } from '../domain/errors.js'
import type { PullRequestReadout } from '../domain/issue-readout.js'
import { describeReadiness } from '../domain/readiness.js'
import { describeNeedsRestack, needsRestack } from '../domain/restack.js'
import type { RestackDecision } from '../domain/restack.js'
import { issueReferenceToCliReference, parseIssueReference, ReferenceParseError } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { describeStackBase } from '../domain/work-start.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitCurrentBranch, primaryRemoteName, primaryRemoteRepository } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { hasFlag, readBaseRecord, readFlag } from '../infra/state-store.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'
import { FAILURE_EXIT_CODE } from './failure.js'
import { commandHint, hinted, placeholder } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import { issuePath } from './issue-shared.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Output } from './output.js'
import { readRestackDecision } from './restack-reading.js'
import { SESSION_FINISH_COMMANDS } from './session-finish.js'
import { SESSION_START_COMMANDS } from './session-start.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { planWorkTarget, recordWorkTarget } from './work-target.js'

const ALL_FLAGS: readonly string[] = [FLAG_PECOT_ACTIVE]

interface FlagStatus {
  readonly name: string
  readonly isSet: boolean
  readonly content: string
}

function collectFlagStatuses(): FlagStatus[] {
  return ALL_FLAGS.map((name) => {
    const isSet = hasFlag(name)
    return { name, isSet, content: isSet ? readFlag(name) ?? '' : '' }
  })
}

const FLAG_DATA = z.strictObject({
  name: z.string().describe('Name of the session flag'),
  isSet: z.boolean().describe('Whether the flag is set'),
  content: z.string().describe('Content of the flag (empty when unset)'),
})

const ACTIVE_ISSUE_DATA = z.strictObject({
  reference: z.string().describe('Issue in .pecot-active (owner/repo/N)'),
  title: z.string().describe('Title of the Issue'),
  state: z.string().describe('State of the Issue (OPEN or CLOSED)'),
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
  inferredIssue: z.int().optional().describe('Issue number inferred from the branch name (omitted when none)'),
  flags: z.array(FLAG_DATA).describe('Session flags'),
  activeIssue: ACTIVE_ISSUE_DATA.optional().describe('Issue in .pecot-active as read from GitHub (omitted when unset or unreadable)'),
  stack: STACK_DATA.optional().describe('Base the work was stacked on (omitted when not stacked)'),
  stackedAbove: z.array(STACKED_ABOVE_DATA).optional().describe('Open PRs whose base is the current branch (omitted when there are none or they cannot be read)'),
})

type SessionShowData = z.input<typeof SESSION_SHOW_OUTPUT>

interface ActiveIssue {
  readonly reference: IssueReference
  readonly config: Readonly<ProjectConfig>
  readonly client: Readonly<GitHubClient>
  readonly lines: readonly string[]
  readonly data: Readonly<z.input<typeof ACTIVE_ISSUE_DATA>>
}

// .pecot-active の Issue を GitHub から読んで、Markdown の行にする。読めなければ warning だけ出して undefined にする
async function readActiveIssue(statuses: readonly FlagStatus[], output: Output): Promise<ActiveIssue | undefined> {
  const active = statuses.find(status => status.name === FLAG_PECOT_ACTIVE && status.isSet && status.content !== '')
  if (active === undefined) return undefined

  let reference
  try {
    reference = parseIssueReference(active.content)
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return undefined
    throw error
  }

  let issue
  let config
  let client
  try {
    config = loadActiveConfig()
    if (config === undefined) {
      output.warning('cannot read the active Issue: no active project')
      return undefined
    }
    client = createGitHubClient(output, config.host)
    issue = await client.getIssueSlim(reference.repository.owner, reference.repository.repository, reference.number, 0)
  }
  catch (error: unknown) {
    if (error instanceof ConfigError || error instanceof GitHubAPIError) {
      output.warning(`cannot read the active Issue: ${error.message}`)
      return undefined
    }
    throw error
  }

  const lines = ['', '## Active Issue', '', `#${String(issue.number)} ${issue.title} (${issue.state})`]
  if (issue.body !== '') lines.push('', issue.body)
  return { reference, config, client, lines, data: { reference: issueReferenceToCliReference(reference), title: issue.title, state: issue.state } }
}

interface StackSection {
  readonly lines: readonly string[]
  readonly data?: SessionShowData['stack']
}

// 積んで着手した作業ディレクトリの `## Stack` の節。積んでいなければ空
async function stackSection(active: Readonly<ActiveIssue>, origin: Readonly<RemoteLocation> | undefined, directory: string, output: Output): Promise<StackSection> {
  const reading = readBaseRecord()
  if (reading.kind === 'malformed') output.warning(`.pecot-base is malformed: ${reading.content}`)
  if (reading.kind !== 'stacked') return { lines: [] }
  const { record, stackedOn } = reading
  // ブランチは作業ディレクトリのリポにあるので、PR もそこで探す（pr restack と同じ）
  const { owner, repository } = origin ?? stackedOn.repository
  // 載せ直す先は、fetch せずに、下の段の remote の先頭を尋ねて記録と比べる
  const read = await readRestackDecision({ client: () => active.client, owner, repository, cwd: directory, remote: primaryRemoteName(directory), reading, developBranch: '' })
  if (read.kind === 'pull-request-unreadable') output.warning(`cannot read the PR of the base branch: ${read.error.message}`)
  const pullRequest: PullRequestReadout | undefined | 'unknown' = read.kind === 'pull-request-unreadable' ? 'unknown' : read.lowerPullRequest
  const restack: RestackDecision | undefined = read.kind === 'decided' ? read.decision : undefined
  const readiness = await blockedReadiness(active, output)
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

// 着手中の Issue の判定が blocked のときだけ、判定の文を返す
async function blockedReadiness(active: Readonly<ActiveIssue>, output: Output): Promise<string | undefined> {
  const result = await readIssueReadinessIfSupported(active.client, active.config, active.reference, createReadinessCache())
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
  description: 'Show the session flag state, branch information, and inferred Issue',
  input: z.object({ directory: directorySchema }),
  output: SESSION_SHOW_OUTPUT,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput<SessionShowData>(false, io)
    const branch = gitCurrentBranch(input.directory)
    const origin = primaryRemoteRepository(input.directory)
    const issueNumber = branch === undefined ? undefined : extractIssueNumberFromBranch(branch)
    const statuses = collectFlagStatuses()
    const active = await readActiveIssue(statuses, output)
    const stack = active === undefined ? { lines: [] } : await stackSection(active, origin, input.directory, output)
    const above = active === undefined || origin === undefined || branch === undefined ? undefined : await readStackedAbove(active, origin, branch, output)
    output.result({
      ...branch !== undefined && { branch },
      ...origin !== undefined && { repository: `${origin.owner}/${origin.repository}` },
      ...issueNumber !== undefined && { inferredIssue: issueNumber },
      flags: statuses.map(status => ({ ...status })),
      ...active !== undefined && { activeIssue: active.data },
      ...stack.data !== undefined && { stack: stack.data },
      ...above !== undefined && above.length > 0 && { stackedAbove: above },
    })

    const lines = [
      '# Session status',
      '',
      `- Branch: ${branch ?? 'unknown'}`,
      `- Repository: ${origin === undefined ? 'unknown' : `${origin.owner}/${origin.repository}`}`,
      `- Inferred Issue: ${issueNumber === undefined ? 'none' : `#${String(issueNumber)}`}`,
      '',
      '| Flag | State | Content |',
      '|------|-------|---------|',
      ...statuses.map(status => `| ${status.name} | ${status.isSet ? 'set' : 'unset'} | ${status.content} |`),
      ...active?.lines ?? [],
      ...withStackedAbove(stack.lines, above),
    ]
    output.data(lines.join('\n'))
    return 0
  },
})

// セッション名に添える題名。設定が無いか API が失敗したときだけ空にする。設定が読めないなら ConfigError を伝える
async function fetchIssueTitle(owner: string, repository: string, number: number, output: Output): Promise<string> {
  try {
    const config = loadActiveConfig()
    if (config === undefined) return ''
    const issue = await createGitHubClient(output, config.host).getIssueSlim(owner, repository, number, 0)
    return issue.title
  }
  catch (error: unknown) {
    if (error instanceof ConfigError) throw error
    if (error instanceof PecotError) return ''
    throw error
  }
}

interface RestoreTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

// issue_ref が無いときの、ブランチ名と remote からの推定。決められなければ error を出して終了コード 1
function inferTarget(directory: string, output: Output): RestoreTarget {
  const branch = gitCurrentBranch(directory)
  if (branch === undefined) {
    return stopWith(output, 'cannot read the branch name', 'git-unresolved', FAILURE_EXIT_CODE)
  }
  const number = extractIssueNumberFromBranch(branch)
  if (number === undefined) {
    return stopWith(output, hinted`cannot infer the Issue number from the branch name: ${branch}\nrun: ${commandHint(['session', 'restore'], { issue_ref: placeholder('owner/repo/N') })}`, 'git-unresolved', FAILURE_EXIT_CODE)
  }
  const origin = primaryRemoteRepository(directory)
  const message = 'cannot read the repository information'
  return origin === undefined ? stopWith(output, message, 'git-unresolved', FAILURE_EXIT_CODE) : { owner: origin.owner, repository: origin.repository, number }
}

// issue_ref の参照を分ける。形が誤っていれば error を出して終了コード 2
function parseTarget(issue: string, output: Output): RestoreTarget {
  try {
    const reference = parseIssueReference(issue)
    return { owner: reference.repository.owner, repository: reference.repository.repository, number: reference.number }
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    return stopWith(output, error.message, 'invalid-input', USAGE_EXIT_CODE)
  }
}

const SESSION_RESTORE_OUTPUT = z.strictObject({
  issue: z.string().describe('Work Issue recorded (owner/repo/N)'),
  workDirectory: z.string().optional().describe('Absolute path of the work directory (omitted on dry_run or when it could not be created)'),
  dryRun: DRY_RUN_FIELD,
})

const SESSION_RESTORE = defineCommand({
  path: ['session', 'restore'],
  description: 'Restore lost session flags (such as .pecot-active) from the branch information',
  input: z.object({
    issue_ref: z.string().optional().describe('Issue reference (owner/repo/number)'),
    directory: directorySchema,
    dry_run: z.boolean().default(false).describe('Show what would be recorded without writing anything'),
  }),
  output: SESSION_RESTORE_OUTPUT,
  positional: [],
  shortFlags: { issue_ref: '-i', directory: '-D', dry_run: '-n' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput<z.input<typeof SESSION_RESTORE_OUTPUT>>(input.dry_run, io)
    const target = input.issue_ref === undefined ? inferTarget(input.directory, output) : parseTarget(input.issue_ref, output)
    let title: string
    try {
      title = await fetchIssueTitle(target.owner, target.repository, target.number, output)
    }
    catch (error: unknown) {
      if (!(error instanceof ConfigError)) throw error
      return stopWith(output, error.message, 'config-invalid', FAILURE_EXIT_CODE)
    }
    const issue = issuePath(target.owner, target.repository, target.number)
    if (input.dry_run) {
      output.result({ issue })
      planWorkTarget(output, target.owner, target.repository, target.number)
      return 0
    }
    const recorded = recordWorkTarget(output, target.owner, target.repository, target.number, title, { failWithExit: true })
    output.result({ issue, ...recorded.workDirectory !== undefined && { workDirectory: recorded.workDirectory } })
    return 0
  },
})

/**
session のグループのコマンド。start は session-start.ts、finish は session-finish.ts にある。並びは help の一覧に出る順
*/
export const SESSION_COMMANDS: readonly CommandDefinition[] = [...SESSION_START_COMMANDS, SESSION_SHOW, SESSION_RESTORE, ...SESSION_FINISH_COMMANDS]
