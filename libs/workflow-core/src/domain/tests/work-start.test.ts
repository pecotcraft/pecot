import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import '../../../tests/_helpers/hint-commands.js'
import { formatHinted } from '../command-hint.js'
import { judgeReadiness } from '../readiness.js'
import type { IssueFacts, IssuePullRequest, Prerequisite } from '../readiness.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { decideStart } from '../work-start.js'

const repository = createRepositoryReference('acme', 'demo')
const target = createIssueReference(repository, 7)
const lower = createIssueReference(repository, 3)

describe('decideStart', () => {
  const targetFacts: IssueFacts = { ref: target, state: 'open', column: undefined, label: undefined, kind: 'task', branches: [], pullRequests: [] }
  const mergedPullRequest: IssuePullRequest = { repository, number: 1003, state: 'merged', headRefName: 'feat/3', baseRefName: 'main', isDraft: false, isCrossRepository: false }
  const mergedOpen: Prerequisite = { issue: { ...targetFacts, ref: lower, pullRequests: [mergedPullRequest] }, wait: 'stack', reason: undefined }
  const unblockHint = 'to remove the prerequisite: issue_dependency_check with method: "remove", owner: "acme", repo: "demo", issue_number: 7, type: "blocked_by", related_owner: "acme", related_repo: "demo", related_issue_number: 3, then issue_dependency_write with the same arguments'

  function blockedText(prerequisite: Prerequisite): string {
    const judged = judgeReadiness({ target: targetFacts, prerequisites: [prerequisite], cycle: undefined, pullRequestsByHead: new Map(), developmentBranch: 'main' })
    const decision = decideStart(judged, [prerequisite], target)
    return decision.kind === 'blocked' ? formatHinted(decision.message) : decision.kind
  }

  it('マージ済みの PR を持つ open の前提で止める場合は、Issue を close するか再実行するよう案内する', async () => {
    await explains('着手の可否を決める関数のテストです。マージ済みの PR を持つ open の前提で止める場合に、Issue を close するか再実行するよう案内する文を表示することを確認します。')
    stepSync('結果を比べる', () => {
      expect(blockedText(mergedOpen)).toBe([
        '#7 is blocked by #3 (not in review: #3 (PR merged, Issue open))',
        '- #3: PR merged, Issue open',
        '#3 has a merged PR: close #3, or retry once it closes',
        unblockHint,
      ].join('\n'))
    })
  })

  it('スタックできない前提でも PR がマージ済みの場合は、マージ済みと表示し、スタックへ切り替える案内を表示しない', async () => {
    await explains('着手の可否を決める関数のテストです。スタックできない前提でも PR がマージ済みの場合に、マージ済みと表示し、スタックへ切り替える案内を表示しないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(blockedText({ ...mergedOpen, wait: 'merge', reason: '理由' })).toBe([
        '#7 is blocked by #3 (not in review: #3 (PR merged, Issue open))',
        '- #3: PR merged, Issue open',
        '#3 has a merged PR: close #3, or retry once it closes',
        unblockHint,
      ].join('\n'))
    })
  })

  it('マージ済みの PR を持つ前提でも列が Pending の場合は、in Pending と表示し、マージ済みの案内の行を表示しない', async () => {
    await explains('着手の可否を決める関数のテストです。マージ済みの PR を持つ前提でも列が `Pending` の場合に、`in Pending` と表示し、マージ済みの案内の行を表示しないことを確認します。')
    const pending: Prerequisite = stepSync('保留の前提を用意する', () => ({ ...mergedOpen, issue: { ...mergedOpen.issue, column: 'Pending' } }))
    stepSync('結果を比べる', () => {
      expect(blockedText(pending)).toBe([
        '#7 is blocked by #3 (not in review: #3 (in Pending))',
        '- #3: in Pending',
        unblockHint,
      ].join('\n'))
    })
  })
})
