// issue read。cli/commands/issue.py の issue_read の移植。
import { z } from 'zod'

import { GitHubAPIError } from '../infra/github/errors.js'
import type { IssueSlim } from '../infra/github/issues.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { createClient, ISSUE_REF_DESCRIPTION, issuePath, loadConfigOrExit, parseIssueReferenceOrExit, runWithExit, throwExit } from './issue-shared.js'
import { createOutput } from './output.js'

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
function formatIssueMarkdown(issue: IssueSlim, owner: string, repository: string): string {
  const lines = [`## #${String(issue.number)} ${issue.title}`, '']

  const meta = [`**State:** ${issue.state}`]
  if (issue.comments.total_count > 0) meta.push(`**Comments:** ${String(issue.comments.total_count)}`)
  lines.push(meta.join(' | '), '')

  const parent = parentLine(issue, owner, repository)
  if (parent !== undefined) lines.push(parent, '')

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
      const config = loadConfigOrExit(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)

      let issue: IssueSlim
      try {
        issue = await createClient(config, output).getIssueSlim(owner, repository, number, input.comment_limit)
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        output.error(`could not read Issue ${issuePath(owner, repository, number)}: ${error.message}`)
        return throwExit(1)
      }

      output.data(input.json ? JSON.stringify({ ...issue, owner, repo: repository }, undefined, 2) : formatIssueMarkdown(issue, owner, repository))
    })
  },
})

export const ISSUE_READ_COMMANDS: readonly CommandDefinition[] = [ISSUE_READ]
