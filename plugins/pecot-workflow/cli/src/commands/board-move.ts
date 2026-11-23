// board move。cli/commands/issue.py の update_issue_status の移植。
import { z } from 'zod'

import { GitHubAPIError } from '../infra/github/errors.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { isStatusConfigured, setIssueField } from './issue-board.js'
import { commandHint, hinted } from './command-hint.js'
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
import { createOutput } from './output.js'

const BOARD_MOVE_OUTPUT = z.strictObject({
  issue: z.string().describe('Issue (owner/repo/N)'),
  status: z.string().describe('Status set on the board'),
})

const BOARD_MOVE = defineCommand({
  path: ['board', 'move'],
  title: 'Move Issue on board',
  description: 'Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().describe('Status (backlog/pending/blocked/ready/active/in_review/archived)'),
    project: PROJECT_INPUT,
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  output: BOARD_MOVE_OUTPUT,
  positional: ['issue_ref', 'status'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput<z.input<typeof BOARD_MOVE_OUTPUT>>(input.dry_run, io)
    return await runWithExit(async () => {
      const { status } = input
      if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const { config } = requireConfigFor(output, { owner, repository }, input.project, ['board', 'move'])
      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        const itemId = await client.getItemIdByIssue(config.project.id, owner, repository, number)
        if (itemId === undefined) {
          stopWith(output, hinted`${target} is not on the project board\nhint: add it to the board first with ${commandHint(['board', 'add'], { issue_ref: `${owner}/${repository}/${String(number)}` })}`, 'not-on-board')
        }
        if (input.dry_run) {
          if (!isStatusConfigured(config, status)) stopWith(output, notConfiguredMessage(status), 'status-not-configured')
          output.planned({ verb: 'set', target: `${target} status ${status}` })
          output.result({ issue: issuePath(owner, repository, number), status })
          return
        }
        let isSet: boolean
        try {
          isSet = await setIssueField(client, config, itemId, 'workflow', status)
        }
        catch (error: unknown) {
          if (!(error instanceof GitHubAPIError)) throw error
          stopWith(output, fieldWriteFailure(`could not set ${target} status ${status}: ${error.message}`, error, config), kindOfFailure(error))
        }
        if (!isSet) stopWith(output, notConfiguredMessage(status), 'status-not-configured')
        output.done({ verb: 'set', target: `${target} status ${status}` })
        output.result({ issue: issuePath(owner, repository, number), status })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not set ${target} status ${status}: ${error.message}`, kindOfFailure(error))
      }
    })
  },
})

export const BOARD_MOVE_COMMANDS: readonly CommandDefinition[] = [BOARD_MOVE]
