// board add。cli/commands/issue.py の add_to_project の移植。
import { z } from 'zod'

import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { addIssueToBoard, isStatusConfigured, setIssueField } from '@pecot/workflow-core/commands-shared/issue-board.js'
import { stopWith, requireConfigFor, PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { fieldWriteFailure } from '@pecot/workflow-core/commands-shared/field-write-failure.js'
import {
  connectToProject,
  exitInvalidStatus,
  ISSUE_REF_DESCRIPTION,
  issuePath,
  notConfiguredMessage,
  parseIssueReferenceOrExit,
  runWithExit,
  VALID_STATUSES,
} from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'

const BOARD_ADD_OUTPUT = z.strictObject({
  issue: z.string().describe('Issue (owner/repo/N)'),
  added: z.boolean().describe('true when the Issue is on the board'),
  status: z.string().optional().describe('Status set on the board (omitted when status is empty)'),
})

const BOARD_ADD = defineTool({
  name: 'board_add',
  title: 'Add Issue to board',
  description: 'Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    status: z.string().default('ready').describe('Initial status (backlog/pending/blocked/ready/active/in_review/archived)'),
    project: PROJECT_INPUT,
  }),
  output: BOARD_ADD_OUTPUT,
  run: async (input, io) => {
    const output = createOutput<z.input<typeof BOARD_ADD_OUTPUT>>(false, io)
    return await runWithExit(async () => {
      const { status } = input
      if (status !== '' && !VALID_STATUSES.has(status)) exitInvalidStatus(output, status)

      const { owner, repository, number } = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const { config } = requireConfigFor(output, { owner, repository }, input.project, ['board', 'add'])
      if (status !== '' && !isStatusConfigured(config, status)) {
        stopWith(output, notConfiguredMessage(status), 'status-not-configured')
      }

      const target = `Issue ${issuePath(owner, repository, number)}`
      try {
        const client = await connectToProject(output, config, owner, repository)
        const { itemId } = await addIssueToBoard(client, config, owner, repository, number, undefined)
        output.done({ verb: 'add', target: `${target} to project` })
        output.result({ issue: issuePath(owner, repository, number), added: true })
        if (status === '') return
        try {
          await setIssueField(client, config, itemId, 'workflow', status)
        }
        catch (error: unknown) {
          if (!(error instanceof GitHubAPIError)) throw error
          // 追加は済んでいるので、追加の失敗とは別の文で止める
          stopWith(output, fieldWriteFailure(`could not set ${target} status ${status}: ${error.message}`, error, config), kindOfFailure(error))
        }
        output.done({ verb: 'set', target: `${target} status ${status}` })
        output.result({ status })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        stopWith(output, `could not add ${target} to project: ${error.message}`, kindOfFailure(error))
      }
    })
  },
})

export const BOARD_ADD_TOOLS: readonly ToolDefinition[] = [BOARD_ADD]
