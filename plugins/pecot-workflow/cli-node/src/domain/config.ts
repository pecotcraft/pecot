// プロジェクト設定（.pecot/config/projects/*.json）のモデルと判定。ファイルの読み書きは infra/config-store.ts が行う。
//
// モデルは zod の schema で表す。読んだ値は読み取り専用（凍結）で、更新はコピーを作る。
// 検証エラーは、Python の CLI が出していた書式（表題は元のクラス名）の ValidationFailure にして投げる。
// 値が無いこと（null・未指定）は、読んだ後はどちらも undefined になり、保存では出さない。

import { z } from 'zod'

import { PecotError } from './errors.js'
import { isJsonObject, jsonField } from './json.js'
import { isJsonArray, pythonRepr, pythonStrip, pythonStringRepr, ValidationFailure } from './python-format.js'
import type { JsonValue, ValidationIssue } from './python-format.js'
import { parseOwnerRepository } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

const WorkflowStatusSchema = z.enum(['backlog', 'pending', 'ready', 'active', 'in_review', 'archived'])
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = WorkflowStatusSchema.options

const PrioritySchema = z.enum(['high', 'medium', 'low'])
export type Priority = z.infer<typeof PrioritySchema>
export const PRIORITIES: readonly Priority[] = PrioritySchema.options

const SizeSchema = z.enum(['xs', 's', 'm', 'l'])
export type Size = z.infer<typeof SizeSchema>
export const SIZES: readonly Size[] = SizeSchema.options

const NAME_PATTERN = /^[\w.-]+$/u
// zod が issue に入れる pattern（`/source/flags`）→ Python の文に出す正規表現の文字列
const PYTHON_PATTERN_TEXTS: ReadonlyMap<string, string> = new Map([[String(NAME_PATTERN), '^[A-Za-z0-9_.-]+$']])
const AGGREGATION_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/u

/**
オブジェクトの schema。型が違うときの issue の message に、元のクラス名を入れる
*/
function model<Shape extends z.core.$ZodShape>(name: string, shape: Shape): z.ZodObject<Shape> {
  return z.object(shape, { error: () => name })
}

/**
`X | None = None` に当たる文字列。null と未指定は、どちらも undefined にする
*/
const optionalString = z.string().nullish().transform(value => value ?? undefined)

// int の lax な変換。bool は 0・1、前後の空白・符号・数字の間の `_`・小数部が 0 だけの文字列は整数にする。
// 変換できない値はそのまま渡し、z.int() が型の誤りにする。
export function convertToInteger(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return value
  const text = pythonStrip(value)
  const isUnderscoreSeparatedDigits = text.replace(/^[+-]/u, '').split('_').every(group => /^\d+$/u.test(group))
  if (isUnderscoreSeparatedDigits) return Number(text.replaceAll('_', ''))
  if (/^[+-]?\d+\.0+$/u.test(text)) return Number(text.slice(0, text.indexOf('.'))) + 0 // -0 を 0 にする
  return value
}
const laxInteger = z.preprocess(convertToInteger, z.int())

const FieldOptionsSchema = model('FieldOptions', {
  id: z.string(),
  options: z.record(z.string(), z.string()).readonly(),
}).readonly()

const ProjectFieldsSchema = model('ProjectFields', {
  workflow: FieldOptionsSchema,
  priority: FieldOptionsSchema.nullish().transform(value => value ?? undefined),
  size: FieldOptionsSchema.nullish().transform(value => value ?? undefined),
}).readonly()

const ProjectSchema = model('Project', {
  number: laxInteger,
  id: z.string(),
  board_url: optionalString,
  fields: ProjectFieldsSchema,
}).readonly()

const PackageSchema = model('Package', {
  name: z.string().min(1, { abort: true }).regex(NAME_PATTERN),
  changelog: z.string().min(1),
}).readonly()

const ReleaseTypeSchema = z.enum(['single', 'multi', 'nx'])
export type ReleaseType = z.infer<typeof ReleaseTypeSchema>

const RepositorySchema = model('Repository', {
  owner: z.string(),
  name: z.string(),
  develop_branch: optionalString,
  release_branch: optionalString,
  changelog_file: optionalString,
  packages: z.array(PackageSchema).readonly().nullish().transform(value => value ?? undefined),
  release_type: ReleaseTypeSchema.nullish().transform(value => value ?? undefined),
}).superRefine((repository, context) => {
  // monorepo 構成（packages あり）では CHANGELOG は package ごとに管理するので、リポ全体の changelog_file は意味を持たない
  const hasPackages = repository.packages !== undefined && repository.packages.length > 0
  if (hasPackages && repository.changelog_file !== undefined && repository.changelog_file !== '') {
    context.addIssue({
      code: 'custom',
      message: 'Value error, changelog_file and packages cannot be set together; in a monorepo, use packages[].changelog instead',
      params: { type: 'value_error' },
    })
  }
}).readonly()

