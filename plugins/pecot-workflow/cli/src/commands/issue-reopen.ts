/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue reopen。cli/commands/issue.py の移植。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { isStatusConfigured, setIssueField } from './issue-board.js'
import { stopWith, requireActiveConfigPlain } from './command-stop.js'
import { kindOfFailure } from './failure.js'
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
import { createOutput } from './output.js'
import type { Output } from './output.js'

// Projects V2 の自動化が Issue をもう一度閉じることがあるため、status を設定した後に待つ
const AUTOMATION_WAIT_MILLISECONDS = 3000

interface ReopenTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

const ISSUE_REOPEN_OUTPUT = z.strictObject({
  issue: z.string().describe('Issue reopened (owner/repo/N)'),
  status: z.string().optional().describe('Workflow status set on the board (omitted when the Issue is not on the board or the status is not configured)'),
  unarchived: z.boolean().describe('Whether the item was unarchived on the board'),
  commented: z.boolean().describe('Whether the reason was posted as a comment'),
  dryRun: z.literal(true).optional().describe('true on dry_run (nothing was written)'),
})

type ReopenOutput = Output<z.input<typeof ISSUE_REOPEN_OUTPUT>>

function issueData({ owner, repository, number }: Readonly<ReopenTarget>): string {
  return `${owner}/${repository}/${String(number)}`
}

// アーカイブの解除、1 回目の reopen、ボードの status の更新。設定できたら自動化を待つ
async function reopenAndSetStatus(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const item = await client.getIssueProjectItem(config.project.id, owner, repository, number)
  output.result({ issue: issueData(issue), unarchived: false, commented: false })
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
  await client.reopenIssue(owner, repository, number)
  const itemId = item?.id
  if (itemId === undefined) {
    output.warning(`${target} is not on the project board`)
  }
  else if (await setIssueField(client, config, itemId, 'workflow', status)) {
    output.done({ verb: 'set', target: `${target} status ${status}` })
    output.result({ status })
    await delay(AUTOMATION_WAIT_MILLISECONDS)
  }
  else {
    output.warning(notConfiguredMessage(status))
  }
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
  await client.addIssueComment(owner, repository, number, comment)
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
  output.result({ issue: issueData(issue), ...willSetStatus && { status }, unarchived: item?.isArchived === true, commented: hasComment, dryRun: true })
  output.planned({ verb: 'reopen', target })
  if (item?.isArchived === true) output.planned({ verb: 'update', target: `${target} unarchived on the board` })
  if (item === undefined) output.warning(`${target} is not on the project board`)
  else if (willSetStatus) output.planned({ verb: 'set', target: `${target} status ${status}` })
  else output.warning(notConfiguredMessage(status))
  if (hasComment) output.planned({ verb: 'create', target: `comment on ${issuePath(owner, repository, number)}` })
}

async function reopenIssue(output: ReopenOutput, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string, comment: string | undefined): Promise<void> {
  await reopenAndSetStatus(output, client, config, issue, status)
  await confirmReopened(output, client, issue, comment)
}

const ISSUE_REOPEN = defineCommand({
  path: ['issue', 'reopen'],
  description: 'Reopen a closed Issue (also sets the status on the board)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().default('ready').describe('Status after reopening (backlog/pending/blocked/ready/active/in_review/archived)'),
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

      const config = requireActiveConfigPlain(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
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
