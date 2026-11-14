/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr の 4 コマンド（PW-PR-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { installFakeExecutable, prependToPath } from '../../src/tests/_helpers/fake-executables.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { verifies } from '../_helpers/verifies.js'
import { graphql, HOST, issueKindData, openWorkspace, pullRequestData, rest, rule } from '../_helpers/workspace.js'
import type { ConfigOptions, PullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { TargetSpec } from '../_helpers/prerequisites.js'
import type { ResponseRule } from '../fake-github/server.js'

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
const KIND_FAILURE = rule({ operation: 'GetIssueKind' }, { status: 500, body: { message: 'Server Error' } })
// 種別の問い合わせが 500 を返したときの warning。httpx の文言が 2 行に分かれ、suffix は 2 行目の末尾に付く
const KIND_WARNING_FILL = /^warning: kind check of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; fill Closes by hand\n/mu
const KIND_WARNING_UNPROTECTED = /^warning: kind check of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; not protected\n/mu
// head の Issue #12 を待つ Issue は無い
const NO_WAITING_RULE = graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: 0, nodes: [] } } } }, { variables: { number: 12 } })
const AFTER_CREATE_RULES: ResponseRuleList = [...IN_REVIEW_RULES, NO_WAITING_RULE]
const CREATED_RULE = rest('POST', '/repos/acme/demo/pulls', 201, { number: 21, html_url: PULL_URL })
const NOT_EPIC_RULE = graphql('GetIssueKind', issueKindData({ number: 12 }), { variables: { number: 12 } })
const SUBMIT_RULES: ResponseRuleList = [NOT_EPIC_RULE, CREATED_RULE, ...AFTER_CREATE_RULES]

// 共通の補助

function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

function restRequests(workspace: Readonly<Workspace>, method: string, requestPath?: string): unknown[] {
  return workspace.requests().filter(request => request.type === 'rest' && request.method === method && (requestPath === undefined || request.path === requestPath))
}

function operationsOf(workspace: Readonly<Workspace>): string[] {
  return workspace.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

function postedBody(workspace: Readonly<Workspace>): Record<string, unknown> {
  const posted = workspace.requests().find(request => request.type === 'rest' && request.method === 'POST' && request.path === '/repos/acme/demo/pulls')
  const body = posted?.type === 'rest' ? posted.body : undefined
  if (typeof body !== 'object' || body === null) throw new TypeError('POST /pulls を受けていない')
  return Object.fromEntries(Object.entries(body))
}

function stateFile(name: string): string {
  return `.pecot/state/${name}`
}

function filesOf(directory: string): string[] {
  const entries = readdirSync(directory, { recursive: true, encoding: 'utf8' })
  return entries
    .filter(relative => relative !== '.git' && !relative.startsWith('.git/'))
    .map((relative) => {
      const stat = lstatSync(path.join(directory, relative))
      return `${relative}:${String(stat.size)}:${String(stat.mtimeMs)}`
    })
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

// 積んだ base（下の段は Issue #11 の feat/demo/11）

const LOWER = 'feat/demo/11'
const RECORD_SHA = '0123456789abcdef0123456789abcdef01234567'
const STACKED_RECORD = { [stateFile('.pecot-base')]: `${LOWER} ${RECORD_SHA} acme/demo#11\n` }
const MALFORMED_RECORD = { [stateFile('.pecot-base')]: 'garbage\n' }
const STACKS_PATH = '/repos/acme/demo/stacks'
const STACKS_VERSION = '2026-03-10'
const NO_STACK_RULE = rule({ method: 'GET', path: STACKS_PATH, query: { pull_request: '20' }, apiVersion: STACKS_VERSION }, { status: 200, body: [] })
const CREATED_STACK_RULE = rule({ method: 'POST', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 201, body: { number: 5, pull_requests: [{ number: 20 }, { number: 21 }] } })

// 下の段のブランチを head に持つ PR #20
function lowerPullRequest(state: string): Record<string, unknown> {
  return { number: 20, state, headRefName: LOWER, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は入れ子が深く、読むだけ
function lowerPullRequests(nodes: readonly Record<string, unknown>[], times = 1): ResponseRule {
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } }
  return graphql('ListPullRequestsByHead', data, { variables: { headRefName: LOWER }, times })
}

function stackedArguments(extra: readonly string[] = [], title = TITLE): string[] {
  return ['pr', 'create', '-m', VALID_BODY, '-t', title, '-b', LOWER, '-r', 'acme/demo', '--screenshot', SCREENSHOT, ...extra]
}

// 待っている Issue（#12 を前提にする #13。ボードでは Blocked）

function waitingRule(total = 1): ResponseRule {
  const nodes = [{ id: 'I_demo_13', number: 13, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }]
  return graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: total, nodes } } } }, { variables: { number: 12 } })
}

const BOARD_ITEM = {
  id: 'PVTI_13',
  updatedAt: '2026-01-02T03:04:05Z',
  fieldValues: { nodes: [{ field: { name: 'pecot-workflow-acme' }, name: 'Blocked' }] },
  content: { id: 'I_13', number: 13, title: '課題13', state: 'OPEN', url: `https://${HOST}/acme/demo/issues/13`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: 'demo' } },
}
const BOARD_RULE = graphql('ListProjectItems', { node: { items: { nodes: [BOARD_ITEM], pageInfo: { hasNextPage: false } } } })
const READY_WRITE_RULE = graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_13' } } }, { variables: { itemId: 'PVTI_13', optionId: 'o3' } })

// #13 の前提の読み取り。hasPullRequest なら、#12 のブランチに作った PR #21 が出る
function waitingTarget(hasPullRequest: boolean): TargetSpec {
  const blocker = hasPullRequest ? { number: 12, branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH }] } : { number: 12 }
  return { number: 13, blockedBy: [blocker] }
}

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

