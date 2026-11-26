import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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
  ])('$dataType のフィールドは、kind を $kind にして選択肢を持たない', async ({ dataType, kind }) => {
    await explains(`ボードのフィールドを属性の定義に変換する関数（\`projectFieldDefinition\`）のテストです。種類が \`${dataType}\` のフィールドは、\`kind\` を \`${kind}\` とし、選択肢を持たず、書き込める定義になることを確認します。`)
    expect(projectFieldDefinition(field(dataType), WORKFLOW_FIELD_ID)).toStrictEqual({ name: dataType.toLowerCase(), source: 'project', kind, writable: true })
  })

  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'MULTI_SELECT', kind: 'multi_select' },
    { dataType: 'ITERATION', kind: 'iteration' },
  ])('$dataType のフィールドは、kind を $kind にして選択肢を持つ', async ({ dataType, kind }) => {
    await explains(`ボードのフィールドを属性の定義に変換する関数（\`projectFieldDefinition\`）のテストです。種類が \`${dataType}\` のフィールドは、\`kind\` を \`${kind}\` とし、フィールドの選択肢を引き継いだ、書き込める定義になることを確認します。`)
    const options = [{ name: 'a' }, { name: 'b', startDate: '2026-01-05' }]
    expect(projectFieldDefinition(field(dataType, { name: 'Area', options }), WORKFLOW_FIELD_ID)).toStrictEqual({ name: 'Area', source: 'project', kind, options, writable: true })
  })

  it('ワークフローのフィールドと id が同じ場合は、名前によらず書き込めない定義とする', async () => {
    await explains('ワークフローのフィールドの id を持つフィールドのテストです。名前が `pecot-status` でも、`writable` が `false` の定義になることを確認します。')
    expect(projectFieldDefinition(field('SINGLE_SELECT', { id: WORKFLOW_FIELD_ID, name: 'pecot-status' }), WORKFLOW_FIELD_ID)).toMatchObject({ kind: 'single_select', writable: false })
  })

  it('単一選択で名前が Status のフィールドは、組み込みのものとして書き込めない定義にする', async () => {
    await explains('名前が `Status` の単一選択のフィールドのテストです。GitHub の組み込みのフィールドとして、`writable` が `false` の定義になることを確認します。')
    expect(projectFieldDefinition(field('SINGLE_SELECT', { name: 'Status' }), WORKFLOW_FIELD_ID)).toMatchObject({ name: 'Status', writable: false })
  })

  it('名前が Status でも単一選択でないフィールドは、書き込める定義にする', async () => {
    await explains('名前が `Status` で、種類が `TEXT` のフィールドのテストです。組み込みの `Status` ではないため、`writable` が `true` の定義になることを確認します。')
    expect(projectFieldDefinition(field('TEXT', { name: 'Status' }), WORKFLOW_FIELD_ID)).toMatchObject({ name: 'Status', writable: true })
  })

  it.for(['ASSIGNEES', 'LABELS', 'MILESTONE', 'ISSUE_TYPE', 'PARENT_ISSUE'])('Issue の機能を写した %s のフィールドは、属性の定義に含めない', async (dataType) => {
    await explains('Issue の担当者やラベルなどを写した、ボードのフィールドのテストです。属性の定義は組み込みの機能と重複するため、`undefined` を返すことを確認します。')
    expect(projectFieldDefinition(field(dataType), WORKFLOW_FIELD_ID)).toBeUndefined()
  })

  it('Issue field を写したボードのフィールドは、属性の定義に含めない', async () => {
    await explains('Issue field を写した、ボードのフィールドのテストです。Issue field として別に扱うため、`undefined` を返すことを確認します。')
    expect(projectFieldDefinition(field('SINGLE_SELECT', { isIssueField: true }), WORKFLOW_FIELD_ID)).toBeUndefined()
  })

  it.for(['TITLE', 'REPOSITORY', 'REVIEWERS', 'LINKED_PULL_REQUESTS', 'TRACKS', 'TRACKED_BY', 'CREATED', 'UPDATED', 'CLOSED', 'SUB_ISSUES_PROGRESS', 'FUTURE_KIND'])('%s のフィールドは、unsupported の書き込めない定義にし、理由に種類を入れる', async (dataType) => {
    await explains('対応していない種類のボードのフィールドのテストです。`kind` が `unsupported` で、`writable` が `false` の定義になり、`unsupportedReason` に GitHub の種類名を入れることを確認します。')
    expect(projectFieldDefinition(field(dataType, { name: 'X' }), WORKFLOW_FIELD_ID)).toStrictEqual({ name: 'X', source: 'project', kind: 'unsupported', writable: false, unsupportedReason: dataType })
  })
})

