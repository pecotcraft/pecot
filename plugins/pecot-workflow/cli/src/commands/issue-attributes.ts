// issue attributes。Issue に付けられる機能（ボードのフィールド・Issue fields・組み込み）の定義を出す。
import { z } from 'zod'

import { ATTRIBUTE_KINDS, ATTRIBUTE_SOURCES, unsupportedOf } from '@pecot/workflow-core/domain/attributes.js'
import type { AttributeDefinition } from '@pecot/workflow-core/domain/attributes.js'
import { readAttributeDefinitions } from '@pecot/workflow-core/infra/github/attributes.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { defineCommand } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createAuthenticatedGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { requireReleaseTargetRepository } from './release.js'
import { requireRepositoryMatch } from './repository-match.js'

const ATTRIBUTES_PATH = ['issue', 'attributes']

const SOURCE_JSON = z.enum(ATTRIBUTE_SOURCES).describe('Where the attribute lives: project (a field of the configured board), issue_field (an Issue field) or issue (built into the Issue)')

const OPTION_JSON = z.strictObject({
  name: z.string().describe('Name of the value to choose'),
  start_date: z.string().optional().describe('Start date of the iteration (YYYY-MM-DD; only for iteration)'),
})

const DEFINITION_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute'),
  source: SOURCE_JSON,
  kind: z.enum(ATTRIBUTE_KINDS).describe('Kind of the value'),
  options: z.array(OPTION_JSON).optional().describe('Values to choose from (only for the kinds with choices; assignees are not listed)'),
  writable: z.boolean().describe('Whether the attribute takes a value set by a person or a tool (false for computed fields, the board columns moved by board_move, parent and blocked_by)'),
  unsupported_reason: z.string().optional().describe('GitHub type that pecot does not handle (only when kind is unsupported)'),
})

export const UNSUPPORTED_ATTRIBUTE_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute'),
  source: SOURCE_JSON,
  github_type: z.string().describe('GitHub type that pecot does not handle'),
})

const ATTRIBUTE_VALUE_JSON = z.union([z.string(), z.number(), z.array(z.string())])

export const ATTRIBUTE_READING_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute'),
  source: SOURCE_JSON,
  kind: z.enum(ATTRIBUTE_KINDS).describe('Kind of the value'),
  value: ATTRIBUTE_VALUE_JSON.describe('Value: a name for select, iteration, milestone and issue_type; a list for multi_select, users, labels and issue_refs; a number for number; YYYY-MM-DD for date; owner/repo/N for issue_ref'),
})

const ISSUE_ATTRIBUTES_OUTPUT = z.strictObject({
  attributes: z.array(DEFINITION_JSON).describe('Attributes that an Issue of the repository can have'),
  unsupported: z.array(UNSUPPORTED_ATTRIBUTE_JSON).describe('Attributes whose kind pecot does not handle'),
})

type IssueAttributesJson = z.input<typeof ISSUE_ATTRIBUTES_OUTPUT>

function definitionJson(definition: Readonly<AttributeDefinition>): IssueAttributesJson['attributes'][number] {
  const { name, source, kind, options, writable, unsupportedReason } = definition
  return {
    name,
    source,
    kind,
    ...options !== undefined && { options: options.map(option => ({ name: option.name, ...option.startDate !== undefined && { start_date: option.startDate } })) },
    writable,
    ...unsupportedReason !== undefined && { unsupported_reason: unsupportedReason },
  }
}

function definitionLine(definition: Readonly<AttributeDefinition>): string {
  const detail = definition.kind === 'unsupported'
    ? `${definition.source}, unsupported (${definition.unsupportedReason ?? ''})`
    : `${definition.source}, ${definition.kind}${definition.writable ? '' : ', read-only'}`
  const options = (definition.options ?? []).map(option => option.startDate === undefined ? option.name : `${option.name} (${option.startDate})`)
  return `- ${definition.name} (${detail})${options.length === 0 ? '' : `: ${options.join(', ')}`}`
}

const ISSUE_ATTRIBUTES = defineCommand({
  path: ATTRIBUTES_PATH,
  title: 'List Issue attributes',
  description: 'List the attributes an Issue of the repository can have: fields of the configured board, Issue fields, and built-in ones',
  input: z.object({
    project: PROJECT_INPUT,
    json: z.boolean().default(false).describe('Output as JSON'),
  }),
  output: ISSUE_ATTRIBUTES_OUTPUT,
  positional: [],
  shortFlags: { json: '-j' },
  interactive: false,
  run: async (input, io) => {
    const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
    const output = createOutput<IssueAttributesJson>(false, io)
    return await runWithExit(async () => {
      const target = requireReleaseTargetRepository(adopted, input.repo, output)
      const { owner, repository } = target
      const { config } = requireConfigFor(output, target, input.project, ATTRIBUTES_PATH)
      const client = await createAuthenticatedGitHubClient(output, config.host)
      let result
      try {
        result = await readAttributeDefinitions(client, { owner, repository, projectId: config.project.id, workflowFieldId: config.project.fields.workflow.id })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        return stopWith(output, `could not read the attributes of ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
      }
      for (const warning of result.warnings) output.warning(warning)
      const json: IssueAttributesJson = {
        attributes: result.definitions.map(definition => definitionJson(definition)),
        unsupported: unsupportedOf(result.definitions).map(({ name, source, githubType }) => ({ name, source, github_type: githubType })),
      }
      output.result(json)
      output.data(input.json ? JSON.stringify(json, undefined, 2) : result.definitions.map(definition => definitionLine(definition)).join('\n'))
    })
  },
})

export const ISSUE_ATTRIBUTES_COMMANDS: readonly CommandDefinition[] = [ISSUE_ATTRIBUTES]
