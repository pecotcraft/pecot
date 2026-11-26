import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { JSON_NULL } from '../json-null.js'
import { boardItemKey, extractFieldValueById, extractFieldValueByName, fieldNameById, fieldNamesWithValues, formatBoardOutput, formatItemsJson, formatStackableChains, formatTableRow, transformItems } from '../format.js'
import type { BoardItem } from '../format.js'
import type { JsonValue } from '../python-format.js'

type RawItem = Readonly<Record<string, JsonValue>>

const SAMPLE_RAW_ITEMS: readonly RawItem[] = [
  {
    id: 'item1',
    updatedAt: '2026-01-14T10:00:00Z',
    fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-test' }, name: 'Active' }] },
    content: {
      number: 100,
      title: 'Active Issue',
      state: 'OPEN',
      url: 'https://github.com/test/repo/issues/100',
      labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }] },
      repository: { owner: { login: 'test' }, name: 'repo' },
    },
  },
  {
    id: 'item2',
    updatedAt: '2026-01-13T10:00:00Z',
    fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-test' }, name: 'Ready' }] },
    content: {
      number: 101,
      title: 'Ready Issue',
      state: 'OPEN',
      url: 'https://github.com/test/repo/issues/101',
      labels: { nodes: [] },
      repository: { owner: { login: 'test' }, name: 'repo' },
    },
  },
  {
    id: 'item3',
    updatedAt: '2026-01-12T10:00:00Z',
    fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-test' }, name: 'Backlog' }] },
    content: {
      number: 102,
      title: 'Backlog Issue',
      state: 'OPEN',
      url: 'https://github.com/test/repo/issues/102',
      labels: { nodes: [{ name: 'enhancement' }] },
      repository: { owner: { login: 'test' }, name: 'repo' },
    },
  },
  {
    id: 'item4',
    updatedAt: '2026-01-11T10:00:00Z',
    fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-test' }, name: 'Archived' }] },
    content: {
      number: 103,
      title: 'Done Issue',
      state: 'CLOSED',
      url: 'https://github.com/test/repo/issues/103',
      labels: { nodes: [{ name: 'bug' }] },
      repository: { owner: { login: 'test' }, name: 'repo' },
    },
  },
]

function firstItem(items: readonly BoardItem[]): BoardItem {
  const [item] = items
  if (item === undefined) throw new Error('item がありません')
  return item
}

