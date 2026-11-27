// issue edit。Issue 1 件の機能の値を、名前で書き、変え、外す。
import { z } from 'zod'

import { readAttributeValues } from '@pecot/workflow-core/infra/github/attributes.js'
import { describeApiError } from '@pecot/workflow-core/domain/api-error-detail.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import {
  ATTRIBUTE_CHANGE_JSON,
  ATTRIBUTE_ERROR_JSON,
  ATTRIBUTE_FAILURE_JSON,
  ATTRIBUTES_INPUT,
  attributeInputs,
  builtinBody,
  builtinOutcome,
  changeLine,
  checkAttributes,
  reportAttributeErrors,
  warnFailures,
  writeIssueFields,
  writeProjectFields,
} from './attribute-writes.js'
import type { AttributeOutcome } from './attribute-writes.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createAuthenticatedGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { ISSUE_REF_DESCRIPTION, issuePath, parseIssueReferenceOrExit, runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'

const EDIT_PATH = ['issue', 'edit']

const ISSUE_EDIT_OUTPUT = z.strictObject({
  changed: z.array(ATTRIBUTE_CHANGE_JSON).describe('Attributes whose value was changed, with the value before and after'),
  errors: z.array(ATTRIBUTE_ERROR_JSON).describe('Why the values were not accepted; nothing was written when this is not empty'),
  failed: z.array(ATTRIBUTE_FAILURE_JSON).describe('Attributes that passed the check but could not be written, with the reason'),
})

type IssueEditJson = z.input<typeof ISSUE_EDIT_OUTPUT>

const EMPTY: IssueEditJson = { changed: [], errors: [], failed: [] }

const ISSUE_EDIT = defineTool({
  name: 'issue_edit',
  title: 'Edit Issue attributes',
  description: 'Write, change or remove the values of the attributes of an Issue by name (the attributes that issue_attributes lists)',
  input: z.object({
    issue_ref: z.string().describe(ISSUE_REF_DESCRIPTION),
    attributes: ATTRIBUTES_INPUT.describe('Attributes to write: name, value (null removes it) and, only when the same name is in several sources, source'),
    project: PROJECT_INPUT,
  }),
  output: ISSUE_EDIT_OUTPUT,
  run: async (input, io) => {
    const output = createOutput<IssueEditJson>(false, io)
    return await runWithExit(async () => {
      const issue = parseIssueReferenceOrExit(output, input.repo, input.issue_ref)
      const { owner, repository, number } = issue
      const { config } = requireConfigFor(output, { owner, repository }, input.project, EDIT_PATH)
      const client = await createAuthenticatedGitHubClient(output, config.host)
      const target = `Issue ${issuePath(owner, repository, number)}`
      const inputs = attributeInputs(input.attributes)
      output.result(EMPTY)
      if (inputs.length === 0) return

      let outcome: AttributeOutcome
      try {
        const current = await readAttributeValues(client, { owner, repository, number, projectId: config.project.id })
        for (const warning of current.warnings) output.warning(warning)
        const validation = await checkAttributes(output, client, config, { owner, repository }, inputs, { readings: current.readings, itemId: current.itemId })
        if (!validation.ok) {
          output.result({ ...EMPTY, errors: [...reportAttributeErrors(output, validation.errors)] })
          return stopWith(output, `did not write the attributes of ${target}`, 'invalid-input')
        }
        const { writes } = validation
        const builtins = builtinBody(writes)
        const parts: AttributeOutcome[] = []
        if (builtins.length > 0) {
          try {
            parts.push(builtinOutcome(writes, await client.updateIssueAttributes(owner, repository, number, builtins)))
          }
          catch (error: unknown) {
            if (!(error instanceof GitHubAPIError)) throw error
            parts.push({ changed: [], failed: writes.filter(write => write.source === 'issue').map(write => ({ name: write.name, source: write.source, reason: describeApiError(error) })) })
          }
        }
        parts.push(await writeIssueFields(client, issue, writes))
        if (current.itemId !== undefined) parts.push(await writeProjectFields(client, config.project.id, current.itemId, writes))
        outcome = { changed: parts.flatMap(part => part.changed), failed: parts.flatMap(part => part.failed) }
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        return stopWith(output, `could not edit the attributes of ${target}: ${error.message}`, kindOfFailure(error))
      }

      report(output, target, outcome)
    })
  },
})

// 結果を set・warning の行と箇条書きに出す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の input の型は配列が可変
function report(output: Readonly<Output<IssueEditJson>>, target: string, outcome: Readonly<AttributeOutcome>): void {
  output.result({ changed: [...outcome.changed], errors: [], failed: [...outcome.failed] })
  if (outcome.changed.length > 0) {
    const operation: Operation = { verb: 'set', target: `${target} ${outcome.changed.map(change => change.name).join(', ')}` }
    output.planned(operation)
    output.done(operation)
  }
  warnFailures(output, target, outcome.failed)
  if (outcome.changed.length > 0) output.data(outcome.changed.map(change => changeLine(change)).join('\n'))
  if (outcome.failed.length > 0) stopWith(output, `could not write ${String(outcome.failed.length)} attribute(s) of ${target}`, 'partial-failure')
}

export const ISSUE_EDIT_TOOLS: readonly ToolDefinition[] = [ISSUE_EDIT]
