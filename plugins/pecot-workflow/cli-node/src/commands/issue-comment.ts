/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者の引数とテンプレートの置き場で決まる */
// issue comment。cli/commands/issue.py の issue_comment とその内部関数の移植。
import { existsSync, writeFileSync } from 'node:fs'

import { z } from 'zod'

import { isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { FrontmatterError, setFrontmatterValue } from '../domain/frontmatter.js'
import { jsonField } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { pythonStrip } from '../domain/python-format.js'
import { OsError, toOsError } from '../infra/os-error.js'
import { parseCommentFile } from '../infra/frontmatter-file.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { OutputPathReservationError, outputDirectory, withReservedOutputPath } from '../infra/paths.js'
import { readTextFile } from '../infra/text-file.js'
import { templateFile } from '../infra/template-store.js'
import { defineCommand } from './command.js'
import type { CommandDefinition } from './command.js'
import {
  COMMENT_VALIDATION_EXIT_CODE,
  createClient,
  hasReportedTemplateViolations,
  loadConfigOrExit,
  parseIssueReferenceOrExit,
  runWithExit,
  throwExit,
} from './issue-shared.js'
import type { IssueTarget } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'

const TEMPLATE_SCHEMA = z.enum(['plan', 'merge-diff', 'review-findings', 'review-resolution', 'precede-notify'])
const TEMPLATE_CHOICES = TEMPLATE_SCHEMA.options.join(' / ')

// PR へのコメントは GitHub が /pull/ の形で html_url を返すので、両方受ける
const COMMENT_URL_PATTERN = /^https?:\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?:issues|pull)\/(?<number>\d+)#issuecomment-(?<id>\d+)$/u

function htmlUrlOf(comment: JsonObject, fallback: string): string {
  const url = jsonField(comment, 'html_url')
  return typeof url === 'string' ? url : fallback
}

// テンプレートをコピーして、そのパスを標準出力に出す。issue_ref が渡されていれば、コピーの issue_ref に入れる
function prepareTemplate(output: Output, template: string, issueReference: string | undefined): void {
  const templatePath = templateFile('comment', template)
  if (!existsSync(templatePath)) {
    output.error(`template not found: ${templatePath}`)
    throwExit(1)
  }
  let content = readTextFile(templatePath)
  if (issueReference !== undefined && issueReference !== '') {
    content = content.replaceAll('issue_ref: ""', () => `issue_ref: "${issueReference}"`)
  }
  try {
    withReservedOutputPath(outputDirectory(), timestamp => `comment-${template}-${timestamp}.md`, (reserved) => {
      writeFileSync(reserved, content, 'utf8')
      output.data(reserved)
    })
  }
  catch (error: unknown) {
    if (!(error instanceof OutputPathReservationError)) throw error
    output.error(error.message)
    throwExit(1)
  }
}

// comment_url からコメントの id を取る。issue_ref と別の Issue を指していたら終了コード 1
function commentIdFor(output: Output, commentUrl: string, host: string, target: IssueTarget): number {
  const groups = COMMENT_URL_PATTERN.exec(pythonStrip(commentUrl))?.groups
  if (groups === undefined) {
    output.error(`comment_url has the wrong form: ${commentUrl}\nexpected: https://<host>/<owner>/<repo>/{issues|pull}/<number>#issuecomment-<id>`)
    return throwExit(1)
  }
  const { host: urlHost = '', owner = '', repo: urlRepository = '', number = '', id = '' } = groups
  if (urlHost.toLowerCase() !== host.toLowerCase()) {
    output.error(`the host of comment_url (${urlHost}) differs from the configured host (${host})`)
    return throwExit(1)
  }
  const isSameIssue = owner.toLowerCase() === target.owner.toLowerCase()
    && urlRepository.toLowerCase() === target.repository.toLowerCase()
    && Number(number) === target.number
  if (!isSameIssue) {
    output.error(
      `comment_url (${owner}/${urlRepository}/${number}) points to a different Issue than issue_ref (${target.owner}/${target.repository}/${String(target.number)})`,
    )
    return throwExit(1)
  }
  return Number(id)
}

// 次に同じファイルを渡したとき更新になるよう、URL を書き戻す。できなければ warning だけ出す
function writeBackCommentUrl(output: Output, file: string, commentUrl: string): void {
  try {
    const content = readTextFile(file)
    writeFileSync(file, setFrontmatterValue(content, 'comment_url', commentUrl), 'utf8')
  }
  catch (error: unknown) {
    const converted = toOsError(error, file)
    if (converted instanceof OsError || converted instanceof FrontmatterError) {
      output.warning(`could not write comment_url back to the file: ${converted.message}`)
      return
    }
    throw converted
  }
}