describe('extractFieldValueByName', () => {
  it('名前の合うフィールドがあるとき、その値を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。指定した名前と一致するフィールドがある場合に、その値を返すことを確認します。')
    const item = { fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Active' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBe('Active')
  })

  it('どのフィールドの名前も一致しない場合は、undefined を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。指定した名前と一致するフィールドが存在しない場合に、`undefined` を返すことを確認します。')
    const item = { fieldValues: { nodes: [{ field: { name: 'Priority' }, name: 'High' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBeUndefined()
  })

  it('fieldValues が空のとき、undefined を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。`fieldValues` のノードが空の場合に、`undefined` を返すことを確認します。')
    expect(extractFieldValueByName({ fieldValues: { nodes: [] } }, 'pecot-workflow-test')).toBeUndefined()
  })

  it('fieldValues が存在しない場合は、undefined を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。`fieldValues` が存在しない場合に、`undefined` を返すことを確認します。')
    expect(extractFieldValueByName({}, 'pecot-workflow-test')).toBeUndefined()
  })

  it('フィールド名の大文字と小文字を区別せずに探す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。フィールド名が大文字と小文字だけ異なる場合でも、一致するフィールドの値を返すことを確認します。')
    const item = { fieldValues: { nodes: [{ field: { name: 'PECOT-WORKFLOW-TEST' }, name: 'Ready' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBe('Ready')
  })

  it('空のノードが混在していても、ワークフローのフィールドの値を取り出す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。空のノードが前後に混在している場合でも、一致するフィールドの値を取り出せることを確認します。')
    const item = { fieldValues: { nodes: [{}, {}, { field: { name: 'pecot-workflow-test' }, name: 'Active' }, {}] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBe('Active')
  })

  it('field が存在しないノードは、読み飛ばして取り出す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。`field` を持たないノードが先頭の場合に、そのノードを無視して、次の一致するフィールドの値を返すことを確認します。')
    const item = { fieldValues: { nodes: [{ name: 'SomeValue' }, { field: { name: 'pecot-workflow-test' }, name: 'Backlog' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBe('Backlog')
  })

  it('null のノードが含まれていても、エラーにならず取り出す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。ノードの一覧に `null` が含まれる場合でも、例外が発生せず、一致するフィールドの値を返すことを確認します。')
    const item = { fieldValues: { nodes: [JSON_NULL, { field: { name: 'pecot-workflow-test' }, name: 'Done' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBe('Done')
  })

  it('値の名前が null の場合は、最初に見つけた時点で未設定として返す', async () => {
    await explains('ボードの Issue から、フィールドの値を名前で取り出す、`extractFieldValueByName` のテストです。一致するフィールドが 2 つあり、先のフィールドの値の名前が `null` の場合に、後のフィールドは見ず、`undefined`（未設定）を返すことを確認します。')
    const item = { fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: JSON_NULL }, { field: { name: 'pecot-workflow-test' }, name: 'Active' }] } }
    expect(extractFieldValueByName(item, 'pecot-workflow-test')).toBeUndefined()
  })
})

describe('extractFieldValueById', () => {
  it('名前に関係なく、ID が一致するフィールドの値を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を ID で取り出す、`extractFieldValueById` のテストです。フィールドの名前が変更されていても、ID が一致するフィールドの値を返すことを確認します。')
    const item = { fieldValues: { nodes: [{}, { field: { id: 'F_other', name: 'pecot-status' }, name: 'Todo' }, { field: { id: 'F_wf', name: 'pecot-workflow-old' }, name: 'Ready' }] } }
    expect(extractFieldValueById(item, 'F_wf')).toBe('Ready')
  })

  it('ID が一致するフィールドが存在しない場合は、undefined を返す', async () => {
    await explains('ボードの Issue から、フィールドの値を ID で取り出す、`extractFieldValueById` のテストです。ID が一致するフィールドが存在しない場合に、`undefined` を返すことを確認します。')
    expect(extractFieldValueById({ fieldValues: { nodes: [{ field: { name: 'F_wf' }, name: 'Ready' }] } }, 'F_wf')).toBeUndefined()
  })
})

