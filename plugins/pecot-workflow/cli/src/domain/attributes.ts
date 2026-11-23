// Issue の機能（ボードのフィールド・Issue fields・Issue の組み込み）の定義と値の形と、GitHub の種類から kind への対応。

// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const ATTRIBUTE_SOURCES = ['project', 'issue_field', 'issue'] as const

export type AttributeSource = typeof ATTRIBUTE_SOURCES[number]

// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const ATTRIBUTE_KINDS = [
  'single_select',
  'multi_select',
  'text',
  'number',
  'date',
  'iteration',
  'users',
  'milestone',
  'issue_type',
  'labels',
  'issue_ref',
  'issue_refs',
  'unsupported',
] as const

export type AttributeKind = typeof ATTRIBUTE_KINDS[number]

/**
選べる値 1 つ。startDate は Iteration の開始日（YYYY-MM-DD）
*/
export interface AttributeOption {
  readonly name: string
  readonly startDate?: string
}

export interface AttributeDefinition {
  readonly name: string
  readonly source: AttributeSource
  readonly kind: AttributeKind
  /**
  選択肢を持つ kind（選択・Iteration・マイルストーン・Issue type・ラベル）だけが持つ
  */
  readonly options?: readonly AttributeOption[]
  readonly writable: boolean
  /**
  kind が unsupported のときの、GitHub の種類の名前
  */
  readonly unsupportedReason?: string
}

export type AttributeValue = string | number | readonly string[]

export interface AttributeReading {
  readonly name: string
  readonly source: AttributeSource
  readonly kind: AttributeKind
  readonly value: AttributeValue
}

export interface UnsupportedAttribute {
  readonly name: string
  readonly source: AttributeSource
  readonly githubType: string
}

/**
ボードのフィールドの形。options は選択肢か Iteration で、無い種類は空
*/
export interface ProjectFieldShape {
  readonly id: string
  readonly name: string
  readonly dataType: string
  readonly isIssueField: boolean
  readonly options: readonly AttributeOption[]
}

export interface IssueFieldShape {
  readonly name: string
  readonly dataType: string
  readonly options: readonly AttributeOption[]
}

// 利用者が足せる種類。ボードのフィールドと Issue fields で同じ名前を使う
const FIELD_KINDS: ReadonlyMap<string, AttributeKind> = new Map<string, AttributeKind>([
  ['TEXT', 'text'],
  ['NUMBER', 'number'],
  ['DATE', 'date'],
  ['SINGLE_SELECT', 'single_select'],
  ['MULTI_SELECT', 'multi_select'],
  ['ITERATION', 'iteration'],
])

