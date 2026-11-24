/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue_create・issue_edit の attributes。入力の形、定義との照らし合わせ、検証の後の書き込みと結果の組み立て。
import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { JSON_NULL } from '../domain/json-null.js'
import { ATTRIBUTE_ERROR_CODES, ATTRIBUTE_SOURCES, formatAttributeValue, validateAttributes } from '../domain/attributes.js'
import type { AttributeError, AttributeInput, AttributeReading, AttributeValidation, AttributeValue, AttributeWrite, AttributeWriteTarget, BuiltinWrite } from '../domain/attributes.js'
import type { ProjectConfig } from '../domain/config.js'
import type { JsonObject } from '../domain/json.js'
import { readAttributeDefinitions } from '../infra/github/attributes.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { builtinValuesOfIssue, issueFieldRestId } from '../infra/github/issues.js'
import type { CreateIssueExtras } from '../infra/github/issues.js'
import type { Output } from './output.js'

const SOURCE_JSON = z.enum(ATTRIBUTE_SOURCES)

const NULLABLE_VALUE_JSON = z.union([z.string(), z.number(), z.array(z.string()), z.null()])

export const ATTRIBUTE_INPUT_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute, as issue_attributes lists it'),
  value: NULLABLE_VALUE_JSON.describe('Value: a name for select, iteration (or its start date), milestone and type; a list for multi_select, assignees and labels; a number for number; YYYY-MM-DD for date; null to remove the value'),
  source: SOURCE_JSON.optional().describe('Source of the attribute (project, issue_field or issue); only needed when the same name is in several sources'),
})

export const ATTRIBUTES_INPUT = z.array(ATTRIBUTE_INPUT_JSON).optional()

const VALUE_JSON = z.union([z.string(), z.number(), z.array(z.string())])

export const ATTRIBUTE_ERROR_JSON = z.strictObject({
  file: z.string().optional().describe('File whose front matter has the value (issue_create with files only)'),
  code: z.enum(ATTRIBUTE_ERROR_CODES).describe('Why the value was not accepted'),
  name: z.string().describe('Name of the attribute as given'),
  source: SOURCE_JSON.optional().describe('Source of the attribute, when known'),
  value: z.union([VALUE_JSON, z.null()]).optional().describe('Value as given'),
  expected: z.string().optional().describe('Values the attribute takes'),
  candidates: z.array(z.string()).optional().describe('Similar names'),
  sources: z.array(SOURCE_JSON).optional().describe('Sources that have the same name'),
  hint: z.string().optional().describe('What to use instead, or why the definitions could not be read'),
})

export const ATTRIBUTE_FAILURE_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute'),
  source: SOURCE_JSON,
  reason: z.string().describe('Message from GitHub, or that GitHub dropped the value'),
})

export const ATTRIBUTE_CHANGE_JSON = z.strictObject({
  name: z.string().describe('Name of the attribute'),
  source: SOURCE_JSON,
  before: z.union([VALUE_JSON, z.null()]).describe('Value before the change (null when there was none)'),
  after: z.union([VALUE_JSON, z.null()]).describe('Value after the change (null when removed)'),
})

export type AttributeErrorJson = z.input<typeof ATTRIBUTE_ERROR_JSON>
export type AttributeFailureJson = z.input<typeof ATTRIBUTE_FAILURE_JSON>
export type AttributeChangeJson = z.input<typeof ATTRIBUTE_CHANGE_JSON>

export interface AttributeOutcome {
  readonly changed: readonly AttributeChangeJson[]
  readonly failed: readonly AttributeFailureJson[]
}

const EMPTY_OUTCOME: AttributeOutcome = { changed: [], failed: [] }

const DROPPED_REASON = 'GitHub dropped the value (writing it needs push access to the repository)'

