/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// session_finish の振る舞いを、ツールをプロセス内で呼んで確かめる。GitHub の読み取りは reads に渡す。
// git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { step, stepSync } from '../_helpers/step.js'
import { TOOLS } from '../../src/commands/registry.js'
import { ambiguousWorkspaceFiles, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { stateFile } from '../_helpers/workspace-inspect.js'
import { HOST, openWorkspace } from '../_helpers/workspace.js'
import type { Workspace, WorkspaceOptions } from '../_helpers/workspace.js'

useIsolatedEnvironment()

type Json = Readonly<Record<string, unknown>>

const BRANCH = 'feat/demo/12'

function branchOf(reference: string, repository = 'acme/demo'): Json {
  return { ref: reference, sha: '0123456789abcdef0123456789abcdef01234567', repo: { full_name: repository } }
}

interface PullRequestSpec {
  readonly number?: number
  readonly repository?: string
  readonly head?: string
  readonly base?: string
  readonly body?: string
  readonly state?: 'open' | 'merged'
}

// pull_request_read（get）の結果
function pullRequestRead(spec: Readonly<PullRequestSpec> = {}): Json {
  const { number = 21, repository = 'acme/demo', head = BRANCH, base = 'main', body = 'Closes #12\n', state = 'merged' } = spec
  return {
    number,
    title: `PR ${String(number)}`,
    body,
    state: state === 'open' ? 'open' : 'closed',
    draft: false,
    merged: state === 'merged',
    html_url: `https://${HOST}/${repository}/pull/${String(number)}`,
    head: branchOf(head, repository),
    base: branchOf(base, repository),
  }
}

function dependency(issue: string, numbers: readonly number[]): Json {
  return { issue, result: { issues: numbers.map(number => ({ number, state: 'open', html_url: `https://${HOST}/acme/demo/issues/${String(number)}` })) } }
}

function issueRead(number: number, closedBy?: number): Json {
  const closing = closedBy === undefined ? {} : { closed_by_pull_requests: { references: [{ number: closedBy, state: 'OPEN', url: `https://${HOST}/acme/demo/pull/${String(closedBy)}` }] } }
  return { issue: { number, title: `[Task] Issue ${String(number)}`, state: 'open', body: '## Goal — 見本\n\n見本の Issue。\n', html_url: `https://${HOST}/acme/demo/issues/${String(number)}`, ...closing } }
}

// マージした PR #21 だけを読む。#12 を待つ Issue と子 PR は無い
const PLAIN_READS = { pull_request: pullRequestRead(), blocking: [dependency('acme/demo/12', [])], children: [] }

// #13 は #12 だけを待つ未着手の Issue。#14 は #12 の上にスタックした PR #22（feat/demo/14）を持つ
const WAITING_READS = {
  pull_request: pullRequestRead(),
  blocking: [dependency('acme/demo/12', [13, 14])],
  children: [pullRequestRead({ number: 22, head: 'feat/demo/14', base: BRANCH, body: '', state: 'open' })],
  issues: [issueRead(12, 21), issueRead(13), issueRead(14, 22)],
  blocked_by: [dependency('acme/demo/13', [12]), dependency('acme/demo/14', [12])],
  pull_requests: [pullRequestRead({ state: 'open' }), pullRequestRead({ number: 22, head: 'feat/demo/14', base: BRANCH, body: '', state: 'open' })],
}

const RECORDS = ['.pecot-base', '.pecot-session-title']
// 古い版が作ったまま残るフラグ。session_finish は触れない
const LEFTOVER_FLAGS = ['.pecot-quick-mode', '.pecot-active']

function flagFiles(): Record<string, string> {
  return Object.fromEntries([...RECORDS, ...LEFTOVER_FLAGS].map(name => [stateFile(name), 'x\n']))
}

function currentBranch(workspace: Readonly<Workspace>, cwd?: string): string {
  return workspace.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
}

function hasBranch(workspace: Readonly<Workspace>): boolean {
  return workspace.git(['branch', '--list', BRANCH]).trim() !== ''
}

function cleanupBranch(extra: Readonly<WorkspaceOptions> = {}): Workspace {
  return stepSync('作業ブランチのある一時リポを用意する', () => openWorkspace({
    branch: BRANCH,
    branches: [{ name: BRANCH, commits: [{ message: '未マージの変更', files: { 'feature.txt': 'x\n' } }] }],
    ...extra,
  }))
}

// コマンドは process.cwd() を作業リポジトリとして読むので、呼ぶ間だけ移る
async function finish(workspace: Readonly<Workspace>, arguments_: Json = {}, cwd = workspace.directory): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    return await callToolOnce(TOOLS, 'session_finish', { pr_ref: 'acme/demo/21', reads: PLAIN_READS, ...arguments_ })
  }
  finally {
    process.chdir(previous)
  }
}

