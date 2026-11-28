// project_check。projects_write の create_project と、github-ops の project-fields に渡す前の引数が、pecot の決まりに合うかを返す
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型。BoardField は changes を当てる間に書き換える */
import { z } from 'zod'

import { WORKFLOW_FIELD_NAME } from '@pecot/workflow-core/domain/config.js'
import { choosePlacement } from '@pecot/workflow-core/domain/field-options.js'
import { mergeLaneOptions } from '@pecot/workflow-core/domain/lane-options.js'
import { isLegacyWorkflowFieldName } from '@pecot/workflow-core/domain/migration.js'
import { FIELD_CHANGE } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import type { FieldChange } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { LANE_FIELD_NAME } from '@pecot/workflow-core/domain/lanes.js'
import { NEEDS_ATTENTION_SPEC, STATUS_FIELD_NAME, UNUSED_FIELD_NAMES, WORKFLOW_FIELD_SPECS } from '@pecot/workflow-core/commands-shared/workflow-fields.js'
import type { OptionSpec } from '@pecot/workflow-core/commands-shared/workflow-fields.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { unreadProblem } from './check-reads.js'
import { parseOfficial, PROJECTS_LIST_FIELDS, projectFieldsOf } from './official-reads.js'
import { LIST_PROJECTS, PROJECT_FIELDS_PAGE, projectsPageOf } from './official-reads-project.js'

const SINGLE_SELECT = 'SINGLE_SELECT'

const PAGES = z.array(z.unknown())

