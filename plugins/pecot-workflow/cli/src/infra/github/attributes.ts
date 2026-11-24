// Issue の機能（ボードのフィールド・Issue fields・Issue の組み込み）の定義と値を、GraphQL で読む。
// 読めない部分（権限の無いボード・Issue fields など）は warnings に回し、読めた分を返す。

import {
  builtinDefinitions,
  builtinReadings,
  issueFieldDefinition,
  issueFieldValueKind,
  projectFieldDefinition,
  projectValueTreatment,
} from '../../domain/attributes.js'
import type {
  AttributeDefinition,
  AttributeKind,
  AttributeOption,
  AttributeReading,
  AttributeValue,
  ProjectFieldShape,
  UnsupportedAttribute,
} from '../../domain/attributes.js'
import { jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { GitHubClientBase, GraphqlOutcome, PathPredicate } from './client.js'
import { asNotFoundError, GitHubNotFoundError } from './errors.js'
import { asArray, isTruthy, truthyNodes } from './payload.js'
import {
  QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS,
  QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS_WITHOUT_ISSUE_FIELDS,
  QUERY_GET_ISSUE_ATTRIBUTES,
  QUERY_GET_ISSUE_ATTRIBUTES_WITHOUT_ISSUE_FIELDS,
  QUERY_GET_REPOSITORY_LABELS_PAGE,
  QUERY_GET_REPOSITORY_MILESTONES_PAGE,
  QUERY_HAS_ISSUE_FIELDS,
} from './queries.js'

/**
読み込みに使うクライアントの操作。GitHubClient が満たす
*/
export type AttributesClient = Pick<GitHubClientBase, 'executeGraphql' | 'executeGraphqlTolerating'>

export interface DefinitionsTarget {
  readonly owner: string
  readonly repository: string
  readonly projectId: string
  readonly workflowFieldId: string
}

export interface AttributeDefinitions {
  readonly definitions: readonly AttributeDefinition[]
  readonly warnings: readonly string[]
}

export interface ValuesTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
  readonly projectId: string
}

export interface AttributeValues {
  readonly readings: readonly AttributeReading[]
  readonly unsupported: readonly UnsupportedAttribute[]
  readonly warnings: readonly string[]
}

const PAGE_SIZE = 100

const ISSUE_FIELD_VALUE_TYPE = 'ProjectV2ItemIssueFieldValue'

// ボードの値の型ごとに、値を読む。値が無ければ undefined
type ValueReader = (node: JsonValue) => AttributeValue | undefined

const PROJECT_VALUE_READERS: ReadonlyMap<string, ValueReader> = new Map<string, ValueReader>([
  ['ProjectV2ItemFieldDateValue', (node: JsonValue) => stringValue(jsonField(node, 'date'))],
  ['ProjectV2ItemFieldIterationValue', (node: JsonValue) => stringValue(jsonField(node, 'title'))],
  ['ProjectV2ItemFieldMultiSelectValue', (node: JsonValue) => namesOf(jsonField(node, 'options'), 'name')],
  ['ProjectV2ItemFieldNumberValue', (node: JsonValue) => numberValue(jsonField(node, 'number'))],
  ['ProjectV2ItemFieldSingleSelectValue', (node: JsonValue) => stringValue(jsonField(node, 'name'))],
  ['ProjectV2ItemFieldTextValue', (node: JsonValue) => stringValue(jsonField(node, 'text'))],
])

const ISSUE_FIELD_VALUE_READERS: ReadonlyMap<string, ValueReader> = new Map<string, ValueReader>([
  ['IssueFieldDateValue', (node: JsonValue) => stringValue(jsonField(node, 'value'))],
  ['IssueFieldMultiSelectValue', (node: JsonValue) => namesOf(jsonField(node, 'options'), 'name')],
  ['IssueFieldNumberValue', (node: JsonValue) => numberValue(jsonField(node, 'numberValue'))],
  ['IssueFieldSingleSelectValue', (node: JsonValue) => stringValue(jsonField(node, 'name'))],
  ['IssueFieldTextValue', (node: JsonValue) => stringValue(jsonField(node, 'value'))],
])

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function namesOf(list: JsonValue | undefined, key: string): readonly string[] {
  return asArray(list).map(node => jsonField(node, key)).filter(name => typeof name === 'string')
}

function hasNextPage(connection: JsonValue | undefined): boolean {
  return jsonField(jsonField(connection, 'pageInfo'), 'hasNextPage') === true
}

function isUnder(path: readonly JsonValue[], prefix: readonly string[]): boolean {
  return prefix.every((key, index) => path.at(index) === key)
}

