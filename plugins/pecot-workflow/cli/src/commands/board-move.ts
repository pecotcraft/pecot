// board move。cli/commands/issue.py の update_issue_status の移植。
import { z } from 'zod'

import { GitHubAPIError } from '../infra/github/errors.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { isStatusConfigured, setIssueField } from './issue-board.js'
import { commandHint, hinted } from './command-hint.js'
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

const BOARD_MOVE = defineCommand({
  path: ['board', 'move'],
  description: 'Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().describe('Status (backlog/pending/blocked/ready/active/in_review/archived)'),
    dry_run: z.boolean().default(false).describe('Show what would change without writing anything'),
  }),
  positional: ['issue_ref', 'status'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(input.dry_run, io)
    return await runWithExit(async () => {
      const { status } = input
      if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const config = requireActiveConfigPlain(output)
      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
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
          return
        }
        if (!await setIssueField(client, config, itemId, 'workflow', status)) {
          stopWith(output, notConfiguredMessage(status), 'status-not-configured')
        }
        output.done({ verb: 'set', target: `${target} status ${status}` })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not set ${target} status ${status}: ${error.message}`, kindOfFailure(error))
      }
    })
  },
})

export const BOARD_MOVE_COMMANDS: readonly CommandDefinition[] = [BOARD_MOVE]
