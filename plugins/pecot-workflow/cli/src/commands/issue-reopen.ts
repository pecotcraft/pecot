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

// 1 回目の reopen（status を更新する前提として open にする）と、ボードの status の更新。設定できたら自動化を待つ
async function reopenAndSetStatus(output: Output, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  await client.reopenIssue(owner, repository, number)
  const item = await client.getIssueProjectItem(config.project.id, owner, repository, number)
  // アーカイブ済みのアイテムは Status を書く前に戻す。ボードの列に出ないため
  if (item?.isArchived === true) {
    await client.unarchiveProjectItem(config.project.id, item.id)
    output.done({ verb: 'update', target: `${target} unarchived on the board` })
  }
  const itemId = item?.id
  if (itemId === undefined) {
    output.warning(`${target} is not on the project board`)
  }
  else if (await setIssueField(client, config, itemId, 'workflow', status)) {
    output.done({ verb: 'set', target: `${target} status ${status}` })
    await delay(AUTOMATION_WAIT_MILLISECONDS)
  }
  else {
    output.warning(notConfiguredMessage(status))
  }
}

// 2 回目の reopen（自動化による close への対策）で open を確かめ、--comment があれば理由を投稿する
async function confirmReopened(output: Output, client: GitHubClient, issue: Readonly<ReopenTarget>, comment: string | undefined): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const result = await client.reopenIssue(owner, repository, number)
  const state = result['state']
  if (state !== 'open') {
    stopWith(output, `${target} did not become open (state: ${typeof state === 'string' ? state : 'None'})`)
  }
  output.done({ verb: 'reopen', target })

  if (comment === undefined || comment === '') return
  await client.addIssueComment(owner, repository, number, comment)
  output.done({ verb: 'create', target: `comment on ${issuePath(owner, repository, number)}` })
}

// 予行。ボードの項目を読み、書く操作を並べる
async function planReopen(output: Output, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string, comment: string | undefined): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)}`
  const item = await client.getIssueProjectItem(config.project.id, owner, repository, number)
  output.planned({ verb: 'reopen', target })
  if (item?.isArchived === true) output.planned({ verb: 'update', target: `${target} unarchived on the board` })
  if (item === undefined) output.warning(`${target} is not on the project board`)
  else if (isStatusConfigured(config, status)) output.planned({ verb: 'set', target: `${target} status ${status}` })
  else output.warning(notConfiguredMessage(status))
  if (comment !== undefined && comment !== '') output.planned({ verb: 'create', target: `comment on ${issuePath(owner, repository, number)}` })
}

async function reopenIssue(output: Output, client: GitHubClient, config: ProjectConfig, issue: Readonly<ReopenTarget>, status: string, comment: string | undefined): Promise<void> {
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
  positional: ['issue_ref'],
  shortFlags: { status: '-s', comment: '-c', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(input.dry_run, io)
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
        stopWith(output, `could not reopen ${target}: ${error.message}`)
      }
    })
  },
})

export const ISSUE_REOPEN_COMMANDS: readonly CommandDefinition[] = [ISSUE_REOPEN]