describe('pr create', () => {
  it('--prepare を付けて打つと、テンプレのコピーを .pecot/tmp/output/ に書く', async (context) => {
    await verifies(context, 'PW-PR-CREATE-01')
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.code).toBe(0)
    const written = result.stdout.trim()
    expect(path.dirname(written)).toBe(path.join(workspace.directory, '.pecot', 'tmp', 'output'))
    const content = readFileSync(written, 'utf8')
    expect(content).toMatch(/^---\ntitle: ""\nrepository: ""\nbase: "main"\n/u)
    expect(content).toContain('## Summary')
    expect(content).toContain('## Verified')
  })

  it('--prepare を付けて打つと、書いたテンプレのパスを標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-02')
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.stdout).toMatch(/^\S+\/\.pecot\/tmp\/output\/pr-create-[\w-]+\.md\n$/u)
    expect(existsSync(result.stdout.trim())).toBe(true)
  })

  it('default のテンプレで --prepare を付けて打つと、コピーの base に develop_branch を入れる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-03')
    const workspace = await pushedBranch({ config: { developBranch: 'develop' }, github: [NOT_EPIC_RULE] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^base: "develop"$/mu)
    expect(result.stderr).toContain('set: base to develop\n')
  })

  it('nx のリポジトリで --prepare を付けて打つと、タイトルの行に scope の目安をコメントで足す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-04')
    installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
    const workspace = await openWorkspace({ ...NX_OPTIONS, github: [NOT_EPIC_RULE] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.code).toBe(0)
    expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^title: "" {2}# expected scope: p-w$/mu)
    expect(result.stderr).toContain('set: title scope hint to p-w\n')
  })

  it('remote が upstream だけでも、--prepare のコピーに base の設定と scope の目安を入れる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-03')
    installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
    const workspace = await openWorkspace({ ...NX_OPTIONS, github: [NOT_EPIC_RULE] })
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.code).toBe(0)
    const content = readFileSync(result.stdout.trim(), 'utf8')
    expect(content).toMatch(/^base: "main"$/mu)
    expect(content).toMatch(/^title: "" {2}# expected scope: p-w$/mu)
    expect(result.stderr).toContain('set: base to main\n')
    expect(result.stderr).toContain('set: title scope hint to p-w\n')
  })

  it('default のテンプレで --prepare を付けて打つと、末尾の Closes に着手中の Issue の番号を入れる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-05')
    const workspace = await openWorkspace({
      branch: 'feat/demo/other',
      files: { [stateFile('.pecot-active')]: 'acme/demo/34\n' },
      github: [graphql('GetIssueKind', issueKindData({ number: 34 }), { variables: { number: 34 } })],
    })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^Closes #34$/mu)
    expect(result.stderr).toContain('set: Closes to #34\n')
  })

  it('着手中の Issue が Epic のときに --prepare を付けて打つと、Closes を空のままにする', async (context) => {
    await verifies(context, 'PW-PR-CREATE-06')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 3 }))] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.code).toBe(0)
    expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^Closes #\s*$/mu)
  })

  it('着手中の Issue が Epic のときに --prepare を付けて打つと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-07')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, issueType: 'Epic' }))] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.stderr).toContain('warning: Issue #12 is an Epic; Closes left empty\n')
  })

  it('Issue の種別を読めないまま --prepare を付けて打つと、warning の行を出して Closes を空のままにする', async () => {
    const workspace = await pushedBranch({ github: [KIND_FAILURE] })
    const result = await workspace.run(['pr', 'create', '--prepare'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(KIND_WARNING_FILL)
    expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^Closes #\s*$/mu)
    expect(result.stderr).not.toContain('set: Closes')
  })

  it('ファイルで作るとき末尾の番号の Issue の種別を読めないと、warning の行を出さずに Closes を足す', async () => {
    const workspace = await pushedBranch({ github: [KIND_FAILURE, CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITHOUT_REFERENCE })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('kind check')
    expect(postedBody(workspace)['body']).toBe(`${BODY_WITHOUT_REFERENCE.trimEnd()}\n\nCloses #12`)
  })

  it('--prepare とファイルを一緒に渡すと、PR を作らずにテンプレのコピーだけを書く', async (context) => {
    await verifies(context, 'PW-PR-CREATE-08')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace)
    const before = readFileSync(file, 'utf8')
    const outputDirectory = path.join(workspace.directory, '.pecot', 'tmp', 'output')
    const result = await workspace.run(['pr', 'create', '--prepare', file])
    expect(result.code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(outputDirectory).map(name => path.join(outputDirectory, name))).toStrictEqual([result.stdout.trim()])
    expect(result.stdout).toMatch(/\/\.pecot\/tmp\/output\/pr-create-[\w-]+\.md\n$/u)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
    expect(result.stderr).not.toContain('created:')
  })

  it('ファイルを渡すと、フロントマターの値で PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-09')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題', head: BRANCH })
    const result = await workspace.run(['pr', 'create', file])
    expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
    expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題', head: BRANCH, base: 'main', draft: false })
    expect(postedBody(workspace)['body']).toContain('## Summary — 見本の変更を取り込む')
  })

  it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルから PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-10')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const file = writePrFile(workspace, { title: 'feat(demo): #12 ファイルの題' })
    const result = await workspace.run(['pr', 'create', file, '-m', '別の本文 #12', '-t', '別の題', '-b', 'main'])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)).toMatchObject({ title: 'feat(demo): #12 ファイルの題' })
    expect(postedBody(workspace)['body']).not.toContain('別の本文')
  })

  it('-m に -t と -b を付けて打つと、PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-11')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
    expect(postedBody(workspace)).toMatchObject({ title: TITLE, base: 'main', head: BRANCH, body: VALID_BODY })
  })

  it('-m で --repo を省くと、設定のリポジトリが 1 つならそのリポジトリに PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-12')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '--screenshot', SCREENSHOT])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'POST', '/repos/acme/demo/pulls')).toHaveLength(1)
  })

  it('--head を省いて打つと、今のブランチを head にする', async (context) => {
    await verifies(context, 'PW-PR-CREATE-13')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    await workspace.run(messageArguments())
    expect(postedBody(workspace)['head']).toBe(BRANCH)
  })

  it('--draft を付けて -m で打つと、ドラフトの PR を作る', async (context) => {
    await verifies(context, 'PW-PR-CREATE-14')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments(['--draft']))
    expect(result.stderr).toContain(`created: draft PR acme/demo ${BRANCH} -> main: ${TITLE}\n`)
    expect(postedBody(workspace)['draft']).toBe(true)
  })

  it.for([{ mode: 'file' }, { mode: 'message' }])('$mode の形で head ブランチ名の末尾に番号があると、本文にその番号の Closes を足す', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-15')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const body = BODY_WITHOUT_REFERENCE
    const argv = row.mode === 'file' ? ['pr', 'create', writePrFile(workspace, { body })] : messageArguments([], body)
    const result = await workspace.run(argv)
    expect(result.code).toBe(0)
    const posted = postedBody(workspace)['body']
    expect(posted).toBe(`${body.trimEnd()}\n\nCloses #12`)
    expect(String(posted).endsWith('Closes #12')).toBe(true)
  })

  it('ファイルで作るとき末尾の番号の Issue が Epic だと、Closes を足さない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-16')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
  })

  it('ファイルで作るとき末尾の番号の Issue が Epic だと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-17')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...AFTER_CREATE_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.stderr).toContain('warning: Issue #12 at the end of the branch is an Epic; Closes not added\n')
  })

  it('--no-issue-ref を付けて打つと、Closes を足さず、Issue の参照の確認もしない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-18')
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

  it('--dry-run を付けずに打つと、PR を作る前に pr preflight と同じ確認をする', async (context) => {
    await verifies(context, 'PW-PR-CREATE-20')
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    const preflight = await workspace.run(['pr', 'preflight', '-D', workspace.directory])
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

  it('PR を作ると、関連 Issue のボードの status を In Review にする', async (context) => {
    await verifies(context, 'PW-PR-CREATE-23')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.stderr).toContain('set: Issue #12 status to In Review\n')
    expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toMatchObject([
      { variables: { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'PVTSSF_workflow', optionId: 'o5' } },
    ])
  })

  it('PR を作ると、pr-create-slash-pending を消す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-24')
    const workspace = await pushedBranch({ github: SUBMIT_RULES, files: { [stateFile('pr-create-slash-pending')]: '1\n' } })
    expect(workspace.exists(stateFile('pr-create-slash-pending'))).toBe(true)
    await workspace.run(messageArguments())
    expect(workspace.exists(stateFile('pr-create-slash-pending'))).toBe(false)
  })

  it('PR を作ると、その URL を標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-25')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.stdout).toBe(`${PULL_URL}\n`)
  })

  it('PR を作ると、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-26')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(lines(result.stderr)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review'])
  })

  it('本文に Issue の参照 #N が無いと、終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-27')
    const workspace = await openWorkspace({ branch: 'feat/demo/other' })
    const result = await workspace.run(messageArguments(['--head', 'feat/demo/other', '--dry-run'], BODY_WITHOUT_REFERENCE))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: PR body has no Issue reference `#N` (use `--no-issue-ref` for a PR not tied to an Issue)\n')
  })

  it('必須の節が足りないと、終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-28')
    const workspace = await pushedBranch()
    const result = await workspace.run(messageArguments(['--dry-run'], '本文だけ #12'))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: missing sections: ## Summary, ## Changes, ## Verified, ## Risks\n')
  })

  it('使えない記法があると、終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-30')
    const workspace = await pushedBranch()
    const result = await workspace.run(messageArguments(['--dry-run'], `${VALID_BODY}\n- [ ] 残タスク\n`))
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: disallowed syntax: checkbox syntax (- [ ] / 1. [ ]) is not allowed\n')
  })

  it('Summary に画像も screenshot の理由も無いと、終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-31')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '-r', 'acme/demo', '--dry-run'])
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: Summary has no image and `screenshot` gives no reason to omit one. If the change alters a screen, Markdown the tool writes for GitHub, or CLI output text, take a screenshot and add it to Summary as `![alt](./<file>.png)`. Otherwise, write the reason in the `screenshot` frontmatter field (`--screenshot` with `-m`)\n')
  })

  it('base が設定のブランチと違うと、終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-32')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'develop', '-r', 'acme/demo', '--screenshot', SCREENSHOT, '--dry-run'])
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: base branch must be main (given: develop)\n')
  })

  it.for([{ mode: 'file' }, { mode: 'message' }])('nx のリポジトリで scope が違うタイトルを $mode の形で渡すと、終了コード 3 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-33')
    installNx({ 'pecot-workflow': { root: 'plugins/pecot-workflow', tags: ['scope:p-w'] } })
    const workspace = await openWorkspace(NX_OPTIONS)
    const title = 'feat(pecot): #12 見本の変更'
    const argv = row.mode === 'file'
      ? ['pr', 'create', writePrFile(workspace, { title }), '--dry-run']
      : ['pr', 'create', '-m', VALID_BODY, '-t', title, '-b', 'main', '-r', 'acme/demo', '--screenshot', SCREENSHOT, '--dry-run']
    const result = await workspace.run(argv)
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('error: PR title scope must be p-w (given: pecot; computed from the tags of the changed nx projects)\n')
  })

  it('検証に失敗すると、違反ごとに error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-34')
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

  it('検証に失敗すると、PR を作らない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-35')
    const workspace = await pushedBranch({ github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments([], '本文だけ #12'))
    expect(result.code).toBe(3)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
  })

  it('事前の確認が warning を出すと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-36')
    const workspace = await openWorkspace({ branch: BRANCH, github: SUBMIT_RULES })
    const result = await workspace.run(messageArguments())
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: preflight found warnings; fix them before creating a PR\nwarning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)\n')
  })

  it('事前の確認が git のリポジトリでないなどの致命的な場合に当たると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-37')
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
  ])('$title と、検証の前に終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-38')
    const workspace = await pushedBranch({ config: row.config })
    const result = await workspace.run(row.argv)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(row.expected)
    expect(result.stderr).not.toContain('missing sections')
  })

  it('ボードの status を In Review にできないと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-39')
    const empty = graphql('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [] } } } })
    const workspace = await pushedBranch({ github: [CREATED_RULE, empty, NO_WAITING_RULE] })
    const result = await workspace.run(messageArguments(['--no-issue-ref']))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
    expect(result.stderr).toContain('warning: Issue #12 is not on the board; status not updated\n')
  })

  it('ボードの status の更新で GitHub API がエラーを返すと、PR は作ったまま warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-39')
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

  it('PR の作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-40')
    const workspace = await pushedBranch({ github: [rest('POST', '/repos/acme/demo/pulls', 422, { message: 'Validation Failed' })], files: { [stateFile('pr-create-slash-pending')]: '1\n' } })
    const result = await workspace.run(messageArguments())
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR creation failed: GitHub API error: 422\n' })
    expect(operationsOf(workspace)).toStrictEqual(['POST /repos/acme/demo/pulls'])
    expect(workspace.exists(stateFile('pr-create-slash-pending'))).toBe(true)
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-41')
    const workspace = await pushedBranch({ config: false })
    const result = await workspace.run(messageArguments())
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it('--template が default でも release でもないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-42')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', '-m', 'test', '-t', 'test', '-b', 'main', '--template', 'invalid'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: --template must be \'default\' or \'release\' (given: invalid)\n' })
  })

  it('--prepare・ファイル・-m のどれも渡さないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-43')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: missing arguments\n  usage:\n  pecot pr create --prepare\n  pecot pr create <path>\n  pecot pr create -m "<body>" -t "<title>" -b <base-branch>\n')
  })

  it.for([
    { title: '-t', argv: ['pr', 'create', '-m', 'x', '-b', 'main'] },
    { title: '-b', argv: ['pr', 'create', '-m', 'x', '-t', 'x'] },
  ])('-m に $title を渡さないと、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-44')
    const workspace = await pushedBranch()
    const result = await workspace.run(row.argv)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: -t (title) and -b (base branch) are required with -m\n' })
  })

  it('ファイルと一緒に --screenshot を渡すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-45')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', writePrFile(workspace), '--screenshot', '理由'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: --screenshot is for -m; write the reason in the `screenshot` frontmatter field instead\n$/u)
  })

  it.for([
    { title: 'フロントマターが無い', content: '本文だけ\n', expected: 'error: frontmatter not found (does not start with ---)\n' },
    { title: 'repository が owner/repo の形でない', content: '---\ntitle: "x"\nrepository: "invalid"\nbase: "main"\nhead: ""\ndraft: false\n---\n\n本文\n', expected: 'error: repository is required (e.g. owner/repo)\n' },
  ])('ファイルが次の形だと（$title）、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-46')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', workspace.scratch('bad.md', row.content)])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(row.expected)
    expect(restRequests(workspace, 'POST')).toStrictEqual([])
  })

  it.for([
    { title: '設定のリポジトリが 2 つで --repo も無い', config: { hasSecondRepository: true }, repo: [], expected: 'error: specify the repository (-r owner/repo)\n' },
    { title: '--repo が owner/repo の形でない', config: {}, repo: ['-r', 'invalid'], expected: 'error: invalid repository format: invalid (expected: owner/repo)\n' },
  ])('-m で次の形だと（$title）、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-47')
    const workspace = await pushedBranch({ config: row.config })
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

  it('head ブランチを決められないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-48')
    const workspace = await pushedBranch()
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(['pr', 'create', '-m', VALID_BODY, '-t', TITLE, '-b', 'main', '-r', 'acme/demo', '--dry-run'], plain)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot determine the head branch\n' })
  })

  describe('積んだ base', () => {
    it('積んだ base の記録があるときに --prepare を付けて打つと、通信せずにコピーの base に下の段のブランチを入れる', async (context) => {
      await verifies(context, 'PW-PR-CREATE-49')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [NOT_EPIC_RULE] })
      const result = await workspace.run(['pr', 'create', '--prepare'])
      expect(result.code).toBe(0)
      expect(readFileSync(result.stdout.trim(), 'utf8')).toMatch(/^base: "feat\/demo\/11"$/mu)
      expect(result.stderr).toContain(`set: base to ${LOWER}\n`)
      expect(operationsOf(workspace)).toStrictEqual(['GetIssueKind'])
    })

    it('下の段の PR が開いているときに打つと、base を下の段のブランチにして PR を作り、新しいスタックに登録する', async (context) => {
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

    it('下の段がスタックに入っているときに PR を作ると、そのスタックの一番上に足す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-51')
      const existing = rule({ method: 'GET', path: STACKS_PATH, apiVersion: STACKS_VERSION }, { status: 200, body: [{ number: 5, pull_requests: [{ number: 19 }, { number: 20 }] }] })
      const added = rule({ method: 'POST', path: `${STACKS_PATH}/5/add`, apiVersion: STACKS_VERSION }, { status: 200, body: { number: 5, pull_requests: [{ number: 19 }, { number: 20 }, { number: 21 }] } })
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), CREATED_RULE, ...AFTER_CREATE_RULES, existing, added] })
      const result = await workspace.run(stackedArguments())
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('added: PR #21 to stack #5\n')
      expect(restRequests(workspace, 'POST', `${STACKS_PATH}/5/add`)).toMatchObject([{ body: { pull_requests: [21] } }])
      expect(restRequests(workspace, 'POST', STACKS_PATH)).toStrictEqual([])
    })

    it('積んだ記録で --dry-run を付けて打つと、下の段のブランチを base にした予定の行を出し、スタックと待つ側を読まない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-50')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')])] })
      const result = await workspace.run(stackedArguments(['--dry-run']))
      expect(result).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: `dry-run: would create PR acme/demo ${BRANCH} -> ${LOWER}: ${TITLE}\ndry-run: would set Issue #12 status to In Review\n`,
      })
      expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
    })

    it('下の段の PR がマージ済みのときにファイルで打つと、base を開発ブランチにして PR を作り、スタックに登録しない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-52')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('MERGED')]), ...SUBMIT_RULES] })
      const result = await workspace.run(['pr', 'create', writePrFile(workspace, { base: LOWER })])
      expect(result).toStrictEqual({ code: 0, stdout: `${PULL_URL}\n`, stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\n` })
      expect(postedBody(workspace)['base']).toBe('main')
      expect(operationsOf(workspace).filter(operation => operation.includes('/stacks'))).toStrictEqual([])
    })

    it('記録が開発ブランチからの着手のときに打つと、記録が無いときと同じ出力と要求になる', async (context) => {
      await verifies(context, 'PW-PR-CREATE-53')
      const plain = await pushedBranch({ github: SUBMIT_RULES })
      const expected = await plain.run(messageArguments())
      const recorded = await pushedBranch({ files: { [stateFile('.pecot-base')]: `main ${RECORD_SHA}\n` }, github: SUBMIT_RULES })
      const result = await recorded.run(messageArguments())
      expect(result).toStrictEqual(expected)
      expect(operationsOf(recorded)).toStrictEqual(operationsOf(plain))
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
      { name: '下の段の PR が無い', nodes: [] },
      { name: '下の段の PR がマージされずに閉じた', nodes: [lowerPullRequest('CLOSED')] },
    ])('$name とき、PR を作らずに直し方を添えた error の行を出し、終了コード 2 で終わる', async (row, context) => {
      await verifies(context, 'PW-PR-CREATE-57')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests(row.nodes), ...SUBMIT_RULES] })
      const result = await workspace.run(stackedArguments())
      expect(result).toStrictEqual({
        code: 2,
        stdout: '',
        stderr: `error: base branch ${LOWER} has no open PR\n  reopen the PR of ${LOWER}, or create a new one, then run pr create again\n`,
      })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    it('下の段の PR が開いているのに base に開発ブランチを渡すと、PR を作らずに終了コード 3 で終わる', async (context) => {
      await verifies(context, 'PW-PR-CREATE-58')
      const workspace = await pushedBranch({ files: STACKED_RECORD, github: [lowerPullRequests([lowerPullRequest('OPEN')]), ...SUBMIT_RULES] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({ code: 3, stdout: '', stderr: `error: base branch must be ${LOWER} while its PR #20 is open (given: main)\n` })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
    })

    it.for([
      { name: '--prepare', mode: 'prepare' },
      { name: 'ファイルの投稿', mode: 'file' },
      { name: '-m の投稿', mode: 'message' },
    ])('積んだ base の記録の形が誤っていると、$name でも終了コード 1 で終わる', async (row, context) => {
      await verifies(context, 'PW-PR-CREATE-59')
      const workspace = await pushedBranch({ files: MALFORMED_RECORD, github: SUBMIT_RULES })
      const argv = row.mode === 'prepare' ? ['pr', 'create', '--prepare'] : (row.mode === 'file' ? ['pr', 'create', writePrFile(workspace)] : messageArguments())
      const result = await workspace.run(argv)
      expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
      expect(restRequests(workspace, 'POST')).toStrictEqual([])
      expect(workspace.exists('.pecot/tmp/output')).toBe(false)
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
    ])('$name とき、PR を作ったまま warning: could not register stack の行を出す', async (row, context) => {
      await verifies(context, 'PW-PR-CREATE-60')
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

    it('下の段の PR がマージ済みのとき、題の scope を記録の位置からの差分で確かめる', async (context) => {
      await verifies(context, 'PW-PR-CREATE-52')
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
  })

  describe('待っている Issue', () => {
    it('PR を作ると、head の Issue を待つ Issue の列を動かし、moved の行を In Review の行と URL の間に出す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-55')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${PULL_URL}\n`,
        stderr: `created: PR acme/demo ${BRANCH} -> main: ${TITLE}\nset: Issue #12 status to In Review\nmoved: #13 Blocked -> Ready (stackable on #12)\n`,
      })
    })

    it('着手の跡がある待つ Issue は、列を動かさない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-56')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule({ ...waitingTarget(true), branch: 'feat/demo/13' })] })
      const result = await workspace.run(messageArguments())
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([`created: PR acme/demo ${BRANCH} -> main: ${TITLE}`, 'set: Issue #12 status to In Review'])
      expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toHaveLength(1)
    })

    it('待つ Issue の判定に作った PR が出ていなければ、1 回だけ読み直してから動かす', async (context) => {
      await verifies(context, 'PW-PR-CREATE-55')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result.stderr).toContain('moved: #13 Blocked -> Ready (stackable on #12)\n')
      expect(operationsOf(workspace).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
    })

    it('読み直しても作った PR が判定に出なければ、warning の行を出して列を動かさない', async (context) => {
      await verifies(context, 'PW-PR-CREATE-61')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(false))] })
      const result = await workspace.run(messageArguments())
      expect(result).toMatchObject({ code: 0, stdout: `${PULL_URL}\n` })
      expect(lines(result.stderr).at(-1)).toBe('warning: could not confirm that GitHub reflects PR #21 in the readiness of #13; its column was not moved')
      expect(result.stderr).not.toContain('moved:')
    })

    it('待つ Issue を全件読めなければ、読めた分を動かして warning の行を出す', async (context) => {
      await verifies(context, 'PW-PR-CREATE-61')
      const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES, waitingRule(2), BOARD_RULE, prerequisitesRule(waitingTarget(true)), READY_WRITE_RULE] })
      const result = await workspace.run(messageArguments())
      expect(result.code).toBe(0)
      expect(lines(result.stderr).slice(2)).toStrictEqual(['moved: #13 Blocked -> Ready (stackable on #12)', 'warning: read 1 of 2 Issues waiting for #12; the rest were not moved'])
    })

    it.for([
      { name: '待つ Issue の読み取り', rules: [rule({ operation: 'GetIssueBlockingReferences' }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not read the Issues waiting for #12: GraphQL query error: /u },
      { name: 'ボードの読み取り', rules: [waitingRule(), rule({ operation: 'ListProjectItems' }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not move the Issues waiting for #12: GraphQL query error: /u },
      { name: '列の書き込み', rules: [waitingRule(), BOARD_RULE, prerequisitesRule(waitingTarget(true)), rule({ operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_13' } }, { status: 500, body: { message: 'boom' } })], expected: /^warning: could not move #13: GraphQL query error: /u },
    ])('$name に失敗すると、PR を作ったまま warning の行を出し、終了コード 0 で終わる', async (row, context) => {
      await verifies(context, 'PW-PR-CREATE-61')
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

    it('待つ Issue が無ければ、ボードを読まない', async () => {
      const workspace = await pushedBranch({ github: SUBMIT_RULES })
      await workspace.run(messageArguments())
      expect(operationsOf(workspace)).toStrictEqual(['POST /repos/acme/demo/pulls', 'GetIssueProjectItems', 'UpdateProjectItemField', 'GetIssueBlockingReferences'])
    })
  })
})

// pr read

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
  threads: [{ isResolved: false, path: 'src/a.ts', line: 10, comments: { nodes: [{ author: { login: 'reviewer' }, body: '名前を直す', createdAt: '2026-01-02T03:04:05Z' }] } }],
}

describe('pr read', () => {
  it('PR の参照を渡すと、見出し・状態・ブランチ・本文を Markdown で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-READ-01')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: '本文の 1 行目\n' }))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21'])
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
  ])('関連 Issue がある PR を読むと、$title を出す', async (row, context) => {
    await verifies(context, 'PW-PR-READ-02')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: row.body }))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21'])
    expect(result.stdout).toContain(row.expected)
  })

  it('レビューがある PR を読むと、レビューごとの author と状態を出す', async (context) => {
    await verifies(context, 'PW-PR-READ-03')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21'])
    expect(result.stdout).toContain('**Reviews:**\n  - reviewer: APPROVED\n')
    expect(result.stdout).toContain('**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2')
  })

  it('--reviews を付けて打つと、レビューの本文と行のコメントを足して出す', async (context) => {
    await verifies(context, 'PW-PR-READ-04')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--reviews'])
    expect(result.stdout).toContain('### @reviewer (CHANGES_REQUESTED) - 2026-01-02\n\n直してください。\n')
    expect(result.stdout).toContain('### `src/a.ts:10` [Open]\n\n**@reviewer** (2026-01-02):\n> 名前を直す\n')
  })

  it.for([
    { title: 'レビューがあれば ## Reviews の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: 'レビューが無ければ ## Reviews の節を出さない', sample: { state: 'OPEN' }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row, context) => {
    await verifies(context, 'PW-PR-READ-05')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(row.sample))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--reviews'])
    expect(result.stdout.includes('## Reviews\n')).toBe(row.isShown)
  })

  it.for([
    { title: '行のコメントがあれば ## Line Comments の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: '行のコメントが無ければ ## Line Comments の節を出さない', sample: { state: 'OPEN', reviews: REVIEW_SAMPLE.reviews ?? [], threads: [] }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row, context) => {
    await verifies(context, 'PW-PR-READ-06')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(row.sample))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--reviews'])
    expect(result.stdout.includes('## Line Comments\n')).toBe(row.isShown)
  })

  it('--reviews を付けて打つと、関連 Issue ごとに pecot issue read の案内を足す', async (context) => {
    await verifies(context, 'PW-PR-READ-07')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData({ ...REVIEW_SAMPLE, closing: [[12, '見本の Issue'], [13, '別の Issue']] }))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--reviews'])
    expect(result.stdout).toContain('  - #12 見本の Issue\n    → details: pecot issue read acme/demo/12\n')
    expect(result.stdout).toContain('  - #13 別の Issue\n    → details: pecot issue read acme/demo/13\n')
  })

  it('--json を付けて打つと、同じ内容を JSON で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-READ-08')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--json'])
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

  it('--json と --reviews を一緒に付けて打つと、JSON にレビューと行のコメントを含める', async (context) => {
    await verifies(context, 'PW-PR-READ-09')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21', '--json', '--reviews'])
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviews: [{ state: 'CHANGES_REQUESTED', author: 'reviewer', body: '直してください。', submitted_at: '2026-01-02T03:04:05Z' }],
      review_threads: [{ is_resolved: false, path: 'src/a.ts', line: 10, comments: [{ author: 'reviewer', body: '名前を直す', created_at: '2026-01-02T03:04:05Z' }] }],
    })
  })

  it.for([
    { title: '--repo（git の remote と違う値）', argv: ['--repo', 'acme/other', 'pr', 'read', '21'], remote: 'origin', expected: 'other' },
    { title: 'origin の remote', argv: ['pr', 'read', '21'], remote: 'origin', expected: 'demo' },
    { title: 'origin が無いときの upstream の remote', argv: ['pr', 'read', '21'], remote: 'upstream', expected: 'upstream-repo' },
  ])('短い形 N の参照を渡すと、$title で補って読む', async (row, context) => {
    await verifies(context, 'PW-PR-READ-10')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN' }))] })
    if (row.remote === 'upstream') {
      workspace.git(['remote', 'rename', 'origin', 'upstream'])
      workspace.git(['remote', 'set-url', 'upstream', `https://${HOST}/acme/upstream-repo.git`])
    }
    const result = await workspace.run(row.argv)
    expect(result.code).toBe(0)
    expect(workspace.requests()).toMatchObject([{ type: 'graphql', operation: 'GetPullRequestSlim', variables: { owner: 'acme', repo: row.expected, number: 21 } }])
  })

  it('PR の参照の形が誤っていると、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-READ-11')
    const workspace = await openWorkspace()
    const result = await workspace.run(['pr', 'read', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-READ-12')
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-READ-13')
    const workspace = await openWorkspace({ github: [rule({ operation: 'GetPullRequestSlim' }, { status: 502, body: { message: 'Bad Gateway' } })] })
    const result = await workspace.run(['pr', 'read', 'acme/demo/21'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: GraphQL query error: /u)
  })
})