describe('fieldNameById', () => {
  it('値が入った最初の Item から、ID が一致するフィールドの現在の名前を返す', async () => {
    await explains('ID からフィールドの現在の名前を返す、`fieldNameById` のテストです。値が入っていない Item を飛ばし、値が入った最初の Item にある、ID が一致するフィールドの名前を返すことを確認します。')
    const items = [{ fieldValues: { nodes: [] } }, { fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-old' }, name: 'Ready' }] } }]
    expect(fieldNameById(items, 'F_wf')).toBe('pecot-workflow-old')
  })

  it('どの Item にも値が入っていない場合は、undefined を返す', async () => {
    await explains('ID からフィールドの現在の名前を返す、`fieldNameById` のテストです。どの Item にも値が入っていない場合に、`undefined` を返すことを確認します。')
    expect(fieldNameById([{ fieldValues: { nodes: [] } }], 'F_wf')).toBeUndefined()
  })
})

describe('fieldNamesWithValues', () => {
  it('どれかの Item に値が入っている名前だけを、渡した名前の順に返す', async () => {
    await explains('値が入っているフィールドの名前を選ぶ、`fieldNamesWithValues` のテストです。渡した名前のうち、どれかの Item に値が入っているものだけを、渡した順に返すことを確認します。')
    const items = [
      { fieldValues: { nodes: [{ field: { id: 'F_s', name: 'pecot-size' }, name: 'M' }] } },
      { fieldValues: { nodes: [{ field: { id: 'F_p', name: 'pecot-priority' }, name: 'High' }, {}] } },
    ]
    expect(fieldNamesWithValues(items, ['pecot-priority', 'pecot-size', 'pecot-other'])).toEqual(['pecot-priority', 'pecot-size'])
  })

  it('どの Item にも値が入っていない場合は、空の配列を返す', async () => {
    await explains('値が入っているフィールドの名前を選ぶ、`fieldNamesWithValues` のテストです。どの Item にも値が入っていない場合に、空の配列を返すことを確認します。')
    expect(fieldNamesWithValues([{ fieldValues: { nodes: [] } }], ['pecot-priority'])).toEqual([])
  })
})

describe('transformItems', () => {
  it('GraphQL の項目を、workflow・title・番号・ラベルを持つ項目に変換する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。GraphQL で取得した 4 件の項目を渡した場合に、`workflow`・`title`・Issue の番号・ラベルの一覧を持つ項目へ変換することを確認します。')
    const items = transformItems(SAMPLE_RAW_ITEMS, 'F_wf')
    expect(items).toHaveLength(4)
    const item = firstItem(items)
    expect(item.workflow).toBe('Active')
    expect(item.title).toBe('Active Issue')
    expect(item.content.number).toBe(100)
    expect(item.content.labels).toEqual(['bug', 'urgent'])
  })

  it('出力のキーを、id・workflow・lane・title・updatedAt・content の順に並べる', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。変換した項目を JSON へ出力した場合に、キーが `id`・`workflow`・`lane`・`title`・`updatedAt`・`content` の順に並ぶことを確認します。')
    const [item] = transformItems(SAMPLE_RAW_ITEMS, 'F_wf')
    expect(JSON.stringify(item)).toBe(JSON.stringify({
      id: 'item1',
      workflow: 'Active',
      lane: JSON_NULL,
      title: 'Active Issue',
      updatedAt: '2026-01-14T10:00:00Z',
      content: {
        number: 100,
        state: 'OPEN',
        url: 'https://github.com/test/repo/issues/100',
        labels: ['bug', 'urgent'],
        repository: 'test/repo',
      },
    }))
  })

  it('項目に値が存在しない場合は、JSON にすると null として出力する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。`title` しかない項目を渡した場合に、存在しない値は `null`、`labels` は空の配列、`updatedAt` と `repository` は空文字で出力されることを確認します。')
    const [item] = transformItems([{ id: 'x', content: { title: 't' } }], 'F_wf')
    expect(JSON.stringify(item)).toBe('{"id":"x","workflow":null,"lane":null,"title":"t","updatedAt":"","content":{"number":null,"state":null,"url":null,"labels":[],"repository":""}}')
  })

  it('Item に lane の値がある場合は、その名前を lane に設定する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。Item に `lane` の値がある場合に、その名前が変換後の `lane` に入ることを確認します。')
    const [item] = transformItems([{ id: 'x', lane: { name: 'alpha' }, content: { title: 't' } }], 'F_wf')
    expect(item?.lane).toBe('alpha')
  })

  it('ラベルが存在しない場合は、labels を空の配列にする', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。ラベルを持たない項目を変換した場合に、`content.labels` が空の配列になることを確認します。')
    const items = transformItems(SAMPLE_RAW_ITEMS, 'F_wf')
    const ready = items.find(item => item.workflow === 'Ready')
    expect(ready?.content.labels).toEqual([])
  })

  it('content が存在しない項目は、変換せず除外する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。下書きのように `content` が `null` の項目を渡した場合に、結果から除外されることを確認します。')
    const raw = [{ id: 'draft', fieldValues: { nodes: [] }, content: JSON_NULL }]
    expect(transformItems(raw, 'F_wf')).toHaveLength(0)
  })

  it('content が空の項目も、変換せず除外する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。`content` が空のオブジェクトの項目を渡した場合に、結果から除外されることを確認します。')
    expect(transformItems([{ id: 'x', content: {} }], 'F_wf')).toHaveLength(0)
  })

  it('不正なラベルのノードは、読み飛ばす', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。ラベルのノードに、名前がないものや名前が空文字のものが含まれる場合に、それらを除いた名前だけを `labels` に入れることを確認します。')
    const raw = [{
      id: 'item1',
      updatedAt: '2026-01-14T10:00:00Z',
      fieldValues: { nodes: [] },
      content: {
        number: 100,
        title: 'Test',
        state: 'OPEN',
        url: 'https://example.com',
        labels: { nodes: [{ name: 'valid' }, {}, { name: '' }, { other: 'field' }, { name: 'also-valid' }] },
      },
    }]
    expect(firstItem(transformItems(raw, 'F_wf')).content.labels).toEqual(['valid', 'also-valid'])
  })

  it('空の fieldValue のノードがあっても、エラーにならず変換する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。`fieldValues` に空のノードが含まれている場合でも、例外が発生せず、`workflow` の値を取り出せることを確認します。')
    const raw = [{
      id: 'item1',
      updatedAt: '2026-01-14T10:00:00Z',
      fieldValues: { nodes: [{}, {}, { field: { id: 'F_wf', name: 'pecot-status' }, name: 'Active' }, {}] },
      content: { number: 100, title: 'Test', state: 'OPEN', url: 'https://example.com', labels: { nodes: [] } },
    }]
    expect(firstItem(transformItems(raw, 'F_wf')).workflow).toBe('Active')
  })

  it('labels のフィールドが存在しなくても、エラーにならず変換する', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。`content` に `labels` が存在しない場合でも、例外が発生せず、`labels` が空の配列になることを確認します。')
    const raw = [{
      id: 'item1',
      updatedAt: '2026-01-14T10:00:00Z',
      fieldValues: { nodes: [] },
      content: { number: 100, title: 'Test', state: 'OPEN', url: 'https://example.com' },
    }]
    expect(firstItem(transformItems(raw, 'F_wf')).content.labels).toEqual([])
  })

  it('リポジトリの owner か名前が欠けている場合は、repository を空文字にする', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。`repository` に owner と名前のどちらか一方しかない場合に、変換後の `repository` が空文字になることを確認します。')
    const raw = [
      { id: 'a', content: { number: 1, repository: { owner: { login: 'o' } } } },
      { id: 'b', content: { number: 2, repository: { name: 'n' } } },
    ]
    expect(transformItems(raw, 'F_wf').map(item => item.content.repository)).toEqual(['', ''])
  })

  it('欠けているキーは、既定値にする（id・title・updatedAt は空文字、ほかは null）', async () => {
    await explains('GraphQL で取得したボードの項目を変換する、`transformItems` のテストです。必須ではないキーが欠けている項目を渡した場合に、`id`・`title`・`updatedAt` は空文字、`workflow`・`lane`・`state`・`url` は `null` になることを確認します。')
    const [item] = transformItems([{ content: { number: 1 } }], 'F_wf')
    expect(item).toEqual({ id: '', workflow: JSON_NULL, lane: JSON_NULL, title: '', updatedAt: '', content: { number: 1, state: JSON_NULL, url: JSON_NULL, labels: [], repository: '' } })
  })
})

