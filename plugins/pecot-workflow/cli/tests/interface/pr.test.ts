/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr の 3 コマンド（PW-PR-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { installFakeExecutable, prependToPath } from '../../src/tests/_helpers/fake-executables.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { settleWithFakeDelays, useFakeDelays } from '../_helpers/interface-case.js'
import { AMBIGUOUS_MESSAGE, ambiguousWorkspaceFiles, NO_ACTIVE_FILES, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { filesOf, KIND_FAILURE, lines, operationsOf, restRequests, stateFile } from '../_helpers/workspace-inspect.js'
import { graphql, HOST, issueKindData, openWorkspace, pullRequestData, REPOSITORY, rest, rule } from '../_helpers/workspace.js'
import type { ConfigOptions, PullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'
import { botResult, commentsRule, prerequisitesRule } from '../_helpers/prerequisites.js'
import type { TargetSpec } from '../_helpers/prerequisites.js'
import type { ResponseRule } from '../fake-github/server.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { PecotError } from '../../src/domain/errors.js'
import { compareStrings } from '../../src/domain/python-format.js'
import { templateFile } from '../../src/infra/template-store.js'
import { ProjectsApi } from '../../src/infra/github/projects.js'

useIsolatedEnvironment()

const BRANCH = 'feat/demo/12'
const NO_DEVELOP_BRANCH: ConfigOptions = { developBranch: false }
const TITLE = 'feat(demo): #12 見本の変更'
const SCREENSHOT = 'CLI の出力の文を変えない変更のため撮らない'
const PULL_URL = 'https://ghes.example.com/acme/demo/pull/21'

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
const BODY_WITHOUT_REFERENCE = BODY_BEFORE_CLOSES
const BODY_WITH_REFERENCE_ONLY = `${BODY_BEFORE_CLOSES}\nRefs #12\n`

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

const IN_REVIEW_RULES: ResponseRuleList = [
  graphql('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_1' } }] } } } }),
  graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }),
]
// 種別の問い合わせが 500 を返したときの warning。httpx の文言が 2 行に分かれ、suffix は 2 行目の末尾に付く
// head の Issue #12 を待つ Issue は無い
const NO_WAITING_RULE = graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: 0, nodes: [] } } } }, { variables: { number: 12 } })
const AFTER_CREATE_RULES: ResponseRuleList = [...IN_REVIEW_RULES, NO_WAITING_RULE]
const CREATED_RULE = rest('POST', '/repos/acme/demo/pulls', 201, { number: 21, html_url: PULL_URL })
const NOT_EPIC_RULE = graphql('GetIssueKind', issueKindData({ number: 12 }), { variables: { number: 12 } })
const SUBMIT_RULES: ResponseRuleList = [NOT_EPIC_RULE, CREATED_RULE, ...AFTER_CREATE_RULES]

// 共通の補助

function postedBody(workspace: Readonly<Workspace>): Record<string, unknown> {
  const posted = workspace.requests().find(request => request.type === 'rest' && request.method === 'POST' && request.path === '/repos/acme/demo/pulls')
  const body = posted?.type === 'rest' ? posted.body : undefined
  if (typeof body !== 'object' || body === null) throw new TypeError('POST /pulls を受けていない')
  return Object.fromEntries(Object.entries(body))
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

// スタックした base（親ブランチは Issue #11 の feat/demo/11）

const LOWER = 'feat/demo/11'
const RECORD_SHA = '0123456789abcdef0123456789abcdef01234567'
const STACKED_RECORD = { [stateFile('.pecot-base')]: `${LOWER} ${RECORD_SHA} acme/demo#11\n` }
const MALFORMED_RECORD = { [stateFile('.pecot-base')]: 'garbage\n' }
const STACKS_PATH = '/repos/acme/demo/stacks'
const STACKS_VERSION = '2026-03-10'
const NO_STACK_RULE = rule({ method: 'GET', path: STACKS_PATH, query: { pull_request: '20' }, apiVersion: STACKS_VERSION }, { status: 200, body: [] })
const CREATED_STACK_RULE = rule({ method: 'POST', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 201, body: { number: 5, pull_requests: [{ number: 20 }, { number: 21 }] } })

// 親ブランチを head に持つ PR #20
function lowerPullRequest(state: string): Record<string, unknown> {
  return { number: 20, state, headRefName: LOWER, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は入れ子が深く、読むだけ
function lowerPullRequests(nodes: readonly Record<string, unknown>[], times = 1): ResponseRule {
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } }
  return graphql('ListPullRequestsByHead', data, { variables: { headRefName: LOWER }, times })
}

const FORK_OWNER = 'someone'
const FORK_HEAD = `${FORK_OWNER}:${BRANCH}`

// 偽の ssh は remotes/<owner>/<repo>.git に向けるので、そこに fork の bare を置き、fork の名前で足す
function addForkRemote(workspace: Readonly<Workspace>, host = HOST): void {
  const bare = path.join(workspace.root, 'remotes', FORK_OWNER, `${REPOSITORY}.git`)
  mkdirSync(bare, { recursive: true })
  workspace.git(['init', '-q', '--bare', bare])
  workspace.git(['remote', 'add', 'fork', `git@${host}:${FORK_OWNER}/${REPOSITORY}.git`])
}

function forkArguments(): string[] {
  return messageArguments(['--head', FORK_HEAD], BODY_WITHOUT_REFERENCE)
}

function commitFile(workspace: Readonly<Workspace>, file: string, content: string): void {
  writeFileSync(path.join(workspace.directory, file), content)
  workspace.git(['add', file])
  workspace.git(['commit', '-q', '-m', `change ${file}`])
}

// 親ブランチの上に子ブランチ（BRANCH）をスタックして push し、親ブランチの今の remote の先頭で base の記録を書く
async function openStackedUpper(github: ResponseRuleList): Promise<Workspace> {
  const workspace = await openWorkspace({ branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }], github })
  workspace.git(['checkout', '-q', '-b', BRANCH, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n')
  workspace.git(['push', '-q', '-u', 'origin', BRANCH])
  const record = path.join(workspace.directory, stateFile('.pecot-base'))
  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, `${LOWER} ${workspace.git(['rev-parse', `origin/${LOWER}`]).trim()} acme/demo#11\n`)
  return workspace
}

// #12 の判定。#11 の PR #20 が開いていれば stackable、前提が無ければ startable
const STACKABLE_RULE = prerequisitesRule({ number: 12, blockedBy: [{ number: 11, branch: LOWER, pullRequests: [{ number: 20, head: LOWER }] }] })
const STARTABLE_RULE = prerequisitesRule({ number: 12 })

// 記録を置かずに、親ブランチの上に子ブランチ（BRANCH）をスタックして push する。別の worktree や clone で checkout したのと同じ形
async function openInferredUpper(github: ResponseRuleList): Promise<Workspace> {
  const workspace = await openWorkspace({ baseRecord: false, branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }], github })
  workspace.git(['checkout', '-q', '-b', BRANCH, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n')
  workspace.git(['push', '-q', '-u', 'origin', BRANCH])
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

type DivergeScene = 'moved' | 'merged' | 'amended'

const STACKED_CHECK_ROWS: readonly { readonly name: string, readonly scene: DivergeScene, readonly state: string }[] = [
  { name: '親ブランチが動き、remote の子ブランチがその上にスタックし直された', scene: 'moved', state: 'OPEN' },
  { name: '親 PR がマージされ、remote の子ブランチが開発ブランチの上にスタックし直された', scene: 'merged', state: 'MERGED' },
]

// diverged でスタックし直しが要らないときの直し方。文の中にロングオプションを書けない（lint）ので、git の引数から組む
const DIVERGED_FIX = `git pull --rebase, or ${['git', 'push', '--force-with-lease'].join(' ')} if you rewrote pushed commits`

const STACKED_CREATE_ROWS: readonly { readonly name: string, readonly scene: DivergeScene, readonly expected: string }[] = [
  { name: '親ブランチが動き、remote の子ブランチがその上にスタックし直された', scene: 'moved', expected: 'pecot pr restack' },
  { name: '親ブランチが動かないまま手元だけを書き換えた', scene: 'amended', expected: DIVERGED_FIX },
]

const UNDECIDED_ROWS: readonly { readonly name: string, readonly cause: 'pull-request-unreadable' | 'gone' | 'unreachable' }[] = [
  { name: '親 PR を読めない', cause: 'pull-request-unreadable' },
  { name: '親ブランチが remote から消え、PR がマージされていない', cause: 'gone' },
  { name: '親ブランチを尋ねる remote に届かない', cause: 'unreachable' },
]

// diverged の Push Status の warning の行ごとの、直し方
function pushStatusFixes(stderr: string): string[] {
  const prefix = 'warning: Push Status: diverged: '
  return lines(stderr).filter(line => line.startsWith(prefix)).map(line => line.slice(line.lastIndexOf('(fix: ') + '(fix: '.length, -1))
}

// スタックした子ブランチを、次の場面で remote とずらす
function divergeStacked(workspace: Readonly<Workspace>, scene: DivergeScene): void {
  if (scene === 'moved') {
    pushTo(workspace, `origin/${LOWER}`, LOWER, 'lower-fix.txt', 'fix\n')
    restackUpperOnRemote(workspace, `origin/${LOWER}`)
  }
  else if (scene === 'merged') {
    pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    restackUpperOnRemote(workspace, 'origin/main')
  }
  else workspace.git(['commit', '-q', '--amend', '-m', 'upper amended'])
}

const UNREADABLE_LOWER_RULE: ResponseRule = { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }

function stackedArguments(extra: readonly string[] = [], title = TITLE): string[] {
  return ['pr', 'create', '-m', VALID_BODY, '-t', title, '-b', LOWER, '-r', 'acme/demo', '--screenshot', SCREENSHOT, ...extra]
}

// 待っている Issue（#12 を前提にする #13。ボードでは Blocked）

function waitingRule(total = 1): ResponseRule {
  const nodes = [{ id: 'I_demo_13', number: 13, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }]
  return graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: total, nodes } } } }, { variables: { number: 12 } })
}

// #13 のボードの項目だけを読む。projectItems が空なら、ボードに載っていない
function boardItemRule(projectItems: readonly unknown[] = [{ id: 'PVTI_13', project: { id: 'PVT_1' }, workflow: { name: 'Blocked' } }]): ResponseRule {
  const issue = { number: 13, title: '課題13', state: 'OPEN', url: `https://${HOST}/acme/demo/issues/13`, repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems: { nodes: projectItems } }
  return graphql('GetIssueBoardItem', { repository: { issue } }, { variables: { number: 13 } })
}
const BOARD_RULE = boardItemRule()
const READY_WRITE_RULE = graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_13' } } }, { variables: { itemId: 'PVTI_13', optionId: 'o3' } })

// #13 の前提の読み取り。hasPullRequest なら、#12 のブランチに作った PR #21 が出る
function waitingTarget(hasPullRequest: boolean): TargetSpec {
  const blocker = hasPullRequest ? { number: 12, branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH }] } : { number: 12 }
  return { number: 13, blockedBy: [blocker] }
}

// #12 を待つ Issue が #13・#14 の 2 件。#13 の列は書け、#14 の書き込みの応答はテストごとに足す
const TWO_WAITING_NODES = [13, 14].map(number => ({ id: `I_demo_${String(number)}`, number, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }))
const ISSUE_14 = { number: 14, title: '課題14', state: 'OPEN', url: `https://${HOST}/acme/demo/issues/14`, repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems: { nodes: [{ id: 'PVTI_14', project: { id: 'PVT_1' }, workflow: { name: 'Blocked' } }] } }
const TWO_WAITING_RULES: ResponseRuleList = [
  CREATED_RULE,
  ...IN_REVIEW_RULES,
  graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: 2, nodes: TWO_WAITING_NODES } } } }, { variables: { number: 12 } }),
  BOARD_RULE,
  graphql('GetIssueBoardItem', { repository: { issue: ISSUE_14 } }, { variables: { number: 14 } }),
  prerequisitesRule(waitingTarget(true)),
  prerequisitesRule({ ...waitingTarget(true), number: 14 }),
  READY_WRITE_RULE,
]
const MOVED_13 = { issue: '#13', from: 'Blocked', to: 'Ready', reason: 'stackable on #12' }

// pr create

function pushedBranch(extra: Readonly<WorkspaceOptions> = {}): Promise<Workspace> {
  return openWorkspace({ branch: BRANCH, branches: [{ name: BRANCH }], ...extra })
}

function messageArguments(extra: readonly string[] = [], body = VALID_BODY): string[] {
  return ['pr', 'create', '-m', body, '-t', TITLE, '-b', 'main', '-r', 'acme/demo', '--screenshot', SCREENSHOT, ...extra]
}

interface FileOptions {
  readonly title?: string
  readonly repository?: string
  readonly base?: string
  readonly head?: string
  readonly body?: string
  readonly screenshot?: string
}

function writePrFile(workspace: Readonly<Workspace>, options: Readonly<FileOptions> = {}): string {
  const screenshot = options.screenshot ?? SCREENSHOT
  const frontmatter = [
    '---',
    `title: "${options.title ?? TITLE}"`,
    `repository: "${options.repository ?? 'acme/demo'}"`,
    `base: "${options.base ?? 'main'}"`,
    `head: "${options.head ?? ''}"`,
    'draft: false',
    ...(screenshot === '' ? [] : [`screenshot: "${screenshot}"`]),
    '---',
    '',
  ]
  return workspace.scratch('pr.md', `${frontmatter.join('\n')}\n${options.body ?? VALID_BODY}`)
}

// 作業リポジトリに入り、MCP のツールを同じプロセスの中のクライアントから 1 回呼ぶ
function callTool(workspace: Readonly<Workspace>, name: string, arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return callToolAt(workspace.directory, name, arguments_)
}

async function callToolAt(directory: string, name: string, arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(directory)
  try {
    return await callToolOnce(COMMANDS, name, arguments_)
  }
  finally {
    process.chdir(previous)
  }
}

function createTool(workspace: Readonly<Workspace>, arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return callTool(workspace, 'pr_create', arguments_)
}

const MESSAGE_ARGUMENTS = { message: VALID_BODY, title: TITLE, base: 'main', repo: 'acme/demo', screenshot: SCREENSHOT }
const MESSAGE_WITHOUT_REPOSITORY = { message: VALID_BODY, title: TITLE, base: 'main', screenshot: SCREENSHOT }
const CREATED = { head: BRANCH, base: 'main', title: TITLE, number: 21, inReview: 12, moves: [], url: PULL_URL }

