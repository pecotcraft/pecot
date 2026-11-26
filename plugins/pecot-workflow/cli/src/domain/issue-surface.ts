/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- graphql の AST と zod の型は変えられない */
// GitHub の Issue の機能の写し（SDL と OpenAPI から抜く項目）と、担保の一覧との照らし合わせ・今のスキーマとの差。
import type { ConstDirectiveNode, DefinitionNode, InputObjectTypeDefinitionNode, TypeNode } from 'graphql'
import { Kind, parse } from 'graphql'
import { z } from 'zod'

import { compareCodePoints } from './fuzzy.js'
import { isJsonObject, jsonField } from './json.js'
import type { JsonValue } from './python-format.js'

const INPUT_TYPES = ['CreateIssueInput', 'UpdateIssueInput', 'ProjectV2FieldValue']

const ENUM_TYPES: ReadonlySet<string> = new Set(['ProjectV2FieldType', 'ProjectV2CustomFieldType', 'IssueFieldDataType'])

const CREATE_ISSUE_PATH = '/repos/{owner}/{repo}/issues'

const COVERAGE_FILE = 'issue-coverage.yaml'

const SURFACE_FILE = 'github-issue-surface.json'

function namedTypeOf(type: TypeNode): string {
  return type.kind === Kind.NAMED_TYPE ? type.name.value : namedTypeOf(type.type)
}

function concreteTypesOf(directives: readonly ConstDirectiveNode[] | undefined): readonly string[] | undefined {
  const directive = directives?.find(candidate => candidate.name.value === 'possibleTypes')
  const value = directive?.arguments?.find(argument => argument.name.value === 'concreteTypes')?.value
  return value?.kind === Kind.LIST ? value.values.map(item => item.kind === Kind.STRING ? item.value : '') : undefined
}

// ID の項目のうち 1 つでも、受ける型が Issue だけのものがあるか（GitHub の @possibleTypes の目印で見る）
function hasIssueOnlyField(input: InputObjectTypeDefinitionNode | undefined): boolean {
  return (input?.fields ?? []).some((field) => {
    const types = concreteTypesOf(field.directives)
    return types?.length === 1 && types[0] === 'Issue'
  })
}

function enumItems(definitions: readonly DefinitionNode[]): string[] {
  return definitions.flatMap((definition) => {
    if (definition.kind !== Kind.ENUM_TYPE_DEFINITION || !ENUM_TYPES.has(definition.name.value)) return []
    const values = definition.values ?? []
    return values.map(value => `graphql:enum:${definition.name.value}.${value.name.value}`)
  })
}

function inputItems(inputs: ReadonlyMap<string, InputObjectTypeDefinitionNode>): string[] {
  return INPUT_TYPES.flatMap((name) => {
    const fields = inputs.get(name)?.fields ?? []
    return fields.map(field => `graphql:${name}.${field.name.value}`)
  })
}

function mutationItems(definitions: readonly DefinitionNode[], inputs: ReadonlyMap<string, InputObjectTypeDefinitionNode>): string[] {
  return definitions.flatMap((definition) => {
    if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION || definition.name.value !== 'Mutation') return []
    const fields = definition.fields ?? []
    return fields.filter((field) => {
      const argument = field.arguments?.find(candidate => candidate.name.value === 'input')
      return argument !== undefined && hasIssueOnlyField(inputs.get(namedTypeOf(argument.type)))
    }).map(field => `graphql:mutation:${field.name.value}`)
  })
}

function graphqlItems(definitions: readonly DefinitionNode[]): string[] {
  const inputs = new Map<string, InputObjectTypeDefinitionNode>()
  for (const definition of definitions) {
    if (definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION) inputs.set(definition.name.value, definition)
  }
  return [...enumItems(definitions), ...inputItems(inputs), ...mutationItems(definitions, inputs)]
}