describe('formatBoardOutput', () => {
  it('ステータスの見出しと Ref・Title の表を表示し、プロジェクト名の見出しと 0 件の見出しは表示しない', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。4 つのステータスの項目を渡した場合に、ステータスごとの見出しと `| Ref | Title |` の表を含み、プロジェクト名の見出しと、項目が 0 件のステータスの見出しを含まないことを確認します。')
    const output = formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'F_wf'))

    // プロジェクト名見出しは出力されない
    expect(output).not.toContain('## プロジェクト:')

    // サンプルが持つステータスのみが見出しに出る
    for (const status of ['Active', 'Ready', 'Backlog', 'Archived']) expect(output).toContain(`### ${status}`)
    // サンプルに無いステータスは出ない (0 件セクション抑制)
    expect(output).not.toContain('### In Review')
    expect(output).not.toContain('### Pending')

    // Ref が owner/repo#N 形式で含まれる
    for (const number of [100, 101, 102, 103]) expect(output).toContain(`| test/repo#${String(number)} |`)

    // 2 カラムヘッダ
    expect(output).toContain('| Ref | Title |')
    // 旧 3 カラムヘッダ/旧カラムは残っていない
    expect(output).not.toContain('| # | タイトル | リポジトリ |')
  })

  it('出力の全体が、Python の出力と同じになる（見出し・表・空行）', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。4 つのステータスの項目を渡した場合に、見出し・表・空行を含む出力の全体が、Python の実出力と一致することを確認します。')
    expect(formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'F_wf'))).toBe([
      '### Active (1)',
      '| Ref | Title |',
      '|-----|----------|',
      '| test/repo#100 | Active Issue |',
      '',
      '### Ready (1)',
      '| Ref | Title |',
      '|-----|----------|',
      '| test/repo#101 | Ready Issue |',
      '',
      '### Backlog (1)',
      '| Ref | Title |',
      '|-----|----------|',
      '| test/repo#102 | Backlog Issue |',
      '',
      '### Archived (1)',
      '| Ref | Title |',
      '|-----|----------|',
      '| test/repo#103 | Done Issue |',
    ].join('\n'))
  })

  it('項目をステータスごとにまとめて表示する', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。複数のステータスの項目を渡した場合に、ステータスごとの見出しと件数を表示することを確認します。')
    const output = formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'F_wf'))
    expect(output).toContain('### Ready (1)')
    expect(output).toContain('### Archived (1)')
  })

  it('項目が存在しないステータスは、表示しない', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。項目が 1 件しかない場合に、その項目があるステータスの見出しだけを表示し、ほかのステータスの見出しと「(なし)」の表示を含まないことを確認します。')
    const items: readonly BoardItem[] = [{ id: 'item1', workflow: 'Active', title: 'Test', updatedAt: '2026-01-14T10:00:00Z', content: { number: 1, labels: [] } }]
    const output = formatBoardOutput(items)
    // 件数のあるステータスのみが見出しに出る
    expect(output).toContain('### Active (1)')
    expect(output).not.toContain('### Backlog')
    expect(output).not.toContain('### Archived')
    // 「(なし)」は廃止
    expect(output).not.toContain('(なし)')
  })

  it('Archived の項目は、更新が新しい 5 件だけを表示する', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。`Archived` の項目が 10 件ある場合に、見出しを `latest 5 of 10` とし、更新日時が新しい 5 件を新しい順に表示して、古い 5 件を含めないことを確認します。')
    const items: BoardItem[] = []
    for (let index = 0; index < 10; index += 1) {
      items.push({ id: `item${String(index)}`, workflow: 'Archived', title: `Archived Issue ${String(index)}`, updatedAt: `2026-01-${String(10 + index).padStart(2, '0')}T10:00:00Z`, content: { number: index, labels: [] } })
    }
    const output = formatBoardOutput(items)

    // 10 件中直近 5 件と表示
    expect(output).toContain('### Archived (latest 5 of 10)')
    // 最新の 5 件（番号 9 / 8 / 7 / 6 / 5）が含まれ、新しい順に並ぶ (repository 未設定 → #N)
    expect(output.split('\n').filter(line => line.startsWith('| #'))).toEqual(['| #9 | Archived Issue 9 |', '| #8 | Archived Issue 8 |', '| #7 | Archived Issue 7 |', '| #6 | Archived Issue 6 |', '| #5 | Archived Issue 5 |'])
    // 古い 5 件（番号 4 / 3 / 2 / 1 / 0）は含まれない
    expect(output).not.toContain('| #4 |')
    expect(output).not.toContain('| #0 |')
  })

  it('Archived の項目が 5 件ちょうどの場合は、絞り込まない', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。`Archived` の項目が 5 件の場合に、件数だけの見出し（`Archived (5)`）にし、5 件すべてを表示することを確認します。')
    const items: readonly BoardItem[] = Array.from({ length: 5 }, (_value, index) => ({ id: String(index), workflow: 'Archived', title: 't', updatedAt: String(index), content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items)).toContain('### Archived (5)')
  })

  it('更新日時が同じ Archived の項目は、元の順序を保つ', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。`Archived` の項目 7 件の更新日時がすべて同じ場合に、渡した順のまま先頭の 5 件を表示することを確認します。')
    const items: readonly BoardItem[] = Array.from({ length: 7 }, (_value, index) => ({ id: String(index), workflow: 'Archived', title: 't', updatedAt: 'same', content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items).split('\n').filter(line => line.startsWith('| #'))).toEqual(['| #0 | t |', '| #1 | t |', '| #2 | t |', '| #3 | t |', '| #4 | t |'])
  })

  it('定義にない workflow のステータスは、どの見出しにも表示しない', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。定義にない `InProgress` のステータスの項目がある場合に、その項目をどの見出しにも表示せず、既知のステータスの項目だけを表示することを確認します。')
    const items: readonly BoardItem[] = [
      { id: 'item1', workflow: 'Active', title: 'Active Item', updatedAt: '2026-01-14T10:00:00Z', content: { number: 1, labels: [] } },
      { id: 'item2', workflow: 'InProgress', title: 'Unknown Status Item', updatedAt: '2026-01-14T10:00:00Z', content: { number: 2, labels: [] } },
    ]
    const output = formatBoardOutput(items)

    // Active のアイテムは表示される (repository 未設定 → #N)
    expect(output).toContain('| #1 |')
    expect(output).toContain('Active Item')

    // 未知のステータスは表示されない
    expect(output).not.toContain('| #2 |')
    expect(output).not.toContain('Unknown Status Item')
  })

  it('workflow が未設定でどのステータスにも項目がない場合は、プレースホルダだけを表示する', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。`workflow` が未設定の項目だけを渡した場合に、すべてのステータスが 0 件になるため、`_No items_` だけを返すことを確認します。')
    const items: readonly BoardItem[] = [{ id: 'item1', workflow: undefined, title: 'No Workflow Item', updatedAt: '2026-01-14T10:00:00Z', content: { number: 99, labels: [] } }]
    // 全ステータス 0 件なら 1 行のプレースホルダのみ
    expect(formatBoardOutput(items)).toBe('_No items_')
  })

  it('項目が存在しない場合は、プレースホルダだけを表示する', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。項目が空の配列の場合に、`_No items_` だけを返すことを確認します。')
    expect(formatBoardOutput([])).toBe('_No items_')
  })

  it('ステータスの表示順を、Active・In Review・Blocked・Ready・Pending・Backlog・Archived とする', async () => {
    await explains('ボードの一覧を Markdown の文字列にする、`formatBoardOutput` のテストです。ステータスの順序がばらばらの項目を渡した場合に、見出しが `Active`・`In Review`・`Blocked`・`Ready`・`Pending`・`Backlog`・`Archived` の順に並ぶことを確認します。')
    const statuses = ['Archived', 'Backlog', 'Pending', 'Ready', 'Blocked', 'In Review', 'Active']
    const items: readonly BoardItem[] = statuses.map((workflow, index) => ({ id: String(index), workflow, title: 't', updatedAt: '', content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items).split('\n').filter(line => line.startsWith('### ')).map(line => line.split(' (', 1)[0])).toEqual(['### Active', '### In Review', '### Blocked', '### Ready', '### Pending', '### Backlog', '### Archived'])
  })
})

