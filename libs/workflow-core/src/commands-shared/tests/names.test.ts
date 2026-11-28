import { describe, expect, it } from 'vitest'
import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { COMMAND_GROUPS, COMMAND_VERBS, toolNameViolations } from '../names.js'

describe('toolNameViolations', () => {
  it('グループの一覧の語と語彙の動詞なら、違反を返さない', async () => {
    await explains('ツール名の規則の違反を求める関数（`toolNameViolations`）のテストです。`issue_check` や `issue_dependency_check` のように、グループと最後の動詞で構成されたツール名の場合に、違反が 1 件も返らないことを確認します。')
    stepSync('結果を確認する', () => {
      expect(toolNameViolations(['issue_check', 'board_add', 'session_finish', 'issue_dependency_check', 'issue_comment_check'])).toEqual([])
    })
  })

  it.for([
    { label: 'ハイフンを含む 1 語', name: 'create-branch', reason: 'has 1 word; a tool name is \'<group>_<verb>\'; \'create-branch\' is not a verb in COMMAND_VERBS' },
    { label: 'ハイフンを含む 2 語目の動詞', name: 'project_set-repo', reason: '\'set-repo\' is not a verb in COMMAND_VERBS' },
    { label: '一覧に無い 2 語のグループ', name: 'project_set_repo', reason: '\'project_set\' is not a group in COMMAND_GROUPS; \'repo\' is not a verb in COMMAND_VERBS' },
    { label: '一覧に無いグループ', name: 'dependabot_show', reason: '\'dependabot\' is not a group in COMMAND_GROUPS' },
    { label: '語彙に無い動詞', name: 'issue_read', reason: '\'read\' is not a verb in COMMAND_VERBS' },
    { label: 'グループと動詞の取り違え', name: 'create_issue', reason: '\'create\' is not a group in COMMAND_GROUPS; \'issue\' is not a verb in COMMAND_VERBS' },
  ])('$label は、名前と理由を返す', async ({ label, name, reason }) => {
    await explains(`ツール名の規則に違反するツール名のテストです。ツール名が ${label} の場合に、名前と違反の理由を返すことを確認します。`)
    stepSync('結果を確認する', () => {
      expect(toolNameViolations([name])).toEqual([{ name, reason }])
    })
  })

  it('違反しているツール名だけを、渡した順に返す', async () => {
    await explains('違反の有無が混在した複数のツール名のテストです。違反しているツール名だけが、渡した順に返ることを確認します。')
    const violations = toolNameViolations(['delete-branch', 'pr_show', 'pr_read'])
    stepSync('結果を確認する', () => {
      expect(violations.map(violation => violation.name)).toEqual(['delete-branch', 'pr_read'])
    })
  })
})

describe('COMMAND_GROUPS と COMMAND_VERBS', () => {
  it('グループと動詞の語彙は、英小文字だけで構成され、重複せず、意味の説明を持つ', async () => {
    await explains('ツール名の語彙（`COMMAND_GROUPS` と `COMMAND_VERBS`）のテストです。すべての語が英小文字と、語の区切りの `_` だけで構成され、重複がなく、意味の説明が空でないことを確認します。')
    stepSync('結果を確認する', () => {
      for (const words of [COMMAND_GROUPS, COMMAND_VERBS]) {
        const names = words.map(word => word.name)
        expect(names.every(name => name.split('_').every(part => /^[a-z]+$/u.test(part)))).toBe(true)
        expect(new Set(names).size).toBe(names.length)
        expect(words.every(word => word.meaning !== '')).toBe(true)
      }
    })
  })

  it('グループは 11 個で、決めた順に並ぶ', async () => {
    await explains('ツールのグループ（`COMMAND_GROUPS`）のテストです。`project`・`board`・`issue`・`issue_dependency` など 11 個のグループが、決めた順序で並ぶことを確認します。')
    stepSync('結果を確認する', () => {
      expect(COMMAND_GROUPS.map(group => group.name)).toEqual(['project', 'board', 'issue', 'issue_dependency', 'issue_comment', 'session', 'pr', 'release', 'worktree', 'branch', 'workflow'])
    })
  })
})