describe('issueFieldDefinition', () => {
  it.for([
    { dataType: 'TEXT', kind: 'text' },
    { dataType: 'NUMBER', kind: 'number' },
    { dataType: 'DATE', kind: 'date' },
  ])('$dataType の Issue field は、kind を $kind にする', async ({ dataType, kind }) => {
    await explains(`Issue field を属性の定義に変換する関数（\`issueFieldDefinition\`）のテストです。種類が \`${dataType}\` の Issue field は、\`kind\` を \`${kind}\` とし、書き込める定義になることを確認します。`)
    expect(issueFieldDefinition({ name: 'Due', dataType, options: [] })).toStrictEqual({ name: 'Due', source: 'issue_field', kind, writable: true })
  })

  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'MULTI_SELECT', kind: 'multi_select' },
  ])('$dataType の Issue field は、kind を $kind にして選択肢を持つ', async ({ dataType, kind }) => {
    await explains(`Issue field を属性の定義に変換する関数（\`issueFieldDefinition\`）のテストです。種類が \`${dataType}\` の Issue field は、\`kind\` を \`${kind}\` とし、選択肢を引き継いだ、書き込める定義になることを確認します。`)
    expect(issueFieldDefinition({ name: 'Priority', dataType, options: [{ name: 'High' }] })).toStrictEqual({ name: 'Priority', source: 'issue_field', kind, options: [{ name: 'High' }], writable: true })
  })

  it('対応していない種類の Issue field は、unsupported の書き込めない定義にする', async () => {
    await explains('種類が `USER` の Issue field のテストです。`kind` が `unsupported` で、`writable` が `false` の定義になり、`unsupportedReason` に種類名を入れることを確認します。')
    expect(issueFieldDefinition({ name: 'Who', dataType: 'USER', options: [] })).toStrictEqual({ name: 'Who', source: 'issue_field', kind: 'unsupported', writable: false, unsupportedReason: 'USER' })
  })
})