describe('pr create', () => {
  it('default のテンプレのファイルで base を空のまま打つと、develop_branch を base にして PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-03')
    const workspace = await pushedBranch({ config: { developBranch: 'develop' }, github: SUBMIT_RULES })
    const file = writePrFile(workspace, { base: '' })
    const result = await workspace.run(['pr', 'create', file])
    expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
    expect(postedBody(workspace)).toMatchObject({ base: 'develop', head: BRANCH })
  })

  it('default のテンプレのファイルで base を空のまま打ち、develop_branch が無いと、PR を作らずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-38')
    const workspace = await pushedBranch({ config: NO_DEVELOP_BRANCH, github: SUBMIT_RULES })
    const file = writePrFile(workspace, { base: '' })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: develop_branch is not set\n/u)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('default のテンプレのファイルで末尾の Closes # を空のまま打つと、head ブランチ名の末尾の番号を入れて PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-05')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace, { body: `${BODY_BEFORE_CLOSES}\nCloses #\n` })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(`${BODY_BEFORE_CLOSES}\nCloses #12`)
  })

  it('head ブランチ名の末尾の番号の Issue が Epic のときにファイルで作ると、番号の空いた Closes # の行を消す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-06')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: `${BODY_WITH_REFERENCE_ONLY}Closes #\n` })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: Issue #12 at the end of the branch is an Epic; Closes not added, and the empty Closes line removed\n')
    expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
  })

  it('.pecot/state/ の無い clone で紐づいたブランチにいるときファイルで作ると、Closes にブランチの番号を入れる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-68')
    const workspace = await openWorkspace({
      branches: [{ name: 'feat/demo/34' }],
      github: [prerequisitesRule({ number: 34 }), graphql('GetIssueKind', issueKindData({ number: 34 }), { variables: { number: 34 } }), CREATED_RULE, ...IN_REVIEW_RULES],
    })
    const clone = path.join(workspace.root, 'clone', REPOSITORY)
    workspace.git(['clone', '-q', '-b', 'feat/demo/34', workspace.git(['remote', 'get-url', 'origin']).trim(), clone])
    cpSync(path.join(workspace.directory, '.pecot', 'config'), path.join(clone, '.pecot', 'config'), { recursive: true })
    expect(existsSync(path.join(clone, '.pecot/state'))).toBe(false)
    const file = writePrFile(workspace, { title: 'feat(demo): #34 見本の変更', body: `${BODY_BEFORE_CLOSES}\nCloses #\n` })
    const result = await workspace.run(['pr', 'create', file], clone)
    expect(result.code).toBe(0)
    expect(postedBody(workspace)).toMatchObject({ head: 'feat/demo/34', body: `${BODY_BEFORE_CLOSES}\nCloses #34` })
  })

  it('別の番号の古い .pecot-active が残っていても読まず、Closes にブランチの番号を入れる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-67')
    const workspace = await openWorkspace({
      branch: 'feat/demo/34',
      branches: [{ name: 'feat/demo/34' }],
      files: { [stateFile('.pecot-active')]: 'acme/demo/99\n' },
      github: [graphql('GetIssueKind', issueKindData({ number: 34 }), { variables: { number: 34 } }), CREATED_RULE],
    })
    const file = writePrFile(workspace, { title: 'feat(demo): #34 見本の変更', body: `${BODY_BEFORE_CLOSES}\nCloses #\n` })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(`${BODY_BEFORE_CLOSES}\nCloses #34`)
  })

  it('ファイルを渡すと、フロントマターの値で PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題', head: BRANCH })
    const result = await workspace.run(['pr', 'create', file])
    expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
    expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題', head: BRANCH, base: 'main', draft: false })
    expect(postedBody(workspace)['body']).toContain('## Summary — 見本の変更を取り込む')
  })

  it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルから PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題' })
    const result = await workspace.run(['pr', 'create', file, '-m', '別の本文 #12', '-t', '別の題', '-b', 'main'])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題' })
    expect(postedBody(workspace)['body']).not.toContain('別の本文')
  })

  it('-m に -t と -b を付けて打つと、PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
    expect(postedBody(workspace)).toMatchObject({ title: TITLE, base: 'main', head: BRANCH, body: VALID_BODY })
  })

  it('-m で --repo を省くと、設定のリポジトリが 1 つならそのリポジトリに PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '--screenshot', SCREENSHOT])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'POST', '/repos/acme/demo/pulls')).toHaveLength(1)
  })

  it('--head を省いて打つと、今のブランチを head にする', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    await workspace.run(messageArguments())
    expect(postedBody(workspace)['head']).toBe(BRANCH)
  })

  it('--draft を付けて -m で打つと、ドラフトの PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments(['--draft']))
    expect(result.stderr).toContain(`created: draft PR acme/demo ${BRANCH} -> main: ${TITLE}\n`)
    expect(postedBody(workspace)['draft']).toBe(true)
  })

  it.for([{ mode: 'file' }, { mode: 'message' }])('$mode の形で head ブランチ名の末尾に番号があると、本文にその番号の Closes を足す', async (row) => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const body = BODY_WITHOUT_REFERENCE
    const argv = row.mode === 'file' ? ['pr', 'create', writePrFile(workspace, { body })] : messageArguments([], body)
    const result = await workspace.run(argv)
    expect(result.code).toBe(0)
    const posted = postedBody(workspace)['body']
    expect(posted).toBe(`${body.trimEnd()}\n\nCloses #12`)
    expect(String(posted).endsWith('Closes #12')).toBe(true)
  })

  it('ファイルで作るとき末尾の番号の Issue の種別を読めないと、Closes を足さず、空の Closes # の行を消し、warning を出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-87')
    const workspace = await pushedBranch({ github: [KIND_FAILURE, CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: `${BODY_WITH_REFERENCE_ONLY}Closes #\n` })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: Issue #12 at the end of the branch could not be read as an Epic or not; Closes not added, and the empty Closes line removed$/mu)
    expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
  })

  it('ファイルで作るとき末尾の番号の Issue が Epic だと、Closes を足さない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-16')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
  })

  it('ファイルで作るとき末尾の番号の Issue が Epic だと、warning の行を標準エラーに出す', async () => {
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.stderr).toContain('warning: Issue #12 at the end of the branch is an Epic; Closes not added\n')
  })

  it('--no-issue-ref を付けて打つと、Closes を足さず、Issue の参照の確認もしない', async () => {
    const workspace = await pushedBranch({ github: [CREATED_RULE, ...AFTER_CREATE_RULES] })
    const result = await workspace.run(messageArguments(['--no-issue-ref'], BODY_WITHOUT_REFERENCE))
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(BODY_WITHOUT_REFERENCE)
    expect(operationsOf(workspace)).not.toContain('GetIssueKind')
  })

  it('--template release を付けて打つと、リリース PR として検証する', async (context) => {
    await verifies(context, 'PW-PR-CREATE-19')
    const workspace = await pushedBranch({ config: { developBranch: 'develop', releaseBranch: 'main' } })
    const missing = await workspace.run(['pr', 'create', '-m', '本文だけ', '-t', 'release: v0.5.0', '-b', 'main', '--head', 'develop', '-r', 'acme/demo', '--template', 'release', '--dry-run'])
    expect(missing.code).toBe(3)
    expect(missing.stderr).toMatch(/^error: missing sections: ## Summary, ## Changes, ## Migration, ## Verified\n/u)
    expect(missing.stderr).not.toContain('Issue reference')
    const wrongBase = await workspace.run(['pr', 'create', '-m', RELEASE_BODY, '-t', 'release: v0.5.0', '-b', 'staging', '--head', 'develop', '-r', 'acme/demo', '--template', 'release', '--dry-run'])
    expect(wrongBase.code).toBe(3)
    expect(wrongBase.stderr).toContain('error: release PR base branch must be main (given: staging)\n')
    const valid = await workspace.run(['pr', 'create', '-m', RELEASE_BODY, '-t', 'release: v0.5.0', '-b', 'main', '--head', 'develop', '-r', 'acme/demo', '--template', 'release', '--dry-run'])
    expect(valid).toMatchObject({ code: 0, stderr: 'dry-run: would create PR acme/demo develop -> main: release: v0.5.0 (release template)\n' })
  })

  it('--dry-run を付けずに打つと、PR を作る前に pr check と同じ確認をする', async (context) => {
    await verifies(context, 'PW-PR-CREATE-20')
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    const preflight = await workspace.run(['pr', 'check', '-D', workspace.directory])
    const warning = 'warning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)\n'
    expect(preflight.stderr).toContain(warning)
    const result = await workspace.run(messageArguments())
    expect(result.stderr).toContain(warning)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('--dry-run を付けて打つと、PR を作らずに dry-run: would create の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-21')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments(['--dry-run']))
    expect(result).toStrictEqual({
      code: 0,
      stdout: '',
      stderr: `dry-run: would create PR acme/demo ${BRANCH} -> main: ${TITLE}\ndry-run: would set Issue #12 status to In Review\n`,
    })
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('--dry-run を付けて打つと、事前の確認をしない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-22')
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await workspace.run(messageArguments(['--dry-run']))
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('preflight')
    expect(result.stderr).not.toContain('warning:')
  })

  it('PR を作ると、関連 Issue のボードの status を In Review にする', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.stderr).toContain('set: Issue #12 status to In Review\n')
    expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toMatchObject([
      { variables: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'PVTSSF_workflow', optionId: 'o5' } },
    ])
  })

  it('PR を作ると、その URL を標準出力に出す', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.stdout).toBe(`${PULL_URL}\n`)
  })

  it('PR を作ると、created の行を標準エラーに出す', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(lines(result.stderr)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review'])
  })

  it('本文に Issue の参照 #N が無いと、終了コード 3 で終わる', async () => {
    const workspace = await openWorkspace({ branch: 'feat/demo/other' })
    const result = await workspace.run(messageArguments(['--head', 'feat/demo/other', '--dry-run'], BODY_WITHOUT_REFERENCE))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: PR body has no Issue reference `#N` (use `--no-issue-ref` for a PR not tied to an Issue)\n')
  })

  it('必須の節が足りないと、終了コード 3 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(messageArguments(['--dry-run'], '本文だけ #12'))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: missing sections: ## Summary, ## Changes, ## Verified, ## Risks\n')
  })

  it('使えない記法があると、終了コード 3 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(messageArguments(['--dry-run'], `${VALID_BODY}\n- [ ] 残タスク\n`))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: disallowed syntax: checkbox syntax (- [ ] / 1. [ ]) is not allowed\n')
  })

  it('Summary に画像も screenshot の理由も無いと、終了コード 3 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '-r', 'acme/demo', '--dry-run'])
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: Summary has no image and `screenshot` gives no reason to omit one. If the change alters a screen, Markdown the tool writes for GitHub, or CLI output text, take a screenshot and add it to Summary as `![alt](./<file>.png)`. Otherwise, write the reason in the `screenshot` frontmatter field (`--screenshot` with `--message`)\n')
  })

  it('base が設定のブランチと違うと、終了コード 3 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'develop', '-r', 'acme/demo', '--screenshot', SCREENSHOT, '--dry-run'])
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: base branch must be main (given: develop)\n')
  })

  it.for([{ mode: 'file' }, { mode: 'message' }])('nx のリポジトリで scope が違うタイトルを $mode の形で渡すと、終了コード 3 で終わる', async (row) => {
    installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
    const workspace = await openWorkspace(NX_OPTIONS)
    const title = 'feat(pecot): #12 見本の変更'
    const argv = row.mode === 'file'
      ? ['pr', 'create', writePrFile(workspace, { title }), '--dry-run']
      : ['pr', 'create', '-m', VALID_BODY, '-t', title, '-b', 'main', '-r', 'acme/demo', '--screenshot', SCREENSHOT, '--dry-run']
    const result = await workspace.run(argv)
    expect(result.code).toBe(3)
    expect(lines(result.stderr).filter(line => !line.startsWith('warning: '))).toEqual(['error: PR title scope must be p-w (given: pecot; computed from the tags of the changed nx projects)'])
  })

  it('検証に失敗すると、違反ごとに error の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ branch: 'feat/demo/other' })
    const result = await workspace.run(['pr', 'create', '-m', '本文だけ', '-t', TITLE, '-b', 'develop', '-r', 'acme/demo', '--dry-run'])
    const errors = lines(result.stderr)
    expect(errors).toHaveLength(4)
    expect(errors.every(line => line.startsWith('error: '))).toBe(true)
    expect(errors[0]).toContain('no Issue reference')
    expect(errors[1]).toContain('missing sections')
    expect(errors[2]).toContain('Summary has no image')
    expect(errors[3]).toBe('error: base branch must be main (given: develop)')
  })

  it('検証に失敗すると、PR を作らない', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments([], '本文だけ #12'))
    expect(result.code).toBe(3)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
  })

  it('事前の確認が warning を出すと、終了コード 2 で終わる', async () => {
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: preflight found warnings; fix them before creating a PR\nwarning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)\n')
  })

  it('owner:branch の head のブランチが owner の fork に push 済みなら、その head で PR を作る', async () => {
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    addForkRemote(workspace)
    workspace.git(['push', '-q', 'fork', BRANCH])
    const result = await workspace.run(forkArguments())
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['head']).toBe(FORK_HEAD)
  })

  it('owner:branch の head でも、ブランチ名の末尾の番号の Closes を本文に足す', async () => {
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    addForkRemote(workspace)
    workspace.git(['push', '-q', 'fork', BRANCH])
    await workspace.run(forkArguments())
    expect(String(postedBody(workspace)['body']).endsWith('Closes #12')).toBe(true)
  })

  it.for([
    { name: 'fork に無い', scene: 'absent', expected: 'fork/feat/demo/12 does not exist (not pushed) (fix: git push fork feat/demo/12)' },
    { name: '未 push のコミットがある', scene: 'ahead', expected: '1 unpushed commits (fix: git push fork feat/demo/12)' },
    { name: 'fork とずれた', scene: 'diverged', expected: 'diverged: local is 1 commits ahead, fork/feat/demo/12 is 1 ahead (fix: git pull --rebase fork feat/demo/12, or git push --force-with-lease fork feat/demo/12 if you rewrote pushed commits)' },
  ])('owner:branch の head のブランチが $name と、remote とブランチ名を示した直し方を出して終了コード 2 で止まる', async (row) => {
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    addForkRemote(workspace)
    if (row.scene !== 'absent') workspace.git(['push', '-q', 'fork', BRANCH])
    if (row.scene === 'ahead') commitFile(workspace, 'ahead.txt', 'ahead\n')
    else if (row.scene === 'diverged') workspace.git(['commit', '-q', '--amend', '-m', 'amended'])
    const result = await workspace.run(forkArguments())
    expect(result.code).toBe(2)
    expect(lines(result.stderr)).toContain(`warning: Push Status: ${row.expected}`)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it.for([
    { name: 'fork の remote が無い', host: undefined },
    { name: 'owner の remote が別のホストにしか無い', host: 'github.com' },
  ])('owner:branch の head で $name と、owner と remote の足し方を出して終了コード 2 で止まる', async (row) => {
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    if (row.host !== undefined) addForkRemote(workspace, row.host)
    const result = await workspace.run(forkArguments())
    expect(result.code).toBe(2)
    expect(lines(result.stderr)).toContain(`warning: Push Status: no git remote points to a repository of someone on ${HOST} (fix: git remote add fork https://${HOST}/someone/demo.git)`)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it.for([':feat/demo/12', 'someone:'])('head が %s のように owner かブランチ名を欠くと、終了コード 1 で止まる', async (head) => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments(['--head', head]))
    expect(result).toMatchObject({ code: 1, stderr: `error: invalid head: ${head} (expected: branch or owner:branch)\n` })
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('--head で今と別のブランチを指すと、そのブランチの push を確かめる', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    workspace.git(['branch', 'feat/demo/other'])
    const result = await workspace.run(messageArguments(['--head', 'feat/demo/other']))
    expect(result.code).toBe(2)
    expect(lines(result.stderr)).toContain('warning: Push Status: origin/feat/demo/other does not exist (not pushed) (fix: git push)')
  })

  it('owner が作り先と同じ head は、作り先のリポの remote で push を確かめる', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments(['--head', `acme:${BRANCH}`]))
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['head']).toBe(`acme:${BRANCH}`)
  })

  it.for(STACKED_CREATE_ROWS)('スタックの記録があり、$name ときに事前の確認が remote とのずれを見つけると、Push Status の直し方に $expected を出す', async (row) => {
    const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')]), NOT_EPIC_RULE])
    divergeStacked(workspace, row.scene)
    const result = await workspace.run(stackedArguments())
    expect(result.code).toBe(2)
    expect(pushStatusFixes(result.stderr)).toStrictEqual([row.expected])
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('事前の確認が git のリポジトリでないなどの致命的な場合に当たると、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(messageArguments(['--head', BRANCH]), plain)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: not a git repository\n' })
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it.for([
    { title: 'develop_branch が設定に無い', config: NO_DEVELOP_BRANCH, argv: messageArguments(['--dry-run'], '本文だけ'), expected: 'error: develop_branch is not set\n  set it with:' },
    { title: 'release_branch が設定に無い', config: { developBranch: 'main' }, argv: ['pr', 'create', '-m', '本文だけ', '-t', 'release: v1', '-b', 'main', '--head', 'develop', '-r', 'acme/demo', '--template', 'release', '--dry-run'], expected: 'error: release_branch is not set\n  set it with:' },
  ])('$title と、検証の前に終了コード 1 で終わる', async (row) => {
    const workspace = await pushedBranch({ config: row.config })
    const result = await workspace.run(row.argv)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(row.expected)
    expect(result.stderr).not.toContain('missing sections')
  })

  it('ボードの status を In Review にできないと、warning の行を標準エラーに出す', async () => {
    const empty = graphql('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
    const workspace = await pushedBranch({ github: [CREATED_RULE, empty, NO_WAITING_RULE] })
    const result = await workspace.run(messageArguments(['--no-issue-ref']))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
    expect(result.stderr).toContain('warning: Issue #12 is not on the board; status not updated\n')
  })

  it('ボードの status の更新で GitHub API がエラーを返すと、PR は作ったまま warning の行を標準エラーに出す', async () => {
    const failing = rule({ operation: 'UpdateProjectItemField' }, { status: 500, body: { message: 'Server Error' } })
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, CREATED_RULE, ...IN_REVIEW_RULES.slice(0, 1), failing, NO_WAITING_RULE] })
    const result = await workspace.run(messageArguments())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
    expect(lines(result.stderr).slice(0, 2)).toStrictEqual([
      `created: PR acme/demo ${BRANCH} -> main: ${TITLE}`,
      expect.stringMatching(/^warning: status update of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error'/u),
    ])
    expect(result.stderr).not.toContain('set: Issue #12 status')
  })

  it('PR の作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ github: [rest('POST', '/repos/acme/demo/pulls', 422, { message: 'Validation Failed' })] })
    const result = await workspace.run(messageArguments())
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR creation failed: GitHub API error: 422\n' })
    expect(operationsOf(workspace)).toStrictEqual(['POST /repos/acme/demo/pulls'])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(messageArguments())
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ config: false })
    const result = await workspace.run(messageArguments())
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES, files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(messageArguments(['--project', SECOND_PROJECT]))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES, files: NO_ACTIVE_FILES })
    const result = await workspace.run(messageArguments())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
  })

  it('-m で --repo を省くと、設定のリポジトリが 2 つあっても git remote のリポジトリで PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES, config: { hasSecondRepository: true } })
    const argv = ['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '--screenshot', SCREENSHOT]
    const result = await workspace.run(argv)
    expect(result.code).toBe(0)
    expect(operationsOf(workspace)).toContain('POST /repos/acme/demo/pulls')
  })

  it('-m で --repo を省き、origin のリポが設定に無いと、設定にあるリポを指す別の remote のリポで PR を作る', async () => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const originUrl = workspace.git(['remote', 'get-url', 'origin']).trim()
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    workspace.git(['remote', 'add', 'origin', 'https://ghes.example.com/someone/demo.git'])
    workspace.git(['config', `url.${originUrl}.insteadOf`, 'https://ghes.example.com/someone/demo.git'])
    workspace.git(['fetch', 'origin'])
    const argv = ['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '--screenshot', SCREENSHOT]
    const result = await workspace.run(argv)
    expect(result.code).toBe(0)
    expect(operationsOf(workspace)).toContain('POST /repos/acme/demo/pulls')
  })

  it('--template が default でも release でもないと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', 'test', '-t', 'test', '-b', 'main', '--template', 'invalid'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: --template must be \'default\' or \'release\' (given: invalid)\n' })
  })

  it('ファイルと -m のどちらも渡さないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-43')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: missing arguments\n  usage:\n  pecot pr create <path>\n  pecot pr create --message <body> --title <title> --base <base-branch>\n')
  })

  it.for([
    { title: '-t', argv: ['pr', 'create', '-m', 'x', '-b', 'main'] },
    { title: '-b', argv: ['pr', 'create', '-m', 'x', '-t', 'x'] },
  ])('-m に $title を渡さないと、終了コード 1 で終わる', async (row) => {
    const workspace = await pushedBranch()
    const result = await workspace.run(row.argv)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: --title and --base (base branch) are required with --message\n' })
  })

  it('ファイルと一緒に --screenshot を渡すと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', writePrFile(workspace), '--screenshot', '理由'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: --screenshot is for --message; write the reason in the `screenshot` frontmatter field instead\n$/u)
  })

  it.for([
    { title: 'フロントマターが無い', content: '本文だけ\n', expected: 'error: frontmatter not found (does not start with ---)\n' },
    { title: 'repository が owner/repo の形でない', content: '---\ntitle: "x"\nrepository: "invalid"\nbase: "main"\nhead: ""\ndraft: false\n---\n\n本文\n', expected: 'error: repository is required (e.g. owner/repo)\n' },
  ])('ファイルが次の形だと（$title）、終了コード 1 で終わる', async (row) => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', workspace.scratch('bad.md', row.content)])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(row.expected)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it.for([
    { title: 'git remote が無く --repo も無い', config: {}, repo: [], expected: 'error: specify the repository (--repo <owner/repo>)\n' },
    { title: '--repo が owner/repo の形でない', config: {}, repo: ['-r', 'invalid'], expected: 'error: invalid repository format: invalid (expected: owner/repo)\n' },
  ])('-m で次の形だと（$title）、終了コード 1 で終わる', async (row) => {
    const workspace = await pushedBranch({ config: row.config })
    if (row.repo.length === 0) workspace.git(['remote', 'remove', 'origin'])
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', ...row.repo])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: row.expected })
  })

  it.for([
    { title: 'ファイルの repository', mode: 'file' },
    { title: '-m の --repo', mode: 'message' },
  ])('$title が owner/repo の形でない 3 つ組だと、終了コード 1 で終わり、PR を作らない', async (row) => {
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const argv = row.mode === 'file'
      ? ['pr', 'create', writePrFile(workspace, { repository: 'a/b/c' })]
      : ['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '-r', 'a/b/c']
    const result = await workspace.run(argv)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: invalid repository format: a/b/c (expected: owner/repo)\n' })
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it('PR の作成の応答に html_url が無いと、探す先を示す error の行を最後に出して終了コード 1 で終わる', async () => {
    const created = rest('POST', '/repos/acme/demo/pulls', 201, { number: 21 })
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, created, ...AFTER_CREATE_RULES] })
    const result = await workspace.run(messageArguments())
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(lines(result.stderr).at(-1)).toBe('error: PR was created, but the response has no html_url; find it on GitHub')
    expect(restRequests(workspace, 'POST')).toHaveLength(1)
  })

  it.for([{ title: 'nx.json が無い' }, { title: 'nx.json がディレクトリ' }])('release_type が nx で $title と、scope を検証しない', async (row) => {
    installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
    const nxJson = row.title === 'nx.json が無い' ? { 'keep.txt': 'x\n' } : { 'nx.json/keep.txt': 'x\n' }
    const workspace = await openWorkspace({ ...NX_OPTIONS, commits: [{ message: 'nx', files: nxJson }] })
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', 'feat(pecot): #12 見本の変更', '-b', 'main', '-r', 'acme/demo', '--screenshot', SCREENSHOT, '--dry-run'])
    expect(result.code).toBe(0)
    expect(lines(result.stderr)).toStrictEqual([`dry-run: would create PR acme/demo ${BRANCH} -> main: feat(pecot): #12 見本の変更`, 'dry-run: would set Issue #12 status to In Review'])
  })

  it('head ブランチを決められないと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '-r', 'acme/demo', '--dry-run'], plain)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot determine the head branch\n' })
  })

  describe('スタックした base', () => {
    it('親 PR が開いているときに打つと、base を親ブランチにして PR を作り、新しいスタックに登録する', async (context) => {
      await verifies(context, 'PW-PR-CREATE-50')
      await verifies(context, 'PW-PR-CREATE-51')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, NO_STACK_RULE, CREATED_STACK_RULE] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\nset: Issue #12 status to In Review\nadded: PR #21 to stack #5\n`,
      })
      expect(postedBody(workspace)).toMatchObject({ base: LOWER, head: BRANCH })
      expect(restRequests(workspace, 'POST', STACKS_PATH)).toMatchObject([{ body: { pull_requests: [20, 21] } }])
      expect(restRequests(workspace, 'GET', STACKS_PATH)).toMatchObject([{ query: { pull_request: '20' } }])
    })

    it('親 PR がスタックに入っているときに PR を作ると、そのスタックの一番上に足す', async () => {
      const existing = rule({ method: 'GET', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 19 }, { number: 20 }] }] })
      const added = rule({ method: 'POST', path: `${STACKS_PATH}/5/add`, apiVersion: STACKS_VERSION }, { status: 200, body: { number: 5, pull_requests: [{ number: 19 }, { number: 20 }, { number: 21 }] } })
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, existing, added] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\nset: Issue #12 status to In Review\nadded: PR #21 to stack #5\n`,
      })
      expect(restRequests(workspace, 'POST', `${STACKS_PATH}/5/add`)).toMatchObject([{ body: { pull_requests: [21] } }])
      expect(restRequests(workspace, 'POST', STACKS_PATH)).toStrictEqual([])
    })

    it('親 PR がスタックの一番上に無いと、追加を呼ばずに warning の行を出し、PR を残す', async () => {
      const existing = rule({ method: 'GET', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 20 }, { number: 22 }] }] })
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, existing] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\nset: Issue #12 status to In Review\nwarning: could not register stack: PR #20 is not the top of stack #5 (top: PR #22); PR #21 was not added\n`,
      })
      expect(restRequests(workspace, 'POST', `${STACKS_PATH}/5/add`)).toStrictEqual([])
    })

    it('スタックの記録で --dry-run を付けて打つと、親ブランチを base にした予定の行とスタックへの登録の予定の行を出し、スタックと待つ側を読まない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-50')
      await verifies(context, 'PW-PR-CREATE-63')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')])] })
      const result = await workspace.run(stackedArguments(['--dry-run']))
      expect(result).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: `dry-run: would create PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\ndry-run: would set Issue #12 status to In Review\ndry-run: would add the new PR to the stack of PR #20\n`,
      })
      expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
    })

    it('テンプレを写したファイルの題と本文を埋め、base を空のまま投稿すると、base を親ブランチにして PR を作り、スタックに登録する', async (context) => {
      await verifies(context, 'PW-PR-CREATE-49')
      await verifies(context, 'PW-PR-CREATE-50')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [NOT_EPIC_RULE, lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, NO_STACK_RULE, CREATED_STACK_RULE] })
      const file = workspace.scratch('pr.md', readFileSync(templateFile('pr', 'create'), 'utf8'))
      const [frontmatter = ''] = readFileSync(file, 'utf8').split(/\n---\n/u, 1)
      const filled = frontmatter
        .replace(/^title: ""/mu, () => `title: "${TITLE}"`)
        .replace(/^repository: ""/mu, 'repository: "acme/demo"')
        .replace(/^screenshot: ""/mu, () => `screenshot: "${SCREENSHOT}"`)
      writeFileSync(file, `${filled}\n---\n${VALID_BODY}`)
      const result = await workspace.run(['pr', 'create', file])
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\nset: Issue #12 status to In Review\nadded: PR #21 to stack #5\n`,
      })
      expect(postedBody(workspace)).toMatchObject({ base: LOWER, head: BRANCH })
    })

    it('記録のコミットが今のブランチの履歴に無く、スタックし直し済みとも決まらないと、pr restack を案内せずに、PR を作らずに終了コード 1 で終わる', async () => {
      const workspace = await pushedBranch({ github: [lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES] })
      const tree = workspace.git(['rev-parse', 'HEAD^{tree}']).trim()
      const foreign = workspace.git(['commit-tree', tree, '-m', 'elsewhere']).trim()
      mkdirSync(path.join(workspace.directory, '.pecot', 'state'), { recursive: true })
      writeFileSync(path.join(workspace.directory, '.pecot', 'state', '.pecot-base'), `${LOWER} ${foreign} acme/demo#11\n`)
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 1,
        stdout: '',
        stderr: `error: .pecot-base records ${LOWER} at ${foreign.slice(0, 7)}, which is not in the history of ${BRANCH}\n  run pr create on the branch the record was written for, or pass --head ${BRANCH} to create the PR without the record\n`,
      })
      expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
    })

    it('記録が別のブランチのもので、その親ブランチが今のブランチの履歴に無い位置へ動いていると、pr restack を案内しない', async () => {
      const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES])
      const tree = workspace.git(['rev-parse', 'HEAD^{tree}']).trim()
      const foreign = workspace.git(['commit-tree', tree, '-m', 'elsewhere']).trim()
      writeFileSync(path.join(workspace.directory, stateFile('.pecot-base')), `${LOWER} ${foreign} acme/demo#11\n`)
      pushTo(workspace, `origin/${LOWER}`, LOWER, 'lower-fix.txt', 'fix\n')
      const result = await workspace.run(stackedArguments())
      expect(result.code).toBe(1)
      expect(lines(result.stderr)).toStrictEqual([
        `error: .pecot-base records ${LOWER} at ${foreign.slice(0, 7)}, which is not in the history of ${BRANCH}`,
        `  run pr create on the branch the record was written for, or pass --head ${BRANCH} to create the PR without the record`,
      ])
    })

    it('親 PR がマージされた後に手でスタックし直すと、PR を作らずに、pr restack で記録を書き直す案内を出す', async () => {
      const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('MERGED')]), ...SUBMIT_RULES])
      const recorded = workspace.git(['rev-parse', `origin/${LOWER}`]).trim()
      pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
      workspace.git(['rebase', '-q', '--onto', 'origin/main', recorded])
      workspace.git(['push', '-q', '--force', 'origin', BRANCH])
      const result = await workspace.run(stackedArguments())
      expect(result.code).toBe(1)
      expect(lines(result.stderr)).toStrictEqual([
        `error: .pecot-base records ${LOWER} at ${recorded.slice(0, 7)}, which is not in the history of ${BRANCH}`,
        `  ${BRANCH} is already restacked; rewrite the record with: pecot pr restack`,
        `  run pr create on the branch the record was written for, or pass --head ${BRANCH} to create the PR without the record`,
      ])
      expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
    })

    it('親ブランチに、マージ済みの PR と後から作って閉じた PR があると、マージ済みの方で base を決める', async () => {
      const closed = { ...lowerPullRequest('CLOSED'), number: 30 }
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([closed, lowerPullRequest('MERGED')]), ...SUBMIT_RULES] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
    })

    it('作成の応答が PR 番号を持たないと、スタックへ登録せずに warning の行を出し、URL を出す', async () => {
      const created = rest('POST', '/repos/acme/demo/pulls', 201, { html_url: PULL_URL })
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), created, ...AFTER_CREATE_RULES] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\nset: Issue #12 status to In Review\nwarning: could not register stack: the PR creation response has no PR number\n`,
      })
      expect(restRequests(workspace, 'GET', STACKS_PATH)).toStrictEqual([])
    })

    it('PR を作った後にスタックの読み取りで接続が切れても、warning の行を出し、URL を出す', async () => {
      const dropped = rule({ method: 'GET', path: STACKS_PATH }, { status: 200, disconnect: true })
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, dropped] })
      const result = await workspace.run(stackedArguments())
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${PULL_URL}\n`)
      expect(lines(result.stderr)).toStrictEqual([
        `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}`,
        'set: Issue #12 status to In Review',
        expect.stringMatching(/^warning: could not register stack: \S/u),
      ])
      expect(operationsOf(workspace)).toContain('GetIssueBlockingReferences')
    })

    it('release のテンプレートで PR を作ると、待っている Issue を読まない', async () => {
      const workspace = await pushedBranch({ config: { developBranch: 'develop', releaseBranch: 'main' }, github: [CREATED_RULE] })
      const result = await workspace.run(['pr', 'create', '-m', RELEASE_BODY, '-t', 'release: v0.5.0', '-b', 'main', '-r', 'acme/demo', '--template', 'release'])
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: release: v0.5.0 (release template)\n` })
      expect(operationsOf(workspace)).not.toContain('GetIssueBlockingReferences')
    })

    it('親 PR がマージ済みのときにファイルで打つと、base を開発ブランチにして PR を作り、スタックに登録しない', async () => {
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('MERGED')]), ...SUBMIT_RULES] })
      const result = await workspace.run(['pr', 'create', writePrFile(workspace, { base: LOWER })])
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
      expect(postedBody(workspace)['base']).toBe('main')
      expect(operationsOf(workspace).filter(operation => operation.includes('/stacks'))).toStrictEqual([])
    })

    it('開発ブランチから着手した記録で打つと、記録の無い startable の判定のときと同じ出力になり、判定を読まない', async () => {
      const plain = await pushedBranch({ baseRecord: false, github: [STARTABLE_RULE, ...SUBMIT_RULES] })
      const expected = await plain.run(messageArguments())
      const recorded = await pushedBranch({ files: { [stateFile('.pecot-base')]: `main ${RECORD_SHA}\n` }, github: SUBMIT_RULES })
      const result = await recorded.run(messageArguments())
      expect(result).toStrictEqual(expected)
      expect(operationsOf(plain)).toStrictEqual(['GetIssuePrerequisites', ...operationsOf(recorded)])
    })

    describe('記録が無い作業ディレクトリ', () => {
      it('判定が stackable で親ブランチの上にあると、--dry-run で親ブランチを base にした PR とスタックへの登録を出す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-71')
        const workspace = await openInferredUpper([STACKABLE_RULE, lowerPullRequests([lowerPullRequest('OPEN')])])
        const result = await workspace.run(stackedArguments(['--dry-run']))
        expect(result).toStrictEqual({
          code: 0,
          stdout: '',
          stderr: `dry-run: would create PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\ndry-run: would set Issue #12 status to In Review\ndry-run: would add the new PR to the stack of PR #20\n`,
        })
      })

      it('親ブランチを進めた main の上へスタックし直して force-push した後も、親ブランチを base にする', async () => {
        const workspace = await openInferredUpper([STACKABLE_RULE, lowerPullRequests([lowerPullRequest('OPEN')])])
        pushTo(workspace, 'origin/main', 'main', 'main.txt', 'main\n')
        workspace.git(['checkout', '-q', '-b', 'rebased-lower', `origin/${LOWER}`])
        workspace.git(['rebase', '-q', 'origin/main'])
        workspace.git(['push', '-q', '--force', 'origin', `HEAD:refs/heads/${LOWER}`])
        workspace.git(['checkout', '-q', BRANCH])
        workspace.git(['fetch', '-q', 'origin'])
        const result = await workspace.run(stackedArguments(['--dry-run']))
        expect(result.code).toBe(0)
        expect(lines(result.stderr)[0]).toBe(`dry-run: would create PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}`)
      })

      it('判定が stackable でも、ブランチが開発ブランチから分かれて親ブランチの変更を持たないと、develop_branch を base にする', async (context) => {
        await verifies(context, 'PW-PR-CREATE-72')
        const workspace = await pushedBranch({ baseRecord: false, branches: [{ name: BRANCH }, { name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }], github: [STACKABLE_RULE] })
        const result = await workspace.run(messageArguments(['--dry-run']))
        expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would create PR acme/demo ${BRANCH} -> main: ${TITLE}\ndry-run: would set Issue #12 status to In Review\n` })
      })

      it('判定が blocked なら、--dry-run では warning を出し、develop_branch を base にする', async (context) => {
        await verifies(context, 'PW-PR-CREATE-74')
        const workspace = await pushedBranch({ baseRecord: false, github: [prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })] })
        const result = await workspace.run(messageArguments(['--dry-run']))
        expect(result.code).toBe(0)
        expect(lines(result.stderr)).toStrictEqual([
          expect.stringMatching(/^warning: cannot infer the stacked base: blocked by #11/u),
          `dry-run: would create PR acme/demo ${BRANCH} -> main: ${TITLE}`,
          'dry-run: would set Issue #12 status to In Review',
        ])
      })

      it.for([
        { name: '判定が blocked', rules: [prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })], expected: /^error: cannot infer the stacked base: blocked by #11/u },
        { name: '判定を読む GitHub への接続が切れる', rules: [rule({ operation: 'GetIssuePrerequisites' }, { status: 200, disconnect: true })], expected: /^error: cannot infer the stacked base: /u },
      ])('$name とき、投稿では PR を作らずに error の行を出し、終了コード 1 で終わる', async (row) => {
        const workspace = await pushedBranch({ baseRecord: false, github: row.rules })
        const result = await workspace.run(messageArguments([]))
        expect(result.code).toBe(1)
        expect(result.stderr).toMatch(row.expected)
        expect(operationsOf(workspace)).toStrictEqual(['GetIssuePrerequisites'])
      })
    })

    it.for([
      { name: '--head で別のブランチを指す', record: 'stacked', mode: 'head' },
      { name: 'フロントマターの head で別のブランチを指す', record: 'malformed', mode: 'frontmatter' },
    ])('$name ときは、記録を読まずに今までどおり動く', async (row, context) => {
      await verifies(context, 'PW-PR-CREATE-54')
      const workspace = await pushedBranch({ files: row.record === 'stacked' ? STACKED_RECORD : MALFORMED_RECORD })
      const argv = row.mode === 'head'
        ? messageArguments(['--head', 'feat/demo/other', '--dry-run'])
        : ['pr', 'create', writePrFile(workspace, { head: 'feat/demo/other' }), '--dry-run']
      const result = await workspace.run(argv)
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would create PR acme/demo feat/demo/other -> main: ${TITLE}\n` })
      expect(operationsOf(workspace)).toStrictEqual([])
    })

    it('今のブランチから release のテンプレートで打つと、形の誤った記録があっても読まずに今までどおり動く', async (context) => {
      await verifies(context, 'PW-PR-CREATE-54')
      const workspace = await pushedBranch({ files: MALFORMED_RECORD, config: { developBranch: 'develop', releaseBranch: 'main' } })
      const result = await workspace.run(['pr', 'create', '-m', RELEASE_BODY, '-t', 'release: v0.5.0', '-b', 'main', '-r', 'acme/demo', '--template', 'release', '--dry-run'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would create PR acme/demo ${BRANCH} -> main: release: v0.5.0 (release template)\n` })
      expect(operationsOf(workspace)).toStrictEqual([])
    })

    it.for([
      { name: '親 PR が無い', nodes: [] },
      { name: '親 PR がマージされずに閉じた', nodes: [lowerPullRequest('CLOSED')] },
    ])('$name とき、PR を作らずに直し方を添えた error の行を出し、終了コード 2 で終わる', async (row) => {
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests(row.nodes), ...SUBMIT_RULES] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 2,
        stdout: '',
        stderr: `error: base branch ${LOWER} has no open PR\n  reopen the PR of ${LOWER}, or create a new one, then run pr create again\n`,
      })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    it('親 PR が開いているのに base に開発ブランチを渡すと、PR を作らずに終了コード 3 で終わる', async () => {
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({ code: 3, stdout: '', stderr: `error: base branch must be ${LOWER} while its PR #20 is open (given: main)\n` })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    it.for([
      { name: 'ファイルの投稿', mode: 'file' },
      { name: '-m の投稿', mode: 'message' },
    ])('スタックした base の記録の形が誤っていると、$name でも終了コード 1 で終わる', async (row) => {
      const workspace = await pushedBranch({ files: MALFORMED_RECORD, github: SUBMIT_RULES })
      const argv = row.mode === 'file' ? ['pr', 'create', writePrFile(workspace)] : messageArguments()
      const result = await workspace.run(argv)
      expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    it.for([
      { name: 'スタックの読み取りが 404', rules: [rule({ method: 'GET', path: STACKS_PATH }, { status: 404, body: { message: 'Not Found' } })], expected: /^warning: could not register stack: resource not found: \S+\/stacks\?pull_request=20 Not Found$/u },
      { name: 'スタックの作成が 422', rules: [NO_STACK_RULE, rule({ method: 'POST', path: STACKS_PATH }, { status: 422, body: { message: 'Validation Failed' } })], expected: /^warning: could not register stack: GitHub API error: 422 Validation Failed$/u },
      {
        name: 'スタックへの追加が 409',
        rules: [
          rule({ method: 'GET', path: STACKS_PATH }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 20 }] }] }),
          rule({ method: 'POST', path: `${STACKS_PATH}/5/add` }, { status: 409, body: { message: 'Conflict' } }),
        ],
        expected: /^warning: could not register stack: GitHub API error: 409 Conflict$/u,
      },
      { name: 'スタックの API が版を知らずに 400', rules: [rule({ method: 'GET', path: STACKS_PATH }, { status: 400, body: { message: 'Unsupported API version' } })], expected: /^warning: could not register stack: GitHub API error: 400 Unsupported API version$/u },
    ])('$name とき、PR を作ったまま warning: could not register stack の行を出す', async (row) => {
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, ...row.rules] })
      const result = await workspace.run(stackedArguments())
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${PULL_URL}\n`)
      expect(lines(result.stderr)).toStrictEqual([
        `created: PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}`,
        'set: Issue #12 status to In Review',
        expect.stringMatching(row.expected),
      ])
    })

    it('親 PR がマージ済みのとき、題の scope を記録のコミットから head までの差分で確かめる', async (context) => {
      await verifies(context, 'PW-PR-CREATE-62')
      installNx({
        'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] },
        'text-rules': { root: 'libs/text-rules', tags: ['scope:libs'] },
      })
      const workspace = await openWorkspace({
        commits: [{ message: 'nx', files: { 'nx.json': '{}\n' } }],
        branch: LOWER,
        branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'libs/text-rules/a.txt': 'x\n' } }] }],
        config: { releaseType: 'nx' },
        github: [lowerPullRequests([lowerPullRequest('MERGED')], 2)],
      })
      const sha = workspace.git(['rev-parse', 'HEAD']).trim()
      workspace.git(['checkout', '-q', '-b', BRANCH])
      mkdirSync(path.join(workspace.directory, 'plugins', 'pecot-workflow'), { recursive: true })
      writeFileSync(path.join(workspace.directory, 'plugins', 'pecot-workflow', 'b.txt'), 'y\n')
      workspace.git(['add', '-A', 'plugins'])
      workspace.git(['commit', '-q', '-m', 'own'])
      mkdirSync(path.join(workspace.directory, '.pecot', 'state'), { recursive: true })
      writeFileSync(path.join(workspace.directory, '.pecot', 'state', '.pecot-base'), `${LOWER} ${sha} acme/demo#11\n`)

      const passed = await workspace.run(stackedArguments(['--dry-run'], 'feat(p-w): #12 見本の変更'))
      const planned = [`dry-run: would create PR acme/demo ${BRANCH} -> main: feat(p-w): #12 見本の変更`, 'dry-run: would set Issue #12 status to In Review', '']
      expect(passed).toMatchObject({ code: 0, stderr: planned.join('\n') })
      const failed = await workspace.run(stackedArguments(['--dry-run'], 'feat(libs,p-w): #12 見本の変更'))
      expect(failed).toStrictEqual({ code: 3, stdout: '', stderr: 'error: PR title scope must be p-w (given: libs,p-w; computed from the tags of the changed nx projects)\n' })
    })

    it('親 PR が開いている間は、題の scope を remote の親ブランチから head までの差分で確かめる', async () => {
      installNx({
        'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] },
        'text-rules': { root: 'libs/text-rules', tags: ['scope:libs'] },
      })
      const workspace = await openWorkspace({
        commits: [{ message: 'nx', files: { 'nx.json': '{}\n' } }],
        branch: LOWER,
        branches: [{ name: LOWER, commits: [{ message: 'lower moved on', files: { 'libs/text-rules/a.txt': 'x\n' } }] }],
        config: { releaseType: 'nx' },
        github: [lowerPullRequests([lowerPullRequest('OPEN')], 2)],
      })
      // 記録は着手した時点の親ブランチの先端。その後に親ブランチへ足した libs の変更を、head は rebase で取り込んでいる
      const recorded = workspace.git(['rev-parse', 'HEAD~1']).trim()
      workspace.git(['checkout', '-q', '-b', BRANCH])
      mkdirSync(path.join(workspace.directory, 'plugins', 'pecot-workflow'), { recursive: true })
      writeFileSync(path.join(workspace.directory, 'plugins', 'pecot-workflow', 'b.txt'), 'y\n')
      workspace.git(['add', '-A', 'plugins'])
      workspace.git(['commit', '-q', '-m', 'own'])
      mkdirSync(path.join(workspace.directory, '.pecot', 'state'), { recursive: true })
      writeFileSync(path.join(workspace.directory, '.pecot', 'state', '.pecot-base'), `${LOWER} ${recorded} acme/demo#11\n`)

      const passed = await workspace.run(stackedArguments(['--dry-run'], 'feat(p-w): #12 見本の変更'))
      expect(passed).toMatchObject({ code: 0 })
      const failed = await workspace.run(stackedArguments(['--dry-run'], 'feat(libs,p-w): #12 見本の変更'))
      expect(failed).toStrictEqual({ code: 3, stdout: '', stderr: 'error: PR title scope must be p-w (given: libs,p-w; computed from the tags of the changed nx projects)\n' })
    })
  })

  describe('待っている Issue', () => {
    it('PR を作ると、head の Issue を待つ Issue の列を動かし、moved の行を In Review の行と URL の間に出す', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\nmoved: #13 Blocked -> Ready (stackable on #12)\n`,
      })
    })

    it('選択肢の ID が古くて In Review と待つ Issue の列を書けないと、warning を 2 行出し、ID を読み直す案内を 1 回だけ添える', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES.slice(0, 1), staleOptionUpdate(2), waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true))] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: [
          `created: PR acme/demo ${BRANCH} -> main: ${TITLE}`,
          `warning: status update of Issue #12 failed: ${STALE_OPTION_TEXT}`,
          '  hint: if the board options were recreated, run pecot project activate ghes.example.com_acme_board_acme to read their IDs again',
          `warning: could not move #13: ${STALE_OPTION_TEXT}`,
          '',
        ].join('\n'),
      })
    })

    it('待つ Issue の札が Bot の待ちの結果を持つ Needs Attention なら、列だけを動かし、札を Todo に戻さない', async () => {
      const waiting = { ...waitingTarget(true), label: 'Needs Attention' }
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waiting), commentsRule(13, [botResult('question')]), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review', 'moved: #13 Blocked -> Ready (stackable on #12)'])
    })

    it('着手の跡がある待つ Issue は、列を動かさない', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule({ ...waitingTarget(true), branch: 'feat/demo/13' })] })
      const result = await workspace.run(messageArguments())
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review'])
      expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toHaveLength(1)
    })

    it('待つ Issue の判定に作った PR が出ていなければ、1 回だけ読み直してから動かす', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      useFakeDelays()
      const result = await settleWithFakeDelays(workspace.run(messageArguments()))
      expect(result.stderr).toContain('moved: #13 Blocked -> Ready (stackable on #12)\n')
      expect(operationsOf(workspace).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
    })

    it('読み直しても作った PR が判定に出なければ、board sync で後から直せる旨の warning の行を出して列を動かさない', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(false))] })
      useFakeDelays()
      const result = await settleWithFakeDelays(workspace.run(messageArguments()))
      expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
      expect(lines(result.stderr).at(-1)).toBe('warning: could not confirm that GitHub reflects PR #21 in the readiness of #13; its column was not moved; run pecot board sync later to move it')
      expect(result.stderr).not.toContain('moved:')
    })

    it('待つ Issue があっても、ボードの全項目を読まず、待つ Issue の項目だけを読む', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      await workspace.run(messageArguments())
      expect(operationsOf(workspace)).toStrictEqual(['POST /repos/acme/demo/pulls', 'GetIssueProjectItems', 'UpdateProjectItemField', 'GetIssueBlockingReferences', 'GetIssueBoardItem', 'GetIssuePrerequisites', 'UpdateProjectItemField'])
    })

    it('ボードに載っていない待つ Issue は、判定を読まずに飛ばす', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), boardItemRule([])] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
    })

    it('待つ Issue を全件読めなければ、読めた分を動かして warning の行を出す', async () => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(2), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result.code).toBe(0)
      expect(lines(result.stderr).slice(2)).toStrictEqual(['moved: #13 Blocked -> Ready (stackable on #12)', 'warning: read 1 of 2 Issues waiting for #12; the rest were not moved'])
    })

    it.for([
      { name: '待つ Issue の読み取り', rules: [rule({ operation: 'GetIssueBlockingReferences' }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not read the Issues waiting for #12: GraphQL query error: /u },
      { name: 'ボードの読み取り', rules: [waitingRule(), rule({ operation: 'GetIssueBoardItem' }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not move the Issues waiting for #12: GraphQL query error: /u },
      { name: '待つ Issue の読み取りの接続', rules: [rule({ operation: 'GetIssueBlockingReferences' }, { status: 200, disconnect: true })], expected: /^warning: could not read the Issues waiting for #12: /u },
      { name: '列の書き込みの接続', rules: [waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), rule({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_13' } }, { status: 200, disconnect: true })], expected: /^warning: could not move #13: /u },
      { name: '列の書き込み', rules: [waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), rule({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_13' } }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not move #13: GraphQL query error: /u },
    ])('$name に失敗すると、PR を作ったまま warning の行を出し、終了コード 0 で終わる', async (row) => {
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, ...row.rules] })
      const result = await workspace.run(messageArguments())
      expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
      expect(lines(result.stderr).slice(0, 2)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review'])
      expect(result.stderr.split('\n').slice(2).join('\n')).toMatch(row.expected)
    })

    it('Issue の依存関係に対応しない GHES では、何も出さずに飛ばす', async () => {
      const unsupported = rule({ operation: 'GetIssueBlockingReferences' }, { status: 200, body: { errors: [{ message: 'Field \'blocking\' doesn\'t exist on type \'Issue\'' }] } })
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, unsupported] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
    })

    it.for([
      // eslint-disable-next-line unicorn/no-null -- 応答の形（Issue が無いと null）
      { name: 'Issue', data: { repository: { issue: null } }, path: ['repository', 'issue'] },
      // eslint-disable-next-line unicorn/no-null -- 応答の形（リポが無いと null）
      { name: 'リポジトリ', data: { repository: null }, path: ['repository'] },
    ])('head の番号の $name が PR のリポに無いと、何も出さずに飛ばす', async (row) => {
      const notFound = rule({ operation: 'GetIssueBlockingReferences' }, { status: 200, body: { data: row.data, errors: [{ type: 'NOT_FOUND', path: row.path, message: 'Could not resolve to an Issue with the number of 12.' }] } })
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, notFound] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
    })

    it('待つ Issue が無ければ、ボードを読まない', async () => {
      const workspace = await pushedBranch({ github: SUBMIT_RULES })
      await workspace.run(messageArguments())
      expect(operationsOf(workspace)).toStrictEqual(['POST /repos/acme/demo/pulls', 'GetIssueProjectItems', 'UpdateProjectItemField', 'GetIssueBlockingReferences'])
    })
  })

  describe('MCP の data', () => {
    it('PR を作ると、URL・番号・ブランチ・題と、In Review にした Issue を返す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-11')
      await verifies(context, 'PW-PR-CREATE-13')
      await verifies(context, 'PW-PR-CREATE-23')
      await verifies(context, 'PW-PR-CREATE-25')
      await verifies(context, 'PW-PR-CREATE-26')
      const workspace = await pushedBranch({ github: SUBMIT_RULES })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result.structured).toEqual(CREATED)
      expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toMatchObject([{ variables: { itemId: 'PVTI_1', fieldId: 'PVTSSF_workflow', optionId: 'o5' } }])
      expect(postedBody(workspace)).toMatchObject({ title: TITLE, base: 'main', head: BRANCH, body: VALID_BODY })
    })

    it('head に owner:branch を渡すと、fork のブランチで PR を作り、その head を返す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-80')
      const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
      addForkRemote(workspace)
      workspace.git(['push', '-q', 'fork', BRANCH])
      const result = await callTool(workspace, 'pr_create', { ...MESSAGE_ARGUMENTS, head: FORK_HEAD })
      expect(result.structured).toEqual({ ...CREATED, head: FORK_HEAD })
    })

    it('待っている Issue の列を動かすと、その Issue を moves に返す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-55')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result.structured).toEqual({ ...CREATED, moves: [{ issue: '#13', from: 'Blocked', to: 'Ready', reason: 'stackable on #12' }] })
    })

    it('待つ Issue の 2 件目の列の書き込みが API エラーで失敗すると、成功のまま 1 件目だけを moves に返し、warning を data に入れる', async (context) => {
      await verifies(context, 'PW-COMMON-19')
      const failing = rule({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_14' } }, { status: 500, body: { message: 'boom' } })
      const workspace = await pushedBranch({ github: [...TWO_WAITING_RULES, failing] })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result.isError).toBe(false)
      const { warnings, ...kept } = result.structured
      expect(kept).toEqual({ ...CREATED, moves: [MOVED_13] })
      expect(warnings).toEqual([expect.stringMatching(/^could not move #14: GraphQL query error: Server error '500 Internal Server Error'/u)])
    })

    it('待つ Issue の 2 件目の移動で想定外の例外が出ると、作った PR と動かせた 1 件目を data に残して失敗を返す', async (context) => {
      await verifies(context, 'PW-COMMON-18')
      // 偽サーバの応答では API 以外の例外を起こせない。#14 の書き込みだけを投げる関数に替える。
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 差し替えの中で this を渡して呼ぶ
      const original = ProjectsApi.prototype.updateProjectItemField
      const spy = vi.spyOn(ProjectsApi.prototype, 'updateProjectItemField').mockImplementation(async function (this: Readonly<ProjectsApi>, projectId: string, itemId: string, fieldId: string, optionId: string) {
        if (itemId === 'PVTI_14') throw new PecotError('boom')
        return original.call(this, projectId, itemId, fieldId, optionId)
      })
      context.onTestFinished(() => {
        spy.mockRestore()
      })
      const workspace = await pushedBranch({ github: [...TWO_WAITING_RULES] })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'other' } })
      const { detail, ...kept } = result.structured
      expect(kept).toEqual({ ...CREATED, moves: [MOVED_13], kind: 'other' })
      expect(detail).toBe('boom')
    })

    it('スタック PR を作ると、親 PR とスタックの番号を stack に返す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-50')
      await verifies(context, 'PW-PR-CREATE-51')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, NO_STACK_RULE, CREATED_STACK_RULE] })
      const result = await callTool(workspace, 'pr_create', { ...MESSAGE_ARGUMENTS, base: LOWER })
      expect(result.structured).toEqual({ ...CREATED, base: LOWER, stack: { lower: 20, registered: true, number: 5 } })
    })

    it('PR を作った後に応答の html_url が無いと、作った PR の値を data に残して失敗を返す', async (context) => {
      await verifies(context, 'PW-COMMON-18')
      const created = rest('POST', '/repos/acme/demo/pulls', 201, { number: 21 })
      const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, created, ...AFTER_CREATE_RULES] })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result).toMatchObject({ isError: true, structured: { kind: 'other' } })
      expect(result.structured).toEqual({
        head: BRANCH,
        base: 'main',
        title: TITLE,
        number: 21,
        inReview: 12,
        moves: [],
        kind: 'other',
        detail: 'PR was created, but the response has no html_url; find it on GitHub',
      })
    })

    it('PR を作った後に列の移動が失敗すると、作った PR の値と warning を data に返し、inReview を返さない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-39')
      await verifies(context, 'PW-COMMON-19')
      const failing = rule({ operation: 'UpdateProjectItemField' }, { status: 500, body: { message: 'Server Error' } })
      const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, CREATED_RULE, ...IN_REVIEW_RULES.slice(0, 1), failing, NO_WAITING_RULE] })
      const result = await callTool(workspace, 'pr_create', MESSAGE_ARGUMENTS)
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({
        head: BRANCH,
        base: 'main',
        title: TITLE,
        number: 21,
        moves: [],
        url: PULL_URL,
        warnings: [expect.stringMatching(/^status update of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error'/u)],
      })
    })

    it('本文の検証に失敗すると、違反の文を data.detail に入れて content-invalid を返す', async (context) => {
      await verifies(context, 'PW-COMMON-26')
      await verifies(context, 'PW-PR-CREATE-28')
      await verifies(context, 'PW-PR-CREATE-32')
      await verifies(context, 'PW-PR-CREATE-34')
      await verifies(context, 'PW-PR-CREATE-35')
      const workspace = await pushedBranch({ github: SUBMIT_RULES })
      const result = await callTool(workspace, 'pr_create', { ...MESSAGE_ARGUMENTS, message: '本文だけ #12', base: 'develop' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'content-invalid' } })
      expect(result.structured).toEqual({
        kind: 'content-invalid',
        detail: 'missing sections: ## Summary, ## Changes, ## Verified, ## Risks\nbase branch must be main (given: develop)',
      })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    describe('MCP の呼び出し', () => {
      it('file を渡すと、フロントマターの値で PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-09')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題', head: BRANCH })
        const result = await createTool(workspace, { file })
        expect(result.structured).toEqual({ ...CREATED, title: 'feat(demo): #12 ファイルの題' })
        expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題', head: BRANCH, base: 'main', draft: false })
      })

      it('file と message を一緒に渡すと、message の本文を使わずにファイルから PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-10')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題' })
        const result = await createTool(workspace, { file, message: '別の本文 #12', title: '別の題', base: 'main' })
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題' })
        expect(postedBody(workspace)['body']).not.toContain('別の本文')
      })

      it('message で repo を省くと、設定のリポジトリが 1 つならそのリポジトリに PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-12')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const result = await createTool(workspace, MESSAGE_WITHOUT_REPOSITORY)
        expect(result.isError).toBe(false)
        expect(restRequests(workspace, 'POST', '/repos/acme/demo/pulls')).toHaveLength(1)
      })

      it('draft を付けて message で呼ぶと、ドラフトの PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-14')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, draft: true })
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)['draft']).toBe(true)
      })

      it.for([{ mode: 'file' }, { mode: 'message' }])('$mode の形で head ブランチ名の末尾に番号があると、本文にその番号の Closes を足す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-15')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const body = BODY_WITHOUT_REFERENCE
        const arguments_ = row.mode === 'file' ? { file: writePrFile(workspace, { body }) } : { ...MESSAGE_ARGUMENTS, message: body }
        const result = await createTool(workspace, arguments_)
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)['body']).toBe(`${body.trimEnd()}\n\nCloses #12`)
      })

      it('file で作るとき末尾の番号の Issue が Epic だと、Closes を足さずに warnings へ入れる', async (context) => {
        await verifies(context, 'PW-PR-CREATE-16')
        await verifies(context, 'PW-PR-CREATE-17')
        const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
        const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
        const result = await createTool(workspace, { file })
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
        expect(result.structured['warnings']).toEqual(['Issue #12 at the end of the branch is an Epic; Closes not added'])
      })

      it('no_issue_ref を付けると、Closes を足さず、Issue の参照の確認もしない', async (context) => {
        await verifies(context, 'PW-PR-CREATE-18')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...AFTER_CREATE_RULES] })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, message: BODY_WITHOUT_REFERENCE, no_issue_ref: true })
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)['body']).toBe(BODY_WITHOUT_REFERENCE)
        expect(operationsOf(workspace)).not.toContain('GetIssueKind')
      })

      it('template に release を渡すと、リリース PR として検証する', async (context) => {
        await verifies(context, 'PW-PR-CREATE-19')
        const workspace = await pushedBranch({ config: { developBranch: 'develop', releaseBranch: 'main' } })
        const release = { title: 'release: v0.5.0', head: 'develop', repo: 'acme/demo', template: 'release' }
        const missing = await createTool(workspace, { ...release, message: '本文だけ', base: 'main' })
        expect(missing.structured['kind']).toBe('content-invalid')
        expect(missing.structured['detail']).toMatch(/^missing sections: ## Summary, ## Changes, ## Migration, ## Verified$/u)
        const wrongBase = await createTool(workspace, { ...release, message: RELEASE_BODY, base: 'staging' })
        expect(wrongBase.structured).toEqual({ kind: 'content-invalid', detail: 'release PR base branch must be main (given: staging)' })
      })

      it('PR を作る前に pr_check と同じ確認をし、引っかかりを warnings に入れて kind が preflight-failed の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-20')
        await verifies(context, 'PW-PR-CREATE-36')
        const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.isError).toBe(true)
        expect(result.structured['kind']).toBe('preflight-failed')
        expect(result.structured['warnings']).toEqual(['Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)'])
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it.for([
        { name: '本文に Issue の参照 #N が無い', id: 'PW-PR-CREATE-27', arguments_: { ...MESSAGE_ARGUMENTS, message: BODY_WITHOUT_REFERENCE, head: 'feat/demo/other' }, detail: 'PR body has no Issue reference `#N` (use `no_issue_ref: true` for a PR not tied to an Issue)' },
        { name: '使えない記法がある', id: 'PW-PR-CREATE-30', arguments_: { ...MESSAGE_ARGUMENTS, message: `${VALID_BODY}\n- [ ] 残タスク\n` }, detail: 'disallowed syntax: checkbox syntax (- [ ] / 1. [ ]) is not allowed' },
        { name: 'base が設定のブランチと違う', id: 'PW-PR-CREATE-32', arguments_: { ...MESSAGE_ARGUMENTS, base: 'develop' }, detail: 'base branch must be main (given: develop)' },
      ])('$name と、PR を作らずに kind が content-invalid の失敗を返す', async (row, context) => {
        await verifies(context, row.id)
        const workspace = await openWorkspace({ branch: 'feat/demo/other', branches: [{ name: BRANCH }] })
        workspace.git(['checkout', '-q', BRANCH])
        const result = await createTool(workspace, row.arguments_)
        expect(result.structured).toEqual({ kind: 'content-invalid', detail: row.detail })
      })

      it('Summary に画像も screenshot の理由も無いと、kind が content-invalid の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-31')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, { message: VALID_BODY, title: TITLE, base: 'main', repo: 'acme/demo' })
        expect(result.structured['kind']).toBe('content-invalid')
        expect(result.structured['detail']).toMatch(/^Summary has no image and `screenshot` gives no reason to omit one\./u)
      })

      it.for([{ mode: 'file' }, { mode: 'message' }])('nx のリポジトリで scope が違うタイトルを $mode の形で渡すと、kind が content-invalid の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-33')
        installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
        const workspace = await openWorkspace(NX_OPTIONS)
        const title = 'feat(pecot): #12 見本の変更'
        const arguments_ = row.mode === 'file' ? { file: writePrFile(workspace, { title }) } : { ...MESSAGE_ARGUMENTS, title }
        const result = await createTool(workspace, arguments_)
        expect(result.structured).toMatchObject({ kind: 'content-invalid', detail: 'PR title scope must be p-w (given: pecot; computed from the tags of the changed nx projects)' })
      })

      it('owner:branch の head でも、ブランチ名の末尾の番号の Closes を本文に足す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-84')
        const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
        addForkRemote(workspace)
        workspace.git(['push', '-q', 'fork', BRANCH])
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, message: BODY_WITHOUT_REFERENCE, head: FORK_HEAD })
        expect(result.isError).toBe(false)
        expect(String(postedBody(workspace)['body']).endsWith('Closes #12')).toBe(true)
      })

      it.for([
        { name: 'fork に無い', scene: 'absent', expected: 'fork/feat/demo/12 does not exist (not pushed) (fix: git push fork feat/demo/12)' },
        { name: '未 push のコミットがある', scene: 'ahead', expected: '1 unpushed commits (fix: git push fork feat/demo/12)' },
        { name: 'fork とずれた', scene: 'diverged', expected: 'diverged: local is 1 commits ahead, fork/feat/demo/12 is 1 ahead (fix: git pull --rebase fork feat/demo/12, or git push --force-with-lease fork feat/demo/12 if you rewrote pushed commits)' },
      ])('owner:branch の head のブランチが $name と、直し方を warnings に入れて kind が preflight-failed の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-81')
        const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
        addForkRemote(workspace)
        if (row.scene !== 'absent') workspace.git(['push', '-q', 'fork', BRANCH])
        if (row.scene === 'ahead') commitFile(workspace, 'ahead.txt', 'ahead\n')
        else if (row.scene === 'diverged') workspace.git(['commit', '-q', '--amend', '-m', 'amended'])
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, message: BODY_WITHOUT_REFERENCE, head: FORK_HEAD })
        expect(result.structured['kind']).toBe('preflight-failed')
        expect(result.structured['warnings']).toContain(`Push Status: ${row.expected}`)
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it.for([
        { name: 'fork の remote が無い', host: undefined },
        { name: 'owner の remote が別のホストにしか無い', host: 'github.com' },
      ])('owner:branch の head で $name と、git remote add の直し方を warnings に入れて kind が preflight-failed の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-82')
        const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
        if (row.host !== undefined) addForkRemote(workspace, row.host)
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, message: BODY_WITHOUT_REFERENCE, head: FORK_HEAD })
        expect(result.structured['kind']).toBe('preflight-failed')
        expect(result.structured['warnings']).toContain(`Push Status: no git remote points to a repository of someone on ${HOST} (fix: git remote add fork https://${HOST}/someone/demo.git)`)
      })

      it.for([':feat/demo/12', 'someone:'])('head が %s のように owner かブランチ名を欠くと、PR を作らずに kind が invalid-input の失敗を返す', async (head, context) => {
        await verifies(context, 'PW-PR-CREATE-83')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, head })
        expect(result.structured).toEqual({ kind: 'invalid-input', detail: `invalid head: ${head} (expected: branch or owner:branch)` })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it('head で今と別のブランチを指すと、そのブランチの push を確かめる', async (context) => {
        await verifies(context, 'PW-PR-CREATE-85')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        workspace.git(['branch', 'feat/demo/other'])
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, head: 'feat/demo/other' })
        expect(result.structured['kind']).toBe('preflight-failed')
        expect(result.structured['warnings']).toContain('Push Status: origin/feat/demo/other does not exist (not pushed) (fix: git push)')
      })

      it('owner が作り先と同じ head は、作り先のリポの remote で push を確かめる', async (context) => {
        await verifies(context, 'PW-PR-CREATE-86')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, head: `acme:${BRANCH}` })
        expect(result.isError).toBe(false)
        expect(postedBody(workspace)['head']).toBe(`acme:${BRANCH}`)
      })

      it.for(STACKED_CREATE_ROWS)('スタックの記録があり、$name ときに事前の確認が remote とのずれを見つけると、Push Status の直し方を pr_check と同じに決める', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-69')
        const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')]), NOT_EPIC_RULE])
        divergeStacked(workspace, row.scene)
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.structured['kind']).toBe('preflight-failed')
        expect(toolFixes(result)).toStrictEqual([row.expected === 'pecot pr restack' ? 'pr_restack' : row.expected])
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it('事前の確認が git のリポジトリでないなどの致命的な場合に当たると、PR を作らずに失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-37')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const plain = mkdirIn(workspace, 'plain')
        const result = await callToolAt(plain, 'pr_create', { ...MESSAGE_ARGUMENTS, head: BRANCH })
        expect(result.structured).toEqual({ kind: 'git-unresolved', detail: 'not a git repository' })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it.for([
        { title: 'develop_branch が設定に無い', config: NO_DEVELOP_BRANCH, arguments_: { ...MESSAGE_ARGUMENTS, message: '本文だけ' }, expected: /^develop_branch is not set\n {2}set it with:/u },
        { title: 'release_branch が設定に無い', config: { developBranch: 'main' }, arguments_: { message: '本文だけ', title: 'release: v1', base: 'main', head: 'develop', repo: 'acme/demo', template: 'release' }, expected: /^release_branch is not set\n {2}set it with:/u },
      ])('$title と、検証の前に kind が repo-setting-missing の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-38')
        const workspace = await pushedBranch({ config: row.config })
        const result = await createTool(workspace, row.arguments_)
        expect(result.structured['kind']).toBe('repo-setting-missing')
        expect(result.structured['detail']).toMatch(row.expected)
        expect(result.structured['detail']).not.toContain('missing sections')
      })

      it('ボードの status を In Review にできないと、warnings に入れて PR を作ったまま成功を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-39')
        const empty = graphql('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
        const workspace = await pushedBranch({ github: [CREATED_RULE, empty, NO_WAITING_RULE] })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, no_issue_ref: true })
        expect(result.isError).toBe(false)
        expect(result.structured['url']).toBe(PULL_URL)
        expect(result.structured['warnings']).toEqual(['Issue #12 is not on the board; status not updated'])
      })

      it('PR の作成で GitHub API がエラーを返すと、失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-40')
        const workspace = await pushedBranch({ github: [rest('POST', '/repos/acme/demo/pulls', 422, { message: 'Validation Failed' })] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.isError).toBe(true)
        expect(result.structured['kind']).toBe('github-api')
        expect(result.structured['detail']).toBe('PR creation failed: GitHub API error: 422')
      })

      it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を入れて、kind が no-active-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-41')
        const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      })

      it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-75')
        const workspace = await pushedBranch({ config: false })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: (none)' })
      })

      it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-76')
        const workspace = await pushedBranch({ github: SUBMIT_RULES, files: ambiguousWorkspaceFiles() })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, project: SECOND_PROJECT })
        expect(result.structured).toEqual(CREATED)
      })

      it('message で repo を省き、origin のリポが設定に無いと、設定にあるリポを指す別の remote のリポに PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-77')
        const workspace = await pushedBranch({ github: SUBMIT_RULES })
        const originUrl = workspace.git(['remote', 'get-url', 'origin']).trim()
        workspace.git(['remote', 'rename', 'origin', 'upstream'])
        workspace.git(['remote', 'add', 'origin', 'https://ghes.example.com/someone/demo.git'])
        workspace.git(['config', `url.${originUrl}.insteadOf`, 'https://ghes.example.com/someone/demo.git'])
        workspace.git(['fetch', 'origin'])
        const result = await createTool(workspace, MESSAGE_WITHOUT_REPOSITORY)
        expect(result.isError).toBe(false)
        expect(operationsOf(workspace)).toContain('POST /repos/acme/demo/pulls')
      })

      it('template が default でも release でもないと、kind が invalid-input の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-42')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, { message: 'test', title: 'test', base: 'main', template: 'invalid' })
        expect(result.isError).toBe(true)
        expect(result.structured['kind']).toBe('invalid-input')
      })

      it('file と message のどちらも渡さないと、kind が invalid-input の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-43')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, {})
        expect(result.structured['kind']).toBe('invalid-input')
        expect(result.structured['detail']).toMatch(/^missing arguments\n/u)
      })

      it.for([
        { title: 'title', arguments_: { message: 'x', base: 'main' } },
        { title: 'base', arguments_: { message: 'x', title: 'x' } },
      ])('message に $title を渡さないと、kind が invalid-input の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-44')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, row.arguments_)
        expect(result.structured).toEqual({ kind: 'invalid-input', detail: 'title and base (base branch) are required with message' })
      })

      it('file と一緒に screenshot を渡すと、kind が invalid-input の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-45')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, { file: writePrFile(workspace), screenshot: '理由' })
        expect(result.structured['kind']).toBe('invalid-input')
        expect(result.structured['detail']).toMatch(/^screenshot is for message; write the reason in the `screenshot` frontmatter field instead$/u)
      })

      it.for([
        { title: 'フロントマターが無い', content: '本文だけ\n', detail: 'frontmatter not found (does not start with ---)' },
        { title: 'repository が owner/repo の形でない', content: '---\ntitle: "x"\nrepository: "invalid"\nbase: "main"\nhead: ""\ndraft: false\n---\n\n本文\n', detail: 'repository is required (e.g. owner/repo)' },
      ])('ファイルが次の形だと（$title）、PR を作らずに kind が content-invalid の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-46')
        const workspace = await pushedBranch()
        const result = await createTool(workspace, { file: workspace.scratch('bad.md', row.content) })
        expect(result.structured).toEqual({ kind: 'content-invalid', detail: row.detail })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it.for([
        { title: 'git remote が無く repo も無い', repo: undefined, detail: 'specify the repository (repo: <owner/repo>)' },
        { title: 'repo が owner/repo の形でない', repo: 'invalid', detail: 'invalid repository format: invalid (expected: owner/repo)' },
      ])('message で次の形だと（$title）、kind が invalid-input の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-47')
        const workspace = await pushedBranch()
        if (row.repo === undefined) workspace.git(['remote', 'remove', 'origin'])
        const result = await createTool(workspace, { message: VALID_BODY, title: TITLE, base: 'main', ...row.repo !== undefined && { repo: row.repo } })
        expect(result.structured).toEqual({ kind: 'invalid-input', detail: row.detail })
      })

      it('message で repo を省くと、設定のリポジトリが 2 つあっても git remote のリポジトリで PR を作る', async (context) => {
        await verifies(context, 'PW-PR-CREATE-47')
        const workspace = await pushedBranch({ github: SUBMIT_RULES, config: { hasSecondRepository: true } })
        const result = await createTool(workspace, MESSAGE_WITHOUT_REPOSITORY)
        expect(result.isError).toBe(false)
        expect(operationsOf(workspace)).toContain('POST /repos/acme/demo/pulls')
      })

      it('head ブランチを決められないと、kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-48')
        const workspace = await pushedBranch()
        const plain = mkdirIn(workspace, 'plain')
        const result = await callToolAt(plain, 'pr_create', MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual({ kind: 'git-unresolved', detail: 'cannot determine the head branch' })
      })

      it('親 PR がスタックに入っているときに PR を作ると、そのスタックの一番上に足し、stack に返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-51')
        const existing = rule({ method: 'GET', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 19 }, { number: 20 }] }] })
        const added = rule({ method: 'POST', path: `${STACKS_PATH}/5/add`, apiVersion: STACKS_VERSION }, { status: 200, body: { number: 5, pull_requests: [{ number: 19 }, { number: 20 }, { number: 21 }] } })
        const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, existing, added] })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.structured).toEqual({ ...CREATED, base: LOWER, stack: { lower: 20, registered: true, number: 5 } })
        expect(restRequests(workspace, 'POST', `${STACKS_PATH}/5/add`)).toMatchObject([{ body: { pull_requests: [21] } }])
      })

      it('親 PR がマージ済みのときに file で呼ぶと、base を開発ブランチにして PR を作り、スタックに登録しない', async (context) => {
        await verifies(context, 'PW-PR-CREATE-52')
        const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('MERGED')]), ...SUBMIT_RULES] })
        const result = await createTool(workspace, { file: writePrFile(workspace, { base: LOWER }) })
        expect(result.structured).toEqual(CREATED)
        expect(operationsOf(workspace).filter(operation => operation.includes('/stacks'))).toStrictEqual([])
      })

      it('開発ブランチから着手した記録で呼ぶと、記録の無い startable の判定のときと同じ結果になり、判定を読まない', async (context) => {
        await verifies(context, 'PW-PR-CREATE-53')
        await verifies(context, 'PW-PR-CREATE-72')
        const plain = await pushedBranch({ baseRecord: false, github: [STARTABLE_RULE, ...SUBMIT_RULES] })
        const expected = await createTool(plain, MESSAGE_ARGUMENTS)
        const recorded = await pushedBranch({ files: { [stateFile('.pecot-base')]: `main ${RECORD_SHA}\n` }, github: SUBMIT_RULES })
        const result = await createTool(recorded, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual(expected.structured)
        expect(result.structured).toEqual(CREATED)
        expect(operationsOf(plain)).toStrictEqual(['GetIssuePrerequisites', ...operationsOf(recorded)])
      })

      it('待つ Issue の判定に作った PR が出ていなければ、1 回だけ読み直してから動かし、moves に入れる', async (context) => {
        await verifies(context, 'PW-PR-CREATE-55')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
        useFakeDelays()
        const result = await settleWithFakeDelays(createTool(workspace, MESSAGE_ARGUMENTS))
        expect(result.structured['moves']).toEqual([MOVED_13])
        expect(operationsOf(workspace).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
      })

      it('着手の跡がある待つ Issue は、列を動かさない', async (context) => {
        await verifies(context, 'PW-PR-CREATE-56')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule({ ...waitingTarget(true), branch: 'feat/demo/13' })] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual(CREATED)
        expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toHaveLength(1)
      })

      it.for([
        { name: '親 PR が無い', nodes: [] },
        { name: '親 PR がマージされずに閉じた', nodes: [lowerPullRequest('CLOSED')] },
      ])('$name とき、PR を作らずに kind が pr-state の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-57')
        const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests(row.nodes), ...SUBMIT_RULES] })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.structured).toEqual({ kind: 'pr-state', detail: `base branch ${LOWER} has no open PR\n  reopen the PR of ${LOWER}, or create a new one, then call pr_create again` })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it('親 PR が開いているのに base に開発ブランチを渡すと、PR を作らずに kind が content-invalid の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-58')
        const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual({ kind: 'content-invalid', detail: `base branch must be ${LOWER} while its PR #20 is open (given: main)` })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it.for([
        { name: 'file の投稿', mode: 'file' },
        { name: 'message の投稿', mode: 'message' },
      ])('スタックした base の記録の形が誤っていると、$name でも kind が content-invalid の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-59')
        const workspace = await pushedBranch({ files: MALFORMED_RECORD, github: SUBMIT_RULES })
        const arguments_ = row.mode === 'file' ? { file: writePrFile(workspace) } : MESSAGE_ARGUMENTS
        const result = await createTool(workspace, arguments_)
        expect(result.structured).toEqual({ kind: 'content-invalid', detail: '.pecot-base is malformed: garbage' })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
        expect(workspace.exists('.pecot/tmp/output')).toBe(false)
      })

      it.for([
        { name: '親 PR がスタックの一番上に無い', rules: [rule({ method: 'GET', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 20 }, { number: 22 }] }] })], expected: /^could not register stack: PR #20 is not the top of stack #5 \(top: PR #22\); PR #21 was not added$/u },
        { name: 'スタックの作成が 422', rules: [NO_STACK_RULE, rule({ method: 'POST', path: STACKS_PATH }, { status: 422, body: { message: 'Validation Failed' } })], expected: /^could not register stack: GitHub API error: 422 Validation Failed$/u },
        { name: 'スタックの読み取りで接続が切れる', rules: [rule({ method: 'GET', path: STACKS_PATH }, { status: 200, disconnect: true })], expected: /^could not register stack: \S/u },
      ])('$name とき、PR を残して warnings に入れる', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-60')
        const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, ...row.rules] })
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.isError).toBe(false)
        expect(result.structured['url']).toBe(PULL_URL)
        expect(result.structured['warnings']).toEqual([expect.stringMatching(row.expected)])
      })

      it('選択肢の ID が古くて In Review と待つ Issue の列を書けないと、warnings を 2 件入れ、ID を読み直す project_activate の案内を 1 回だけ添える', async (context) => {
        await verifies(context, 'PW-PR-CREATE-39')
        await verifies(context, 'PW-PR-CREATE-61')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES.slice(0, 1), staleOptionUpdate(2), waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true))] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual([
          `status update of Issue #12 failed: ${STALE_OPTION_TEXT}\n  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again`,
          `could not move #13: ${STALE_OPTION_TEXT}`,
        ])
      })

      it('読み直しても作った PR が判定に出なければ、board_sync で後から直せる旨を warnings に入れて列を動かさない', async (context) => {
        await verifies(context, 'PW-PR-CREATE-61')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(false))] })
        useFakeDelays()
        const result = await settleWithFakeDelays(createTool(workspace, MESSAGE_ARGUMENTS))
        expect(result.isError).toBe(false)
        expect(result.structured['moves']).toEqual([])
        expect(result.structured['warnings']).toEqual(['could not confirm that GitHub reflects PR #21 in the readiness of #13; its column was not moved; call board_sync later to move it'])
      })

      it.for([
        { name: '待つ Issue を全件読めない', rules: [waitingRule(2), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE], expected: /^read 1 of 2 Issues waiting for #12; the rest were not moved$/u },
        { name: '待つ Issue の読み取りに失敗する', rules: [rule({ operation: 'GetIssueBlockingReferences' }, { status: 500, body: { message: 'boom' } })], expected: /^could not read the Issues waiting for #12: GraphQL query error: /u },
        { name: '列の書き込みの接続が切れる', rules: [waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), rule({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_13' } }, { status: 200, disconnect: true })], expected: /^could not move #13: /u },
      ])('$name と、PR を作ったまま warnings に入れて成功を返す', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-61')
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, ...row.rules] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.isError).toBe(false)
        expect(result.structured['url']).toBe(PULL_URL)
        expect(result.structured['warnings']).toEqual([expect.stringMatching(row.expected)])
      })

      it('記録のコミットが今のブランチの履歴に無く、スタックし直し済みとも決まらないと、pr_restack を案内せずに、PR を作らずに kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-CREATE-65')
        await verifies(context, 'PW-PR-CREATE-70')
        const workspace = await pushedBranch({ github: [lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES] })
        const tree = workspace.git(['rev-parse', 'HEAD^{tree}']).trim()
        const foreign = workspace.git(['commit-tree', tree, '-m', 'elsewhere']).trim()
        mkdirSync(path.join(workspace.directory, '.pecot', 'state'), { recursive: true })
        writeFileSync(path.join(workspace.directory, '.pecot', 'state', '.pecot-base'), `${LOWER} ${foreign} acme/demo#11\n`)
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.structured).toEqual({
          kind: 'git-unresolved',
          detail: `.pecot-base records ${LOWER} at ${foreign.slice(0, 7)}, which is not in the history of ${BRANCH}\n  call pr_create on the branch the record was written for, or pass head: "${BRANCH}" to create the PR without the record`,
        })
        expect(restRequests(workspace, 'POST')).toStrictEqual([])
      })

      it('親 PR がマージされた後に手でスタックし直すと、PR を作らずに、pr_restack で記録を書き直す案内を detail に入れる', async (context) => {
        await verifies(context, 'PW-PR-CREATE-65')
        await verifies(context, 'PW-PR-CREATE-70')
        const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('MERGED')]), ...SUBMIT_RULES])
        const recorded = workspace.git(['rev-parse', `origin/${LOWER}`]).trim()
        pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
        workspace.git(['rebase', '-q', '--onto', 'origin/main', recorded])
        workspace.git(['push', '-q', '--force', 'origin', BRANCH])
        const result = await createTool(workspace, { ...MESSAGE_ARGUMENTS, base: LOWER })
        expect(result.structured['kind']).toBe('git-unresolved')
        expect(String(result.structured['detail']).split('\n')).toStrictEqual([
          `.pecot-base records ${LOWER} at ${recorded.slice(0, 7)}, which is not in the history of ${BRANCH}`,
          `  ${BRANCH} is already restacked; rewrite the record with: pr_restack`,
          `  call pr_create on the branch the record was written for, or pass head: "${BRANCH}" to create the PR without the record`,
        ])
      })

      it.for([
        // eslint-disable-next-line unicorn/no-null -- 応答の形（Issue が無いと null）
        { name: 'Issue', data: { repository: { issue: null } }, path: ['repository', 'issue'] },
        // eslint-disable-next-line unicorn/no-null -- 応答の形（リポが無いと null）
        { name: 'リポジトリ', data: { repository: null }, path: ['repository'] },
      ])('head の番号の $name が PR のリポに無いと、待っている Issue の確認を何も返さずに飛ばす', async (row, context) => {
        await verifies(context, 'PW-PR-CREATE-64')
        const notFound = rule({ operation: 'GetIssueBlockingReferences' }, { status: 200, body: { data: row.data, errors: [{ type: 'NOT_FOUND', path: row.path, message: 'Could not resolve to an Issue with the number of 12.' }] } })
        const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, notFound] })
        const result = await createTool(workspace, MESSAGE_ARGUMENTS)
        expect(result.structured).toEqual(CREATED)
      })

      describe('記録が無い作業ディレクトリ', () => {
        it.for([
          { name: '判定が blocked', rules: [prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })], expected: /^cannot infer the stacked base: blocked by #11/u },
          { name: '判定を読む GitHub への接続が切れる', rules: [rule({ operation: 'GetIssuePrerequisites' }, { status: 200, disconnect: true })], expected: /^cannot infer the stacked base: /u },
        ])('$name とき、投稿では PR を作らずに失敗を返す', async (row, context) => {
          await verifies(context, 'PW-PR-CREATE-73')
          const workspace = await pushedBranch({ baseRecord: false, github: row.rules })
          const result = await createTool(workspace, MESSAGE_ARGUMENTS)
          expect(result.isError).toBe(true)
          expect(result.structured['detail']).toMatch(row.expected)
          expect(operationsOf(workspace)).toStrictEqual(['GetIssuePrerequisites'])
        })
      })
    })
  })
})