export function attributeErrorJson(error: Readonly<AttributeError>, file?: string): AttributeErrorJson {
  const { code, name, source, value, expected, candidates, sources, hint } = error
  return {
    ...file !== undefined && { file },
    code,
    name,
    ...source !== undefined && { source },
    ...value !== undefined && { value: plain(value) },
    ...expected !== undefined && { expected },
    ...candidates !== undefined && { candidates: [...candidates] },
    ...sources !== undefined && { sources: [...sources] },
    ...hint !== undefined && { hint },
  }
}

/**
error の行の文。似た名前・取りうる値・代わりの操作を後ろに付ける
*/
export function attributeErrorLine(error: Readonly<AttributeError>): string {
  const where = error.source === undefined ? error.name : `${error.name} (${error.source})`
  const parts = [`${error.code}: ${where}`]
  if (error.value !== undefined) parts.push(`value ${error.value === null ? 'null' : JSON.stringify(error.value)}`)
  if (error.expected !== undefined) parts.push(`expected ${error.expected}`)
  if (error.candidates !== undefined && error.candidates.length > 0) parts.push(`did you mean ${error.candidates.join(', ')}`)
  if (error.sources !== undefined && error.sources.length > 0) parts.push(`give source: ${error.sources.join(' or ')}`)
  if (error.hint !== undefined) parts.push(error.hint)
  return parts.join('; ')
}

export type RawAttributes = readonly z.output<typeof ATTRIBUTE_INPUT_JSON>[] | undefined

export function attributeInputs(raw: RawAttributes): readonly AttributeInput[] {
  return (raw ?? []).map(({ name, value, source }) => ({ name, value, ...source !== undefined && { source } }))
}

function assigneeLogins(inputs: readonly AttributeInput[]): readonly string[] {
  const logins = new Set<string>()
  for (const { name, source, value } of inputs) {
    if (value === null || name !== 'assignees' || typeof value !== 'object' || (source !== undefined && source !== 'issue')) continue
    for (const login of value) {
      if (login !== '') logins.add(login)
    }
  }
  return [...logins]
}

export interface AttributeCheckTarget {
  readonly owner: string
  readonly repository: string
}

export interface CurrentAttributes {
  readonly readings: readonly AttributeReading[]
  readonly itemId: string | undefined
}

/**
リポごとに 1 回だけ読む定義。一括の起票で同じリポのファイルが続くときに使い回す
*/
export type DefinitionsCache = Map<string, Awaited<ReturnType<typeof readAttributeDefinitions>>>

/**
定義を読み、担当にできるかを問い、値を照らす。current は issue_edit の今の値（issue_create では undefined）。
定義の読み込みの警告は、読んだときに 1 回だけ warning の行にする
*/
export async function checkAttributes(output: Output, client: GitHubClient, config: ProjectConfig, target: Readonly<AttributeCheckTarget>, inputs: readonly AttributeInput[], current: Readonly<CurrentAttributes> | undefined, cache: DefinitionsCache = new Map()): Promise<AttributeValidation> {
  const key = `${target.owner}/${target.repository}`
  let read = cache.get(key)
  if (read === undefined) {
    read = await readAttributeDefinitions(client, { owner: target.owner, repository: target.repository, projectId: config.project.id, workflowFieldId: config.project.fields.workflow.id })
    cache.set(key, read)
    for (const warning of read.warnings) output.warning(warning)
  }
  const unassignable = new Set<string>()
  for (const login of assigneeLogins(inputs)) {
    if (!await client.isAssignable(target.owner, target.repository, login)) unassignable.add(login)
  }
  return validateAttributes(read.definitions, inputs, {
    unreadableSources: read.unreadable,
    unassignableLogins: unassignable,
    current: current?.readings,
    isOnBoard: current === undefined || current.itemId !== undefined,
  })
}