function messagesUnder(errors: readonly JsonObject[], prefix: readonly string[]): readonly string[] {
  return errors.filter(error => isUnder(asArray(error['path']), prefix)).map((error) => {
    const message = error['message']
    return typeof message === 'string' ? message : ''
  })
}

function failureWarning(subject: string, messages: readonly string[]): readonly string[] {
  return messages.length === 0 ? [] : [`could not read ${subject}: ${messages.join('; ')}`]
}

async function hasIssueFieldTypes(client: AttributesClient): Promise<boolean> {
  const result = await client.executeGraphql(QUERY_HAS_ISSUE_FIELDS, {})
  return jsonField(result, '__type') !== JSON_NULL
}

async function queryTolerating(client: AttributesClient, query: string, variables: Readonly<Record<string, JsonValue>>, isTolerated: PathPredicate): Promise<GraphqlOutcome> {
  try {
    return await client.executeGraphqlTolerating(query, variables, isTolerated)
  }
  catch (error: unknown) {
    throw asNotFoundError(error)
  }
}

function requireRepository(data: JsonObject, owner: string, repository: string): JsonValue {
  const node = jsonField(data, 'repository')
  if (!isTruthy(node)) throw new GitHubNotFoundError(`repository not found: ${owner}/${repository}`)
  return node ?? JSON_NULL
}

function iterationOption(iteration: JsonValue): AttributeOption | undefined {
  const name = jsonField(iteration, 'title')
  const startDate = jsonField(iteration, 'startDate')
  return typeof name === 'string' ? { name, ...typeof startDate === 'string' && { startDate } } : undefined
}

function optionsOfProjectField(node: JsonValue): readonly AttributeOption[] {
  const iterationSetup = jsonField(node, 'configuration')
  if (isTruthy(iterationSetup)) {
    const iterations = [...asArray(jsonField(iterationSetup, 'iterations')), ...asArray(jsonField(iterationSetup, 'completedIterations'))]
    return iterations.map(iteration => iterationOption(iteration)).filter(option => option !== undefined)
  }
  const options = jsonField(node, 'multiSelectOptions') ?? jsonField(node, 'options')
  return namesOf(options, 'name').map(name => ({ name }))
}

function projectFieldShape(node: JsonValue): ProjectFieldShape | undefined {
  const id = jsonField(node, 'id')
  const name = jsonField(node, 'name')
  const dataType = jsonField(node, 'dataType')
  return typeof id === 'string' && typeof name === 'string' && typeof dataType === 'string'
    ? { id, name, dataType, isIssueField: jsonField(node, 'isIssueField') === true, options: optionsOfProjectField(node) }
    : undefined
}

async function remainingNames(client: AttributesClient, query: string, connectionKey: string, nameKey: string, target: Readonly<DefinitionsTarget>, first: JsonValue | undefined): Promise<readonly string[]> {
  const names = [...namesOf(jsonField(first, 'nodes'), nameKey)]
  let connection = first
  while (hasNextPage(connection)) {
    const after = jsonField(jsonField(connection, 'pageInfo'), 'endCursor')
    if (typeof after !== 'string') break
    const data = await client.executeGraphql(query, { owner: target.owner, repo: target.repository, after })
    connection = jsonField(jsonField(data, 'repository'), connectionKey)
    names.push(...namesOf(jsonField(connection, 'nodes'), nameKey))
  }
  return names
}

function isDefinitionsTolerated(path: readonly JsonValue[]): boolean {
  return isUnder(path, ['project']) || isUnder(path, ['repository', 'issueFields']) || isUnder(path, ['repository', 'issueTypes'])
}

