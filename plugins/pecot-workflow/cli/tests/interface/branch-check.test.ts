// branch_check の振る舞いを、MCP のツールの結果で確かめる。作業の Issue は acme/demo/7、前提は acme/demo/5
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { BRANCH_CHECK_TOOLS } from '../../src/commands/branch-check.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { enterGitRepository, setUpProject } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { containing } from '../hooks/_helpers/text.js'

useIsolatedEnvironment()

const TASK_BODY = '## Goal — 一覧画面から状態を確認できる\n\n利用者が一覧画面で各項目の状態を確認できる。\n'

function issueRead(number: number, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { issue: { number, title: `[Task] Issue ${String(number)}`, state: 'open', body: TASK_BODY, html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}`, ...extra } }
}

// issue_read（get）の結果に足す、開いた PR が閉じる旨の項目
function closing(pullRequest: number): Readonly<Record<string, unknown>> {
  return { closed_by_pull_requests: { references: [{ number: pullRequest, state: 'OPEN', url: `https://ghes.example.com/acme/demo/pull/${String(pullRequest)}` }] } }
}

function pullRequestRead(number: number, head: string, base: string): Readonly<Record<string, unknown>> {
  const branch = (reference: string): Readonly<Record<string, unknown>> => ({ ref: reference, sha: '0123456789abcdef0123456789abcdef01234567', repo: { full_name: 'acme/demo' } })
  return { number, title: `PR ${String(number)}`, state: 'open', draft: false, merged: false, html_url: `https://ghes.example.com/acme/demo/pull/${String(number)}`, head: branch(head), base: branch(base) }
}

// #7 の前提の読み取り
function blockedBy(numbers: readonly number[]): Readonly<Record<string, unknown>> {
  return { issue: 'acme/demo/7', result: { issues: numbers.map(number => ({ number, state: 'open', html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` })) } }
}

const READY_READS = { issues: [issueRead(7)], blocked_by: [blockedBy([])] }

// 前提の 5 は、main へ向く開いた PR #11（head は feat/5）を持つ
const STACK_READS = {
  issues: [issueRead(7), issueRead(5, closing(11))],
  blocked_by: [blockedBy([5])],
  pull_requests: [pullRequestRead(11, 'feat/5', 'main')],
}

const TARGET = { owner: 'acme', repo: 'demo', issue: 7, branch: 'feat/7' }

// 作業ディレクトリを、git remote が repository を指す一時のリポにする
function useProject(repository = 'acme/demo'): void {
  setUpProject()
  const directory = enterGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', `https://ghes.example.com/${repository}.git`])
}

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await step('branch_check を呼ぶ', async () => await callToolOnce(BRANCH_CHECK_TOOLS, 'branch_check', { ...TARGET, ...arguments_ }))
}

describe('branch_check', () => {
  it('前提の無い Issue を開発ブランチから作ると、problem の無い結果を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-01')
    await explains('前提を持たない開いた Issue のブランチを、`base` に開発ブランチ（`main`）を指定して作る場合のテストです。問題の無い結果を返し、`stacked_on` を返さないことを確認します。')
    useProject()
    const outcome = await check({ base: 'main', reads: READY_READS })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ problems: [] })
    })
  })

  it('スタックできる前提の Issue を前提のブランチから作ると、stacked_on に前提を入れる', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-02')
    await explains('開発ブランチへ向く PR を持つ前提の上にスタックできる Issue を、`base` に前提の PR の head（`feat/5`）を指定して作る場合のテストです。問題の無い結果と、`stacked_on` の前提を返すことを確認します。')
    useProject()
    const outcome = await check({ base: 'feat/5', reads: STACK_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [], stacked_on: 'acme/demo/5' })
    })
  })

  it('スタックできる前提の Issue を開発ブランチから作ると、前提のブランチを候補にした base-mismatch の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-02')
    await explains('前提の上にスタックできる Issue を、`base` に開発ブランチを指定して作る場合のテストです。`base-mismatch` の問題と前提の PR の head の候補を返し、`stacked_on` も返すことを確認します。')
    useProject()
    const outcome = await check({ base: 'main', reads: STACK_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({
        problems: [{ field: 'base', code: 'base-mismatch', message: 'the branch stacks on #5: base must be feat/5, not main', candidates: ['feat/5'] }],
        stacked_on: 'acme/demo/5',
      })
    })
  })

  it('PR の無い開いた前提を持つ Issue を渡すと、prerequisite-open の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-03')
    await explains('閉じる PR を持たない開いた Issue を前提に持つ Issue を渡した場合のテストです。着手できないため、`issue` の `prerequisite-open` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ base: 'main', reads: { issues: [issueRead(7), issueRead(5)], blocked_by: [blockedBy([5])] } })
    await step('結果を確かめる', () => {
      expect(outcome.structured['problems']).toEqual([expect.objectContaining({ field: 'issue', code: 'prerequisite-open' })])
    })
  })

  it('閉じた Issue を渡すと、再び開くよう案内する issue-closed の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-03')
    await explains('閉じた Issue のブランチを作ろうとした場合のテストです。作業を始める前に Issue を開き直すよう案内する `issue-closed` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ base: 'main', reads: { ...READY_READS, issues: [issueRead(7, { state: 'closed' })] } })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'issue', code: 'issue-closed', message: '#7 is closed: reopen it before starting work' }] })
    })
  })

  it('Issue の番号で終わらないブランチ名を渡すと、branch-name の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-04')
    await explains('ブランチ名が `/<Issue の番号>` で終わらない場合のテストです。名前の形を案内する `branch-name` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ branch: 'feat/list-status', base: 'main', reads: READY_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'branch', code: 'branch-name', message: 'the branch name must end with /7 after a prefix, such as feat/7' }] })
    })
  })

  it('作業ディレクトリの git remote が Issue のリポと違うと、repository-mismatch の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-05')
    await explains('作業ディレクトリの git remote が別のリポジトリ（`acme/other`）を指す場合のテストです。対象のリポジトリの worktree へ移るよう案内する `repository-mismatch` の問題を返すことを確認します。')
    useProject('acme/other')
    const outcome = await check({ base: 'main', reads: READY_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured['problems']).toEqual([expect.objectContaining({ field: 'repo', code: 'repository-mismatch', message: containing('differs from the CWD git remote (acme/other)') })])
    })
  })

  it('プロジェクトに無いリポジトリの Issue を渡すと、not-in-project の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-06')
    await explains('プロジェクトの設定に存在しないリポジトリ（`acme/other`）の Issue を渡した場合のテストです。`repo` の `not-in-project` の問題を返すことを確認します。')
    useProject('acme/other')
    const outcome = await check({ repo: 'other', base: 'main', reads: READY_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured['problems']).toContainEqual(expect.objectContaining({ field: 'repo', code: 'not-in-project' }))
    })
  })

  it('reads を渡さないと、Issue の読み取りを案内する read-required の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-07')
    await explains('`reads` を渡さずに呼んだ場合のテストです。前提を判定できないため、読み取りを案内する `read-required` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ base: 'main' })
    await step('結果を確かめる', () => {
      expect(outcome.structured['problems']).toContainEqual(expect.objectContaining({ code: 'read-required' }))
      expect(outcome.structured).not.toHaveProperty('stacked_on')
    })
  })

  it('開発ブランチから作るのに base を省くと、開発ブランチを候補にした required の problem を返す', async (context) => {
    await verifies(context, 'PW-BRANCH-CHECK-08')
    await explains('前提を持たない Issue のブランチを、`base` を省いて作る場合のテストです。リポジトリの既定のブランチから作られるのを防ぐため、開発ブランチを候補にした `required` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ reads: READY_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'base', code: 'required', message: 'give base main (the develop branch); without it, link-branch starts from the default branch of the repository', candidates: ['main'] }] })
    })
  })
})
