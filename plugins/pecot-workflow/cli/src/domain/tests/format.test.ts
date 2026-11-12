import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'
import { extractWorkflowStatus, formatBoardOutput, formatItemsJson, formatTableRow, transformItems } from '../format.js'
import type { BoardItem } from '../format.js'
import type { JsonValue } from '../python-format.js'

type RawItem = Readonly<Record<string, JsonValue>>

const SAMPLE_RAW_ITEMS: readonly RawItem[] = [
  {
    id: 'item1',
    updatedAt: '2026-01-14T10:00:00Z',
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Active' }] },
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
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Ready' }] },
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
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Backlog' }] },
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
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Archived' }] },
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

describe('extractWorkflowStatus', () => {
  it('pecot-workflow のフィールドがあるとき、その値を返す', () => {
    const item = { fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: 'Active' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBe('Active')
  })

  it('pecot-workflow のフィールドが無いとき、undefined を返す', () => {
    const item = { fieldValues: { nodes: [{ field: { name: 'Priority' }, name: 'High' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBeUndefined()
  })

  it('fieldValues が空のとき、undefined を返す', () => {
    expect(extractWorkflowStatus({ fieldValues: { nodes: [] } }, 'pecot-workflow-test')).toBeUndefined()
  })

  it('fieldValues が無いとき、undefined を返す', () => {
    expect(extractWorkflowStatus({}, 'pecot-workflow-test')).toBeUndefined()
  })

  it('大文字小文字を区別しない', () => {
    const item = { fieldValues: { nodes: [{ field: { name: 'PECOT-WORKFLOW-TEST' }, name: 'Ready' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBe('Ready')
  })

  it('空ノードが混在しても Workflow を抽出できる', () => {
    const item = { fieldValues: { nodes: [{}, {}, { field: { name: 'pecot-workflow-test' }, name: 'Active' }, {}] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBe('Active')
  })

  it('field がないノードをスキップ', () => {
    const item = { fieldValues: { nodes: [{ name: 'SomeValue' }, { field: { name: 'pecot-workflow-test' }, name: 'Backlog' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBe('Backlog')
  })

  it('null のノードが含まれていてもエラーにならない', () => {
    const item = { fieldValues: { nodes: [JSON_NULL, { field: { name: 'pecot-workflow-test' }, name: 'Done' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBe('Done')
  })

  it('値の名前が null なら最初に見つけた時点で未設定を返す', () => {
    const item = { fieldValues: { nodes: [{ field: { name: 'pecot-workflow-test' }, name: JSON_NULL }, { field: { name: 'pecot-workflow-test' }, name: 'Active' }] } }
    expect(extractWorkflowStatus(item, 'pecot-workflow-test')).toBeUndefined()
  })
})

describe('transformItems', () => {
  it('raw の項目を、workflow・title・番号・ラベルを持つ項目に変換する', () => {
    const items = transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test')
    expect(items).toHaveLength(4)
    const item = firstItem(items)
    expect(item.workflow).toBe('Active')
    expect(item.title).toBe('Active Issue')
    expect(item.content.number).toBe(100)
    expect(item.content.labels).toEqual(['bug', 'urgent'])
  })

  it('出力の形（キーの順序を含む）は Python の辞書と同じ', () => {
    const [item] = transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test')
    expect(JSON.stringify(item)).toBe(JSON.stringify({
      id: 'item1',
      workflow: 'Active',
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

  it('無い値は JSON にすると null で出る（Python の CLI と同じ）', () => {
    const [item] = transformItems([{ id: 'x', content: { title: 't' } }], 'pecot-workflow-test')
    expect(JSON.stringify(item)).toBe('{"id":"x","workflow":null,"title":"t","updatedAt":"","content":{"number":null,"state":null,"url":null,"labels":[],"repository":""}}')
  })

  it('ラベルが空のとき、labels は空配列になる', () => {
    const items = transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test')
    const ready = items.find(item => item.workflow === 'Ready')
    expect(ready?.content.labels).toEqual([])
  })

  it('content がないアイテムはスキップ', () => {
    const raw = [{ id: 'draft', fieldValues: { nodes: [] }, content: JSON_NULL }]
    expect(transformItems(raw, 'pecot-workflow-test')).toHaveLength(0)
  })

  it('content が空のアイテムもスキップ', () => {
    expect(transformItems([{ id: 'x', content: {} }], 'pecot-workflow-test')).toHaveLength(0)
  })

  it('不正なラベルノードはスキップ', () => {
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
    expect(firstItem(transformItems(raw, 'pecot-workflow-test')).content.labels).toEqual(['valid', 'also-valid'])
  })

  it('空の fieldValue ノードがあってもエラーにならない', () => {
    const raw = [{
      id: 'item1',
      updatedAt: '2026-01-14T10:00:00Z',
      fieldValues: { nodes: [{}, {}, { field: { name: 'pecot-workflow-test' }, name: 'Active' }, {}] },
      content: { number: 100, title: 'Test', state: 'OPEN', url: 'https://example.com', labels: { nodes: [] } },
    }]
    expect(firstItem(transformItems(raw, 'pecot-workflow-test')).workflow).toBe('Active')
  })

  it('labels フィールドがなくてもエラーにならない', () => {
    const raw = [{
      id: 'item1',
      updatedAt: '2026-01-14T10:00:00Z',
      fieldValues: { nodes: [] },
      content: { number: 100, title: 'Test', state: 'OPEN', url: 'https://example.com' },
    }]
    expect(firstItem(transformItems(raw, 'pecot-workflow-test')).content.labels).toEqual([])
  })

  it('リポジトリの owner か名前が欠けると repository は空文字', () => {
    const raw = [
      { id: 'a', content: { number: 1, repository: { owner: { login: 'o' } } } },
      { id: 'b', content: { number: 2, repository: { name: 'n' } } },
    ]
    expect(transformItems(raw, 'pecot-workflow-test').map(item => item.content.repository)).toEqual(['', ''])
  })

  it('欠けたキーは既定値になる（id・title・updatedAt は空文字、他は null）', () => {
    const [item] = transformItems([{ content: { number: 1 } }], 'pecot-workflow-test')
    expect(item).toEqual({ id: '', workflow: JSON_NULL, title: '', updatedAt: '', content: { number: 1, state: JSON_NULL, url: JSON_NULL, labels: [], repository: '' } })
  })
})

describe('formatBoardOutput', () => {
  it('ステータスの見出しと Ref・Title の表を出し、プロジェクト名の見出しと 0 件の見出しは出さない', () => {
    const output = formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test'))

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

  it('出力全体は Python と同じ（見出し・表・空行）', () => {
    expect(formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test'))).toBe([
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

  it('ステータスごとにグループ化される', () => {
    const output = formatBoardOutput(transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test'))
    expect(output).toContain('### Ready (1)')
    expect(output).toContain('### Archived (1)')
  })

  it('空のステータスがある場合はスキップされる', () => {
    const items: readonly BoardItem[] = [{ id: 'item1', workflow: 'Active', title: 'Test', updatedAt: '2026-01-14T10:00:00Z', content: { number: 1, labels: [] } }]
    const output = formatBoardOutput(items)
    // 件数のあるステータスのみが見出しに出る
    expect(output).toContain('### Active (1)')
    expect(output).not.toContain('### Backlog')
    expect(output).not.toContain('### Archived')
    // 「(なし)」は廃止
    expect(output).not.toContain('(なし)')
  })

  it('Archived は直近 5 件のみ表示', () => {
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

  it('Archived が 5 件ちょうどなら絞らない', () => {
    const items: readonly BoardItem[] = Array.from({ length: 5 }, (_value, index) => ({ id: String(index), workflow: 'Archived', title: 't', updatedAt: String(index), content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items)).toContain('### Archived (5)')
  })

  it('updatedAt が同じ Archived は元の順序を保つ', () => {
    const items: readonly BoardItem[] = Array.from({ length: 7 }, (_value, index) => ({ id: String(index), workflow: 'Archived', title: 't', updatedAt: 'same', content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items).split('\n').filter(line => line.startsWith('| #'))).toEqual(['| #0 | t |', '| #1 | t |', '| #2 | t |', '| #3 | t |', '| #4 | t |'])
  })

  it('未知の workflow ステータスはどのセクションにも表示されない', () => {
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

  it('workflow が未設定で全ステータスが空ならプレースホルダのみ', () => {
    const items: readonly BoardItem[] = [{ id: 'item1', workflow: undefined, title: 'No Workflow Item', updatedAt: '2026-01-14T10:00:00Z', content: { number: 99, labels: [] } }]
    // 全ステータス 0 件なら 1 行のプレースホルダのみ
    expect(formatBoardOutput(items)).toBe('_No items_')
  })

  it('アイテムが無ければプレースホルダのみ', () => {
    expect(formatBoardOutput([])).toBe('_No items_')
  })

  it('表示順は Active・In Review・Blocked・Ready・Pending・Backlog・Archived', () => {
    const statuses = ['Archived', 'Backlog', 'Pending', 'Ready', 'Blocked', 'In Review', 'Active']
    const items: readonly BoardItem[] = statuses.map((workflow, index) => ({ id: String(index), workflow, title: 't', updatedAt: '', content: { number: index, labels: [] } }))
    expect(formatBoardOutput(items).split('\n').filter(line => line.startsWith('### ')).map(line => line.split(' (', 1)[0])).toEqual(['### Active', '### In Review', '### Blocked', '### Ready', '### Pending', '### Backlog', '### Archived'])
  })
})

describe('formatItemsJson', () => {
  it('items だけをキーに持つ JSON を返す', () => {
    const items = transformItems(SAMPLE_RAW_ITEMS, 'pecot-workflow-test')
    const output = formatItemsJson(items)
    expect(Object.keys(output)).toEqual(['items'])
    expect(output.items).toHaveLength(4)
    expect(firstItem(output.items).workflow).toBe('Active')
  })
})

describe('formatTableRow', () => {
  it('Ref と Title を並べた表の行を返す', () => {
    const item: BoardItem = { id: 'item1', workflow: 'Active', title: 'Test Issue', updatedAt: '2026-01-14T10:00:00Z', content: { number: 123, labels: ['bug', 'urgent'], repository: 'owner/repo' } }
    expect(formatTableRow(item)).toBe('| owner/repo#123 | Test Issue |')
  })

  it('repository と number のどちらも無い場合は Ref が - になる', () => {
    expect(formatTableRow({ title: 'Test', content: { number: undefined, labels: [], repository: '' } })).toBe('| - | Test |')
  })

  it('repository だけがある場合は Ref が repository になる', () => {
    expect(formatTableRow({ title: 'Test', content: { labels: [], repository: 'owner/repo' } })).toBe('| owner/repo | Test |')
  })

  it('number が 0 でも # 付きで表示する', () => {
    expect(formatTableRow({ title: 'Test', content: { number: 0, labels: [] } })).toBe('| #0 | Test |')
  })

  it('title が空の場合は - を表示', () => {
    expect(formatTableRow({ title: '', content: { number: 1, labels: [], repository: 'owner/repo' } })).toBe('| owner/repo#1 | - |')
  })

  it('フィールドが欠けたとき、Ref と Title を - にした行を返す', () => {
    expect(formatTableRow({ content: {} })).toBe('| - | - |')
  })
})