// pr preflight

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
  return workspace.run(['pr', 'preflight', '-D', workspace.directory])
}

describe('pr preflight', () => {
  it('--directory でリポジトリを指すと、11 の節を決まった順で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-01')
    const workspace = await pushedBranch()
    const elsewhere = path.join(workspace.root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = await workspace.run(['pr', 'preflight', '-D', workspace.directory], elsewhere)
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
    const result = await workspace.run(['pr', 'preflight', '-D', workspace.directory], elsewhere)
    expect(result.stdout).toContain('=== Git Exclude ===\n# 目印の行\n.marker-exclude\n')
    expect(result.stdout).not.toContain('(no exclude)')
  })

  it('worktree を --directory に渡すと、Worktree Info の節に Is worktree environment: true を出す', async () => {
    const workspace = await pushedBranch()
    const worktree = path.join(workspace.root, 'linked')
    workspace.git(['worktree', 'add', '-q', '-b', 'linked-work', worktree])
    const elsewhere = path.join(workspace.root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = await workspace.run(['pr', 'preflight', '-D', worktree], elsewhere)
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

  it('warning があるときに打つと、11 の節を全部出す', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-02')
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(headingsOf(result.stdout)).toStrictEqual(SECTION_HEADINGS)
  })

  it.for([{ remote: 'origin' }, { remote: 'upstream' }])('remote が $remote だけだと、Base Branch の節に <remote>/<develop_branch> を出す', async (row, context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-03')
    const workspace = await pushedBranch()
    if (row.remote !== 'origin') workspace.git(['remote', 'rename', 'origin', row.remote])
    const result = await preflight(workspace)
    expect(result.stdout).toContain(`=== Base Branch ===\n${row.remote}/main\n`)
    expect(result.stdout).toContain(`=== Push Status ===\nin sync with ${row.remote}/${BRANCH}\n`)
  })

  it.for([
    { name: '下の段のブランチが remote にある', branches: [BRANCH, LOWER], expected: `origin/${LOWER}` },
    { name: '下の段のブランチが remote に無い', branches: [BRANCH], expected: 'origin/main' },
    { name: '下の段のブランチが remote から消え、手元に追跡参照が残っている', branches: [BRANCH, LOWER], remoteChange: 'delete', expected: 'origin/main' },
    { name: '下の段の追跡参照があり、remote に届かない', branches: [BRANCH, LOWER], remoteChange: 'unreachable', expected: `origin/${LOWER}` },
  ])('積んだ base の記録があり、$name ときに打つと、Base Branch の節に $expected を出す', async (row, context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-18')
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

  it('積んだ base の記録の形が誤っていると、終了コード 1 で終わる', async () => {
    const workspace = await pushedBranch({ files: MALFORMED_RECORD })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
  })

  it('打つと、count: preflight warnings の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-04')
    const workspace = await pushedBranch()
    const result = await preflight(workspace)
    expect(result.stderr).toBe('count: preflight warnings: 0\n')
  })

  it('warning があるときに打つと、warning ごとに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-05')
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual([
      'count: preflight warnings: 2',
      'warning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)',
      'warning: Git Status: modified or untracked files (fix: commit)',
    ])
  })

  it('常に、リポジトリとファイルを書き換えない', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-06')
    const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n', [stateFile('pr-create-slash-pending')]: '1\n' } })
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
  ])('ブランチが次の状態だと（$title）、Push Status の warning を数える', async (row, context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-07')
    const workspace = row.kind === 'unpushed' ? await openWorkspace({ branch: BRANCH }) : await pushedBranch()
    if (row.kind !== 'unpushed') workspace.git(['commit', '--allow-empty', '-q', '-m', 'local'])
    if (row.kind === 'diverged') {
      workspace.advanceRemote(BRANCH)
      workspace.git(['fetch', '-q', 'origin'])
    }
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', `warning: Push Status: ${row.expected} (fix: git push)`])
  })

  it('未コミットの変更があると、Git Status の warning を数える', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-08')
    const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Git Status: modified or untracked files (fix: commit)'])
  })

  it('stash に項目があると、Stash List の warning を数える', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-09')
    const workspace = await pushedBranch()
    writeFileSync(path.join(workspace.directory, 'README.md'), '変更\n')
    workspace.git(['stash', 'push', '-q'])
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Stash List: 1 stash entries (fix: check them)'])
    expect(result.stdout).toContain('=== Stash List ===\nstash@{0}: ')
  })

  it('warning が 1 件以上あると、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-10')
    const dirty = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const dirtyResult = await preflight(dirty)
    expect(dirtyResult.code).toBe(2)
    const clean = await pushedBranch()
    const cleanResult = await preflight(clean)
    expect(cleanResult.code).toBe(0)
  })

  it('git のリポジトリでないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-11')
    const workspace = await pushedBranch()
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(['pr', 'preflight', '-D', plain])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: not a git repository\n' })
  })

  it('git の remote が無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-12')
    const workspace = await pushedBranch()
    workspace.git(['remote', 'remove', 'origin'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: git remote not found\n' })
  })

  it('現在のブランチを決められないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-13')
    const workspace = await pushedBranch()
    const unborn = path.join(workspace.root, 'unborn')
    mkdirSync(unborn)
    workspace.git(['init', '-q', '-b', 'main'], unborn)
    workspace.git(['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'], unborn)
    const result = await workspace.run(['pr', 'preflight', '-D', unborn])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot determine the current branch\n' })
  })

  it('remote のリポジトリを決められないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-13')
    const workspace = await pushedBranch()
    workspace.git(['remote', 'set-url', 'origin', '/local/path/demo'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot read repository info from the remote URL\n  check it with: git remote -v\n' })
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-14')
    const workspace = await pushedBranch({ config: false })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: project config not found\n  activate a project with: pecot project activate <PROJECT>\n' })
  })

  it('develop_branch が設定に無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-15')
    const workspace = await pushedBranch({ config: NO_DEVELOP_BRANCH })
    const result = await preflight(workspace)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: develop_branch is not set for acme\/demo\n {2}set it with: pecot project set-repo acme\/demo --develop-branch develop\n$/u)
  })

  it('<remote>/<develop_branch> が無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-16')
    const workspace = await pushedBranch({ config: { developBranch: 'develop' } })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: branch origin/develop does not exist\n  check the remote branches with: git branch -r\n' })
  })

  it('--directory を渡していないと、使い方のエラーを出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-PREFLIGHT-17')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'preflight'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: pecot pr preflight [OPTIONS]')
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })
})

