/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue quick。cli/commands/issue.py の issue_quick_command の移植。テンプレートの検証はしない。
import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { findRepository } from '../domain/config.js'
import type { JsonObject } from '../domain/json.js'
import { pythonRightStrip, pythonStrip, truncateCodePoints } from '../domain/python-format.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { FLAG_ISSUE_CREATE_SLASH_PENDING, FLAG_ISSUE_PENDING, FLAG_PECOT_QUICK_MODE } from '../domain/state.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { requireNumber, requireString } from '../infra/github/payload.js'
import { formatTimestamp } from '../infra/paths.js'
import { consumeFlag, touchFlag } from '../infra/state-store.js'
import { defineCommand } from './command.js'
import type { CommandIo } from './command.js'
import {
  addToBoardOrWarn,
  BACKLOG_TYPES,
  buildIssueTitle,
  clientForIssueCreate,
  createIssueOrExit,
  linkToParentEpic,
  loadConfigOrExit,
  normalizeParentEpicCli,
  resolveParentEpicReference,
  runWithExit,
  setIssueFields,
  throwExit,
} from './issue-shared.js'
import type { IssueField, IssueType } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { recordWorkTarget } from './work-target.js'

const TYPE_SCHEMA = z.enum(['task', 'bug', 'epic', 'tracker']).default('task').describe('Issue type (task/bug/epic/tracker)')

// テンプレートの検証を飛ばす quick でも、起票規約への参照を本文の末尾に残す
const BODY_FOOTER = '<!-- pecot issue quick で起票（テンプレ検証スキップ）。起票ルール: skills/w-help/references/issue-flow-rules.md#起票時の既定-status -->'

const TITLE_LENGTH = 50

// 空のメッセージと owner/repo の形の誤りを止める
function parseQuickArguments(output: Output, message: string, repository: string): readonly [string, string] {
  if (pythonStrip(message) === '') {
    output.error('the message is empty')
    throwExit(1)
  }
  const [owner, name, ...rest] = repository.split('/')
  if (owner === undefined || name === undefined || rest.length > 0) {
    output.error(`invalid repository format: ${repository}\nexpected: owner/repo`)
    throwExit(1)
  }
  return [owner, name]
}

// status は Backlog に置く型なら backlog、それ以外は active。priority は medium、size は s（Backlog に置く型は付けない）
function quickFields(issueType: IssueType): readonly IssueField[] {
  const isBacklog = BACKLOG_TYPES.has(issueType)
  const status = isBacklog ? 'backlog' : 'active'
  const fields: IssueField[] = [
    { fieldName: 'workflow', optionName: status, label: `status ${status}` },
    { fieldName: 'priority', optionName: 'medium', label: 'priority medium' },
  ]
  if (!isBacklog) fields.push({ fieldName: 'size', optionName: 's', label: 'size s' })
  return fields
}

async function createBranch(output: Output, config: ProjectConfig, client: GitHubClient, owner: string, repository: string, issueNumber: number, issueNodeId: string, title: string): Promise<void> {
  const base = findRepository(config, owner, repository)?.develop_branch
  if (base === undefined || base === '') {
    output.error(`develop_branch is not set for repository ${owner}/${repository}\nset it with: pecot project set-repo ${owner}/${repository} --develop-branch develop\n(or --develop-branch develop-aist / --develop-branch main)`)
    throwExit(1)
  }
  const name = `feat/${formatTimestamp(Date.now())}/${String(issueNumber)}`
  const sha = await client.getBranchSha(owner, repository, base)
  const created = await client.createLinkedBranch(issueNodeId, sha, name)
  output.done({ verb: 'create', target: `branch ${created} in ${owner}/${repository}` })
  recordWorkTarget(output, owner, repository, issueNumber, title, { failWithExit: false })
}