function fieldAt(value: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined {
  let target = value
  for (const key of keys) target = jsonField(target, key)
  return target
}

// 文書の中を指す $ref（#/...）をたどる。外を指す・先が無いときは undefined
function resolveReference(document: JsonValue, value: JsonValue | undefined): JsonValue | undefined {
  const reference = jsonField(value, '$ref')
  if (reference === undefined) return value
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined
  return fieldAt(document, reference.slice(2).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')))
}

function restItems(openapi: JsonValue): string[] {
  const operation = fieldAt(openapi, ['paths', CREATE_ISSUE_PATH, 'post'])
  const body = resolveReference(openapi, jsonField(operation, 'requestBody'))
  const schema = resolveReference(openapi, fieldAt(body, ['content', 'application/json', 'schema']))
  const properties = jsonField(schema, 'properties')
  return isJsonObject(properties) ? Object.keys(properties).map(key => `rest:POST ${CREATE_ISSUE_PATH}#${key}`) : []
}

/**
公開スキーマの SDL と REST の OpenAPI から、写しの項目の id を符号位置の順で返す。
範囲の型が無ければその項目を出さない。SDL の構文の誤りは graphql の parse が投げる
*/
export function extractIssueSurface(sdl: string, openapi: JsonValue): string[] {
  return [...graphqlItems(parse(sdl).definitions), ...restItems(openapi)].toSorted(compareCodePoints)
}

const coverageEntrySchema = z.strictObject({
  id: z.string(),
  status: z.enum(['supported', 'excluded']),
  handler: z.string().optional(),
  tool: z.string().optional(),
  reason: z.string().optional(),
})

/**
担保の一覧（issue-coverage.yaml）の形。組み合わせの誤りは id を挙げるため checkIssueCoverage で見る
*/
export const issueCoverageSchema = z.strictObject({ items: z.array(coverageEntrySchema) })

export type IssueCoverage = z.infer<typeof issueCoverageSchema>

type CoverageEntry = IssueCoverage['items'][number]

/**
写し（github-issue-surface.json）の形
*/
export const issueSurfaceSchema = z.strictObject({
  sources: z.strictObject({ graphql: z.string(), rest: z.string(), rest_api_version: z.string(), fetched_at: z.string() }),
  items: z.array(z.string()),
})

export type IssueSurface = z.infer<typeof issueSurfaceSchema>

function entryProblems(entry: Readonly<CoverageEntry>, handlers: ReadonlySet<string>, tools: ReadonlySet<string>): string[] {
  const { handler, tool } = entry
  if (entry.status === 'excluded') {
    if (handler !== undefined || tool !== undefined) return ['excluded must not have handler or tool']
    return (entry.reason ?? '').trim() === '' ? ['excluded needs a reason'] : []
  }
  if (entry.reason !== undefined) return ['supported must not have a reason']
  if ((handler === undefined) === (tool === undefined)) return ['supported needs exactly one of handler or tool']
  if (handler !== undefined && !handlers.has(handler)) return [`handler ${handler} is not in ATTRIBUTE_HANDLERS`]
  if (tool !== undefined && !tools.has(tool)) return [`tool ${tool} is not an MCP tool of COMMANDS`]
  return []
}

/**
写しの項目と担保の一覧を照らし、問題を「id: 文」の形で id の順に返す。問題が無ければ空。
handlers は ATTRIBUTE_HANDLERS の鍵、tools は COMMANDS の MCP のツール名
*/
export function checkIssueCoverage(items: readonly string[], coverage: Readonly<IssueCoverage>, handlers: readonly string[], tools: readonly string[]): string[] {
  const surface = new Set(items)
  const handlerSet = new Set(handlers)
  const toolSet = new Set(tools)
  const seen = new Set<string>()
  const problems: (readonly [string, string])[] = []
  for (const entry of coverage.items) {
    if (seen.has(entry.id)) problems.push([entry.id, 'listed more than once'])
    seen.add(entry.id)
    if (!surface.has(entry.id)) problems.push([entry.id, `not in ${SURFACE_FILE}`])
    for (const problem of entryProblems(entry, handlerSet, toolSet)) problems.push([entry.id, problem])
  }
  for (const id of items) {
    if (!seen.has(id)) problems.push([id, `not in ${COVERAGE_FILE}`])
  }
  return problems
    .toSorted(([leftId, left], [rightId, right]) => compareCodePoints(leftId, rightId) || compareCodePoints(left, right))
    .map(([id, problem]) => `${id}: ${problem}`)
}

/**
写しと今の抜き出しの差。added は今にあって写しに無い id、removed は写しにあって今に無い id。どちらも符号位置の順
*/
export interface IssueSurfaceDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export function diffIssueSurface(snapshot: readonly string[], current: readonly string[]): IssueSurfaceDiff {
  const before = new Set(snapshot)
  const after = new Set(current)
  return {
    added: [...after].filter(id => !before.has(id)).toSorted(compareCodePoints),
    removed: [...before].filter(id => !after.has(id)).toSorted(compareCodePoints),
  }
}

export function hasIssueSurfaceDifference(diff: Readonly<IssueSurfaceDiff>): boolean {
  return diff.added.length > 0 || diff.removed.length > 0
}
