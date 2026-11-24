import { describe, expect, it } from 'vitest'

import {
  builtinDefinitions,
  builtinReadings,
  formatAttributeValue,
  issueFieldDefinition,
  issueFieldValueKind,
  issueReferenceText,
  projectFieldDefinition,
  projectValueTreatment,
  relationReadings,
  unsupportedOf,
} from '../attributes.js'

const WORKFLOW_FIELD_ID = 'PVTSSF_workflow'

function field(dataType: string, overrides: Readonly<{ id?: string, name?: string, isIssueField?: boolean, options?: readonly { readonly name: string, readonly startDate?: string }[] }> = {}): Parameters<typeof projectFieldDefinition>[0] {
  return { id: overrides.id ?? `F_${dataType}`, name: overrides.name ?? dataType.toLowerCase(), dataType, isIssueField: overrides.isIssueField ?? false, options: overrides.options ?? [] }
}

describe('projectFieldDefinition', () => {
  it.for([
    { dataType: 'TEXT', kind: 'text' },
    { dataType: 'NUMBER', kind: 'number' },
    { dataType: 'DATE', kind: 'date' },
  ])('$dataType のフィールドは、kind を $kind にして選択肢を持たない', ({ dataType, kind }) => {
    expect(projectFieldDefinition(field(dataType), WORKFLOW_FIELD_ID)).toStrictEqual({ name: dataType.toLowerCase(), source: 'project', kind, writable: true })
  })

  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'MULTI_SELECT', kind: 'multi_select' },
    { dataType: 'ITERATION', kind: 'iteration' },
  ])('$dataType のフィールドは、kind を $kind にして選択肢を持つ', ({ dataType, kind }) => {
    const options = [{ name: 'a' }, { name: 'b', startDate: '2026-01-05' }]
    expect(projectFieldDefinition(field(dataType, { name: 'Area', options }), WORKFLOW_FIELD_ID)).toStrictEqual({ name: 'Area', source: 'project', kind, options, writable: true })
  })

  it('設定の進行の欄の id のフィールドは、名前によらず書けない', () => {
    expect(projectFieldDefinition(field('SINGLE_SELECT', { id: WORKFLOW_FIELD_ID, name: 'pecot-status' }), WORKFLOW_FIELD_ID)).toMatchObject({ kind: 'single_select', writable: false })
  })

  it('単一選択で名前が Status の組み込みのフィールドは書けない', () => {
    expect(projectFieldDefinition(field('SINGLE_SELECT', { name: 'Status' }), WORKFLOW_FIELD_ID)).toMatchObject({ name: 'Status', writable: false })
  })

  it('単一選択でない Status という名前のフィールドは書ける', () => {
    expect(projectFieldDefinition(field('TEXT', { name: 'Status' }), WORKFLOW_FIELD_ID)).toMatchObject({ name: 'Status', writable: true })
  })

  it.for(['ASSIGNEES', 'LABELS', 'MILESTONE', 'ISSUE_TYPE', 'PARENT_ISSUE'])('Issue の機能を写す %s のフィールドは、定義に出さない', (dataType) => {
    expect(projectFieldDefinition(field(dataType), WORKFLOW_FIELD_ID)).toBeUndefined()
  })

  it('Issue field を写したフィールドは、定義に出さない', () => {
    expect(projectFieldDefinition(field('SINGLE_SELECT', { isIssueField: true }), WORKFLOW_FIELD_ID)).toBeUndefined()
  })

  it.for(['TITLE', 'REPOSITORY', 'REVIEWERS', 'LINKED_PULL_REQUESTS', 'TRACKS', 'TRACKED_BY', 'CREATED', 'UPDATED', 'CLOSED', 'SUB_ISSUES_PROGRESS', 'FUTURE_KIND'])('%s のフィールドは、unsupported で書けず、理由に種類を入れる', (dataType) => {
    expect(projectFieldDefinition(field(dataType, { name: 'X' }), WORKFLOW_FIELD_ID)).toStrictEqual({ name: 'X', source: 'project', kind: 'unsupported', writable: false, unsupportedReason: dataType })
  })
})

describe('issueFieldDefinition', () => {
  it.for([
    { dataType: 'TEXT', kind: 'text' },
    { dataType: 'NUMBER', kind: 'number' },
    { dataType: 'DATE', kind: 'date' },
  ])('$dataType の Issue field は、kind を $kind にする', ({ dataType, kind }) => {
    expect(issueFieldDefinition({ name: 'Due', dataType, options: [] })).toStrictEqual({ name: 'Due', source: 'issue_field', kind, writable: true })
  })

  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'MULTI_SELECT', kind: 'multi_select' },
  ])('$dataType の Issue field は、kind を $kind にして選択肢を持つ', ({ dataType, kind }) => {
    expect(issueFieldDefinition({ name: 'Priority', dataType, options: [{ name: 'High' }] })).toStrictEqual({ name: 'Priority', source: 'issue_field', kind, options: [{ name: 'High' }], writable: true })
  })

  it('知らない種類の Issue field は、unsupported で書けない', () => {
    expect(issueFieldDefinition({ name: 'Who', dataType: 'USER', options: [] })).toStrictEqual({ name: 'Who', source: 'issue_field', kind: 'unsupported', writable: false, unsupportedReason: 'USER' })
  })
})