const PROJECT_CHECK_INPUT = z.object({
  method: z.enum(['create', 'fields']).describe('create before projects_write with method create_project; fields before the project-fields operation of github-ops, or to see what a board still lacks'),
  owner: z.string().min(1).describe('Owner of the board (a user or an organization)'),
  owner_type: z.enum(['user', 'org']).optional().describe('With create: owner_type passed to create_project'),
  title: z.string().optional().describe('With create: title passed to create_project'),
  project: z.number().int().min(1).optional().describe('With fields: number of the board (the project param of project-fields)'),
  changes: z.array(FIELD_CHANGE).optional().describe('With fields: the changes param of project-fields, applied in order to the fields read; omit it to check the board as it is'),
  lanes: z.array(z.string().min(1)).min(1).optional().describe('With fields: values the pecot-lane field must have (the areas of work, in English); omit it when the board has no lanes'),
  reads: z.object({
    projects: PAGES.optional().describe('With create: results of projects_list with method list_projects for the owner (every page)'),
    fields: z.unknown().optional().describe('With fields: result of projects_list with method list_project_fields for the board'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type ProjectCheckInput = z.output<typeof PROJECT_CHECK_INPUT>

const PROJECT_CHECK_OUTPUT = z.strictObject({
  ...CHECK_RESULT_SHAPE,
  deletable: z.array(z.string()).optional().describe('With fields: fields on the board after the changes that pecot does not use (pecot-priority, pecot-size, and the old pecot-workflow-<suffix> field next to pecot-status). Deleting one deletes its values on every card, so delete them only after the user approves'),
})

// --- create ---

function createProblems(output: Readonly<Output>, input: Readonly<ProjectCheckInput>): readonly CheckProblem[] {
  const problems: CheckProblem[] = []
  if (input.owner_type === undefined) problems.push({ field: 'owner_type', code: 'required', message: 'create_project needs owner_type: user or org', candidates: ['user', 'org'] })
  if (input.title === undefined || input.title === '') problems.push({ field: 'title', code: 'required', message: 'create_project needs the title of the new board' })
  if (input.changes !== undefined) problems.push({ field: 'changes', code: 'unexpected', message: 'create checks a new board; check its fields with method fields after create_project' })
  const pages = input.reads?.projects
  if (pages === undefined) return [...problems, unreadProblem('reads.projects', `read the boards of ${input.owner} with projects_list (method list_projects, every page) and pass the results as reads.projects`)]
  const read = pages.map((page, index) => projectsPageOf(parseOfficial(output, 'projects_list', LIST_PROJECTS, page, `reads.projects[${String(index)}]`)))
  if (read.at(-1)?.hasNextPage === true) problems.push(unreadProblem('reads.projects', 'the last page of list_projects has a next page; read it with after and add it to reads.projects'))
  const taken = read.flatMap(page => page.projects).find(project => project.title === input.title)
  if (taken !== undefined && input.title !== undefined) {
    problems.push({ field: 'title', code: 'title-taken', message: `${input.owner} already has a board titled ${input.title} (#${String(taken.number ?? '?')}); choose another title, or use that board with method fields` })
  }
  return problems
}

// --- fields ---

interface BoardField {
  name: string
  readonly dataType: string
  options: readonly string[]
}

const ACTION_LABEL = 'changes'

function changeProblem(index: number, code: string, message: string): CheckProblem {
  return { field: `${ACTION_LABEL}[${String(index)}]`, code, message }
}

// changes を読んだ欄に順に当てる。github-ops が断る変更と、カードの値を消す変更を problem にする
function applyChanges(fields: BoardField[], changes: readonly FieldChange[]): readonly CheckProblem[] {
  const problems: CheckProblem[] = []
  for (const [index, change] of changes.entries()) {
    const found = fields.find(field => field.name === change.name)
    if (change.action === 'create') {
      if (found === undefined) fields.push({ name: change.name, dataType: SINGLE_SELECT, options: change.options.map(option => option.name) })
      else problems.push(changeProblem(index, 'already-exists', `field ${change.name} already exists on the board; use set-options to change its options`))
      continue
    }
    if (found === undefined) {
      problems.push(changeProblem(index, 'not-found', `field ${change.name} is not on the board (after the earlier changes)`))
      continue
    }
    const problem = applyToField(fields, found, change, index)
    if (problem !== undefined) problems.push(problem)
  }
  return problems
}

function applyToField(fields: BoardField[], found: BoardField, change: Exclude<FieldChange, { action: 'create' }>, index: number): CheckProblem | undefined {
  switch (change.action) {
    case 'rename': {
      if (fields.some(field => field.name === change.to)) return changeProblem(index, 'already-exists', `field ${change.to} already exists on the board`)
      found.name = change.to
      return undefined
    }
    case 'delete': {
      fields.splice(fields.indexOf(found), 1)
      return undefined
    }
    case 'set-options': {
      if (found.dataType !== SINGLE_SELECT) return changeProblem(index, 'field-type', `field ${change.name} is not a single select field (${found.dataType})`)
      const before = found.options
      const given = new Set(change.options.map(option => option.name))
      const dropped = before.filter(option => !given.has(option))
      found.options = change.options.map(option => option.name)
      return dropped.length === 0 ? undefined : { ...changeProblem(index, 'option-removed', `set-options replaces the options of ${change.name}, so ${dropped.join(', ')} and their values on the cards would be deleted; list the existing options too, in their order`), candidates: [...before] }
    }
  }
}

function specText(spec: Readonly<OptionSpec>): string {
  return `${spec.option.name} (color ${spec.option.color}, description "${spec.option.description}")`
}

function placementText(spec: Readonly<OptionSpec>, existing: readonly string[]): string {
  const placement = choosePlacement(existing.map(name => ({ name })), spec.placement ?? [{ end: true }])
  if ('after' in placement) return ` after ${placement.after}`
  return 'before' in placement ? ` before ${placement.before}` : ' at the end'
}

function hasOption(options: readonly string[], name: string): boolean {
  return options.some(option => option.toLowerCase() === name.toLowerCase())
}

function workflowProblems(fields: readonly BoardField[]): readonly CheckProblem[] {
  const field = fields.find(item => item.name === WORKFLOW_FIELD_NAME)
  const candidates = WORKFLOW_FIELD_SPECS.map(spec => spec.option.name)
  if (field === undefined) {
    const legacy = fields.find(item => isLegacyWorkflowFieldName(item.name))
    const message = legacy === undefined
      ? `the board has no ${WORKFLOW_FIELD_NAME} field; add a create change with these options in this order: ${WORKFLOW_FIELD_SPECS.map(spec => specText(spec)).join(', ')}`
      : `the board has no ${WORKFLOW_FIELD_NAME} field; add a rename change from ${legacy.name} to ${WORKFLOW_FIELD_NAME}, which keeps its options and the values on the cards`
    return [{ field: WORKFLOW_FIELD_NAME, code: 'missing-field', message, candidates }]
  }
  if (field.dataType !== SINGLE_SELECT) return [{ field: WORKFLOW_FIELD_NAME, code: 'field-type', message: `${WORKFLOW_FIELD_NAME} must be a single select field (it is ${field.dataType}); delete or rename it, then create it again` }]
  const missing = WORKFLOW_FIELD_SPECS.filter(spec => !hasOption(field.options, spec.option.name))
  if (missing.length === 0) return []
  const listed = missing.map(spec => `${specText(spec)}${placementText(spec, field.options)}`).join(', ')
  return [{ field: WORKFLOW_FIELD_NAME, code: 'missing-option', message: `${WORKFLOW_FIELD_NAME} lacks options: ${listed}; add a set-options change that lists the existing options in their order with these`, candidates: missing.map(spec => spec.option.name) }]
}

// 既定の Status は、ある単一選択の欄にだけ Needs Attention を求める（無い・単一選択でない欄は見ない）
function statusProblems(fields: readonly BoardField[]): readonly CheckProblem[] {
  const field = fields.findLast(item => item.name === STATUS_FIELD_NAME && item.dataType === SINGLE_SELECT)
  return field === undefined || hasOption(field.options, NEEDS_ATTENTION_SPEC.option.name) ? [] : [{ field: STATUS_FIELD_NAME, code: 'missing-option', message: `${STATUS_FIELD_NAME} lacks the option ${specText(NEEDS_ATTENTION_SPEC)} at the end; add a set-options change that lists the existing options in their order with it`, candidates: [NEEDS_ATTENTION_SPEC.option.name] }]
}

function laneProblems(fields: readonly BoardField[], lanes: readonly string[] | undefined): readonly CheckProblem[] {
  if (lanes === undefined) return []
  const field = fields.find(item => item.name === LANE_FIELD_NAME)
  const existing = (field?.options ?? []).map(name => ({ name, color: '', description: '' }))
  const { options, added } = mergeLaneOptions(existing, lanes)
  const colored = options.filter(option => added.includes(option.name)).map(option => `${option.name} (color ${option.color})`).join(', ')
  if (field === undefined) return [{ field: LANE_FIELD_NAME, code: 'missing-field', message: `the board has no ${LANE_FIELD_NAME} field; add a create change with the lanes as options: ${colored}`, candidates: [...added] }]
  if (field.dataType !== SINGLE_SELECT) return [{ field: LANE_FIELD_NAME, code: 'field-type', message: `${LANE_FIELD_NAME} must be a single select field (it is ${field.dataType}); delete or rename it, then create it again` }]
  if (added.length === 0) return []
  return [{ field: LANE_FIELD_NAME, code: 'missing-option', message: `${LANE_FIELD_NAME} lacks the lanes ${colored} at the end; add a set-options change that lists the existing options in their order with them`, candidates: [...added] }]
}

function deletableOf(fields: readonly BoardField[]): readonly string[] {
  const unused = UNUSED_FIELD_NAMES.filter(name => fields.some(field => field.name === name))
  const hasCurrent = fields.some(field => field.name === WORKFLOW_FIELD_NAME)
  const legacy = hasCurrent ? fields.filter(field => isLegacyWorkflowFieldName(field.name)).map(field => field.name) : []
  return [...unused, ...legacy]
}

interface FieldsCheck {
  readonly problems: readonly CheckProblem[]
  readonly deletable?: readonly string[]
}

function fieldsCheck(output: Readonly<Output>, input: Readonly<ProjectCheckInput>): FieldsCheck {
  const required: CheckProblem[] = []
  if (input.project === undefined) required.push({ field: 'project', code: 'required', message: 'fields needs project, the number of the board' })
  if (input.title !== undefined || input.owner_type !== undefined) required.push({ field: input.title === undefined ? 'owner_type' : 'title', code: 'unexpected', message: 'title and owner_type are for method create' })
  const read = input.reads?.fields
  if (read === undefined) {
    return { problems: [...required, unreadProblem('reads.fields', `read the fields of the board with projects_list (method list_project_fields, owner ${input.owner}, project_number ${String(input.project ?? '<N>')}) and pass its result as reads.fields`)] }
  }
  const parsed = parseOfficial(output, 'projects_list', PROJECTS_LIST_FIELDS, read, 'reads.fields')
  if (parseOfficial(output, 'projects_list', PROJECT_FIELDS_PAGE, read, 'reads.fields').fields.pageInfo?.hasNextPage === true) {
    required.push(unreadProblem('reads.fields', 'list_project_fields has a next page; read it with per_page 50, or with after, and pass all the fields'))
  }
  const fields: BoardField[] = projectFieldsOf(parsed).map(field => ({ name: field.name, dataType: field.dataType, options: field.options.map(option => option.name) }))
  const changeProblems = applyChanges(fields, input.changes ?? [])
  return {
    problems: [...required, ...changeProblems, ...workflowProblems(fields), ...statusProblems(fields), ...laneProblems(fields, input.lanes)],
    deletable: deletableOf(fields),
  }
}

const PROJECT_CHECK = defineTool({
  name: 'project_check',
  title: 'Check project board',
  description: 'Check the arguments for projects_write create_project (the title is free for the owner), or the changes for the project-fields operation of github-ops against the pecot field rules: after the changes, the board has pecot-status, the Needs Attention option of Status and the pecot-lane values. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  openWorld: false,
  input: PROJECT_CHECK_INPUT,
  output: PROJECT_CHECK_OUTPUT,
  run: (input, io) => {
    const output = createOutput<z.input<typeof PROJECT_CHECK_OUTPUT>>(false, io)
    const checked: FieldsCheck = input.method === 'create' ? { problems: createProblems(output, input) } : fieldsCheck(output, input)
    const problems = [...checked.problems]
    output.result({ problems, ...checked.deletable !== undefined && { deletable: [...checked.deletable] } })
    const lines = problems.length === 0 ? ['ok'] : problems.map(problem => `${problem.field}: ${problem.message}`)
    const deletable = checked.deletable ?? []
    output.data([...lines, ...deletable.length === 0 ? [] : [`deletable: ${deletable.join(', ')}`]].join('\n'))
    return Promise.resolve(0)
  },
})

export { PROJECT_CHECK }
