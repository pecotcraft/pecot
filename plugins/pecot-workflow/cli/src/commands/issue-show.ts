// issue show。cli/commands/issue.py の issue_read の移植。
import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import type { JsonObject } from '../domain/json.js'
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
function formatIssueMarkdown(issue: IssueSlim, owner: string, repository: string, readiness?: Readonly<ReadinessView>): string {
  const lines = [`## #${String(issue.number)} ${issue.title}`, '']

  const meta = [`**State:** ${issue.state}`]
  if (issue.comments.total_count > 0) meta.push(`**Comments:** ${String(issue.comments.total_count)}`)
  lines.push(meta.join(' | '), '')

  const parent = parentLine(issue, owner, repository)
  const header = [...parent === undefined ? [] : [parent], ...readiness?.lines ?? []]
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

interface ReadinessView {
  readonly lines: readonly string[]
  readonly blockedBy: readonly JsonObject[] | typeof JSON_NULL
  readonly readiness: JsonObject | typeof JSON_NULL
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
    return {
      label: displayReference(issue.ref, home),
      title: source.titles.get(issueReferenceKey(issue.ref)) ?? '',
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
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
    readiness: readiness === undefined || text === undefined ? JSON_NULL : readinessJson(readiness, text),
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
  positional: ['issue_ref'],
  shortFlags: { json: '-j', comment_limit: '-c' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
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

      const jsonFields = { ...issue, blockedByCount: undefined }
      const view = await readView(output, client, config, issue, createIssueReference(createRepositoryReference(owner, repository), number))
      output.data(input.json
        ? JSON.stringify({ ...jsonFields, owner, repo: repository, blockedBy: view.blockedBy, readiness: view.readiness }, undefined, 2)
        : formatIssueMarkdown(issue, owner, repository, view))
    })
  },
})

export const ISSUE_SHOW_COMMANDS: readonly CommandDefinition[] = [ISSUE_SHOW]