/**
照らした結果が止める形なら、error の行を出し、errors を返す。通ったら undefined
*/
export function reportAttributeErrors(output: Output, errors: readonly AttributeError[], file?: string): readonly AttributeErrorJson[] {
  for (const error of errors) output.error(file === undefined ? attributeErrorLine(error) : `${file}: ${attributeErrorLine(error)}`)
  return errors.map(error => attributeErrorJson(error, file))
}

/**
`label`・フロントマターの `labels` と、attributes の labels を両方渡したときの誤り
*/
export function labelsConflict(inputs: readonly AttributeInput[], hasLabels: boolean): readonly AttributeError[] {
  if (!hasLabels) return []
  return inputs.filter(input => input.name === 'labels' && (input.source === undefined || input.source === 'issue')).map((input): AttributeError => ({
    code: 'ambiguous_attribute',
    name: input.name,
    source: 'issue',
    hint: 'labels are given both as labels and as the labels attribute; give them in one place',
  }))
}

type TargetedWrite<S extends AttributeWriteTarget['source']> = AttributeWrite & { readonly target: Extract<AttributeWriteTarget, { readonly source: S }> }

function targetedBy<S extends AttributeWriteTarget['source']>(source: S): (write: Readonly<AttributeWrite>) => write is TargetedWrite<S> {
  return (write): write is TargetedWrite<S> => write.target.source === source
}

function builtinWritesOf(writes: readonly AttributeWrite[]): readonly TargetedWrite<'issue'>[] {
  return writes.filter(targetedBy('issue'))
}

/**
REST の Issue の作成・更新の本文に入れる組み込みの機能
*/
export function builtinBody(writes: readonly AttributeWrite[]): readonly BuiltinWrite[] {
  return builtinWritesOf(writes).map(write => write.target.write)
}

/**
起票の要求に入れる組み込みの機能。ラベルは labels に、ほかは extras に入れる
*/
export function createBuiltins(writes: readonly AttributeWrite[]): { readonly labels: readonly string[] | undefined, readonly extras: CreateIssueExtras } {
  let labels: readonly string[] | undefined
  let extras: CreateIssueExtras = {}
  for (const write of builtinBody(writes)) {
    if (write.key === 'labels') labels = write.value
    else if (write.key === 'assignees') extras = { ...extras, assignees: write.value }
    else if (write.value !== null) extras = write.key === 'milestone' ? { ...extras, milestone: write.value } : { ...extras, type: write.value }
  }
  return { labels, extras }
}

function isSameSet(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left)
  return left.length === right.length && right.every(item => set.has(item)) && new Set(right).size === set.size
}

function isKept(write: Readonly<BuiltinWrite>, values: ReturnType<typeof builtinValuesOfIssue>): boolean {
  switch (write.key) {
    case 'assignees': { return isSameSet(write.value, values.assignees) }
    case 'labels': { return isSameSet(write.value, values.labels) }
    case 'milestone': { return write.value === (values.milestone?.number ?? JSON_NULL) }
    case 'type': { return write.value === (values.type ?? JSON_NULL) }
  }
}

/**
応答の Issue と頼んだ値を比べ、残った機能を changed に、GitHub が捨てた機能を failed に入れる
*/
export function builtinOutcome(writes: readonly AttributeWrite[], issue: JsonObject): AttributeOutcome {
  const values = builtinValuesOfIssue(issue)
  const builtins = builtinWritesOf(writes)
  return {
    changed: builtins.filter(write => isKept(write.target.write, values)).map(write => changeJson(write)),
    failed: builtins.filter(write => !isKept(write.target.write, values)).map(write => ({ name: write.name, source: write.source, reason: DROPPED_REASON })),
  }
}

export function changeJson(write: Readonly<AttributeWrite>): AttributeChangeJson {
  return { name: write.name, source: write.source, before: plain(write.before), after: plain(write.after) }
}

function plain(value: AttributeValue | null): string | number | string[] | null {
  return value === null || typeof value === 'string' || typeof value === 'number' ? value : [...value]
}

function failure(write: Readonly<AttributeWrite>, reason: string): AttributeFailureJson {
  return { name: write.name, source: write.source, reason }
}

