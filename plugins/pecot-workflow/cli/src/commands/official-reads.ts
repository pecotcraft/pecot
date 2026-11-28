// 公式の GitHub MCP（github-mcp-server v2.3.0）の読み取りの結果の形と、domain の型への写し。
// 使う項目だけを確かめ、ほかは捨てる。形が違えば github-mcp-shape の失敗で止める。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod が推論する結果の型は readonly にできない */
import { z } from 'zod'

import type { AttributeDefinition, AttributeOption } from '@pecot/workflow-core/domain/attributes.js'
import { issueFieldDefinition, projectFieldDefinition } from '@pecot/workflow-core/domain/attributes.js'
import { ValidationFailure } from '@pecot/workflow-core/domain/python-format.js'
import type { IssueFacts, IssuePullRequest, IssueWorkKind } from '@pecot/workflow-core/domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'

// --- issue_read（get_comments）---

const COMMENT = z.looseObject({
  id: z.number().int(),
  html_url: z.string(),
  body: z.string().optional(),
  user: z.looseObject({ login: z.string() }).nullable().optional(),
})

/**
issue_read（method: get_comments）の structuredContent
*/
export const ISSUE_READ_COMMENTS = z.looseObject({
  comments: z.array(COMMENT).nullable().optional(),
})

// --- issue_read（get）---

const CLOSING_PULL_REQUEST = z.looseObject({
  number: z.number().int(),
  state: z.string(),
  url: z.string(),
  repository: z.string().optional(),
})

const ISSUE = z.looseObject({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  body: z.string().optional(),
  html_url: z.string(),
  closed_by_pull_requests: z.looseObject({
    references: z.array(CLOSING_PULL_REQUEST).nullable().optional(),
  }).nullable().optional(),
})

/**
issue_read（method: get）の structuredContent
*/
export const ISSUE_READ_GET = z.looseObject({ issue: ISSUE })

export type IssueReadGet = z.infer<typeof ISSUE_READ_GET>

// --- pull_request_read（get）---

const BRANCH = z.looseObject({
  ref: z.string(),
  sha: z.string().optional(),
  repo: z.looseObject({ full_name: z.string() }).nullable().optional(),
})

/**
pull_request_read（method: get）の structuredContent
*/
export const PULL_REQUEST_READ_GET = z.looseObject({
  number: z.number().int(),
  title: z.string().optional(),
  body: z.string().optional(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable_state: z.string().optional(),
  html_url: z.string(),
  head: BRANCH,
  base: BRANCH,
})

// --- list_pull_requests ---

/**
list_pull_requests の structuredContent の 1 件。fields で絞ると項目が欠けるので、number と html_url のほかは省略できる
*/
const LISTED_PULL_REQUEST = z.looseObject({
  number: z.number().int(),
  title: z.string().optional(),
  body: z.string().optional(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  html_url: z.string(),
  head: BRANCH.optional(),
  base: BRANCH.optional(),
})

/**
list_pull_requests の structuredContent。公式のサーバは配列（か null）を返す
*/
export const LIST_PULL_REQUESTS = z.array(LISTED_PULL_REQUEST).nullable()

export type ListPullRequests = z.infer<typeof LIST_PULL_REQUESTS>

export type PullRequestReadGet = z.infer<typeof PULL_REQUEST_READ_GET>

// --- issue_read（get_sub_issues）---

const SUB_ISSUE = z.looseObject({
  number: z.number().int().nullable().optional(),
  title: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
}).nullable()

/**
issue_read（method: get_sub_issues）の structuredContent
*/
export const ISSUE_READ_SUB_ISSUES = z.looseObject({
  sub_issues: z.array(SUB_ISSUE).nullable().optional(),
})

export type IssueReadSubIssues = z.infer<typeof ISSUE_READ_SUB_ISSUES>

// --- issue_dependency_read（get_blocked_by）---

const DEPENDENCY = z.looseObject({
  number: z.number().int(),
  state: z.string(),
  html_url: z.string().optional(),
  repository: z.string().optional(),
})

/**
issue_dependency_read（method: get_blocked_by）の structuredContent
*/
export const ISSUE_DEPENDENCY_READ = z.looseObject({
  issues: z.array(DEPENDENCY).nullable().optional(),
  pageInfo: z.looseObject({ hasNextPage: z.boolean() }).optional(),
})

export type IssueDependencyRead = z.infer<typeof ISSUE_DEPENDENCY_READ>

// --- projects_list（list_project_items・list_project_fields）---

const ITEM_FIELD = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  value: z.unknown().optional(),
})

