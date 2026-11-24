/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// Issue の機能の偽の応答（HasIssueFields・GetIssueAttributes・GetIssueAttributeDefinitions）。
// 応答は 2026-11-23 に取った公開スキーマの型に合わせる。
import type { ResponseRule } from '../fake-github/server.js'

const page = (nodes: readonly unknown[]): Record<string, unknown> => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes })

export function issueFieldsProbeRule(isSupported = true, times = 1): ResponseRule {
  return { match: { operation: 'HasIssueFields' }, respond: { status: 200, body: { data: { __type: isSupported ? { name: 'IssueFields' } : null } } }, times }
}

export interface IssueAttributesSpec {
  readonly assignees?: readonly string[]
  readonly milestone?: string
  readonly issueType?: string
  readonly labels?: readonly string[]
  readonly issueFieldValues?: readonly unknown[]
  /**
  設定のボード（PVT_1）の Item の fieldValues の項
  */
  readonly fieldValues?: readonly unknown[]
  /**
  偽なら、Issue を設定のボードに載せない
  */
  readonly isOnBoard?: boolean
}

/**
GetIssueAttributes の data。既定は、値の入った機能が無い Issue
*/
export function issueAttributesData(spec: Readonly<IssueAttributesSpec> = {}): Record<string, unknown> {
  const { assignees = [], milestone, issueType, labels = [], issueFieldValues = [], fieldValues = [], isOnBoard = true } = spec
  return {
    repository: {
      issue: {
        assignees: page(assignees.map(login => ({ login }))),
        milestone: milestone === undefined ? null : { title: milestone },
        labels: page(labels.map(name => ({ name }))),
        issueType: issueType === undefined ? null : { name: issueType },
        issueFieldValues: page(issueFieldValues),
        projectItems: page(isOnBoard ? [{ id: 'PVTI_1', project: { id: 'PVT_1' }, fieldValues: page(fieldValues) }] : []),
      },
    },
  }
}

/**
issue show が値を読む 2 つの要求の応答
*/
export function attributeRules(spec: Readonly<IssueAttributesSpec> = {}, times = 1): readonly ResponseRule[] {
  return [
    issueFieldsProbeRule(true, times),
    { match: { operation: 'GetIssueAttributes' }, respond: { status: 200, body: { data: issueAttributesData(spec) } }, times },
  ]
}

/**
ボードの値の項。field は ProjectV2FieldCommon の id・name・dataType・isIssueField
*/
export function boardValue(typename: string, name: string, dataType: string, value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { __typename: typename, field: { id: `F_${name}`, name, dataType, isIssueField: false }, ...value }
}

const projectField = (id: string, name: string, dataType: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({ id, name, dataType, isIssueField: false, ...extra })

/**
GetIssueAttributeDefinitions の既定のボードのフィールド。計算するもの・Issue の機能を写すもの・Status・進行の欄・Issue field を写したものを含む
*/
export const BOARD_FIELDS: readonly unknown[] = [
  projectField('F_title', 'Title', 'TITLE'),
  projectField('F_assignees', 'Assignees', 'ASSIGNEES'),
  projectField('F_status', 'Status', 'SINGLE_SELECT', { options: [{ id: 'O_todo', name: 'Todo' }, { id: 'O_done', name: 'Done' }] }),
  projectField('PVTSSF_workflow', 'pecot-workflow-acme', 'SINGLE_SELECT', { options: [{ id: 'O_ready', name: 'Ready' }] }),
  projectField('F_area', 'Area', 'SINGLE_SELECT', { options: [{ id: 'O_cli', name: 'cli' }, { id: 'O_docs', name: 'docs' }] }),
  projectField('F_sprint', 'Sprint', 'ITERATION', { configuration: { iterations: [{ id: 'I_2', title: 'Sprint 2', startDate: '2026-11-16' }], completedIterations: [] } }),
  projectField('F_priority', 'Priority', 'SINGLE_SELECT', { isIssueField: true, options: [{ id: 'O_high', name: 'High' }] }),
]

export interface DefinitionsSpec {
  readonly fields?: readonly unknown[]
  readonly issueFields?: readonly unknown[] | null
  readonly issueTypes?: readonly string[]
  readonly labels?: unknown
  readonly milestones?: unknown
}

/**
GetIssueAttributeDefinitions の data。issueFields に null を渡すと、読めなかった形にする
*/
export function definitionsData(spec: Readonly<DefinitionsSpec> = {}): Record<string, unknown> {
  const { fields = BOARD_FIELDS, issueFields = [{ fullDatabaseId: '101', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ name: 'High' }, { name: 'Low' }] }, { fullDatabaseId: '103', name: 'Effort', dataType: 'NUMBER' }], issueTypes = ['Bug', 'Task'] } = spec
  return {
    project: { fields: page(fields) },
    repository: {
      issueTypes: page(issueTypes.map(name => ({ name }))),
      issueFields: issueFields === null ? null : page(issueFields),
      labels: spec.labels ?? page([{ name: 'bug' }]),
      milestones: spec.milestones ?? page([{ number: 3, title: 'v1' }]),
    },
  }
}

/**
issue attributes が定義を読む 2 つの要求の応答
*/
export function definitionRules(spec: Readonly<DefinitionsSpec> = {}): readonly ResponseRule[] {
  return [
    issueFieldsProbeRule(),
    { match: { operation: 'GetIssueAttributeDefinitions' }, respond: { status: 200, body: { data: definitionsData(spec) } }, times: 1 },
  ]
}

export { page as connectionPage }