function failureOf(write: Readonly<AttributeWrite>, error: unknown): AttributeFailureJson {
  if (!(error instanceof GitHubAPIError)) throw error
  return failure(write, describeApiError(error))
}

function merge(parts: readonly AttributeOutcome[]): AttributeOutcome {
  return { changed: parts.flatMap(part => part.changed), failed: parts.flatMap(part => part.failed) }
}

export interface IssueLocationTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

/**
Issue fields を書く。値のあるものはまとめて 1 回（25 件ずつ）、外すものは 1 つずつ。失敗は failed に入れて続ける
*/
export async function writeIssueFields(client: GitHubClient, issue: Readonly<IssueLocationTarget>, writes: readonly AttributeWrite[]): Promise<AttributeOutcome> {
  const fields = writes.filter(targetedBy('issue_field'))
  if (fields.length === 0) return EMPTY_OUTCOME
  const unusable: AttributeFailureJson[] = []
  const sets: { readonly write: AttributeWrite, readonly restId: number, readonly value: string | number | readonly string[] }[] = []
  const removals: { readonly write: AttributeWrite, readonly restId: number }[] = []
  for (const write of fields) {
    const restId = issueFieldRestId(write.target.fieldId)
    if (restId === undefined) unusable.push(failure(write, `the Issue field ID ${write.target.fieldId} is not a REST ID`))
    else if (write.target.value === null) removals.push({ write, restId })
    else sets.push({ write, restId, value: write.target.value })
  }

  const parts: AttributeOutcome[] = [{ changed: [], failed: unusable }]
  if (sets.length > 0) {
    try {
      await client.addIssueFieldValues(issue.owner, issue.repository, issue.number, sets.map(entry => ({ fieldId: entry.restId, value: entry.value })))
      parts.push({ changed: sets.map(entry => changeJson(entry.write)), failed: [] })
    }
    catch (error: unknown) {
      parts.push({ changed: [], failed: sets.map(entry => failureOf(entry.write, error)) })
    }
  }
  for (const entry of removals) {
    try {
      await client.deleteIssueFieldValue(issue.owner, issue.repository, issue.number, entry.restId)
      parts.push({ changed: [changeJson(entry.write)], failed: [] })
    }
    catch (error: unknown) {
      parts.push({ changed: [], failed: [failureOf(entry.write, error)] })
    }
  }
  return merge(parts)
}

/**
ボードのフィールドを 1 つずつ書く。失敗は failed に入れて続ける
*/
export async function writeProjectFields(client: GitHubClient, projectId: string, itemId: string, writes: readonly AttributeWrite[]): Promise<AttributeOutcome> {
  const parts: AttributeOutcome[] = []
  for (const write of writes) {
    const { target } = write
    if (target.source !== 'project') continue
    try {
      await (target.value === null
        ? client.clearProjectItemField(projectId, itemId, target.fieldId)
        : client.setProjectItemFieldValue(projectId, itemId, target.fieldId, target.value))
      parts.push({ changed: [changeJson(write)], failed: [] })
    }
    catch (error: unknown) {
      parts.push({ changed: [], failed: [failureOf(write, error)] })
    }
  }
  return merge(parts)
}

/**
書けなかった機能ごとの warning の行。target は `Issue owner/repo/N` の形
*/
export function warnFailures(output: Output, target: string, failed: readonly AttributeFailureJson[]): void {
  for (const item of failed) output.warning(`could not set ${item.name} (${item.source}) of ${target}: ${item.reason}`)
}

/**
Markdown の 1 行。値の無いときは (none)
*/
export function changeLine(change: Readonly<AttributeChangeJson>): string {
  const show = (value: AttributeChangeJson['before']): string => value === null ? '(none)' : formatAttributeValue(value)
  return `- ${change.name}: ${show(change.before)} -> ${show(change.after)}`
}
