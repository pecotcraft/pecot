/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue reopen。cli/commands/issue.py の移植。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { defineCommand } from './command-definition.js'
import { hinted, inputNameHint } from './command-hint.js'
import type { CommandDefinition } from './command-definition.js'
import { isStatusConfigured, setIssueField } from './issue-board.js'
import { stopWith, requireConfigFor, PROJECT_INPUT } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { fieldWriteFailure } from './field-write-failure.js'
import {
  connectToProject,
  exitInvalidStatus,
  ISSUE_REF_DESCRIPTION,
  issuePath,
  notConfiguredMessage,
  parseIssueReferenceOrExit,
  runWithExit,
  VALID_STATUSES,
} from './issue-shared.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Output } from './output.js'

// Projects V2 の自動化が Issue をもう一度閉じることがあるため、status を設定した後に待つ
const AUTOMATION_WAIT_MILLISECONDS = 3000

// 組み込みの Auto-close issue が、初期の設定で Issue を閉じる Status の値
const DONE_STATUS = 'Done'

interface ReopenTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

const ISSUE_REOPEN_OUTPUT = z.strictObject({
  issue: z.string().describe('Issue reopened (owner/repo/N)'),
  status: z.string().optional().describe('Workflow status set on the board (omitted when the Issue is not on the board or the status is not configured)'),
  unarchived: z.boolean().describe('Whether the item was unarchived on the board'),
  doneCleared: z.boolean().describe('Whether the built-in Status Done was cleared on the board'),
  commented: z.boolean().describe('Whether the reason was posted as a comment'),
  dryRun: DRY_RUN_FIELD,
})

type ReopenOutput = Output<z.input<typeof ISSUE_REOPEN_OUTPUT>>

// アーカイブの解除、1 回目の reopen、ボードの status の更新。設定できたら自動化を待つ
async function reopenAndSetStatus(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const item = await client.getIssueProjectItem(config.project.id, owner, repository, number)
  output.result({ issue: issuePath(issue.owner, issue.repository, issue.number), unarchived: false, doneCleared: false, commented: false })
  // アーカイブ済みの項目はボードの列に出ないので戻す。失敗したら Issue を開かずに止める
  if (item?.isArchived === true) {
    try {
      await client.unarchiveProjectItem(config.project.id, item.id)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      stopWith(output, `could not unarchive ${target} on the board: ${error.message}`, kindOfFailure(error))
    }
    output.done({ verb: 'update', target: `${target} unarchived on the board` })
    output.result({ unarchived: true })
  }
  if (item?.status?.name === DONE_STATUS) await clearDoneStatus(output, client, config, { target, itemId: item.id, fieldId: item.status.fieldId })
  await client.reopenIssue(owner, repository, number)
  const itemId = item?.id
  if (itemId === undefined) {
    output.warning(`${target} is not on the project board`)
  }
  else {
    await setReopenedStatus(output, client, config, { target, itemId }, status)
  }
}

// Status に Done が残ると、Auto-close issue で閉じ直されうる（#536）。消せなければ warning にとどめて続ける
async function clearDoneStatus(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, item: Readonly<{ target: string, itemId: string, fieldId: string }>): Promise<void> {
  const { target, itemId, fieldId } = item
  try {
    await client.clearProjectItemField(config.project.id, itemId, fieldId)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`could not remove ${target} Status ${DONE_STATUS} on the board: ${error.message}. The board automation may close the Issue again; clear Status on the board`)
    return
  }
  output.done({ verb: 'remove', target: `${target} Status ${DONE_STATUS} on the board` })
  output.result({ doneCleared: true })
}

// 列を書く。書けなければ warning にとどめ、2 回目の reopen とコメントの投稿へ進む。設定できたときだけ自動化を待つ
async function setReopenedStatus(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, item: Readonly<{ target: string, itemId: string }>, status: string): Promise<void> {
  const { target, itemId } = item
  let isSet: boolean
  try {
    isSet = await setIssueField(client, config, itemId, 'workflow', status)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(fieldWriteFailure(`could not set ${target} status ${status}: ${error.message}`, error, config))
    return
  }
  if (!isSet) {
    output.warning(notConfiguredMessage(status))
    return
  }
  output.done({ verb: 'set', target: `${target} status ${status}` })
  output.result({ status })
  await delay(AUTOMATION_WAIT_MILLISECONDS)
}