describe('formatBoardOutput の Readiness の列', () => {
  const items = transformItems(SAMPLE_RAW_ITEMS, 'F_wf')

  it('判定の表を渡した場合は、Ready の節だけに Readiness の列を付ける', async () => {
    await explains('ボードの一覧に Readiness の列を付ける、`formatBoardOutput` のテストです。Issue ごとの判定の表を渡した場合に、`Ready` の節だけが `Readiness` の列と判定の値を持ち、ほかの節の表は変わらないことを確認します。')
    const output = formatBoardOutput(items, new Map([['test/repo#101', 'startable']]))
    expect(output).toContain('### Ready (1)\n| Ref | Title | Readiness |\n|-----|----------|-----------|\n| test/repo#101 | Ready Issue | startable |')
    expect(output).toContain('### Active (1)\n| Ref | Title |\n')
    expect(output).toContain('### Backlog (1)\n| Ref | Title |\n')
  })

  it('Blocked の節にも列を付け、判定の表に存在しない Issue のセルは - にする', async () => {
    await explains('ボードの一覧に Readiness の列を付ける、`formatBoardOutput` のテストです。`Blocked` の節にも `Readiness` の列を付け、判定の表に存在しない Issue のセルは `-`、存在する Issue のセルは判定の値になることを確認します。')
    const blocked = transformItems([{
      id: 'b',
      fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-test' }, name: 'Blocked' }] },
      content: { number: 7, title: 'Blocked Issue', repository: { owner: { login: 'Test' }, name: 'Repo' } },
    }], 'F_wf')
    expect(formatBoardOutput(blocked, new Map())).toContain('| Test/Repo#7 | Blocked Issue | - |')
    expect(formatBoardOutput(blocked, new Map([['test/repo#7', 'blocked by #3 (waits for merge)']]))).toContain('| Test/Repo#7 | Blocked Issue | blocked by #3 (waits for merge) |')
  })

  it('判定の表を渡さない場合は、Readiness の列を付けない', async () => {
    await explains('ボードの一覧に Readiness の列を付ける、`formatBoardOutput` のテストです。判定の表を渡さない場合に、出力に `Readiness` が含まれないことを確認します。')
    expect(formatBoardOutput(items)).not.toContain('Readiness')
  })

  it('boardItemKey は owner/repo#N を小文字にして返し、要素が欠けている場合は undefined を返す', async () => {
    await explains('ボードの項目から判定の表を引くキーを作成する、`boardItemKey` のテストです。owner・リポジトリ名・番号がそろっている場合は `acme/app#5` のように小文字で返し、どれかが欠けている場合は `undefined` を返すことを確認します。')
    const [first] = transformItems([{ content: { number: 5, title: 't', repository: { owner: { login: 'Acme' }, name: 'App' } } }], 'x')
    expect(first === undefined ? undefined : boardItemKey(first)).toBe('acme/app#5')
    expect(boardItemKey({ content: { number: 5 } })).toBeUndefined()
    expect(boardItemKey({ content: { repository: 'a/b' } })).toBeUndefined()
  })
})

