/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
// board_check。projects_write（update_project_item）に渡す前の引数が、ボードの欄と選択肢と、Ready・Blocked の判定に合うかを返す
import { z } from 'zod'

import { COLUMN_CONFIG_KEYS } from '@pecot/workflow-core/domain/board-move.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { AttributeOption } from '@pecot/workflow-core/domain/attributes.js'
import { displayReference } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { VALID_STATUSES } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { configFor, developmentBranchOf, issueText, parseReads, READ_BLOCKED_BY, READ_ISSUES, READ_PROJECT_FIELDS, READ_PROJECT_ITEMS, READ_PULL_REQUESTS, stackUndecidedHint, unreadProblem } from './check-reads.js'
import type { BoardShape, ParsedReads } from './check-reads.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { referenceOf } from './official-reads.js'
import type { ReadProjectField } from './official-reads.js'
import { dependencyReads, judgeFromReads } from './readiness-reads.js'

const CHECK_PATH = ['board', 'check']

// 判定と比べる列の、判定の側の表示名
const JUDGED_COLUMNS: ReadonlyMap<string, 'Ready' | 'Blocked'> = new Map<string, 'Ready' | 'Blocked'>([['ready', 'Ready'], ['blocked', 'Blocked']])

const FIELD_VALUE = z.union([z.string().describe('Option name, option id or text'), z.number().describe('Number or option id'), z.null().describe('Clears the field')]).describe('Value to set; null clears the field')

