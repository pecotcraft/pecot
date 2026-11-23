/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// 応答は 2026-11-23 に取った公開スキーマ（schema.docs.graphql）の型に合わせる。
import { describe, expect, it } from 'vitest'

import type { ResponseRule } from '../../../../tests/fake-github/server.js'
import { readAttributeDefinitions, readAttributeValues } from '../attributes.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { graphqlData, graphqlRequests, rejection, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

const DEFINITIONS_TARGET = { owner: 'acme', repository: 'demo', projectId: 'PVT_1', workflowFieldId: 'PVTSSF_workflow' }
const VALUES_TARGET = { owner: 'acme', repository: 'demo', number: 7, projectId: 'PVT_1' }

function issueFieldsProbe(isSupported = true): ResponseRule {
  return graphqlData('HasIssueFields', { __type: isSupported ? { name: 'IssueFields' } : null })
}

function respond(operation: string, body: unknown): ResponseRule {
  return { match: { operation }, respond: { status: 200, body }, times: 1 }
}

const page = (nodes: readonly unknown[], hasNextPage = false, endCursor: string | null = null): Record<string, unknown> => ({ pageInfo: { hasNextPage, endCursor }, nodes })

function projectField(id: string, name: string, dataType: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { id, name, dataType, isIssueField: false, ...extra }
}

const BOARD_FIELDS = [
  projectField('F_title', 'Title', 'TITLE'),
  projectField('F_assignees', 'Assignees', 'ASSIGNEES'),
  projectField('F_status', 'Status', 'SINGLE_SELECT', { options: [{ name: 'Todo' }, { name: 'Done' }] }),
  projectField('PVTSSF_workflow', 'pecot-status', 'SINGLE_SELECT', { options: [{ name: 'Ready' }] }),
  projectField('F_area', 'Area', 'SINGLE_SELECT', { options: [{ name: 'cli' }, { name: 'docs' }] }),
  projectField('F_tags', 'Tags', 'MULTI_SELECT', { multiSelectOptions: [{ name: 'a' }, { name: 'b' }] }),
  projectField('F_note', 'Note', 'TEXT'),
  projectField('F_estimate', 'Estimate', 'NUMBER'),
  projectField('F_due', 'Due', 'DATE'),
  projectField('F_sprint', 'Sprint', 'ITERATION', { configuration: { iterations: [{ title: 'Sprint 2', startDate: '2026-11-16' }], completedIterations: [{ title: 'Sprint 1', startDate: '2026-11-02' }] } }),
  projectField('F_progress', 'Sub-issues progress', 'SUB_ISSUES_PROGRESS'),
  projectField('F_priority', 'Priority', 'SINGLE_SELECT', { isIssueField: true, options: [{ name: 'High' }] }),
]

const ISSUE_FIELDS = [
  { name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ name: 'High' }, { name: 'Low' }] },
  { name: 'Start date', dataType: 'DATE' },
  { name: 'Effort', dataType: 'NUMBER' },
]

interface DefinitionsData {
  readonly project?: unknown
  readonly issueTypes?: unknown
  readonly issueFields?: unknown
  readonly labels?: unknown
  readonly milestones?: unknown
}

function definitionsData(data: Readonly<DefinitionsData> = {}): Record<string, unknown> {
  return {
    project: 'project' in data ? data.project : { fields: page(BOARD_FIELDS) },
    repository: {
      issueTypes: 'issueTypes' in data ? data.issueTypes : page([{ name: 'Bug' }, { name: 'Task' }]),
      issueFields: 'issueFields' in data ? data.issueFields : page(ISSUE_FIELDS),
      labels: data.labels ?? page([{ name: 'bug' }]),
      milestones: data.milestones ?? page([{ title: 'v1' }]),
    },
  }
}

