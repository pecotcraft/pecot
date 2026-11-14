// board add。cli/commands/issue.py の add_to_project の移植。
import { z } from 'zod'

import { getFieldId, getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { addIssueToBoard, setIssueField } from './issue-board.js'
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

function isStatusConfigured(config: ProjectConfig, status: string): boolean {
  const fieldId = getFieldId(config, 'workflow')
  const optionId = getOptionId(config, 'workflow', status)
  return fieldId !== undefined && fieldId !== '' && optionId !== undefined && optionId !== ''
}

const BOARD_ADD = defineCommand({
  path: ['board', 'add'],
  description: 'Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().default('ready').describe('Initial status (backlog/pending/blocked/ready/active/in_review/archived)'),
  }),
  positional: ['issue_ref'],
  shortFlags: { status: '-s' },
  interactive: false,
  run: async (input, io) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const { status } = input
      if (status !== '' && !VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const config = requireActiveConfigPlain(output)
      if (status !== '' && !isStatusConfigured(config, status)) {
        stopWith(output, notConfiguredMessage(status))
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

export const BOARD_ADD_COMMANDS: readonly CommandDefinition[] = [BOARD_ADD]