const BOARD_CHECK_INPUT = z.object({
  method: z.enum(['update_project_item']).describe('Same as the method of projects_write'),
  owner: z.string().min(1).describe('Owner of the project (same as projects_write)'),
  project_number: z.number().int().min(1).describe('Number of the project (same as projects_write)'),
  issue_number: z.number().int().min(1).describe('Number of the Issue on the card'),
  item_owner: z.string().min(1).describe('Owner of the repository of the Issue'),
  item_repo: z.string().min(1).describe('Name of the repository of the Issue'),
  updated_field: z.object({
    id: z.number().int().optional().describe('Numeric ID of the field (list_project_fields); the value is then an option ID'),
    name: z.string().min(1).optional().describe('Name of the field; the value is then an option name or ID'),
    value: FIELD_VALUE,
  }).describe('Same as the updated_field of projects_write: give either id or name'),
  project: PROJECT_INPUT,
  reads: z.object({
    project_fields: READ_PROJECT_FIELDS,
    project_items: READ_PROJECT_ITEMS.describe('Results of projects_list with method list_project_items (every page, with the field IDs of pecot-status and Status in fields): the cards of the Issue and, for Ready or Blocked, its prerequisites'),
    issues: READ_ISSUES.describe('Results of issue_read with method get (the structuredContent, { issue: ... }): for Ready or Blocked, the Issue and each prerequisite'),
    blocked_by: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocked_by: for Ready or Blocked, the Issue'),
    pull_requests: READ_PULL_REQUESTS,
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type CheckInput = z.output<typeof BOARD_CHECK_INPUT>

const BOARD_CHECK_OUTPUT = z.strictObject({ ...CHECK_RESULT_SHAPE })

type CheckOutput = z.input<typeof BOARD_CHECK_OUTPUT>

interface Checked {
  readonly problems: readonly CheckProblem[]
  readonly warnings: readonly string[]
}

const NONE: Checked = { problems: [], warnings: [] }

function projectProblems(input: Readonly<CheckInput>, config: ProjectConfig): readonly CheckProblem[] {
  const problems: CheckProblem[] = []
  if (input.owner.toLowerCase() !== config.owner.toLowerCase()) problems.push({ field: 'owner', code: 'value', message: `the board of ${input.item_owner}/${input.item_repo} is owned by ${config.owner}`, candidates: [config.owner] })
  if (input.project_number !== config.project.number) problems.push({ field: 'project_number', code: 'value', message: `the board of ${input.item_owner}/${input.item_repo} is project ${String(config.project.number)}`, candidates: [String(config.project.number)] })
  return problems
}

type FieldPick = { readonly field: ReadProjectField } | { readonly problem: CheckProblem }

function pickField(input: Readonly<CheckInput>, board: BoardShape): FieldPick {
  const { id, name } = input.updated_field
  if (id !== undefined && name !== undefined) return { problem: { field: 'updated_field', code: 'value', message: 'give either updated_field.id or updated_field.name, not both' } }
  if (id === undefined && name === undefined) return { problem: { field: 'updated_field', code: 'required', message: 'give updated_field.id or updated_field.name' } }
  const field = id === undefined
    ? board.fields.find(candidate => candidate.name.toLowerCase() === name?.toLowerCase())
    : board.fields.find(candidate => candidate.id === String(id))
  if (field !== undefined) return { field }
  const shown = id === undefined ? `named ${name ?? ''}` : `with ID ${String(id)}`
  const candidates = id === undefined ? board.fields.map(candidate => candidate.name) : board.fields.map(candidate => candidate.id)
  return { problem: { field: id === undefined ? 'updated_field.name' : 'updated_field.id', code: 'unknown-field', message: `the board has no field ${shown}`, candidates } }
}

// 名前の形は選択肢の名前か ID を、ID の形は選択肢の ID だけを受ける（公式の projects_write と同じ）
function pickOption(input: Readonly<CheckInput>, field: ReadProjectField, value: string, allowed: readonly AttributeOption[]): { readonly name: string } | { readonly problem: CheckProblem } {
  const isByName = input.updated_field.name !== undefined
  const found = allowed.find(option => option.id === value || (isByName && option.name.toLowerCase() === value.toLowerCase()))
  if (found !== undefined) return { name: found.name }
  const candidates = isByName ? allowed.map(option => option.name) : allowed.flatMap(option => option.id ?? [])
  const form = isByName ? 'an option name' : 'an option ID (the id form does not take names)'
  return { problem: { field: 'updated_field.value', code: 'unknown-option', message: `${value} is not ${form} of ${field.name} that can be set here`, candidates } }
}

function columnKeyOf(board: BoardShape, optionName: string): string | undefined {
  return [...VALID_STATUSES].find(key => board.column(key)?.toLowerCase() === optionName.toLowerCase())
}

function allowedColumns(board: BoardShape, field: ReadProjectField): readonly AttributeOption[] {
  return field.options.filter(option => columnKeyOf(board, option.name) !== undefined)
}

function blockedOptionGuide(board: BoardShape, value: string): string {
  return board.column('blocked') === undefined && value.toLowerCase() === 'blocked'
    ? '; the board has no Blocked option: add it with project_check (method fields) and the project-fields operation'
    : ''
}

interface JudgeTarget {
  readonly target: IssueReference
  readonly key: string
  readonly reads: ParsedReads
  readonly board: BoardShape
  readonly config: ProjectConfig | undefined
}

// Ready・Blocked に書くときは、書く先の列に置いたものとして判定し、動かす先が出れば食い違い
function judgedProblems(output: Readonly<Output>, input: Readonly<CheckInput>, query: Readonly<JudgeTarget>): Checked {
  const { target, key, reads, board } = query
  const dependencies = dependencyReads(output, input.reads?.blocked_by ?? [])
  const name = displayReference(target, target.repository)
  const column = JUDGED_COLUMNS.get(key) ?? 'Ready'
  const judgment = judgeFromReads({ ref: target, reads, blockedBy: dependencies.reads, board, developmentBranch: developmentBranchOf(query.config, target.repository), column })
  if (judgment.kind === 'unread') return { problems: [...dependencies.problems, ...judgment.problems], warnings: [] }
  const { judged } = judgment
  if (judged.stackUndecided !== undefined) return { problems: dependencies.problems, warnings: [`whether ${name} can stack on its prerequisites is not decided: ${stackUndecidedHint(judged.stackUndecided)}`] }
  const { move } = judged
  const warnings: string[] = []
  const problems: CheckProblem[] = [...dependencies.problems]
  if (move?.label !== undefined) warnings.push(`set Status of ${name} to ${move.label} as well`)
  if (move?.conflict !== undefined) {
    problems.push({ field: 'updated_field.value', code: 'status-mismatch', message: `${name} was started but its prerequisites are not done; keep it in its column` })
  }
  const to = move?.column?.to
  if (to !== undefined) {
    // eslint-disable-next-line security/detect-object-injection -- to は MovableColumn の列挙
    const expected = board.column(COLUMN_CONFIG_KEYS[to]) ?? to
    problems.push({ field: 'updated_field.value', code: 'status-mismatch', message: `${name} belongs in ${expected} by its prerequisites, not ${board.column(key) ?? column}`, candidates: [expected] })
  }
  return { problems, warnings }
}

function cardProblem(reads: ParsedReads, target: IssueReference, input: Readonly<CheckInput>, isRequired: boolean): CheckProblem | undefined {
  if (reads.cards === undefined) {
    return isRequired ? unreadProblem('reads.project_items', 'read the cards with projects_list (method list_project_items) to judge the column') : undefined
  }
  if (reads.cards.has(issueReferenceKey(target))) return undefined
  return { field: 'issue_number', code: 'not-found', message: `${issueText(target)} is not on the board ${input.owner}/${String(input.project_number)}: add it with projects_write (method add_project_item) first` }
}

function checkField(output: Readonly<Output>, input: Readonly<CheckInput>, target: IssueReference, config: ProjectConfig | undefined): Checked {
  const reads = parseReads(output, input.reads, config)
  const { board } = reads
  if (board === undefined) return { problems: [unreadProblem('reads.project_fields', 'read the board fields with projects_list (method list_project_fields)')], warnings: [] }
  const picked = pickField(input, board)
  if ('problem' in picked) return { problems: [picked.problem], warnings: [] }
  const { field } = picked
  const { value } = input.updated_field
  const isColumn = field === board.workflow
  if (value === null) return isColumn ? { problems: [{ field: 'updated_field.value', code: 'value', message: `${field.name} cannot be cleared: every Issue on the board has a column` }], warnings: [] } : NONE
  if (field.dataType !== 'SINGLE_SELECT') return NONE
  if (typeof value !== 'string') return { problems: [{ field: 'updated_field.value', code: 'value', message: `${field.name} takes an option name or ID as a string` }], warnings: [] }
  const option = pickOption(input, field, value, isColumn ? allowedColumns(board, field) : field.options)
  if ('problem' in option) return { problems: [{ ...option.problem, message: `${option.problem.message}${isColumn ? blockedOptionGuide(board, value) : ''}` }], warnings: [] }
  const key = isColumn ? columnKeyOf(board, option.name) : undefined
  const isJudged = key !== undefined && JUDGED_COLUMNS.has(key)
  const card = cardProblem(reads, target, input, isJudged)
  if (card !== undefined) return { problems: [card], warnings: [] }
  return isJudged ? judgedProblems(output, input, { target, key, reads, board, config }) : NONE
}

function runCheck(output: Readonly<Output<CheckOutput>>, input: Readonly<CheckInput>): void {
  const problems: CheckProblem[] = []
  const target = referenceOf(`${input.item_owner}/${input.item_repo}`, input.issue_number)
  if (target === undefined) problems.push({ field: 'item_repo', code: 'value', message: `${input.item_owner}/${input.item_repo} is not a repository name` })
  let config: ProjectConfig | undefined
  if (target !== undefined) {
    const chosen = configFor(target.repository, input.project, CHECK_PATH)
    if (chosen.kind === 'problem') problems.push({ field: 'item_repo', code: 'not-in-project', message: chosen.message })
    else config = chosen.config
  }
  if (config !== undefined) problems.push(...projectProblems(input, config))
  const checked = target === undefined ? NONE : checkField(output, input, target, config)
  for (const warning of checked.warnings) output.warning(warning)
  const all = [...problems, ...checked.problems]
  output.result({ problems: all })
  output.data(all.length === 0 ? 'ok' : all.map(problem => `${problem.field}: ${problem.message}`).join('\n'))
}

const BOARD_CHECK = defineTool({
  name: 'board_check',
  title: 'Check board move',
  description: 'Check the arguments for projects_write (method update_project_item) against the pecot rules before writing: the field and option are on the board, and Ready or Blocked matches the judgment of the prerequisites. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  openWorld: false,
  input: BOARD_CHECK_INPUT,
  output: BOARD_CHECK_OUTPUT,
  run: (input, io) => {
    runCheck(createOutput<CheckOutput>(false, io), input)
    return Promise.resolve(0)
  },
})

export const BOARD_CHECK_TOOLS: readonly ToolDefinition[] = [BOARD_CHECK]