// pr show

const FULL_SAMPLE: PullRequestSample = {
  state: 'OPEN',
  body: '本文の 1 行目\n\nRefs #3\n',
  isDraft: true,
  comments: 2,
  reviews: [{ state: 'APPROVED', author: { login: 'reviewer' } }],
}

const REVIEW_SAMPLE: PullRequestSample = {
  state: 'OPEN',
  reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' }, body: '直してください。', submittedAt: '2026-01-02T03:04:05Z' }],
  threads: [{ isResolved: false, path: 'src/a.ts', line: 10, comments: { nodes: [{ author: { login: 'reviewer' }, body: '名前を直す', createdAt: '2026-01-02T03:04:05Z', url: 'https://github.com/acme/demo/pull/21#discussion_r1' }] } }],
}

describe('pr show', () => {
  it('PR の参照を渡すと、見出し・状態・ブランチ・本文を Markdown で標準出力に出す', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: '本文の 1 行目\n' }))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe([
      '## PR #21 feat(demo): #12 見本の変更',
      '',
      '**State:** OPEN | **Mergeable:** MERGEABLE',
      '',
      '**Branch:** `feat/demo/12` → `main`',
      '',
      '**Closing Issues:**',
      '  - #12 見本の Issue',
      '',
      '---',
      '',
      '本文の 1 行目',
      '',
      '',
    ].join('\n'))
  })

  it.for([
    { title: 'closing issues', body: '本文\n', expected: '**Closing Issues:**\n  - #12 見本の Issue\n' },
    { title: '本文の参照 Issue', body: '本文\n\nRefs #3\n', expected: '**Referenced Issues:**\n  - #3\n' },
  ])('関連 Issue がある PR を読むと、$title を出す', async (row) => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: row.body }))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.stdout).toContain(row.expected)
  })

  it('短い形 N の参照を --repo なしで渡し、remote の URL から owner/repo を読めないと、短い形の案内と理由を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-COMMON-22')
    const workspace = await openWorkspace()
    workspace.git(['remote', 'set-url', 'origin', '/srv/git/demo.git'])
    const result = await workspace.run(['pr', 'show', '21'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe([
      'error: the short form \'N\' needs a base_repo: pass --repo <owner/repo> or use the full form \'owner/repo/N\'',
      '  could not read the repository from the URL of the Git remote origin',
      '',
    ].join('\n'))
  })

  it('レビューがある PR を読むと、レビューごとの author と状態を出す', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.stdout).toContain('**Reviews:**\n  - reviewer: APPROVED\n')
    expect(result.stdout).toContain('**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2')
  })

  it('--reviews を付けて打つと、レビューの本文と行のコメントを足して出す', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout).toContain('### @reviewer (CHANGES_REQUESTED) - 2026-01-02\n\n直してください。\n')
    expect(result.stdout).toContain('### `src/a.ts:10` [Open]\n\n**@reviewer** (2026-01-02) https://github.com/acme/demo/pull/21#discussion_r1:\n> 名前を直す\n')
  })

  it.for([
    { title: 'レビューがあれば ## Reviews の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: 'レビューが無ければ ## Reviews の節を出さない', sample: { state: 'OPEN' }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row) => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(row.sample))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout.includes('## Reviews\n')).toBe(row.isShown)
  })

  it.for([
    { title: '行のコメントがあれば ## Line Comments の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: '行のコメントが無ければ ## Line Comments の節を出さない', sample: { state: 'OPEN', reviews: REVIEW_SAMPLE.reviews ?? [], threads: [] }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row) => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(row.sample))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout.includes('## Line Comments\n')).toBe(row.isShown)
  })

  it('--reviews を付けて打つと、関連 Issue ごとに pecot issue show の案内を足す', async (context) => {
    await verifies(context, 'PW-PR-SHOW-07')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData({ ...REVIEW_SAMPLE, closing: [[12, '見本の Issue'], [13, '別の Issue']] }))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout).toContain('  - #12 見本の Issue\n    → details: issue show acme/demo/12\n')
    expect(result.stdout).toContain('  - #13 別の Issue\n    → details: issue show acme/demo/13\n')
  })

  it('--json を付けて打つと、同じ内容を JSON で標準出力に出す', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toStrictEqual({
      number: 21,
      state: 'OPEN',
      title: TITLE,
      body: '本文の 1 行目\n\nRefs #3\n',
      head_ref: BRANCH,
      base_ref: 'main',
      is_draft: true,
      mergeable: 'MERGEABLE',
      comments: 2,
      closing_issues: [{ number: 12, title: '見本の Issue' }],
      referenced_issues: [{ number: 3, title: '' }],
      reviews: [{ state: 'APPROVED', author: 'reviewer' }],
    })
  })

  it('--json と --reviews を一緒に付けて打つと、JSON にレビューと行のコメントを含める', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--json', '--reviews'])
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviews: [{ state: 'CHANGES_REQUESTED', author: 'reviewer', body: '直してください。', submitted_at: '2026-01-02T03:04:05Z' }],
      review_threads: [{ is_resolved: false, path: 'src/a.ts', line: 10, comments: [{ author: 'reviewer', body: '名前を直す', created_at: '2026-01-02T03:04:05Z', url: 'https://github.com/acme/demo/pull/21#discussion_r1' }] }],
    })
  })

  it.for([
    { title: '--repo（git の remote と違う値）', argv: ['--repo', 'acme/other', 'pr', 'show', '21'], remote: 'origin', expected: 'other' },
    { title: 'origin の remote', argv: ['pr', 'show', '21'], remote: 'origin', expected: 'demo' },
    { title: 'origin が無いときの upstream の remote', argv: ['pr', 'show', '21'], remote: 'upstream', expected: 'other' },
  ])('短い形 N の参照を渡すと、$title で補って読む', async (row) => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))], config: { hasSecondRepository: true } })
    if (row.remote === 'upstream') {
      workspace.git(['remote', 'rename', 'origin', 'upstream'])
      workspace.git(['remote', 'set-url', 'upstream', `https://${HOST}/acme/other.git`])
    }
    const result = await workspace.run(row.argv)
    expect(result.code).toBe(0)
    expect(workspace.requests()).toMatchObject([{ type: 'graphql', operation: 'GetPullRequestSlim', variables: { owner: 'acme', repo: row.expected, number: 21 } }])
  })

  it('PR の参照の形が誤っていると、終了コード 2 で終わる', async () => {
    const workspace = await openWorkspace()
    const result = await workspace.run(['pr', 'show', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))], files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--project', SECOND_PROJECT])
    expect(result.code).toBe(0)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で読む', async () => {
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))], files: NO_ACTIVE_FILES })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.code).toBe(0)
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ github: [rule({ operation: 'GetPullRequestSlim' }, { status: 502, body: { message: 'Bad Gateway' } })] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: GraphQL query error: /u)
  })

  describe('MCP の data', () => {
    it('json を省いても、--json と同じ中身を返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-01')
      await verifies(context, 'PW-PR-SHOW-03')
      await verifies(context, 'PW-PR-SHOW-08')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21' })
      expect(result.structured).toEqual({
        number: 21,
        state: 'OPEN',
        title: TITLE,
        body: '本文の 1 行目\n\nRefs #3\n',
        head_ref: BRANCH,
        base_ref: 'main',
        is_draft: true,
        mergeable: 'MERGEABLE',
        comments: 2,
        closing_issues: [{ number: 12, title: '見本の Issue' }],
        referenced_issues: [{ number: 3, title: '' }],
        reviews: [{ state: 'APPROVED', author: 'reviewer' }],
      })
    })

    it('reviews を付けると、--json --reviews と同じく、レビューの本文と行のコメントも返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-09')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE), { times: 2 })] })
      const json = await workspace.run(['pr', 'show', 'acme/demo/21', '--json', '--reviews'])
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21', reviews: true })
      expect(result.structured).toEqual(JSON.parse(json.stdout))
    })

    it('reviews を付けると、レビューの本文と日時を reviews に、行のコメントを review_threads に入れる', async (context) => {
      await verifies(context, 'PW-PR-SHOW-04')
      await verifies(context, 'PW-PR-SHOW-05')
      await verifies(context, 'PW-PR-SHOW-06')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21', reviews: true })
      expect(result.isError).toBe(false)
      expect(result.structured).toMatchObject({
        reviews: [{ state: 'CHANGES_REQUESTED', author: 'reviewer', body: '直してください。', submitted_at: '2026-01-02T03:04:05Z' }],
        review_threads: [{ is_resolved: false, path: 'src/a.ts', line: 10, comments: [{ author: 'reviewer', body: '名前を直す', created_at: '2026-01-02T03:04:05Z', url: 'https://github.com/acme/demo/pull/21#discussion_r1' }] }],
      })
    })

    it('reviews を付けても、行のコメントが無ければ review_threads を空にする', async (context) => {
      await verifies(context, 'PW-PR-SHOW-06')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData({ state: 'OPEN', reviews: REVIEW_SAMPLE.reviews ?? [], threads: [] }))] })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21', reviews: true })
      expect(result.structured['review_threads']).toEqual([])
    })

    it('関連 Issue がある PR を読むと、closes の Issue を closing_issues に、本文の参照を referenced_issues に入れる', async (context) => {
      await verifies(context, 'PW-PR-SHOW-02')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: '本文\n\nRefs #3\n' }))] })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21' })
      expect(result.structured).toMatchObject({ closing_issues: [{ number: 12, title: '見本の Issue' }], referenced_issues: [{ number: 3, title: '' }] })
    })

    it.for([
      { title: 'repo（git の remote と違う値）', arguments_: { pr_ref: '21', repo: 'acme/other' }, remote: 'origin', expected: 'other' },
      { title: 'origin の remote', arguments_: { pr_ref: '21' }, remote: 'origin', expected: 'demo' },
      { title: 'origin が無いときの upstream の remote', arguments_: { pr_ref: '21' }, remote: 'upstream', expected: 'other' },
    ])('短い形 N の参照を渡すと、$title で補って読む', async (row, context) => {
      await verifies(context, 'PW-PR-SHOW-10')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))], config: { hasSecondRepository: true } })
      if (row.remote === 'upstream') {
        workspace.git(['remote', 'rename', 'origin', 'upstream'])
        workspace.git(['remote', 'set-url', 'upstream', `https://${HOST}/acme/other.git`])
      }
      const result = await callTool(workspace, 'pr_show', row.arguments_)
      expect(result.isError).toBe(false)
      expect(workspace.requests()).toMatchObject([{ type: 'graphql', operation: 'GetPullRequestSlim', variables: { owner: 'acme', repo: row.expected, number: 21 } }])
    })

    it('PR の参照の形が誤っていると、何も読まずに kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-11')
      const workspace = await openWorkspace()
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'not-a-ref' })
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
      expect(result.structured['detail']).toMatch(/^invalid reference: not-a-ref\n/u)
      expect(workspace.requests()).toStrictEqual([])
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を入れて、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-12')
      const workspace = await openWorkspace({ files: ambiguousWorkspaceFiles() })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21' })
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      expect(workspace.requests()).toStrictEqual([])
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-14')
      const workspace = await openWorkspace({ config: false })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21' })
      expect(result.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: (none)' })
      expect(workspace.requests()).toStrictEqual([])
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で読む', async (context) => {
      await verifies(context, 'PW-PR-SHOW-15')
      const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))], files: ambiguousWorkspaceFiles() })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21', project: SECOND_PROJECT })
      expect(result.isError).toBe(false)
      expect(result.structured['number']).toBe(21)
    })

    it('GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-SHOW-13')
      const workspace = await openWorkspace({ github: [rule({ operation: 'GetPullRequestSlim' }, { status: 502, body: { message: 'Bad Gateway' } })] })
      const result = await callTool(workspace, 'pr_show', { pr_ref: 'acme/demo/21' })
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('github-api')
      expect(result.structured['detail']).toMatch(/^GraphQL query error: /u)
    })
  })
})

