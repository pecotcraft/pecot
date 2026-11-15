// issue show。cli/commands/issue.py の issue_read の移植。
import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { JSON_NULL } from '../domain/json-null.js'
import { describePrerequisiteState, describeReadiness, describeUnknown, displayReference, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import type { IssueFacts, Readiness } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, repositoryFullName } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { IssueSlim } from '../infra/github/issues.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { stopWith, requireActiveConfigPlain } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from './issue-shared.js'
import { blockedByReadCount, createReadinessCache, judgeSnapshot, readIssueReadiness, readinessJson, snapshotWithoutPrerequisites } from './issue-readiness.js'
import type { IssueSnapshot, JudgedIssue } from './issue-readiness.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'

const MAX_COMMENT_LIMIT = 20
const DEFAULT_COMMENT_LIMIT = 5

function parentLine(issue: IssueSlim, owner: string, repository: string): string | undefined {
  const { parent } = issue
  if (parent === null) return undefined
  const isCrossRepository = parent.owner !== null && parent.repo !== null && (parent.owner !== owner || parent.repo !== repository)
  const label = isCrossRepository ? `${parent.owner}/${parent.repo}#${String(parent.number)}` : `#${String(parent.number)}`
  return `**Parent:** ${label} ${parent.title} (${parent.state})`
}

/**
Issue の情報を Markdown にする。owner・repo は、親が別のリポジトリかを調べる元
*/
function formatIssueMarkdown(issue: IssueSlim, owner: string, repository: string, readinessLines: readonly string[]): string {
  const lines = [`## #${String(issue.number)} ${issue.title}`, '']

  const meta = [`**State:** ${issue.state}`]
  if (issue.comments.total_count > 0) meta.push(`**Comments:** ${String(issue.comments.total_count)}`)
  lines.push(meta.join(' | '), '')

  const parent = parentLine(issue, owner, repository)
  const header = [...parent === undefined ? [] : [parent], ...readinessLines]
  if (header.length > 0) lines.push(...header, '')

  if (issue.linked_branches.length > 0) {
    lines.push('**Branches:**', ...issue.linked_branches.map(branch => `  - \`${branch}\``), '')
  }
  if (issue.linked_prs.length > 0) {
    lines.push('**Linked PRs:**', ...issue.linked_prs.map(pr => `  - #${String(pr.number)} ${pr.title} (${pr.state})`), '')
  }
  if (issue.sub_issues.length > 0) {
    lines.push('**Sub-issues:**', ...issue.sub_issues.map(sub => `  - #${String(sub.number)} ${sub.title} (${sub.state})`), '')
  }

  lines.push('---', '', issue.body)

  const comments = issue.comments.nodes
  if (comments.length > 0) {
    lines.push('', '', `### Comments (${String(comments.length)}/${String(issue.comments.total_count)})`, '')
    for (const comment of comments) {
      lines.push('---', '', `**@${comment.author}** - ${comment.created_at.slice(0, 10)}`, '', comment.body, '')
    }
  }
  return lines.join('\n')
}

const PREREQUISITE_JSON = z.strictObject({
  number: z.int().describe('Issue number of the prerequisite'),
  repository: z.string().describe('Repository of the prerequisite (owner/repo)'),
  state: z.enum(['OPEN', 'CLOSED']).describe('State of the prerequisite'),
  wait: z.enum(['stack', 'merge']).describe('How to wait for the prerequisite (stack on its branch, or wait for its merge)'),
  reason: z.string().nullable().describe('Reason written in the Waits for merge section (null when none)'),
})

const STACK_ON_JSON = z.strictObject({
  number: z.int().describe('Issue number to stack on'),
  repository: z.string().describe('Repository of that Issue (owner/repo)'),
  branch: z.string().describe('Branch to stack on'),
})

const READINESS_JSON = z.strictObject({
  kind: z.enum(['startable', 'stackable', 'blocked']).describe('Readiness judgment'),
  stackOn: STACK_ON_JSON.nullable().describe('Prerequisite to stack on (null unless stackable)'),
  reason: z.string().nullable().describe('Code of the reason for blocked (null unless blocked)'),
  text: z.string().describe('Readiness as shown in the Readiness line'),
})

const COMMENT_JSON = z.strictObject({
  author: z.string().describe('Login of the author (ghost when deleted)'),
  created_at: z.string().describe('Creation time (ISO 8601)'),
  body: z.string().describe('Body of the comment'),
})

const COMMENTS_JSON = z.strictObject({
  total_count: z.int().describe('Number of all comments'),
  nodes: z.array(COMMENT_JSON).describe('Latest comments, up to comment_limit'),
})

