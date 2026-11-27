import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { closeMatches } from '../fuzzy.js'

const ROOT_OPTIONS = ['--version', '--repo', '--show-repo', '--install-completion', '--show-completion', '--help']
const ROOT_COMMANDS = ['project', 'board', 'issue', 'session', 'pr', 'release', 'tracker', 'worktree', 'branch']
const ISSUE_COMMANDS = ['read', 'reopen', 'create', 'comment', 'quick']

// 期待値は Python の difflib.get_close_matches(word, possibilities) の実出力
describe('closeMatches', () => {
  it('入力に近い候補を、近い順に最大 3 件返す', async () => {
    await explains('打ち間違えたコマンド名やオプション名に近い候補を返す、`closeMatches` のテストです。候補が 4 件以上ある場合でも、近い順に最大 3 件までを返すことを確認します。')
    expect(closeMatches('--show-rep', ROOT_OPTIONS)).toEqual(['--show-repo', '--repo', '--help'])
    expect(closeMatches('reed', ISSUE_COMMANDS)).toEqual(['read', 'reopen', 'create'])
    expect(closeMatches('rea', ISSUE_COMMANDS)).toEqual(['read', 'create'])
  })

  it('類似度が 0.6 に届かない候補は返さない', async () => {
    await explains('打ち間違えたコマンド名やオプション名に近い候補を返す、`closeMatches` のテストです。類似度が 0.6 に届かない候補は結果に含まれず、該当する候補がなければ空の配列を返すことを確認します。')
    expect(closeMatches('isue', ROOT_COMMANDS)).toEqual(['issue'])
    expect(closeMatches('xyz', ROOT_COMMANDS)).toEqual([])
    expect(closeMatches('--jso', ['--json', '--comment-limit', '--help'])).toEqual(['--json'])
  })

  it('入力か候補が空の場合でも、例外を発生させず結果を返す', async () => {
    await explains('打ち間違えたコマンド名やオプション名に近い候補を返す、`closeMatches` のテストです。入力が空文字の場合と、候補が空の配列の場合のどちらでも、例外が発生せずに結果を返すことを確認します。')
    expect(closeMatches('', [''])).toEqual([''])
    expect(closeMatches('a', [])).toEqual([])
  })

  it('類似度が同じ場合は、文字列として大きい候補を先に返す', async () => {
    await explains('打ち間違えたコマンド名やオプション名に近い候補を返す、`closeMatches` のテストです。類似度の等しい候補が複数ある場合に、文字列として大きい候補から順に並ぶことを確認します。')
    expect(closeMatches('abcd', ['abce', 'abcf', 'abcg', 'abch'])).toEqual(['abch', 'abcg', 'abcf'])
  })
})
