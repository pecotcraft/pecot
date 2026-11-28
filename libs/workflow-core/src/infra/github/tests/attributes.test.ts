/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// 応答は 2026-11-23 に取った公開スキーマ（schema.docs.graphql）の型に合わせる。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../../tests/_helpers/step.js'

import type { ResponseRule } from '../../../../tests/_helpers/fake-github/server.js'
import { readAttributeDefinitions, readAttributeValues } from '../attributes.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import {
  QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS,
  QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS_WITHOUT_ISSUE_FIELDS,
  QUERY_GET_ISSUE_ATTRIBUTES,
  QUERY_GET_ISSUE_ATTRIBUTES_WITHOUT_ISSUE_FIELDS,
  QUERY_GET_REPOSITORY_MILESTONES_PAGE,
} from '../queries.js'
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
  projectField('F_status', 'Status', 'SINGLE_SELECT', { options: [{ id: 'O_todo', name: 'Todo' }, { id: 'O_done', name: 'Done' }] }),
  projectField('PVTSSF_workflow', 'pecot-status', 'SINGLE_SELECT', { options: [{ name: 'Ready' }] }),
  projectField('F_area', 'Area', 'SINGLE_SELECT', { options: [{ id: 'O_cli', name: 'cli' }, { id: 'O_docs', name: 'docs' }] }),
  projectField('F_tags', 'Tags', 'MULTI_SELECT', { multiSelectOptions: [{ id: 'O_a', name: 'a' }, { id: 'O_b', name: 'b' }] }),
  projectField('F_note', 'Note', 'TEXT'),
  projectField('F_estimate', 'Estimate', 'NUMBER'),
  projectField('F_due', 'Due', 'DATE'),
  projectField('F_sprint', 'Sprint', 'ITERATION', { configuration: { iterations: [{ id: 'I_2', title: 'Sprint 2', startDate: '2026-11-16' }], completedIterations: [{ id: 'I_1', title: 'Sprint 1', startDate: '2026-11-02' }] } }),
  projectField('F_progress', 'Sub-issues progress', 'SUB_ISSUES_PROGRESS'),
  projectField('F_priority', 'Priority', 'SINGLE_SELECT', { isIssueField: true, options: [{ name: 'High' }] }),
]

const ISSUE_FIELDS = [
  { fullDatabaseId: '101', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ name: 'High' }, { name: 'Low' }] },
  { fullDatabaseId: '102', name: 'Start date', dataType: 'DATE' },
  { fullDatabaseId: '103', name: 'Effort', dataType: 'NUMBER' },
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
      milestones: data.milestones ?? page([{ number: 3, title: 'v1' }]),
    },
  }
}

