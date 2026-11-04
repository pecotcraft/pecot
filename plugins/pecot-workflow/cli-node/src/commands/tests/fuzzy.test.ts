import { describe, expect, it } from 'vitest'

import { closeMatches } from '../fuzzy.js'

const ROOT_OPTIONS = ['--version', '--repo', '--show-repo', '--install-completion', '--show-completion', '--help']
const ROOT_COMMANDS = ['add-to-project', 'update-issue-status', 'create-branch', 'delete-branch', 'project', 'issue', 'pr', 'session', 'release', 'worktree']
const ISSUE_COMMANDS = ['read', 'reopen', 'create', 'comment', 'quick']

// 期待値は Python の difflib.get_close_matches(word, possibilities) の実出力
describe('closeMatches', () => {
  it('近い順に最大 3 件返す', () => {
    expect(closeMatches('--show-rep', ROOT_OPTIONS)).toEqual(['--show-repo', '--repo', '--help'])
    expect(closeMatches('reed', ISSUE_COMMANDS)).toEqual(['read', 'reopen', 'create'])
    expect(closeMatches('rea', ISSUE_COMMANDS)).toEqual(['read', 'create'])
  })

  it('cutoff 0.6 に届かなければ返さない', () => {
    expect(closeMatches('isue', ROOT_COMMANDS)).toEqual(['issue'])
    expect(closeMatches('xyz', ROOT_COMMANDS)).toEqual([])
    expect(closeMatches('--jso', ['--json', '--comment-limit', '--help'])).toEqual(['--json'])
  })

  it('空の語と空の候補を扱える', () => {
    expect(closeMatches('', [''])).toEqual([''])
    expect(closeMatches('a', [])).toEqual([])
  })

  it('近さが同じなら、文字列の大きい方が先', () => {
    expect(closeMatches('abcd', ['abce', 'abcf', 'abcg', 'abch'])).toEqual(['abch', 'abcg', 'abcf'])
  })
})
