// add-to-project・update-issue-status・issue reopen。cli/commands/issue.py の移植。
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { getFieldId, getOptionId, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { defineCommand } from './command.js'
import type { CommandDefinition } from './command.js'
import { addIssueToBoard, setIssueField } from './issue-board.js'
import {
  createClient,
  exitInvalidStatus,
  loadConfigOrExit,
  parseIssueReferenceOrExit,
  runWithExit,
  throwExit,
  VALID_STATUSES,
} from './issue-shared.js'
import { createOutput } from './output.js'

const ISSUE_REF_DESCRIPTION = 'Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)'

// Projects V2 の自動化が Issue をもう一度閉じることがあるため、status を設定した後に待つ
const AUTOMATION_WAIT_MILLISECONDS = 3000

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

      const config = loadConfigOrExit(output)
      if (status !== '' && !isStatusConfigured(config, status)) {
        output.error(`status '${status}' is not configured in the project`)
        throwExit(1)
      }

      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${owner}/${repository}/${String(number)}`
      try {
        const client = createClient(config, output)
        if (!await isRepositoryInProject(config, owner, repository, client)) {
          output.error(`repository ${owner}/${repository} is not in the project`)
          throwExit(1)
        }
        const { itemId } = await addIssueToBoard(client, config, owner, repository, number, undefined)
        output.done({ verb: 'add', target: `${target} to project` })
        if (status !== '') {
          await setIssueField(client, config, itemId, 'workflow', status)
          output.done({ verb: 'set', target: `${target} status ${status}` })
        }
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        output.error(`could not add ${target} to project: ${error.message}`)
        throwExit(1)
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

      const config = loadConfigOrExit(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${owner}/${repository}/${String(number)}`
      try {
        const client = createClient(config, output)
        if (!await isRepositoryInProject(config, owner, repository, client)) {
          output.error(`repository ${owner}/${repository} is not in the project`)
          throwExit(1)
        }
        const itemId = await client.getItemIdByIssue(config.project.id, owner, repository, number)
        if (itemId === undefined) {
          output.error(`${target} is not on the project board\nhint: add it to the board first with add-to-project`)
          throwExit(1)
        }
        if (!await setIssueField(client, config, itemId, 'workflow', status)) {
          output.error(`status '${status}' is not configured in the project`)
          throwExit(1)
        }
        output.done({ verb: 'set', target: `${target} status ${status}` })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        output.error(`could not set ${target} status ${status}: ${error.message}`)
        throwExit(1)
      }
    })
  },
})

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

      const config = loadConfigOrExit(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const target = `Issue ${owner}/${repository}/${String(number)}`
      try {
        const client = createClient(config, output)
        if (!await isRepositoryInProject(config, owner, repository, client)) {
          output.error(`repository ${owner}/${repository} is not in the project`)
          throwExit(1)
        }

        // 1 回目は、status を更新する前提として open にする
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

        // 2 回目は、自動化による close への対策
        const result = await client.reopenIssue(owner, repository, number)
        const state = result['state']
        if (state !== 'open') {
          output.error(`${target} did not become open (state: ${typeof state === 'string' ? state : 'None'})`)
          throwExit(1)
        }
        output.done({ verb: 'reopen', target })

        if (comment !== undefined && comment !== '') {
          await client.addIssueComment(owner, repository, number, comment)
          output.done({ verb: 'create', target: `comment on ${owner}/${repository}/${String(number)}` })
        }
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        output.error(`could not reopen ${target}: ${error.message}`)
        throwExit(1)
      }
    })
  },
})

export const ISSUE_PROJECT_COMMANDS: readonly CommandDefinition[] = [ADD_TO_PROJECT, UPDATE_ISSUE_STATUS, ISSUE_REOPEN]