const ProjectConfigSchema = model('ProjectConfig', {
  host: z.string(),
  owner: z.string(),
  workflow_suffix: z.string(),
  project: ProjectSchema,
  repositories: z.array(RepositorySchema).readonly().default([]),
  aggregation_repo: z.string().superRefine((value, context) => {
    if (!AGGREGATION_REPOSITORY_PATTERN.test(value)) {
      context.addIssue({
        code: 'custom',
        message: `Value error, aggregation_repo must be in 'owner/repo' form: ${pythonStringRepr(value)}`,
        params: { type: 'value_error' },
      })
    }
  }).nullish().transform(value => value ?? undefined),
}).readonly()

export type FieldOptions = z.infer<typeof FieldOptionsSchema>
export type Package = z.infer<typeof PackageSchema>
export type Repository = z.infer<typeof RepositorySchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/**
プロジェクトにリンクされたリポジトリ。判定の問い合わせ先（GitHub）の実体は infra が持つ
*/
export interface LinkedRepository {
  readonly owner: string
  readonly name: string
}

export interface RepositoryMembership {
  readonly linkedRepositories: (owner: string, projectNumber: number) => Promise<readonly LinkedRepository[]>
}

export class ConfigError extends PecotError {}

export class MultipleConfigsError extends ConfigError {
  readonly files: readonly string[]

  constructor(files: readonly string[]) {
    const names = files.map(file => file.slice(file.lastIndexOf('/') + 1))
    super(`multiple config files found: ${pythonRepr(names)}`)
    this.files = files
  }
}

// 検証エラーの変換

function valueAt(root: JsonValue, location: readonly (string | number)[]): JsonValue | undefined {
  let current: JsonValue | undefined = root
  for (const key of location) {
    if (isJsonArray(current)) current = current[Number(key)]
    else if (isJsonObject(current)) current = jsonField(current, String(key))
    else return undefined
  }
  return current
}

