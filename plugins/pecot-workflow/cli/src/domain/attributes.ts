// Issue の機能（ボードのフィールド・Issue fields・Issue の組み込み）の定義と値の形と、GitHub の種類から kind への対応。
import { closeMatches } from './fuzzy.js'
import { JSON_NULL } from './json-null.js'

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
選べる値 1 つ。startDate は Iteration の開始日（YYYY-MM-DD）。
id は書くときだけ使う内部の値（ボードの選択肢・Iteration の ID、マイルストーンの番号）で、出力に出さない
*/
export interface AttributeOption {
  readonly name: string
  readonly startDate?: string
  readonly id?: string
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
  /**
  書くときだけ使う内部の値。ボードのフィールドの ID か、Issue field の fullDatabaseId。出力に出さない
  */
  readonly fieldId?: string
}

export type AttributeValue = string | number | readonly string[]

// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const ATTRIBUTE_ERROR_CODES = [
  'unknown_attribute',
  'ambiguous_attribute',
  'read_only_attribute',
  'unsupported_attribute',
  'invalid_value',
  'unreadable_attribute',
  'not_on_board',
] as const

export type AttributeErrorCode = typeof ATTRIBUTE_ERROR_CODES[number]

/**
issue_create・issue_edit の attributes の 1 つ。value の null は外す。source は同じ名前が複数の source にあるときだけ要る
*/
export interface AttributeInput {
  readonly name: string
  readonly value: AttributeValue | null
  readonly source?: AttributeSource
}

/**
検証で止めた理由 1 つ。expected は取りうる値、candidates は似た名前、sources は同じ名前を持つ source、hint は代わりに使う操作
*/
export interface AttributeError {
  readonly code: AttributeErrorCode
  readonly name: string
  readonly source?: AttributeSource
  readonly value?: AttributeValue | null
  readonly expected?: string
  readonly candidates?: readonly string[]
  readonly sources?: readonly AttributeSource[]
  readonly hint?: string
}

/**
検証が照らす、定義の外の事実。
unreadableSources は定義を読めなかった source と理由、unassignableLogins は担当にできないと分かったログイン名。
current は issue_edit の今の値（issue_create では undefined）、isOnBoard は設定のボードに Issue が載っているか
*/
export interface AttributeValidationContext {
  readonly unreadableSources: ReadonlyMap<AttributeSource, string>
  readonly unassignableLogins: ReadonlySet<string>
  readonly current: readonly AttributeReading[] | undefined
  readonly isOnBoard: boolean
}

/**
updateProjectV2ItemFieldValue の value（ProjectV2FieldValue）
*/
export type ProjectFieldValueInput
  = | { readonly text: string }
    | { readonly number: number }
    | { readonly date: string }
    | { readonly singleSelectOptionId: string }
    | { readonly multiSelectOptionIds: readonly string[] }
    | { readonly iterationId: string }

/**
REST の Issue の作成・更新の本文に入れる、組み込みの機能のキーと値。milestone は番号
*/
export type BuiltinWrite
  = | { readonly key: 'assignees', readonly value: readonly string[] }
    | { readonly key: 'labels', readonly value: readonly string[] }
    | { readonly key: 'milestone', readonly value: number | null }
    | { readonly key: 'type', readonly value: string | null }

/**
書き方 1 つ。value が null なら外す
*/
export type AttributeWriteTarget
  = | { readonly source: 'project', readonly fieldId: string, readonly value: ProjectFieldValueInput | null }
    | { readonly source: 'issue_field', readonly fieldId: string, readonly value: string | number | readonly string[] | null }
    | { readonly source: 'issue', readonly write: BuiltinWrite }

/**
検証を通った書く予定 1 つ。before・after は名前の値。値の無いときは null
*/
export interface AttributeWrite {
  readonly name: string
  readonly source: AttributeSource
  readonly kind: AttributeKind
  readonly before: AttributeValue | null
  readonly after: AttributeValue | null
  readonly target: AttributeWriteTarget
}

export type AttributeValidation
  = | { readonly ok: true, readonly writes: readonly AttributeWrite[] }
    | { readonly ok: false, readonly errors: readonly AttributeError[] }

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

export function findOption(options: readonly AttributeOption[], name: string): AttributeOption | undefined {
  return options.find(option => option.name === name)
}

export type WritableAttributeKind = Exclude<AttributeKind, 'issue_ref' | 'issue_refs' | 'unsupported'>

/**
値を確かめた結果。value は書く名前の値（Iteration は開始日で受けても名前）
*/
export type NormalizedAttributeValue
  = | { readonly ok: true, readonly value: AttributeValue }
    | { readonly ok: false, readonly expected: string, readonly hint?: string }