async function postFromFile(output: Output, config: ProjectConfig, repository: string | undefined, file: string): Promise<void> {
  let parsed
  try {
    parsed = parseCommentFile(file)
  }
  catch (error: unknown) {
    if (!(error instanceof FrontmatterError)) throw error
    output.error(error.message)
    return throwExit(1)
  }
  const { frontmatter, body } = parsed

  const target = parseIssueReferenceOrExit(output, repository, frontmatter.issue_ref)

  if (frontmatter.template === undefined) {
    output.error(`specify template in the frontmatter (${TEMPLATE_CHOICES})`)
    return throwExit(1)
  }
  if (hasReportedTemplateViolations(output, body, templateFile('comment', frontmatter.template))) throwExit(COMMENT_VALIDATION_EXIT_CODE)

  const display = `${target.owner}/${target.repository}/${String(target.number)}`

  // comment_url は、issue_ref と同じ Issue のコメントに限る
  const commentUrl = frontmatter.comment_url
  const hasCommentUrl = commentUrl !== undefined && commentUrl !== ''
  const commentId = hasCommentUrl ? commentIdFor(output, commentUrl, config.host, target) : 0

  const client = createClient(config, output)
  if (!await isRepositoryInProject(config, target.owner, target.repository, client)) {
    output.warning(`${target.owner}/${target.repository} is not in the project`)
  }

  if (hasCommentUrl) {
    let comment
    try {
      comment = await client.updateIssueComment(target.owner, target.repository, commentId, body)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      output.error(`could not update the comment on Issue ${display}: ${error.message}`)
      return throwExit(1)
    }
    output.done({ verb: 'update', target: `comment on ${display}` })
    output.data(htmlUrlOf(comment, commentUrl))
    return
  }

  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, body)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.error(`could not create a comment on Issue ${display}: ${error.message}`)
    return throwExit(1)
  }
  const createdUrl = htmlUrlOf(comment, '')
  output.done({ verb: 'create', target: `comment on ${display}` })
  output.data(createdUrl)

  if (createdUrl !== '') writeBackCommentUrl(output, file, createdUrl)
}

async function postDirect(output: Output, config: ProjectConfig, repository: string | undefined, issueReference: string, message: string, template: string): Promise<void> {
  const target = parseIssueReferenceOrExit(output, repository, issueReference)
  const display = `${target.owner}/${target.repository}/${String(target.number)}`

  if (hasReportedTemplateViolations(output, message, templateFile('comment', template))) throwExit(COMMENT_VALIDATION_EXIT_CODE)

  const client = createClient(config, output)
  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, message)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.error(`could not create a comment on Issue ${display}: ${error.message}`)
    return throwExit(1)
  }
  output.done({ verb: 'create', target: `comment on ${display}` })
  output.data(htmlUrlOf(comment, ''))
}

const ISSUE_COMMENT = defineCommand({
  path: ['issue', 'comment'],
  description: 'Post a comment on an Issue',
  input: z.object({
    file: z.string().optional().describe('Path of a Markdown file with frontmatter'),
    message: z.string().optional().describe('Comment body'),
    issue: z.string().optional().describe('Issue reference (owner/repo/123 form, required with -m)'),
    prepare: z.boolean().default(false).describe('Copy a template to the work directory'),
    template: TEMPLATE_SCHEMA.optional().describe(
      'Template type (required with --prepare and -m; plan/merge-diff/review-findings/review-resolution/precede-notify)',
    ),
  }),
  positional: ['file'],
  shortFlags: { message: '-m', issue: '-i', prepare: '-p', template: '-t' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const { file, message, issue, prepare, template } = input
      if (template === undefined && (prepare || (message !== undefined && file === undefined))) {
        output.error(`specify a template with -t (${TEMPLATE_CHOICES})`)
        throwExit(1)
      }
      if (prepare && template !== undefined) {
        prepareTemplate(output, template, issue)
        return
      }
      if (file !== undefined) {
        await postFromFile(output, loadConfigOrExit(output), input.repo, file)
        return
      }
      if (message !== undefined && template !== undefined) {
        if (issue === undefined || issue === '') {
          output.error('--issue (Issue reference) is required with -m')
          throwExit(1)
        }
        await postDirect(output, loadConfigOrExit(output), input.repo, issue, message, template)
        return
      }
      output.error(
        'missing arguments\n'
        + 'direct posting: pecot issue comment -m "MESSAGE" -t <template> --issue owner/repo/123\n'
        + 'prepare a template: pecot issue comment --prepare -t <template>\n'
        + 'from a file: pecot issue comment <path>',
      )
      throwExit(1)
    })
  },
})

export const ISSUE_COMMENT_COMMANDS: readonly CommandDefinition[] = [ISSUE_COMMENT]