const PROJECT_ITEM = z.looseObject({
  content: z.looseObject({
    number: z.number().int(),
    repository: z.string(),
  }).nullable().optional(),
  fields: z.array(ITEM_FIELD).nullable().optional(),
})

/**
projects_list（method: list_project_items）の structuredContent
*/
export const PROJECTS_LIST_ITEMS = z.looseObject({
  items: z.looseObject({
    items: z.array(PROJECT_ITEM).nullable().optional(),
  }),
})

export type ProjectsListItems = z.infer<typeof PROJECTS_LIST_ITEMS>

const RAW_TEXT = z.looseObject({ raw: z.string() })

const PROJECT_FIELD_OPTION = z.looseObject({
  id: z.string(),
  name: RAW_TEXT,
})

const ITERATION = z.looseObject({
  id: z.string(),
  title: RAW_TEXT,
  start_date: z.string().optional(),
})

const ITERATION_CONFIGURATION = z.looseObject({
  iterations: z.array(ITERATION).nullable().optional(),
})

const PROJECT_FIELD = z.looseObject({
  id: z.number().int(),
  node_id: z.string().optional(),
  name: z.string(),
  data_type: z.string(),
  options: z.array(PROJECT_FIELD_OPTION).nullable().optional(),
  configuration: ITERATION_CONFIGURATION.nullable().optional(),
})

/**
projects_list（method: list_project_fields）の structuredContent
*/
export const PROJECTS_LIST_FIELDS = z.looseObject({
  fields: z.looseObject({
    fields: z.array(PROJECT_FIELD).nullable().optional(),
  }),
})

export type ProjectsListFields = z.infer<typeof PROJECTS_LIST_FIELDS>

// --- list_issue_fields・list_issue_types・list_repository_collaborators ---

const ISSUE_FIELD_OPTION = z.looseObject({ id: z.string().optional(), name: z.string() })

const ISSUE_FIELD = z.looseObject({
  id: z.string(),
  name: z.string(),
  data_type: z.string(),
  full_database_id: z.union([z.string(), z.number()]).optional(),
  options: z.array(ISSUE_FIELD_OPTION).nullable().optional(),
})

/**
list_issue_fields の structuredContent。公式のサーバは配列（か null）を返す
*/
export const LIST_ISSUE_FIELDS = z.array(ISSUE_FIELD).nullable()

export type ListIssueFields = z.infer<typeof LIST_ISSUE_FIELDS>

/**
list_issue_types の structuredContent。公式のサーバは配列（か null）を返す
*/
export const LIST_ISSUE_TYPES = z.array(z.looseObject({
  name: z.string().nullable().optional(),
  is_enabled: z.boolean().nullable().optional(),
})).nullable()

export type ListIssueTypes = z.infer<typeof LIST_ISSUE_TYPES>

/**
list_repository_collaborators の structuredContent
*/
const COLLABORATOR = z.looseObject({ login: z.string() })

export const LIST_COLLABORATORS = z.looseObject({
  items: z.array(COLLABORATOR).nullable().optional(),
})

export type ListCollaborators = z.infer<typeof LIST_COLLABORATORS>

// --- 形の確かめ ---