/**
設定のボードのフィールドと、リポの Issue fields・Issue type・ラベル・開いたマイルストーンの定義を読む。
ボード・Issue fields・Issue type を読めない部分エラーは、warnings に 1 行ずつ入れ、残りを返す
*/
export async function readAttributeDefinitions(client: AttributesClient, target: Readonly<DefinitionsTarget>): Promise<AttributeDefinitions> {
  const hasIssueFields = await hasIssueFieldTypes(client)
  const query = hasIssueFields ? QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS : QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS_WITHOUT_ISSUE_FIELDS
  const { data, errors } = await queryTolerating(client, query, { owner: target.owner, repo: target.repository, projectId: target.projectId }, isDefinitionsTolerated)
  const repository = requireRepository(data, target.owner, target.repository)
  const repositoryName = `${target.owner}/${target.repository}`

  const projectMessages = messagesUnder(errors, ['project'])
  const fields = jsonField(jsonField(data, 'project'), 'fields')
  const projectWarnings = projectMessages.length > 0 || isTruthy(fields)
    ? failureWarning('the fields of the board', projectMessages)
    : [`could not read the fields of the board: project ${target.projectId} was not found`]
  const projectDefinitions = truthyNodes(fields).flatMap((node) => {
    const shape = projectFieldShape(node)
    const definition = shape === undefined ? undefined : projectFieldDefinition(shape, target.workflowFieldId)
    return definition === undefined ? [] : [definition]
  })

  const issueFields = jsonField(repository, 'issueFields')
  const issueFieldDefinitions = truthyNodes(issueFields).flatMap((node) => {
    const name = jsonField(node, 'name')
    const dataType = jsonField(node, 'dataType')
    return typeof name === 'string' && typeof dataType === 'string' ? [issueFieldDefinition({ name, dataType, options: namesOf(jsonField(node, 'options'), 'name').map(option => ({ name: option })) })] : []
  })
  const issueTypes = jsonField(repository, 'issueTypes')
  const issueTypeMessages = messagesUnder(errors, ['repository', 'issueTypes'])

  const labels = await remainingNames(client, QUERY_GET_REPOSITORY_LABELS_PAGE, 'labels', 'name', target, jsonField(repository, 'labels'))
  const milestones = await remainingNames(client, QUERY_GET_REPOSITORY_MILESTONES_PAGE, 'milestones', 'title', target, jsonField(repository, 'milestones'))
  const builtins = builtinDefinitions({
    milestones,
    issueTypes: hasIssueFields && issueTypeMessages.length === 0 ? namesOf(jsonField(issueTypes, 'nodes'), 'name') : undefined,
    labels,
  })

  const warnings = [
    ...projectWarnings,
    ...hasNextPage(fields) ? [`read only the first ${String(PAGE_SIZE)} fields of the board`] : [],
    ...failureWarning(`the Issue types of ${repositoryName}`, issueTypeMessages),
    ...hasNextPage(issueTypes) ? [`read only the first ${String(PAGE_SIZE)} Issue types of ${repositoryName}`] : [],
    ...failureWarning(`the Issue fields of ${repositoryName}`, messagesUnder(errors, ['repository', 'issueFields'])),
    ...hasNextPage(issueFields) ? [`read only the first ${String(PAGE_SIZE)} Issue fields of ${repositoryName}`] : [],
  ]
  return { definitions: [...projectDefinitions, ...issueFieldDefinitions, ...builtins], warnings }
}

interface ClassifiedValues {
  readonly readings: readonly AttributeReading[]
  readonly unsupported: readonly UnsupportedAttribute[]
  readonly warnings: readonly string[]
}

const EMPTY_CLASSIFIED: ClassifiedValues = { readings: [], unsupported: [], warnings: [] }

function merge(parts: readonly ClassifiedValues[]): ClassifiedValues {
  return {
    readings: parts.flatMap(part => part.readings),
    unsupported: parts.flatMap(part => part.unsupported),
    warnings: parts.flatMap(part => part.warnings),
  }
}

function isPresent(value: AttributeValue | undefined): value is AttributeValue {
  return value !== undefined && !(Array.isArray(value) && value.length === 0)
}

function readingOf(name: string, source: AttributeReading['source'], kind: AttributeKind, value: AttributeValue | undefined): ClassifiedValues {
  return isPresent(value) ? { ...EMPTY_CLASSIFIED, readings: [{ name, source, kind, value }] } : EMPTY_CLASSIFIED
}

function typenameOf(node: JsonValue): string {
  const typename = jsonField(node, '__typename')
  return typeof typename === 'string' ? typename : ''
}

function projectValue(node: JsonValue, issueText: string): ClassifiedValues {
  const typename = typenameOf(node)
  if (typename === ISSUE_FIELD_VALUE_TYPE) return EMPTY_CLASSIFIED
  const field = jsonField(node, 'field')
  const name = jsonField(field, 'name')
  const dataType = jsonField(field, 'dataType')
  if (typeof name !== 'string' || typeof dataType !== 'string') {
    return { ...EMPTY_CLASSIFIED, warnings: [`could not read a board value of the unknown type ${typename} on ${issueText}`] }
  }
  const treatment = projectValueTreatment(dataType, jsonField(field, 'isIssueField') === true)
  if (treatment.treatment === 'skip') return EMPTY_CLASSIFIED
  const reader = PROJECT_VALUE_READERS.get(typename)
  return reader === undefined || treatment.treatment === 'unsupported'
    ? { ...EMPTY_CLASSIFIED, unsupported: [{ name, source: 'project', githubType: dataType }] }
    : readingOf(name, 'project', treatment.kind, reader(node))
}