const PARENT_JSON = z.strictObject({
  number: z.int().describe('Issue number of the parent'),
  title: z.string().describe('Title of the parent'),
  state: z.string().describe('State of the parent (OPEN or CLOSED)'),
  owner: z.string().nullable().describe('Owner of the parent repository'),
  repo: z.string().nullable().describe('Name of the parent repository'),
})

const SUB_ISSUE_JSON = z.strictObject({
  number: z.int().describe('Issue number of the sub-issue'),
  state: z.string().describe('State of the sub-issue (OPEN or CLOSED)'),
  title: z.string().describe('Title of the sub-issue'),
})

const LINKED_PR_JSON = z.strictObject({
  number: z.int().describe('PR number'),
  title: z.string().describe('Title of the PR'),
  state: z.string().describe('State of the PR'),
})

const ISSUE_SHOW_OUTPUT = z.strictObject({
  number: z.int().describe('Issue number'),
  state: z.string().describe('State of the Issue (OPEN or CLOSED)'),
  title: z.string().describe('Title of the Issue'),
  body: z.string().describe('Body of the Issue'),
  comments: COMMENTS_JSON.describe('Comments of the Issue'),
  parent: PARENT_JSON.nullable().describe('Parent Issue (null when none)'),
  sub_issues: z.array(SUB_ISSUE_JSON).describe('Sub-issues'),
  linked_branches: z.array(z.string()).describe('Branches linked to the Issue'),
  linked_prs: z.array(LINKED_PR_JSON).describe('PRs linked to the Issue'),
  owner: z.string().describe('Owner of the Issue repository'),
  repo: z.string().describe('Name of the Issue repository'),
  blockedBy: z.array(PREREQUISITE_JSON).nullable().describe('Prerequisites (blocked by) of the Issue (null when they could not be read)'),
  readiness: READINESS_JSON.nullable().describe('Readiness judgment (null when it could not be judged)'),
})

type IssueShowJson = z.input<typeof ISSUE_SHOW_OUTPUT>
type PrerequisiteJson = z.input<typeof PREREQUISITE_JSON>

interface ReadinessView {
  readonly lines: readonly string[]
  readonly blockedBy: readonly Readonly<PrerequisiteJson>[] | typeof JSON_NULL
  readonly readiness: Readonly<z.input<typeof READINESS_JSON>> | typeof JSON_NULL
}

// 前提と判定を読めなかったとき
const UNREAD: ReadinessView = { lines: [], blockedBy: JSON_NULL, readiness: JSON_NULL }

type PrerequisiteSource = Pick<IssueSnapshot, 'ref' | 'prerequisites' | 'titles'>

/**
前提の行と JSON。Readiness の行は text が渡されたときだけ足す（Epic と Tracker は判定が無い）
*/
function readinessView(source: Readonly<PrerequisiteSource>, readiness: Readiness | undefined, text: string | undefined): ReadinessView {
  const home = source.ref.repository
  const entries = source.prerequisites.map((prerequisite) => {
    const { issue, wait, reason } = prerequisite
    const state: PrerequisiteJson['state'] = issue.state === 'open' ? 'OPEN' : 'CLOSED'
    return {
      label: displayReference(issue.ref, home),
      title: source.titles.get(issueReferenceKey(issue.ref)) ?? '',
      state,
      status: describePrerequisiteState(prerequisite),
      wait,
      reason,
      ref: issue.ref,
    }
  })
  const lines = entries.length === 0
    ? []
    : [`**Blocked by:** ${entries.map(entry => `${entry.label} ${entry.title} (${entry.state}, ${entry.status})`).join(', ')}`, ...text === undefined ? [] : [`**Readiness:** ${text}`]]
  return {
    lines,
    blockedBy: entries.map(entry => ({ number: entry.ref.number, repository: repositoryFullName(entry.ref.repository), state: entry.state, wait: entry.wait, reason: entry.reason ?? JSON_NULL })),
    // 形は board show と共有の readinessJson が決める。型の付いた値にするため schema で読み直す
    readiness: readiness === undefined || text === undefined ? JSON_NULL : READINESS_JSON.parse(readinessJson(readiness, text)),
  }
}