/**
kind 1 つの扱い。target は、書くための ID を定義が持たないとき undefined
*/
export interface AttributeHandler {
  readonly normalize: (definition: Readonly<AttributeDefinition>, value: AttributeValue, context: Readonly<AttributeValidationContext>) => NormalizedAttributeValue
  readonly equals: (before: AttributeValue, after: AttributeValue) => boolean
  readonly target: (definition: Readonly<AttributeDefinition>, after: AttributeValue | null) => AttributeWriteTarget | undefined
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u

function isCalendarDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

function listOf(value: AttributeValue | null): readonly string[] | undefined {
  return value === null || typeof value === 'string' || typeof value === 'number' ? undefined : value
}

const accept = (value: AttributeValue): NormalizedAttributeValue => ({ ok: true, value })

const reject = (expected: string, hint?: string): NormalizedAttributeValue => ({ ok: false, expected, ...hint !== undefined && { hint } })

const optionsOf = (definition: Readonly<AttributeDefinition>): readonly AttributeOption[] => definition.options ?? []

function namesText(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ')
}

const oneOf = (definition: Readonly<AttributeDefinition>): string => `one of: ${namesText(optionsOf(definition).map(option => option.name))}`

const listOfOptions = (definition: Readonly<AttributeDefinition>): string => `list of: ${namesText(optionsOf(definition).map(option => option.name))}`

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function normalizeChoice(definition: Readonly<AttributeDefinition>, value: AttributeValue): NormalizedAttributeValue {
  return typeof value === 'string' && findOption(optionsOf(definition), value) !== undefined ? accept(value) : reject(oneOf(definition))
}

function normalizeChoices(definition: Readonly<AttributeDefinition>, value: AttributeValue): NormalizedAttributeValue {
  const names = listOf(value)
  const isValid = names !== undefined && !hasDuplicates(names) && names.every(name => findOption(optionsOf(definition), name) !== undefined)
  return isValid ? accept(names) : reject(listOfOptions(definition))
}

function normalizeIteration(definition: Readonly<AttributeDefinition>, value: AttributeValue): NormalizedAttributeValue {
  const options = optionsOf(definition)
  const option = typeof value === 'string' ? findOption(options, value) ?? options.find(candidate => candidate.startDate === value) : undefined
  if (option !== undefined) return accept(option.name)
  const choices = options.map(candidate => candidate.startDate === undefined ? candidate.name : `${candidate.name} (${candidate.startDate})`)
  return reject(`iteration name or start date: ${namesText(choices)}`)
}

const ASSIGNABLE_LOGINS = 'assignable logins'

function normalizeUsers(_definition: Readonly<AttributeDefinition>, value: AttributeValue, context: Readonly<AttributeValidationContext>): NormalizedAttributeValue {
  const logins = listOf(value)
  if (logins === undefined || hasDuplicates(logins) || logins.includes('')) return reject(ASSIGNABLE_LOGINS)
  const unassignable = logins.filter(login => context.unassignableLogins.has(login))
  return unassignable.length === 0 ? accept(logins) : reject(ASSIGNABLE_LOGINS, `not assignable: ${unassignable.join(', ')}`)
}

const isSameValue = (before: AttributeValue, after: AttributeValue): boolean => before === after

function isSameSet(before: AttributeValue, after: AttributeValue): boolean {
  const left = listOf(before)
  const right = listOf(after)
  if (left === undefined || right === undefined) return false
  const rightSet = new Set(right)
  return new Set(left).size === rightSet.size && left.every(name => rightSet.has(name))
}

function optionId(definition: Readonly<AttributeDefinition>, name: string): string | undefined {
  return findOption(optionsOf(definition), name)?.id
}

type ProjectValue = (definition: Readonly<AttributeDefinition>, after: AttributeValue) => ProjectFieldValueInput | undefined

// ボードのフィールドと Issue fields の書き方。Issue fields は選択肢も名前で送る
function fieldTarget(projectValue: ProjectValue): AttributeHandler['target'] {
  return (definition, after) => {
    const { fieldId } = definition
    if (fieldId === undefined) return
    if (definition.source === 'issue_field') return { source: 'issue_field', fieldId, value: after }
    if (definition.source !== 'project') return
    if (after === null) return { source: 'project', fieldId, value: JSON_NULL }
    const value = projectValue(definition, after)
    return value === undefined ? undefined : { source: 'project', fieldId, value }
  }
}

function builtinTarget(write: (after: AttributeValue | null, definition: Readonly<AttributeDefinition>) => BuiltinWrite | undefined): AttributeHandler['target'] {
  return (definition, after) => {
    if (definition.source !== 'issue') return
    const builtin = write(after, definition)
    return builtin === undefined ? undefined : { source: 'issue', write: builtin }
  }
}

function milestoneWrite(after: AttributeValue | null, definition: Readonly<AttributeDefinition>): BuiltinWrite | undefined {
  if (after === null) return { key: 'milestone', value: JSON_NULL }
  const id = typeof after === 'string' ? optionId(definition, after) : undefined
  const number = id === undefined ? NaN : Number(id)
  return Number.isSafeInteger(number) ? { key: 'milestone', value: number } : undefined
}

export const ATTRIBUTE_HANDLERS: Readonly<Record<WritableAttributeKind, AttributeHandler>> = {
  text: {
    normalize: (_definition, value) => typeof value === 'string' ? accept(value) : reject('string'),
    equals: isSameValue,
    target: fieldTarget((_definition, after) => typeof after === 'string' ? { text: after } : undefined),
  },
  number: {
    normalize: (_definition, value) => typeof value === 'number' && Number.isFinite(value) ? accept(value) : reject('number'),
    equals: isSameValue,
    target: fieldTarget((_definition, after) => typeof after === 'number' ? { number: after } : undefined),
  },
  date: {
    normalize: (_definition, value) => typeof value === 'string' && isCalendarDate(value) ? accept(value) : reject('YYYY-MM-DD'),
    equals: isSameValue,
    target: fieldTarget((_definition, after) => typeof after === 'string' ? { date: after } : undefined),
  },
  single_select: {
    normalize: normalizeChoice,
    equals: isSameValue,
    target: fieldTarget((definition, after) => {
      const id = typeof after === 'string' ? optionId(definition, after) : undefined
      return id === undefined ? undefined : { singleSelectOptionId: id }
    }),
  },
  multi_select: {
    normalize: normalizeChoices,
    equals: isSameSet,
    target: fieldTarget((definition, after) => {
      const ids = (listOf(after) ?? []).map(name => optionId(definition, name))
      return ids.every(id => id !== undefined) ? { multiSelectOptionIds: ids } : undefined
    }),
  },
  iteration: {
    normalize: normalizeIteration,
    equals: isSameValue,
    target: fieldTarget((definition, after) => {
      const id = typeof after === 'string' ? optionId(definition, after) : undefined
      return id === undefined ? undefined : { iterationId: id }
    }),
  },
  users: {
    normalize: normalizeUsers,
    equals: isSameSet,
    target: builtinTarget(after => ({ key: 'assignees', value: listOf(after) ?? [] })),
  },
  milestone: {
    normalize: normalizeChoice,
    equals: isSameValue,
    target: builtinTarget(milestoneWrite),
  },
  issue_type: {
    normalize: normalizeChoice,
    equals: isSameValue,
    target: builtinTarget(after => ({ key: 'type', value: typeof after === 'string' ? after : JSON_NULL })),
  },
  labels: {
    normalize: normalizeChoices,
    equals: isSameSet,
    target: builtinTarget(after => ({ key: 'labels', value: listOf(after) ?? [] })),
  },
}

function isWritableKind(kind: AttributeKind): kind is WritableAttributeKind {
  return Object.hasOwn(ATTRIBUTE_HANDLERS, kind)
}

type Resolution
  = | { readonly ok: true, readonly definition: AttributeDefinition }
    | { readonly ok: false, readonly error: AttributeError }

function resolveDefinition(definitions: readonly AttributeDefinition[], input: Readonly<AttributeInput>, context: Readonly<AttributeValidationContext>): Resolution {
  const { name, source } = input
  const matches = definitions.filter(definition => definition.name === name && (source === undefined || definition.source === source))
  const [first, ...rest] = matches
  if (first !== undefined && rest.length === 0) return { ok: true, definition: first }
  if (first !== undefined) return { ok: false, error: { code: 'ambiguous_attribute', name, sources: matches.map(definition => definition.source) } }
  const searched = source === undefined ? ATTRIBUTE_SOURCES : [source]
  const unreadable = searched.filter(candidate => context.unreadableSources.has(candidate))
  if (unreadable.length > 0) {
    const hint = unreadable.map(candidate => context.unreadableSources.get(candidate) ?? '').join('; ')
    return { ok: false, error: { code: 'unreadable_attribute', name, ...unreadable.length === 1 && { source: unreadable[0] }, hint } }
  }
  const names = [...new Set(definitions.filter(definition => searched.includes(definition.source)).map(definition => definition.name))]
  return { ok: false, error: { code: 'unknown_attribute', name, ...source !== undefined && { source }, candidates: closeMatches(name, names) } }
}

function readOnlyHint(definition: Readonly<AttributeDefinition>): string {
  if (definition.kind === 'issue_ref') return 'set the parent with parent_epic'
  if (definition.kind === 'issue_refs') return 'change blocked_by with issue_block or issue_unblock'
  return 'move the issue with board_move'
}

// 書けない理由のうち、値を見ずに分かるもの
function definitionError(definition: Readonly<AttributeDefinition>, context: Readonly<AttributeValidationContext>): AttributeError | undefined {
  const { name, source } = definition
  if (definition.kind === 'unsupported') return { code: 'unsupported_attribute', name, source, hint: `GitHub type ${definition.unsupportedReason ?? ''} is not supported` }
  if (!definition.writable || !isWritableKind(definition.kind)) return { code: 'read_only_attribute', name, source, hint: readOnlyHint(definition) }
  if (source === 'project' && !context.isOnBoard) return { code: 'not_on_board', name, source, hint: 'add the issue to the board with board_add' }
  return undefined
}

type WritePlan
  = | { readonly outcome: 'write', readonly write: AttributeWrite }
    | { readonly outcome: 'skip' }
    | { readonly outcome: 'error', readonly error: AttributeError }

const isEmptyList = (value: AttributeValue): boolean => listOf(value)?.length === 0

function planWrite(definition: Readonly<AttributeDefinition>, value: AttributeValue | null, context: Readonly<AttributeValidationContext>): WritePlan {
  const blocked = definitionError(definition, context)
  if (blocked !== undefined || !isWritableKind(definition.kind)) return { outcome: 'error', error: blocked ?? { code: 'read_only_attribute', name: definition.name } }
  const { name, source, kind } = definition
  // eslint-disable-next-line security/detect-object-injection -- kind は列挙型
  const handler = ATTRIBUTE_HANDLERS[kind]
  const normalized = value === null ? undefined : handler.normalize(definition, value, context)
  if (normalized?.ok === false) {
    const { expected, hint } = normalized
    return { outcome: 'error', error: { code: 'invalid_value', name, source, value, expected, ...hint !== undefined && { hint } } }
  }
  // 空の配列は外すのと同じに扱う
  const after = normalized === undefined || isEmptyList(normalized.value) ? JSON_NULL : normalized.value
  const reading = context.current?.find(candidate => candidate.name === name && candidate.source === source)
  if (reading === undefined ? after === null : after !== null && handler.equals(reading.value, after)) return { outcome: 'skip' }
  const target = handler.target(definition, after)
  return target === undefined
    ? { outcome: 'error', error: { code: 'unreadable_attribute', name, source, hint: 'the definition has no ID' } }
    : { outcome: 'write', write: { name, source, kind, before: reading?.value ?? JSON_NULL, after, target } }
}

/**
attributes を定義に照らす。1 つでも合わなければ全部の理由を返し、書く予定を返さない。
current が undefined（issue_create）なら null を飛ばし、current があれば値の変わる機能だけを書く
*/
export function validateAttributes(definitions: readonly AttributeDefinition[], inputs: readonly AttributeInput[], context: Readonly<AttributeValidationContext>): AttributeValidation {
  const resolved = inputs.map(input => ({ input, resolution: resolveDefinition(definitions, input, context) }))
  const counts = new Map<AttributeDefinition, number>()
  for (const { resolution } of resolved) {
    if (resolution.ok) counts.set(resolution.definition, (counts.get(resolution.definition) ?? 0) + 1)
  }
  const reported = new Set<AttributeDefinition>()
  const errors: AttributeError[] = []
  const writes: AttributeWrite[] = []
  for (const { input, resolution } of resolved) {
    if (!resolution.ok) {
      errors.push(resolution.error)
      continue
    }
    const { definition } = resolution
    if ((counts.get(definition) ?? 0) > 1) {
      // 同じ機能を 2 回書くと、どちらの値を書くか決まらない
      if (!reported.has(definition)) errors.push({ code: 'ambiguous_attribute', name: definition.name, source: definition.source, sources: [definition.source], hint: 'the attribute is given more than once' })
      reported.add(definition)
      continue
    }
    const plan = planWrite(definition, input.value, context)
    if (plan.outcome === 'error') errors.push(plan.error)
    else if (plan.outcome === 'write') writes.push(plan.write)
  }
  return errors.length === 0 ? { ok: true, writes } : { ok: false, errors }
}
