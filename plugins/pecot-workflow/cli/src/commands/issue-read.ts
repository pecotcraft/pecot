// issue read。cli/commands/issue.py の issue_read の移植。
import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import type { JsonObject } from '../domain/json.js'
import { JSON_NULL } from '../domain/json-null.js'
import { describePrerequisiteState, describeReadiness } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import { createRepositoryReference, repositoryFullName } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { IssueSlim } from '../infra/github/issues.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { stopWith, requireActiveConfigPlain } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from './issue-shared.js'
import { createReadinessCache, readIssueReadiness, readinessJson } from './issue-readiness.js'
import type { JudgedIssue } from './issue-readiness.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { issueLabel } from './issue-board.js'

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
  readonly blockedBy: readonly JsonObject[]
  readonly readiness: JsonObject | typeof JSON_NULL
}

const UNREAD: ReadinessView = { lines: [], blockedBy: [], readiness: JSON_NULL }

function readinessView(judged: Readonly<JudgedIssue>): ReadinessView {
  const home = judged.ref.repository
  const { prerequisites, readiness } = judged
  const text = readiness === undefined ? undefined : describeReadiness(readiness, prerequisites, home)
  const entries = prerequisites.map(({ issue, wait, reason }) => ({
    label: issueLabel(issue.ref, home),
    title: judged.titles.get(issueReferenceKey(issue.ref)) ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    status: describePrerequisiteState({ issue, wait, reason }),
    wait,
    reason,
    ref: issue.ref,
  }))
  const lines = prerequisites.length === 0
    ? []
    : [`**Blocked by:** ${entries.map(entry => `${entry.label} ${entry.title} (${entry.state}, ${entry.status})`).join(', ')}`, ...text === undefined ? [] : [`**Readiness:** ${text}`]]
  return {
    lines,
    blockedBy: entries.map(entry => ({ number: entry.ref.number, repository: repositoryFullName(entry.ref.repository), state: entry.state, wait: entry.wait, reason: entry.reason ?? JSON_NULL })),
    readiness: readiness === undefined || text === undefined ? JSON_NULL : readinessJson(readiness, text),
  }
}

function warnAboutSections(out: Readonly<Output>, judged: Readonly<JudgedIssue>): void {
  const home = judged.ref.repository
  const self = issueLabel(judged.ref, undefined)
  for (const mismatch of judged.mismatches) {
    out.warning(`Waits for merge of ${self} lists ${issueLabel(mismatch.ref, home)}, which is not a blocked-by of it`)
  }
  if (judged.malformedReason !== undefined) out.warning(`Waits for merge of ${self} is malformed: ${judged.malformedReason}`)
}

// 判定が読めなくても、今までの出力は止めない
async function readView(out: Readonly<Output>, client: Readonly<GitHubClient>, config: ProjectConfig, target: Readonly<{ owner: string, repository: string, number: number }>): Promise<ReadinessView> {
  const reference = createIssueReference(createRepositoryReference(target.owner, target.repository), target.number)
  try {
    const result = await readIssueReadiness(client, config, reference, createReadinessCache())
    if (result.kind === 'unreadable') {
      out.warning(`could not read blocked-by of #${String(target.number)}: ${result.reason}`)
      return UNREAD
    }
    warnAboutSections(out, result)
    return readinessView(result)
  }
  catch (error: unknown) {
    if (!(error instanceof DependenciesUnsupportedError)) throw error
    out.warning(`could not read blocked-by of #${String(target.number)}: ${error.message}`)
    return UNREAD
  }
}

const ISSUE_READ = defineCommand({
  path: ['issue', 'read'],
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
        return stopWith(output, `could not read Issue ${issuePath(owner, repository, number)}: ${error.message}`)
      }

      const view = await readView(output, client, config, { owner, repository, number })
      output.data(input.json
        ? JSON.stringify({ ...issue, owner, repo: repository, blockedBy: view === UNREAD ? JSON_NULL : view.blockedBy, readiness: view.readiness }, undefined, 2)
        : formatIssueMarkdown(issue, owner, repository, view))
    })
  },
})

export const ISSUE_READ_COMMANDS: readonly CommandDefinition[] = [ISSUE_READ]
