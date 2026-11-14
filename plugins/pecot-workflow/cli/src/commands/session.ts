// session show・session restore。cli/commands/session.py の移植。
import { z } from 'zod'

import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { ConfigError } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { PecotError } from '../domain/errors.js'
import { describeReadiness } from '../domain/readiness.js'
import { parseIssueReference, ReferenceParseError } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { describeStackBase, pickBasePullRequest } from '../domain/work-start.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitCurrentBranch, primaryRemoteRepository } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { hasFlag, readBaseRecord, readFlag } from '../infra/state-store.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'
import { FAILURE_EXIT_CODE } from './failure.js'
import { stopWith } from './command-stop.js'
import { directorySchema } from './directory-option.js'
import { createGitHubClient } from './github-client.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { SESSION_FINISH_COMMANDS } from './session-finish.js'
import { SESSION_START_COMMANDS } from './session-start.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { recordWorkTarget } from './work-target.js'

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

interface ActiveIssue {
  readonly reference: IssueReference
  readonly config: Readonly<ProjectConfig>
  readonly client: Readonly<GitHubClient>
  readonly lines: readonly string[]
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
  return { reference, config, client, lines }
}

// 積んで着手した作業ディレクトリの `## Stack` の節。積んでいなければ空
async function stackLines(active: Readonly<ActiveIssue>, output: Output): Promise<string[]> {
  const reading = readBaseRecord()
  if (reading.kind === 'malformed') output.warning(`.pecot-base is malformed: ${reading.content}`)
  if (reading.kind !== 'stacked') return []
  const { record, stackedOn } = reading
  const { owner, repository } = stackedOn.repository
  let pullRequest: ReturnType<typeof pickBasePullRequest> | 'unknown'
  try {
    const found = await active.client.listPullRequestsByHead(owner, repository, record.branch)
    pullRequest = pickBasePullRequest(found.pullRequests)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`cannot read the PR of the base branch: ${error.message}`)
    pullRequest = 'unknown'
  }
  const readiness = await readinessLines(active, output)
  return ['', '## Stack', describeStackBase(record.branch, stackedOn, pullRequest), ...readiness]
}

// 着手中の Issue の判定が blocked のときだけ出す
async function readinessLines(active: Readonly<ActiveIssue>, output: Output): Promise<string[]> {
  const result = await readIssueReadinessIfSupported(active.client, active.config, active.reference, createReadinessCache())
  if (result === undefined) return []
  if (result.kind === 'unreadable') {
    output.warning(`cannot judge readiness of the active Issue: ${result.reason}`)
    return []
  }
  const { readiness } = result
  return readiness?.kind === 'blocked' ? [`- readiness: ${describeReadiness(readiness, result.prerequisites, active.reference.repository)}`] : []
}

const SESSION_SHOW = defineCommand({
  path: ['session', 'show'],
  description: 'Show the session flag state, branch information, and inferred Issue',
  input: z.object({ directory: directorySchema }),
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    const branch = gitCurrentBranch(input.directory)
    const origin = primaryRemoteRepository(input.directory)
    const issueNumber = branch === undefined ? undefined : extractIssueNumberFromBranch(branch)
    const statuses = collectFlagStatuses()
    const active = await readActiveIssue(statuses, output)

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
      ...active === undefined ? [] : await stackLines(active, output),
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

// --issue が無いときの、ブランチ名と remote からの推定。決められなければ error を出して終了コード 1
function inferTarget(directory: string, output: Output): RestoreTarget {
  const branch = gitCurrentBranch(directory)
  if (branch === undefined) {
    return stopWith(output, 'cannot read the branch name', FAILURE_EXIT_CODE)
  }
  const number = extractIssueNumberFromBranch(branch)
  if (number === undefined) {
    return stopWith(output, `cannot infer the Issue number from the branch name: ${branch}\nrun: pecot session restore --issue <owner/repo/N>`, FAILURE_EXIT_CODE)
  }
  const origin = primaryRemoteRepository(directory)
  const message = 'cannot read the repository information'
  return origin === undefined ? stopWith(output, message, FAILURE_EXIT_CODE) : { owner: origin.owner, repository: origin.repository, number }
}

// --issue の参照を分ける。形が誤っていれば error を出して終了コード 2
function parseTarget(issue: string, output: Output): RestoreTarget {
  try {
    const reference = parseIssueReference(issue)
    return { owner: reference.repository.owner, repository: reference.repository.repository, number: reference.number }
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    return stopWith(output, error.message, USAGE_EXIT_CODE)
  }
}

const SESSION_RESTORE = defineCommand({
  path: ['session', 'restore'],
  description: 'Restore lost session flags (such as .pecot-active) from the branch information',
  input: z.object({
    issue: z.string().optional().describe('Issue reference (owner/repo/number)'),
    directory: directorySchema,
  }),
  positional: [],
  shortFlags: { issue: '-i', directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    const target = input.issue === undefined ? inferTarget(input.directory, output) : parseTarget(input.issue, output)
    let title: string
    try {
      title = await fetchIssueTitle(target.owner, target.repository, target.number, output)
    }
    catch (error: unknown) {
      if (!(error instanceof ConfigError)) throw error
      return stopWith(output, error.message, FAILURE_EXIT_CODE)
    }
    recordWorkTarget(output, target.owner, target.repository, target.number, title, { failWithExit: true })
    return 0
  },
})

/**
session のグループのコマンド。start は session-start.ts、finish は session-finish.ts にある。並びは help の一覧に出る順
*/
export const SESSION_COMMANDS: readonly CommandDefinition[] = [...SESSION_START_COMMANDS, SESSION_SHOW, SESSION_RESTORE, ...SESSION_FINISH_COMMANDS]