// pr cleanup

const MERGED = 'GetPullRequestSlim'

function kindRule(number: number, options: Readonly<{ subIssues?: number, issueType?: string }> = {}): ReturnType<typeof graphql> {
  return graphql('GetIssueKind', issueKindData({ number, ...options }), { variables: { number } })
}

function closeRule(number: number, status = 200): ReturnType<typeof rest> {
  return rest('PATCH', `/repos/acme/demo/issues/${String(number)}`, status, status === 200 ? { number, state: 'closed' } : { message: 'Server Error' })
}

function deleteRule(branch: string, status = 204, message?: string): ReturnType<typeof rest> {
  return rest('DELETE', `/repos/acme/demo/git/refs/heads/${branch}`, status, message === undefined ? undefined : { message })
}

function mergedRules(sample: Readonly<PullRequestSample> = {}, extra: ResponseRuleList = [kindRule(12), closeRule(12)]): ResponseRuleList {
  return [graphql(MERGED, pullRequestData(sample)), ...extra]
}

const ALL_FLAGS = ['.pecot-active', '.pecot-base', '.pecot-session-title', '.pecot-quick-mode', '.wip-branch-linked', 'merge-slash-pending']

function flagFiles(): Record<string, string> {
  return Object.fromEntries(ALL_FLAGS.map(name => [stateFile(name), 'x\n']))
}