describe('formatStackableChains', () => {
  it('Epic ごとの並びを、1 行ずつ表示する', async () => {
    await explains('着手できる Issue の並びを Markdown にする、`formatStackableChains` のテストです。Epic ごとの Issue の並びを、`#1 -> #2 -> #3` の形で 1 行ずつ表示し、Epic がない並びは `(no epic)` として表示することを確認します。')
    expect(formatStackableChains([
      { epic: '#10', chain: ['#1', '#2', '#3'] },
      { epic: undefined, chain: ['#4', '#5'] },
    ])).toBe('## Stackable chains\n\n- #10: #1 -> #2 -> #3\n- (no epic): #4 -> #5')
  })

  it('並びが存在しない場合は、節を表示しない', async () => {
    await explains('着手できる Issue の並びを Markdown にする、`formatStackableChains` のテストです。並びが空の場合に、節を作らず `undefined` を返すことを確認します。')
    expect(formatStackableChains([])).toBeUndefined()
  })
})

describe('formatItemsJson', () => {
  it('items だけをキーに持つ JSON を返す', async () => {
    await explains('ボードの項目を JSON にする、`formatItemsJson` のテストです。変換後の項目を渡した場合に、キーが `items` だけで、項目の件数と内容が保たれることを確認します。')
    const items = transformItems(SAMPLE_RAW_ITEMS, 'F_wf')
    const output = formatItemsJson(items)
    expect(Object.keys(output)).toEqual(['items'])
    expect(output.items).toHaveLength(4)
    expect(firstItem(output.items).workflow).toBe('Active')
  })
})