const ISSUE_FIELD_KINDS: ReadonlySet<string> = new Set(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT'])

// Issue の機能を写すボードのフィールド。source: issue の組み込みで出す
const BUILTIN_PROJECT_FIELD_TYPES: ReadonlySet<string> = new Set(['ASSIGNEES', 'LABELS', 'MILESTONE', 'ISSUE_TYPE', 'PARENT_ISSUE'])

// GitHub が計算するボードのフィールド
const COMPUTED_PROJECT_FIELD_TYPES: ReadonlySet<string> = new Set([
  'TITLE',
  'REPOSITORY',
  'REVIEWERS',
  'LINKED_PULL_REQUESTS',
  'TRACKS',
  'TRACKED_BY',
  'CREATED',
  'UPDATED',
  'CLOSED',
  'SUB_ISSUES_PROGRESS',
])

const KINDS_WITH_OPTIONS: ReadonlySet<AttributeKind> = new Set<AttributeKind>(['single_select', 'multi_select', 'iteration', 'milestone', 'issue_type', 'labels'])

const STATUS_FIELD_NAME = 'Status'

function definition(name: string, source: AttributeSource, kind: AttributeKind, options: readonly AttributeOption[], isWritable: boolean): AttributeDefinition {
  return { name, source, kind, ...KINDS_WITH_OPTIONS.has(kind) && { options }, writable: isWritable }
}

function unsupportedDefinition(name: string, source: AttributeSource, githubType: string): AttributeDefinition {
  return { name, source, kind: 'unsupported', writable: false, unsupportedReason: githubType }
}

/**
ボードのフィールドの定義。Issue の機能を写すフィールドと Issue field を写したフィールドは、別の source で出すので undefined。
pecot の進行の欄（設定の id で見分ける）と組み込みの Status は、board_move で動かすので書けない
*/
export function projectFieldDefinition(field: Readonly<ProjectFieldShape>, workflowFieldId: string): AttributeDefinition | undefined {
  if (field.isIssueField || BUILTIN_PROJECT_FIELD_TYPES.has(field.dataType)) return undefined
  const kind = FIELD_KINDS.get(field.dataType)
  if (kind === undefined) return unsupportedDefinition(field.name, 'project', field.dataType)
  const isBoardColumn = field.id === workflowFieldId || (field.dataType === 'SINGLE_SELECT' && field.name === STATUS_FIELD_NAME)
  return definition(field.name, 'project', kind, field.options, !isBoardColumn)
}

/**
Issue field の値の kind。知らない種類は unsupported
*/
export function issueFieldValueKind(dataType: string): AttributeKind {
  return ISSUE_FIELD_KINDS.has(dataType) ? FIELD_KINDS.get(dataType) ?? 'unsupported' : 'unsupported'
}

export function issueFieldDefinition(field: Readonly<IssueFieldShape>): AttributeDefinition {
  const kind = issueFieldValueKind(field.dataType)
  return kind === 'unsupported' ? unsupportedDefinition(field.name, 'issue_field', field.dataType) : definition(field.name, 'issue_field', kind, field.options, true)
}

export interface BuiltinChoices {
  readonly milestones: readonly string[]
  /**
  Issue type を読めない環境（GHES）では undefined。type の定義を出さない
  */
  readonly issueTypes: readonly string[] | undefined
  readonly labels: readonly string[]
}

const named = (names: readonly string[]): readonly AttributeOption[] => names.map(name => ({ name }))

/**
組み込みの機能の定義。parent・blocked_by は、書く道を issue_create と issue_block・issue_unblock の 1 つにするので書けない
*/
export function builtinDefinitions(choices: Readonly<BuiltinChoices>): readonly AttributeDefinition[] {
  return [
    definition('assignees', 'issue', 'users', [], true),
    definition('milestone', 'issue', 'milestone', named(choices.milestones), true),
    ...choices.issueTypes === undefined ? [] : [definition('type', 'issue', 'issue_type', named(choices.issueTypes), true)],
    definition('labels', 'issue', 'labels', named(choices.labels), true),
    definition('parent', 'issue', 'issue_ref', [], false),
    definition('blocked_by', 'issue', 'issue_refs', [], false),
  ]
}

export function unsupportedOf(definitions: readonly AttributeDefinition[]): readonly UnsupportedAttribute[] {
  return definitions.filter(definition => definition.kind === 'unsupported').map(({ name, source, unsupportedReason = '' }) => ({ name, source, githubType: unsupportedReason }))
}

export type ProjectValueTreatment
  = | { readonly treatment: 'read', readonly kind: AttributeKind }
    | { readonly treatment: 'skip' }
    | { readonly treatment: 'unsupported' }

/**
ボードの値の扱い。システムのフィールドと Issue field を写したフィールドの値は、ほかの source で出すので読み捨てる
*/
export function projectValueTreatment(dataType: string, isIssueField: boolean): ProjectValueTreatment {
  if (isIssueField || BUILTIN_PROJECT_FIELD_TYPES.has(dataType) || COMPUTED_PROJECT_FIELD_TYPES.has(dataType)) return { treatment: 'skip' }
  const kind = FIELD_KINDS.get(dataType)
  return kind === undefined ? { treatment: 'unsupported' } : { treatment: 'read', kind }
}

export interface BuiltinValues {
  readonly assignees: readonly string[]
  readonly milestone: string | undefined
  readonly issueType: string | undefined
  readonly labels: readonly string[]
}

function reading(name: string, kind: AttributeKind, value: AttributeValue | undefined): readonly AttributeReading[] {
  const isEmpty = value === undefined || (Array.isArray(value) && value.length === 0)
  return isEmpty ? [] : [{ name, source: 'issue', kind, value }]
}

/**
値のある組み込みの機能（parent・blocked_by を除く）
*/
export function builtinReadings(values: Readonly<BuiltinValues>): readonly AttributeReading[] {
  return [
    ...reading('assignees', 'users', values.assignees),
    ...reading('milestone', 'milestone', values.milestone),
    ...reading('type', 'issue_type', values.issueType),
    ...reading('labels', 'labels', values.labels),
  ]
}

export interface IssueLocation {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

export function issueReferenceText(location: Readonly<IssueLocation>): string {
  return `${location.owner}/${location.repository}/${String(location.number)}`
}

/**
parent・blocked_by の値。blockedBy が undefined（読めない）か空なら blocked_by を出さない
*/
export function relationReadings(parent: Readonly<IssueLocation> | undefined, blockedBy: readonly Readonly<IssueLocation>[] | undefined): readonly AttributeReading[] {
  return [
    ...reading('parent', 'issue_ref', parent === undefined ? undefined : issueReferenceText(parent)),
    ...reading('blocked_by', 'issue_refs', blockedBy?.map(location => issueReferenceText(location))),
  ]
}

/**
Markdown の 1 行に出す値。配列は「, 」でつなぐ
*/
export function formatAttributeValue(value: AttributeValue): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? value : value.join(', ')
}