// ブランチの作成。API の失敗は warning にして続ける（--no-branch なら作業対象を記録するだけ）
async function branchOrRecord(output: Output, config: ProjectConfig, client: GitHubClient, target: { readonly owner: string, readonly repository: string, readonly number: number, readonly nodeId: string, readonly title: string }, isNoBranch: boolean): Promise<void> {
  if (isNoBranch) {
    recordWorkTarget(output, target.owner, target.repository, target.number, target.title, { failWithExit: false })
    return
  }
  try {
    await createBranch(output, config, client, target.owner, target.repository, target.number, target.nodeId, target.title)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`could not create the branch: ${error.message}\ncreate the branch manually`)
  }
}

interface QuickOptions {
  readonly issueType: IssueType
  readonly parentReference: IssueReference | undefined
  readonly noBranch: boolean
}

// 作った Issue の後始末。ボードへの追加に失敗したら、そこで止める
async function finishIssue(output: Output, config: ProjectConfig, client: GitHubClient, owner: string, repository: string, issue: JsonObject, options: Readonly<QuickOptions>): Promise<void> {
  const number = requireNumber(issue['number'], 'number')
  const url = requireString(issue['html_url'], 'html_url')
  const target = `Issue ${owner}/${repository}/${String(number)}`
  const nodeId = typeof issue['node_id'] === 'string' ? issue['node_id'] : undefined

  const added = await addToBoardOrWarn(output, client, config, owner, repository, number, nodeId, url)
  if (added === undefined) return
  await setIssueFields(output, client, config, added.itemId, target, quickFields(options.issueType))

  if (options.parentReference !== undefined) {
    if (options.issueType === 'epic') output.warning('giving a parent Epic to an Epic is not recommended')
    await linkToParentEpic(output, client, target, options.parentReference, added.issueNodeId, url)
  }
  const title = typeof issue['title'] === 'string' ? issue['title'] : ''
  await branchOrRecord(output, config, client, { owner, repository, number, nodeId: added.issueNodeId, title }, options.noBranch)

  if (!BACKLOG_TYPES.has(options.issueType)) touchFlag(FLAG_PECOT_QUICK_MODE)
  output.data(url)
}

export const ISSUE_QUICK = defineCommand({
  path: ['issue', 'quick'],
  description: 'Create an Issue at once from a free-format message',
  input: z.object({
    message: z.string().describe('Issue message (free format)'),
    repo: z.string().describe('Repository (owner/repo form)'),
    parent_epic: z.string().optional().describe('Parent Epic reference: an integer (relative to aggregation_repo) or the primary form \'owner/repo/N\''),
    order: z.int().optional().describe('Order number of the subtask (used with parent_epic)'),
    no_branch: z.boolean().default(false).describe('Skip creating a branch'),
    type: TYPE_SCHEMA,
  }),
  positional: [],
  shortFlags: { message: '-m', repo: '-r' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const [owner, repository] = parseQuickArguments(output, input.message, input.repo)
      const config = loadConfigOrExit(output)

      const rawParent = normalizeParentEpicCli(input.parent_epic)
      const parentReference = rawParent === undefined ? undefined : resolveParentEpicReference(rawParent, config, owner, repository)

      // タイトルは先頭 50 文字の空白を 1 つにまとめたもの
      const cleaned = pythonStrip(truncateCodePoints(input.message, TITLE_LENGTH).replaceAll(/\s+/gu, ' '))
      const title = buildIssueTitle(input.type, cleaned, { parentEpic: parentReference?.number, order: input.order })
      const client = await clientForIssueCreate(output, config, owner, repository, input.repo, parentReference, input.order)

      const body = `${pythonRightStrip(input.message)}\n\n${BODY_FOOTER}`
      const issue = await createIssueOrExit(output, client, owner, repository, title, body, undefined)
      consumeFlag(FLAG_ISSUE_PENDING)
      consumeFlag(FLAG_ISSUE_CREATE_SLASH_PENDING)

      await finishIssue(output, config, client, owner, repository, issue, { issueType: input.type, parentReference, noBranch: input.no_branch })
    })
  },
})
