import { describe, expect, it } from 'vitest'

import { commandNameViolations } from '../names.js'

describe('commandNameViolations', () => {
  it('英小文字だけの 2 語なら、違反を返さない', () => {
    expect(commandNameViolations([['issue', 'create'], ['board', 'add']])).toEqual([])
  })

  it.for([
    { name: 'ハイフン入りの 1 語', path: ['create-branch'], reason: 'has 1 word(s); a command name is \'<object> <verb>\' (2 words); \'create-branch\' is not lowercase letters only (^[a-z]+$)' },
    { name: 'ハイフン入りの 2 語目', path: ['project', 'set-repo'], reason: '\'set-repo\' is not lowercase letters only (^[a-z]+$)' },
    { name: '3 語', path: ['a', 'b', 'c'], reason: 'has 3 word(s); a command name is \'<object> <verb>\' (2 words)' },
    { name: '大文字や数字を含む語', path: ['Issue', 'read2'], reason: '\'Issue\' is not lowercase letters only (^[a-z]+$); \'read2\' is not lowercase letters only (^[a-z]+$)' },
  ])('$name は、path と理由を返す', ({ path, reason }) => {
    expect(commandNameViolations([path])).toEqual([{ path: path.join(' '), reason }])
  })

  it('違反の path だけを、渡された順で返す', () => {
    const violations = commandNameViolations([['delete-branch'], ['pr', 'read'], ['project', 'set-repo']])
    expect(violations.map(violation => violation.path)).toEqual(['delete-branch', 'project set-repo'])
  })
})