// pr check

const SECTION_HEADINGS = [
  '=== Git Remote ===',
  '=== Current Branch ===',
  '=== Push Status ===',
  '=== Base Branch ===',
  '=== Git Status ===',
  '=== .gitignore ===',
  '=== Git Exclude ===',
  '=== Commits (vs origin/main) ===',
  '=== Diff Summary (vs origin/main) ===',
  '=== Worktree Info ===',
  '=== Stash List ===',
]

function headingsOf(stdout: string): string[] {
  return stdout.split('\n').filter(line => /^=== .* ===$/u.test(line))
}

function preflight(workspace: Readonly<Workspace>): ReturnType<Workspace['run']> {
  return workspace.run(['pr', 'check', '-D', workspace.directory])
}

function checkTool(workspace: Readonly<Workspace>, extra: Readonly<Record<string, unknown>> = {}): Promise<ToolOutcome> {
  return callTool(workspace, 'pr_check', { directory: workspace.directory, ...extra })
}

// MCP の warnings のうち、diverged の Push Status の文ごとの直し方
function toolFixes(result: Readonly<ToolOutcome>): string[] {
  const warnings = Array.isArray(result.structured['warnings']) ? result.structured['warnings'].map(String) : []
  const prefix = 'Push Status: diverged: '
  return warnings.filter(line => line.startsWith(prefix)).map(line => line.slice(line.lastIndexOf('(fix: ') + '(fix: '.length, -1))
}