describe('readAttributeDefinitions', () => {
  it('ボードの 6 種類のフィールドを、data-model の kind と選択肢にする', async () => {
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.filter(definition => ['Area', 'Tags', 'Note', 'Estimate', 'Due', 'Sprint'].includes(definition.name))).toStrictEqual([
      { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli' }, { name: 'docs' }], writable: true },
      { name: 'Tags', source: 'project', kind: 'multi_select', options: [{ name: 'a' }, { name: 'b' }], writable: true },
      { name: 'Note', source: 'project', kind: 'text', writable: true },
      { name: 'Estimate', source: 'project', kind: 'number', writable: true },
      { name: 'Due', source: 'project', kind: 'date', writable: true },
      { name: 'Sprint', source: 'project', kind: 'iteration', options: [{ name: 'Sprint 2', startDate: '2026-11-16' }, { name: 'Sprint 1', startDate: '2026-11-02' }], writable: true },
    ])
  })

  it('GitHub が計算するフィールドは unsupported で書けず、Status と進行の欄も書けない', async () => {
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    const project = definitions.filter(definition => definition.source === 'project')
    expect(project.filter(definition => !definition.writable).map(({ name, kind, unsupportedReason }) => ({ name, kind, unsupportedReason }))).toStrictEqual([
      { name: 'Title', kind: 'unsupported', unsupportedReason: 'TITLE' },
      { name: 'Status', kind: 'single_select', unsupportedReason: undefined },
      { name: 'pecot-status', kind: 'single_select', unsupportedReason: undefined },
      { name: 'Sub-issues progress', kind: 'unsupported', unsupportedReason: 'SUB_ISSUES_PROGRESS' },
    ])
  })

  it('Issue の機能を写すフィールドと Issue field を写したフィールドは、source が project の定義に出さない', async () => {
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    const names = definitions.filter(definition => definition.source === 'project').map(definition => definition.name)
    expect(names).not.toContain('Assignees')
    expect(names).not.toContain('Priority')
  })

  it('知らない dataType のフィールドは、unsupported と unsupported_reason の種類になる', async () => {
    const project = { fields: page([projectField('F_x', 'People', 'PEOPLE')]) }
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData({ project }))])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions[0]).toStrictEqual({ name: 'People', source: 'project', kind: 'unsupported', writable: false, unsupportedReason: 'PEOPLE' })
  })

  it('Issue fields・Issue type・ラベル・マイルストーンと組み込みの機能を、この順に出す', async () => {
    const { client, server } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())])

    const { definitions, warnings } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.filter(definition => definition.source !== 'project')).toStrictEqual([
      { name: 'Priority', source: 'issue_field', kind: 'single_select', options: [{ name: 'High' }, { name: 'Low' }], writable: true },
      { name: 'Start date', source: 'issue_field', kind: 'date', writable: true },
      { name: 'Effort', source: 'issue_field', kind: 'number', writable: true },
      { name: 'assignees', source: 'issue', kind: 'users', writable: true },
      { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1' }], writable: true },
      { name: 'type', source: 'issue', kind: 'issue_type', options: [{ name: 'Bug' }, { name: 'Task' }], writable: true },
      { name: 'labels', source: 'issue', kind: 'labels', options: [{ name: 'bug' }], writable: true },
      { name: 'parent', source: 'issue', kind: 'issue_ref', writable: false },
      { name: 'blocked_by', source: 'issue', kind: 'issue_refs', writable: false },
    ])
    expect(warnings).toStrictEqual([])
    expect(graphqlRequests(server)).toStrictEqual([
      { operation: 'HasIssueFields', variables: {} },
      { operation: 'GetIssueAttributeDefinitions', variables: { owner: 'acme', repo: 'demo', projectId: 'PVT_1' } },
    ])
  })

  it.for([
    { name: 'FORBIDDEN', type: 'FORBIDDEN', message: 'Resource not accessible by integration' },
    { name: 'NOT_FOUND', type: 'NOT_FOUND', message: 'Could not resolve to a node' },
  ])('Issue fields の読み込みが $name でも、ほかの定義は出し、warnings に 1 行入れる', async ({ type, message }) => {
    const data = definitionsData({ issueFields: null })
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data, errors: [{ type, path: ['repository', 'issueFields'], message }] })])

    const { definitions, warnings } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.some(definition => definition.source === 'issue_field')).toBe(false)
    expect(definitions.map(definition => definition.name)).toContain('Area')
    expect(definitions.map(definition => definition.name)).toContain('type')
    expect(warnings).toStrictEqual([`could not read the Issue fields of acme/demo: ${message}`])
  })

  it('ボードを読めない部分エラーでも、リポの定義は出し、warnings に 1 行入れる', async () => {
    const data = definitionsData({ project: null })
    const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['project'], message: 'Your token has not been granted the required scopes' }]
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data, errors })])

    const { definitions, warnings } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.some(definition => definition.source === 'project')).toBe(false)
    expect(definitions.map(definition => definition.name)).toContain('Priority')
    expect(warnings).toStrictEqual(['could not read the fields of the board: Your token has not been granted the required scopes'])
  })

  it('Issue fields の型が無い GHES では、Issue fields と Issue type を抜いた版で読み、type を出さない', async () => {
    const data = { project: { fields: page([projectField('F_note', 'Note', 'TEXT')]) }, repository: { labels: page([]), milestones: page([]) } }
    const { client, server } = await startClient([issueFieldsProbe(false), graphqlData('GetIssueAttributeDefinitionsWithoutIssueFields', data)])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.map(definition => definition.name)).toStrictEqual(['Note', 'assignees', 'milestone', 'labels', 'parent', 'blocked_by'])
    expect(graphqlRequests(server).map(request => request.operation)).toStrictEqual(['HasIssueFields', 'GetIssueAttributeDefinitionsWithoutIssueFields'])
  })

  it('ラベルとマイルストーンに続きのページがあれば、続きも読む', async () => {
    const data = definitionsData({ labels: page([{ name: 'bug' }], true, 'L1'), milestones: page([{ title: 'v1' }], true, 'M1') })
    const { client, server } = await startClient([
      issueFieldsProbe(),
      graphqlData('GetIssueAttributeDefinitions', data),
      graphqlData('GetRepositoryLabelsPage', { repository: { labels: page([{ name: 'docs' }]) } }),
      graphqlData('GetRepositoryMilestonesPage', { repository: { milestones: page([{ title: 'v2' }]) } }),
    ])

    const { definitions } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(definitions.find(definition => definition.name === 'labels')?.options).toStrictEqual([{ name: 'bug' }, { name: 'docs' }])
    expect(definitions.find(definition => definition.name === 'milestone')?.options).toStrictEqual([{ name: 'v1' }, { name: 'v2' }])
    expect(graphqlRequests(server).slice(2)).toStrictEqual([
      { operation: 'GetRepositoryLabelsPage', variables: { owner: 'acme', repo: 'demo', after: 'L1' } },
      { operation: 'GetRepositoryMilestonesPage', variables: { owner: 'acme', repo: 'demo', after: 'M1' } },
    ])
  })

  it('ボードのフィールド・Issue fields・Issue type に続きがあれば、warnings に 1 行ずつ入れる', async () => {
    const data = definitionsData({ project: { fields: page([], true) }, issueFields: page([], true), issueTypes: page([], true) })
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', data)])

    const { warnings } = await readAttributeDefinitions(client, DEFINITIONS_TARGET)

    expect(warnings).toStrictEqual([
      'read only the first 100 fields of the board',
      'read only the first 100 Issue types of acme/demo',
      'read only the first 100 Issue fields of acme/demo',
    ])
  })

  it('リポが無いと、GitHubNotFoundError にする', async () => {
    const errors = [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository with the name \'acme/demo\'.' }]
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data: { project: null, repository: null }, errors })])

    expect(await rejection(readAttributeDefinitions(client, DEFINITIONS_TARGET))).toBeInstanceOf(GitHubNotFoundError)
  })
})

