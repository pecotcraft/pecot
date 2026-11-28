/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr_check の振る舞い（PW-PR-CHECK-*）を、MCP のツールの結果で確かめる。git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { step } from '../_helpers/step.js'
import { installFakeExecutable, prependToPath } from '../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { PR_TOOLS } from '../../src/commands/pr.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { stateFile } from '../_helpers/workspace-inspect.js'
import { HOST, openWorkspace } from '../_helpers/workspace.js'
import type { Workspace, WorkspaceOptions } from '../_helpers/workspace.js'

useIsolatedEnvironment()

const BRANCH = 'feat/demo/12'
const LOWER = 'feat/demo/11'
const TITLE = 'feat(demo): #12 見本の変更'
const SCREENSHOT = 'CLI の出力の文を変えない変更のため撮らない'
const CREATE = 'pecot-template://pr/create'
const RELEASE = 'pecot-template://pr/release'
const HEAD_SHA = '89abcdef0123456789abcdef0123456789abcdef'

const BODY_BEFORE_CLOSES = `## Summary — 見本の変更を取り込む

見本の変更を取り込みます。

## Changes

なし

## Verified — 見本の確認を終えた

確認しました。

- 見本の確認 — 通過

## Risks — 残る懸念はない

なし。

- 見本の懸念 — なし
`

const VALID_BODY = `${BODY_BEFORE_CLOSES}\nCloses #12\n`

const RELEASE_BODY = `## Summary — v0.5.0 の公開

利用者に届く変更の要点

## Changes — CHANGELOG 転記

- 変更1
- 変更2

## Migration — なし

なし

## Changes

なし

## Verified — 全項目確認済み

- **CHANGELOG.md** — 該当バージョン節の更新を確認
- **テスト** — run-tests.sh --scope=all で通過を確認
- **ドキュメント** — 更新不要と判断
`

const PROBLEMS = z.array(z.record(z.string(), z.unknown()))

// 作業リポジトリに入り、pr_check を同じプロセスの中のクライアントから 1 回呼ぶ
async function check(workspace: Readonly<Workspace>, arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(workspace.directory)
  try {
    return await callToolOnce(PR_TOOLS, 'pr_check', arguments_)
  }
  finally {
    process.chdir(previous)
  }
}

function createArguments(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { method: 'create', owner: 'acme', repo: 'demo', title: TITLE, head: BRANCH, base: 'main', body: VALID_BODY, template: CREATE, screenshot: SCREENSHOT, ...extra }
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  expect(outcome.isError).toBe(false)
  return PROBLEMS.parse(outcome.structured['problems'])
}

function codesOf(outcome: Readonly<ToolOutcome>): readonly (readonly unknown[])[] {
  return problemsOf(outcome).map(problem => [problem['field'], problem['code']])
}

function pushedBranch(extra: Readonly<WorkspaceOptions> = {}): Workspace {
  return openWorkspace({ branch: BRANCH, branches: [{ name: BRANCH }], ...extra })
}

function commitFile(workspace: Readonly<Workspace>, file: string, content: string): void {
  writeFileSync(path.join(workspace.directory, file), content)
  workspace.git(['add', file])
  workspace.git(['commit', '-q', '-m', `change ${file}`])
}

function writeRecord(workspace: Readonly<Workspace>, content: string): void {
  const record = path.join(workspace.directory, stateFile('.pecot-base'))
  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, content)
}

