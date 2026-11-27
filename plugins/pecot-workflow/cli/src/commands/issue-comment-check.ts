// issue_comment_check。add_issue_comment・update_issue_comment に渡す前の引数が、pecot の決まりに合うかを返す
import { z } from 'zod'

import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { closedHeadingGuidance, EM_DASH_HINT, templateViolations } from '@pecot/workflow-core/domain/template-violations.js'
import type { TemplateViolation, TemplateViolationCode } from '@pecot/workflow-core/domain/template-violations.js'
import { readTemplateSections } from '@pecot/workflow-core/infra/template-sections.js'
import { templateFile } from '../infra/template-store.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { ISSUE_READ_COMMENTS, parseOfficial } from './official-reads.js'

const BUNDLED_PREFIX = 'pecot-template://'
const COMMENT_PREFIX = `${BUNDLED_PREFIX}comment/`
export const COMMENT_TEMPLATES: readonly string[] = ['plan', 'merge-diff', 'review-findings', 'review-resolution', 'precede-notify']

// PR へのコメントは GitHub が /pull/ の形で html_url を返すので、両方受ける
const COMMENT_URL_PATTERN = /^https?:\/\/[^/]+\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?:issues|pull)\/(?<number>\d+)#issuecomment-\d+$/u

const ISSUE_COMMENT_CHECK_INPUT = z.object({
  method: z.enum(['add', 'update']).describe('add before add_issue_comment, update before update_issue_comment'),
  owner: z.string().min(1).describe('Owner of the repository of the Issue or PR the comment is on'),
  repo: z.string().min(1).describe('Name of the repository of the Issue or PR the comment is on'),
  issue_number: z.number().int().min(1).describe('Number of the Issue or PR the comment is on; with update, the Issue the comment must belong to'),
  comment_id: z.number().int().min(1).optional().describe('With update only: id of the comment to rewrite (the id in the result of add_issue_comment)'),
  body: z.string().describe('Comment body, as passed to the write tool'),
  template: z.string().optional().describe('Template the body follows: pecot-template://comment/<name> for a bundled one (its rules are checked); a replaced template\'s path or URL is accepted without checking the body'),
  template_text: z.string().optional().describe('Text of a replaced template; the body is not checked against it'),
  reads: z.object({
    comments: z.unknown().optional().describe('With update: the result of issue_read with method get_comments for the same Issue'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

const ISSUE_COMMENT_CHECK_OUTPUT = z.strictObject(CHECK_RESULT_SHAPE)

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

function templateProblems(body: string, template: string): readonly CheckProblem[] {
  if (!template.startsWith(BUNDLED_PREFIX)) return []
  const stem = template.slice(COMMENT_PREFIX.length)
  if (!template.startsWith(COMMENT_PREFIX) || !COMMENT_TEMPLATES.includes(stem)) {
    const candidates = COMMENT_TEMPLATES.map(name => `${COMMENT_PREFIX}${name}`)
    return [{ field: 'template', code: 'unknown-template', message: `${template} is not a bundled comment template; use one of the candidates, or the path or URL of a replaced template`, candidates }]
  }
  const required = readTemplateSections(templateFile('comment', stem))
  return templateViolations(body, { stem, required }).map(violation => ({ field: 'body', code: violation.code, message: violationMessage(violation, template, stem) }))
}

interface CommentTarget {
  readonly owner: string
  readonly repo: string
  readonly issue_number: number
}

// html_url が読めない形なら、別の Issue とは決めない
function isOnTarget(htmlUrl: string, target: Readonly<CommentTarget>): boolean {
  const groups = COMMENT_URL_PATTERN.exec(htmlUrl)?.groups
  return groups === undefined || (groups['owner']?.toLowerCase() === target.owner.toLowerCase()
    && groups['repo']?.toLowerCase() === target.repo.toLowerCase()
    && Number(groups['number']) === target.issue_number)
}

function updateProblems(output: Readonly<Output>, target: Readonly<CommentTarget>, commentId: number | undefined, readComments: unknown): readonly CheckProblem[] {
  if (commentId === undefined) return [{ field: 'comment_id', code: 'required', message: 'update needs comment_id, the id of the comment to rewrite' }]
  const issue = `${target.owner}/${target.repo}/${String(target.issue_number)}`
  if (readComments === undefined) {
    return [{ field: 'reads.comments', code: 'read-required', message: `read the comments of ${issue} with issue_read (method get_comments) and pass its result as reads.comments` }]
  }
  const comments = parseOfficial(output, 'issue_read', ISSUE_READ_COMMENTS, readComments, 'reads.comments').comments ?? []
  const found = comments.find(comment => comment.id === commentId)
  if (found === undefined) {
    return [{ field: 'comment_id', code: 'not-found', message: `comment ${String(commentId)} is not in reads.comments: it is on another Issue than ${issue}, or on a page of issue_read get_comments not read yet (read the next page with page)` }]
  }
  return isOnTarget(found.html_url, target) ? [] : [{ field: 'comment_id', code: 'other-issue', message: `comment ${String(commentId)} (${found.html_url}) is on another Issue than ${issue}` }]
}

function addProblems(commentId: number | undefined): readonly CheckProblem[] {
  return commentId === undefined ? [] : [{ field: 'comment_id', code: 'unexpected', message: 'add_issue_comment creates a new comment and takes no comment_id; use method update to rewrite a comment' }]
}

const ISSUE_COMMENT_CHECK = defineTool({
  name: 'issue_comment_check',
  title: 'Check issue comment',
  description: 'Check the arguments for add_issue_comment or update_issue_comment against the pecot rules before writing: the bundled comment template the body follows, and with update, that the comment belongs to the Issue. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  openWorld: false,
  input: ISSUE_COMMENT_CHECK_INPUT,
  output: ISSUE_COMMENT_CHECK_OUTPUT,
  run: (input, io) => {
    const output = createOutput<z.input<typeof ISSUE_COMMENT_CHECK_OUTPUT>>(false, io)
    const { method, comment_id: commentId, body, template, reads } = input
    const commentProblems = method === 'add' ? addProblems(commentId) : updateProblems(output, input, commentId, reads?.comments)
    const problems = [...commentProblems, ...template === undefined ? [] : templateProblems(body, template)]
    output.result({ problems })
    output.data(problems.length === 0 ? 'ok' : problems.map(problem => `${problem.field}: ${problem.message}`).join('\n'))
    return Promise.resolve(0)
  },
})

export const ISSUE_COMMENT_CHECK_TOOLS: readonly ToolDefinition[] = [ISSUE_COMMENT_CHECK]
