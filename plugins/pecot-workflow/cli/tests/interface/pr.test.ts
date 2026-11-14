/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr の 3 コマンド（PW-PR-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { installFakeExecutable, prependToPath } from '../../src/tests/_helpers/fake-executables.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { verifies } from '../_helpers/verifies.js'
import { filesOf, KIND_FAILURE, lines, operationsOf, restRequests, stateFile } from '../_helpers/workspace-inspect.js'
import { graphql, HOST, issueKindData, openWorkspace, pullRequestData, rest, rule } from '../_helpers/workspace.js'
import type { ConfigOptions, PullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'

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
const KIND_WARNING_FILL = /^warning: kind check of Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; fill Closes by hand\n/mu
const CREATED_RULE = rest('POST', '/repos/acme/demo/pulls', 201, { number: 21, html_url: PULL_URL })
const NOT_EPIC_RULE = graphql('GetIssueKind', issueKindData({ number: 12 }), { variables: { number: 12 } })
const SUBMIT_RULES: ResponseRuleList = [NOT_EPIC_RULE, CREATED_RULE, ...IN_REVIEW_RULES]

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
    const workspace = await pushedBranch({ github: [KIND_FAILURE, CREATED_RULE, ...IN_REVIEW_RULES] })
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
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...IN_REVIEW_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.code).toBe(0)
    expect(postedBody(workspace)['body']).toBe(BODY_WITH_REFERENCE_ONLY.trimEnd())
  })

  it('ファイルで作るとき末尾の番号の Issue が Epic だと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-17')
    const workspace = await pushedBranch({ github: [graphql('GetIssueKind', issueKindData({ number: 12, subIssues: 2 })), CREATED_RULE, ...IN_REVIEW_RULES] })
    const file = writePrFile(workspace, { body: BODY_WITH_REFERENCE_ONLY })
    const result = await workspace.run(['pr', 'create', file])
    expect(result.stderr).toContain('warning: Issue #12 at the end of the branch is an Epic; Closes not added\n')
  })

  it('--no-issue-ref を付けて打つと、Closes を足さず、Issue の参照の確認もしない', async (context) => {
    await verifies(context, 'PW-PR-CREATE-18')
    const workspace = await pushedBranch({ github: [CREATED_RULE, ...IN_REVIEW_RULES] })
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
    expect(result.stderr).toBe('error: Summary has no image and `screenshot` gives no reason to omit one. If the change alters a screen, Markdown the tool writes for GitHub, or CLI output text, take a screenshot and add it to Summary as `![alt](./<file>.png)`. Otherwise, write the reason in the `screenshot` frontmatter field (`--screenshot` with `--message`)\n')
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
    const workspace = await pushedBranch({ github: [CREATED_RULE, empty] })
    const result = await workspace.run(messageArguments(['--no-issue-ref']))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${PULL_URL}\n`)
    expect(result.stderr).toContain('warning: Issue #12 is not on the board; status not updated\n')
  })

  it('ボードの status の更新で GitHub API がエラーを返すと、PR は作ったまま warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CREATE-39')
    const failing = rule({ operation: 'UpdateProjectItemField' }, { status: 500, body: { message: 'Server Error' } })
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, CREATED_RULE, ...IN_REVIEW_RULES.slice(0, 1), failing] })
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
    expect(result.stderr).toBe('error: missing arguments\n  usage:\n  pecot pr create --prepare\n  pecot pr create <path>\n  pecot pr create --message <body> --title <title> --base <base-branch>\n')
  })

  it.for([
    { title: '-t', argv: ['pr', 'create', '-m', 'x', '-b', 'main'] },
    { title: '-b', argv: ['pr', 'create', '-m', 'x', '-t', 'x'] },
  ])('-m に $title を渡さないと、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-PR-CREATE-44')
    const workspace = await pushedBranch()
    const result = await workspace.run(row.argv)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: --title and --base (base branch) are required with --message\n' })
  })

  it('ファイルと一緒に --screenshot を渡すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CREATE-45')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'create', writePrFile(workspace), '--screenshot', '理由'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: --screenshot is for --message; write the reason in the `screenshot` frontmatter field instead\n$/u)
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
    { title: '設定のリポジトリが 2 つで --repo も無い', config: { hasSecondRepository: true }, repo: [], expected: 'error: specify the repository (--repo <owner/repo>)\n' },
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
    const workspace = await pushedBranch({ github: [NOT_EPIC_RULE, created, ...IN_REVIEW_RULES] })
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
  threads: [{ isResolved: false, path: 'src/a.ts', line: 10, comments: { nodes: [{ author: { login: 'reviewer' }, body: '名前を直す', createdAt: '2026-01-02T03:04:05Z' }] } }],
}

describe('pr show', () => {
  it('PR の参照を渡すと、見出し・状態・ブランチ・本文を Markdown で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-SHOW-01')
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
  ])('関連 Issue がある PR を読むと、$title を出す', async (row, context) => {
    await verifies(context, 'PW-PR-SHOW-02')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData({ state: 'OPEN', body: row.body }))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.stdout).toContain(row.expected)
  })

  it('レビューがある PR を読むと、レビューごとの author と状態を出す', async (context) => {
    await verifies(context, 'PW-PR-SHOW-03')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestSlim', pullRequestData(FULL_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.stdout).toContain('**Reviews:**\n  - reviewer: APPROVED\n')
    expect(result.stdout).toContain('**State:** OPEN | **Draft** | **Mergeable:** MERGEABLE | **Comments:** 2')
  })

  it('--reviews を付けて打つと、レビューの本文と行のコメントを足して出す', async (context) => {
    await verifies(context, 'PW-PR-SHOW-04')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout).toContain('### @reviewer (CHANGES_REQUESTED) - 2026-01-02\n\n直してください。\n')
    expect(result.stdout).toContain('### `src/a.ts:10` [Open]\n\n**@reviewer** (2026-01-02):\n> 名前を直す\n')
  })

  it.for([
    { title: 'レビューがあれば ## Reviews の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: 'レビューが無ければ ## Reviews の節を出さない', sample: { state: 'OPEN' }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row, context) => {
    await verifies(context, 'PW-PR-SHOW-05')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(row.sample))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--reviews'])
    expect(result.stdout.includes('## Reviews\n')).toBe(row.isShown)
  })

  it.for([
    { title: '行のコメントがあれば ## Line Comments の節を出す', sample: REVIEW_SAMPLE, isShown: true },
    { title: '行のコメントが無ければ ## Line Comments の節を出さない', sample: { state: 'OPEN', reviews: REVIEW_SAMPLE.reviews ?? [], threads: [] }, isShown: false },
  ])('--reviews を付けて打つと、$title', async (row, context) => {
    await verifies(context, 'PW-PR-SHOW-06')
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

  it('--json を付けて打つと、同じ内容を JSON で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-SHOW-08')
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

  it('--json と --reviews を一緒に付けて打つと、JSON にレビューと行のコメントを含める', async (context) => {
    await verifies(context, 'PW-PR-SHOW-09')
    const workspace = await openWorkspace({ github: [graphql('GetPullRequestWithReviews', pullRequestData(REVIEW_SAMPLE))] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21', '--json', '--reviews'])
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviews: [{ state: 'CHANGES_REQUESTED', author: 'reviewer', body: '直してください。', submitted_at: '2026-01-02T03:04:05Z' }],
      review_threads: [{ is_resolved: false, path: 'src/a.ts', line: 10, comments: [{ author: 'reviewer', body: '名前を直す', created_at: '2026-01-02T03:04:05Z' }] }],
    })
  })

  it.for([
    { title: '--repo（git の remote と違う値）', argv: ['--repo', 'acme/other', 'pr', 'show', '21'], remote: 'origin', expected: 'other' },
    { title: 'origin の remote', argv: ['pr', 'show', '21'], remote: 'origin', expected: 'demo' },
    { title: 'origin が無いときの upstream の remote', argv: ['pr', 'show', '21'], remote: 'upstream', expected: 'upstream-repo' },
  ])('短い形 N の参照を渡すと、$title で補って読む', async (row, context) => {
    await verifies(context, 'PW-PR-SHOW-10')
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
    await verifies(context, 'PW-PR-SHOW-11')
    const workspace = await openWorkspace()
    const result = await workspace.run(['pr', 'show', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-SHOW-12')
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-SHOW-13')
    const workspace = await openWorkspace({ github: [rule({ operation: 'GetPullRequestSlim' }, { status: 502, body: { message: 'Bad Gateway' } })] })
    const result = await workspace.run(['pr', 'show', 'acme/demo/21'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: GraphQL query error: /u)
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

describe('pr check', () => {
  it('--directory でリポジトリを指すと、11 の節を決まった順で標準出力に出す', async (context) => {
    await verifies(context, 'PW-PR-CHECK-01')
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

  it('warning があるときに打つと、11 の節を全部出す', async (context) => {
    await verifies(context, 'PW-PR-CHECK-02')
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(result.code).toBe(2)
    expect(headingsOf(result.stdout)).toStrictEqual(SECTION_HEADINGS)
  })

  it.for([{ remote: 'origin' }, { remote: 'upstream' }])('remote が $remote だけだと、Base Branch の節に <remote>/<develop_branch> を出す', async (row, context) => {
    await verifies(context, 'PW-PR-CHECK-03')
    const workspace = await pushedBranch()
    if (row.remote !== 'origin') workspace.git(['remote', 'rename', 'origin', row.remote])
    const result = await preflight(workspace)
    expect(result.stdout).toContain(`=== Base Branch ===\n${row.remote}/main\n`)
    expect(result.stdout).toContain(`=== Push Status ===\nin sync with ${row.remote}/${BRANCH}\n`)
  })

  it('打つと、count: preflight warnings の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CHECK-04')
    const workspace = await pushedBranch()
    const result = await preflight(workspace)
    expect(result.stderr).toBe('count: preflight warnings: 0\n')
  })

  it('warning があるときに打つと、warning ごとに warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PR-CHECK-05')
    const workspace = await openWorkspace({ branch: BRANCH, files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual([
      'count: preflight warnings: 2',
      'warning: Push Status: origin/feat/demo/12 does not exist (not pushed) (fix: git push)',
      'warning: Git Status: modified or untracked files (fix: commit)',
    ])
  })

  it('常に、リポジトリとファイルを書き換えない', async (context) => {
    await verifies(context, 'PW-PR-CHECK-06')
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
    await verifies(context, 'PW-PR-CHECK-07')
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
    await verifies(context, 'PW-PR-CHECK-08')
    const workspace = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Git Status: modified or untracked files (fix: commit)'])
  })

  it('stash に項目があると、Stash List の warning を数える', async (context) => {
    await verifies(context, 'PW-PR-CHECK-09')
    const workspace = await pushedBranch()
    writeFileSync(path.join(workspace.directory, 'README.md'), '変更\n')
    workspace.git(['stash', 'push', '-q'])
    const result = await preflight(workspace)
    expect(lines(result.stderr)).toStrictEqual(['count: preflight warnings: 1', 'warning: Stash List: 1 stash entries (fix: check them)'])
    expect(result.stdout).toContain('=== Stash List ===\nstash@{0}: ')
  })

  it('warning が 1 件以上あると、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-10')
    const dirty = await pushedBranch({ files: { 'memo.txt': 'x\n' } })
    const dirtyResult = await preflight(dirty)
    expect(dirtyResult.code).toBe(2)
    const clean = await pushedBranch()
    const cleanResult = await preflight(clean)
    expect(cleanResult.code).toBe(0)
  })

  it('git のリポジトリでないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-11')
    const workspace = await pushedBranch()
    const plain = path.join(workspace.root, 'plain')
    mkdirSync(plain)
    const result = await workspace.run(['pr', 'check', '-D', plain])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: not a git repository\n' })
  })

  it('git の remote が無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-12')
    const workspace = await pushedBranch()
    workspace.git(['remote', 'remove', 'origin'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: git remote not found\n' })
  })

  it('現在のブランチを決められないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-13')
    const workspace = await pushedBranch()
    const unborn = path.join(workspace.root, 'unborn')
    mkdirSync(unborn)
    workspace.git(['init', '-q', '-b', 'main'], unborn)
    workspace.git(['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'], unborn)
    const result = await workspace.run(['pr', 'check', '-D', unborn])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot determine the current branch\n' })
  })

  it('remote のリポジトリを決められないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-13')
    const workspace = await pushedBranch()
    workspace.git(['remote', 'set-url', 'origin', '/local/path/demo'])
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: cannot read repository info from the remote URL\n  check it with: git remote -v\n' })
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-14')
    const workspace = await pushedBranch({ config: false })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: project config not found\n  activate a project with: pecot project activate <PROJECT>\n' })
  })

  it('develop_branch が設定に無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-15')
    const workspace = await pushedBranch({ config: NO_DEVELOP_BRANCH })
    const result = await preflight(workspace)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: develop_branch is not set for acme\/demo\n {2}set it with: pecot project link acme\/demo --develop-branch develop\n$/u)
  })

  it('<remote>/<develop_branch> が無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-16')
    const workspace = await pushedBranch({ config: { developBranch: 'develop' } })
    const result = await preflight(workspace)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: branch origin/develop does not exist\n  check the remote branches with: git branch -r\n' })
  })

  it('--directory を渡していないと、使い方のエラーを出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-PR-CHECK-17')
    const workspace = await pushedBranch()
    const result = await workspace.run(['pr', 'check'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: pecot pr check [OPTIONS]')
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })
})