function pathText(path: readonly PropertyKey[]): string {
  return path.map(segment => typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`).join('').replace(/^\./u, '')
}

/**
公式のツールの結果を schema で確かめる。合わなければ、ツール名と項目の path を detail に出し、github-mcp-shape で止める。
where は入力の中の置き場所（reads.issues[0] など）
*/
export function parseOfficial<S extends z.ZodType>(output: Readonly<Output>, tool: string, schema: S, value: unknown, where?: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.map((issue) => {
    const at = pathText(issue.path)
    return `${at === '' ? '(root)' : at}: ${issue.message}`
  })
  output.error(`the result of ${tool}${where === undefined ? '' : ` in ${where}`} is not in the shape of the official GitHub MCP server\n${lines.join('\n')}`)
  throw new CommandExit(1, 'github-mcp-shape')
}

// --- domain の型への写し ---

// eslint-disable-next-line security/detect-unsafe-regex -- 量指定の入れ子が無く、後戻りは URL の長さに比例する
const ISSUE_URL_PATTERN = /^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/u

function safeReference(owner: string, name: string, number: number): IssueReference | undefined {
  try {
    return createIssueReference(createRepositoryReference(owner, name), number)
  }
  catch (error: unknown) {
    if (error instanceof ValidationFailure) return undefined
    throw error
  }
}

/**
Issue・PR の URL を参照にする。読めなければ undefined
*/
export function referenceFromUrl(url: string): IssueReference | undefined {
  const [, owner, name, number] = ISSUE_URL_PATTERN.exec(url) ?? []
  return owner === undefined || name === undefined || number === undefined ? undefined : safeReference(owner, name, Number(number))
}

/**
`owner/name` と番号から参照を作る。repository が読めなければ undefined
*/
export function referenceOf(repository: string, number: number): IssueReference | undefined {
  const parts = splitOwnerRepository(repository)
  return parts === undefined ? undefined : safeReference(parts.owner, parts.repository, number)
}

function pullRequestState(state: string): IssuePullRequest['state'] | undefined {
  switch (state.toUpperCase()) {
    case 'OPEN': { return 'open' }
    case 'MERGED': { return 'merged' }
    case 'CLOSED': { return 'closed' }
    default: { return undefined }
  }
}

/**
pull_request_read（get）の結果を判定の PR にする。html_url が PR の URL でなければ github-mcp-shape で止める
*/
export function readPullRequestOf(output: Readonly<Output>, read: PullRequestReadGet, where: string): IssuePullRequest {
  const reference = referenceFromUrl(read.html_url)
  if (reference === undefined) {
    output.error(`the result of pull_request_read in ${where} is not in the shape of the official GitHub MCP server\nhtml_url: not a pull request URL: ${read.html_url}`)
    throw new CommandExit(1, 'github-mcp-shape')
  }
  const headRepository = read.head.repo?.full_name.toLowerCase()
  const baseRepository = read.base.repo?.full_name.toLowerCase()
  return {
    repository: reference.repository,
    number: read.number,
    state: read.merged ? 'merged' : read.state,
    headRefName: read.head.ref,
    baseRefName: read.base.ref,
    isDraft: read.draft,
    isCrossRepository: headRepository !== undefined && baseRepository !== undefined && headRepository !== baseRepository,
  }
}

/**
list_pull_requests の結果を判定の PR にする。html_url が PR の URL でないものと、head・base の無いものは飛ばす
*/
export function listedPullRequestsOf(read: ListPullRequests): readonly IssuePullRequest[] {
  return (read ?? []).flatMap((pull): IssuePullRequest | [] => {
    const reference = referenceFromUrl(pull.html_url)
    const state = pull.merged === true ? 'merged' : pullRequestState(pull.state ?? '')
    if (reference === undefined || state === undefined || pull.head === undefined || pull.base === undefined) return []
    const headRepository = pull.head.repo?.full_name.toLowerCase()
    const baseRepository = pull.base.repo?.full_name.toLowerCase()
    return {
      repository: reference.repository,
      number: pull.number,
      state,
      headRefName: pull.head.ref,
      baseRefName: pull.base.ref,
      isDraft: pull.draft ?? false,
      isCrossRepository: headRepository !== undefined && baseRepository !== undefined && headRepository !== baseRepository,
    }
  })
}

/**
閉じる PR を、判定の PR にする。公式の結果は head・base を持たないので空にする。pull_request_read の結果があれば check-reads が差し替える
*/
function closingPullRequests(issue: z.infer<typeof ISSUE>, home: RepositoryReference): readonly IssuePullRequest[] {
  return (issue.closed_by_pull_requests?.references ?? []).flatMap((reference): IssuePullRequest | [] => {
    const state = pullRequestState(reference.state)
    if (state === undefined) return []
    const located = (reference.repository === undefined ? undefined : referenceOf(reference.repository, reference.number)) ?? referenceFromUrl(reference.url)
    return { repository: located?.repository ?? home, number: reference.number, state, headRefName: '', baseRefName: '', isDraft: false, isCrossRepository: false }
  })
}

/**
読んだ Issue 1 件。参照は html_url から取る
*/
export interface ReadIssue {
  readonly ref: IssueReference
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly body: string
  readonly pullRequests: readonly IssuePullRequest[]
}

/**
issue_read（get）の結果を Issue にする。html_url が Issue の URL でなければ github-mcp-shape で止める
*/
export function readIssueOf(output: Readonly<Output>, read: IssueReadGet, where: string): ReadIssue {
  const { issue } = read
  const reference = referenceFromUrl(issue.html_url)
  if (reference === undefined) {
    output.error(`the result of issue_read in ${where} is not in the shape of the official GitHub MCP server\nissue.html_url: not an Issue URL: ${issue.html_url}`)
    throw new CommandExit(1, 'github-mcp-shape')
  }
  return {
    ref: reference,
    title: issue.title,
    state: issue.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    body: issue.body ?? '',
    pullRequests: closingPullRequests(issue, reference.repository),
  }
}

/**
ボードのカード 1 枚。列（進行の欄）と札（Status）の表示名
*/
export interface ReadCard {
  readonly ref: IssueReference
  readonly fields: ReadonlyMap<string, string>
}

function fieldValueName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'object' || value === null) return undefined
  const named = z.looseObject({ name: z.string() }).safeParse(value)
  if (named.success) return named.data.name
  const titled = z.looseObject({ title: z.string() }).safeParse(value)
  return titled.success ? titled.data.title : undefined
}

/**
list_project_items の結果をカードにする。fields は欄の名前（小文字）→ 値の名前
*/
export function cardsOf(results: readonly ProjectsListItems[]): ReadonlyMap<string, ReadCard> {
  const cards = new Map<string, ReadCard>()
  for (const result of results) {
    const items = result.items.items ?? []
    for (const item of items) {
      const content = item.content
      if (content === null || content === undefined) continue
      const reference = referenceOf(content.repository, content.number)
      if (reference === undefined) continue
      const fields = new Map<string, string>()
      const values = item.fields ?? []
      for (const field of values) {
        const name = fieldValueName(field.value)
        if (name !== undefined) fields.set(field.name.toLowerCase(), name)
      }
      cards.set(issueReferenceKey(reference), { ref: reference, fields })
    }
  }
  return cards
}

/**
Issue と、あればカードから、判定の事実を作る。ブランチは公式の結果から分からないので空
*/
export function issueFactsOf(issue: Readonly<ReadIssue>, card: Readonly<ReadCard> | undefined, names: { readonly column: string, readonly label: string }, kind: IssueWorkKind = 'task'): IssueFacts {
  return {
    ref: issue.ref,
    state: issue.state,
    column: card?.fields.get(names.column.toLowerCase()),
    label: card?.fields.get(names.label.toLowerCase()),
    kind,
    branches: [],
    pullRequests: issue.pullRequests,
  }
}

/**
get_sub_issues の結果を、番号の判定の題にする。番号か題の無いものは飛ばす
*/
export function subIssueTitlesOf(read: IssueReadSubIssues): readonly { readonly number: number, readonly state: string, readonly title: string }[] {
  return (read.sub_issues ?? []).flatMap(sub => sub?.number === null || sub?.number === undefined || sub.title === null || sub.title === undefined
    ? []
    : { number: sub.number, state: (sub.state ?? '').toUpperCase(), title: sub.title })
}

/**
get_blocked_by の結果の前提の参照と状態。repository が無ければ html_url から取る
*/
export function blockedByOf(read: IssueDependencyRead): readonly { readonly ref: IssueReference, readonly state: 'open' | 'closed' }[] {
  return (read.issues ?? []).flatMap((issue) => {
    const reference = (issue.repository === undefined ? undefined : referenceOf(issue.repository, issue.number)) ?? (issue.html_url === undefined ? undefined : referenceFromUrl(issue.html_url))
    const state: 'open' | 'closed' = issue.state.toLowerCase() === 'closed' ? 'closed' : 'open'
    return reference === undefined ? [] : { ref: reference, state }
  })
}

/**
読んだボードの欄 1 つ。id は数の ID、nodeId は設定の ID と比べる GraphQL の ID
*/
export interface ReadProjectField {
  readonly id: string
  readonly nodeId: string | undefined
  readonly name: string
  readonly dataType: string
  readonly options: readonly AttributeOption[]
}

/**
list_project_fields の結果を欄にする。data_type は GraphQL の表記（大文字）にそろえる
*/
export function projectFieldsOf(read: ProjectsListFields): readonly ReadProjectField[] {
  return (read.fields.fields ?? []).map(field => ({
    id: String(field.id),
    nodeId: field.node_id,
    name: field.name,
    dataType: field.data_type.toUpperCase(),
    options: [
      ...(field.options ?? []).map(option => ({ id: option.id, name: option.name.raw })),
      ...(field.configuration?.iterations ?? []).map(iteration => ({ id: iteration.id, name: iteration.title.raw, ...iteration.start_date !== undefined && { startDate: iteration.start_date } })),
    ],
  }))
}

/**
ボードの欄の定義。書くときの ID は数の ID（projects_write の updated_field.id）
*/
export function projectDefinitionsOf(fields: readonly ReadProjectField[], workflowFieldId: string): readonly AttributeDefinition[] {
  return fields.flatMap((field) => {
    const definition = projectFieldDefinition({ id: field.nodeId ?? field.id, name: field.name, dataType: field.dataType, isIssueField: false, options: field.options }, workflowFieldId)
    return definition === undefined ? [] : { ...definition, fieldId: field.id }
  })
}

/**
list_issue_fields の結果を Issue field の定義にする
*/
export function issueFieldDefinitionsOf(read: ListIssueFields): readonly AttributeDefinition[] {
  return (read ?? []).map((field) => {
    const definition = issueFieldDefinition({ name: field.name, dataType: field.data_type.toUpperCase(), options: (field.options ?? []).map(option => ({ name: option.name, ...option.id !== undefined && { id: option.id } })) })
    return { ...definition, fieldId: field.full_database_id === undefined ? field.id : String(field.full_database_id) }
  })
}

/**
list_issue_types の結果の、使える Issue type の名前
*/
export function issueTypeNamesOf(read: ListIssueTypes): readonly string[] {
  return (read ?? []).flatMap(type => type.name === null || type.name === undefined || type.is_enabled === false ? [] : type.name)
}

/**
list_repository_collaborators の結果の login
*/
export function collaboratorLoginsOf(read: ListCollaborators): readonly string[] {
  return (read.items ?? []).map(item => item.login)
}