// 親ブランチの上に子ブランチ（BRANCH）をスタックして push し、親ブランチの今の remote の先頭で base の記録を書く
function openStackedUpper(): Workspace {
  const workspace = openWorkspace({ branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }] })
  workspace.git(['checkout', '-q', '-b', BRANCH, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n')
  workspace.git(['push', '-q', '-u', 'origin', BRANCH])
  writeRecord(workspace, `${LOWER} ${workspace.git(['rev-parse', `origin/${LOWER}`]).trim()} acme/demo#11\n`)
  return workspace
}

// from の上にコミットを作って origin の target へ push し、子ブランチに戻る
function pushTo(workspace: Readonly<Workspace>, from: string, target: string, file: string, content: string): void {
  workspace.git(['checkout', '-q', '-b', `work-${target.replaceAll('/', '-')}`, from])
  commitFile(workspace, file, content)
  workspace.git(['push', '-q', '--force', 'origin', `HEAD:refs/heads/${target}`])
  workspace.git(['checkout', '-q', BRANCH])
}

// remote の子ブランチだけを、onto の上に作り直して置き換える。手元の子ブランチは古いまま残る
function restackUpperOnRemote(workspace: Readonly<Workspace>, onto: string): void {
  workspace.git(['checkout', '-q', '-b', 'rewritten', onto])
  workspace.git(['cherry-pick', BRANCH])
  workspace.git(['push', '-q', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`])
  workspace.git(['checkout', '-q', BRANCH])
}

// list_pull_requests の 1 件。親ブランチ（LOWER）を head に持つ PR #11
function listedLower(state: 'open' | 'closed', isMerged = false): Record<string, unknown> {
  return {
    number: 11,
    state,
    ...(isMerged && { merged_at: '2026-11-01T00:00:00Z' }),
    html_url: `https://${HOST}/acme/demo/pull/11`,
    head: { ref: LOWER, repo: { full_name: 'acme/demo' } },
    base: { ref: 'main', repo: { full_name: 'acme/demo' } },
  }
}

// pull_request_read（method get）の結果。PR #21 の head は BRANCH
function readPullRequest(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    number: 21,
    title: TITLE,
    body: VALID_BODY,
    state: 'open',
    draft: false,
    merged: false,
    mergeable_state: 'clean',
    html_url: `https://${HOST}/acme/demo/pull/21`,
    head: { ref: BRANCH, sha: HEAD_SHA },
    base: { ref: 'main' },
    ...extra,
  }
}

function mergeArguments(extra: Readonly<Record<string, unknown>> = {}, pullRequest: Readonly<Record<string, unknown>> = readPullRequest()): Record<string, unknown> {
  return { method: 'merge', owner: 'acme', repo: 'demo', pullNumber: 21, merge_method: 'squash', expectedHeadSha: HEAD_SHA, reads: { pull_request: pullRequest }, ...extra }
}

// issue_read（method get）の結果。Epic なら Issue の種別を Epic にする
function readIssue(isEpic: boolean): Record<string, unknown> {
  return { issue: { number: 12, html_url: `https://${HOST}/acme/demo/issues/12`, issue_type: isEpic ? 'Epic' : 'Task' } }
}

function installNx(projects: Readonly<Record<string, { readonly root: string, readonly tags: readonly string[] }>>): void {
  const nodes = Object.fromEntries(Object.entries(projects).map(([name, data]) => [name, { data }]))
  const bin = makeTemporaryDirectory('pecot-nx-')
  installFakeExecutable(bin, 'nx', `file="\${2#--file=}"\nprintf '%s' '${JSON.stringify({ graph: { nodes } })}' > "$file"\n`)
  prependToPath(bin)
}

const NX_OPTIONS: WorkspaceOptions = {
  commits: [{ message: 'nx', files: { 'nx.json': '{}\n' } }],
  branch: BRANCH,
  branches: [{ name: BRANCH, commits: [{ message: 'change', files: { 'plugins/pecot-workflow/a.txt': 'x\n' } }] }],
  config: { releaseType: 'nx' },
}

describe('pr_check', () => {
  describe('create・update の値', () => {
    it('push 済みのブランチで決まりに合う create の値を渡すと、GitHub を読み書きせずに problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-01')
      await explains('push 済みのブランチで、同梱の `create` のテンプレートに合う値を渡すテストです。問題の無い結果と `ok` を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments())
      await step('結果を確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [] }, text: 'ok' })
      })
    })

    it('本文にテンプレートのフロントマターと番号の無い Closes # の行が残ると、それぞれを body の problem にする', async (context) => {
      await verifies(context, 'PW-PR-CHECK-01')
      await explains('テンプレートを写したままのフロントマターと、番号の無い `Closes #` の行が本文に残る場合のテストです。`frontmatter` と `empty-closes` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const body = `---\ntitle: ""\n---\n${BODY_BEFORE_CLOSES}\nCloses #\n`
      const outcome = await check(workspace, createArguments({ body, template: undefined, reads: { issue: readIssue(true) } }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['body', 'frontmatter'], ['body', 'empty-closes']])
      })
    })

    it('同梱の create のテンプレートで必須の節が足りないと、足りない節ごとに missing-section の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-02')
      await explains('同梱の `create` のテンプレートを指定し、`Summary` の節だけを持つ本文を渡すテストです。不足している節ごとに `missing-section` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ body: '## Summary — 見本の変更を取り込む\n\n<img src="https://example.com/a.png" alt="結果">\n\nCloses #12\n' }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['body', 'missing-section'], ['body', 'missing-section'], ['body', 'missing-section']])
      })
    })

    it('同梱に無い PR のテンプレートを指定すると、同梱の 2 つを候補に添えて unknown-template の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-02')
      await explains('`pecot-template://pr/` で始まるが同梱に存在しないテンプレートを指定するテストです。`create` と `release` を候補に含む `unknown-template` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ template: 'pecot-template://pr/unknown' }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'template', code: 'unknown-template', candidates: [CREATE, RELEASE] })])
      })
    })

    it.for([
      { name: '差し替えたテンプレートのパス', template: '.github/pecot/pr/create.md' },
      { name: 'テンプレートの省略', template: undefined },
    ])('$name では、本文にテンプレートの見出しの決まりを当てない', async ({ name, template }, context) => {
      await verifies(context, 'PW-PR-CHECK-03')
      await explains(`${name}の場合のテストです。見出しの無い本文でも、同梱のテンプレートの決まりと画像の決まりを当てず、問題の無い結果を返すことを確認します。`)
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ template, body: '変更です。\n\nCloses #12\n', screenshot: undefined }))
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })

    it('create に title・head・base が無いと、それぞれの required の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-04')
      await explains('`method` が `create` で、`title`・`head`・`base` を渡さないテストです。不足している引数ごとに `required` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ title: undefined, head: undefined, base: '' }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['title', 'required'], ['head', 'required'], ['base', 'required']])
      })
    })

    it('update に pullNumber が無いと、pullNumber の required の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-04')
      await explains('`method` が `update` で `pullNumber` を渡さないテストです。書き換える PR を示す `pullNumber` が不足している問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, { method: 'update', owner: 'acme', repo: 'demo', body: VALID_BODY })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['pullNumber', 'required']])
      })
    })

    it('update に reads.pull_request が無いと、pull_request_read で読むよう read-required の problem で案内する', async (context) => {
      await verifies(context, 'PW-PR-CHECK-05')
      await explains('`method` が `update` で、PR の読み取りの結果を渡さないテストです。`pull_request_read` で読んで `reads.pull_request` に渡すよう案内する問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, { method: 'update', owner: 'acme', repo: 'demo', pullNumber: 21, body: VALID_BODY })
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{ field: 'reads.pull_request', code: 'read-required', message: 'read acme/demo#21 with pull_request_read (method get) and pass its result as reads.pull_request' }])
      })
    })

    it('update の reads.pull_request が別の番号の PR だと、pullNumber の not-found の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-05')
      await explains('`method` が `update` で、`pullNumber` と異なる番号の PR の読み取りの結果を渡すテストです。`pullNumber` の `not-found` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, { method: 'update', owner: 'acme', repo: 'demo', pullNumber: 21, body: VALID_BODY, reads: { pull_request: readPullRequest({ number: 22 }) } })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['pullNumber', 'not-found']])
      })
    })

    it('update で base と title を省くと、読み取った PR の base と題で照らし、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-01')
      await explains('`method` が `update` で本文だけを渡すテストです。`reads.pull_request` の PR の `base` と題を使って照らし、問題の無い結果を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, { method: 'update', owner: 'acme', repo: 'demo', pullNumber: 21, body: VALID_BODY, template: CREATE, screenshot: SCREENSHOT, reads: { pull_request: readPullRequest() } })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })

    it('本文が Issue を閉じず、ブランチの Issue が Epic でないと、Closes #12 を候補に missing-closes の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-06')
      await explains('本文に `Closes` が無く、`reads.issue` の Issue #12 が Epic でない場合のテストです。`Closes #12` を候補に含む `missing-closes` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ body: BODY_BEFORE_CLOSES, reads: { issue: readIssue(false) } }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'body', code: 'missing-closes', candidates: ['Closes #12'] })])
      })
    })

    it('本文が Issue を閉じず、reads.issue が無いと、issue_read で読むよう read-required の problem で案内する', async (context) => {
      await verifies(context, 'PW-PR-CHECK-07')
      await explains('本文に `Closes` が無く、ブランチの Issue の読み取りの結果を渡さない場合のテストです。`issue_read` で読んで `reads.issue` に渡すよう案内する問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ body: BODY_BEFORE_CLOSES }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['reads.issue', 'read-required']])
        expect(problemsOf(outcome)[0]?.['message']).toContain('read acme/demo#12 with issue_read (method get)')
      })
    })

    it('ブランチの Issue が Epic だと、本文に Closes が無くても problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-08')
      await explains('本文に `Closes` が無く、`reads.issue` の Issue #12 の種別が Epic の場合のテストです。`Closes` を求めず、問題の無い結果を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ body: BODY_BEFORE_CLOSES, reads: { issue: readIssue(true) } }))
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })

    it('同梱の create のテンプレートで Summary に画像が無く screenshot も空だと、screenshot の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-09')
      await explains('同梱の `create` のテンプレートで、`Summary` に画像が無く、`screenshot` に理由も無い場合のテストです。`screenshot` の `required` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ screenshot: ' ' }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['screenshot', 'required']])
      })
    })

    it('リリース PR の値を渡すと、base を release_branch に照らし、Issue と画像の決まりを当てない', async (context) => {
      await verifies(context, 'PW-PR-CHECK-14')
      await explains('`release` のテンプレートで、開発ブランチから `release_branch` へのリリース PR の値を渡すテストです。`Closes` と画像を求めず、問題の無い結果を返すことを確認します。')
      const workspace = openWorkspace({ config: { releaseBranch: 'release' } })
      const outcome = await check(workspace, createArguments({ title: 'release: v0.5.0', head: 'main', base: 'release', body: RELEASE_BODY, template: RELEASE, screenshot: undefined }))
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })

    it('リリース PR の base が release_branch と違うと、release_branch を候補に base-mismatch の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-14')
      await explains('`release` のテンプレートで、`base` に `release_branch` と異なるブランチを渡すテストです。`release` を候補に含む `base-mismatch` の問題を返すことを確認します。')
      const workspace = openWorkspace({ config: { releaseBranch: 'release' }, branches: [{ name: 'other' }] })
      const outcome = await check(workspace, createArguments({ title: 'release: v0.5.0', head: 'main', base: 'other', body: RELEASE_BODY, template: RELEASE, screenshot: undefined }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'base', code: 'base-mismatch', candidates: ['release'] })])
      })
    })

    it('nx を使うリポで題の scope が変更した nx のプロジェクトと違うと、期待する scope を候補に title-scope の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-15')
      await explains('nx を使うリポで、`plugins/pecot-workflow` を変更したブランチの題の scope に `pecot` を渡すテストです。`p-w` を候補に含む `title-scope` の問題を返すことを確認します。')
      installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
      const workspace = openWorkspace(NX_OPTIONS)
      const outcome = await check(workspace, createArguments({ title: 'feat(pecot): #12 見本の変更' }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{
          field: 'title',
          code: 'title-scope',
          message: 'PR title scope must be p-w (given: pecot; computed from the tags of the changed nx projects)',
          candidates: ['p-w'],
        }])
      })
    })
  })

  describe('スタックした base', () => {
    it.for([
      { name: '親 PR が開いていて base が親ブランチ', base: LOWER, isOpen: true },
      { name: '親 PR がマージ済みで base が開発ブランチ', base: 'main', isOpen: false },
    ])('$name だと、problem の無い結果を返す', async ({ name, base, isOpen }, context) => {
      await verifies(context, 'PW-PR-CHECK-10')
      await explains(`スタックの記録のある head で、${name}の場合のテストです。記録と親 PR の状態から決まる base に合うため、問題の無い結果を返すことを確認します。`)
      const workspace = openStackedUpper()
      const lower = isOpen ? listedLower('open') : listedLower('closed', true)
      const outcome = await check(workspace, createArguments({ base, reads: { pull_requests: [lower] } }))
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })

    it('親 PR が開いているのに base に開発ブランチを渡すと、親ブランチを候補に base-mismatch の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-10')
      await explains('スタックの記録のある head で、親 PR が開いているのに `base` に `main` を渡すテストです。親ブランチを候補に含む `base-mismatch` の問題を返すことを確認します。')
      const workspace = openStackedUpper()
      const outcome = await check(workspace, createArguments({ reads: { pull_requests: [listedLower('open')] } }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{ field: 'base', code: 'base-mismatch', message: `base branch must be ${LOWER} while its PR #11 is open (given: main)`, candidates: [LOWER] }])
      })
    })

    it('親ブランチに開いた PR もマージ済みの PR も無いと、PR を開く案内を添えて base-mismatch の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-11')
      await explains('スタックの記録のある head で、親ブランチの PR が閉じたものだけの場合のテストです。親ブランチの PR を開き直す案内を含む `base-mismatch` の問題を返すことを確認します。')
      const workspace = openStackedUpper()
      const outcome = await check(workspace, createArguments({ base: LOWER, reads: { pull_requests: [listedLower('closed')] } }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{
          field: 'base',
          code: 'base-mismatch',
          message: `base branch ${LOWER} has no open PR\nreopen the PR of ${LOWER}, or create a new one, then call pr_check again`,
        }])
      })
    })

    it('スタックの記録のある head で reads.pull_requests が無いと、list_pull_requests で読むよう read-required の problem で案内する', async (context) => {
      await verifies(context, 'PW-PR-CHECK-12')
      await explains('スタックの記録のある head で、親ブランチの PR の読み取りの結果を渡さないテストです。`list_pull_requests` で読んで `reads.pull_requests` に渡すよう案内する問題を返すことを確認します。')
      const workspace = openStackedUpper()
      const outcome = await check(workspace, createArguments({ base: LOWER }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{
          field: 'reads.pull_requests',
          code: 'read-required',
          message: `the head is stacked on ${LOWER}: read its PRs with list_pull_requests (owner acme, repo demo, head acme:${LOWER}, state all) and pass its result as reads.pull_requests`,
        }])
      })
    })

    it('スタックの記録が無い head で base に開発ブランチと違うブランチを渡すと、開発ブランチを候補に base-mismatch の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-13')
      await explains('開発ブランチから着手した記録を持つ head で、`base` に別のブランチを渡すテストです。開発ブランチの `main` を候補に含む `base-mismatch` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ base: LOWER }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'base', code: 'base-mismatch', candidates: ['main'] })])
      })
    })

    it('スタックしたブランチが remote とずれ、親ブランチが動いていると、Push Status の直し方を pr_restack にする', async (context) => {
      await verifies(context, 'PW-PR-CHECK-17')
      await explains('親ブランチが動き、remote の子ブランチだけがその上にスタックし直された場合のテストです。`unpushed-commits` の問題の直し方が `pr_restack` になることを確認します。')
      const workspace = openStackedUpper()
      await step('親ブランチを動かし、remote の子ブランチをスタックし直す', () => {
        pushTo(workspace, `origin/${LOWER}`, LOWER, 'lower-fix.txt', 'fix\n')
        restackUpperOnRemote(workspace, `origin/${LOWER}`)
      })
      const outcome = await check(workspace, createArguments({ base: LOWER, reads: { pull_requests: [listedLower('open')] } }))
      await step('結果を確かめる', () => {
        const problems = problemsOf(outcome)
        expect(problems.map(problem => [problem['field'], problem['code']])).toStrictEqual([['head', 'unpushed-commits']])
        expect(problems[0]?.['message']).toMatch(/^Push Status: diverged: .*\(fix: pr_restack\)$/u)
      })
    })

    it('base の記録のコミットが head の履歴に無いと、git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-18')
      await explains('`.pecot-base` の記録のコミットが head の履歴に含まれない場合のテストです。種別 `git-unresolved` の失敗を返し、記録の位置と書き直し方を示すことを確認します。')
      const workspace = pushedBranch()
      const foreign = await step('履歴に無いコミットで記録を書く', () => {
        const tree = workspace.git(['rev-parse', 'HEAD^{tree}']).trim()
        const sha = workspace.git(['commit-tree', tree, '-m', 'elsewhere']).trim()
        writeRecord(workspace, `${LOWER} ${sha} acme/demo#11\n`)
        return sha
      })
      const outcome = await check(workspace, createArguments({ base: LOWER, reads: { pull_requests: [listedLower('open')] } }))
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('git-unresolved')
        expect(outcome.structured['detail']).toContain(`.pecot-base records ${LOWER} at ${foreign.slice(0, 7)}, which is not in the history of ${BRANCH}`)
        expect(outcome.structured['detail']).toContain('pr_restack')
      })
    })
  })

  describe('create の事前の確認', () => {
    it('push していないブランチ、変更したファイル、stash があると、それぞれの problem を直し方を添えて返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-16')
      await explains('push していないブランチに、未追跡のファイルと stash がある場合のテストです。`unpushed-commits`・`uncommitted-changes`・`stash-left` の問題を直し方を添えて返すことを確認します。')
      const workspace = openWorkspace({ branch: BRANCH })
      await step('stash と未追跡のファイルを作る', () => {
        writeFileSync(path.join(workspace.directory, 'stashed.txt'), 'stashed\n')
        workspace.git(['stash', 'push', '-q', '-u', '-m', 'pr-check-test'])
        writeFileSync(path.join(workspace.directory, 'untracked.txt'), 'untracked\n')
      })
      const outcome = await check(workspace, createArguments())
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([
          { field: 'head', code: 'unpushed-commits', message: `Push Status: origin/${BRANCH} does not exist (not pushed) (fix: git push)` },
          { field: 'head', code: 'uncommitted-changes', message: 'Git Status: modified or untracked files (fix: commit)' },
          { field: 'head', code: 'stash-left', message: 'Stash List: 1 stash entries (fix: check them)' },
        ])
      })
    })

    it('update では事前の確認をせず、push していないブランチでも problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-16')
      await explains('`method` が `update` で、push していないブランチから呼ぶテストです。事前の確認は `create` のときだけ行うため、問題の無い結果を返すことを確認します。')
      const workspace = openWorkspace({ branch: BRANCH })
      const outcome = await check(workspace, { method: 'update', owner: 'acme', repo: 'demo', pullNumber: 21, body: VALID_BODY, template: CREATE, screenshot: SCREENSHOT, reads: { pull_request: readPullRequest() } })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })
  })

  describe('merge の値', () => {
    it('開いた PR を squash で先頭のコミットを添えてマージする値を渡すと、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-22')
      await explains('開発ブランチへの開いた PR を、`squash` と PR の先頭のコミットを添えてマージする値のテストです。問題の無い結果を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, mergeArguments())
      await step('結果を確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [] }, text: 'ok' })
      })
    })

    it.for([
      { name: 'マージ済み', extra: { state: 'closed', merged: true }, reason: 'is already merged' },
      { name: '閉じている', extra: { state: 'closed' }, reason: 'is closed' },
      { name: '下書き', extra: { draft: true }, reason: 'is a draft: mark it ready for review first' },
      { name: '衝突している', extra: { mergeable_state: 'dirty' }, reason: 'conflicts with its base: resolve the conflicts and push first' },
    ])('PR が $name だと、not-mergeable の problem を返す', async ({ name, extra, reason }, context) => {
      await verifies(context, 'PW-PR-CHECK-19')
      await explains(`\`merge\` で、\`reads.pull_request\` の PR が${name}の場合のテストです。理由を添えた \`not-mergeable\` の問題を返すことを確認します。`)
      const workspace = pushedBranch()
      const outcome = await check(workspace, mergeArguments({}, readPullRequest(extra)))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{ field: 'pullNumber', code: 'not-mergeable', message: `PR #21 ${reason}` }])
      })
    })

    it('merge に pullNumber と expectedHeadSha が無いと、それぞれの required の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-04')
      await verifies(context, 'PW-PR-CHECK-20')
      await explains('`method` が `merge` で、`pullNumber` と `expectedHeadSha` を渡さないテストです。不足している引数ごとに `required` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, { method: 'merge', owner: 'acme', repo: 'demo', merge_method: 'squash' })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['pullNumber', 'required'], ['expectedHeadSha', 'required']])
      })
    })

    it('merge の expectedHeadSha が PR の先頭と違うと、今の先頭を候補に head-moved の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-20')
      await explains('`method` が `merge` で、`expectedHeadSha` が `reads.pull_request` の先頭のコミットと異なるテストです。今の先頭を候補に含む `head-moved` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, mergeArguments({ expectedHeadSha: '0'.repeat(40) }))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'expectedHeadSha', code: 'head-moved', candidates: [HEAD_SHA] })])
      })
    })

    it('merge に reads.pull_request が無いと、pull_request_read で読むよう read-required の problem で案内する', async (context) => {
      await verifies(context, 'PW-PR-CHECK-05')
      await explains('`method` が `merge` で、PR の読み取りの結果を渡さないテストです。`reads.pull_request` の `read-required` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, mergeArguments({ reads: undefined }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['reads.pull_request', 'read-required']])
      })
    })

    it('PR の base を head に持つ開いた PR があると、not-stack-bottom の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-21')
      await explains('`merge` で、PR の `base` の親ブランチを head に持つ PR #11 が開いている場合のテストです。先に PR #11 をマージするよう案内する `not-stack-bottom` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const pullRequest = readPullRequest({ base: { ref: LOWER } })
      const outcome = await check(workspace, mergeArguments({ reads: { pull_request: pullRequest, pull_requests: [listedLower('open')] } }, pullRequest))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([{ field: 'pullNumber', code: 'not-stack-bottom', message: `the PR is stacked on PR #11 (head ${LOWER}), which is open: merge PR #11 first` }])
      })
    })

    it('PR の base が開発ブランチでなく reads.pull_requests が無いと、list_pull_requests で読むよう read-required の problem で案内する', async (context) => {
      await verifies(context, 'PW-PR-CHECK-21')
      await explains('`merge` で、PR の `base` が開発ブランチでなく、その親ブランチの PR の読み取りの結果を渡さないテストです。`reads.pull_requests` の `read-required` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const pullRequest = readPullRequest({ base: { ref: LOWER } })
      const outcome = await check(workspace, mergeArguments({}, pullRequest))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['reads.pull_requests', 'read-required']])
      })
    })

    it.for([
      { name: '開発ブランチへの PR で merge_method を省く', release: false, method: undefined, expected: 'squash' },
      { name: 'リリース PR に squash を渡す', release: true, method: 'squash', expected: 'merge' },
    ])('$name と、$expected を候補に merge-method の problem を返す', async ({ name, release, method, expected }, context) => {
      await verifies(context, 'PW-PR-CHECK-22')
      await explains(`\`merge\` で、${name}場合のテストです。PR の種類から決まる \`${expected}\` を候補に含む \`merge-method\` の問題を返すことを確認します。`)
      const workspace = pushedBranch({ config: { releaseBranch: 'release' } })
      const pullRequest = release ? readPullRequest({ head: { ref: 'main', sha: HEAD_SHA }, base: { ref: 'release' } }) : readPullRequest()
      const outcome = await check(workspace, mergeArguments({ merge_method: method }, pullRequest))
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toStrictEqual([expect.objectContaining({ field: 'merge_method', code: 'merge-method', candidates: [expected] })])
      })
    })

    it('リリース PR を merge でマージする値を渡すと、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-22')
      await explains('開発ブランチから `release_branch` へのリリース PR を、`merge` でマージする値のテストです。開発ブランチの履歴を残すマージ方法に合うため、問題の無い結果を返すことを確認します。')
      const workspace = pushedBranch({ config: { releaseBranch: 'release' } })
      const pullRequest = readPullRequest({ head: { ref: 'main', sha: HEAD_SHA }, base: { ref: 'release' } })
      const outcome = await check(workspace, mergeArguments({ merge_method: 'merge' }, pullRequest))
      await step('結果を確かめる', () => {
        expect(outcome.structured).toStrictEqual({ problems: [] })
      })
    })
  })

  describe('設定と入力の誤り', () => {
    it('対象のリポを含む設定が無いと、repo の not-in-project の problem を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-23')
      await explains('設定に含まれないリポ（`acme/other`）を `owner`・`repo` に渡すテストです。`repo` の `not-in-project` の問題を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ repo: 'other' }))
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toStrictEqual([['repo', 'not-in-project']])
      })
    })

    it('develop_branch が設定に無いと、project_link の案内を添えて repo-setting-missing の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-24')
      await explains('設定のリポに `develop_branch` が無い場合のテストです。種別 `repo-setting-missing` の失敗を返し、`project_link` で設定する案内を含めることを確認します。')
      const workspace = pushedBranch({ config: { developBranch: false } })
      const outcome = await check(workspace, createArguments())
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('repo-setting-missing')
        expect(outcome.structured['detail']).toContain('develop_branch is not set for acme/demo')
        expect(outcome.structured['detail']).toContain('project_link')
      })
    })

    it('reads.pull_request が公式の MCP の結果の形でないと、github-mcp-shape の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-25')
      await explains('`reads.pull_request` に必須の `head` と `base` を持たない値を渡すテストです。公式の GitHub MCP の結果の形と異なるため、種別 `github-mcp-shape` の失敗を返すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, mergeArguments({}, { number: 21, state: 'open', draft: false, merged: false, html_url: `https://${HOST}/acme/demo/pull/21` }))
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('github-mcp-shape')
        expect(outcome.structured['detail']).toContain('reads.pull_request')
      })
    })

    it('method に create・update・merge のほかの値を渡すと、invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-26')
      await explains('`method` に `close` を渡すテストです。種別 `invalid-input` のツールの失敗を返し、`detail` に `method` の誤りを示すことを確認します。')
      const workspace = pushedBranch()
      const outcome = await check(workspace, createArguments({ method: 'close' }))
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('invalid-input')
        expect(outcome.structured['detail']).toContain('method')
      })
    })
  })
})
