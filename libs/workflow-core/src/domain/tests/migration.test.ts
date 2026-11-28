import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { isLegacyWorkflowFieldName, planConfigMove, planWorkflowField } from '../migration.js'

describe('planWorkflowField', () => {
  it.for([
    { name: 'pecot-status だけ', fields: ['Title', 'pecot-status'], expected: { kind: 'current', use: 'pecot-status' } },
    { name: 'pecot-workflow-<s> だけ', fields: ['Status', 'pecot-workflow-acme'], expected: { kind: 'rename', use: 'pecot-status', from: 'pecot-workflow-acme' } },
    { name: '両方', fields: ['pecot-workflow-acme', 'pecot-status'], expected: { kind: 'both', use: 'pecot-status', legacy: 'pecot-workflow-acme' } },
    { name: 'どちらも存在しない', fields: ['Status', 'pecot-workflow-'], expected: { kind: 'create', use: 'pecot-status' } },
  ])('$name のボードでは、決まった扱いを返す', async ({ fields, expected }) => {
    await explains(`ボードのフィールドの一覧から、ワークフロー用のフィールドの扱いを決める、\`planWorkflowField\` のテストです。フィールドが \`${JSON.stringify(fields)}\` の場合に、\`kind\` が \`${expected.kind}\` の扱いを返すことを確認します。`)
    stepSync('planWorkflowField を呼び、結果を比べる', () => {
      expect(planWorkflowField(fields)).toEqual(expected)
    })
  })
})

describe('isLegacyWorkflowFieldName', () => {
  it.for([
    { name: 'pecot-workflow-acme', expected: true },
    { name: 'pecot-workflow-', expected: false },
    { name: 'pecot-status', expected: false },
  ])('$name は、旧い名前かを $expected で返す', async ({ name, expected }) => {
    await explains(`フィールド名が旧い名前（\`pecot-workflow-\` に続けて名前を付けた形）かどうかを判定する、\`isLegacyWorkflowFieldName\` のテストです。\`${name}\` を渡した場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('isLegacyWorkflowFieldName を呼び、結果を比べる', () => {
      expect(isLegacyWorkflowFieldName(name)).toBe(expected)
    })
  })
})

function entry(fileName: string, number = 3, owner = 'acme') {
  return { fileName, host: 'github.com', owner, number }
}

describe('planConfigMove', () => {
  const board = { host: 'github.com', owner: 'acme', number: 3 }

  it('同じボードの旧い名前のファイルを、移す元として返す', async () => {
    await explains('ボードの設定ファイルの移行を計画する、`planConfigMove` のテストです。同じボードの旧い名前のファイルがある場合に、新しい名前（`github.com_acme_3.json`）を移す先、旧い名前のファイルを移す元として返すことを確認します。')
    stepSync('planConfigMove を呼び、結果を比べる', () => {
      expect(planConfigMove(board, [entry('github.com_acme_board_acme.json'), entry('github.com_acme_other.json', 4)]))
        .toEqual({ to: 'github.com_acme_3.json', from: ['github.com_acme_board_acme.json'] })
    })
  })

  it('新しい名前のファイルしか存在しない場合は、移す元を返さない', async () => {
    await explains('ボードの設定ファイルの移行を計画する、`planConfigMove` のテストです。新しい名前のファイルしか存在しない場合に、移す元が空の配列になることを確認します。')
    stepSync('planConfigMove を呼び、結果を比べる', () => {
      expect(planConfigMove(board, [entry('github.com_acme_3.json')])).toEqual({ to: 'github.com_acme_3.json', from: [] })
    })
  })

  it('持ち主か番号が異なるファイルは、移す元に含めない', async () => {
    await explains('ボードの設定ファイルの移行を計画する、`planConfigMove` のテストです。持ち主（owner）か番号が異なるボードのファイルがある場合に、それらが移す元に含まれないことを確認します。')
    stepSync('planConfigMove を呼び、結果を比べる', () => {
      expect(planConfigMove(board, [entry('x.json', 3, 'other'), entry('y.json', 5)]).from).toEqual([])
    })
  })

  it('同じボードの旧い名前のファイルが 2 つある場合は、両方を名前順に返す', async () => {
    await explains('ボードの設定ファイルの移行を計画する、`planConfigMove` のテストです。同じボードの旧い名前のファイルが 2 つある場合に、両方が移す元として名前順に並ぶことを確認します。')
    stepSync('planConfigMove を呼び、結果を比べる', () => {
      expect(planConfigMove(board, [entry('b.json'), entry('a.json'), entry('github.com_acme_3.json')]).from).toEqual(['a.json', 'b.json'])
    })
  })
})
