import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { activeIssueFromBranch, extractIssueNumberFromBranch } from '../branch-name.js'
import { issueReferenceToString } from '../reference-parser.js'

describe('extractIssueNumberFromBranch', () => {
  it.each([
    ['feat/description/470', 470],
    ['fix/bug-fix/123', 123],
    ['feat/module/sub-feature/999', 999],
    ['123', 123],
  ])('ブランチ %s の場合は、末尾の番号 %i を返す', async (branch, expected) => {
    await explains('ブランチ名から Issue の番号を取り出す関数（`extractIssueNumberFromBranch`）のテストです。末尾が `/` で区切られた数字（`feat/description/470` など）の場合に、その数字を番号として返すことを確認します。')
    stepSync('`extractIssueNumberFromBranch` を呼び、結果を比べる', () => {
      expect(extractIssueNumberFromBranch(branch)).toBe(expected)
    })
  })

  it.each(['main', 'develop-aist', 'feat/no-issue-number', 'feat/12a', 'feat/123/', ''])('ブランチ %j のように、末尾が数字だけの区切りでない場合は、undefined を返す', async (branch) => {
    await explains('末尾の区切りが数字だけではないブランチ名のテストです。`main` や `feat/12a`、空文字などの場合に、番号を取り出さず `undefined` を返すことを確認します。')
    stepSync('`extractIssueNumberFromBranch` を呼び、結果を比べる', () => {
      expect(extractIssueNumberFromBranch(branch)).toBeUndefined()
    })
  })
})

describe('activeIssueFromBranch', () => {
  const remote = { owner: 'owner', repository: 'repo' }

  it.each([
    ['feat/x/387', 'owner/repo#387'],
    ['feat/20261112-101500/412', 'owner/repo#412'],
    ['feat/x/007', 'owner/repo#7'],
  ])('リモートが owner/repo の場合は、ブランチ %s から作業中の Issue %s を返す', async (branch, expected) => {
    await explains('リモートとブランチ名から作業中の Issue を求める関数（`activeIssueFromBranch`）のテストです。末尾が番号のブランチの場合に、リモートのリポジトリと番号から Issue の参照（`owner/repo#387` など）を返し、先頭の 0 は取り除くことを確認します。')
    const result = stepSync('`activeIssueFromBranch` を呼ぶ', () => activeIssueFromBranch(remote, branch))

    stepSync('結果を比べる', () => {
      expect(result === undefined ? undefined : issueReferenceToString(result)).toBe(expected)
    })
  })

  it.each(['main', 'wt4', '025-hook-session-state', 'feat/x/387a', 'feat/387/x', 'HEAD', 'feat/x/0'])('ブランチ %s の場合は、作業中の Issue は存在しないとして undefined を返す', async (branch) => {
    await explains('末尾が番号ではないブランチ名のテストです。`main` や `feat/x/0` などの場合に、作業中の Issue は存在しないとして `undefined` を返すことを確認します。')
    stepSync('`activeIssueFromBranch` を呼び、結果を比べる', () => {
      expect(activeIssueFromBranch(remote, branch)).toBeUndefined()
    })
  })

  it('リモートが存在しない場合は、番号を含むブランチでも undefined を返す', async () => {
    await explains('リモートが存在しない場合のテストです。ブランチ名に番号が含まれていても、作業中の Issue は存在しないとして `undefined` を返すことを確認します。')
    stepSync('`activeIssueFromBranch` を呼び、結果を比べる', () => {
      expect(activeIssueFromBranch(undefined, 'feat/x/387')).toBeUndefined()
    })
  })

  it('ブランチ名を取得できない場合は、undefined を返す', async () => {
    await explains('ブランチ名が `undefined` の場合のテストです。作業中の Issue は存在しないとして `undefined` を返すことを確認します。')
    stepSync('`activeIssueFromBranch` を呼び、結果を比べる', () => {
      expect(activeIssueFromBranch(remote, undefined)).toBeUndefined()
    })
  })

  it('リモートの owner に使えない文字が含まれる場合は、undefined を返す', async () => {
    await explains('リモートの owner に空白など使えない文字が含まれる場合のテストです。Issue の参照を作成できないため、`undefined` を返すことを確認します。')
    stepSync('`activeIssueFromBranch` を呼び、結果を比べる', () => {
      expect(activeIssueFromBranch({ owner: 'own er', repository: 'repo' }, 'feat/x/387')).toBeUndefined()
    })
  })
})