function currentBranch(workspace: Readonly<Workspace>, cwd?: string): string {
  return workspace.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
}

function hasBranch(workspace: Readonly<Workspace>): boolean {
  return workspace.git(['branch', '--list', BRANCH]).trim() !== ''
}

function cleanupBranch(extra: Readonly<WorkspaceOptions> = {}): Promise<Workspace> {
  return openWorkspace({
    branch: BRANCH,
    branches: [{ name: BRANCH, commits: [{ message: '未マージの変更', files: { 'feature.txt': 'x\n' } }] }],
    ...extra,
  })
}

const CLEANUP = ['pr', 'cleanup', 'acme/demo/21']
// eslint-disable-next-line unicorn/no-null -- 応答の形（PR が無いと null）
const NO_PULL_REQUEST = { repository: { pullRequest: null } }

describe('pr cleanup', () => {
  it('マージ済みの PR の参照を渡すと、closing issues・本文の Closes / Fixes / Resolves・head ブランチ名の末尾の番号の Issue を close する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-01')
    const github = mergedRules({ closing: [[10, 'closing']], body: 'Fixes #11\n\nResolves #13\n\nCloses #14\n' }, [10, 11, 12, 13, 14].flatMap(number => [kindRule(number), closeRule(number)]))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    const closed = restRequests(workspace, 'PATCH')
    expect(closed).toMatchObject([10, 11, 12, 13, 14].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it.for([
    { title: 'Issue Type が Epic', options: { issueType: 'Epic' } },
    { title: 'sub-issue を持つ Issue', options: { subIssues: 3 } },
  ])('次の Issue があると（$title）、その Issue を close しない', async (row, context) => {
    await verifies(context, 'PW-PR-CLEANUP-02')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [[10, 'epic']] }, [kindRule(10, row.options), kindRule(12), closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    expect(result.stderr).toContain('count: Issues to close: 1\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('Issue の種別を読めないと、warning の行を出して、その Issue を Epic として守らずに close する', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [KIND_FAILURE, closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(KIND_WARNING_UNPROTECTED)
    expect(result.stderr).toMatch(/\ncount: Issues to close: 1\nclosed: Issue #12\n$/u)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
  })

  it('Epic か sub-issue を持つ Issue があると、skipped の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-03')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { subIssues: 1 })]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it('--delete-branch を付けて打つと、リモートの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-04')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '--delete-branch', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }, { path: `/repos/acme/demo/git/refs/heads/wip/${BRANCH}` }])
  })

  it('リモートの head ブランチを削除すると、続けて wip/<head> を削除する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-05')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(lines(result.stderr).slice(-2)).toStrictEqual([`deleted: remote branch ${BRANCH}`, `deleted: remote branch wip/${BRANCH}`])
  })

  it('カレントのリポジトリが PR のリポジトリと同じで worktree の外だと、develop_branch のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-06')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('set: current branch to main\n')
    expect(currentBranch(workspace)).toBe('main')
  })

  it('カレントが worktree だと、置き場所の親ディレクトリの名前の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-06')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt1', branch: 'wt1-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt1', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('カレントが worktree で add の記録があると、記録の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-06')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt2', branch: 'wt2-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt2', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const record = workspace.git(['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name'], worktree).trim()
    writeFileSync(record, 'wt1\n')
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('ブランチを切り替えると、origin の remote（無ければ最初の remote）から develop_branch を pull する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-07')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    workspace.advanceRemote('main')
    expect(workspace.git(['rev-parse', 'main'])).not.toBe(workspace.remoteGit(['rev-parse', 'main']))
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('updated: main from upstream/main\n')
    expect(workspace.git(['rev-parse', 'main'])).toBe(workspace.remoteGit(['rev-parse', 'main']))
  })

  it('pull すると、ローカルの head ブランチを git branch -D で削除する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-08')
    const workspace = await cleanupBranch({ github: mergedRules() })
    expect(hasBranch(workspace)).toBe(true)
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain(`deleted: local branch ${BRANCH}\n`)
    expect(hasBranch(workspace)).toBe(false)
  })

  it('ローカルの片付けを終えると、フラグのファイルと merge-slash-pending を消す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-09')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true, true, true, true, true])
    await workspace.run(CLEANUP)
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([false, false, false, false, false, false])
  })

  it('--skip-local-cleanup を付けて打つと、ローカルの片付けをしない', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-10')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(result.stderr).not.toContain('current branch')
  })

  it('--skip-local-cleanup を付けて打つと、フラグのファイルと merge-slash-pending を消さない', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-11')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true, true, true, true, true])
  })

  it('--dry-run を付けて打つと、何も変えずに dry-run: would の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-12')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    const files = filesOf(workspace.directory)
    const result = await workspace.run([...CLEANUP, '--dry-run', '--delete-branch'])
    expect(lines(result.stderr)).toStrictEqual([
      'count: Issues to close: 1',
      'dry-run: would close Issue #12',
      `dry-run: would delete remote branch ${BRANCH}`,
      'dry-run: would set current branch to main',
      'dry-run: would update main from origin/main',
      `dry-run: would delete local branch ${BRANCH}`,
    ])
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
    expect(restRequests(workspace, 'DELETE')).toStrictEqual([])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('実行すると、close する Issue の件数を count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-13')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [[10, 'a']] }, [kindRule(10), closeRule(10), kindRule(12), closeRule(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr.startsWith('count: Issues to close: 2\n')).toBe(true)
  })

  it('Issue を close すると、closed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-14')
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 1\nclosed: Issue #12\n')
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-15')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチが既に無いと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-16')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH, 422, 'Reference does not exist'), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`unchanged: remote branch ${BRANCH} (already deleted)\n`)
  })

  it('ローカルの head ブランチが既に無いなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-17')
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`\\nwarning: deleting local branch ${BRANCH} failed: .*\\n$`, 'u'))
  })

  it('--delete-branch を付けてローカルの片付けも通すと、結果の行を実行した順で標準エラーへ出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-04')
    await verifies(context, 'PW-PR-CLEANUP-13')
    await verifies(context, 'PW-PR-CLEANUP-14')
    await verifies(context, 'PW-PR-CLEANUP-15')
    const workspace = await cleanupBranch({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.split('\n')).toStrictEqual([
      'count: Issues to close: 1',
      'closed: Issue #12',
      `deleted: remote branch ${BRANCH}`,
      `deleted: remote branch wip/${BRANCH}`,
      'set: current branch to main',
      'updated: main from origin/main',
      `deleted: local branch ${BRANCH}`,
      '',
    ])
  })

  it('origin の develop_branch が無く pull に失敗すると、warning の行を出したうえで、ローカルの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-17')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.remoteGit(['update-ref', '-d', 'refs/heads/main'])
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    const output = lines(result.stderr)
    expect(output.slice(0, 3)).toStrictEqual(['count: Issues to close: 1', 'closed: Issue #12', 'set: current branch to main'])
    const pulling = output.findIndex(line => line.startsWith('warning: pulling main failed: '))
    expect(pulling).toBe(3)
    expect(output.at(-1)).toBe(`deleted: local branch ${BRANCH}`)
    expect(hasBranch(workspace)).toBe(false)
    expect(result.stderr).not.toContain('updated:')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-18')
    const github = [graphql(MERGED, pullRequestData({ closing: [], body: '', head: 'feat/other' }))]
    const workspace = await cleanupBranch({ github })
    const result = await workspace.run(['pr', 'cleanup', 'acme/other/21'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup\n')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、ローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-19')
    const github = [graphql(MERGED, pullRequestData({ closing: [], body: '', head: BRANCH }))]
    const workspace = await cleanupBranch({ github })
    const result = await workspace.run(['pr', 'cleanup', 'acme/other/21'])
    expect(result.stderr).not.toContain('current branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
  })

  it('Issue の close に失敗したなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-20')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12, 500)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/\nwarning: closing Issue #12 failed: /u)
  })

  it('Issue の close に失敗したなら、ほかの Issue と後の処理を続ける', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-21')
    const github = mergedRules({ closing: [[10, 'a']] }, [kindRule(10), closeRule(10, 500), kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`)])
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('closed: Issue #12\n')
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチの削除に失敗したなら、wip/<head> の削除を飛ばす', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-22')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH, 403, 'Forbidden'), deleteRule(`wip/${BRANCH}`)]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch ${BRANCH} failed: `)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(1)
  })

  it('checkout に失敗したなら、pull と git branch -D を飛ばす', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-23')
    const workspace = await cleanupBranch({ config: { developBranch: 'ghost' }, github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: checking out ghost failed: ')
    expect(result.stderr).not.toContain('updated:')
    expect(result.stderr).not.toContain('deleted: local branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
  })

  it('PR がマージされていないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-24')
    const workspace = await openWorkspace({ github: mergedRules({ state: 'OPEN' }) })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR #21 is not merged yet (state: OPEN); merge it with gh pr merge first\n' })
  })

  it('PR がマージされていないなら、何も変えない', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-25')
    const workspace = await cleanupBranch({ github: mergedRules({ state: 'OPEN' }), files: flagFiles() })
    const files = filesOf(workspace.directory)
    await workspace.run([...CLEANUP, '-d'])
    expect(operationsOf(workspace)).toStrictEqual([MERGED])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('アクティブなプロジェクトが無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-26')
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it.for([
    { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'error: PR not found: acme/demo/21\n' },
    { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'error: GraphQL query error: ' },
  ])('次の場合は（$title）、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CLEANUP-27')
    const workspace = await openWorkspace({ github: row.rules })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(row.expected)).toBe(true)
  })

  it('PR の参照の形が誤っているなら、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-28')
    const workspace = await openWorkspace()
    const result = await workspace.run(['pr', 'cleanup', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  it('wip/<head> のリモートブランチが無いなら、何も出さない', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-29')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`, 422, 'Reference does not exist')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(2)
    expect(result.stderr).not.toContain('wip/')
  })

  it('wip/<head> があるのに削除できなかったなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CLEANUP-30')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12), deleteRule(BRANCH), deleteRule(`wip/${BRANCH}`, 403, 'Forbidden')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch wip/${BRANCH} failed: `)
  })
})