describe('formatTableRow', () => {
  it('追加のセルを、Title の後ろに追加する', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。追加のセル（`startable`）を渡した場合に、`Title` の後ろにセルを追加した行を返すことを確認します。')
    const item: BoardItem = { id: 'item1', workflow: 'Ready', title: 'T', content: { number: 1, labels: [], repository: 'owner/repo' } }
    expect(formatTableRow(item, ['startable'])).toBe('| owner/repo#1 | T | startable |')
  })

  it('Ref と Title を並べた表の行を返す', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。リポジトリ名と番号を持つ項目を渡した場合に、`| owner/repo#123 | Test Issue |` の形の行を返すことを確認します。')
    const item: BoardItem = { id: 'item1', workflow: 'Active', title: 'Test Issue', updatedAt: '2026-01-14T10:00:00Z', content: { number: 123, labels: ['bug', 'urgent'], repository: 'owner/repo' } }
    expect(formatTableRow(item)).toBe('| owner/repo#123 | Test Issue |')
  })

  it('repository と number のどちらも存在しない場合は、Ref を - にする', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。リポジトリ名と番号のどちらも存在しない場合に、`Ref` のセルが `-` になることを確認します。')
    expect(formatTableRow({ title: 'Test', content: { number: undefined, labels: [], repository: '' } })).toBe('| - | Test |')
  })

  it('repository だけがある場合は、Ref を repository にする', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。リポジトリ名だけがあり、番号が存在しない場合に、`Ref` のセルがリポジトリ名だけになることを確認します。')
    expect(formatTableRow({ title: 'Test', content: { labels: [], repository: 'owner/repo' } })).toBe('| owner/repo | Test |')
  })

  it('number が 0 の場合でも、# を付けて表示する', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。番号が `0` の場合でも、`#0` のように `#` を付けて表示することを確認します。')
    expect(formatTableRow({ title: 'Test', content: { number: 0, labels: [] } })).toBe('| #0 | Test |')
  })

  it('title が空の場合は、- を表示する', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。`title` が空文字の場合に、`Title` のセルが `-` になることを確認します。')
    expect(formatTableRow({ title: '', content: { number: 1, labels: [], repository: 'owner/repo' } })).toBe('| owner/repo#1 | - |')
  })

  it('フィールドが欠けている場合は、Ref と Title を - にした行を返す', async () => {
    await explains('表の 1 行を作成する、`formatTableRow` のテストです。`content` が空で、`title` も存在しない場合に、`| - | - |` の行を返すことを確認します。')
    expect(formatTableRow({ content: {} })).toBe('| - | - |')
  })
})