/**
--json の標準出力と MCP の data の中身。キーを並べた順が --json の出力の順になる
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の入れ子の型
function issueShowJson(issue: Readonly<IssueSlim>, owner: string, repository: string, view: Readonly<ReadinessView>): IssueShowJson {
  return {
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    comments: { total_count: issue.comments.total_count, nodes: [...issue.comments.nodes] },
    parent: issue.parent,
    sub_issues: [...issue.sub_issues],
    linked_branches: [...issue.linked_branches],
    linked_prs: [...issue.linked_prs],
    owner,
    repo: repository,
    blockedBy: view.blockedBy === JSON_NULL ? JSON_NULL : [...view.blockedBy],
    readiness: view.readiness,
  }
}

function judgedView(judged: Readonly<JudgedIssue>): ReadinessView {
  const { readiness } = judged
  return readinessView(judged, readiness, readiness === undefined ? undefined : describeReadiness(readiness, judged.prerequisites, judged.ref.repository))
}

function warnAboutSections(out: Readonly<Output>, source: Readonly<Pick<IssueSnapshot, 'ref' | 'mismatches' | 'malformedReason'>>): void {
  const home = source.ref.repository
  const self = displayReference(source.ref, home)
  for (const mismatch of source.mismatches) {
    out.warning(`Waits for merge of ${self} lists ${displayReference(mismatch.ref, home)}, which is not a blocked-by of it`)
  }
  if (source.malformedReason !== undefined) out.warning(`Waits for merge of ${self} is malformed: ${source.malformedReason}`)
}

// 前提が無いと分かっている Issue の判定。API は呼ばない。Epic と Tracker は判定を出さない
async function readWithoutPrerequisites(client: Readonly<GitHubClient>, config: ProjectConfig, issue: Readonly<IssueSlim>, reference: IssueReference): Promise<JudgedIssue> {
  const isGrouping = issue.sub_issues.length > 0 || issue.title.startsWith(TRACKER_TITLE_PREFIX)
  const target: IssueFacts = { ref: reference, state: issue.state.toLowerCase() === 'open' ? 'open' : 'closed', column: undefined, label: undefined, kind: isGrouping ? 'epic' : 'task', branches: issue.linked_branches, pullRequests: [] }
  const result = await judgeSnapshot(client, snapshotWithoutPrerequisites(config, { title: issue.title, target, parent: undefined }), createReadinessCache())
  if (result.kind === 'unreadable') throw new Error('unreachable: a snapshot without prerequisites is always judged')
  return result
}

// 判定が読めなくても、今までの出力は止めない
async function readView(out: Readonly<Output>, client: Readonly<GitHubClient>, config: ProjectConfig, issue: Readonly<IssueSlim>, reference: IssueReference): Promise<ReadinessView> {
  const label = displayReference(reference, reference.repository)
  try {
    const result = issue.blockedByCount === 0
      ? await readWithoutPrerequisites(client, config, issue, reference)
      : await readIssueReadiness(client, config, reference, createReadinessCache(), undefined, blockedByReadCount(issue.blockedByCount))
    if (result.kind === 'unreadable') {
      const { snapshot } = result
      if (snapshot === undefined) {
        out.warning(`could not read blocked-by of ${label}: ${result.reason}`)
        return UNREAD
      }
      out.warning(`could not judge readiness of ${label}: ${result.reason}`)
      warnAboutSections(out, snapshot)
      return readinessView(snapshot, undefined, describeUnknown(result.reason))
    }
    warnAboutSections(out, result)
    return judgedView(result)
  }
  catch (error: unknown) {
    if (!(error instanceof DependenciesUnsupportedError)) throw error
    out.warning(`could not read blocked-by of ${label}: ${error.message}`)
    return UNREAD
  }
}

const ISSUE_SHOW = defineCommand({
  path: ['issue', 'show'],
  description: 'Fetch Issue details efficiently (GraphQL, only the needed fields)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    json: z.boolean().default(false).describe('Output as JSON'),
    comment_limit: z.int().min(0).max(MAX_COMMENT_LIMIT).default(DEFAULT_COMMENT_LIMIT).describe('Number of comments to show (0-20; 0 hides them)'),
  }),
  output: ISSUE_SHOW_OUTPUT,
  positional: ['issue_ref'],
  shortFlags: { json: '-j', comment_limit: '-c' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput<IssueShowJson>(false, io)
    return await runWithExit(async () => {
      const config = requireActiveConfigPlain(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)

      let issue: IssueSlim
      const client = createGitHubClient(output, config.host)
      try {
        issue = await client.getIssueSlim(owner, repository, number, input.comment_limit)
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        return stopWith(output, `could not read Issue ${issuePath(owner, repository, number)}: ${error.message}`, kindOfFailure(error))
      }

      const view = await readView(output, client, config, issue, createIssueReference(createRepositoryReference(owner, repository), number))
      const json = issueShowJson(issue, owner, repository, view)
      output.result(json)
      output.data(input.json ? JSON.stringify(json, undefined, 2) : formatIssueMarkdown(issue, owner, repository, view.lines))
    })
  },
})

export const ISSUE_SHOW_COMMANDS: readonly CommandDefinition[] = [ISSUE_SHOW]
