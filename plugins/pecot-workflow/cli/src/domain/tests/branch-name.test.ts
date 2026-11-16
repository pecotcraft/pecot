import { describe, expect, it } from 'vitest'

import { activeIssueFromBranch, extractIssueNumberFromBranch } from '../branch-name.js'
import { issueReferenceToString } from '../reference-parser.js'

describe('extractIssueNumberFromBranch', () => {
  it.each([
    ['feat/description/470', 470],
    ['fix/bug-fix/123', 123],
    ['feat/module/sub-feature/999', 999],
    ['123', 123],
  ])('ブランチ %s の末尾の番号 %i を返す', (branch, expected) => {
    expect(extractIssueNumberFromBranch(branch)).toBe(expected)
  })

  it.each(['main', 'develop-aist', 'feat/no-issue-number', 'feat/12a', 'feat/123/', ''])('末尾が数字だけの区切りでない %j は undefined を返す', (branch) => {
    expect(extractIssueNumberFromBranch(branch)).toBeUndefined()
  })
})

describe('activeIssueFromBranch', () => {
  const remote = { owner: 'owner', repository: 'repo' }

  it.each([
    ['feat/x/387', 'owner/repo#387'],
    ['feat/20261112-101500/412', 'owner/repo#412'],
    ['feat/x/007', 'owner/repo#7'],
  ])('remote owner/repo とブランチ %s から %s を返す', (branch, expected) => {
    const result = activeIssueFromBranch(remote, branch)
    expect(result === undefined ? undefined : issueReferenceToString(result)).toBe(expected)
  })

  it.each(['main', 'wt4', '025-hook-session-state', 'feat/x/387a', 'feat/387/x', 'HEAD', 'feat/x/0'])('ブランチ %s なら作業中の Issue は無い', (branch) => {
    expect(activeIssueFromBranch(remote, branch)).toBeUndefined()
  })

  it('remote が無ければ、番号のあるブランチでも作業中の Issue は無い', () => {
    expect(activeIssueFromBranch(undefined, 'feat/x/387')).toBeUndefined()
  })

  it('ブランチが読めなければ作業中の Issue は無い', () => {
    expect(activeIssueFromBranch(remote, undefined)).toBeUndefined()
  })

  it('owner に使えない文字を含む remote なら作業中の Issue は無い', () => {
    expect(activeIssueFromBranch({ owner: 'own er', repository: 'repo' }, 'feat/x/387')).toBeUndefined()
  })
})
