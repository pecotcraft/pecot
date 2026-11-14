/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
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
import type { GitHubClient } from '../infra/github/index.js'
import { OutputPathReservationError, outputDirectory, withReservedOutputPath } from '../infra/paths.js'
import { readTextFile } from '../infra/text-file.js'
import { templateFile } from '../infra/template-store.js'
import { defineCommand, CommandExit } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, inputNameHint, placeholder } from './command-hint.js'
import { stopWith, requireActiveConfigPlain } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import {
  COMMENT_VALIDATION_EXIT_CODE,
  hasReportedTemplateViolations,
  issuePath,
  parseIssueReferenceOrExit,
  runWithExit,
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
function prepareTemplate(output: Output, template: string, issueReference: string | undefined, isDryRun: boolean): void {
  const templatePath = templateFile('comment', template)
  if (!existsSync(templatePath)) {
    stopWith(output, `template not found: ${templatePath}`, 'other')
  }
  if (isDryRun) {
    output.planned({ verb: 'create', target: `comment template ${template} in ${outputDirectory()}` })
    return
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
    stopWith(output, error.message, 'other')
  }
}

// comment_url からコメントの id を取る。issue_ref と別の Issue を指していたら終了コード 1
function commentIdFor(output: Output, commentUrl: string, host: string, target: IssueTarget): number {
  const groups = COMMENT_URL_PATTERN.exec(pythonStrip(commentUrl))?.groups
  if (groups === undefined) {
    return stopWith(output, `comment_url has the wrong form: ${commentUrl}\nexpected: https://<host>/<owner>/<repo>/{issues|pull}/<number>#issuecomment-<id>`, 'invalid-input')
  }
  const { host: urlHost = '', owner = '', repo: urlRepository = '', number = '', id = '' } = groups
  if (urlHost.toLowerCase() !== host.toLowerCase()) {
    return stopWith(output, `the host of comment_url (${urlHost}) differs from the configured host (${host})`, 'invalid-input')
  }
  const isSameIssue = owner.toLowerCase() === target.owner.toLowerCase()
    && urlRepository.toLowerCase() === target.repository.toLowerCase()
    && Number(number) === target.number
  const message = `comment_url (${owner}/${urlRepository}/${number}) points to a different Issue than issue_ref (${target.owner}/${target.repository}/${String(target.number)})`
  return isSameIssue ? Number(id) : stopWith(output, message, 'invalid-input')
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

// コメントを作って created の行と URL を出す。失敗は error の行と終了コード 1。作ったコメントの URL を返す
async function createComment(output: Output, client: GitHubClient, target: IssueTarget, body: string): Promise<string> {
  const display = issuePath(target.owner, target.repository, target.number)
  let comment
  try {
    comment = await client.addIssueComment(target.owner, target.repository, target.number, body)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(output, `could not create a comment on Issue ${display}: ${error.message}`, kindOfFailure(error))
  }
  const createdUrl = htmlUrlOf(comment, '')
  output.done({ verb: 'create', target: `comment on ${display}` })
  output.data(createdUrl)
  return createdUrl
}

// comment_url のコメントを書き換える。失敗は error の行と終了コード 1
async function updateComment(output: Output, client: GitHubClient, target: IssueTarget, commentId: number, commentUrl: string, body: string): Promise<void> {
  const display = issuePath(target.owner, target.repository, target.number)
  let comment
  try {
    comment = await client.updateIssueComment(target.owner, target.repository, commentId, body)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(output, `could not update the comment on Issue ${display}: ${error.message}`, kindOfFailure(error))
  }
  output.done({ verb: 'update', target: `comment on ${display}` })
  output.data(htmlUrlOf(comment, commentUrl))
}

async function postFromFile(output: Output, config: ProjectConfig, repository: string | undefined, file: string, isDryRun: boolean): Promise<void> {
  let parsed
  try {
    parsed = parseCommentFile(file)
  }
  catch (error: unknown) {
    if (!(error instanceof FrontmatterError)) throw error
    return stopWith(output, error.message, 'content-invalid')
  }
  const { frontmatter, body } = parsed

  const target = parseIssueReferenceOrExit(output, repository, frontmatter.issue_ref)

  if (frontmatter.template === undefined) {
    return stopWith(output, `specify template in the frontmatter (${TEMPLATE_CHOICES})`, 'content-invalid')
  }
  if (hasReportedTemplateViolations(output, body, templateFile('comment', frontmatter.template))) throw new CommandExit(COMMENT_VALIDATION_EXIT_CODE, 'content-invalid')

  // comment_url は、issue_ref と同じ Issue のコメントに限る
  const commentUrl = frontmatter.comment_url
  const hasCommentUrl = commentUrl !== undefined && commentUrl !== ''
  const commentId = hasCommentUrl ? commentIdFor(output, commentUrl, config.host, target) : 0

  const client = createGitHubClient(output, config.host)
  if (!await isRepositoryInProject(config, target.owner, target.repository, client)) {
    output.warning(`${target.owner}/${target.repository} is not in the project`)
  }
  if (isDryRun) {
    const display = issuePath(target.owner, target.repository, target.number)
    output.planned({ verb: hasCommentUrl ? 'update' : 'create', target: `comment on ${display}` })
    if (!hasCommentUrl) output.planned({ verb: 'set', target: `comment_url in ${file}` })
    return
  }

  if (hasCommentUrl) {
    await updateComment(output, client, target, commentId, commentUrl, body)
    return
  }
  const createdUrl = await createComment(output, client, target, body)
  if (createdUrl !== '') writeBackCommentUrl(output, file, createdUrl)
}

async function postDirect(output: Output, config: ProjectConfig, repository: string | undefined, issueReference: string, message: string, template: string, isDryRun: boolean): Promise<void> {
  const target = parseIssueReferenceOrExit(output, repository, issueReference)

  if (hasReportedTemplateViolations(output, message, templateFile('comment', template))) throw new CommandExit(COMMENT_VALIDATION_EXIT_CODE, 'content-invalid')

  if (isDryRun) {
    output.planned({ verb: 'create', target: `comment on ${issuePath(target.owner, target.repository, target.number)}` })
    return
  }
  await createComment(output, createGitHubClient(output, config.host), target, message)
}

const COMMENT_PATH = ['issue', 'comment']

const ISSUE_COMMENT = defineCommand({
  path: COMMENT_PATH,
  description: 'Post a comment on an Issue',
  input: z.object({
    file: z.string().optional().describe('Path of a Markdown file with frontmatter'),
    message: z.string().optional().describe('Comment body'),
    issue_ref: z.string().optional().describe('Issue reference (owner/repo/123 form, required with -m)'),
    prepare: z.boolean().default(false).describe('Copy a template to the work directory'),
    template: TEMPLATE_SCHEMA.optional().describe(
      'Template type (required with --prepare and -m; plan/merge-diff/review-findings/review-resolution/precede-notify)',
    ),
    dry_run: z.boolean().default(false).describe('Show what would be posted or written without changing anything'),
  }),
  positional: ['file'],
  shortFlags: { message: '-m', issue_ref: '-i', prepare: '-p', template: '-t', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(input.dry_run, io)
    return await runWithExit(async () => {
      const { file, message, issue_ref: issue, prepare, template } = input
      if (template === undefined && (prepare || (message !== undefined && file === undefined))) {
        stopWith(output, hinted`specify a template with ${inputNameHint(COMMENT_PATH, 'template')} (${TEMPLATE_CHOICES})`, 'invalid-input')
      }
      if (prepare && template !== undefined) {
        prepareTemplate(output, template, issue, input.dry_run)
        return
      }
      if (file !== undefined) {
        await postFromFile(output, requireActiveConfigPlain(output), input.repo, file, input.dry_run)
        return
      }
      if (message !== undefined && template !== undefined) {
        if (issue === undefined || issue === '') {
          stopWith(output, hinted`${inputNameHint(COMMENT_PATH, 'issue_ref')} (Issue reference) is required with ${inputNameHint(COMMENT_PATH, 'message')}`, 'invalid-input')
        }
        await postDirect(output, requireActiveConfigPlain(output), input.repo, issue, message, template, input.dry_run)
        return
      }
      stopWith(
        output,
        hinted`missing arguments
direct posting: ${commandHint(COMMENT_PATH, { message: placeholder('MESSAGE'), template: placeholder('template'), issue_ref: 'owner/repo/123' })}
prepare a template: ${commandHint(COMMENT_PATH, { prepare: true, template: placeholder('template') })}
from a file: ${commandHint(COMMENT_PATH, { file: placeholder('path') })}`,
        'invalid-input',
      )
    })
  },
})

export const ISSUE_COMMENT_COMMANDS: readonly CommandDefinition[] = [ISSUE_COMMENT]
