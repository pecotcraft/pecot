/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- graphql の AST の型は変えられない */
// GitHub の公開スキーマ（SDL）と REST の OpenAPI を取り、Issue の機能の写しの項目を抜く。どちらも認証なしで取れる。
import type { ConstDirectiveNode, DefinitionNode, InputObjectTypeDefinitionNode, TypeNode } from 'graphql'
import { Kind, parse } from 'graphql'

import { compareCodePoints } from '@pecot/workflow-core/domain/fuzzy.js'
import type { IssueSurface } from '@pecot/workflow-core/domain/issue-surface.js'
import { isJsonObject, jsonField, parseJsonText } from '@pecot/workflow-core/domain/json.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'

export const GRAPHQL_SCHEMA_URL = 'https://docs.github.com/public/fpt/schema.docs.graphql'

const REST_DESCRIPTION_BASE = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com'

const FETCH_TIMEOUT_MS = 120_000

const INPUT_TYPES = ['CreateIssueInput', 'UpdateIssueInput', 'ProjectV2FieldValue']

const ENUM_TYPES: ReadonlySet<string> = new Set(['ProjectV2FieldType', 'ProjectV2CustomFieldType', 'IssueFieldDataType'])

const CREATE_ISSUE_PATH = '/repos/{owner}/{repo}/issues'

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

export function restDescriptionUrl(apiVersion: string): string {
  return `${REST_DESCRIPTION_BASE}/api.github.com.${apiVersion}.json`
}

interface IssueSurfaceSources {
  readonly sdl: string
  readonly openapi: JsonValue
  readonly sources: IssueSurface['sources']
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${url} failed: ${String(response.status)} ${response.statusText}`)
  return response.text()
}

async function fetchJson(url: string): Promise<JsonValue> {
  return parseJsonText(await fetchText(url))
}

/**
SDL と、apiVersion の版の OpenAPI を取る。sources には取った URL・版・取り始めの日時を入れる。
取れないときと OpenAPI が JSON でないときは投げる
*/
export async function fetchIssueSurfaceSources(apiVersion: string): Promise<IssueSurfaceSources> {
  const fetchedAt = new Date().toISOString()
  const rest = restDescriptionUrl(apiVersion)
  const [sdl, openapi] = await Promise.all([fetchText(GRAPHQL_SCHEMA_URL), fetchJson(rest)])
  return { sdl, openapi, sources: { graphql: GRAPHQL_SCHEMA_URL, rest, rest_api_version: apiVersion, fetched_at: fetchedAt } }
}