describe('readAttributeDefinitions', () => {
  it('ボードの 6 種類のフィールドを、種別と選択肢を持つ定義にし、フィールドと選択肢・Iteration の ID を保持する', async () => {
    await explains('属性の定義を読み取る関数のテストです。ボードの単一選択・複数選択・テキスト・数値・日付・Iteration のフィールドが、種別と選択肢、フィールドと選択肢の ID を持つ定義として返ることを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())]))

    const { definitions, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.filter(definition => ['Area', 'Tags', 'Note', 'Estimate', 'Due', 'Sprint'].includes(definition.name))).toStrictEqual([
        { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli', id: 'O_cli' }, { name: 'docs', id: 'O_docs' }], writable: true, fieldId: 'F_area' },
        { name: 'Tags', source: 'project', kind: 'multi_select', options: [{ name: 'a', id: 'O_a' }, { name: 'b', id: 'O_b' }], writable: true, fieldId: 'F_tags' },
        { name: 'Note', source: 'project', kind: 'text', writable: true, fieldId: 'F_note' },
        { name: 'Estimate', source: 'project', kind: 'number', writable: true, fieldId: 'F_estimate' },
        { name: 'Due', source: 'project', kind: 'date', writable: true, fieldId: 'F_due' },
        {
          name: 'Sprint',
          source: 'project',
          kind: 'iteration',
          options: [{ name: 'Sprint 2', startDate: '2026-11-16', id: 'I_2' }, { name: 'Sprint 1', startDate: '2026-11-02', id: 'I_1' }],
          writable: true,
          fieldId: 'F_sprint',
        },
      ])
      expect(unreadable).toStrictEqual(new Map())
    })
  })

  it('定義のクエリは、選択肢・Iteration の ID、Issue field の fullDatabaseId、マイルストーンの番号を問い合わせる', async () => {
    await explains('属性の定義を取得する GraphQL クエリのテストです。選択肢と Iteration の ID、Issue field の `fullDatabaseId`、マイルストーンの番号を問い合わせる文になっていることを確認します。')
    stepSync('結果を比べる', () => {
      const definitions = QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS.replaceAll(/\s+/gu, ' ')
      expect(definitions).toContain('options { id name }')
      expect(definitions).toContain('multiSelectOptions { id name }')
      expect(definitions).toContain('iterations { id title startDate }')
      expect(definitions).toContain('completedIterations { id title startDate }')
      expect(definitions).toContain('... on IssueFieldCommon { fullDatabaseId name dataType }')
      expect(definitions).toContain('nodes { number title }')
      expect(QUERY_GET_REPOSITORY_MILESTONES_PAGE.replaceAll(/\s+/gu, ' ')).toContain('nodes { number title }')
    })
  })

  it('GitHub が計算するフィールドは unsupported とし、Status と pecot-status も書き込み不可にする', async () => {
    await explains('属性の定義を読み取る関数のテストです。`Title` など GitHub が計算するフィールドは `unsupported` の書き込み不可として返り、`Status` と `pecot-status` も書き込み不可になることを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())]))

    const { definitions } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      const project = definitions.filter(definition => definition.source === 'project')
      expect(project.filter(definition => !definition.writable).map(({ name, kind, unsupportedReason }) => ({ name, kind, unsupportedReason }))).toStrictEqual([
        { name: 'Title', kind: 'unsupported', unsupportedReason: 'TITLE' },
        { name: 'Status', kind: 'single_select', unsupportedReason: undefined },
        { name: 'pecot-status', kind: 'single_select', unsupportedReason: undefined },
        { name: 'Sub-issues progress', kind: 'unsupported', unsupportedReason: 'SUB_ISSUES_PROGRESS' },
      ])
    })
  })

  it('Issue の機能を写したフィールドと Issue field を写したフィールドは、source が project の定義に含めない', async () => {
    await explains('属性の定義を読み取る関数のテストです。Issue の機能を写したフィールド（`Assignees`）と Issue field を写したフィールド（`Priority`）が、source が `project` の定義に含まれないことを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())]))

    const { definitions } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      const names = definitions.filter(definition => definition.source === 'project').map(definition => definition.name)
      expect(names).not.toContain('Assignees')
      expect(names).not.toContain('Priority')
    })
  })

  it('未知の dataType のフィールドは、種別を unsupported とし、unsupportedReason を持たせる', async () => {
    await explains('属性の定義を読み取る関数のテストです。未知の `dataType` を持つフィールドが、種別 `unsupported` と `unsupportedReason` を持つ書き込み不可の定義として返ることを確認します。')
    const project = { fields: page([projectField('F_x', 'People', 'PEOPLE')]) }

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData({ project }))]))

    const { definitions } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions[0]).toStrictEqual({ name: 'People', source: 'project', kind: 'unsupported', writable: false, unsupportedReason: 'PEOPLE', fieldId: 'F_x' })
    })
  })

  it('Issue fields・Issue type・ラベル・マイルストーンと組み込みの機能を、この順に返し、Issue field とマイルストーンに ID を持たせる', async () => {
    await explains('属性の定義を読み取る関数のテストです。Issue fields・Issue type・ラベル・マイルストーンと組み込みの機能が、この順に返り、Issue field とマイルストーンが ID を持つことを確認します。')
    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData())]))

    const { definitions, warnings } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.filter(definition => definition.source !== 'project')).toStrictEqual([
        { name: 'Priority', source: 'issue_field', kind: 'single_select', options: [{ name: 'High' }, { name: 'Low' }], writable: true, fieldId: '101' },
        { name: 'Start date', source: 'issue_field', kind: 'date', writable: true, fieldId: '102' },
        { name: 'Effort', source: 'issue_field', kind: 'number', writable: true, fieldId: '103' },
        { name: 'assignees', source: 'issue', kind: 'users', writable: true },
        { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1', id: '3' }], writable: true },
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
  })

  it.for([
    { name: 'FORBIDDEN', type: 'FORBIDDEN', message: 'Resource not accessible by integration' },
    { name: 'NOT_FOUND', type: 'NOT_FOUND', message: 'Could not resolve to a node' },
  ])('Issue fields の読み込みが $name で失敗しても、ほかの定義は返し、警告を 1 行追加し、issue_field を unreadable に記録する', async ({ type, message }) => {
    await explains('部分エラーのテストです。Issue fields の読み取りが失敗した場合に、ほかの定義は返し、警告と `unreadable` の記録を残すことを確認します。')
    const data = definitionsData({ issueFields: null })

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data, errors: [{ type, path: ['repository', 'issueFields'], message }] })]))

    const { definitions, warnings, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.some(definition => definition.source === 'issue_field')).toBe(false)
      expect(definitions.map(definition => definition.name)).toContain('Area')
      expect(definitions.map(definition => definition.name)).toContain('type')
      expect(warnings).toStrictEqual([`could not read the Issue fields of acme/demo: ${message}`])
      expect(unreadable).toStrictEqual(new Map([['issue_field', `could not read the Issue fields of acme/demo: ${message}`]]))
    })
  })

  it('ボードを読み取れない部分エラーでも、リポジトリの定義は返し、警告を 1 行追加し、project を unreadable に記録する', async () => {
    await explains('部分エラーのテストです。ボードの読み取りがエラーになった場合は、リポジトリの定義は返し、警告を 1 行追加して、`project` を `unreadable` として記録することを確認します。')
    const data = definitionsData({ project: null })

    const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['project'], message: 'Your token has not been granted the required scopes' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data, errors })]))

    const { definitions, warnings, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.some(definition => definition.source === 'project')).toBe(false)
      expect(definitions.map(definition => definition.name)).toContain('Priority')
      expect(warnings).toStrictEqual(['could not read the fields of the board: Your token has not been granted the required scopes'])
      expect(unreadable).toStrictEqual(new Map([['project', 'could not read the fields of the board: Your token has not been granted the required scopes']]))
    })
  })

  it('ボードが存在しない場合は、project を unreadable に記録する', async () => {
    await explains('属性の定義を読み取る関数のテストです。ボードが存在しない場合に、`project` を `unreadable` に記録することを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData({ project: null }))]))

    const { unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(unreadable).toStrictEqual(new Map([['project', 'could not read the fields of the board: project PVT_1 was not found']]))
    })
  })

  it('Issue type を読み取れない部分エラーでは、type を返さず、issue を unreadable に記録する', async () => {
    await explains('部分エラーのテストです。Issue type の読み取りがエラーになった場合は、`type` を返さず、`issue` を `unreadable` として記録することを確認します。')
    const data = definitionsData({ issueTypes: null })

    const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issueTypes'], message: 'Resource not accessible' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data, errors })]))

    const { definitions, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.map(definition => definition.name)).not.toContain('type')
      expect(unreadable).toStrictEqual(new Map([['issue', 'could not read the Issue types of acme/demo: Resource not accessible']]))
    })
  })

  it('Issue field の fullDatabaseId が null の場合は、fieldId を持たせない', async () => {
    await explains('属性の定義を読み取る関数のテストです。Issue field の `fullDatabaseId` が `null` の場合に、`fieldId` を持たない定義として返すことを確認します。')
    const issueFields = page([{ fullDatabaseId: null, name: 'Effort', dataType: 'NUMBER' }])

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', definitionsData({ issueFields }))]))

    const { definitions } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.find(definition => definition.name === 'Effort')).toStrictEqual({ name: 'Effort', source: 'issue_field', kind: 'number', writable: true })
    })
  })

  it('Issue fields の型が存在しない GHES では、Issue fields と Issue type を除いたクエリで読み取り、type を返さない', async () => {
    await explains('GitHub Enterprise Server（GHES）向けのテストです。`IssueFields` の型が存在しない場合に、Issue fields と Issue type を除いたクエリで読み取り、`type` を返さないことを確認します。')
    const data = { project: { fields: page([projectField('F_note', 'Note', 'TEXT')]) }, repository: { labels: page([]), milestones: page([]) } }

    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(false), graphqlData('GetIssueAttributeDefinitionsWithoutIssueFields', data)]))

    const { definitions, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.map(definition => definition.name)).toStrictEqual(['Note', 'assignees', 'milestone', 'labels', 'parent', 'blocked_by'])
      expect(unreadable).toStrictEqual(new Map())
      expect(graphqlRequests(server).map(request => request.operation)).toStrictEqual(['HasIssueFields', 'GetIssueAttributeDefinitionsWithoutIssueFields'])
    })
  })

  it('GHES 向けのクエリは、Issue fields と同じ時期に追加された複数選択の型を問い合わせない', async () => {
    await explains('GHES 向けのクエリのテストです。Issue fields と同じ時期に追加された複数選択の型 `MultiSelect` を、問い合わせないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(QUERY_GET_ISSUE_ATTRIBUTE_DEFINITIONS_WITHOUT_ISSUE_FIELDS).not.toContain('MultiSelect')
      expect(QUERY_GET_ISSUE_ATTRIBUTES_WITHOUT_ISSUE_FIELDS).not.toContain('MultiSelect')
    })
  })

  it('ラベルとマイルストーンに続きのページがある場合は、続きも取得する', async () => {
    await explains('属性の定義を読み取る関数のテストです。ラベルとマイルストーンに続きのページがある場合に、続きのページも取得して結合することを確認します。')
    const data = definitionsData({ labels: page([{ name: 'bug' }], true, 'L1'), milestones: page([{ number: 3, title: 'v1' }], true, 'M1') })

    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([
      issueFieldsProbe(),
      graphqlData('GetIssueAttributeDefinitions', data),
      graphqlData('GetRepositoryLabelsPage', { repository: { labels: page([{ name: 'docs' }]) } }),
      graphqlData('GetRepositoryMilestonesPage', { repository: { milestones: page([{ number: 4, title: 'v2' }]) } }),
    ]))

    const { definitions } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(definitions.find(definition => definition.name === 'labels')?.options).toStrictEqual([{ name: 'bug' }, { name: 'docs' }])
      expect(definitions.find(definition => definition.name === 'milestone')?.options).toStrictEqual([{ name: 'v1', id: '3' }, { name: 'v2', id: '4' }])
      expect(graphqlRequests(server).slice(2)).toStrictEqual([
        { operation: 'GetRepositoryLabelsPage', variables: { owner: 'acme', repo: 'demo', after: 'L1' } },
        { operation: 'GetRepositoryMilestonesPage', variables: { owner: 'acme', repo: 'demo', after: 'M1' } },
      ])
    })
  })

  it('ボードのフィールド・Issue fields・Issue type が先頭の 100 件に収まらない場合は、警告を 1 行ずつ追加し、その source を unreadable に記録する', async () => {
    await explains('属性の定義を読み取る関数のテストです。ボードのフィールドなどが 100 件を超える場合は、警告を 1 行ずつ追加し、その source を `unreadable` として記録することを確認します。')
    const data = definitionsData({ project: { fields: page([], true) }, issueFields: page([], true), issueTypes: page([], true) })

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributeDefinitions', data)]))

    const { warnings, unreadable } = await step('属性の定義を読む', async () => await readAttributeDefinitions(client, DEFINITIONS_TARGET))

    stepSync('結果を比べる', () => {
      expect(warnings).toStrictEqual([
        'read only the first 100 fields of the board',
        'read only the first 100 Issue types of acme/demo',
        'read only the first 100 Issue fields of acme/demo',
      ])
      expect(unreadable).toStrictEqual(new Map([
        ['project', 'read only the first 100 fields of the board'],
        ['issue_field', 'read only the first 100 Issue fields of acme/demo'],
        ['issue', 'read only the first 100 Issue types of acme/demo'],
      ]))
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError が発生する', async () => {
    await explains('属性の定義を読み取る関数のテストです。リポジトリが存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const errors = [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository with the name \'acme/demo\'.' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributeDefinitions', { data: { project: null, repository: null }, errors })]))

    const error = await step('属性の定義を読む', async () => await rejection(readAttributeDefinitions(client, DEFINITIONS_TARGET)))

    stepSync('エラーの種類を比べる', () => {
      expect(error).toBeInstanceOf(GitHubNotFoundError)
    })
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
    { id: 'PVTI_other', project: { id: 'PVT_other' }, fieldValues: page(elsewhere) },
    { id: 'PVTI_1', project: { id: 'PVT_1' }, fieldValues: page(issue.fieldValues ?? []) },
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
  it('設定したボードの 6 種類の値を、種別と値を持つ読み取り結果にする', async () => {
    await explains('属性の値を読み取る関数のテストです。設定したボードの単一選択・複数選択・テキスト・数値・日付・Iteration の値が、種別と値を持つ読み取り結果として返ることを確認します。')
    const fieldValues = [
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Area', 'SINGLE_SELECT'), { name: 'cli' }),
      boardValue('ProjectV2ItemFieldMultiSelectValue', fieldOf('Tags', 'MULTI_SELECT'), { options: [{ name: 'a' }, { name: 'b' }] }),
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Note', 'TEXT'), { text: 'メモ' }),
      boardValue('ProjectV2ItemFieldNumberValue', fieldOf('Estimate', 'NUMBER'), { number: 2.5 }),
      boardValue('ProjectV2ItemFieldDateValue', fieldOf('Due', 'DATE'), { date: '2026-12-01' }),
      boardValue('ProjectV2ItemFieldIterationValue', fieldOf('Sprint', 'ITERATION'), { title: 'Sprint 2' }),
    ]

    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))]))

    const { readings, unsupported, warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
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
  })

  it('担当者・マイルストーン・Issue type・ラベルを、source が issue の値として返す', async () => {
    await explains('属性の値を読み取る関数のテストです。担当者・マイルストーン・Issue type・ラベルが、source が `issue` の値として返ることを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData())]))

    const { readings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings).toStrictEqual([
        { name: 'assignees', source: 'issue', kind: 'users', value: ['alice'] },
        { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
        { name: 'type', source: 'issue', kind: 'issue_type', value: 'Task' },
        { name: 'labels', source: 'issue', kind: 'labels', value: ['bug', 'docs'] },
      ])
    })
  })

  it('Issue fields の値を、source が issue_field の値として返す', async () => {
    await explains('属性の値を読み取る関数のテストです。Issue fields の値が、source が `issue_field` の値として返ることを確認します。')
    const issueFieldValues = page([
      { __typename: 'IssueFieldSingleSelectValue', field: { name: 'Priority', dataType: 'SINGLE_SELECT' }, name: 'High' },
      { __typename: 'IssueFieldMultiSelectValue', field: { name: 'Teams', dataType: 'MULTI_SELECT' }, options: [{ name: 'x' }, { name: 'y' }] },
      { __typename: 'IssueFieldDateValue', field: { name: 'Start date', dataType: 'DATE' }, value: '2026-11-30' },
      { __typename: 'IssueFieldNumberValue', field: { name: 'Effort', dataType: 'NUMBER' }, numberValue: 3 },
      { __typename: 'IssueFieldTextValue', field: { name: 'Owner note', dataType: 'TEXT' }, value: '確認中' },
    ])

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ issueFieldValues }))]))

    const { readings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.filter(reading => reading.source === 'issue_field')).toStrictEqual([
        { name: 'Priority', source: 'issue_field', kind: 'single_select', value: 'High' },
        { name: 'Teams', source: 'issue_field', kind: 'multi_select', value: ['x', 'y'] },
        { name: 'Start date', source: 'issue_field', kind: 'date', value: '2026-11-30' },
        { name: 'Effort', source: 'issue_field', kind: 'number', value: 3 },
        { name: 'Owner note', source: 'issue_field', kind: 'text', value: '確認中' },
      ])
    })
  })

  it('ProjectV2ItemIssueFieldValue と、Issue field を写したフィールドの値は、結果に含めない', async () => {
    await explains('属性の値を読み取る関数のテストです。`ProjectV2ItemIssueFieldValue` と、Issue field を写したフィールドの値を、結果に含めないことを確認します。')
    const fieldValues = [
      boardValue('ProjectV2ItemIssueFieldValue', fieldOf('Priority', 'SINGLE_SELECT', true)),
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Priority', 'SINGLE_SELECT', true), { name: 'High' }),
    ]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))]))

    const { readings, unsupported } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
      expect(unsupported).toStrictEqual([])
    })
  })

  it('システムのフィールドの値は、結果に含めない', async () => {
    await explains('属性の値を読み取る関数のテストです。`Title` や `Repository` など GitHub が管理するシステムのフィールドの値を、結果に含めないことを確認します。')
    const fieldValues = [
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Title', 'TITLE'), { text: '題' }),
      boardValue('ProjectV2ItemFieldRepositoryValue', fieldOf('Repository', 'REPOSITORY')),
      boardValue('ProjectV2ItemFieldUserValue', fieldOf('Assignees', 'ASSIGNEES')),
      boardValue('ProjectV2ItemFieldLabelValue', fieldOf('Labels', 'LABELS')),
      boardValue('ProjectV2ItemFieldMilestoneValue', fieldOf('Milestone', 'MILESTONE')),
      boardValue('ProjectV2ItemFieldPullRequestValue', fieldOf('Linked pull requests', 'LINKED_PULL_REQUESTS')),
      boardValue('ProjectV2ItemFieldReviewerValue', fieldOf('Reviewers', 'REVIEWERS')),
    ]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))]))

    const { readings, unsupported, warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
      expect({ unsupported, warnings }).toStrictEqual({ unsupported: [], warnings: [] })
    })
  })

  it('未知の型で field を取得できる場合は unsupported に、取得できない場合は警告に記録し、ほかの値は返す', async () => {
    await explains('属性の値を読み取る関数のテストです。未知の型の値のうち、field を取得できるものは `unsupported` に、取得できないものは警告に記録し、ほかの値は返すことを確認します。')
    const fieldValues = [
      boardValue('ProjectV2ItemFieldPeopleValue', fieldOf('Reviewer group', 'PEOPLE')),
      boardValue('ProjectV2ItemFieldFutureValue', undefined),
      boardValue('ProjectV2ItemFieldTextValue', fieldOf('Note', 'TEXT'), { text: 'メモ' }),
    ]

    const issueFieldValues = page([
      { __typename: 'IssueFieldUserValue', field: { name: 'Reviewer', dataType: 'USER' } },
      { __typename: 'IssueFieldFutureValue' },
    ])

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues, issueFieldValues }))]))

    const { readings, unsupported, warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
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
  })

  it('未知の dataType の値は、型が既知でも unsupported に記録する', async () => {
    await explains('属性の値を読み取る関数のテストです。型は既知でも `dataType` が未知の値を、`unsupported` に記録することを確認します。')
    const fieldValues = [boardValue('ProjectV2ItemFieldTextValue', fieldOf('Summary', 'AI_SUMMARY'), { text: '要約' })]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))]))

    const { unsupported } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(unsupported).toStrictEqual([{ name: 'Summary', source: 'project', githubType: 'AI_SUMMARY' }])
    })
  })

  it('値が設定されていないフィールドは、結果に含めない', async () => {
    await explains('属性の値を読み取る関数のテストです。値が設定されていないフィールド（`null` や空の選択肢）を、結果に含めないことを確認します。')
    const fieldValues = [
      boardValue('ProjectV2ItemFieldSingleSelectValue', fieldOf('Area', 'SINGLE_SELECT'), { name: null }),
      boardValue('ProjectV2ItemFieldNumberValue', fieldOf('Estimate', 'NUMBER'), { number: null }),
      boardValue('ProjectV2ItemFieldMultiSelectValue', fieldOf('Tags', 'MULTI_SELECT'), { options: [] }),
    ]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ fieldValues }))]))

    const { readings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.filter(reading => reading.source === 'project')).toStrictEqual([])
    })
  })

  it('ボードを読み取れない部分エラーでも、Issue の値は返し、警告を 1 行追加する', async () => {
    await explains('部分エラーのテストです。ボードの読み取りがエラーになった場合は、Issue の値は返し、警告を 1 行追加することを確認します。')
    const data = valuesData({ projectItems: null })

    const errors = [{ type: 'INSUFFICIENT_SCOPES', path: ['repository', 'issue', 'projectItems'], message: 'Your token has not been granted the required scopes' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data, errors })]))

    const { readings, warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.map(reading => reading.name)).toStrictEqual(['assignees', 'milestone', 'type', 'labels'])
      expect(warnings).toStrictEqual(['could not read the board fields of acme/demo/7: Your token has not been granted the required scopes'])
    })
  })

  it('Issue fields を読み取れない部分エラーでも、ほかの値は返し、警告を 1 行追加する', async () => {
    await explains('部分エラーのテストです。Issue fields の読み取りがエラーになった場合は、ほかの値は返し、警告を 1 行追加することを確認します。')
    const data = valuesData({ issueFieldValues: null })

    const errors = [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'issueFieldValues'], message: 'Resource not accessible' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data, errors })]))

    const { readings, warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings.map(reading => reading.name)).toStrictEqual(['assignees', 'milestone', 'type', 'labels'])
      expect(warnings).toStrictEqual(['could not read the Issue fields of acme/demo/7: Resource not accessible'])
    })
  })

  it('Issue fields の型が存在しない GHES では、Issue fields と Issue type を除いたクエリで読み取る', async () => {
    await explains('GHES 向けのテストです。`IssueFields` の型が存在しない場合に、Issue fields と Issue type を除いたクエリで値を読み取ることを確認します。')
    const data = { repository: { issue: { assignees: page([]), milestone: null, labels: page([]), projectItems: page([]) } } }

    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(false), graphqlData('GetIssueAttributesWithoutIssueFields', data)]))

    const { readings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(readings).toStrictEqual([])
      expect(graphqlRequests(server).map(request => request.operation)).toStrictEqual(['HasIssueFields', 'GetIssueAttributesWithoutIssueFields'])
    })
  })

  it('担当者・ラベル・ボードの値が先頭の 100 件に収まらない場合は、警告を 1 行ずつ追加する', async () => {
    await explains('属性の値を読み取る関数のテストです。担当者・ラベル・ボードの値などが 100 件を超える場合は、警告を 1 行ずつ追加することを確認します。')
    const projectItems = page([{ project: { id: 'PVT_1' }, fieldValues: page([], true) }], true)

    const data = valuesData({ projectItems, assignees: page([], true), labels: page([], true), issueFieldValues: page([], true) })

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', data)]))

    const { warnings } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(warnings).toStrictEqual([
        'read only the first 100 assignees of acme/demo/7',
        'read only the first 100 labels of acme/demo/7',
        'read only the first 100 Issue field values of acme/demo/7',
        'read only the first 100 project items of acme/demo/7',
        'read only the first 100 board values of acme/demo/7',
      ])
    })
  })

  it('許可していない道筋のエラーは、GitHubAPIError として扱う', async () => {
    await explains('属性の値を読み取る関数のテストです。許可していない道筋のエラー（`SERVICE_UNAVAILABLE` など）が返った場合に、`GitHubAPIError` が発生することを確認します。')
    const errors = [{ type: 'SERVICE_UNAVAILABLE', path: ['repository', 'issue', 'labels'], message: 'boom' }]

    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), respond('GetIssueAttributes', { data: valuesData(), errors })]))

    const error = await step('属性を読む', async () => await rejection(readAttributeValues(client, VALUES_TARGET)))

    stepSync('結果を比べる', () => {
      expect(error).toMatchObject({ name: GitHubAPIError.name })
      expect(String(error)).toContain('boom')
    })
  })

  it('設定したボードの Item の ID を、itemId として返す', async () => {
    await explains('属性の値を読み取る関数のテストです。設定したボードの Item の ID を、`itemId` として返すことを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData())]))

    const { itemId } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(itemId).toBe('PVTI_1')
      expect(QUERY_GET_ISSUE_ATTRIBUTES.replaceAll(/\s+/gu, ' ')).toContain('nodes { id project { id }')
    })
  })

  it.for([
    { name: '別のボードにだけ載っている', projectItems: page([{ id: 'PVTI_other', project: { id: 'PVT_other' }, fieldValues: page([]) }]) },
    { name: 'どのボードにも載っていない', projectItems: page([]) },
  ])('Issue がボードに載っていない場合（$name）は、itemId が undefined になる', async ({ projectItems }) => {
    await explains('属性の値を読み取る関数のテストです。Issue が別のボードにだけ載っている場合や、どのボードにも載っていない場合に、`itemId` が `undefined` になることを確認します。')
    const { client } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([issueFieldsProbe(), graphqlData('GetIssueAttributes', valuesData({ projectItems }))]))

    const { itemId } = await step('属性の値を読む', async () => await readAttributeValues(client, VALUES_TARGET))

    stepSync('結果を比べる', () => {
      expect(itemId).toBeUndefined()
    })
  })
})
