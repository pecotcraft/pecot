import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { COMMAND_GROUPS, COMMAND_VERBS, commandNameViolations } from '../names.js'

describe('commandNameViolations', () => {
  it('グループの一覧の語と語彙の動詞の 2 語なら、違反を返さない', async () => {
    await explains('コマンド名の規則の違反を求める関数（`commandNameViolations`）のテストです。`issue create` のように、グループと動詞の 2 語で構成されたコマンド名の場合に、違反が 1 件も返らないことを確認します。')
    expect(commandNameViolations([['issue', 'create'], ['board', 'add'], ['session', 'finish']])).toEqual([])
  })

  it.for([
    { name: 'ハイフンを含む 1 語', path: ['create-branch'], reason: 'has 1 word(s); a command name is \'<group> <verb>\' (2 words); \'create-branch\' is not a group in COMMAND_GROUPS' },
    { name: 'ハイフンを含む 2 語目の動詞', path: ['project', 'set-repo'], reason: '\'set-repo\' is not a verb in COMMAND_VERBS' },
    { name: '3 語', path: ['project', 'set', 'repo'], reason: 'has 3 word(s); a command name is \'<group> <verb>\' (2 words)' },
    { name: '一覧に無いグループ', path: ['dependabot', 'show'], reason: '\'dependabot\' is not a group in COMMAND_GROUPS' },
    { name: '語彙に無い動詞', path: ['issue', 'read'], reason: '\'read\' is not a verb in COMMAND_VERBS' },
    { name: 'グループと動詞の取り違え', path: ['create', 'issue'], reason: '\'create\' is not a group in COMMAND_GROUPS; \'issue\' is not a verb in COMMAND_VERBS' },
  ])('$name は、path と理由を返す', async ({ name, path, reason }) => {
    await explains(`コマンド名の規則に違反するコマンド名のテストです。コマンド名が ${name} の場合に、path と違反の理由を返すことを確認します。`)
    expect(commandNameViolations([path])).toEqual([{ path: path.join(' '), reason }])
  })

  it('違反しているコマンド名の path だけを、渡した順に返す', async () => {
    await explains('違反の有無が混在した複数のコマンド名のテストです。違反しているコマンド名の path だけが、渡した順に返ることを確認します。')
    const violations = commandNameViolations([['delete-branch'], ['pr', 'show'], ['pr', 'read']])
    expect(violations.map(violation => violation.path)).toEqual(['delete-branch', 'pr read'])
  })
})

describe('COMMAND_GROUPS と COMMAND_VERBS', () => {
  it('グループと動詞の語彙は、英小文字だけで構成され、重複せず、意味の説明を持つ', async () => {
    await explains('コマンド名の語彙（`COMMAND_GROUPS` と `COMMAND_VERBS`）のテストです。すべての語が英小文字だけで構成され、重複がなく、意味の説明が空でないことを確認します。')
    for (const words of [COMMAND_GROUPS, COMMAND_VERBS]) {
      const names = words.map(word => word.name)
      expect(names.every(name => /^[a-z]+$/u.test(name))).toBe(true)
      expect(new Set(names).size).toBe(names.length)
      expect(words.every(word => word.meaning !== '')).toBe(true)
    }
  })

  it('グループは 9 個で、help の一覧の順に並ぶ', async () => {
    await explains('コマンドのグループ（`COMMAND_GROUPS`）のテストです。`project`・`board`・`issue` など 9 個のグループが、`help` の一覧と同じ順序で並ぶことを確認します。')
    expect(COMMAND_GROUPS.map(group => group.name)).toEqual(['project', 'board', 'issue', 'session', 'pr', 'release', 'worktree', 'branch', 'workflow'])
  })

  it('すべてのグループが、help に表示する説明を持つ', async () => {
    await explains('コマンドのグループ（`COMMAND_GROUPS`）のテストです。`help` に表示する説明が空のグループが存在しないことを確認します。')
    expect(COMMAND_GROUPS.filter(group => group.help === '').map(group => group.name)).toEqual([])
  })
})
