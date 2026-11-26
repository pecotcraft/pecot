// issue check。issue create に渡すファイルを確かめ、番号・前提・進め方の表を返す。書き込まない。
import { z } from 'zod'

import { formatPlanTable } from '@pecot/workflow-core/domain/batch-plan.js'
import type { PlanRow, ResolvedPrerequisite } from '@pecot/workflow-core/domain/batch-plan.js'
import { displayReference } from '@pecot/workflow-core/domain/readiness.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { defineCommand } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { CommandDefinition, CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { inputNameHint, hinted } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { chainsData, chainsText, existingLabels, prepareBatch, STACKABLE_CHAINS } from './issue-create.js'
import type { BatchContext } from './issue-create.js'
import { runWithExit } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const CHECK_PATH = ['issue', 'check']

const PLAN_PREREQUISITE_DATA = z.strictObject({
  issue: z.string().describe('Prerequisite: key of a file, or #N / owner/repo#N for an existing Issue'),
  wait: z.enum(['stack', 'merge']).describe('How to wait for the prerequisite'),
})

const PLAN_ROW_DATA = z.strictObject({
  file: z.string().describe('Key of the file (the file name without the extension)'),
  order: z.int().optional().describe('Order number in the title (omitted without a parent Epic)'),
  blockedBy: z.array(PLAN_PREREQUISITE_DATA).describe('Prerequisites in the order written'),
  approach: z.enum(['alone', 'wait-merge', 'stack', 'join']).describe('How to proceed'),
  stackOn: z.string().optional().describe('Prerequisite to stack on (only when approach is stack)'),
})

const FILES_SCHEMA = z.array(z.string()).describe('Path of a Markdown file with frontmatter (several for a batch, in the order to post)')

const ISSUE_CHECK_OUTPUT = z.strictObject({
  plan: z.array(PLAN_ROW_DATA).describe('Progression table of the files, in the order given'),
  stackableChains: STACKABLE_CHAINS,
})

type IssueCheckData = z.input<typeof ISSUE_CHECK_OUTPUT>

function planRowData(row: Readonly<PlanRow>, home: RepositoryReference): z.input<typeof PLAN_ROW_DATA> {
  const label = ({ target, key }: Readonly<ResolvedPrerequisite>): string => target.kind === 'file' ? key : displayReference(target.reference, home)
  const { progression } = row
  const stackOn = progression?.kind === 'stack' ? row.prerequisites.find(({ key }) => key === progression.on) : undefined
  return {
    file: row.file,
    ...row.order !== undefined && { order: row.order },
    blockedBy: row.prerequisites.map(prerequisite => ({ issue: label(prerequisite), wait: prerequisite.wait })),
    approach: progression?.kind ?? 'alone',
    ...progression?.kind === 'stack' && { stackOn: stackOn === undefined ? progression.on : label(stackOn) },
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Map を持つため
function printPlan(output: Readonly<Output<IssueCheckData>>, context: Readonly<BatchContext>): void {
  const rows = context.locals.map((local, index): PlanRow => ({
    file: local.key,
    order: context.orders.at(index),
    prerequisites: context.prerequisites.at(index) ?? [],
    progression: context.progressions.get(local.key),
  }))
  const labels = existingLabels(context)
  output.result({ plan: rows.map(row => planRowData(row, context.home)), ...chainsData(context.progressions, labels) })
  const chains = chainsText(context.progressions, labels)
  // MCP の要約の文が表の見出しにならないよう、表の前に題の行を置く
  output.data(['Plan:', formatPlanTable(rows, context.home), ...chains === undefined ? [] : ['', chains]].join('\n'))
}

const ISSUE_CHECK = defineCommand({
  path: CHECK_PATH,
  title: 'Check Issue files',
  description: 'Check Markdown files for issue create and show their order numbers, prerequisites and how to proceed, without creating anything',
  input: z.object({
    files: FILES_SCHEMA,
    project: PROJECT_INPUT,
  }),
  output: ISSUE_CHECK_OUTPUT,
  positional: ['files'],
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput<IssueCheckData>(false, io)
    return await runWithExit(async () => {
      if (input.files.length === 0) stopWith(output, hinted`${inputNameHint(CHECK_PATH, 'files')} is required`, 'invalid-input', USAGE_EXIT_CODE)
      printPlan(output, await prepareBatch(output, input.files, input.project, CHECK_PATH))
    })
  },
})

export const ISSUE_CHECK_COMMANDS: readonly CommandDefinition[] = [ISSUE_CHECK]