describe('builtinDefinitions', () => {
  it('組み込みの機能を、担当者・マイルストーン・Issue type・ラベル・親・前提の順に返す', () => {
    const definitions = builtinDefinitions({ milestones: ['v1'], issueTypes: ['Bug', 'Task'], labels: ['bug'] })
    expect(definitions).toStrictEqual([
      { name: 'assignees', source: 'issue', kind: 'users', writable: true },
      { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1' }], writable: true },
      { name: 'type', source: 'issue', kind: 'issue_type', options: [{ name: 'Bug' }, { name: 'Task' }], writable: true },
      { name: 'labels', source: 'issue', kind: 'labels', options: [{ name: 'bug' }], writable: true },
      { name: 'parent', source: 'issue', kind: 'issue_ref', writable: false },
      { name: 'blocked_by', source: 'issue', kind: 'issue_refs', writable: false },
    ])
  })

  it('Issue type を読めない環境では、type を出さない', () => {
    expect(builtinDefinitions({ milestones: [], issueTypes: undefined, labels: [] }).map(definition => definition.name)).toStrictEqual(['assignees', 'milestone', 'labels', 'parent', 'blocked_by'])
  })
})

describe('unsupportedOf', () => {
  it('unsupported の定義だけを、名前・source・種類にする', () => {
    const definitions = [
      projectFieldDefinition(field('SUB_ISSUES_PROGRESS', { name: 'Sub-issues progress' }), WORKFLOW_FIELD_ID),
      projectFieldDefinition(field('TEXT', { name: 'Note' }), WORKFLOW_FIELD_ID),
    ].filter(definition => definition !== undefined)
    expect(unsupportedOf(definitions)).toStrictEqual([{ name: 'Sub-issues progress', source: 'project', githubType: 'SUB_ISSUES_PROGRESS' }])
  })
})

describe('projectValueTreatment', () => {
  it.for([
    { dataType: 'TEXT', kind: 'text' },
    { dataType: 'NUMBER', kind: 'number' },
    { dataType: 'DATE', kind: 'date' },
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'MULTI_SELECT', kind: 'multi_select' },
    { dataType: 'ITERATION', kind: 'iteration' },
  ])('$dataType の値は、$kind として読む', ({ dataType, kind }) => {
    expect(projectValueTreatment(dataType, false)).toStrictEqual({ treatment: 'read', kind })
  })

  it.for(['ASSIGNEES', 'LABELS', 'MILESTONE', 'ISSUE_TYPE', 'PARENT_ISSUE', 'TITLE', 'REPOSITORY', 'SUB_ISSUES_PROGRESS'])('システムのフィールド %s の値は、読み捨てる', (dataType) => {
    expect(projectValueTreatment(dataType, false)).toStrictEqual({ treatment: 'skip' })
  })

  it('Issue field を写したフィールドの値は、読み捨てる', () => {
    expect(projectValueTreatment('TEXT', true)).toStrictEqual({ treatment: 'skip' })
  })

  it('知らない種類の値は、unsupported にする', () => {
    expect(projectValueTreatment('FUTURE_KIND', false)).toStrictEqual({ treatment: 'unsupported' })
  })
})

describe('issueFieldValueKind', () => {
  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'USER', kind: 'unsupported' },
  ])('$dataType の Issue field の値は、$kind になる', ({ dataType, kind }) => {
    expect(issueFieldValueKind(dataType)).toBe(kind)
  })
})

describe('builtinReadings', () => {
  it('値のある組み込みの機能だけを、担当者・マイルストーン・Issue type・ラベルの順に返す', () => {
    expect(builtinReadings({ assignees: ['alice', 'bob'], milestone: 'v1', issueType: 'Bug', labels: ['bug'] })).toStrictEqual([
      { name: 'assignees', source: 'issue', kind: 'users', value: ['alice', 'bob'] },
      { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
      { name: 'type', source: 'issue', kind: 'issue_type', value: 'Bug' },
      { name: 'labels', source: 'issue', kind: 'labels', value: ['bug'] },
    ])
  })

  it('値の無い組み込みの機能は出さない', () => {
    expect(builtinReadings({ assignees: [], milestone: undefined, issueType: undefined, labels: [] })).toStrictEqual([])
  })
})

describe('relationReadings', () => {
  it('親を parent に、前提を blocked_by に、owner/repo/N の形で返す', () => {
    const parent = { owner: 'acme', repository: 'demo', number: 3 }
    const blockedBy = [{ owner: 'acme', repository: 'other', number: 4 }, { owner: 'acme', repository: 'demo', number: 5 }]
    expect(relationReadings(parent, blockedBy)).toStrictEqual([
      { name: 'parent', source: 'issue', kind: 'issue_ref', value: 'acme/demo/3' },
      { name: 'blocked_by', source: 'issue', kind: 'issue_refs', value: ['acme/other/4', 'acme/demo/5'] },
    ])
  })

  it('親が無く、前提が空か読めないときは出さない', () => {
    expect(relationReadings(undefined, [])).toStrictEqual([])
    expect(relationReadings(undefined, undefined)).toStrictEqual([])
  })
})

describe('issueReferenceText', () => {
  it('owner/repo/N の形にする', () => {
    expect(issueReferenceText({ owner: 'acme', repository: 'demo', number: 12 })).toBe('acme/demo/12')
  })
})

describe('formatAttributeValue', () => {
  it.for([
    { name: '文字列', value: 'High', text: 'High' },
    { name: '数', value: 2.5, text: '2.5' },
    { name: '配列', value: ['a', 'b'], text: 'a, b' },
  ])('$name の値を、1 行の文字列にする', ({ value, text }) => {
    expect(formatAttributeValue(value)).toBe(text)
  })
})
