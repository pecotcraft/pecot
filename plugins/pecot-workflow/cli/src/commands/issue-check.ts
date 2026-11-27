/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
// issue_check。issue_write に渡す前の引数が、pecot の起票の決まり（本文・題・置く列・前提・機能の値）に合うかを返す
import { z } from 'zod'

import { resolveBatch } from '@pecot/workflow-core/domain/batch-plan.js'
import type { BatchFile, PlanRow, ResolvedPrerequisite } from '@pecot/workflow-core/domain/batch-plan.js'
import { validateAttributes } from '@pecot/workflow-core/domain/attributes.js'
import type { AttributeDefinition, AttributeInput } from '@pecot/workflow-core/domain/attributes.js'
import { workflowFieldId } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { stripFrontmatter, stripLeadingHtmlComment } from '@pecot/workflow-core/domain/frontmatter.js'
import { findBatchDuplicate, planOrders, usedOrdersOf } from '@pecot/workflow-core/domain/issue-order.js'
import type { OrderRequest } from '@pecot/workflow-core/domain/issue-order.js'
import { buildIssueTitle, epicTargetRepository, splitIssueTitle, titlePrefixOf } from '@pecot/workflow-core/domain/issue-rules.js'
import type { IssueType, TitleParts } from '@pecot/workflow-core/domain/issue-rules.js'
import { JSON_NULL } from '@pecot/workflow-core/domain/json-null.js'
import { LANE_FIELD_NAME } from '@pecot/workflow-core/domain/lanes.js'
import { readWaitsForMerge, WAITS_FOR_MERGE_HEADING } from '@pecot/workflow-core/domain/prerequisites.js'
import { PYTHON_LINE_BREAK, pythonRightStrip, pythonStrip, truncateCodePoints } from '@pecot/workflow-core/domain/python-format.js'
import { displayReference, stackChains } from '@pecot/workflow-core/domain/readiness.js'
import type { Prerequisite, Progression } from '@pecot/workflow-core/domain/readiness.js'
import { createIssueReference, issueReferenceKey, parseIssueReference, ReferenceParseError } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { closedHeadingGuidance, EM_DASH_HINT, templateViolations } from '@pecot/workflow-core/domain/template-violations.js'
import type { TemplateViolation, TemplateViolationCode } from '@pecot/workflow-core/domain/template-violations.js'
import { loadActiveConfig, loadNamedConfig } from '@pecot/workflow-core/infra/config-store.js'
import { readTemplateSections } from '@pecot/workflow-core/infra/template-sections.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { templateFile } from '../infra/template-store.js'
import { attributeErrorLine } from './attribute-writes.js'
import { columnNames, configFor, developmentBranchOf, issueText, judgeMove, parseReads, prerequisiteFacts, READ_ISSUES, READ_PROJECT_FIELDS, READ_PROJECT_ITEMS, READ_PULL_REQUESTS, stackUndecidedHint, unreadProblem } from './check-reads.js'
import type { BoardShape, ParsedReads } from './check-reads.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { collaboratorLoginsOf, issueFactsOf, issueFieldDefinitionsOf, issueTypeNamesOf, ISSUE_READ_SUB_ISSUES, LIST_COLLABORATORS, LIST_ISSUE_FIELDS, LIST_ISSUE_TYPES, parseOfficial, projectDefinitionsOf, subIssueTitlesOf } from './official-reads.js'
import type { ReadProjectField } from './official-reads.js'

const CHECK_PATH = ['issue', 'check']
const ISSUE_TEMPLATE_PREFIX = 'pecot-template://issue/'
const BUNDLED_PREFIX = 'pecot-template://'
// 同梱のテンプレートの名前 → そのテンプレートの種別
const ISSUE_TEMPLATES: ReadonlyMap<string, IssueType> = new Map([['task', 'task'], ['task-implement', 'task'], ['bug', 'bug'], ['epic', 'epic'], ['tracker', 'tracker']])
const PLACEHOLDER_PATTERN = /\{\{issue:([^{}\s]+)\}\}/gu
// Python の re の `\s` と同じ集合。JS の `\s` と違い、U+001C〜U+001F を含む
// eslint-disable-next-line no-control-regex -- Python の空白に含まれる制御文字
const PYTHON_WHITESPACE_RUN = /[\p{White_Space}\u{1C}\u{1D}\u{1E}\u{1F}]+/gu
// テンプレートを使わない自由形式でも、起票の決まりへの参照を本文の末尾に残す
const FREEFORM_FOOTER = '<!-- issue_check の自由形式で起票（テンプレートの検証なし）。起票ルール: skills/w-help/references/issue-flow-rules.md#起票時の既定-status -->'
const FREEFORM_TITLE_LENGTH = 50
// GitHub が 1 つの Issue に付けられる blocked by の数と担当の数
const MAX_BLOCKED_BY = 50
const MAX_ASSIGNEES = 10
// 一括の key を、Waits for merge の節と判定で Issue の番号として読むための仮の番号
const PLACEHOLDER_NUMBER_BASE = 900_000_000
const STATUS_FIELD_NAME = 'Status'

const VIOLATION_LABELS: ReadonlyMap<TemplateViolationCode, string> = new Map([
  ['missing-section', 'missing section'],
  ['heading-summary', 'heading summary rule'],
  ['body-style', 'unusable notation'],
  ['fold', 'collapse rule'],
  ['extra-heading', 'heading not in the template'],
])

const BLOCKED_BY_ENTRY = z.object({
  issue: z.string().min(1).describe('Prerequisite: owner/repo/N for an existing Issue, or the key of an earlier Issue in the batch'),
  wait: z.enum(['stack', 'merge']).default('stack').describe('stack (build on its branch; the default) or merge (wait until it is merged)'),
  reason: z.string().optional().describe('With wait merge only: why it waits for the merge, in one line'),
})

const ISSUE_FIELD_ENTRY = z.object({
  field_name: z.string().min(1).describe('Name of the Issue field'),
  // 枝ごとに describe を付けて、JSON Schema を型の配列でなく anyOf にする（定義書の書き出しが受ける形）
  value: z.union([z.string().describe('Value of a text or date field'), z.number().describe('Value of a number field')]).optional().describe('Value of a text, number or date field'),
  field_option_name: z.string().optional().describe('Option name of a single select field'),
  delete: z.boolean().optional().describe('True to clear the field'),
})

const PROJECT_FIELD_ENTRY = z.object({
  name: z.string().optional().describe('Name of the board field'),
  id: z.number().int().optional().describe('Id of the board field (the id in list_project_fields; same as updated_field.id of projects_write)'),
  value: z.union([z.string().describe('Option name, option id or text'), z.number().describe('Number or option id'), z.null().describe('Clears the field')]).describe('Value as passed to projects_write: an option name or option id for a single select, null to clear'),
})

