import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import type { PullRequestStack } from '../../infra/github/pulls.js'
import { planStackRegistration } from '../stack-registration.js'

const stackOf = (number: number, ...pullRequests: readonly number[]): PullRequestStack => ({ number, pullRequests })

describe('planStackRegistration', () => {
  it.for([
    { name: '親と子のどちらもスタックに無い', parent: 1, child: 2, parentStack: undefined, childStack: undefined, expected: { kind: 'create', pullRequests: [1, 2] } },
    { name: '親のスタックの一番上が親', parent: 2, child: 3, parentStack: stackOf(7, 1, 2), childStack: undefined, expected: { kind: 'add', stackNumber: 7, pullRequests: [3] } },
    { name: '親のスタックの一番上が親でない', parent: 1, child: 3, parentStack: stackOf(7, 1, 2), childStack: undefined, expected: { kind: 'conflict', reason: 'PR #1 is not the top of stack #7 (top: PR #2)' } },
    { name: '子が親と同じスタックで、親の直後にある', parent: 1, child: 2, parentStack: stackOf(7, 1, 2), childStack: stackOf(7, 1, 2), expected: { kind: 'already', stack: stackOf(7, 1, 2) } },
    { name: '子が親と同じスタックにあるが、親の直後でない', parent: 1, child: 3, parentStack: stackOf(7, 1, 2, 3), childStack: stackOf(7, 1, 2, 3), expected: { kind: 'conflict', reason: 'PR #3 is already in stack #7' } },
    { name: '子が別のスタックにある', parent: 1, child: 5, parentStack: undefined, childStack: stackOf(9, 4, 5), expected: { kind: 'conflict', reason: 'PR #5 is already in stack #9' } },
    { name: '子が別のスタックにあり、親にもスタックがある', parent: 2, child: 5, parentStack: stackOf(7, 1, 2), childStack: stackOf(9, 4, 5), expected: { kind: 'conflict', reason: 'PR #5 is already in stack #9' } },
  ])('$name 場合は、$expected.kind を返す', async ({ name, parent, child, parentStack, childStack, expected }) => {
    await explains(`スタックへの登録の判断を返す \`planStackRegistration\` のテストです。${name}場合に、判断の種類と中身が期待どおりになることを確認します。`)
    expect(planStackRegistration(parent, child, parentStack, childStack)).toEqual(expected)
  })
})