// 2 回目の reopen（自動化による close への対策）で open を確かめ、--comment があれば理由を投稿する
async function confirmReopened(output: ReopenOutput, client: GitHubClient, issue: Readonly<ReopenTarget>, comment: string | undefined): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const result = await client.reopenIssue(owner, repository, number)
  const state = result['state']
  if (state !== 'open') {
    stopWith(output, `${target} did not become open (state: ${typeof state === 'string' ? state : 'None'})`, 'other')
  }
  output.done({ verb: 'reopen', target })

  if (comment === undefined || comment === '') return
  // Issue は開いているので、投稿の失敗は reopen の失敗と分けて伝える
  try {
    await client.addIssueComment(owner, repository, number, comment)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    stopWith(output, `could not comment on ${target}: ${error.message}`, kindOfFailure(error))
  }
  output.done({ verb: 'create', target: `comment on ${issuePath(owner, repository, number)}` })
  output.result({ commented: true })
}

// 予行。ボードの項目を読み、書く操作を並べる
async function planReopen(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string, comment: string | undefined): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const item = await client.getIssueProjectItem(config.project.id, owner, repository, number)
  const hasComment = comment !== undefined && comment !== ''
  const willSetStatus = item !== undefined && isStatusConfigured(config, status)
  const willClearDone = item?.status?.name === DONE_STATUS
  output.result({ issue: issuePath(issue.owner, issue.repository, issue.number), ...willSetStatus && { status }, unarchived: item?.isArchived === true, doneCleared: willClearDone, commented: hasComment })
  output.planned({ verb: 'reopen', target })
  if (item?.isArchived === true) output.planned({ verb: 'update', target: `${target} unarchived on the board` })
  if (willClearDone) output.planned({ verb: 'remove', target: `${target} Status ${DONE_STATUS} on the board` })
  if (item === undefined) output.warning(`${target} is not on the project board`)
  else if (willSetStatus) output.planned({ verb: 'set', target: `${target} status ${status}` })
  else output.warning(notConfiguredMessage(status))
  if (hasComment) output.planned({ verb: 'create', target: `comment on ${issuePath(owner, repository, number)}` })
}

async function reopenIssue(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string, comment: string | undefined): Promise<void> {
  await reopenAndSetStatus(output, client, config, issue, status)
  await confirmReopened(output, client, issue, comment)
}

const REOPEN_PATH = ['issue', 'reopen']

const ISSUE_REOPEN = defineCommand({
  path: REOPEN_PATH,
  description: 'Reopen a closed Issue (also sets the status on the board)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().default('ready').describe('Status after reopening (backlog/pending/blocked/ready/active/in_review/archived)'),
    project: PROJECT_INPUT,
    comment: z.string().optional().describe('Reason for reopening (posted as a comment)'),
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  output: ISSUE_REOPEN_OUTPUT,
  positional: ['issue_ref'],
  shortFlags: { status: '-s', comment: '-c', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput<z.input<typeof ISSUE_REOPEN_OUTPUT>>(input.dry_run, io)
    return await runWithExit(async () => {
      const { status, comment } = input
      if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)
      // 空白だけの理由は GitHub が 422 で拒むので、開き直す前に止める
      if (comment !== undefined && comment !== '' && comment.trim() === '') {
        stopWith(output, hinted`${inputNameHint(REOPEN_PATH, 'comment')} is blank: give a reason or omit it`, 'invalid-input')
      }

      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const { config } = requireConfigFor(output, { owner, repository }, input.project, REOPEN_PATH)
      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        const run = input.dry_run ? planReopen : reopenIssue
        await run(output, client, config, { owner, repository, number }, status, comment)
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not reopen ${target}: ${error.message}`, kindOfFailure(error))
      }
    })
  },
})

export const ISSUE_REOPEN_COMMANDS: readonly CommandDefinition[] = [ISSUE_REOPEN]