function mkdirIn(workspace: Readonly<Workspace>, name: string): string {
  const directory = path.join(workspace.root, name)
  mkdirSync(directory)
  return directory
}

function removeOrigin(workspace: Readonly<Workspace>): string {
  workspace.git(['remote', 'remove', 'origin'])
  return workspace.directory
}

function unbornRepository(workspace: Readonly<Workspace>): string {
  const unborn = mkdirIn(workspace, 'unborn')
  workspace.git(['init', '-q', '-b', 'main'], unborn)
  workspace.git(['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'], unborn)
  return unborn
}

function localRemote(workspace: Readonly<Workspace>): string {
  workspace.git(['remote', 'set-url', 'origin', '/local/path/demo'])
  return workspace.directory
}

describe('pr check', () => {
  it('--directory でリポジトリを指すと、11 の節を決まった順で標準出力に出す', async () => {
    const workspace = await pushedBranch()
    const elsewhere = path.join(workspace.root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = await workspace.run(['pr', 'check', '-D', workspace.directory], elsewhere)
    expect(result.code).toBe(0)
    expect(headingsOf(result.stdout)).toStrictEqual(SECTION_HEADINGS)
    expect(result.stdout).toContain('=== Git Remote ===\ngit@ghes.example.com:acme/demo.git\n')
    expect(result.stdout).toContain(`=== Current Branch ===\n${BRANCH}\n`)
    expect(result.stdout).toContain('=== Push Status ===\nin sync with origin/feat/demo/12\n')
  })

  it('プロセスの cwd がリポジトリの外でも、そのリポジトリの .git/info/exclude を Git Exclude の節に出す', async () => {
    const workspace = await pushedBranch()
    writeFileSync(path.join(workspace.directory, '.git', 'info', 'exclude'), '# 目印の行\n.marker-exclude\n')
    const elsewhere = path.join(workspace.root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = await workspace.run(['pr', 'check', '-D', workspace.directory], elsewhere)
    expect(result.stdout).toContain('=== Git Exclude ===\n# 目印の行\n.marker-exclude\n')
    expect(result.stdout).not.toContain('(no exclude)')
  })

  it('worktree を --directory に渡すと、Worktree Info の節に Is worktree environment: true を出す', async () => {
    const workspace = await pushedBranch()
    const worktree = path.join(workspace.root, 'linked')
    workspace.git(['worktree', 'add', '-q', '-b', 'linked-work', worktree])
    const elsewhere = path.join(workspace.root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = await workspace.run(['pr', 'check', '-D', worktree], elsewhere)
    expect(result.stdout).toContain('Is worktree environment: true\n')
    const main = await preflight(workspace)
    expect(main.stdout).toContain('Is worktree environment: false\n')
  })

  it('.gitignore が UTF-8 として読めないと、.gitignore の節に (read error) を出す', async () => {
    const workspace = await pushedBranch()
    writeFileSync(path.join(workspace.directory, '.gitignore'), Buffer.from([0x61, 0xFF, 0x0A]))
    const result = await preflight(workspace)
    expect(result.stdout).toContain('=== .gitignore ===\n(read error)\n')
  })

  it('warning があるときに打つと、11 の節を全部出す', async () => {
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(headingsOf(result.stdout)).toStrictEqual(SECTION_HEADINGS)
  })

  it.for([{ remote: 'origin' }, { remote: 'upstream' }])('remote が $remote だけだと、Base Branch の節に <remote>/<develop_branch> を出す', async (row) => {
    const workspace = await pushedBranch()
    if (row.remote !== 'origin') workspace.git(['remote', 'rename', 'origin', row.remote])
    const result = await preflight(workspace)
    expect(result.stdout).toContain(`=== Base Branch ===\n${row.remote}/main\n`)
    expect(result.stdout).toContain(`=== Push Status ===\nin sync with ${row.remote}/${BRANCH}\n`)
  })

  it.for([
    { name: '親ブランチが remote にある', branches: [BRANCH, LOWER], expected: `origin/${LOWER}` },
    { name: '親ブランチが remote に無い', branches: [BRANCH], expected: 'origin/main' },
    { name: '親ブランチが remote から消え、手元に追跡参照が残っている', branches: [BRANCH, LOWER], remoteChange: 'delete', expected: 'origin/main' },
    { name: '親ブランチの追跡参照があり、remote に届かない', branches: [BRANCH, LOWER], remoteChange: 'unreachable', expected: `origin/${LOWER}` },
  ])('スタックした base の記録があり、$name ときに打つと、Base Branch の節に $expected を出す', async (row) => {
    const workspace = await pushedBranch({ branches: row.branches.map(name => ({ name })), files: STACKED_RECORD })
    if (row.remoteChange === 'delete') workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    else if (row.remoteChange === 'unreachable') {
      const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
      renameSync(bare, `${bare}.moved`)
    }
    const result = await preflight(workspace)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`=== Base Branch ===\n${row.expected}\n`)
    expect(result.stdout).toContain(`=== Commits (vs ${row.expected}) ===\n`)
  })

  it('スタックした base の記録があり、親ブランチが remote にあって手元に追跡参照が無いと、開発ブランチと比べて git fetch を案内する', async () => {
    const workspace = await pushedBranch({ branches: [{ name: BRANCH }, { name: LOWER }], files: STACKED_RECORD })
    workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
    const result = await preflight(workspace)
    expect(result.stdout).toContain('=== Base Branch ===\norigin/main\n')
    expect(lines(result.stderr)).toStrictEqual([
      `warning: base branch ${LOWER} is on origin, but origin/${LOWER} is not fetched; compared with the develop branch`,
      `  run: git fetch origin ${LOWER}`,
      'count: preflight warnings: 0',
    ])
  })

  it('スタックした base の記録の形が誤っていると、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ files: MALFORMED_RECORD })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
  })

  it('打つと、count: preflight warnings の行を標準エラーに出す', async () => {
    const workspace = await pushedBranch()
    const result = await preflight(workspace)
    expect(result.stderr).toBe('count: preflight warnings: 0\n')
  })

  it('warning があるときに打つと、warning ごとに warning の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual([
      'count: preflight warnings: 2',
      'warning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)',
      'warning: Git Status: modified or untracked files (fix: commit)',
    ])
  })

  it('常に、リポジトリとファイルを書き換えない', async () => {
    const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const snapshot = (): unknown => ({
      files: filesOf(workspace.directory),
      head: workspace.git(['rev-parse', 'HEAD']),
      status: workspace.git(['status', '--porcelain', '--ignored']),
      branches: workspace.git(['branch', '-a']),
      stash: workspace.git(['stash', 'list']),
    })
    const before = snapshot()
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(snapshot()).toStrictEqual(before)
    expect(workspace.requests()).toStrictEqual([])
  })

  it.for([
    { title: '未 push', kind: 'unpushed', expected: 'origin/feat/demo/12 does not exist (not pushed)' },
    { title: 'push 後に手元だけ進んだ', kind: 'ahead', expected: '1 unpushed commits' },
    { title: 'remote とずれた', kind: 'diverged', expected: `diverged: local is 1 commits ahead, origin/${BRANCH} is 1 ahead` },
  ])('ブランチが次の状態だと（$title）、Push Status の warning を数える', async (row) => {
    const workspace = row.kind === 'unpushed' ? await openWorkspace({ branch: BRANCH }) : await pushedBranch()
    if (row.kind !== 'unpushed') workspace.git(['commit', '--allow-empty', '-q', '-m', 'local'])
    if (row.kind === 'diverged') {
      workspace.advanceRemote(BRANCH)
      workspace.git(['fetch', '-q', 'origin'])
    }
    const result = await preflight(workspace)
    const fix = row.kind === 'diverged' ? DIVERGED_FIX : 'git push'
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', `warning: Push Status: ${row.expected} (fix: ${fix})`])
  })

  it.for(STACKED_CHECK_ROWS)('スタックの記録があり、$name ときに打つと、Push Status の直し方に pr restack を出す', async (row) => {
    const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest(row.state)])])
    divergeStacked(workspace, row.scene)
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(pushStatusFixes(result.stderr)).toStrictEqual(['pecot pr restack'])
  })

  it('スタックの記録があり、親 PR のマージの後に手元だけをスタックし直して remote とずれると、Push Status の直し方に pr restack を出す', async () => {
    const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('MERGED')])])
    const recorded = workspace.git(['rev-parse', `origin/${LOWER}`]).trim()
    pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    workspace.git(['rebase', '-q', '--onto', 'origin/main', recorded])
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(pushStatusFixes(result.stderr)).toStrictEqual(['pecot pr restack'])
  })

  it('記録が無く、判定が stackable で親ブランチの上にあると、親ブランチの追跡参照と比べ、Commits の節に子ブランチのコミットだけを出す', async () => {
    const workspace = await openInferredUpper([STACKABLE_RULE])
    const result = await preflight(workspace)
    expect(result).toMatchObject({ code: 0, stderr: 'count: preflight warnings: 0\n' })
    expect(result.stdout).toContain(`=== Base Branch ===\norigin/${LOWER}\n`)
    expect(result.stdout).toMatch(/=== Commits \(vs origin\/feat\/demo\/11\) ===\n[\da-f]+ change upper\.txt\n\n/u)
  })

  it('記録が無く、判定が stackable で、親ブランチが自分のコミットを持たないまま子ブランチの祖先なら、親ブランチの追跡参照と比べる', async () => {
    const workspace = await openWorkspace({ baseRecord: false, branches: [{ name: LOWER }], github: [STACKABLE_RULE] })
    workspace.git(['checkout', '-q', '-b', BRANCH, `origin/${LOWER}`])
    commitFile(workspace, 'upper.txt', 'upper\n')
    workspace.git(['push', '-q', '-u', 'origin', BRANCH])
    const result = await preflight(workspace)
    expect(result.stdout).toContain(`=== Base Branch ===\norigin/${LOWER}\n`)
  })

  it.for([
    { name: '判定を読む GitHub が失敗を返す', rules: [rule({ operation: 'GetIssuePrerequisites' }, { status: 500, body: { message: 'boom' } })], isTracked: true, expected: /^warning: cannot infer the stacked base: /u },
    { name: '判定を読む GitHub への接続が切れる', rules: [rule({ operation: 'GetIssuePrerequisites' }, { status: 200, disconnect: true })], isTracked: true, expected: /^warning: cannot infer the stacked base: /u },
    { name: '親ブランチの追跡参照が無い', rules: [STACKABLE_RULE], isTracked: false, expected: /^warning: cannot infer the stacked base: origin\/feat\/demo\/11 is not found; fetch it with: git fetch$/u },
  ])('記録が無く、$name と、warning の行を出し、develop_branch の追跡参照と比べる', async (row) => {
    const workspace = await openInferredUpper(row.rules)
    if (!row.isTracked) workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
    const result = await preflight(workspace)
    expect(result.code).toBe(0)
    expect(lines(result.stderr)[0]).toMatch(row.expected)
    expect(result.stdout).toContain('=== Base Branch ===\norigin/main\n')
  })

  it('スタックの記録があり、親ブランチが動かないまま手元だけを書き換えて remote とずれると、Push Status の直し方に取り込みか lease 付きの上書きを出す', async () => {
    const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')])])
    divergeStacked(workspace, 'amended')
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', `warning: Push Status: diverged: local is 1 commits ahead, origin/${BRANCH} is 1 ahead (fix: ${DIVERGED_FIX})`])
  })

  it.for(UNDECIDED_ROWS)('スタックの記録があって remote とずれ、$name と、Push Status の直し方に pr restack --check を出す', async (row) => {
    const workspace = await openStackedUpper([row.cause === 'pull-request-unreadable' ? UNREADABLE_LOWER_RULE : lowerPullRequests([lowerPullRequest('OPEN')])])
    divergeStacked(workspace, 'moved')
    if (row.cause === 'gone') workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    else if (row.cause === 'unreachable') {
      const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
      renameSync(bare, `${bare}.moved`)
    }
    const result = await preflight(workspace)
    expect(pushStatusFixes(result.stderr)).toStrictEqual(['pecot pr restack --check'])
  })

  it('MCP で呼ぶと、Push Status の直し方をツールの名前で出す', async (context) => {
    await verifies(context, 'PW-PR-CHECK-21')
    const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')])])
    divergeStacked(workspace, 'moved')
    const result = await callTool(workspace, 'pr_check', { directory: workspace.directory })
    expect(result.structured['warnings']).toStrictEqual([`Push Status: diverged: local is 1 commits ahead, origin/${BRANCH} is 2 ahead (fix: pr_restack)`])
  })

  it('未コミットの変更があると、Git Status の warning を数える', async () => {
    const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Git Status: modified or untracked files (fix: commit)'])
  })

  it('stash に項目があると、Stash List の warning を数える', async () => {
    const workspace = await pushedBranch()
    writeFileSync(path.join(workspace.directory, 'README.md'), '変更\n')
    workspace.git(['stash', 'push', '-q'])
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Stash List: 1 stash entries (fix: check them)'])
    expect(result.stdout).toContain('=== Stash List ===\nstash@{0}: ')
  })

  it('warning が 1 件以上あると、終了コード 2 で終わる', async () => {
    const dirty = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const dirtyResult = await preflight(dirty)
    expect(dirtyResult.code).toBe(2)
    const clean = await pushedBranch()
    const cleanResult = await preflight(clean)
    expect(cleanResult.code).toBe(0)
  })

  it('git のリポジトリでないと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(['pr', 'check', '-D', plain])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: not a git repository\n' })
  })

  it('git の remote が無いと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    workspace.git(['remote', 'remove', 'origin'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: git remote not found\n' })
  })

  it('現在のブランチを決められないと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    const unborn = path.join(workspace.root, 'unborn')
    mkdirSync(unborn)
    workspace.git(['init', '-q', '-b', 'main'], unborn)
    workspace.git(['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'], unborn)
    const result = await workspace.run(['pr', 'check', '-D', unborn])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot determine the current branch\n' })
  })

  it('remote のリポジトリを決められないと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch()
    workspace.git(['remote', 'set-url', 'origin', '/local/path/demo'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot read repository info from the remote URL\n  check it with: git remote -v\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ config: false })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async () => {
    const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'check', '-D', workspace.directory, '--project', SECOND_PROJECT])
    expect(result.stdout).toContain('=== Base Branch ===\norigin/main\n')
    expect(result.stderr).not.toContain('project config')
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で確かめる', async () => {
    const workspace = await pushedBranch({ files: NO_ACTIVE_FILES })
    const result = await preflight(workspace)
    expect(result.stdout).toContain('=== Base Branch ===\norigin/main\n')
  })

  it('develop_branch が設定に無いと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ config: NO_DEVELOP_BRANCH })
    const result = await preflight(workspace)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: develop_branch is not set for acme\/demo\n {2}set it with: pecot project link acme\/demo --develop-branch develop\n$/u)
  })

  it('<remote>/<develop_branch> が無いと、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ config: { developBranch: 'develop' } })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: branch origin/develop does not exist\n  check the remote branches with: git branch -r\n' })
  })

  it('--directory を渡していないと、使い方のエラーを出して終了コード 2 で終わる', async () => {
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'check'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: pecot pr check [OPTIONS]')
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })

  describe('MCP の data', () => {
    it('節の中身を項目ごとに返す', async () => {
      const workspace = await pushedBranch()
      const result = await callTool(workspace, 'pr_check', { directory: workspace.directory })
      expect(result.structured).toEqual({
        remoteUrl: 'git@ghes.example.com:acme/demo.git',
        currentBranch: BRANCH,
        pushed: true,
        pushStatus: `in sync with origin/${BRANCH}`,
        baseBranch: 'origin/main',
        gitStatus: `On branch ${BRANCH}\nnothing to commit, working tree clean\n`,
        commits: '(no commits)',
        diffSummary: '(no diff)',
        worktree: { list: workspace.git(['worktree', 'list']).trim(), directoryName: path.basename(workspace.directory), isWorktree: false },
        stashList: '(no stash)',
      })
    })

    it('preflight の warning で失敗しても、集めた値を data に残す', async (context) => {
      await verifies(context, 'PW-COMMON-18')
      await verifies(context, 'PW-COMMON-19')
      const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
      const result = await callTool(workspace, 'pr_check', { directory: workspace.directory })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'preflight-failed', detail: 'preflight found warnings; fix them before creating a PR' } })
      expect(result.structured).toMatchObject({ currentBranch: BRANCH, pushed: true })
      expect(result.structured['gitStatus']).toContain('Untracked files:\n\tmemo.txt\n')
      expect(result.structured['warnings']).toEqual(['Git Status: modified or untracked files (fix: commit)'])
    })

    it('directory でリポジトリを指すと、プロセスの cwd が外でも、remote・ブランチ・base・worktree の項目を返し、warnings を入れない', async (context) => {
      await verifies(context, 'PW-PR-CHECK-01')
      await verifies(context, 'PW-PR-CHECK-04')
      const workspace = await pushedBranch()
      const elsewhere = path.join(workspace.root, 'elsewhere')
      mkdirSync(elsewhere)
      const previous = process.cwd()
      process.chdir(elsewhere)
      let result: ToolOutcome
      try {
        result = await callToolOnce(COMMANDS, 'pr_check', { directory: workspace.directory })
      }
      finally {
        process.chdir(previous)
      }
      expect(result.isError).toBe(false)
      expect(result.structured).toMatchObject({ remoteUrl: 'git@ghes.example.com:acme/demo.git', currentBranch: BRANCH, pushed: true, pushStatus: `in sync with origin/${BRANCH}`, baseBranch: 'origin/main' })
      expect(result.structured).not.toHaveProperty('warnings')
    })

    it('引っかかりがあるときに呼ぶと、失敗の結果にも集めた項目を全部入れ、1 件ごとの文を warnings に入れる', async (context) => {
      await verifies(context, 'PW-PR-CHECK-02')
      await verifies(context, 'PW-PR-CHECK-04')
      await verifies(context, 'PW-PR-CHECK-05')
      await verifies(context, 'PW-PR-CHECK-07')
      await verifies(context, 'PW-PR-CHECK-08')
      await verifies(context, 'PW-PR-CHECK-10')
      const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
      const result = await checkTool(workspace)
      expect(result.isError).toBe(true)
      expect(Object.keys(result.structured).toSorted(compareStrings)).toEqual(['baseBranch', 'commits', 'currentBranch', 'detail', 'diffSummary', 'gitStatus', 'kind', 'pushStatus', 'pushed', 'remoteUrl', 'stashList', 'warnings', 'worktree'])
      expect(result.structured['kind']).toBe('preflight-failed')
      expect(result.structured['warnings']).toEqual([
        'Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)',
        'Git Status: modified or untracked files (fix: commit)',
      ])
    })

    it.for([{ remote: 'origin' }, { remote: 'upstream' }])('remote が $remote だけだと、baseBranch に <remote>/<develop_branch> を入れる', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-03')
      const workspace = await pushedBranch()
      if (row.remote !== 'origin') workspace.git(['remote', 'rename', 'origin', row.remote])
      const result = await checkTool(workspace)
      expect(result.structured).toMatchObject({ baseBranch: `${row.remote}/main`, pushStatus: `in sync with ${row.remote}/${BRANCH}` })
    })

    it('常に、リポジトリとファイルを書き換えない', async (context) => {
      await verifies(context, 'PW-PR-CHECK-06')
      const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
      const snapshot = (): unknown => ({
        files: filesOf(workspace.directory),
        head: workspace.git(['rev-parse', 'HEAD']),
        status: workspace.git(['status', '--porcelain', '--ignored']),
        branches: workspace.git(['branch', '-a']),
        stash: workspace.git(['stash', 'list']),
      })
      const before = snapshot()
      const result = await checkTool(workspace)
      expect(result.isError).toBe(true)
      expect(snapshot()).toStrictEqual(before)
      expect(workspace.requests()).toStrictEqual([])
    })

    it.for([
      { title: 'push 後に手元だけ進んだ', kind: 'ahead', expected: '1 unpushed commits (fix: git push)' },
      { title: 'remote とずれた', kind: 'diverged', expected: `diverged: local is 1 commits ahead, origin/${BRANCH} is 1 ahead (fix: ${DIVERGED_FIX})` },
    ])('ブランチが次の状態だと（$title）、Push Status の文を warnings に入れる', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-07')
      await verifies(context, 'PW-PR-CHECK-22')
      const workspace = await pushedBranch()
      workspace.git(['commit', '--allow-empty', '-q', '-m', 'local'])
      if (row.kind === 'diverged') {
        workspace.advanceRemote(BRANCH)
        workspace.git(['fetch', '-q', 'origin'])
      }
      const result = await checkTool(workspace)
      expect(result.structured['warnings']).toEqual([`Push Status: ${row.expected}`])
    })

    it('スタックの記録があり、親ブランチが動かないまま手元だけを書き換えて remote とずれると、直し方に取り込みか lease 付きの上書きを示す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-22')
      const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('OPEN')])])
      divergeStacked(workspace, 'amended')
      const result = await checkTool(workspace)
      expect(result.structured['warnings']).toEqual([`Push Status: diverged: local is 1 commits ahead, origin/${BRANCH} is 1 ahead (fix: ${DIVERGED_FIX})`])
    })

    it.for(STACKED_CHECK_ROWS)('スタックの記録があり、$name ときに呼ぶと、Push Status の直し方に pr_restack を示す', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-21')
      const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest(row.state)])])
      divergeStacked(workspace, row.scene)
      const result = await checkTool(workspace)
      expect(result.structured['kind']).toBe('preflight-failed')
      expect(toolFixes(result)).toStrictEqual(['pr_restack'])
    })

    it('スタックの記録があり、親 PR のマージの後に手元だけをスタックし直して remote とずれると、Push Status の直し方に pr_restack を示す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-24')
      const workspace = await openStackedUpper([lowerPullRequests([lowerPullRequest('MERGED')])])
      const recorded = workspace.git(['rev-parse', `origin/${LOWER}`]).trim()
      pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
      workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
      workspace.git(['rebase', '-q', '--onto', 'origin/main', recorded])
      const result = await checkTool(workspace)
      expect(toolFixes(result)).toStrictEqual(['pr_restack'])
    })

    it.for(UNDECIDED_ROWS)('スタックの記録があって remote とずれ、$name と、Push Status の直し方に check を付けた pr_restack を示す', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-23')
      const workspace = await openStackedUpper([row.cause === 'pull-request-unreadable' ? UNREADABLE_LOWER_RULE : lowerPullRequests([lowerPullRequest('OPEN')])])
      divergeStacked(workspace, 'moved')
      if (row.cause === 'gone') workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
      else if (row.cause === 'unreachable') {
        const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
        renameSync(bare, `${bare}.moved`)
      }
      const result = await checkTool(workspace)
      expect(toolFixes(result)).toStrictEqual(['pr_restack with check: true'])
    })

    it('stash に項目があると、Stash List の文を warnings に入れ、stashList に一覧を入れる', async (context) => {
      await verifies(context, 'PW-PR-CHECK-09')
      const workspace = await pushedBranch()
      writeFileSync(path.join(workspace.directory, 'README.md'), '変更\n')
      workspace.git(['stash', 'push', '-q'])
      const result = await checkTool(workspace)
      expect(result.structured['warnings']).toEqual(['Stash List: 1 stash entries (fix: check them)'])
      expect(result.structured['stashList']).toMatch(/^stash@\{0\}: /u)
    })

    it.for([
      { name: 'スタックした base の記録があり、親ブランチが remote にある', branches: [BRANCH, LOWER], expected: `origin/${LOWER}` },
      { name: 'スタックした base の記録があり、親ブランチが remote に無い', branches: [BRANCH], expected: 'origin/main' },
      { name: '親ブランチが remote から消え、手元に追跡参照が残っている', branches: [BRANCH, LOWER], remoteChange: 'delete', expected: 'origin/main' },
      { name: '親ブランチの追跡参照があり、remote に届かない', branches: [BRANCH, LOWER], remoteChange: 'unreachable', expected: `origin/${LOWER}` },
    ])('$name ときに呼ぶと、baseBranch に $expected を入れる', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-18')
      const workspace = await pushedBranch({ branches: row.branches.map(name => ({ name })), files: STACKED_RECORD })
      if (row.remoteChange === 'delete') workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
      else if (row.remoteChange === 'unreachable') {
        const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
        renameSync(bare, `${bare}.moved`)
      }
      const result = await checkTool(workspace)
      expect(result.isError).toBe(false)
      expect(result.structured['baseBranch']).toBe(row.expected)
    })

    it('スタックした base の記録があり、親ブランチが remote にあって手元に追跡参照が無いと、開発ブランチと比べ、git fetch の案内を warnings に入れる', async (context) => {
      await verifies(context, 'PW-PR-CHECK-18')
      await verifies(context, 'PW-PR-CHECK-20')
      const workspace = await pushedBranch({ branches: [{ name: BRANCH }, { name: LOWER }], files: STACKED_RECORD })
      workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
      const result = await checkTool(workspace)
      expect(result.structured['baseBranch']).toBe('origin/main')
      expect(result.structured['warnings']).toEqual([`base branch ${LOWER} is on origin, but origin/${LOWER} is not fetched; compared with the develop branch\n  run: git fetch origin ${LOWER}`])
    })

    it('スタックした base の記録の形が誤っていると、kind が content-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-19')
      const workspace = await pushedBranch({ files: MALFORMED_RECORD })
      const result = await checkTool(workspace)
      expect(result.structured).toEqual({ kind: 'content-invalid', detail: '.pecot-base is malformed: garbage' })
    })

    it('記録が無く、判定が stackable で親ブランチの上にあると、親ブランチの追跡参照と比べ、commits に子ブランチのコミットだけを入れる', async (context) => {
      await verifies(context, 'PW-PR-CHECK-25')
      const workspace = await openInferredUpper([STACKABLE_RULE])
      const result = await checkTool(workspace)
      expect(result.isError).toBe(false)
      expect(result.structured['baseBranch']).toBe(`origin/${LOWER}`)
      expect(result.structured['commits']).toMatch(/^[\da-f]+ change upper\.txt$/u)
    })

    it.for([
      { name: '判定を読む GitHub が失敗を返す', rules: [rule({ operation: 'GetIssuePrerequisites' }, { status: 500, body: { message: 'boom' } })], isTracked: true, expected: /^cannot infer the stacked base: /u },
      { name: '親ブランチの追跡参照が無い', rules: [STACKABLE_RULE], isTracked: false, expected: /^cannot infer the stacked base: origin\/feat\/demo\/11 is not found; fetch it with: git fetch$/u },
    ])('記録が無く、$name と、理由を warnings に入れ、develop_branch の追跡参照と比べる', async (row, context) => {
      await verifies(context, 'PW-PR-CHECK-26')
      const workspace = await openInferredUpper(row.rules)
      if (!row.isTracked) workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
      const result = await checkTool(workspace)
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(row.expected)])
      expect(result.structured['baseBranch']).toBe('origin/main')
    })

    it.for([
      { name: 'git のリポジトリでない', id: 'PW-PR-CHECK-11', setUp: (workspace: Workspace): string => mkdirIn(workspace, 'plain'), detail: 'not a git repository' },
      { name: 'git の remote が無い', id: 'PW-PR-CHECK-12', setUp: (workspace: Workspace): string => removeOrigin(workspace), detail: 'git remote not found' },
      { name: '現在のブランチを決められない', id: 'PW-PR-CHECK-13', setUp: (workspace: Workspace): string => unbornRepository(workspace), detail: 'cannot determine the current branch' },
      { name: 'remote のリポジトリを決められない', id: 'PW-PR-CHECK-13', setUp: (workspace: Workspace): string => localRemote(workspace), detail: 'cannot read repository info from the remote URL\n  check it with: git remote -v' },
    ])('$name と、kind が git-unresolved の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      const workspace = await pushedBranch()
      const directory = row.setUp(workspace)
      const result = await callTool(workspace, 'pr_check', { directory })
      expect(result.structured).toEqual({ kind: 'git-unresolved', detail: row.detail })
    })

    it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を入れて、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-14')
      const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
      const result = await checkTool(workspace)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-27')
      const workspace = await pushedBranch({ config: false })
      const result = await checkTool(workspace)
      expect(result.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: (none)' })
    })

    it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async (context) => {
      await verifies(context, 'PW-PR-CHECK-28')
      const workspace = await pushedBranch({ files: ambiguousWorkspaceFiles() })
      const result = await checkTool(workspace, { project: SECOND_PROJECT })
      expect(result.isError).toBe(false)
      expect(result.structured['baseBranch']).toBe('origin/main')
    })

    it('develop_branch が設定に無いと、kind が repo-setting-missing の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-15')
      const workspace = await pushedBranch({ config: NO_DEVELOP_BRANCH })
      const result = await checkTool(workspace)
      expect(result.structured['kind']).toBe('repo-setting-missing')
      expect(result.structured['detail']).toMatch(/^develop_branch is not set for acme\/demo\n/u)
    })

    it('<remote>/<develop_branch> が無いと、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-16')
      const workspace = await pushedBranch({ config: { developBranch: 'develop' } })
      const result = await checkTool(workspace)
      expect(result.structured).toEqual({ kind: 'git-unresolved', detail: 'branch origin/develop does not exist\n  check the remote branches with: git branch -r' })
    })

    it('directory を渡していないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PR-CHECK-17')
      const workspace = await pushedBranch()
      const result = await callTool(workspace, 'pr_check', {})
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
    })
  })
})