function quotedChoices(values: readonly unknown[]): string {
  const quoted = values.map(value => pythonStringRepr(String(value)))
  const last = quoted.at(-1)
  return last === undefined || quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${last}`
}

function integerIssue(input: JsonValue | undefined): Pick<ValidationIssue, 'type' | 'message'> {
  if (typeof input === 'string') return { type: 'int_parsing', message: 'Input should be a valid integer, unable to parse string as an integer' }
  if (typeof input !== 'number') return { type: 'int_type', message: 'Input should be a valid integer' }
  if (!Number.isFinite(input)) return { type: 'finite_number', message: 'Input should be a finite number' }
  return { type: 'int_from_float', message: 'Input should be a valid integer, got a number with a fractional part' }
}

/**
zod の issue のうち、変換に使う項目
*/
interface SchemaIssueView {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
  readonly expected?: string
  readonly values?: readonly unknown[]
  readonly minimum?: unknown
  readonly pattern?: unknown
}

function invalidTypeIssue(expected: string | undefined, modelName: string, location: readonly (string | number)[], input: JsonValue | undefined): ValidationIssue {
  if (input === undefined) return { type: 'missing', location, message: 'Field required', input: undefined }
  if (expected === 'string') return { type: 'string_type', location, message: 'Input should be a valid string', input }
  if (expected === 'int' || expected === 'number') return { ...integerIssue(input), location, input }
  if (expected === 'array') return { type: 'list_type', location, message: 'Input should be a valid list', input }
  if (expected === 'record') return { type: 'dict_type', location, message: 'Input should be a valid dictionary', input }
  return { type: 'model_type', location, message: `Input should be a valid dictionary or instance of ${modelName}`, input }
}

function toValidationIssue(issue: SchemaIssueView, root: JsonValue): ValidationIssue {
  const location = issue.path.map(key => typeof key === 'symbol' ? String(key) : key)
  const input = valueAt(root, location)
  if (issue.code === 'invalid_type') {
    // 値が無いときの input は、その項目を持つはずの親（Python の入力辞書）
    const base = invalidTypeIssue(issue.expected, issue.message, location, input)
    return base.type === 'missing' ? { ...base, input: valueAt(root, location.slice(0, -1)) } : base
  }
  if (issue.code === 'invalid_value') return { type: 'literal_error', location, message: `Input should be ${quotedChoices(issue.values ?? [])}`, input }
  if (issue.code === 'too_small') {
    const minimum = Number(issue.minimum)
    return { type: 'string_too_short', location, message: `String should have at least ${String(minimum)} character${minimum === 1 ? '' : 's'}`, input }
  }
  if (issue.code === 'invalid_format') {
    // Python の文には、Python 側の正規表現の書き方（lint が書き換える前の形）がそのまま入る
    const pattern = PYTHON_PATTERN_TEXTS.get(String(issue.pattern)) ?? String(issue.pattern)
    return { type: 'string_pattern_mismatch', location, message: `String should match pattern ${pythonStringRepr(pattern)}`, input }
  }
  return { type: 'value_error', location, message: issue.message, input }
}

/**
JSON の値からプロジェクト設定を作る。形が不正なら ValidationFailure（表題は ProjectConfig）
*/
export function parseProjectConfig(data: JsonValue): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(data)
  if (!result.success) throw new ValidationFailure('ProjectConfig', result.error.issues.map(issue => toValidationIssue(issue, data)))
  return result.data
}

/**
設定ファイルの中身。2 スペースのインデントで、末尾に改行を置く。
値の無い項目は出さず、非 ASCII の文字はそのまま出す。
キーの順はモデルの定義順
*/
export function serializeProjectConfig(config: ProjectConfig): string {
  return `${JSON.stringify(config, undefined, 2)}\n`
}

// 検索

export function workflowFieldName(config: ProjectConfig): string {
  return `pecot-workflow-${config.workflow_suffix}`
}

function fieldOf(config: ProjectConfig, fieldName: string): FieldOptions | undefined {
  switch (fieldName) {
    case 'workflow': { return config.project.fields.workflow }
    case 'priority': { return config.project.fields.priority }
    case 'size': { return config.project.fields.size }
    default: { return undefined }
  }
}

export function getFieldId(config: ProjectConfig, fieldName: string): string | undefined {
  return fieldOf(config, fieldName)?.id
}

export function getOptionId(config: ProjectConfig, fieldName: string, optionName: string): string | undefined {
  const options = fieldOf(config, fieldName)?.options
  return options === undefined ? undefined : new Map(Object.entries(options)).get(optionName)
}

export function findRepository(config: ProjectConfig, owner: string, name: string): Repository | undefined {
  return config.repositories.find(repository => repository.owner === owner && repository.name === name)
}

/**
owner を指定せずに名前だけで探す（アクティブ設定内の検索用）
*/
export function findRepositoryByName(config: ProjectConfig, name: string): Repository | undefined {
  return config.repositories.find(repository => repository.name === name)
}

/**
設定の repositories の 1 件の `owner/name`
*/
export function configuredRepositoryFullName(repository: Repository): string {
  return `${repository.owner}/${repository.name}`
}

export function findPackage(repository: Repository, name: string): Package | undefined {
  return repository.packages?.find(item => item.name === name)
}

/**
release_type が未指定なら、packages の有無から決める（あれば multi、無ければ single）
*/
export function effectiveReleaseType(repository: Repository): ReleaseType {
  if (repository.release_type !== undefined) return repository.release_type
  return repository.packages !== undefined && repository.packages.length > 0 ? 'multi' : 'single'
}

export function getDevelopBranch(config: ProjectConfig, owner: string, name: string): string | undefined {
  return findRepository(config, owner, name)?.develop_branch
}

export function getReleaseBranch(config: ProjectConfig, owner: string, name: string): string | undefined {
  return findRepository(config, owner, name)?.release_branch
}

/**
aggregation_repo を RepositoryReference にする（未設定なら undefined）
*/
export function aggregationRepositoryReference(config: ProjectConfig): RepositoryReference | undefined {
  return config.aggregation_repo === undefined || config.aggregation_repo === '' ? undefined : parseOwnerRepository(config.aggregation_repo)
}

/**
リポジトリがプロジェクトにリンクされているか。リンクの一覧は membership に問い合わせる
*/
export async function isRepositoryInProject(config: ProjectConfig, owner: string, name: string, membership: RepositoryMembership): Promise<boolean> {
  const linked = await membership.linkedRepositories(config.owner, config.project.number)
  return linked.some(repository => repository.owner === owner && repository.name === name)
}

// 更新（コピーを作る）

/**
aggregation_repo を差し替えたコピー。undefined なら外す。値の形式は検証しない（呼び出し側が先に検証する）
*/
export function withAggregationRepository(config: ProjectConfig, value: string | undefined): ProjectConfig {
  return Object.freeze({ ...config, aggregation_repo: value })
}

/**
リポジトリを末尾に足したコピー
*/
export function withRepositoryAppended(config: ProjectConfig, repository: Repository): ProjectConfig {
  return Object.freeze({ ...config, repositories: Object.freeze([...config.repositories, repository]) })
}