function boardValue(typename: string, field: Readonly<Record<string, unknown>> | undefined, value: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { __typename: typename, ...field !== undefined && { field }, ...value }
}

const fieldOf = (name: string, dataType: string, isIssueField = false): Record<string, unknown> => ({ id: `F_${name}`, name, dataType, isIssueField })

interface ValuesIssue {
  readonly assignees?: unknown
  readonly labels?: unknown
  readonly fieldValues?: readonly unknown[]
  readonly issueFieldValues?: unknown
  readonly projectItems?: unknown
}

function valuesData(issue: Readonly<ValuesIssue> = {}): Record<string, unknown> {
  const elsewhere = [boardValue('ProjectV2ItemFieldTextValue', fieldOf('Elsewhere', 'TEXT'), { text: '別のボード' })]
  const items = issue.projectItems ?? page([
    { project: { id: 'PVT_other' }, fieldValues: page(elsewhere) },
    { project: { id: 'PVT_1' }, fieldValues: page(issue.fieldValues ?? []) },
  ])
  return {
    repository: {
      issue: {
        assignees: issue.assignees ?? page([{ login: 'alice' }]),
        milestone: { title: 'v1' },
        labels: issue.labels ?? page([{ name: 'bug' }, { name: 'docs' }]),
        issueType: { name: 'Task' },
        issueFieldValues: 'issueFieldValues' in issue ? issue.issueFieldValues : page([]),
        projectItems: items,
      },
    },
  }
}

