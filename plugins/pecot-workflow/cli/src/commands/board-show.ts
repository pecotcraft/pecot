/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
// board_show。公式の MCP で読んだボードのカードを表にし、前提を読んだ Ready・Blocked の Issue に着手の判定を付ける。GitHub を読まず書かない
import { z } from 'zod'

import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { boardItemKey, formatBoardOutput } from '@pecot/workflow-core/domain/format.js'
import type { BoardItem } from '@pecot/workflow-core/domain/format.js'
import { JSON_NULL } from '@pecot/workflow-core/domain/json-null.js'
import { LANE_FIELD_NAME, summarizeLanes } from '@pecot/workflow-core/domain/lanes.js'
import type { LaneSummary } from '@pecot/workflow-core/domain/lanes.js'
import { describeReadiness, describeUnknown } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'
import { parseOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { BOARD_SYNC_WORKFLOW } from '@pecot/workflow-core/commands-shared/board-judgment.js'
import { BOARD_SHOW_OUTPUT as BOARD_VIEW_OUTPUT } from '@pecot/workflow-core/commands-shared/board-view.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { requireActiveConfig, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { readinessJson } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import type { BoardReadinessJson } from '@pecot/workflow-core/commands-shared/issue-readiness.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { developmentBranchOf, parseReads, READ_BLOCKED_BY, READ_ISSUES, READ_PULL_REQUESTS, stackUndecidedHint } from './check-reads.js'
import type { BoardShape, ParsedReads } from './check-reads.js'
import { cardsOfItems, itemFieldValue, PROJECT_ITEMS_PAGE } from './official-reads-board.js'
import type { ProjectItem } from './official-reads-board.js'
import { parseOfficial, referenceOf } from './official-reads.js'
import type { IssueDependencyRead, ReadIssue } from './official-reads.js'
import { dependencyReads, judgeFromReads } from './readiness-reads.js'

const DISPLAY_STATUSES: ReadonlySet<string> = new Set(['Backlog', 'Pending', 'Blocked', 'Ready', 'Active', 'In Review'])
const JUDGED_STATUSES: ReadonlySet<string> = new Set(['Ready', 'Blocked'])

const BOARD_SHOW_OUTPUT = BOARD_VIEW_OUTPUT.pick({ board: true, lanes: true, mismatches: true })

type BoardShowData = z.input<typeof BOARD_SHOW_OUTPUT>

const READ_ITEM_PAGES = z.array(z.unknown()).min(1).describe('Results of projects_list with method list_project_items, every page: pass the field IDs of pecot-status, Status and pecot-lane in fields')

const BOARD_SHOW_INPUT = z.strictObject({
  json: z.boolean().default(false).describe('Output as JSON'),
  repo: z.string().superRefine((value, context) => {
    try {
      parseOwnerRepository(value)
    }
    catch (error: unknown) {
      if (!(error instanceof InvalidValueError)) throw error
      context.addIssue({ code: 'custom', message: `must be in 'owner/repo' form: ${error.message}` })
    }
  }).optional().describe('Show only the items of this repository (owner/repo)'),
  reads: z.object({
    items: READ_ITEM_PAGES,
    fields: z.unknown().describe('Result of projects_list with method list_project_fields'),
    issues: READ_ISSUES.describe('Results of issue_read with method get (the structuredContent, { issue: ... }): the Ready and Blocked Issues to judge, and their prerequisites'),
    blocked_by: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocked_by: the Ready and Blocked Issues to judge; only these get a readiness'),
    pull_requests: READ_PULL_REQUESTS,
  }).describe('Results of the official GitHub MCP reads'),
})

type ShowInput = z.output<typeof BOARD_SHOW_INPUT>

function mismatchNote(count: number): string {
  const subject = count === 1 ? '1 Ready or Blocked Issue may be' : `${String(count)} Ready or Blocked Issues may be`
  return `${subject} in a column or Status that does not match its judgment; run ${BOARD_SYNC_WORKFLOW} to fix`
}

function laneFieldOf(board: BoardShape): string | undefined {
  return board.fields.find(field => field.dataType === 'SINGLE_SELECT' && field.name.toLowerCase() === LANE_FIELD_NAME)?.name
}

function boardItemOf(item: ProjectItem, board: BoardShape): BoardItem | undefined {
  const { content } = item
  if (content === null || content === undefined) return undefined
  const lane = laneFieldOf(board)
  return {
    id: item.id,
    workflow: (board.workflow === undefined ? undefined : itemFieldValue(item, board.workflow.name)) ?? JSON_NULL,
    lane: (lane === undefined ? undefined : itemFieldValue(item, lane)) ?? JSON_NULL,
    title: content.title ?? '',
    updatedAt: item.updated_at ?? '',
    content: {
      number: content.number ?? JSON_NULL,
      state: content.state?.toUpperCase() ?? JSON_NULL,
      url: content.html_url ?? JSON_NULL,
      labels: content.labels ?? [],
      repository: content.repository ?? '',
    },
  }
}

function isPullRequestItem(item: BoardItem): boolean {
  return typeof item.content.url === 'string' && item.content.url.includes('/pull/')
}

interface Judgments {
  readonly texts: ReadonlyMap<string, string>
  readonly json: ReadonlyMap<string, BoardReadinessJson>
  readonly mismatches: number
}

interface JudgeContext {
  readonly reads: ParsedReads
  readonly blockedBy: ReadonlyMap<string, IssueDependencyRead>
  readonly board: BoardShape
  readonly config: ProjectConfig
}

function unknownJson(text: string): BoardReadinessJson {
  return { kind: 'unknown', stackOn: JSON_NULL, reason: JSON_NULL, text }
}

// 前提を読んだ（reads.blocked_by に渡した）Ready・Blocked の Issue だけを判定する。列と札は動かさない
function judgeItems(items: readonly BoardItem[], context: Readonly<JudgeContext>): Judgments {
  const texts = new Map<string, string>()
  const json = new Map<string, BoardReadinessJson>()
  let mismatches = 0
  for (const item of items) {
    if (typeof item.workflow !== 'string' || !JUDGED_STATUSES.has(item.workflow) || isPullRequestItem(item)) continue
    const key = boardItemKey(item)
    const reference = typeof item.content.number === 'number' ? referenceOf(item.content.repository ?? '', item.content.number) : undefined
    if (key === undefined || reference === undefined || !context.blockedBy.has(issueReferenceKey(reference))) continue
    const fallback: ReadIssue = { ref: reference, title: typeof item.title === 'string' ? item.title : '', state: 'open', body: '', pullRequests: [] }
    const judgment = judgeFromReads({ ref: reference, reads: context.reads, blockedBy: context.blockedBy, board: context.board, developmentBranch: developmentBranchOf(context.config, reference.repository), fallback })
    if (judgment.kind === 'unread') {
      const text = describeUnknown(judgment.problems.map(problem => problem.message).join('; '))
      texts.set(key, text)
      json.set(key, unknownJson(text))
      continue
    }
    const { readiness, move, stackUndecided } = judgment.judged
    if (readiness === undefined) continue
    if (stackUndecided !== undefined) {
      const text = describeUnknown(stackUndecidedHint(stackUndecided))
      texts.set(key, text)
      json.set(key, unknownJson(text))
      continue
    }
    const text = describeReadiness(readiness, judgment.prerequisites, reference.repository)
    texts.set(key, text)
    json.set(key, readinessJson(readiness, text))
    if (move?.column !== undefined || move?.label !== undefined) mismatches += 1
  }
  return { texts, json, mismatches }
}

function lanesSection(lanes: readonly LaneSummary[]): readonly string[] {
  if (lanes.length === 0) return []
  const rows = lanes.map(lane => `| ${lane.name ?? '(none)'} | ${String(lane.count)} | ${String(lane.startable)} |`)
  return ['', '## Lanes', '', '| Lane | Issues | Startable |', '|------|--------|-----------|', ...rows]
}

function readPages(output: Readonly<Output>, pages: readonly unknown[]): readonly ProjectItem[] {
  const parsed = pages.map((raw, index) => parseOfficial(output, 'projects_list', PROJECT_ITEMS_PAGE, raw, `reads.items[${String(index)}]`))
  if (parsed.at(-1)?.items.pageInfo?.hasNextPage === true) output.warning('the last page in reads.items has more pages: the board shows only the items read so far')
  return parsed.flatMap(page => page.items.items ?? [])
}

function show(output: Readonly<Output<BoardShowData>>, input: Readonly<ShowInput>): void {
  const config = requireActiveConfig(output)
  const projectItems = readPages(output, input.reads.items)
  const parsed = parseReads(output, { issues: input.reads.issues, project_fields: input.reads.fields, pull_requests: input.reads.pull_requests }, config)
  const reads: ParsedReads = { ...parsed, cards: cardsOfItems(projectItems) }
  const { board } = parsed
  if (board === undefined) return stopWith(output, 'reads.fields is required: read the board fields with projects_list (method list_project_fields)', 'invalid-input', USAGE_EXIT_CODE)
  if (board.workflow === undefined) output.warning('the board has no pecot-status field: the items have no column')
  const all = projectItems.flatMap(item => boardItemOf(item, board) ?? [])
  const open = all.filter(item => item.content.state === 'OPEN' && typeof item.workflow === 'string' && DISPLAY_STATUSES.has(item.workflow))
  const items = input.repo === undefined ? open : open.filter(item => item.content.repository === input.repo)
  const dependencies = dependencyReads(output, input.reads.blocked_by ?? [])
  for (const problem of dependencies.problems) output.warning(`${problem.field}: ${problem.message}`)
  const judgments = judgeItems(items, { reads, blockedBy: dependencies.reads, board, config })
  if (judgments.mismatches > 0) output.warning(mismatchNote(judgments.mismatches))
  const readinessOf = (item: BoardItem): BoardReadinessJson | typeof JSON_NULL => {
    const key = boardItemKey(item)
    return (key === undefined ? undefined : judgments.json.get(key)) ?? JSON_NULL
  }
  const laneField = laneFieldOf(board)
  const laneOptions = laneField === undefined ? undefined : board.fields.find(field => field.name === laneField)?.options.map(option => option.name)
  const lanes = [...summarizeLanes(laneOptions, items.filter(item => !isPullRequestItem(item)).map(item => ({
    lane: item.lane ?? JSON_NULL,
    isStartable: item.workflow === 'Ready' && readinessOf(item)?.kind === 'startable',
  })))]
  const data = {
    board: { items: items.map(item => ({ ...item, content: { ...item.content, labels: [...item.content.labels ?? []] }, readiness: readinessOf(item) })) },
    lanes,
  }
  output.result({ ...data, mismatches: judgments.mismatches })
  const heading = input.repo === undefined ? '## Board status' : `## Board status (filter: ${input.repo})`
  output.data(input.json ? JSON.stringify(data, undefined, 2) : [heading, '', formatBoardOutput(items, judgments.texts), ...lanesSection(lanes)].join('\n'))
}

const boardShowCommand = defineTool({
  name: 'board_show',
  title: 'Show board dashboard',
  description: 'Show the open items of the project board by column, the readiness of the Ready and Blocked Issues whose prerequisites were read, and the Issues per pecot-lane value. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  input: BOARD_SHOW_INPUT,
  hasOwnRepo: true,
  openWorld: false,
  output: BOARD_SHOW_OUTPUT,
  run: (input, io) => {
    show(createOutput<BoardShowData>(false, io), input)
    return Promise.resolve(0)
  },
})

export const BOARD_SHOW_TOOLS: readonly ToolDefinition[] = [boardShowCommand]