function issueFieldValue(node: JsonValue, issueText: string): ClassifiedValues {
  const typename = typenameOf(node)
  const field = jsonField(node, 'field')
  const name = jsonField(field, 'name')
  const dataType = jsonField(field, 'dataType')
  if (typeof name !== 'string' || typeof dataType !== 'string') {
    return { ...EMPTY_CLASSIFIED, warnings: [`could not read an Issue field value of the unknown type ${typename} on ${issueText}`] }
  }
  const kind = issueFieldValueKind(dataType)
  const reader = ISSUE_FIELD_VALUE_READERS.get(typename)
  return reader === undefined || kind === 'unsupported'
    ? { ...EMPTY_CLASSIFIED, unsupported: [{ name, source: 'issue_field', githubType: dataType }] }
    : readingOf(name, 'issue_field', kind, reader(node))
}

const PROJECT_ITEMS_PATH = ['repository', 'issue', 'projectItems']
const ISSUE_FIELD_VALUES_PATH = ['repository', 'issue', 'issueFieldValues']

function isValuesTolerated(path: readonly JsonValue[]): boolean {
  return isUnder(path, PROJECT_ITEMS_PATH) || isUnder(path, ISSUE_FIELD_VALUES_PATH)
}

/**
Issue 1 件の、値の入っている機能を読む。ボードの値は設定のボードのものだけ。parent・blocked_by は含めない。
ボード・Issue fields を読めない部分エラーは、warnings に 1 行ずつ入れ、残りを返す
*/
export async function readAttributeValues(client: AttributesClient, target: Readonly<ValuesTarget>): Promise<AttributeValues> {
  const hasIssueFields = await hasIssueFieldTypes(client)
  const query = hasIssueFields ? QUERY_GET_ISSUE_ATTRIBUTES : QUERY_GET_ISSUE_ATTRIBUTES_WITHOUT_ISSUE_FIELDS
  const { data, errors } = await queryTolerating(client, query, { owner: target.owner, repo: target.repository, number: target.number }, isValuesTolerated)
  const issueText = `${target.owner}/${target.repository}/${String(target.number)}`
  const issue = jsonField(requireRepository(data, target.owner, target.repository), 'issue')
  if (!isTruthy(issue)) throw new GitHubNotFoundError(`Issue not found: ${issueText}`)

  const assignees = jsonField(issue, 'assignees')
  const labels = jsonField(issue, 'labels')
  const milestone = stringValue(jsonField(jsonField(issue, 'milestone'), 'title'))
  const issueType = stringValue(jsonField(jsonField(issue, 'issueType'), 'name'))
  const builtins = builtinReadings({ assignees: namesOf(jsonField(assignees, 'nodes'), 'login'), milestone, issueType, labels: namesOf(jsonField(labels, 'nodes'), 'name') })

  const issueFieldValues = jsonField(issue, 'issueFieldValues')
  const issueFieldParts = merge(truthyNodes(issueFieldValues).map(node => issueFieldValue(node, issueText)))

  const projectItems = jsonField(issue, 'projectItems')
  const item = truthyNodes(projectItems).find(node => jsonField(jsonField(node, 'project'), 'id') === target.projectId)
  const fieldValues = jsonField(item, 'fieldValues')
  const projectParts = merge(truthyNodes(fieldValues).map(node => projectValue(node, issueText)))

  const warnings = [
    ...hasNextPage(assignees) ? [`read only the first ${String(PAGE_SIZE)} assignees of ${issueText}`] : [],
    ...hasNextPage(labels) ? [`read only the first ${String(PAGE_SIZE)} labels of ${issueText}`] : [],
    ...failureWarning(`the Issue fields of ${issueText}`, messagesUnder(errors, ISSUE_FIELD_VALUES_PATH)),
    ...hasNextPage(issueFieldValues) ? [`read only the first ${String(PAGE_SIZE)} Issue field values of ${issueText}`] : [],
    ...failureWarning(`the board fields of ${issueText}`, messagesUnder(errors, PROJECT_ITEMS_PATH)),
    ...hasNextPage(projectItems) ? [`read only the first ${String(PAGE_SIZE)} project items of ${issueText}`] : [],
    ...hasNextPage(fieldValues) ? [`read only the first ${String(PAGE_SIZE)} board values of ${issueText}`] : [],
    ...projectParts.warnings,
    ...issueFieldParts.warnings,
  ]
  return {
    readings: [...projectParts.readings, ...issueFieldParts.readings, ...builtins],
    unsupported: [...projectParts.unsupported, ...issueFieldParts.unsupported],
    warnings,
  }
}
