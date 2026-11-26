import { describe, expect, it } from 'vitest'

import { isLegacyWorkflowFieldName, planConfigMove, planWorkflowField } from '../migration.js'

describe('planWorkflowField', () => {
  it.for([
    { name: 'pecot-status だけ', fields: ['Title', 'pecot-status'], expected: { kind: 'current', use: 'pecot-status' } },
    { name: 'pecot-workflow-<s> だけ', fields: ['Status', 'pecot-workflow-acme'], expected: { kind: 'rename', use: 'pecot-status', from: 'pecot-workflow-acme' } },
    { name: '両方', fields: ['pecot-workflow-acme', 'pecot-status'], expected: { kind: 'both', use: 'pecot-status', legacy: 'pecot-workflow-acme' } },
    { name: 'どちらも無い', fields: ['Status', 'pecot-workflow-'], expected: { kind: 'create', use: 'pecot-status' } },
  ])('$name のボードでは、決まった扱いを返す', ({ fields, expected }) => {
    expect(planWorkflowField(fields)).toEqual(expected)
  })
})

describe('isLegacyWorkflowFieldName', () => {
  it.for([
    { name: 'pecot-workflow-acme', expected: true },
    { name: 'pecot-workflow-', expected: false },
    { name: 'pecot-status', expected: false },
  ])('$name は、旧い名前かを $expected で返す', ({ name, expected }) => {
    expect(isLegacyWorkflowFieldName(name)).toBe(expected)
  })
})

function entry(fileName: string, number = 3, owner = 'acme') {
  return { fileName, host: 'github.com', owner, number }
}

describe('planConfigMove', () => {
  const board = { host: 'github.com', owner: 'acme', number: 3 }

  it('同じボードの旧い名前のファイルを、移す元に返す', () => {
    expect(planConfigMove(board, [entry('github.com_acme_board_acme.json'), entry('github.com_acme_other.json', 4)]))
      .toEqual({ to: 'github.com_acme_3.json', from: ['github.com_acme_board_acme.json'] })
  })

  it('新しい名前のファイルしか無ければ、移す元を返さない', () => {
    expect(planConfigMove(board, [entry('github.com_acme_3.json')])).toEqual({ to: 'github.com_acme_3.json', from: [] })
  })

  it('持ち主か番号が違うファイルは、移す元にしない', () => {
    expect(planConfigMove(board, [entry('x.json', 3, 'other'), entry('y.json', 5)]).from).toEqual([])
  })

  it('同じボードの旧い名前のファイルが 2 つあれば、両方を名前順に返す', () => {
    expect(planConfigMove(board, [entry('b.json'), entry('a.json'), entry('github.com_acme_3.json')]).from).toEqual(['a.json', 'b.json'])
  })
})