describe('session_finish', () => {
  it('マージ済みの PR の読み取りを渡すと、手元を片付ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-01')
    await explains('マージ済みの PR の `pull_request_read` の結果を渡した場合のテストです。開発ブランチへ切り替えて head ブランチを削除し、結果の項目を返すことを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace)
    await step('結果と手元を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ deletedBranches: [{ branch: BRANCH, location: 'local' }], readinessChanges: [], restack: [], currentBranch: 'main' })
      expect(currentBranch(workspace)).toBe('main')
    })
  })

  it('カレントのリポジトリが PR のリポジトリと同じで worktree の外だと、develop_branch のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('戻り先のブランチのテストです。カレントのリポジトリが PR のリポジトリと同じで、worktree の外の場合に、`develop_branch` のブランチへ切り替えることを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace)
    await step('切り替えた先を確かめる', () => {
      expect(outcome.structured['currentBranch']).toBe('main')
      expect(currentBranch(workspace)).toBe('main')
    })
  })

  it('カレントが worktree だと、置き場所の親ディレクトリの名前の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('戻り先のブランチのテストです。カレントが worktree の場合に、置き場所の親ディレクトリの名前に対応する `wtN` のブランチへ切り替えることを確認します。')
    const workspace = cleanupBranch({ branch: 'main', branches: [{ name: 'wt1' }, { name: BRANCH }], worktrees: [{ name: 'wt1', branch: 'wt1-work', files: {} }] })
    const worktree = path.join(workspace.root, 'wt1', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const outcome = await finish(workspace, {}, worktree)
    await step('切り替えた先を確かめる', () => {
      expect(outcome.structured['currentBranch']).toBe('wt1')
      expect(currentBranch(workspace, worktree)).toBe('wt1')
    })
  })

  it('カレントが worktree で add の記録があると、記録の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('戻り先のブランチのテストです。カレントが worktree で追加時の記録がある場合に、記録された `wtN` のブランチへ切り替えることを確認します。')
    const workspace = cleanupBranch({ branch: 'main', branches: [{ name: 'wt1' }, { name: BRANCH }], worktrees: [{ name: 'wt2', branch: 'wt2-work', files: {} }] })
    const worktree = path.join(workspace.root, 'wt2', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    writeFileSync(workspace.git(['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name'], worktree).trim(), 'wt1\n')
    const outcome = await finish(workspace, {}, worktree)
    await step('切り替えた先を確かめる', () => {
      expect(currentBranch(workspace, worktree)).toBe('wt1')
      expect(outcome.structured['currentBranch']).toBe('wt1')
    })
  })

  it.for([
    { name: 'bold-oak', branch: 'worktree-bold-oak' },
    { name: 'team+task', branch: 'worktree-team/task' },
  ])('カレントが Claude Code の作った .claude/worktrees/$name だと、$branch のブランチに切り替える', async (row, context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains(`カレントが \`.claude/worktrees/${row.name}\` の場合のテストです。フォルダ名の \`+\` を \`/\` と読み替えた \`${row.branch}\` へ切り替え、head ブランチを削除することを確認します。`)
    const workspace = cleanupBranch({ branch: 'main' })
    const worktree = path.join(workspace.directory, '.claude', 'worktrees', row.name)
    workspace.git(['worktree', 'add', '-q', '-b', row.branch, worktree])
    workspace.git(['checkout', '-q', BRANCH], worktree)
    await finish(workspace, {}, worktree)
    await step('切り替えた先を確かめる', () => {
      expect(currentBranch(workspace, worktree)).toBe(row.branch)
      expect(hasBranch(workspace)).toBe(false)
    })
  })

  it('worktree の中で戻り先のブランチが決まらないと、ブランチを切り替えずにローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-47')
    await explains('戻り先のブランチが決まらない場合のテストです。worktree の中で戻り先を決定できないときに、ブランチを切り替えず、警告を入れてローカルの後始末を実施しないことを確認します。')
    const workspace = cleanupBranch({ branch: 'main' })
    const worktree = path.join(workspace.root, 'elsewhere', 'demo')
    workspace.git(['worktree', 'add', '-q', worktree, BRANCH])
    const outcome = await finish(workspace, {}, worktree)
    await step('結果と手元を確かめる', () => {
      expect(outcome.structured['warnings']).toEqual(['cannot determine the branch to return to in this worktree; skipped local cleanup'])
      expect(outcome.structured).not.toHaveProperty('currentBranch')
      expect(currentBranch(workspace, worktree)).toBe(BRANCH)
      expect(hasBranch(workspace)).toBe(true)
    })
  })

  it('ブランチを切り替えると、origin の remote（無ければ最初の remote）から develop_branch を pull する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-07')
    await explains('pull のテストです。ブランチを切り替えた場合に、`origin` が存在しなければ最初の remote（`upstream`）から `develop_branch` を pull することを確認します。')
    const workspace = cleanupBranch()
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    workspace.advanceRemote('main')
    await finish(workspace)
    await step('pull した先頭を確かめる', () => {
      expect(workspace.git(['rev-parse', 'main'])).toBe(workspace.remoteGit(['rev-parse', 'main']))
    })
  })

  it('pull すると、ローカルの head ブランチを削除し、deletedBranches に local で入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-08')
    await explains('ローカルブランチの削除のテストです。pull が終わった場合に、ローカルの head ブランチを削除し、`deletedBranches` に `local` として入れることを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace)
    await step('結果と手元を確かめる', () => {
      expect(outcome.structured['deletedBranches']).toEqual([{ branch: BRANCH, location: 'local' }])
      expect(hasBranch(workspace)).toBe(false)
    })
  })

  it('ローカルの片付けを終えると、.pecot-base と .pecot-session-title を削除し、古い版のファイルは残す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-09')
    await explains('フラグのファイルの削除のテストです。ローカルの後始末が終わった場合に、作業の記録のファイルを削除し、古い版の `.pecot-quick-mode` と `.pecot-active` は残すことを確認します。')
    const workspace = cleanupBranch({ files: flagFiles() })
    await finish(workspace)
    await step('残ったファイルを確かめる', () => {
      expect(RECORDS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([false, false])
      expect(LEFTOVER_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
    })
  })

  it('.pecot-session-title が PR の閉じる Issue のものでないと、.pecot-base と .pecot-session-title を残す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-46')
    await explains('作業対象の記録のテストです。`.pecot-session-title` が PR の閉じる Issue でない #30 のものの場合に、`.pecot-base` と `.pecot-session-title` を残すことを確認します。')
    const workspace = cleanupBranch({ files: { [stateFile('.pecot-base')]: `main ${'0'.repeat(40)}\n`, [stateFile('.pecot-session-title')]: '#30 次の作業\n' } })
    const outcome = await finish(workspace)
    await step('残ったファイルを確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(RECORDS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
    })
  })

  it('カレントのリポジトリが PR のリポジトリと違うと、warnings に 1 つ入れ、ローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-19')
    await explains('リポジトリの不一致のテストです。カレントのリポジトリが PR のリポジトリ（`acme/other`）と異なる場合に、警告を 1 つ入れ、ローカルの後始末を実施しないことを確認します。')
    const workspace = cleanupBranch({ config: { hasSecondRepository: true } })
    const reads = { ...PLAIN_READS, pull_request: pullRequestRead({ repository: 'acme/other', body: '' }), blocking: [dependency('acme/other/12', [])] }
    const outcome = await finish(workspace, { pr_ref: 'acme/other/21', reads })
    await step('結果と手元を確かめる', () => {
      expect(outcome.structured['warnings']).toEqual(['current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup'])
      expect(currentBranch(workspace)).toBe(BRANCH)
      expect(hasBranch(workspace)).toBe(true)
    })
  })

  it('checkout に失敗すると、pull とローカルの head ブランチの削除を飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-23')
    await explains('checkout の失敗のテストです。`develop_branch` の `ghost` を checkout できない場合は、pull とローカルブランチの削除をしないことを確認します。')
    const workspace = cleanupBranch({ config: { developBranch: 'ghost' } })
    const outcome = await finish(workspace)
    await step('結果と手元を確かめる', () => {
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^checking out ghost failed: /u)])
      expect(outcome.structured['deletedBranches']).toEqual([])
      expect(currentBranch(workspace)).toBe(BRANCH)
    })
  })

  it('PR がマージされていないと、GitHub の画面でマージするよう案内して kind が pr-state の失敗を返し、何も変えない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-24')
    await explains('開いたままの PR の読み取りを渡した場合のテストです。`kind` が `pr-state` の失敗と、GitHub でマージするよう案内する `detail` を返し、手元のブランチと記録を変えないことを確認します。')
    const workspace = cleanupBranch({ files: flagFiles() })
    const outcome = await finish(workspace, { reads: { ...PLAIN_READS, pull_request: pullRequestRead({ state: 'open' }) } })
    await step('結果と手元を確かめる', () => {
      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'pr-state', detail: 'PR #21 is not merged yet (state: open); merge it on GitHub first' })
      expect(currentBranch(workspace)).toBe(BRANCH)
      expect(RECORDS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
    })
  })

  it.for([
    { name: 'pr_ref の形が誤っている', arguments_: { pr_ref: 'not-a-ref' } },
    { name: 'reads.pull_request が別の PR の読み取り', arguments_: { reads: { ...PLAIN_READS, pull_request: pullRequestRead({ number: 30 }) } } },
  ])('$name と、kind が invalid-input の失敗を返す', async ({ name, arguments_ }, context) => {
    await verifies(context, 'PW-SESSION-FINISH-28')
    await explains(`${name}場合のテストです。手元を変えずに、\`kind\` が \`invalid-input\` の失敗を返すことを確認します。`)
    const workspace = cleanupBranch()
    const outcome = await finish(workspace, arguments_)
    await step('結果と手元を確かめる', () => {
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(currentBranch(workspace)).toBe(BRANCH)
    })
  })

  it('閉じる Issue を待つ Issue の判定がマージで変わると、readinessChanges に入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-33')
    await explains('PR が閉じる #12 を、未着手の #13 とスタックした #14 が待つ場合のテストです。マージの前後で判定が変わる #13 と #14 を、`readinessChanges` に入れることを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace, { reads: WAITING_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured['readinessChanges']).toEqual([{ issue: '#13', from: 'stackable on #12', to: 'startable' }, { issue: '#14', from: 'stackable on #12', to: 'startable' }])
    })
  })

  it('マージしたブランチの上にスタックした Issue があると、restack に入れ、pr_restack を warnings で案内する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-35')
    await explains('マージしたブランチ `feat/demo/12` の上に、#14 の PR がスタックしている場合のテストです。`restack` に #14 とそのブランチを 1 回だけ入れ、`pr_restack` を `warnings` で案内することを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace, { reads: WAITING_READS })
    await step('結果を確かめる', () => {
      expect(outcome.structured['restack']).toEqual([{ issue: '#14', branch: 'feat/demo/14' }])
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^#14 is stacked on feat\/demo\/12; .*pr_restack.* in the working directory of feat\/demo\/14$/u)])
    })
  })

  it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-43')
    await explains('プロジェクトの設定が存在しない場合のテストです。`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
    const outcome = await finish(cleanupBranch({ config: false }))
    await step('結果を確かめる', () => {
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'repo-not-in-project' } })
    })
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で片付ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-44')
    await explains('`project` のテストです。対象のリポジトリを含む設定が 2 つあっても、`project` で指定した設定で後始末することを確認します。')
    const workspace = cleanupBranch({ files: ambiguousWorkspaceFiles() })
    const outcome = await finish(workspace, { project: SECOND_PROJECT })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(currentBranch(workspace)).toBe('main')
    })
  })

  it('判定に要る読み取りが足りないと、その Issue を判定せず、足りない読み取りを warnings で案内する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-48')
    await explains('`reads.blocking` と `reads.children` を渡さない場合のテストです。待つ Issue と子 PR を判定せずに後始末を続け、それぞれの読み取りを `warnings` で案内することを確認します。')
    const workspace = cleanupBranch()
    const outcome = await finish(workspace, { reads: { pull_request: pullRequestRead() } })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([
        'the Issues waiting for #12 are not judged: pass the result of issue_dependency_read (method get_blocking) for it in reads.blocking',
        `the PRs stacked on ${BRANCH} are not checked: pass the result of list_pull_requests (base ${BRANCH}, state open) in reads.children`,
      ])
      expect(outcome.structured['currentBranch']).toBe('main')
    })
  })

  it('待つ Issue の読み取りが無いと、その Issue の判定を飛ばして warnings に入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-48')
    await explains('#12 を待つ #13 の `issue_read` を渡さない場合のテストです。#13 の判定を飛ばし、判定できない理由を `warnings` に入れて後始末を続けることを確認します。')
    const workspace = cleanupBranch()
    const reads = { ...WAITING_READS, blocking: [dependency('acme/demo/12', [13])], children: [], issues: [issueRead(12, 21)] }
    const outcome = await finish(workspace, { reads })
    await step('結果を確かめる', () => {
      expect(outcome.structured['readinessChanges']).toEqual([])
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^the readiness of #13 is not judged: /u)])
      expect(outcome.structured['currentBranch']).toBe('main')
    })
  })

  it('短い形 N の pr_ref を repo なしで渡し、remote の URL から owner/repo を読めないと、短い形の案内と理由を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-COMMON-22')
    await explains('短い形の `N` で `pr_ref` を指定し、`repo` も指定せず、remote の URL から `owner/repo` を取得できない場合のテストです。短い形の案内と理由を出力して、終了コード 2 で終了することを確認します。')
    const workspace = cleanupBranch()
    workspace.git(['remote', 'set-url', 'origin', '/srv/git/demo.git'])
    const result = await step('session_finish を短い形で動かす', async () => await workspace.run('session_finish', { pr_ref: '21', reads: PLAIN_READS }))
    await step('終了コードと標準エラーを確かめる', () => {
      expect(result.code).toBe(2)
      expect(result.stderr).toBe([
        'error: the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'',
        '  could not read the repository from the URL of the Git remote origin',
        '',
      ].join('\n'))
    })
  })
})