const ISSUE_ARGS = z.object({
  key: z.string().optional().describe('With a batch create: the name blocked_by and {{issue:key}} of later Issues use for this one'),
  template: z.string().optional().describe('Template the body follows: pecot-template://issue/<name> for a bundled one (its rules are checked); a replaced template\'s path or URL is accepted without checking the body; omit for the free form'),
  template_text: z.string().optional().describe('Text of a replaced template; the body is not checked against it'),
  kind: z.enum(['task', 'bug', 'epic', 'tracker']).describe('pecot kind of the Issue'),
  owner: z.string().optional().describe('Owner of the repository to write to'),
  repo: z.string().optional().describe('Name of the repository to write to'),
  issue_number: z.number().int().min(1).optional().describe('With update only: the Issue to rewrite'),
  title: z.string().optional().describe('Same as issue_write'),
  body: z.string().optional().describe('Same as issue_write; without the frontmatter and the guide comment of the template'),
  type: z.union([z.string().min(1).describe('Issue type name'), z.null().describe('Clears the type')]).optional().describe('Same as issue_write: a GitHub Issue type name'),
  labels: z.array(z.string()).optional().describe('Same as issue_write'),
  assignees: z.array(z.string()).optional().describe('Same as issue_write'),
  milestone: z.number().int().optional().describe('Same as issue_write'),
  issue_fields: z.array(ISSUE_FIELD_ENTRY).optional().describe('Same as issue_write'),
  parent_owner: z.string().optional().describe('Owner of the repository of the parent Epic'),
  parent_repo: z.string().optional().describe('Name of the repository of the parent Epic'),
  parent_issue_number: z.number().int().min(1).optional().describe('Number of the parent Epic'),
  blocked_by: z.array(BLOCKED_BY_ENTRY).optional().describe('With create only: prerequisites to write with issue_dependency_write after the create'),
  project_fields: z.array(PROJECT_FIELD_ENTRY).optional().describe('Board fields to write with projects_write (update_project_item), including the column (pecot-status)'),
  state: z.string().optional().describe('With update only: same as issue_write'),
  state_reason: z.string().optional().describe('With update only: same as issue_write'),
  duplicate_of: z.number().int().optional().describe('With update only: same as issue_write'),
})

const SUB_ISSUES_READ = z.object({
  parent: z.string().describe('The parent Epic whose sub-issues were read (owner/repo/N)'),
  result: z.unknown().describe('Result of issue_read with method get_sub_issues'),
})

