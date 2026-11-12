/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
/* eslint-disable security/detect-non-literal-fs-filename -- パスは利用者の引数で決まる */
// issue create。cli/commands/issue.py の issue_create の移植。--prepare・ファイル・-m の 3 つの形がある。
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { FrontmatterError, stripFrontmatter, stripLeadingHtmlComment } from '../domain/frontmatter.js'
import type { IssueFrontmatter } from '../domain/frontmatter.js'
import { FLAG_ISSUE_CREATE_SLASH_PENDING, FLAG_ISSUE_PENDING } from '../domain/state.js'
import { compareStrings, pythonStrip, pythonStringRepr } from '../domain/python-format.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { parseIssueFile } from '../infra/frontmatter-file.js'
import type { GitHubClient } from '../infra/github/index.js'
import { OutputPathReservationError, normalizePath, outputDirectory, resolveRealPath, withReservedOutputPath } from '../infra/paths.js'
import { consumeFlag } from '../infra/state-store.js'
import { templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'
import { defineCommand } from './command.js'
import type { CommandDefinition, CommandIo } from './command.js'
import {
  addToBoardOrWarn,
  buildIssueTitle,
  clientForIssueCreate,
  createIssueOrExit,
  ISSUE_TYPE_SCHEMA,
  issuePath,
  linkToParentEpic,
  loadConfigOrExit,
  normalizeParentEpicCli,
  PARENT_EPIC_DESCRIPTION,
  resolveEpicTargetRepository,
  resolveParentEpicReference,
  runWithExit,
  setIssueFields,
  summarizeCreatedIssue,
  throwExit,
  TYPE_DEFAULT_STATUS,
  validateIssueTemplate,
  validateStatusForType,
  warnEpicRepositoryException,
} from './issue-shared.js'
import type { IssueField, IssueType } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const FILES_SCHEMA = z.array(z.string()).optional().describe('Path of a Markdown file with frontmatter (several for a batch post)')
const LABEL_SCHEMA = z.array(z.string()).optional().describe('Label (can be given several times)')
const TEMPLATE_SCHEMA = z.enum(['task', 'bug', 'epic', 'tracker', 'task-implement']).default('task').describe('Template type (with --prepare: task/bug/epic/tracker/task-implement)')

// 一括投稿の先行 Issue 番号の置き場所。key は先行ファイルの --suffix 由来か、ファイルの stem
const PLACEHOLDER_PATTERN = /\{\{issue:([^{}\s]+)\}\}/gu
// --prepare --suffix が作るファイル名 `issue-<template>-<YYYYMMDD>-<HHMMSS>-<suffix>`
const PREPARED_FILENAME_PATTERN = /^issue-.+-\d{8}-\d{6}-(?<suffix>.+)$/u
// Python の `$` は末尾の改行の前にも当たる
const REPOSITORY_SEGMENT_PATTERN = /^[\w.-]+\n?$/u

interface CreatedIssue {
  readonly repository: string
  readonly number: number
}

// --- 共通 ---

function splitRepository(repository: string): readonly [string, string] | undefined {
  const parts = repository.split('/')
  const [owner, name] = parts
  return owner !== undefined && name !== undefined && parts.length === 2 ? [owner, name] : undefined
}

// owner/repo の形が不正なら error と終了コード 2。正しければ owner と name を返す
function validateRepositoryShape(output: Output, repository: string): readonly [string, string] {
  const parts = splitRepository(repository)
  if (parts?.every(part => REPOSITORY_SEGMENT_PATTERN.test(part)) === true) return parts
  output.error(`invalid repository format: ${repository}\nexpected: owner/repo`)
  return throwExit(USAGE_EXIT_CODE)
}

interface Posting {
  readonly owner: string
  readonly repository: string
  readonly title: string
  readonly body: string
  readonly labels: readonly string[] | undefined
  /**
  `created: ... from <source>` の source。ファイルの名前
  */
  readonly source: string | undefined
  /**
  真なら、作成の応答の node_id をボードへの追加に使う。偽なら、追加の側で取り直す
  */
  readonly useResponseNodeId: boolean
  readonly fields: readonly IssueField[]
  readonly parentReference: IssueReference | undefined
}

/**
Issue を作ってボードへ足し、欄の設定・親 Epic への接続・URL の出力まで行う。
ボードへの追加に失敗したら、そこで止める。作った Issue の番号を返す
*/
async function postIssue(output: Output, client: GitHubClient, config: ProjectConfig, posting: Readonly<Posting>): Promise<number> {
  const { owner, repository } = posting
  const issue = await createIssueOrExit(output, client, owner, repository, posting.title, posting.body, posting.labels, posting.source)
  const { number, url, nodeId } = summarizeCreatedIssue(issue)
  const target = `Issue ${issuePath(owner, repository, number)}`
  consumeFlag(FLAG_ISSUE_PENDING)

  const added = await addToBoardOrWarn(output, client, config, owner, repository, number, posting.useResponseNodeId ? nodeId : undefined, url)
  if (added === undefined) return number
  await setIssueFields(output, client, config, added.itemId, target, posting.fields)
  if (posting.parentReference !== undefined) await linkToParentEpic(output, client, target, posting.parentReference, added.issueNodeId, url)
  output.data(url)
  return number
}

function parentReferenceOf(raw: number | string | undefined, config: ProjectConfig, owner: string, repository: string): IssueReference | undefined {
  return raw === undefined ? undefined : resolveParentEpicReference(raw, config, owner, repository)
}

// --- --prepare ---

function prepareTemplate(output: Output, template: IssueType | 'task-implement', repository: string | undefined, suffix: string | undefined): void {
  if (template !== 'epic' && repository === undefined) {
    output.error('--repo owner/repo is required with --template task|bug|tracker|task-implement')
    throwExit(USAGE_EXIT_CODE)
  }
  if (repository !== undefined) validateRepositoryShape(output, repository)

  const source = templateFile('issue', template)
  if (!existsSync(source)) {
    output.error(`template not found: ${source}`)
    throwExit(1)
  }
  let content = readTextFile(source)
  // 置き換えの文字列に `$` があっても、そのまま入れる
  if (repository !== undefined) content = content.replace('repository: ""', () => `repository: ${repository}`)

  const nameSuffix = suffix === undefined || suffix === '' ? '' : `-${suffix}`
  try {
    withReservedOutputPath(outputDirectory(), timestamp => `issue-${template}-${timestamp}${nameSuffix}.md`, (reserved) => {
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

// --- ファイルからの一括投稿 ---

function fileKeys(file: string): ReadonlySet<string> {
  const stem = path.parse(path.basename(file)).name
  const keys = new Set([stem])
  const suffix = PREPARED_FILENAME_PATTERN.exec(stem)?.groups?.['suffix']
  if (suffix !== undefined) keys.add(suffix)
  return keys
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

// 1 件も投稿しないうちに、ファイルの重複・不在と、先行を指さないプレースホルダを止める
function validatePlaceholders(output: Output, files: readonly string[]): void {
  const seen = new Set<string>()
  const available = new Set<string>()
  for (const file of files) {
    const resolved = resolveRealPath(file)
    if (seen.has(resolved)) {
      output.error(`file specified more than once: ${normalizePath(file)}`)
      throwExit(1)
    }
    seen.add(resolved)
    if (!isFile(file)) {
      output.error(`file not found: ${normalizePath(file)}`)
      throwExit(1)
    }
    // フロントマターと冒頭のガイドコメントは投稿本文に出ないので、走査から外す
    const body = stripLeadingHtmlComment(stripFrontmatter(readTextFile(file)))
    for (const [, reference] of body.matchAll(PLACEHOLDER_PATTERN)) {
      if (reference === undefined || available.has(reference)) continue
      output.error(`{{issue:${reference}}} in ${path.basename(file)} does not point to an earlier file (forward reference or unknown key)\nput the file it depends on earlier in the arguments`)
      throwExit(1)
    }
    const keys = fileKeys(file)
    const collided = [...keys].filter(key => available.has(key)).toSorted(compareStrings)
    if (collided.length > 0) {
      output.error(`placeholder keys collide: ${collided.join(', ')} (${path.basename(file)})`)
      throwExit(1)
    }
    for (const key of keys) available.add(key)
  }
}

// ファイル入力の作成先。Epic は aggregation_repo の方針で決める
function fileTargetRepository(output: Output, frontmatter: IssueFrontmatter, config: ProjectConfig): readonly [string, string] {
  let resolved: string
  if (frontmatter.type === 'epic') {
    const explicit = frontmatter.repository === '' ? undefined : pythonStrip(frontmatter.repository)
    const target = resolveEpicTargetRepository(output, explicit, config)
    if (target.needsWarning) warnEpicRepositoryException(output, target.repository, config)
    resolved = target.repository
  }
  else {
    resolved = frontmatter.repository
  }
  const parts = resolved.includes('/') ? splitRepository(resolved) : undefined
  if (parts === undefined) {
    output.error(`invalid repository format in the frontmatter: ${pythonStringRepr(frontmatter.repository)}`)
    throwExit(1)
  }
  return parts
}

function expandPlaceholders(body: string, created: ReadonlyMap<string, CreatedIssue>, owner: string, repository: string): string {
  return body.replaceAll(PLACEHOLDER_PATTERN, (whole: string, key: string) => {
    const issue = created.get(key)
    if (issue === undefined) return whole
    return issue.repository === `${owner}/${repository}` ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
  })
}

function frontmatterFields(frontmatter: IssueFrontmatter): readonly IssueField[] {
  const fields: IssueField[] = [{ fieldName: 'workflow', optionName: frontmatter.status, label: `status ${frontmatter.status}` }]
  if (frontmatter.priority !== undefined) fields.push({ fieldName: 'priority', optionName: frontmatter.priority, label: `priority ${frontmatter.priority}` })
  if (frontmatter.size !== undefined) fields.push({ fieldName: 'size', optionName: frontmatter.size, label: `size ${frontmatter.size}` })
  return fields
}

async function createFromFile(output: Output, file: string, created: ReadonlyMap<string, CreatedIssue>): Promise<CreatedIssue> {
  const config = loadConfigOrExit(output)
  let parsed
  try {
    parsed = parseIssueFile(file)
  }
  catch (error: unknown) {
    if (!(error instanceof FrontmatterError)) throw error
    output.error(error.message)
    return throwExit(1)
  }
  const { frontmatter } = parsed

  const [owner, repository] = fileTargetRepository(output, frontmatter, config)
  const body = created.size > 0 ? expandPlaceholders(parsed.body, created, owner, repository) : parsed.body

  validateIssueTemplate(output, frontmatter.template ?? frontmatter.type, body)
  // 作成より前に、純粋な判定で止める
  validateStatusForType(output, frontmatter.type, frontmatter.status)

  const parentReference = parentReferenceOf(frontmatter.parent_epic, config, owner, repository)
  const title = buildIssueTitle(frontmatter.type, frontmatter.title, { parentEpic: parentReference?.number, order: frontmatter.order, parallel: frontmatter.parallel })
  const client = await clientForIssueCreate(output, config, owner, repository, frontmatter.repository, parentReference, frontmatter.order, frontmatter.parallel)

  const number = await postIssue(output, client, config, {
    owner,
    repository,
    title,
    body,
    labels: frontmatter.labels.length > 0 ? frontmatter.labels : undefined,
    source: path.basename(file),
    useResponseNodeId: false,
    fields: frontmatterFields(frontmatter),
    parentReference,
  })
  return { repository: `${owner}/${repository}`, number }
}

async function createFromFiles(output: Output, files: readonly string[]): Promise<void> {
  validatePlaceholders(output, files)
  const created = new Map<string, CreatedIssue>()
  for (const file of files) {
    const issue = await createFromFile(output, file, created)
    for (const key of fileKeys(file)) created.set(key, issue)
  }
  consumeFlag(FLAG_ISSUE_CREATE_SLASH_PENDING)
}

// --- -m の直接投稿 ---

interface DirectOptions {
  readonly message: string
  readonly title: string
  readonly repository: string
  readonly issueType: IssueType
  readonly status: string | undefined
  readonly priority: string | undefined
  readonly size: string | undefined
  readonly parentEpic: string | undefined
  readonly labels: readonly string[] | undefined
  readonly order: number | undefined
}

// config は epic の作成先を決めるときに読み済みなら渡す。無ければ、status の確認の後に読む
async function createDirect(output: Output, options: Readonly<DirectOptions>, loadedConfig: ProjectConfig | undefined): Promise<void> {
  const { issueType } = options
  // status は設定の取得や作成より前に確かめる
  let status: string
  if (options.status === undefined) {
    // eslint-disable-next-line security/detect-object-injection -- issueType は列挙型
    status = TYPE_DEFAULT_STATUS[issueType]
  }
  else {
    validateStatusForType(output, issueType, options.status)
    status = options.status
  }

  const config = loadedConfig ?? loadConfigOrExit(output)
  const [owner, repository] = validateRepositoryShape(output, options.repository)

  const parentReference = parentReferenceOf(normalizeParentEpicCli(options.parentEpic), config, owner, repository)
  const title = buildIssueTitle(issueType, options.title, { parentEpic: parentReference?.number, order: options.order })
  validateIssueTemplate(output, issueType, options.message)
  const client = await clientForIssueCreate(output, config, owner, repository, options.repository, parentReference, options.order)

  const fields: IssueField[] = [{ fieldName: 'workflow', optionName: status, label: `status ${status}` }]
  if (options.priority !== undefined && options.priority !== '') fields.push({ fieldName: 'priority', optionName: options.priority, label: `priority ${options.priority}` })
  if (options.size !== undefined && options.size !== '') fields.push({ fieldName: 'size', optionName: options.size, label: `size ${options.size}` })

  await postIssue(output, client, config, {
    owner,
    repository,
    title,
    body: options.message,
    labels: options.labels !== undefined && options.labels.length > 0 ? options.labels : undefined,
    source: undefined,
    useResponseNodeId: true,
    fields,
    parentReference,
  })
}

interface MessageTarget {
  readonly repository: string
  /**
  epic は作成先を決めるときに読んだ設定。epic 以外は undefined
  */
  readonly config: ProjectConfig | undefined
}

// -m の作成先。epic 以外は --repo が要る。epic は aggregation_repo の方針で決める
function messageModeTarget(output: Output, issueType: IssueType, repository: string | undefined): MessageTarget {
  if (issueType !== 'epic') {
    if (repository === undefined || repository === '') {
      output.error('-r (repository) is required with -m')
      throwExit(1)
    }
    return { repository, config: undefined }
  }
  const config = loadConfigOrExit(output)
  const target = resolveEpicTargetRepository(output, repository, config)
  if (target.needsWarning) warnEpicRepositoryException(output, target.repository, config)
  return { repository: target.repository, config }
}

const USAGE_TEXT = 'missing arguments\n'
  + 'direct posting: pecot issue create -t "TITLE" -r owner/repo -m "BODY"\n'
  + 'prepare a template: pecot issue create --prepare --template task --repo owner/repo\n'
  + 'from a file: pecot issue create <path>'

interface MessageInput {
  readonly title?: string | undefined
  readonly repo?: string | undefined
  readonly type: IssueType
  readonly status?: string | undefined
  readonly priority?: string | undefined
  readonly size?: string | undefined
  readonly parent_epic?: string | undefined
  readonly label?: readonly string[] | undefined
  readonly order?: number | undefined
}

// -m の直接投稿。入力の確認から作成まで
async function createFromMessage(output: Output, input: Readonly<MessageInput>, message: string): Promise<void> {
  if (input.title === undefined || input.title === '') {
    output.error('-t (title) is required with -m')
    throwExit(1)
  }
  const target = messageModeTarget(output, input.type, input.repo)
  await createDirect(output, {
    message,
    title: input.title,
    repository: target.repository,
    issueType: input.type,
    status: input.status,
    priority: input.priority,
    size: input.size,
    parentEpic: input.parent_epic,
    labels: input.label,
    order: input.order,
  }, target.config)
  consumeFlag(FLAG_ISSUE_CREATE_SLASH_PENDING)
}

const ISSUE_CREATE = defineCommand({
  path: ['issue', 'create'],
  description: 'Create Issues from Markdown files with frontmatter',
  input: z.object({
    files: FILES_SCHEMA,
    message: z.string().optional().describe('Issue body (direct posting mode)'),
    title: z.string().optional().describe('Issue title (direct posting mode, required with -m)'),
    repo: z.string().optional().describe('Repository (owner/repo form; required with -m / --prepare unless epic)'),
    type: ISSUE_TYPE_SCHEMA,
    status: z.string().optional().describe('Status (backlog/pending/ready/active/in_review/archived)'),
    priority: z.string().optional().describe('Priority (high/medium/low)'),
    size: z.string().optional().describe('Size (xs/s/m/l)'),
    parent_epic: z.string().optional().describe(PARENT_EPIC_DESCRIPTION),
    order: z.int().optional().describe('Order number of the subtask (used with parent_epic)'),
    label: LABEL_SCHEMA,
    prepare: z.boolean().default(false).describe('Copy a template to the work directory'),
    template: TEMPLATE_SCHEMA,
    suffix: z.string().optional().describe('Suffix of the output file name (only with --prepare)'),
  }),
  positional: ['files'],
  shortFlags: { message: '-m', title: '-t', repo: '-r', label: '-l', prepare: '-p', suffix: '-s' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      if (input.prepare) {
        prepareTemplate(output, input.template, input.repo, input.suffix)
      }
      else if (input.files !== undefined && input.files.length > 0) {
        await createFromFiles(output, input.files)
      }
      else if (input.message === undefined) {
        output.error(USAGE_TEXT)
        throwExit(1)
      }
      else {
        await createFromMessage(output, input, input.message)
      }
    })
  },
})

export const ISSUE_CREATE_COMMANDS: readonly CommandDefinition[] = [ISSUE_CREATE]
