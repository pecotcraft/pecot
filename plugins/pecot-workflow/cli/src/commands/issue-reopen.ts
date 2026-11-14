/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue reopen。cli/commands/issue.py の移植。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { setIssueField } from './issue-board.js'
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
  const itemId = await client.getItemIdByIssue(config.project.id, owner, repository, number)
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
  }),
  positional: ['issue_ref'],
  shortFlags: { status: '-s', comment: '-c' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const { status, comment } = input
      if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const config = requireActiveConfigPlain(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        await reopenIssue(output, client, config, { owner, repository, number }, status, comment)
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not reopen ${target}: ${error.message}`)
      }
    })
  },
})

export const ISSUE_REOPEN_COMMANDS: readonly CommandDefinition[] = [ISSUE_REOPEN]