const ISSUE_CHECK_INPUT = z.object({
  method: z.enum(['create', 'update']).describe('create before issue_write with method create (several Issues for a batch, in the order to write), update before issue_write with method update (one Issue)'),
  project: PROJECT_INPUT,
  issues: z.array(ISSUE_ARGS).min(1).describe('Arguments of each Issue: the keys of the template, the same values passed to the write tools'),
  reads: z.object({
    issues: READ_ISSUES,
    sub_issues: z.array(SUB_ISSUES_READ).optional().describe('Results of issue_read with method get_sub_issues for each parent Epic (every page)'),
    project_items: READ_PROJECT_ITEMS,
    project_fields: READ_PROJECT_FIELDS,
    pull_requests: READ_PULL_REQUESTS,
    issue_fields: z.unknown().optional().describe('Result of list_issue_fields for the repository of the Issues'),
    issue_types: z.unknown().optional().describe('Result of list_issue_types for the owner of the repository'),
    collaborators: z.unknown().optional().describe('Result of list_repository_collaborators for the repository of the Issues'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type CheckInput = z.output<typeof ISSUE_CHECK_INPUT>
type IssueArguments = CheckInput['issues'][number]

const PLAN_PREREQUISITE_DATA = z.strictObject({
  issue: z.string().describe('Prerequisite: key of an Issue in the batch, or #N / owner/repo#N for an existing Issue'),
  wait: z.enum(['stack', 'merge']).describe('How to wait for the prerequisite'),
})

const PLAN_ROW_DATA = z.strictObject({
  key: z.string().describe('Key of the Issue (issues[i] when it has none)'),
  order: z.int().optional().describe('Order number in the title (omitted without a parent Epic)'),
  blockedBy: z.array(PLAN_PREREQUISITE_DATA).describe('Prerequisites in the order written'),
  approach: z.enum(['alone', 'wait-merge', 'stack', 'join']).describe('How to proceed'),
  stackOn: z.string().optional().describe('Prerequisite to stack on (only when approach is stack)'),
})

const STACK_CHAIN = z.array(z.string())

const ISSUE_CHECK_OUTPUT = z.strictObject({
  ...CHECK_RESULT_SHAPE,
  plan: z.array(PLAN_ROW_DATA).optional().describe('With create: how each Issue proceeds, in the order given'),
  stackableChains: z.array(STACK_CHAIN).optional().describe('Stackable chains, each from the bottom; Issues of the batch by key, existing Issues as #N or owner/repo#N (omitted when none)'),
})

type CheckOutput = z.input<typeof ISSUE_CHECK_OUTPUT>

/**
1 件の Issue の、確かめに使う形
*/
interface Target {
  readonly index: number
  readonly args: IssueArguments
  /**
  problem の issue。一括のときだけ持つ
  */
  readonly label: string | undefined
  /**
  一括の中の名前（key か issues[i]）
  */
  readonly name: string
  readonly home: RepositoryReference | undefined
  readonly parent: IssueReference | undefined
  readonly title: string | undefined
  readonly body: string | undefined
  readonly type: string | undefined
}

class Findings {
  readonly problems: CheckProblem[] = []
  readonly warnings: string[] = []

  add(target: Readonly<Target> | undefined, field: string, code: string, message: string, candidates?: readonly string[]): void {
    this.problems.push({ ...target?.label !== undefined && { issue: target.label }, field, code, message, ...candidates !== undefined && candidates.length > 0 && { candidates: [...candidates] } })
  }

  push(problem: Readonly<CheckProblem>, target?: Readonly<Target>): void {
    this.problems.push({ ...target?.label !== undefined && { issue: target.label }, ...problem })
  }

  warn(target: Readonly<Target> | undefined, message: string): void {
    this.warnings.push(target?.label === undefined ? message : `${target.label}: ${message}`)
  }
}

function given(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || pythonStrip(value) === '' ? undefined : value
}

function repositoryOf(owner: string | undefined, repository: string | undefined): RepositoryReference | undefined {
  if (owner === undefined || repository === undefined) return undefined
  const parts = splitOwnerRepository(`${pythonStrip(owner)}/${pythonStrip(repository)}`)
  return parts === undefined ? undefined : createRepositoryReference(parts.owner, parts.repository)
}

function parentOf(issue: Readonly<IssueArguments>, target: Readonly<Target>, findings: Findings): IssueReference | undefined {
  const owner = given(issue.parent_owner)
  const repository = given(issue.parent_repo)
  const number = issue.parent_issue_number ?? undefined
  const count = [owner, repository, number].filter(value => value !== undefined).length
  if (count === 0) return undefined
  if (count < 3) {
    findings.add(target, 'parent_issue_number', 'parent', 'give parent_owner, parent_repo and parent_issue_number together, or none of them')
    return undefined
  }
  const home = repositoryOf(owner, repository)
  if (home === undefined || number === undefined) {
    findings.add(target, 'parent_repo', 'value', `${String(owner)}/${String(repository)} is not a repository name`)
    return undefined
  }
  return createIssueReference(home, number)
}

function targetsOf(input: Readonly<CheckInput>, findings: Findings): readonly Target[] {
  const isBatch = input.issues.length > 1
  return input.issues.map((issue, index) => {
    const key = given(issue.key)
    const name = key ?? `issues[${String(index)}]`
    const partial: Target = { index, args: issue, label: isBatch ? name : undefined, name, home: repositoryOf(given(issue.owner), given(issue.repo)), parent: undefined, title: given(issue.title), body: issue.body, type: given(issue.type) }
    return { ...partial, parent: parentOf(issue, partial, findings) }
  })
}

// --- 起票先と設定 ---

interface ChosenConfig {
  readonly config: ProjectConfig | undefined
  readonly source: string | undefined
}

function boardConfig(project: string | undefined): ProjectConfig | undefined {
  return project === undefined ? loadActiveConfig() : loadNamedConfig(project)?.config
}

// 起票先のリポから設定を選ぶ。Epic は aggregation_repo の方針も見る
function configOfTarget(target: Readonly<Target>, input: Readonly<CheckInput>, findings: Findings): ChosenConfig {
  const { args, home } = target
  if (home === undefined) {
    const isGiven = given(args.owner) !== undefined || given(args.repo) !== undefined
    if (isGiven) {
      findings.add(target, 'repo', 'value', `${String(args.owner)}/${String(args.repo)} is not a repository name`)
      return { config: undefined, source: undefined }
    }
    const aggregation = args.kind === 'epic' ? boardConfig(input.project)?.aggregation_repo : undefined
    const epic = epicTargetRepository(undefined, aggregation)
    const candidates = epic.kind === 'resolved' ? [epic.repository] : []
    findings.add(target, 'repo', 'required', args.kind === 'epic' && epic.kind === 'resolved' ? `owner and repo are required: write an Epic to aggregation_repo ${epic.repository}` : 'owner and repo are required', candidates)
    return { config: undefined, source: undefined }
  }
  const chosen = configFor(home, input.project, CHECK_PATH)
  if (chosen.kind === 'problem') {
    findings.add(target, 'repo', 'not-in-project', chosen.message)
    return { config: undefined, source: undefined }
  }
  if (args.kind === 'epic' && input.method === 'create') {
    const aggregation = chosen.config.aggregation_repo
    const epic = epicTargetRepository(`${home.owner}/${home.repository}`, aggregation)
    if (epic.kind === 'resolved' && epic.isException) findings.warn(target, `the Epic is written to ${home.owner}/${home.repository}, not to aggregation_repo ${String(aggregation)}; keep it only when the exception is intended`)
  }
  return { config: chosen.config, source: chosen.source }
}

function chooseConfig(targets: readonly Target[], input: Readonly<CheckInput>, findings: Findings): ProjectConfig | undefined {
  const chosen = targets.map(target => ({ target, ...configOfTarget(target, input, findings) }))
  const found = chosen.filter(entry => entry.source !== undefined)
  const [first] = found
  if (first !== undefined && found.some(entry => entry.source !== first.source)) {
    findings.add(undefined, 'issues', 'project', `the Issues belong to different project configs: ${found.map(entry => `${entry.target.name} (${String(entry.source)})`).join(', ')}; check them separately`)
  }
  return first?.config
}

// --- 用法 ---

function usageProblems(input: Readonly<CheckInput>, target: Readonly<Target>, findings: Findings): void {
  const { args } = target
  if (input.method === 'update') {
    if (args.issue_number === undefined) findings.add(target, 'issue_number', 'required', 'update needs issue_number, the Issue to rewrite')
    if (target.parent !== undefined || args.parent_issue_number !== undefined) findings.add(target, 'parent_issue_number', 'unexpected', 'the parent is not changed with update; link it with sub_issue_write')
    if ((args.blocked_by ?? []).length > 0) findings.add(target, 'blocked_by', 'unexpected', 'blocked_by is not changed with update; check each change with issue_dependency_check and write it with issue_dependency_write')
    return
  }
  if (args.issue_number !== undefined) findings.add(target, 'issue_number', 'unexpected', 'create takes no issue_number; use method update to rewrite an Issue')
  if (given(args.state) !== undefined) findings.add(target, 'state', 'unexpected', 'state is only for update')
  if (given(args.state_reason) !== undefined) findings.add(target, 'state_reason', 'unexpected', 'state_reason is only for update')
  if (args.duplicate_of !== undefined) findings.add(target, 'duplicate_of', 'unexpected', 'duplicate_of is only for update')
  if (target.parent !== undefined && args.kind === 'epic') findings.warn(target, 'giving a parent Epic to an Epic is not recommended')
  if (target.parent !== undefined && (args.issue_fields ?? []).length > 0) findings.warn(target, 'issue_write takes no parent_* together with issue_fields: leave the parent out of issue_write and link it with sub_issue_write after the create')
}

function builtinProblems(target: Readonly<Target>, reads: Readonly<RawReads>, output: Readonly<Output>, findings: Findings): void {
  const { args } = target
  const assignees = args.assignees ?? []
  if (assignees.length > MAX_ASSIGNEES) findings.add(target, 'assignees', 'limit', `an Issue takes up to ${String(MAX_ASSIGNEES)} assignees (given ${String(assignees.length)})`)
  if (assignees.length > 0 && reads.collaborators !== undefined) {
    const logins = new Set(collaboratorLoginsOf(parseOfficial(output, 'list_repository_collaborators', LIST_COLLABORATORS, reads.collaborators, 'reads.collaborators')).map(login => login.toLowerCase()))
    const unknown = assignees.filter(login => !logins.has(login.toLowerCase()))
    if (unknown.length > 0) findings.warn(target, `not a collaborator of the repository, so GitHub may drop the assignment: ${unknown.join(', ')}`)
  }
  if (args.milestone !== undefined && args.milestone <= 0) findings.add(target, 'milestone', 'value', 'milestone is the number of the milestone, a positive integer')
  typeProblems(target, reads, output, findings)
}

function typeProblems(target: Readonly<Target>, reads: Readonly<RawReads>, output: Readonly<Output>, findings: Findings): void {
  const { type } = target
  if (type === undefined) return
  if (reads.issue_types === undefined) {
    findings.push(unreadProblem('reads.issue_types', 'read the Issue types with list_issue_types to check type'), target)
    return
  }
  const names = issueTypeNamesOf(parseOfficial(output, 'list_issue_types', LIST_ISSUE_TYPES, reads.issue_types, 'reads.issue_types'))
  if (names.length === 0) findings.add(target, 'type', 'no-issue-types', 'the repository has no Issue types: omit type')
  else if (names.every(name => name.toLowerCase() !== type.toLowerCase())) findings.add(target, 'type', 'value', `${type} is not an Issue type of the repository`, names)
}

// --- 本文 ---

function violationMessage(violation: Readonly<TemplateViolation>, template: string, stem: string): string {
  const base = `${VIOLATION_LABELS.get(violation.code) ?? violation.code} (${template}): ${violation.detail}`
  if (violation.code === 'missing-section' && violation.detail.includes(' — <')) return `${base}; ${EM_DASH_HINT}`
  if (violation.code === 'extra-heading') return `${base}; ${String(closedHeadingGuidance(stem))}`
  return base
}

function freeformMessage(body: string): string {
  const trimmed = pythonRightStrip(body)
  return trimmed.endsWith(FREEFORM_FOOTER) ? trimmed.slice(0, -FREEFORM_FOOTER.length) : body
}

// 自由形式の題の、接頭辞と番号を除いた部分。本文の 1 行目の先頭 50 字で、空白を 1 つにまとめたもの
function freeformTitle(body: string): string {
  const [firstLine = ''] = pythonStrip(freeformMessage(body)).split(PYTHON_LINE_BREAK)
  return pythonStrip(truncateCodePoints(firstLine, FREEFORM_TITLE_LENGTH).replaceAll(PYTHON_WHITESPACE_RUN, ' '))
}

function templateProblems(target: Readonly<Target>, template: string, body: string, findings: Findings): void {
  const stem = template.slice(ISSUE_TEMPLATE_PREFIX.length)
  const templateKind = template.startsWith(ISSUE_TEMPLATE_PREFIX) ? ISSUE_TEMPLATES.get(stem) : undefined
  if (templateKind === undefined) {
    findings.add(target, 'template', 'unknown-template', `${template} is not a bundled Issue template; use one of the candidates, or the path or URL of a replaced template`, Array.from(ISSUE_TEMPLATES.keys(), name => `${ISSUE_TEMPLATE_PREFIX}${name}`))
    return
  }
  if (templateKind !== target.args.kind) findings.add(target, 'kind', 'value', `${template} is a template for kind ${templateKind}`, [templateKind])
  if (stripLeadingHtmlComment(body) !== body) findings.add(target, 'body', 'guide-comment', 'remove the guide comment of the template from the start of the body')
  const required = readTemplateSections(templateFile('issue', stem))
  const violations = templateViolations(body.replaceAll(PLACEHOLDER_PATTERN, '#1'), { stem, required })
  for (const violation of violations) {
    findings.add(target, 'body', violation.code, violationMessage(violation, template, stem))
  }
}

function bodyProblems(method: CheckInput['method'], target: Readonly<Target>, earlierKeys: ReadonlySet<string>, findings: Findings): void {
  const { body } = target
  const template = given(target.args.template)
  if (body === undefined || pythonStrip(body) === '') {
    if (method === 'create') findings.add(target, 'body', 'required', 'create needs body')
    return
  }
  if (stripFrontmatter(body) !== body) findings.add(target, 'body', 'frontmatter', 'the body still has the frontmatter of the template: pass its keys as arguments and leave them out of body')
  for (const [, key] of body.matchAll(PLACEHOLDER_PATTERN)) {
    if (key !== undefined && method === 'create' && earlierKeys.has(key)) continue
    const where = method === 'create' ? 'does not point to an earlier Issue of the batch (forward reference or unknown key); put the Issue it points to earlier' : 'is only for a batch create; write the Issue number'
    findings.add(target, 'body', 'placeholder', `{{issue:${String(key)}}} ${where}`)
  }
  if (template === undefined) {
    if (method === 'create' && !pythonRightStrip(body).endsWith(FREEFORM_FOOTER)) findings.add(target, 'body', 'freeform-footer', `a body without template ends with this line: ${FREEFORM_FOOTER}`, [`${pythonRightStrip(body)}\n\n${FREEFORM_FOOTER}`])
    return
  }
  if (template.startsWith(BUNDLED_PREFIX)) templateProblems(target, template, body, findings)
}

// --- 題と番号 ---

interface OrderPlan {
  /**
  Issue の順の、決まった番号。親の無い Issue は undefined
  */
  readonly orders: ReadonlyMap<number, number>
}

function titleParts(target: Readonly<Target>): TitleParts | undefined {
  return target.title === undefined ? undefined : splitIssueTitle(target.args.kind, target.title)
}

function orderOf(target: Readonly<Target>): number | undefined {
  const parts = titleParts(target)
  return parts !== undefined && parts.parentEpic === target.parent?.number ? parts.order : undefined
}

function usedOrdersByParent(output: Readonly<Output>, reads: Readonly<RawReads>, findings: Findings): ReadonlyMap<string, ReturnType<typeof usedOrdersOf>> {
  const used = new Map<string, ReturnType<typeof usedOrdersOf>>()
  const entries = reads.sub_issues ?? []
  for (const [index, entry] of entries.entries()) {
    let parent: IssueReference
    try {
      parent = parseIssueReference(entry.parent)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      findings.add(undefined, `reads.sub_issues[${String(index)}].parent`, 'value', `${entry.parent} is not owner/repo/N`)
      continue
    }
    const read = parseOfficial(output, 'issue_read', ISSUE_READ_SUB_ISSUES, entry.result, `reads.sub_issues[${String(index)}].result`)
    used.set(issueReferenceKey(parent), usedOrdersOf(subIssueTitlesOf(read), parent.number))
  }
  return used
}

// 親ごとに、兄弟の題と一括の中の番号から、重なりを見て、番号の無い Issue に振る番号を決める
function planTitleOrders(targets: readonly Target[], used: ReadonlyMap<string, ReturnType<typeof usedOrdersOf>>, findings: Findings): OrderPlan {
  const groups = new Map<string, { readonly parent: IssueReference, readonly members: Target[] }>()
  for (const target of targets) {
    if (target.parent === undefined) continue
    const key = issueReferenceKey(target.parent)
    const group = groups.get(key) ?? { parent: target.parent, members: [] }
    group.members.push(target)
    groups.set(key, group)
  }
  const orders = new Map<number, number>()
  for (const [key, { parent, members }] of groups) {
    const requests = members.map((target): OrderRequest => ({ file: target.name, order: orderOf(target) }))
    const duplicate = findBatchDuplicate(requests)
    if (duplicate !== undefined) {
      findings.add(undefined, 'title', 'order-conflict', `order ${String(duplicate.order)} under ${issueText(parent)} is given to more than one Issue: ${duplicate.files.join(', ')}`)
      continue
    }
    const siblings = used.get(key)
    if (siblings === undefined) {
      findings.push(unreadProblem('reads.sub_issues', `read the sub-issues of ${issueText(parent)} with issue_read (method get_sub_issues) and add it to reads.sub_issues with parent ${issueText(parent)}: the order in the title must not be used by a sibling`))
    }
    const plan = planOrders(siblings, requests)
    if (plan.kind === 'duplicate-existing') {
      const member = members.find(target => orderOf(target) === plan.order)
      const rest = member === undefined ? undefined : titleParts(member)?.rest
      const fixed = member === undefined || rest === undefined ? [] : [expectedTitle(member, rest, plan.nextAvailable)]
      findings.add(member, 'title', 'order-conflict', `order ${String(plan.order)} under ${issueText(parent)} is used by #${String(plan.existing.number)} (${plan.existing.title}); the next free order is ${String(plan.nextAvailable)}`, fixed)
      continue
    }
    if (plan.kind !== 'planned') continue
    for (const [position, order] of plan.orders.entries()) {
      const member = members.at(position)
      if (member !== undefined) orders.set(member.index, order)
    }
  }
  return { orders }
}

function expectedTitle(target: Readonly<Target>, rest: string, order: number | undefined): string {
  return buildIssueTitle(target.args.kind, rest, { parentEpic: target.parent?.number, order: target.parent === undefined ? undefined : order })
}

function createTitleProblems(target: Readonly<Target>, plan: Readonly<OrderPlan>, findings: Findings): void {
  const order = plan.orders.get(target.index)
  const freeform = given(target.args.template) === undefined && target.body !== undefined ? freeformTitle(target.body) : undefined
  const parts = titleParts(target)
  if (parts === undefined) {
    findings.add(target, 'title', 'required', 'create needs title', freeform === undefined ? [] : [expectedTitle(target, freeform, order)])
    return
  }
  const rest = freeform ?? parts.rest
  const expected = expectedTitle(target, rest, order)
  if (titlePrefixOf(target.args.kind) !== '' && !parts.hasPrefix) {
    findings.add(target, 'title', 'title-prefix', `the title of kind ${target.args.kind} starts with ${titlePrefixOf(target.args.kind)}`, [expected])
  }
  if (target.parent === undefined) {
    if (parts.order !== undefined) findings.add(target, 'title', 'title-order', `${parts.orderText.trim()} needs a parent Epic: give parent_owner, parent_repo and parent_issue_number, or remove it from the title`)
  }
  else if (parts.parentEpic !== target.parent.number || parts.order === undefined) {
    findings.add(target, 'title', 'title-order', `the title of a sub-issue of ${issueText(target.parent)} starts with #${String(target.parent.number)}-<order>: after the prefix`, order === undefined ? [] : [expected])
  }
  if (freeform !== undefined && parts.rest !== freeform) {
    findings.add(target, 'title', 'freeform-title', 'without template, the title is the first line of the body (up to 50 characters, spaces joined into one)', [expected])
  }
}

function updateTitleProblems(target: Readonly<Target>, reads: ParsedReads, findings: Findings): void {
  const parts = titleParts(target)
  if (parts === undefined || target.home === undefined || target.args.issue_number === undefined) return
  const reference = createIssueReference(target.home, target.args.issue_number)
  if (titlePrefixOf(target.args.kind) !== '' && !parts.hasPrefix) {
    findings.add(target, 'title', 'title-prefix', `the title of kind ${target.args.kind} starts with ${titlePrefixOf(target.args.kind)}`, [buildIssueTitle(target.args.kind, `${parts.orderText}${parts.rest}`)])
  }
  const current = reads.issues.get(issueReferenceKey(reference))
  if (current === undefined) {
    findings.push(unreadProblem('reads.issues', `read ${issueText(reference)} with issue_read (method get): the order in the title must stay`), target)
    return
  }
  const before = splitIssueTitle(target.args.kind, current.title)
  if (before.orderText !== parts.orderText) {
    findings.add(target, 'title', 'title-order', `keep the order of the title: ${before.orderText.trim() === '' ? '(none)' : before.orderText.trim()}`, [buildIssueTitle(target.args.kind, `${before.orderText}${parts.rest}`)])
  }
}

// --- ボードの欄と機能の値 ---

interface ProjectEntry {
  readonly field: ReadProjectField | undefined
  readonly label: string
  readonly value: string | number | null
}

function projectEntries(target: Readonly<Target>, board: BoardShape | undefined, findings: Findings): readonly ProjectEntry[] {
  return (target.args.project_fields ?? []).flatMap((entry, index): ProjectEntry[] => {
    const name = given(entry.name)
    const byId = entry.id === undefined ? undefined : board?.fields.find(field => field.id === String(entry.id))
    const field = byId ?? (name === undefined ? undefined : board?.fields.find(field => field.name.toLowerCase() === name.toLowerCase()))
    if (name === undefined && entry.id === undefined) {
      findings.add(target, `project_fields[${String(index)}]`, 'required', 'give the name or id of the board field')
      return []
    }
    if (board !== undefined && field === undefined && name === undefined) {
      findings.add(target, `project_fields[${String(index)}]`, 'unknown-field', `the board has no field with id ${String(entry.id)}`, board.fields.map(candidate => candidate.name))
      return []
    }
    // 単一選択の値は、選択肢の ID でも名前でも書ける。照らすときは名前にそろえる
    const option = typeof entry.value === 'string' ? field?.options.find(candidate => candidate.id === entry.value) : undefined
    return [{ field, label: field?.name ?? name ?? String(entry.id), value: option?.name ?? entry.value }]
  })
}

function isField(field: ReadProjectField | undefined, other: ReadProjectField | undefined): boolean {
  return field !== undefined && field.id === other?.id
}

function attributeProblems(output: Readonly<Output>, target: Readonly<Target>, entries: readonly ProjectEntry[], context: Readonly<AttributeContext>, findings: Findings): void {
  const { board, reads, config } = context
  const inputs: AttributeInput[] = []
  const definitions: AttributeDefinition[] = []
  const issueFields = target.args.issue_fields ?? []
  if (issueFields.length > 0) {
    if (reads.issue_fields === undefined) {
      findings.push(unreadProblem('reads.issue_fields', 'read the Issue fields with list_issue_fields to check issue_fields'), target)
    }
    else {
      definitions.push(...issueFieldDefinitionsOf(parseOfficial(output, 'list_issue_fields', LIST_ISSUE_FIELDS, reads.issue_fields, 'reads.issue_fields')))
      for (const field of issueFields) {
        const value = field.delete === true ? JSON_NULL : field.value ?? field.field_option_name
        if (value === undefined) findings.add(target, `issue_fields.${field.field_name}`, 'required', 'give value, field_option_name or delete')
        else inputs.push({ name: field.field_name, value, source: 'issue_field' })
      }
    }
  }
  const attributes = entries.filter(entry => !isField(entry.field, board?.workflow) && !isField(entry.field, board?.status))
  if (board !== undefined && attributes.length > 0) {
    definitions.push(...projectDefinitionsOf(board.fields, config === undefined ? board.workflow?.nodeId ?? '' : workflowFieldId(config)))
    for (const entry of attributes) inputs.push({ name: entry.label, value: entry.value, source: 'project' })
  }
  if (inputs.length === 0) return
  const validation = validateAttributes(definitions, inputs, { unreadableSources: new Map(), unassignableLogins: new Set(), current: undefined, isOnBoard: true })
  if (validation.ok) return
  for (const error of validation.errors) {
    const prefix = error.source === 'issue_field' ? 'issue_fields' : 'project_fields'
    const options = error.code === 'invalid_value' ? definitions.find(definition => definition.name === error.name && definition.source === error.source)?.options : undefined
    findings.add(target, `${prefix}.${error.name}`, error.code, attributeErrorLine(error), error.candidates ?? options?.map(option => option.name))
  }
}

interface AttributeContext {
  readonly board: BoardShape | undefined
  readonly reads: Readonly<RawReads>
  readonly parsed: ParsedReads
  readonly config: ProjectConfig | undefined
}

// pecot-lane を書いていない子は、親 Epic のカードの値にそろえる
function laneProblems(target: Readonly<Target>, entries: readonly ProjectEntry[], context: Readonly<AttributeContext>, findings: Findings): void {
  const { board, parsed } = context
  const { parent } = target
  if (parent === undefined || board === undefined || target.args.kind === 'epic') return
  const laneField = board.fields.find(field => field.name.toLowerCase() === LANE_FIELD_NAME)
  if (laneField === undefined || entries.some(entry => isField(entry.field, laneField))) return
  if (parsed.cards === undefined) {
    findings.push(unreadProblem('reads.project_items', `read the card of the parent ${issueText(parent)} with projects_list (method list_project_items): ${LANE_FIELD_NAME} follows the parent when omitted`), target)
    return
  }
  const lane = parsed.cards.get(issueReferenceKey(parent))?.fields.get(LANE_FIELD_NAME)
  if (lane !== undefined) findings.add(target, `project_fields.${LANE_FIELD_NAME}`, 'lane', `write ${LANE_FIELD_NAME} ${lane}, the value of the parent ${issueText(parent)} (or another lane on purpose)`, [lane])
}

// --- 置く列 ---

interface Batch {
  readonly prerequisites: readonly (readonly ResolvedPrerequisite[])[]
  readonly progressions: ReadonlyMap<string, Progression>
}

function placeholderReference(home: RepositoryReference, index: number): IssueReference {
  return createIssueReference(home, PLACEHOLDER_NUMBER_BASE + index)
}

// 起票の時に置く列の表示名。前提がすべて既存の Issue なら、済んだかで Ready にする
function expectedColumns(target: Readonly<Target>, prerequisites: readonly ResolvedPrerequisite[], context: Readonly<AttributeContext>, board: BoardShape, findings: Findings): readonly string[] | undefined {
  const name = (key: string, fallback: string): string => board.column(key) ?? fallback
  if (target.args.kind === 'epic' || target.args.kind === 'tracker') return [name('backlog', 'Backlog')]
  if (prerequisites.length === 0) return [name('ready', 'Ready')]
  const blocked = board.column('blocked')
  if (blocked === undefined) {
    findings.warn(target, 'the board has no Blocked column; an Issue with blocked-by is placed in Ready')
    return [name('ready', 'Ready')]
  }
  if (prerequisites.some(({ target: prerequisite }) => prerequisite.kind === 'file') || target.home === undefined) return [blocked]
  const facts: Prerequisite[] = []
  for (const prerequisite of prerequisites) {
    if (prerequisite.target.kind !== 'existing') continue
    const { reference } = prerequisite.target
    const issue = context.parsed.issues.has(issueReferenceKey(reference)) ? prerequisiteFacts(reference, undefined, context.parsed, board) : undefined
    if (issue === undefined) {
      findings.push(unreadProblem('reads.issues', `read ${issueText(reference)} with issue_read (method get): the column depends on whether the prerequisites are done`), target)
      return undefined
    }
    facts.push({ issue, wait: prerequisite.wait, reason: prerequisite.reason })
  }
  const self = issueFactsOf({ ref: placeholderReference(target.home, target.index), title: '', state: 'open', body: '', pullRequests: [] }, undefined, columnNames(board))
  const judged = judgeMove({
    target: { ...self, column: blocked },
    prerequisites: facts,
    hasPrerequisites: true,
    board,
    pullRequests: context.parsed.pullRequests,
    developmentBranch: developmentBranchOf(context.config, target.home),
  })
  if (judged.stackUndecided !== undefined) {
    findings.warn(target, `whether the Issue can stack on its prerequisites is not decided: ${stackUndecidedHint(judged.stackUndecided)}; Ready and Blocked are both accepted`)
    return [name('ready', 'Ready'), blocked]
  }
  return [judged.move?.column?.to === 'Ready' ? name('ready', 'Ready') : blocked]
}

interface WrittenColumn {
  readonly workflow: ReadProjectField
  readonly entry: ProjectEntry | undefined
}

// Status と、update の列を書いていないかを見る。create で列を確かめられるなら、列の欄と書いた値を返す
function writtenColumn(method: CheckInput['method'], target: Readonly<Target>, entries: readonly ProjectEntry[], board: BoardShape | undefined, findings: Findings): WrittenColumn | undefined {
  if (board === undefined) return undefined
  for (const entry of entries) {
    if (isField(entry.field, board.status)) findings.add(target, `project_fields.${entry.label}`, 'status-field', `${STATUS_FIELD_NAME} is written by the pecot automation; leave it out`)
  }
  const { workflow } = board
  const written = workflow === undefined ? [] : entries.filter(entry => isField(entry.field, workflow))
  if (method === 'update') {
    for (const entry of written) findings.add(target, `project_fields.${entry.label}`, 'column', 'the column is not changed with update; it moves by the pecot rules (the readiness of the prerequisites and the pull request)')
    return undefined
  }
  if (workflow === undefined) {
    findings.add(target, 'reads.project_fields', 'board', 'the board has no column field (pecot-status) of the project config; run project_init or check the project')
    return undefined
  }
  return { workflow, entry: written.at(0) }
}

function columnValueProblems(target: Readonly<Target>, column: Readonly<WrittenColumn>, names: readonly string[], findings: Findings): void {
  const { workflow, entry } = column
  const field = `project_fields.${workflow.name}`
  if (entry === undefined) {
    findings.add(target, field, 'required', `write the column ${workflow.name}: ${names.join(' or ')}`, names)
    return
  }
  const { value } = entry
  if (typeof value !== 'string' || names.every(name => name.toLowerCase() !== value.toLowerCase())) findings.add(target, field, 'column', `the column at creation is ${names.join(' or ')} (given: ${String(value)})`, names)
}

// --- 前提 ---

function displayOf(prerequisite: Readonly<ResolvedPrerequisite>, home: RepositoryReference): string {
  return prerequisite.target.kind === 'file' ? prerequisite.key : displayReference(prerequisite.target.reference, home)
}

function blockedByUsage(target: Readonly<Target>, findings: Findings): void {
  const entries = target.args.blocked_by ?? []
  if (entries.length === 0) return
  if (target.args.kind === 'epic' || target.args.kind === 'tracker') findings.add(target, 'blocked_by', 'unexpected', `an Issue of kind ${target.args.kind} has no prerequisites`)
  if (entries.length > MAX_BLOCKED_BY) findings.add(target, 'blocked_by', 'limit', `an Issue takes up to ${String(MAX_BLOCKED_BY)} blocked-by Issues`)
  for (const [index, entry] of entries.entries()) {
    const reason = entry.reason?.trim()
    if (entry.wait === 'merge' && (reason === undefined || reason === '')) findings.add(target, `blocked_by[${String(index)}].reason`, 'required', 'wait merge needs reason: why it waits for the merge, in one line')
    if (entry.wait === 'stack' && entry.reason !== undefined) findings.add(target, `blocked_by[${String(index)}].reason`, 'unexpected', 'reason is only for wait merge; a stack prerequisite has no reason')
    if (reason !== undefined && /[\r\n]/u.test(reason)) findings.add(target, `blocked_by[${String(index)}].reason`, 'value', 'reason must be a single line')
  }
}

// 本文の Waits for merge の節が、wait merge の前提と理由を挙げているか。一括の key は {{issue:key}} で書く
function waitsForMergeProblems(target: Readonly<Target>, prerequisites: readonly ResolvedPrerequisite[], keyIndexes: ReadonlyMap<string, number>, findings: Findings): void {
  const { home, body } = target
  if (home === undefined || body === undefined) return
  const localBody = body.replaceAll(PLACEHOLDER_PATTERN, (whole: string, key: string) => {
    const index = keyIndexes.get(key)
    return index === undefined ? whole : `#${String(PLACEHOLDER_NUMBER_BASE + index)}`
  })
  const section = readWaitsForMerge(localBody, home)
  if (section.kind === 'malformed') {
    malformedSectionProblem(target, section.reason, findings)
    return
  }
  const lines = section.kind === 'ok' ? section.lines : []
  const referenceOfPrerequisite = (prerequisite: Readonly<ResolvedPrerequisite>): IssueReference => prerequisite.target.kind === 'existing' ? prerequisite.target.reference : placeholderReference(home, prerequisite.target.index)
  const written = (prerequisite: Readonly<ResolvedPrerequisite>): string => prerequisite.target.kind === 'file' ? `{{issue:${prerequisite.key}}}` : displayReference(prerequisite.target.reference, home)
  const merges = prerequisites.filter(prerequisite => prerequisite.wait === 'merge')
  for (const prerequisite of merges) {
    const key = issueReferenceKey(referenceOfPrerequisite(prerequisite))
    const line = lines.find(candidate => issueReferenceKey(candidate.ref) === key)
    const reason = prerequisite.reason?.trim() ?? ''
    if (line === undefined) findings.add(target, 'body', 'waits-for-merge', `add the line of ${displayOf(prerequisite, home)} to the ${WAITS_FOR_MERGE_HEADING} section at the end of the body`, [`- ${written(prerequisite)}: ${reason}`])
    else if (line.reason !== reason) findings.add(target, 'body', 'waits-for-merge', `the reason of ${displayOf(prerequisite, home)} in the ${WAITS_FOR_MERGE_HEADING} section differs from blocked_by`, [`- ${written(prerequisite)}: ${reason}`])
  }
  const mergeKeys = new Set(merges.map(prerequisite => issueReferenceKey(referenceOfPrerequisite(prerequisite))))
  for (const line of lines) {
    if (mergeKeys.has(issueReferenceKey(line.ref))) continue
    const index = line.ref.number - PLACEHOLDER_NUMBER_BASE
    const shown = index >= 0 && isSameHome(line.ref, home) ? [...keyIndexes].find(([, value]) => value === index)?.[0] ?? displayReference(line.ref, home) : displayReference(line.ref, home)
    findings.add(target, 'body', 'waits-for-merge', `remove the line of ${shown} from the ${WAITS_FOR_MERGE_HEADING} section: it is not a wait merge prerequisite in blocked_by`)
  }
}

function malformedSectionProblem(target: Readonly<Target>, reason: string, findings: Findings): void {
  findings.add(target, 'body', 'waits-for-merge', `the ${WAITS_FOR_MERGE_HEADING} section is malformed: ${reason}; write one line per prerequisite as "- #N: <reason>"`)
}

function updateWaitsForMergeProblems(target: Readonly<Target>, findings: Findings): void {
  const { home, body } = target
  if (home === undefined || body === undefined) return
  const section = readWaitsForMerge(body, home)
  if (section.kind === 'malformed') malformedSectionProblem(target, section.reason, findings)
}

function isSameHome(reference: IssueReference, home: RepositoryReference): boolean {
  return reference.repository.owner.toLowerCase() === home.owner.toLowerCase() && reference.repository.repository.toLowerCase() === home.repository.toLowerCase()
}

function resolveTargets(targets: readonly Target[], findings: Findings): Batch | undefined {
  const keyed = new Map<string, Target>()
  for (const target of targets) {
    const key = given(target.args.key)
    if (key === undefined) continue
    if (keyed.has(key)) findings.add(target, 'key', 'duplicate-key', `key ${key} is given to more than one Issue`)
    keyed.set(key, target)
  }
  const files = targets.map((target): BatchFile => {
    const key = given(target.args.key)
    return {
      name: target.name,
      key: target.name,
      keys: key === undefined ? [] : [key],
      blockedBy: (target.args.blocked_by ?? []).map(({ issue, wait, reason }) => ({ issue, wait, reason: reason?.trim() })),
    }
  })
  const resolution = resolveBatch(files)
  if (resolution.kind === 'error') {
    findings.add(undefined, 'blocked_by', 'blocked-by', resolution.message)
    return undefined
  }
  return { prerequisites: resolution.prerequisites, progressions: resolution.progressions }
}

// --- 出力 ---

function planRows(targets: readonly Target[], batch: Readonly<Batch>, plan: Readonly<OrderPlan>): readonly PlanRow[] {
  return targets.map((target): PlanRow => ({
    file: target.name,
    order: plan.orders.get(target.index),
    prerequisites: batch.prerequisites.at(target.index) ?? [],
    progression: batch.progressions.get(target.name),
  }))
}

function planData(rows: readonly PlanRow[], home: RepositoryReference): NonNullable<CheckOutput['plan']> {
  return rows.map((row) => {
    const { progression } = row
    const stackOn = progression?.kind === 'stack' ? row.prerequisites.find(({ key }) => key === progression.on) : undefined
    return {
      key: row.file,
      ...row.order !== undefined && { order: row.order },
      blockedBy: row.prerequisites.map(prerequisite => ({ issue: displayOf(prerequisite, home), wait: prerequisite.wait })),
      approach: progression?.kind ?? 'alone',
      ...progression?.kind === 'stack' && { stackOn: stackOn === undefined ? progression.on : displayOf(stackOn, home) },
    }
  })
}

function chainLabels(batch: Readonly<Batch>, home: RepositoryReference): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const list of batch.prerequisites) {
    for (const prerequisite of list) {
      if (prerequisite.target.kind === 'existing') labels.set(prerequisite.key, displayOf(prerequisite, home))
    }
  }
  return labels
}

interface RawReads {
  readonly issues?: readonly unknown[] | undefined
  readonly sub_issues?: readonly { readonly parent: string, readonly result: unknown }[] | undefined
  readonly project_items?: readonly unknown[] | undefined
  readonly project_fields?: unknown
  readonly issue_fields?: unknown
  readonly issue_types?: unknown
  readonly collaborators?: unknown
}

interface Checked {
  readonly findings: Findings
  readonly plan?: CheckOutput['plan']
  readonly stackableChains?: CheckOutput['stackableChains']
}

function checkIssues(output: Readonly<Output>, input: Readonly<CheckInput>): Checked {
  const findings = new Findings()
  const reads: RawReads = input.reads ?? {}
  if (input.method === 'update' && input.issues.length !== 1) findings.add(undefined, 'issues', 'update-one', 'update checks one Issue at a time')
  const targets = targetsOf(input, findings)
  const config = chooseConfig(targets, input, findings)
  const parsed = parseReads(output, reads, config)
  const { board } = parsed
  const context: AttributeContext = { board, reads, parsed, config }
  if (board === undefined && (input.method === 'create' || targets.some(target => (target.args.project_fields ?? []).length > 0))) {
    findings.push(unreadProblem('reads.project_fields', 'read the board fields with projects_list (method list_project_fields): the check needs the columns and fields of the board'))
  }

  const earlierKeys = new Set<string>()
  for (const target of targets) {
    usageProblems(input, target, findings)
    bodyProblems(input.method, target, earlierKeys, findings)
    builtinProblems(target, reads, output, findings)
    const key = given(target.args.key)
    if (key !== undefined) earlierKeys.add(key)
  }

  if (input.method === 'update') {
    const [target] = targets
    if (target !== undefined) {
      updateTitleProblems(target, parsed, findings)
      updateWaitsForMergeProblems(target, findings)
      const entries = projectEntries(target, board, findings)
      writtenColumn('update', target, entries, board, findings)
      attributeProblems(output, target, entries, context, findings)
    }
    return { findings }
  }

  const orders = planTitleOrders(targets, usedOrdersByParent(output, reads, findings), findings)
  for (const target of targets) blockedByUsage(target, findings)
  const batch = resolveTargets(targets, findings)
  const keyIndexes = new Map(targets.flatMap((target): [string, number][] => given(target.args.key) === undefined ? [] : [[target.name, target.index]]))
  for (const target of targets) {
    createTitleProblems(target, orders, findings)
    const entries = projectEntries(target, board, findings)
    const prerequisites = batch?.prerequisites.at(target.index)
    if (prerequisites !== undefined) waitsForMergeProblems(target, prerequisites, keyIndexes, findings)
    const column = writtenColumn('create', target, entries, board, findings)
    const names = column === undefined || board === undefined || prerequisites === undefined ? undefined : expectedColumns(target, prerequisites, context, board, findings)
    if (column !== undefined && names !== undefined) columnValueProblems(target, column, names, findings)
    attributeProblems(output, target, entries, context, findings)
    laneProblems(target, entries, context, findings)
  }
  const home = targets.find(target => target.home !== undefined)?.home
  if (batch === undefined || home === undefined) return { findings }
  const rows = planRows(targets, batch, orders)
  const labels = chainLabels(batch, home)
  const chains = stackChains(batch.progressions).filter(chain => chain.length >= 2).map(chain => chain.map(key => labels.get(key) ?? key))
  return {
    findings,
    plan: planData(rows, home),
    ...chains.length > 0 && { stackableChains: chains },
  }
}

const ISSUE_CHECK = defineTool({
  name: 'issue_check',
  title: 'Check Issue',
  description: 'Check the arguments for issue_write (and the board fields and blocked-by written after it) against the pecot rules before writing: the template of the body, the title prefix and order, the type, the Issue and board fields, the column to place the Issue in, and the prerequisites. A batch create gives the order numbers and how each Issue proceeds. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  openWorld: false,
  input: ISSUE_CHECK_INPUT,
  output: ISSUE_CHECK_OUTPUT,
  run: (input, io) => {
    const output = createOutput<CheckOutput>(false, io)
    const checked = checkIssues(output, input)
    const { problems, warnings } = checked.findings
    for (const warning of warnings) output.warning(warning)
    output.result({
      problems,
      ...checked.plan !== undefined && { plan: checked.plan },
      ...checked.stackableChains !== undefined && { stackableChains: checked.stackableChains },
    })
    const lines = problems.length === 0 ? ['ok'] : problems.map(problem => `${problem.issue === undefined ? '' : `${problem.issue}: `}${problem.field}: ${problem.message}`)
    output.data(lines.join('\n'))
    return Promise.resolve(0)
  },
})

export const ISSUE_CHECK_TOOLS: readonly ToolDefinition[] = [ISSUE_CHECK]
