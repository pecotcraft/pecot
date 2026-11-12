/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// add-to-project・update-issue-status・issue reopen。cli/commands/issue.py の移植。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { getFieldId, getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { addIssueToBoard, setIssueField } from './issue-board.js'
import { stopWith, requireActiveConfig, NO_ACTIVE_PROJECT_SHORT } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import {
  ensureRepositoryInProject,
  exitInvalidStatus,
  ISSUE_REF_DESCRIPTION,
  issuePath,
  parseIssueReferenceOrExit,
  runWithExit,
  VALID_STATUSES,
} from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'

// Projects V2 の自動化が Issue をもう一度閉じることがあるため、status を設定した後に待つ
const AUTOMATION_WAIT_MILLISECONDS = 3000

// クライアントを作り、リポジトリがプロジェクトにあることを確かめる。無ければ error と終了コード 1
async function connectToProject(output: Output, config: ProjectConfig, owner: string, repository: string): Promise<GitHubClient> {
  const client = createGitHubClient(output, config.host)
  await ensureRepositoryInProject(output, config, client, owner, repository, `repository ${owner}/${repository} is not in the project`)
  return client
}

function isStatusConfigured(config: ProjectConfig, status: string): boolean {
  const fieldId = getFieldId(config, 'workflow')
  const optionId = getOptionId(config, 'workflow', status)
  return fieldId !== undefined && fieldId !== '' && optionId !== undefined && optionId !== ''
}

const ADD_TO_PROJECT = defineCommand({
  path: ['add-to-project'],
  description: 'Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().default('ready').describe('Initial status (backlog/pending/ready/active/in_review/archived)'),
  }),
  positional: ['issue_ref'],
  shortFlags: { status: '-s' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const { status } = input
      if (status !== '' && !VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const config = requireActiveConfig(output, NO_ACTIVE_PROJECT_SHORT)
      if (status !== '' && !isStatusConfigured(config, status)) {
        stopWith(output, `status '${status}' is not configured in the project`)
      }

      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        const { itemId } = await addIssueToBoard(client, config, owner, repository, number, undefined)
        output.done({ verb: 'add', target: `${target} to project` })
        if (status !== '') {
          await setIssueField(client, config, itemId, 'workflow', status)
          output.done({ verb: 'set', target: `${target} status ${status}` })
        }
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not add ${target} to project: ${error.message}`)
      }
    })
  },
})

const UPDATE_ISSUE_STATUS = defineCommand({
  path: ['update-issue-status'],
  description: 'Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().describe('Status (backlog/pending/ready/active/in_review/archived)'),
  }),
  positional: ['issue_ref', 'status'],
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const { status } = input
      if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const config = requireActiveConfig(output, NO_ACTIVE_PROJECT_SHORT)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        const itemId = await client.getItemIdByIssue(config.project.id, owner, repository, number)
        if (itemId === undefined) {
          stopWith(output, `${target} is not on the project board\nhint: add it to the board first with add-to-project`)
        }
        if (!await setIssueField(client, config, itemId, 'workflow', status)) {
          stopWith(output, `status '${status}' is not configured in the project`)
        }
        output.done({ verb: 'set', target: `${target} status ${status}` })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not set ${target} status ${status}: ${error.message}`)
      }
    })
  },
})

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
    output.warning(`status '${status}' is not configured in the project`)
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
    status: z.string().default('ready').describe('Status after reopening (backlog/pending/ready/active/in_review/archived)'),
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

      const config = requireActiveConfig(output, NO_ACTIVE_PROJECT_SHORT)
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

export const ISSUE_PROJECT_COMMANDS: readonly CommandDefinition[] = [ADD_TO_PROJECT, UPDATE_ISSUE_STATUS, ISSUE_REOPEN]
