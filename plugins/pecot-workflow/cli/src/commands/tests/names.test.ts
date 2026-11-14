import { describe, expect, it } from 'vitest'

import { COMMAND_GROUPS, COMMAND_VERBS, commandNameViolations } from '../names.js'

describe('commandNameViolations', () => {
  it('グループの一覧の語と語彙の動詞の 2 語なら、違反を返さない', () => {
    expect(commandNameViolations([['issue', 'create'], ['board', 'add'], ['tracker', 'sync']])).toEqual([])
  })

  it.for([
    { name: 'ハイフン入りの 1 語', path: ['create-branch'], reason: 'has 1 word(s); a command name is \'<group> <verb>\' (2 words); \'create-branch\' is not a group in COMMAND_GROUPS' },
    { name: 'ハイフン入りの 2 語目', path: ['project', 'set-repo'], reason: '\'set-repo\' is not a verb in COMMAND_VERBS' },
    { name: '3 語', path: ['project', 'set', 'repo'], reason: 'has 3 word(s); a command name is \'<group> <verb>\' (2 words)' },
    { name: '一覧に無いグループ', path: ['dependabot', 'sync'], reason: '\'dependabot\' is not a group in COMMAND_GROUPS' },
    { name: '語彙に無い動詞', path: ['issue', 'read'], reason: '\'read\' is not a verb in COMMAND_VERBS' },
    { name: 'グループと動詞の取り違え', path: ['create', 'issue'], reason: '\'create\' is not a group in COMMAND_GROUPS; \'issue\' is not a verb in COMMAND_VERBS' },
  ])('$name は、path と理由を返す', ({ path, reason }) => {
    expect(commandNameViolations([path])).toEqual([{ path: path.join(' '), reason }])
  })

  it('違反の path だけを、渡された順で返す', () => {
    const violations = commandNameViolations([['delete-branch'], ['pr', 'show'], ['pr', 'read']])
    expect(violations.map(violation => violation.path)).toEqual(['delete-branch', 'pr read'])
  })
})

describe('COMMAND_GROUPS と COMMAND_VERBS', () => {
  it('語は英小文字だけで重複せず、意味の説明を持つ', () => {
    for (const words of [COMMAND_GROUPS, COMMAND_VERBS]) {
      const names = words.map(word => word.name)
      expect(names.every(name => /^[a-z]+$/u.test(name))).toBe(true)
      expect(new Set(names).size).toBe(names.length)
      expect(words.every(word => word.meaning !== '')).toBe(true)
    }
  })

  it('グループは 9 個で、help の一覧の順に並ぶ', () => {
    expect(COMMAND_GROUPS.map(group => group.name)).toEqual(['project', 'board', 'issue', 'session', 'pr', 'release', 'tracker', 'worktree', 'branch'])
  })

  it('どのグループも、help に出す説明を持つ', () => {
    expect(COMMAND_GROUPS.filter(group => group.help === '').map(group => group.name)).toEqual([])
  })
})