describe('readAttributeValues', () => {
  it('設定のボードの 6 種類の値を、名前の値にする', async () => {
    const fieldValues = [
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Area', 'SINGLE_SELECT'), { name: 'cli' }),
      boardValue('ProjectV2ItemFieldMultiSelectValue', fieldOf('Tags', 'MULTI_SELECT'), { options: [{ name: 'a' }, { name: 'b' }] }),
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Note', 'TEXT'), { text: 'メモ' }),
      boardValue('ProjectV2ItemFieldNumberValue', fieldOf('Estimate', 'NUMBER'), { number: 2.5 }),
      boardValue('ProjectV2ItemFieldDateValue', fieldOf('Due', 'DATE'), { date: '2026-12-01' }),
      boardValue('ProjectV2ItemFieldIterationValue', fieldOf('Sprint', 'ITERATION'), { title: 'Sprint 2' }),
    ]
    const { client, server } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))])

    const { readings, unsupported, warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([
      { name: 'Area', source: 'project', kind: 'single_select', value: 'cli' },
      { name: 'Tags', source: 'project', kind: 'multi_select', value: ['a', 'b'] },
      { name: 'Note', source: 'project', kind: 'text', value: 'メモ' },
      { name: 'Estimate', source: 'project', kind: 'number', value: 2.5 },
      { name: 'Due', source: 'project', kind: 'date', value: '2026-12-01' },
      { name: 'Sprint', source: 'project', kind: 'iteration', value: 'Sprint 2' },
    ])
    expect({ unsupported, warnings }).toStrictEqual({ unsupported: [], warnings: [] })
    expect(graphqlRequests(server)).toStrictEqual([
      { operation: 'HasIssueFields', variables: {} },
      { operation: 'GetIssueAttributes', variables: { owner: 'acme', repo: 'demo', number: 7 } },
    ])
  })

  it('担当者・マイルストーン・Issue type・ラベルを、source が issue の値にする', async () => {
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData())])

    const { readings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings).toStrictEqual([
      { name: 'assignees', source: 'issue', kind: 'users', value: ['alice'] },
      { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
      { name: 'type', source: 'issue', kind: 'issue_type', value: 'Task' },
      { name: 'labels', source: 'issue', kind: 'labels', value: ['bug', 'docs'] },
    ])
  })

  it('Issue fields の値を、source が issue_field の値にする', async () => {
    const issueFieldValues = page([
      { __typename: 'IssueFieldSingleSelectValue', field: { name: 'Priority', dataType: 'SINGLE_SELECT' }, name: 'High' },
      { __typename: 'IssueFieldMultiSelectValue', field: { name: 'Teams', dataType: 'MULTI_SELECT' }, options: [{ name: 'x' }, { name: 'y' }] },
      { __typename: 'IssueFieldDateValue', field: { name: 'Start date', dataType: 'DATE' }, value: '2026-11-30' },
      { __typename: 'IssueFieldNumberValue', field: { name: 'Effort', dataType: 'NUMBER' }, numberValue: 3 },
      { __typename: 'IssueFieldTextValue', field: { name: 'Owner note', dataType: 'TEXT' }, value: '確認中' },
    ])
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ issueFieldValues }))])

    const { readings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'issue_field')).toStrictEqual([
      { name: 'Priority', source: 'issue_field', kind: 'single_select', value: 'High' },
      { name: 'Teams', source: 'issue_field', kind: 'multi_select', value: ['x', 'y'] },
      { name: 'Start date', source: 'issue_field', kind: 'date', value: '2026-11-30' },
      { name: 'Effort', source: 'issue_field', kind: 'number', value: 3 },
      { name: 'Owner note', source: 'issue_field', kind: 'text', value: '確認中' },
    ])
  })

  it('ProjectV2ItemIssueFieldValue と、Issue field を写したフィールドの値を読み捨てる', async () => {
    const fieldValues = [
      boardValue('ProjectV2ItemIssueFieldValue', fieldOf('Priority', 'SINGLE_SELECT', true)),
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Priority', 'SINGLE_SELECT', true), { name: 'High' }),
    ]
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))])

    const { readings, unsupported } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
    expect(unsupported).toStrictEqual([])
  })

  it('システムのフィールドの値を読み捨てる', async () => {
    const fieldValues = [
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Title', 'TITLE'), { text: '題' }),
      boardValue('ProjectV2ItemFieldRepositoryValue', fieldOf('Repository', 'REPOSITORY')),
      boardValue('ProjectV2ItemFieldUserValue', fieldOf('Assignees', 'ASSIGNEES')),
      boardValue('ProjectV2ItemFieldLabelValue', fieldOf('Labels', 'LABELS')),
      boardValue('ProjectV2ItemFieldMilestoneValue', fieldOf('Milestone', 'MILESTONE')),
      boardValue('ProjectV2ItemFieldPullRequestValue', fieldOf('Linked pull requests', 'LINKED_PULL_REQUESTS')),
      boardValue('ProjectV2ItemFieldReviewerValue', fieldOf('Reviewers', 'REVIEWERS')),
    ]
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))])

    const { readings, unsupported, warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
    expect({ unsupported, warnings }).toStrictEqual({ unsupported: [], warnings: [] })
  })

  it('知らない型で field を読めれば unsupported に、読めなければ warnings に出し、ほかの値は出す', async () => {
    const fieldValues = [
      boardValue('ProjectV2ItemFieldPeopleValue', fieldOf('Reviewer group', 'PEOPLE')),
      boardValue('ProjectV2ItemFieldFutureValue', undefined),
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Note', 'TEXT'), { text: 'メモ' }),
    ]
    const issueFieldValues = page([
      { __typename: 'IssueFieldUserValue', field: { name: 'Reviewer', dataType: 'USER' } },
      { __typename: 'IssueFieldFutureValue' },
    ])
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues, issueFieldValues }))])

    const { readings, unsupported, warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([{ name: 'Note', source: 'project', kind: 'text', value: 'メモ' }])
    expect(unsupported).toStrictEqual([
      { name: 'Reviewer group', source: 'project', githubType: 'PEOPLE' },
      { name: 'Reviewer', source: 'issue_field', githubType: 'USER' },
    ])
    expect(warnings).toStrictEqual([
      'could not read a board value of the unknown type ProjectV2ItemFieldFutureValue on acme/demo/7',
      'could not read an Issue field value of the unknown type IssueFieldFutureValue on acme/demo/7',
    ])
  })

  it('知らない dataType の値は、型を知っていても unsupported に出す', async () => {
    const fieldValues = [boardValue('ProjectV2ItemFieldTextValue', fieldOf('Summary', 'AI_SUMMARY'), { text: '要約' })]
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))])

    const { unsupported } = await readAttributeValues(client, VALUES_TARGET)

    expect(unsupported).toStrictEqual([{ name: 'Summary', source: 'project', githubType: 'AI_SUMMARY' }])
  })

  it('値の無いフィールドは出さない', async () => {
    const fieldValues = [
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Area', 'SINGLE_SELECT'), { name: null }),
      boardValue('ProjectV2ItemFieldNumberValue', fieldOf('Estimate', 'NUMBER'), { number: null }),
      boardValue('ProjectV2ItemFieldMultiSelectValue', fieldOf('Tags', 'MULTI_SELECT'), { options: [] }),
    ]
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))])

    const { readings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
  })

  it('ボードを読めない部分エラーでも、Issue の値は出し、warnings に 1 行入れる', async () => {
    const data = valuesData({ projectItems: null })
    const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['repository', 'issue', 'projectItems'], message: 'Your token has not been granted the required scopes' }]
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data, errors })])

    const { readings, warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.map(reading => reading.name)).toStrictEqual(['assignees', 'milestone', 'type', 'labels'])
    expect(warnings).toStrictEqual(['could not read the board fields of acme/demo/7: Your token has not been granted the required scopes'])
  })

  it('Issue fields を読めない部分エラーでも、ほかの値は出し、warnings に 1 行入れる', async () => {
    const data = valuesData({ issueFieldValues: null })
    const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'issueFieldValues'], message: 'Resource not accessible' }]
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data, errors })])

    const { readings, warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings.map(reading => reading.name)).toStrictEqual(['assignees', 'milestone', 'type', 'labels'])
    expect(warnings).toStrictEqual(['could not read the Issue fields of acme/demo/7: Resource not accessible'])
  })

  it('Issue fields の型が無い GHES では、Issue fields と Issue type を抜いた版で読む', async () => {
    const data = { repository: { issue: { assignees: page([]), milestone: null, labels: page([]), projectItems: page([]) } } }
    const { client, server } = await startClient([issueFieldsProbe(false), graphqlData('GetIssueAttributesWithoutIssueFields', data)])

    const { readings } = await readAttributeValues(client, VALUES_TARGET)

    expect(readings).toStrictEqual([])
    expect(graphqlRequests(server).map(request => request.operation)).toStrictEqual(['HasIssueFields', 'GetIssueAttributesWithoutIssueFields'])
  })

  it('担当者・ラベル・ボードの値に続きがあれば、warnings に 1 行ずつ入れる', async () => {
    const projectItems = page([{ project: { id: 'PVT_1' }, fieldValues: page([], true) }], true)
    const data = valuesData({ projectItems, assignees: page([], true), labels: page([], true), issueFieldValues: page([], true) })
    const { client } = await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', data)])

    const { warnings } = await readAttributeValues(client, VALUES_TARGET)

    expect(warnings).toStrictEqual([
      'read only the first 100 assignees of acme/demo/7',
      'read only the first 100 labels of acme/demo/7',
      'read only the first 100 Issue field values of acme/demo/7',
      'read only the first 100 project items of acme/demo/7',
      'read only the first 100 board values of acme/demo/7',
    ])
  })

  it('許さない道筋のエラーは、GitHubAPIError にする', async () => {
    const errors = [{ type: 'SERVICE_UNAVAILABLE', path: ['repository', 'issue', 'labels'], message: 'boom' }]
    const { client } = await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data: valuesData(), errors })])

    const error = await rejection(readAttributeValues(client, VALUES_TARGET))
    expect(error).toMatchObject({ name: GitHubAPIError.name })
    expect(String(error)).toContain('boom')
  })
})
