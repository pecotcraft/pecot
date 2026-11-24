import { describe, expect, it } from 'vitest'

import type {
  AttributeDefinition,
  AttributeError,
  AttributeInput,
  AttributeKind,
  AttributeReading,
  AttributeSource,
  AttributeValidation,
  AttributeValidationContext,
  AttributeValue,
  AttributeWrite,
} from '../attributes.js'
import {
  ATTRIBUTE_HANDLERS,
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
  validateAttributes,
} from '../attributes.js'
import { compareCodePoints } from '../fuzzy.js'
import { JSON_NULL } from '../json-null.js'

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

const BOARD_DEFINITIONS: readonly AttributeDefinition[] = [
  { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli', id: 'OPT_cli' }, { name: 'docs', id: 'OPT_docs' }], writable: true, fieldId: 'PVTSSF_area' },
  { name: 'Tags', source: 'project', kind: 'multi_select', options: [{ name: 'a', id: 'OPT_a' }, { name: 'b', id: 'OPT_b' }], writable: true, fieldId: 'PVTMSF_tags' },
  { name: 'Note', source: 'project', kind: 'text', writable: true, fieldId: 'PVTF_note' },
  { name: 'Points', source: 'project', kind: 'number', writable: true, fieldId: 'PVTF_points' },
  { name: 'Due', source: 'project', kind: 'date', writable: true, fieldId: 'PVTF_due' },
  { name: 'Sprint', source: 'project', kind: 'iteration', options: [{ name: 'Sprint 1', startDate: '2026-11-02', id: 'IT_1' }, { name: 'Sprint 2', startDate: '2026-11-16', id: 'IT_2' }], writable: true, fieldId: 'PVTIF_sprint' },
  { name: 'pecot-status', source: 'project', kind: 'single_select', options: [{ name: 'Ready', id: 'OPT_ready' }], writable: false, fieldId: 'PVTSSF_workflow' },
  { name: 'Status', source: 'project', kind: 'single_select', options: [{ name: 'Todo', id: 'OPT_todo' }], writable: false, fieldId: 'PVTSSF_status' },
  { name: 'Sub-issues progress', source: 'project', kind: 'unsupported', writable: false, unsupportedReason: 'SUB_ISSUES_PROGRESS' },
]

const ISSUE_FIELD_DEFINITIONS: readonly AttributeDefinition[] = [
  { name: 'Priority', source: 'issue_field', kind: 'single_select', options: [{ name: 'High' }, { name: 'Low' }], writable: true, fieldId: '101' },
  { name: 'Effort', source: 'issue_field', kind: 'multi_select', options: [{ name: 'S' }, { name: 'M' }], writable: true, fieldId: '102' },
  { name: 'Note', source: 'issue_field', kind: 'text', writable: true, fieldId: '103' },
  { name: 'Start date', source: 'issue_field', kind: 'date', writable: true, fieldId: '104' },
  { name: 'Size', source: 'issue_field', kind: 'number', writable: true, fieldId: '105' },
]

const BUILTIN_DEFINITIONS: readonly AttributeDefinition[] = [
  { name: 'assignees', source: 'issue', kind: 'users', writable: true },
  { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1', id: '7' }], writable: true },
  { name: 'type', source: 'issue', kind: 'issue_type', options: [{ name: 'Bug' }, { name: 'Task' }], writable: true },
  { name: 'labels', source: 'issue', kind: 'labels', options: [{ name: 'bug' }, { name: 'docs' }], writable: true },
  { name: 'parent', source: 'issue', kind: 'issue_ref', writable: false },
  { name: 'blocked_by', source: 'issue', kind: 'issue_refs', writable: false },
]

const DEFINITIONS = [...BOARD_DEFINITIONS, ...ISSUE_FIELD_DEFINITIONS, ...BUILTIN_DEFINITIONS]

function context(overrides: Partial<AttributeValidationContext> = {}): AttributeValidationContext {
  return { unreadableSources: new Map(), unassignableLogins: new Set(), current: undefined, isOnBoard: true, ...overrides }
}

function validate(inputs: readonly AttributeInput[], overrides: Partial<AttributeValidationContext> = {}, definitions: readonly AttributeDefinition[] = DEFINITIONS): AttributeValidation {
  return validateAttributes(definitions, inputs, context(overrides))
}

function errorsOf(validation: AttributeValidation): readonly AttributeError[] {
  return validation.ok ? [] : validation.errors
}

function writesOf(validation: AttributeValidation): readonly AttributeWrite[] {
  return validation.ok ? validation.writes : []
}

describe('validateAttributes', () => {
  it('定義に無い名前は、unknown_attribute にして似た名前を候補に出す', () => {
    expect(validate([{ name: 'Aera', value: 'cli' }])).toStrictEqual({ ok: false, errors: [{ code: 'unknown_attribute', name: 'Aera', candidates: ['Area'] }] })
  })

  it('source を指定して名前が無いときは、その source の名前だけを候補に出す', () => {
    expect(errorsOf(validate([{ name: 'Prioriti', value: 'High', source: 'project' }]))).toStrictEqual([{ code: 'unknown_attribute', name: 'Prioriti', source: 'project', candidates: [] }])
    expect(errorsOf(validate([{ name: 'Prioriti', value: 'High', source: 'issue_field' }]))).toStrictEqual([{ code: 'unknown_attribute', name: 'Prioriti', source: 'issue_field', candidates: ['Priority'] }])
  })

  it('同じ名前が複数の source にあり source の指定が無いと、ambiguous_attribute にして候補の source を出す', () => {
    expect(errorsOf(validate([{ name: 'Note', value: 'x' }]))).toStrictEqual([{ code: 'ambiguous_attribute', name: 'Note', sources: ['project', 'issue_field'] }])
  })

  it('同じ名前が複数の source にあっても、source を指定すればその定義に書く', () => {
    expect(writesOf(validate([{ name: 'Note', value: 'x', source: 'issue_field' }]))).toStrictEqual([
      { name: 'Note', source: 'issue_field', kind: 'text', before: JSON_NULL, after: 'x', target: { source: 'issue_field', fieldId: '103', value: 'x' } },
    ])
  })

  it('同じ機能が入力に 2 回あると、ambiguous_attribute を 1 つだけ返す', () => {
    expect(errorsOf(validate([{ name: 'Area', value: 'cli' }, { name: 'Area', value: 'docs', source: 'project' }]))).toStrictEqual([
      { code: 'ambiguous_attribute', name: 'Area', source: 'project', sources: ['project'], hint: 'the attribute is given more than once' },
    ])
  })

  it.for([
    { name: 'pecot-status', hint: 'move the issue with board_move' },
    { name: 'Status', hint: 'move the issue with board_move' },
  ])('ボードの列 $name は、read_only_attribute にして board_move を案内する', ({ name, hint }) => {
    expect(errorsOf(validate([{ name, value: 'Ready' }]))).toStrictEqual([{ code: 'read_only_attribute', name, source: 'project', hint }])
  })

  it.for([
    { name: 'parent', value: 'acme/demo/3', hint: 'set the parent with parent_epic' },
    { name: 'blocked_by', value: ['acme/demo/4'], hint: 'change blocked_by with issue_block or issue_unblock' },
  ])('$name は、read_only_attribute にして代わりのツールを案内する', ({ name, value, hint }) => {
    expect(errorsOf(validate([{ name, value }]))).toStrictEqual([{ code: 'read_only_attribute', name, source: 'issue', hint }])
  })

  it('unsupported の定義は、read_only でなく unsupported_attribute にして GitHub の種類を出す', () => {
    expect(errorsOf(validate([{ name: 'Sub-issues progress', value: 'x' }]))).toStrictEqual([
      { code: 'unsupported_attribute', name: 'Sub-issues progress', source: 'project', hint: 'GitHub type SUB_ISSUES_PROGRESS is not supported' },
    ])
  })

  it('ボードに載っていない Issue のボードのフィールドは、not_on_board にして board_add を案内する', () => {
    expect(errorsOf(validate([{ name: 'Area', value: 'cli' }, { name: 'Priority', value: 'High' }], { isOnBoard: false }))).toStrictEqual([
      { code: 'not_on_board', name: 'Area', source: 'project', hint: 'add the issue to the board with board_add' },
    ])
  })

  it('読めなかった source にある名前は、unknown でなく unreadable_attribute にして理由を出す', () => {
    const unreadableSources = new Map<AttributeSource, string>([['issue_field', 'Issue fields are not enabled']])
    expect(errorsOf(validate([{ name: 'Risk', value: 'High' }], { unreadableSources }))).toStrictEqual([
      { code: 'unreadable_attribute', name: 'Risk', source: 'issue_field', hint: 'Issue fields are not enabled' },
    ])
  })

  it('source を指定して、その source が読めていれば、ほかの source が読めなくても unknown_attribute にする', () => {
    const unreadableSources = new Map<AttributeSource, string>([['issue_field', 'Issue fields are not enabled']])
    expect(errorsOf(validate([{ name: 'Risk', value: 'High', source: 'project' }], { unreadableSources }))).toStrictEqual([
      { code: 'unknown_attribute', name: 'Risk', source: 'project', candidates: [] },
    ])
  })

  it.for([
    { name: 'fieldId の無い定義', definition: { name: 'Note', source: 'project', kind: 'text', writable: true }, value: 'x' },
    { name: '選択肢の id の無い定義', definition: { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli' }], writable: true, fieldId: 'F' }, value: 'cli' },
    { name: 'マイルストーンの番号の無い定義', definition: { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1' }], writable: true }, value: 'v1' },
  ] satisfies readonly { name: string, definition: AttributeDefinition, value: AttributeValue }[])('$name に書くと、unreadable_attribute にする', ({ definition, value }) => {
    expect(errorsOf(validate([{ name: definition.name, value }], {}, [definition]))).toStrictEqual([
      { code: 'unreadable_attribute', name: definition.name, source: definition.source, hint: 'the definition has no ID' },
    ])
  })

  it.for([
    { name: 'text に数', attribute: 'Note', source: 'project', value: 3, expected: 'string' },
    { name: 'number に文字列', attribute: 'Points', source: 'project', value: '3', expected: 'number' },
    { name: 'number に NaN', attribute: 'Points', source: 'project', value: NaN, expected: 'number' },
    { name: 'number に Infinity', attribute: 'Points', source: 'project', value: Infinity, expected: 'number' },
    { name: 'date に実在しない日', attribute: 'Due', source: 'project', value: '2026-02-30', expected: 'YYYY-MM-DD' },
    { name: 'date に別の形', attribute: 'Due', source: 'project', value: '2026/11/24', expected: 'YYYY-MM-DD' },
    { name: 'single_select に大文字違い', attribute: 'Area', source: 'project', value: 'CLI', expected: 'one of: cli, docs' },
    { name: 'single_select に配列', attribute: 'Priority', source: 'issue_field', value: ['High'], expected: 'one of: High, Low' },
    { name: 'multi_select に無い名前', attribute: 'Tags', source: 'project', value: ['a', 'c'], expected: 'list of: a, b' },
    { name: 'multi_select に重複', attribute: 'Tags', source: 'project', value: ['a', 'a'], expected: 'list of: a, b' },
    { name: 'multi_select に文字列', attribute: 'Effort', source: 'issue_field', value: 'S', expected: 'list of: S, M' },
    { name: 'labels に無い名前', attribute: 'labels', source: 'issue', value: ['wontfix'], expected: 'list of: bug, docs' },
    { name: 'iteration に無い名前', attribute: 'Sprint', source: 'project', value: 'Sprint 3', expected: 'iteration name or start date: Sprint 1 (2026-11-02), Sprint 2 (2026-11-16)' },
    { name: 'milestone に無い名前', attribute: 'milestone', source: 'issue', value: 'v2', expected: 'one of: v1' },
    { name: 'type に無い名前', attribute: 'type', source: 'issue', value: 'Epic', expected: 'one of: Bug, Task' },
    { name: 'users に文字列', attribute: 'assignees', source: 'issue', value: 'alice', expected: 'assignable logins' },
    { name: 'users に空の名前', attribute: 'assignees', source: 'issue', value: [''], expected: 'assignable logins' },
  ] satisfies readonly { name: string, attribute: string, source: AttributeSource, value: AttributeValue, expected: string }[])('$name を渡すと、invalid_value にして取りうる値を出す', ({ attribute, source, value, expected }) => {
    expect(errorsOf(validate([{ name: attribute, value, source }]))).toStrictEqual([{ code: 'invalid_value', name: attribute, source, value, expected }])
  })

  it('担当にできないログイン名は、invalid_value にしてその名前を出す', () => {
    const unassignableLogins = new Set(['ghost'])
    expect(errorsOf(validate([{ name: 'assignees', value: ['alice', 'ghost'] }], { unassignableLogins }))).toStrictEqual([
      { code: 'invalid_value', name: 'assignees', source: 'issue', value: ['alice', 'ghost'], expected: 'assignable logins', hint: 'not assignable: ghost' },
    ])
  })

  it('閏年の 2 月 29 日は、date として通す', () => {
    expect(writesOf(validate([{ name: 'Due', value: '2028-02-29' }])).map(write => write.after)).toStrictEqual(['2028-02-29'])
  })

  it('合わない入力が複数あると、全部の理由を返して書く予定を返さない', () => {
    const validation = validate([
      { name: 'Area', value: 'cli' },
      { name: 'Aera', value: 'cli' },
      { name: 'Points', value: 'many' },
      { name: 'parent', value: 'acme/demo/1' },
    ])
    expect(validation.ok).toBe(false)
    expect(validation).not.toHaveProperty('writes')
    expect(errorsOf(validation).map(error => [error.code, error.name])).toStrictEqual([
      ['unknown_attribute', 'Aera'],
      ['invalid_value', 'Points'],
      ['read_only_attribute', 'parent'],
    ])
  })

  it('issue_create（今の値が無い）では、null の入力を書かずに飛ばす', () => {
    expect(validate([{ name: 'Area', value: JSON_NULL }, { name: 'labels', value: JSON_NULL }])).toStrictEqual({ ok: true, writes: [] })
  })

  it('issue_edit で null を渡すと、今の値を外す書き方にする', () => {
    const current: readonly AttributeReading[] = [
      { name: 'Area', source: 'project', kind: 'single_select', value: 'cli' },
      { name: 'Priority', source: 'issue_field', kind: 'single_select', value: 'High' },
      { name: 'assignees', source: 'issue', kind: 'users', value: ['alice'] },
      { name: 'labels', source: 'issue', kind: 'labels', value: ['bug'] },
      { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
      { name: 'type', source: 'issue', kind: 'issue_type', value: 'Bug' },
    ]
    const inputs = current.map(reading => ({ name: reading.name, value: JSON_NULL }))
    expect(writesOf(validate(inputs, { current })).map(write => [write.name, write.before, write.after, write.target])).toStrictEqual([
      ['Area', 'cli', JSON_NULL, { source: 'project', fieldId: 'PVTSSF_area', value: JSON_NULL }],
      ['Priority', 'High', JSON_NULL, { source: 'issue_field', fieldId: '101', value: JSON_NULL }],
      ['assignees', ['alice'], JSON_NULL, { source: 'issue', write: { key: 'assignees', value: [] } }],
      ['labels', ['bug'], JSON_NULL, { source: 'issue', write: { key: 'labels', value: [] } }],
      ['milestone', 'v1', JSON_NULL, { source: 'issue', write: { key: 'milestone', value: JSON_NULL } }],
      ['type', 'Bug', JSON_NULL, { source: 'issue', write: { key: 'type', value: JSON_NULL } }],
    ])
  })

  it('issue_edit で null を渡しても、今の値が無ければ書かない', () => {
    expect(validate([{ name: 'Area', value: JSON_NULL }], { current: [] })).toStrictEqual({ ok: true, writes: [] })
  })

  it('空の配列は、外すのと同じに扱う', () => {
    const current: readonly AttributeReading[] = [{ name: 'Tags', source: 'project', kind: 'multi_select', value: ['a'] }]
    expect(writesOf(validate([{ name: 'Tags', value: [] }], { current }))).toStrictEqual([
      { name: 'Tags', source: 'project', kind: 'multi_select', before: ['a'], after: JSON_NULL, target: { source: 'project', fieldId: 'PVTMSF_tags', value: JSON_NULL } },
    ])
    expect(validate([{ name: 'labels', value: [] }])).toStrictEqual({ ok: true, writes: [] })
  })

  it('issue_edit で今の値と同じ値は書かない', () => {
    const current: readonly AttributeReading[] = [
      { name: 'Note', source: 'project', kind: 'text', value: 'x' },
      { name: 'Points', source: 'project', kind: 'number', value: 3 },
    ]
    expect(validate([{ name: 'Note', value: 'x', source: 'project' }, { name: 'Points', value: 3 }], { current })).toStrictEqual({ ok: true, writes: [] })
  })

  it.for([
    { name: 'multi_select', attribute: 'Tags', kind: 'multi_select', before: ['a', 'b'], after: ['b', 'a'] },
    { name: 'labels', attribute: 'labels', kind: 'labels', before: ['bug', 'docs'], after: ['docs', 'bug'] },
    { name: 'users', attribute: 'assignees', kind: 'users', before: ['alice', 'bob'], after: ['bob', 'alice'] },
  ] satisfies readonly { name: string, attribute: string, kind: AttributeKind, before: readonly string[], after: readonly string[] }[])('$name は集合として比べ、順だけが違えば書かない', ({ attribute, kind, before, after }) => {
    const source = attribute === 'Tags' ? 'project' : 'issue'
    expect(validate([{ name: attribute, value: after }], { current: [{ name: attribute, source, kind, value: before }] })).toStrictEqual({ ok: true, writes: [] })
  })

  it('集合の中身が変われば、前と後の値で書く', () => {
    const current: readonly AttributeReading[] = [{ name: 'labels', source: 'issue', kind: 'labels', value: ['bug'] }]
    expect(writesOf(validate([{ name: 'labels', value: ['bug', 'docs'] }], { current }))).toStrictEqual([
      { name: 'labels', source: 'issue', kind: 'labels', before: ['bug'], after: ['bug', 'docs'], target: { source: 'issue', write: { key: 'labels', value: ['bug', 'docs'] } } },
    ])
  })

  it('iteration を開始日で受けると、名前に引き当てて書く', () => {
    expect(writesOf(validate([{ name: 'Sprint', value: '2026-11-16' }]))).toStrictEqual([
      { name: 'Sprint', source: 'project', kind: 'iteration', before: JSON_NULL, after: 'Sprint 2', target: { source: 'project', fieldId: 'PVTIF_sprint', value: { iterationId: 'IT_2' } } },
    ])
  })

  it('iteration を開始日で受けても、今の値の名前と同じなら書かない', () => {
    const current: readonly AttributeReading[] = [{ name: 'Sprint', source: 'project', kind: 'iteration', value: 'Sprint 2' }]
    expect(validate([{ name: 'Sprint', value: '2026-11-16' }], { current })).toStrictEqual({ ok: true, writes: [] })
  })

  it('ボードのフィールドは、種類ごとの値と選択肢の ID で書く', () => {
    const inputs: readonly AttributeInput[] = [
      { name: 'Area', value: 'docs' },
      { name: 'Tags', value: ['b', 'a'] },
      { name: 'Note', value: 'memo', source: 'project' },
      { name: 'Points', value: 2.5 },
      { name: 'Due', value: '2026-12-01' },
      { name: 'Sprint', value: 'Sprint 1' },
    ]
    expect(writesOf(validate(inputs)).map(write => write.target)).toStrictEqual([
      { source: 'project', fieldId: 'PVTSSF_area', value: { singleSelectOptionId: 'OPT_docs' } },
      { source: 'project', fieldId: 'PVTMSF_tags', value: { multiSelectOptionIds: ['OPT_b', 'OPT_a'] } },
      { source: 'project', fieldId: 'PVTF_note', value: { text: 'memo' } },
      { source: 'project', fieldId: 'PVTF_points', value: { number: 2.5 } },
      { source: 'project', fieldId: 'PVTF_due', value: { date: '2026-12-01' } },
      { source: 'project', fieldId: 'PVTIF_sprint', value: { iterationId: 'IT_1' } },
    ])
  })

  it('Issue fields は、選択肢も名前のまま書く', () => {
    const inputs: readonly AttributeInput[] = [
      { name: 'Priority', value: 'High' },
      { name: 'Effort', value: ['S', 'M'] },
      { name: 'Note', value: 'memo', source: 'issue_field' },
      { name: 'Start date', value: '2026-11-24' },
      { name: 'Size', value: 5 },
    ]
    expect(writesOf(validate(inputs)).map(write => write.target)).toStrictEqual([
      { source: 'issue_field', fieldId: '101', value: 'High' },
      { source: 'issue_field', fieldId: '102', value: ['S', 'M'] },
      { source: 'issue_field', fieldId: '103', value: 'memo' },
      { source: 'issue_field', fieldId: '104', value: '2026-11-24' },
      { source: 'issue_field', fieldId: '105', value: 5 },
    ])
  })

  it('組み込みの機能は、REST の本文のキーと値で書き、マイルストーンは番号にする', () => {
    const inputs: readonly AttributeInput[] = [
      { name: 'assignees', value: ['alice'] },
      { name: 'milestone', value: 'v1' },
      { name: 'type', value: 'Task' },
      { name: 'labels', value: ['docs'] },
    ]
    expect(writesOf(validate(inputs)).map(write => write.target)).toStrictEqual([
      { source: 'issue', write: { key: 'assignees', value: ['alice'] } },
      { source: 'issue', write: { key: 'milestone', value: 7 } },
      { source: 'issue', write: { key: 'type', value: 'Task' } },
      { source: 'issue', write: { key: 'labels', value: ['docs'] } },
    ])
  })
})

describe('ATTRIBUTE_HANDLERS', () => {
  it('書ける kind ごとに扱いを持つ', () => {
    expect(Object.keys(ATTRIBUTE_HANDLERS).toSorted(compareCodePoints)).toStrictEqual(['date', 'issue_type', 'iteration', 'labels', 'milestone', 'multi_select', 'number', 'single_select', 'text', 'users'])
  })
})