describe('builtinDefinitions', () => {
  it('組み込みの機能を、担当者・マイルストーン・Issue type・ラベル・親・前提の順に返す', async () => {
    await explains('組み込みの機能の定義を作成する関数（`builtinDefinitions`）のテストです。担当者・マイルストーン・Issue type・ラベル・親・前提の順に定義を返し、親と前提は書き込めない定義になることを確認します。')
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

  it('Issue type を取得できない環境では、type の定義を含めない', async () => {
    await explains('Issue type を取得できない環境のテストです。定義の一覧に `type` が含まれないことを確認します。')
    expect(builtinDefinitions({ milestones: [], issueTypes: undefined, labels: [] }).map(definition => definition.name)).toStrictEqual(['assignees', 'milestone', 'labels', 'parent', 'blocked_by'])
  })
})

describe('unsupportedOf', () => {
  it('unsupported の定義だけを、名前・source・種類にして返す', async () => {
    await explains('対応していない定義を一覧にする関数（`unsupportedOf`）のテストです。`unsupported` の定義だけを選び、名前・`source`・GitHub の種類にして返すことを確認します。')
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
  ])('$dataType の値は、$kind として読む', async ({ dataType, kind }) => {
    await explains(`ボードのフィールドの値の扱いを決める関数（\`projectValueTreatment\`）のテストです。種類が \`${dataType}\` の値は、\`${kind}\` として読み取ると判定することを確認します。`)
    expect(projectValueTreatment(dataType, false)).toStrictEqual({ treatment: 'read', kind })
  })

  it.for(['ASSIGNEES', 'LABELS', 'MILESTONE', 'ISSUE_TYPE', 'PARENT_ISSUE', 'TITLE', 'REPOSITORY', 'SUB_ISSUES_PROGRESS'])('システムのフィールド %s の値は、読み取らずに捨てる', async (dataType) => {
    await explains('ボードのシステムのフィールドの値のテストです。Issue の情報と重複するため、読み取らずに捨てる（`skip`）と判定することを確認します。')
    expect(projectValueTreatment(dataType, false)).toStrictEqual({ treatment: 'skip' })
  })

  it('Issue field を写したフィールドの値は、読み取らずに捨てる', async () => {
    await explains('Issue field を写した、ボードのフィールドの値のテストです。Issue field として別に読み取るため、読み取らずに捨てる（`skip`）と判定することを確認します。')
    expect(projectValueTreatment('TEXT', true)).toStrictEqual({ treatment: 'skip' })
  })

  it('対応していない種類の値は、unsupported と判定する', async () => {
    await explains('未知の種類のフィールドの値のテストです。読み取れないため、`unsupported` と判定することを確認します。')
    expect(projectValueTreatment('FUTURE_KIND', false)).toStrictEqual({ treatment: 'unsupported' })
  })
})

describe('issueFieldValueKind', () => {
  it.for([
    { dataType: 'SINGLE_SELECT', kind: 'single_select' },
    { dataType: 'USER', kind: 'unsupported' },
  ])('$dataType の Issue field の値は、$kind になる', async ({ dataType, kind }) => {
    await explains(`Issue field の値の種類を決める関数（\`issueFieldValueKind\`）のテストです。種類が \`${dataType}\` の Issue field の値は、\`${kind}\` になることを確認します。`)
    expect(issueFieldValueKind(dataType)).toBe(kind)
  })
})

describe('builtinReadings', () => {
  it('値が存在する組み込みの機能だけを、担当者・マイルストーン・Issue type・ラベルの順に返す', async () => {
    await explains('組み込みの機能の現在の値を作成する関数（`builtinReadings`）のテストです。値を持つ機能だけを、担当者・マイルストーン・Issue type・ラベルの順に返すことを確認します。')
    expect(builtinReadings({ assignees: ['alice', 'bob'], milestone: 'v1', issueType: 'Bug', labels: ['bug'] })).toStrictEqual([
      { name: 'assignees', source: 'issue', kind: 'users', value: ['alice', 'bob'] },
      { name: 'milestone', source: 'issue', kind: 'milestone', value: 'v1' },
      { name: 'type', source: 'issue', kind: 'issue_type', value: 'Bug' },
      { name: 'labels', source: 'issue', kind: 'labels', value: ['bug'] },
    ])
  })

  it('値が存在しない組み込みの機能は、返さない', async () => {
    await explains('担当者・ラベルが空で、マイルストーンと Issue type が `undefined` の場合のテストです。空の配列を返すことを確認します。')
    expect(builtinReadings({ assignees: [], milestone: undefined, issueType: undefined, labels: [] })).toStrictEqual([])
  })
})

describe('relationReadings', () => {
  it('親を parent に、前提を blocked_by に、owner/repo/N の形で返す', async () => {
    await explains('Issue の親と前提の現在の値を作成する関数（`relationReadings`）のテストです。親は `parent`、前提は `blocked_by` として、どちらも `owner/repo/N` の形の文字列で返すことを確認します。')
    const parent = { owner: 'acme', repository: 'demo', number: 3 }
    const blockedBy = [{ owner: 'acme', repository: 'other', number: 4 }, { owner: 'acme', repository: 'demo', number: 5 }]
    expect(relationReadings(parent, blockedBy)).toStrictEqual([
      { name: 'parent', source: 'issue', kind: 'issue_ref', value: 'acme/demo/3' },
      { name: 'blocked_by', source: 'issue', kind: 'issue_refs', value: ['acme/other/4', 'acme/demo/5'] },
    ])
  })

  it('親が存在せず、前提が空か取得できない場合は、何も返さない', async () => {
    await explains('親が `undefined` の場合のテストです。前提が空の配列でも `undefined` でも、空の配列を返すことを確認します。')
    expect(relationReadings(undefined, [])).toStrictEqual([])
    expect(relationReadings(undefined, undefined)).toStrictEqual([])
  })
})

describe('issueReferenceText', () => {
  it('Issue の参照を、owner/repo/N の形の文字列にする', async () => {
    await explains('Issue の参照を文字列にする関数（`issueReferenceText`）のテストです。`owner/repo/N` の形の文字列を返すことを確認します。')
    expect(issueReferenceText({ owner: 'acme', repository: 'demo', number: 12 })).toBe('acme/demo/12')
  })
})

describe('formatAttributeValue', () => {
  it.for([
    { name: '文字列', value: 'High', text: 'High' },
    { name: '数', value: 2.5, text: '2.5' },
    { name: '配列', value: ['a', 'b'], text: 'a, b' },
  ])('$name の値は、1 行の文字列にする', async ({ name, value, text }) => {
    await explains(`属性の値を文字列にする関数（\`formatAttributeValue\`）のテストです。${name}の値は、\`${text}\` の 1 行の文字列になることを確認します。`)
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
  it('定義に存在しない名前は、似た名前を候補にして unknown_attribute にする', async () => {
    await explains('属性の入力を検証する関数（`validateAttributes`）のテストです。定義に存在しない名前（`Aera`）を指定した場合に、`unknown_attribute` のエラーを返し、似た名前（`Area`）を候補に示すことを確認します。')
    expect(validate([{ name: 'Aera', value: 'cli' }])).toStrictEqual({ ok: false, errors: [{ code: 'unknown_attribute', name: 'Aera', candidates: ['Area'] }] })
  })

  it('source を指定して名前が存在しない場合は、その source の名前だけを候補にする', async () => {
    await explains('名前と `source` を両方指定した場合のテストです。名前が存在しない場合は、指定した `source` の定義の名前だけを候補に示すことを確認します。')
    expect(errorsOf(validate([{ name: 'Prioriti', value: 'High', source: 'project' }]))).toStrictEqual([{ code: 'unknown_attribute', name: 'Prioriti', source: 'project', candidates: [] }])
    expect(errorsOf(validate([{ name: 'Prioriti', value: 'High', source: 'issue_field' }]))).toStrictEqual([{ code: 'unknown_attribute', name: 'Prioriti', source: 'issue_field', candidates: ['Priority'] }])
  })

  it('同じ名前が複数の source に存在し、source を指定していない場合は、候補の source を示して ambiguous_attribute にする', async () => {
    await explains('ボードのフィールドと Issue field が同じ名前（`Note`）を持つ場合のテストです。`source` を指定していなければ、`ambiguous_attribute` のエラーを返し、候補の `source` を示すことを確認します。')
    expect(errorsOf(validate([{ name: 'Note', value: 'x' }]))).toStrictEqual([{ code: 'ambiguous_attribute', name: 'Note', sources: ['project', 'issue_field'] }])
  })

  it('同じ名前が複数の source に存在しても、source を指定した場合は、その定義に書き込む', async () => {
    await explains('ボードのフィールドと Issue field が同じ名前（`Note`）を持つ場合のテストです。`source` を指定すれば、指定した定義への書き込みを作成することを確認します。')
    expect(writesOf(validate([{ name: 'Note', value: 'x', source: 'issue_field' }]))).toStrictEqual([
      { name: 'Note', source: 'issue_field', kind: 'text', before: JSON_NULL, after: 'x', target: { source: 'issue_field', fieldId: '103', value: 'x' } },
    ])
  })

  it('同じ属性を入力に 2 回指定した場合は、ambiguous_attribute を 1 つだけ返す', async () => {
    await explains('同じ属性（`Area`）を 2 回指定した場合のテストです。`ambiguous_attribute` のエラーを 1 つだけ返し、重複を示すヒントを付けることを確認します。')
    expect(errorsOf(validate([{ name: 'Area', value: 'cli' }, { name: 'Area', value: 'docs', source: 'project' }]))).toStrictEqual([
      { code: 'ambiguous_attribute', name: 'Area', source: 'project', sources: ['project'], hint: 'the attribute is given more than once' },
    ])
  })

  it.for([
    { name: 'pecot-status', hint: 'move the issue with board_move' },
    { name: 'Status', hint: 'move the issue with board_move' },
  ])('ボードの列 $name は、board_move を案内して read_only_attribute にする', async ({ name, hint }) => {
    await explains(`ボードの列を属性として指定した場合のテストです。${name}は書き込めないため、\`read_only_attribute\` のエラーを返し、\`board_move\` で移動するよう案内することを確認します。`)
    expect(errorsOf(validate([{ name, value: 'Ready' }]))).toStrictEqual([{ code: 'read_only_attribute', name, source: 'project', hint }])
  })

  it.for([
    { name: 'parent', value: 'acme/demo/3', hint: 'set the parent with parent_epic' },
    { name: 'blocked_by', value: ['acme/demo/4'], hint: 'change blocked_by with issue_block or issue_unblock' },
  ])('$name は、代わりのツールを案内して read_only_attribute にする', async ({ name, value, hint }) => {
    await explains(`親と前提を属性として指定した場合のテストです。${name}は書き込めないため、\`read_only_attribute\` のエラーを返し、代わりに使うツールを案内することを確認します。`)
    expect(errorsOf(validate([{ name, value }]))).toStrictEqual([{ code: 'read_only_attribute', name, source: 'issue', hint }])
  })

  it('unsupported の定義は、read_only ではなく、GitHub の種類を示して unsupported_attribute にする', async () => {
    await explains('対応していない種類のフィールドを指定した場合のテストです。`read_only_attribute` ではなく `unsupported_attribute` のエラーを返し、GitHub の種類を示すことを確認します。')
    expect(errorsOf(validate([{ name: 'Sub-issues progress', value: 'x' }]))).toStrictEqual([
      { code: 'unsupported_attribute', name: 'Sub-issues progress', source: 'project', hint: 'GitHub type SUB_ISSUES_PROGRESS is not supported' },
    ])
  })

  it('ボードに追加されていない Issue のボードのフィールドは、board_add を案内して not_on_board にする', async () => {
    await explains('ボードに追加されていない Issue に、ボードのフィールドと Issue field を指定した場合のテストです。ボードのフィールドだけ `not_on_board` のエラーを返し、`board_add` で追加するよう案内することを確認します。')
    expect(errorsOf(validate([{ name: 'Area', value: 'cli' }, { name: 'Priority', value: 'High' }], { isOnBoard: false }))).toStrictEqual([
      { code: 'not_on_board', name: 'Area', source: 'project', hint: 'add the issue to the board with board_add' },
    ])
  })

  it('取得できなかった source の名前は、unknown ではなく、理由を示して unreadable_attribute にする', async () => {
    await explains('Issue fields を取得できなかった場合のテストです。定義に存在しない名前でも、`unknown_attribute` ではなく `unreadable_attribute` のエラーを返し、取得できなかった理由を示すことを確認します。')
    const unreadableSources = new Map<AttributeSource, string>([['issue_field', 'Issue fields are not enabled']])
    expect(errorsOf(validate([{ name: 'Risk', value: 'High' }], { unreadableSources }))).toStrictEqual([
      { code: 'unreadable_attribute', name: 'Risk', source: 'issue_field', hint: 'Issue fields are not enabled' },
    ])
  })

  it('source を指定し、その source を取得できた場合は、ほかの source を取得できなくても unknown_attribute にする', async () => {
    await explains('Issue fields を取得できず、`source` に `project` を指定した場合のテストです。指定した `source` は取得できているため、`unreadable_attribute` ではなく `unknown_attribute` のエラーを返すことを確認します。')
    const unreadableSources = new Map<AttributeSource, string>([['issue_field', 'Issue fields are not enabled']])
    expect(errorsOf(validate([{ name: 'Risk', value: 'High', source: 'project' }], { unreadableSources }))).toStrictEqual([
      { code: 'unknown_attribute', name: 'Risk', source: 'project', candidates: [] },
    ])
  })

  it.for([
    { name: 'fieldId の無い定義', definition: { name: 'Note', source: 'project', kind: 'text', writable: true }, value: 'x' },
    { name: '選択肢の id の無い定義', definition: { name: 'Area', source: 'project', kind: 'single_select', options: [{ name: 'cli' }], writable: true, fieldId: 'F' }, value: 'cli' },
    { name: 'マイルストーンの番号の無い定義', definition: { name: 'milestone', source: 'issue', kind: 'milestone', options: [{ name: 'v1' }], writable: true }, value: 'v1' },
  ] satisfies readonly { name: string, definition: AttributeDefinition, value: AttributeValue }[])('$name へ書き込むと、unreadable_attribute にする', async ({ name, definition, value }) => {
    await explains(`ID が存在しない定義への書き込みのテストです。${name}へ書き込むと、\`unreadable_attribute\` のエラーを返し、理由として \`the definition has no ID\` を示すことを確認します。`)
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
  ] satisfies readonly { name: string, attribute: string, source: AttributeSource, value: AttributeValue, expected: string }[])('$name を渡すと、取りうる値を示して invalid_value にする', async ({ name, attribute, source, value, expected }) => {
    await explains(`属性に合わない値を渡した場合のテストです。${name}を渡すと、\`invalid_value\` のエラーとなり、指定できる値（\`expected\`）が示されることを確認します。`)
    expect(errorsOf(validate([{ name: attribute, value, source }]))).toStrictEqual([{ code: 'invalid_value', name: attribute, source, value, expected }])
  })

  it('担当者にできないログイン名を指定した場合は、その名前を示して invalid_value にする', async () => {
    await explains('担当者にできないログイン名を指定した場合のテストです。`invalid_value` のエラーを返し、担当者にできない名前（`ghost`）を示すことを確認します。')
    const unassignableLogins = new Set(['ghost'])
    expect(errorsOf(validate([{ name: 'assignees', value: ['alice', 'ghost'] }], { unassignableLogins }))).toStrictEqual([
      { code: 'invalid_value', name: 'assignees', source: 'issue', value: ['alice', 'ghost'], expected: 'assignable logins', hint: 'not assignable: ghost' },
    ])
  })

  it('閏年の 2 月 29 日は、有効な日付として受け付ける', async () => {
    await explains('閏年の 2 月 29 日（`2028-02-29`）を日付のフィールドに指定した場合のテストです。エラーにならず、書き込みを作成することを確認します。')
    expect(writesOf(validate([{ name: 'Due', value: '2028-02-29' }])).map(write => write.after)).toStrictEqual(['2028-02-29'])
  })

  it('不正な入力が複数ある場合は、すべての理由を返し、書き込む予定は返さない', async () => {
    await explains('正しい入力と不正な入力が混在する場合のテストです。不正な入力すべての理由（`unknown_attribute`・`invalid_value`・`read_only_attribute`）を入力の順に返し、書き込みの予定は返さないことを確認します。')
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

  it('issue_create のように現在の値が存在しない場合は、null の入力を書き込まず無視する', async () => {
    await explains('Issue を作成するときの、現在の値が存在しない場合のテストです。`null` を指定した属性は書き込まず、書き込みの予定が空になることを確認します。')
    expect(validate([{ name: 'Area', value: JSON_NULL }, { name: 'labels', value: JSON_NULL }])).toStrictEqual({ ok: true, writes: [] })
  })

  it('issue_edit で null を指定した場合は、現在の値を外す書き込みにする', async () => {
    await explains('Issue を編集するときに、値を持つ属性へ `null` を指定した場合のテストです。ボードのフィールド・Issue field・組み込みの機能のそれぞれで、現在の値を外す書き込みになることを確認します。')
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

  it('issue_edit で null を指定しても、現在の値が存在しない場合は書き込まない', async () => {
    await explains('Issue を編集するときに、現在の値が存在しない属性へ `null` を指定した場合のテストです。書き込みの予定が空になることを確認します。')
    expect(validate([{ name: 'Area', value: JSON_NULL }], { current: [] })).toStrictEqual({ ok: true, writes: [] })
  })

  it('空の配列は、値を外す指定と同じように扱う', async () => {
    await explains('複数選択のフィールドへ空の配列を指定した場合のテストです。現在の値があれば `null` への書き込みを作成し、現在の値がなければ何も書き込まないことを確認します。')
    const current: readonly AttributeReading[] = [{ name: 'Tags', source: 'project', kind: 'multi_select', value: ['a'] }]
    expect(writesOf(validate([{ name: 'Tags', value: [] }], { current }))).toStrictEqual([
      { name: 'Tags', source: 'project', kind: 'multi_select', before: ['a'], after: JSON_NULL, target: { source: 'project', fieldId: 'PVTMSF_tags', value: JSON_NULL } },
    ])
    expect(validate([{ name: 'labels', value: [] }])).toStrictEqual({ ok: true, writes: [] })
  })

  it('issue_edit で現在の値と同じ値を指定した場合は、書き込まない', async () => {
    await explains('Issue を編集するときに、現在の値と同じ値を指定した場合のテストです。書き込みの予定が空になることを確認します。')
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
  ] satisfies readonly { name: string, attribute: string, kind: AttributeKind, before: readonly string[], after: readonly string[] }[])('$name は集合として比較し、順序だけが違う場合は書き込まない', async ({ name, attribute, kind, before, after }) => {
    await explains(`現在の値と入力の値を比較するテストです。${name}の要素の順序だけが違う場合は、書き込みを作成しないことを確認します。`)
    const source = attribute === 'Tags' ? 'project' : 'issue'
    expect(validate([{ name: attribute, value: after }], { current: [{ name: attribute, source, kind, value: before }] })).toStrictEqual({ ok: true, writes: [] })
  })

  it('集合の要素が変わる場合は、変更前と変更後の値を持つ書き込みにする', async () => {
    await explains('ラベルに要素を追加する場合のテストです。変更前の値と変更後の値を持つ書き込みを作成することを確認します。')
    const current: readonly AttributeReading[] = [{ name: 'labels', source: 'issue', kind: 'labels', value: ['bug'] }]
    expect(writesOf(validate([{ name: 'labels', value: ['bug', 'docs'] }], { current }))).toStrictEqual([
      { name: 'labels', source: 'issue', kind: 'labels', before: ['bug'], after: ['bug', 'docs'], target: { source: 'issue', write: { key: 'labels', value: ['bug', 'docs'] } } },
    ])
  })

  it('iteration を開始日で指定した場合は、一致する名前の iteration へ書き込む', async () => {
    await explains('iteration のフィールドに開始日（`2026-11-16`）を指定した場合のテストです。開始日が一致する iteration（`Sprint 2`）を探し、その ID で書き込みを作成することを確認します。')
    expect(writesOf(validate([{ name: 'Sprint', value: '2026-11-16' }]))).toStrictEqual([
      { name: 'Sprint', source: 'project', kind: 'iteration', before: JSON_NULL, after: 'Sprint 2', target: { source: 'project', fieldId: 'PVTIF_sprint', value: { iterationId: 'IT_2' } } },
    ])
  })

  it('iteration を開始日で指定しても、現在の値と同じ iteration の場合は書き込まない', async () => {
    await explains('iteration のフィールドに開始日を指定し、一致する iteration が現在の値と同じ場合のテストです。書き込みの予定が空になることを確認します。')
    const current: readonly AttributeReading[] = [{ name: 'Sprint', source: 'project', kind: 'iteration', value: 'Sprint 2' }]
    expect(validate([{ name: 'Sprint', value: '2026-11-16' }], { current })).toStrictEqual({ ok: true, writes: [] })
  })

  it('ボードのフィールドは、種類ごとの形の値と選択肢の ID で書き込む', async () => {
    await explains('ボードのフィールドへの書き込みのテストです。単一選択・複数選択・テキスト・数・日付・iteration のそれぞれで、種類に応じた形の値と選択肢の ID を持つ書き込みを作成することを確認します。')
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

  it('Issue field は、選択肢も名前のまま書き込む', async () => {
    await explains('Issue field への書き込みのテストです。選択肢の ID に変換せず、入力した名前や値のまま書き込みを作成することを確認します。')
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

  it('組み込みの機能は、REST の本文のキーと値で書き込み、マイルストーンは番号にする', async () => {
    await explains('担当者・マイルストーン・Issue type・ラベルへの書き込みのテストです。REST API の本文のキーと値の形で書き込みを作成し、マイルストーンは名前ではなく番号にすることを確認します。')
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
  it('書き込める kind のすべてに、書き込みの処理を持つ', async () => {
    await explains('書き込みの処理の一覧（`ATTRIBUTE_HANDLERS`）のテストです。書き込める `kind` のすべてが、処理を持つことを確認します。')
    expect(Object.keys(ATTRIBUTE_HANDLERS).toSorted(compareCodePoints)).toStrictEqual(['date', 'issue_type', 'iteration', 'labels', 'milestone', 'multi_select', 'number', 'single_select', 'text', 'users'])
  })
})
