/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SESSION_TOOLS } from '../../src/commands/session.js'
import { installFakeExecutable } from '../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { TargetSpec } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { INVALID_DIRECTORY_CASES, isRoot, unlock } from '../_helpers/directory-option-case.js'
import { CONFIG_FILE, issueFailure, issueResponse, prepareSession, separateRepository } from '../_helpers/session-case.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'
import { explains } from '../_helpers/explains.js'

useIsolatedEnvironment()

const HEADER = '# Session status\n\n'
const SUMMARY = `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Active Issue: acme/demo#7\n`

async function status(directory: string): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess('session_show', { directory: directory }, SESSION_TOOLS)
}

const pullRequest = (number: number, state: string, isCrossRepository = false): Record<string, unknown> => ({
  number, state, headRefName: 'feat/3', baseRefName: 'main', isDraft: false, isCrossRepository, repository: { owner: { login: 'acme' }, name: 'demo' },
})
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
const pullRequests = (...nodes: readonly Record<string, unknown>[]): ResponseRule => ({
  match: { operation: 'ListPullRequestsByHead' },
  respond: { status: 200, body: { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } } },
  times: 1,
})
const above = (number: number, head: string, isCrossRepository = false): Record<string, unknown> => ({ ...pullRequest(number, 'OPEN', isCrossRepository), headRefName: head, baseRefName: 'feat/demo/7' })
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
const stackedAbove = (...nodes: readonly Record<string, unknown>[]): ResponseRule => ({
  match: { operation: 'ListPullRequestsByBase' },
  respond: { status: 200, body: { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } } },
  times: 1,
})
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの規則は入れ子が深く、読むだけ
const rules = (spec: Partial<TargetSpec>, ...nodes: readonly Record<string, unknown>[]): ResponseRule[] => [
  issueResponse({ number: 7, title: 't' }), pullRequests(...nodes), prerequisitesRule({ number: 7, ...spec }), stackedAbove(),
]

function operationsOf(github: Readonly<RunningGithub>): readonly string[] {
  return github.requests().map(request => request.type === 'graphql' ? request.operation : request.path)
}

// main の上に親ブランチ feat/3 のコミットを置き、追跡参照を向ける。isStacked なら今のブランチをその上に載せる
function prepareLower(isStacked: boolean): string {
  const { repository } = prepareSession({ baseRecord: false })
  gitForTest(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  gitForTest(repository, ['checkout', '-q', '-b', 'lower', 'HEAD'])
  writeFileSync(path.join(repository, 'lower.txt'), '1\n')
  gitForTest(repository, ['add', 'lower.txt'])
  gitForTest(repository, ['commit', '-q', '-m', 'lower'])
  gitForTest(repository, ['update-ref', 'refs/remotes/origin/feat/3', 'HEAD'])
  gitForTest(repository, ['checkout', '-q', 'feat/demo/7'])
  if (isStacked) gitForTest(repository, ['reset', '-q', '--hard', 'lower'])
  return repository
}

/**
origin の `git@ghes.example.com:acme/demo.git` を、偽の ssh で一時の bare リポにつなぐ。bare のパスを返す
*/
function sshOrigin(): string {
  const remotes = makeTemporaryDirectory('pecot-remotes-')
  const bare = path.join(remotes, 'acme', 'demo.git')
  mkdirSync(bare, { recursive: true })
  gitForTest(bare, ['init', '-q', '--bare'])
  const bin = makeTemporaryDirectory('pecot-ssh-')
  // git が ssh として呼ぶ形は `fake-ssh <host> <git-upload-pack 'acme/demo.git'>`。host は見ず、bare に向ける
  const body = `cmd="$(eval "printf '%s\\n' $(printf '%s' "$2" | sed 's/^[^ ]* //')")"\nprog="\${2%% *}"\nexec git "\${prog#git-}" '${remotes}'/"$cmd"\n`
  setEnvironment({ GIT_SSH: installFakeExecutable(bin, 'fake-ssh', body), GIT_SSH_VARIANT: 'simple' })
  return bare
}

async function showTool(directory: string): Promise<ToolOutcome> {
  return await callToolOnce(SESSION_TOOLS, 'session_show', { directory })
}

function failingOn(operation: string): ResponseRule {
  return { match: { operation }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
}

describe('session_show', () => {
  it('directory を渡すと、ブランチ・リポジトリ・remote とブランチ名から求めた作業中の Issue を標準出力に出し、フラグの表を出さない', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await explains('`session_show` の `directory` を実行した場合のテストです。ブランチ名と remote から求めた作業中の Issue を標準出力に表示し、フラグの表を表示しないことを確認します。')
    const { repository } = prepareSession()
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result).toEqual({ code: 0, stdout: `${SUMMARY}\n## Active Issue\n\n#7 t (OPEN)\n`, stderr: '' })
  })

  it('作業中の Issue を、読んだ Issue の番号・題名・状態と本文で Active Issue の節に出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-06')
    await explains('作業中の Issue の表示のテストです。GitHub から読み取った Issue の番号・題名・状態と本文が、`Active Issue` の節に表示されることを確認します。')
    const { repository } = prepareSession()
    const github = await startGithub([issueResponse({ number: 7, title: '見本の Issue', body: '本文の 1 行目\n本文の 2 行目\n' }), stackedAbove()])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${SUMMARY}\n## Active Issue\n\n#7 見本の Issue (OPEN)\n\n本文の 1 行目\n本文の 2 行目\n`)
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 0 } },
      { type: 'graphql', operation: 'ListPullRequestsByBase', variables: { owner: 'acme', repo: 'demo', baseRefName: 'feat/demo/7' } },
    ])
  })

  it('本文が空の Issue は、題名の行までで Active Issue の節を終える', async () => {
    await explains('本文が空の Issue を作業中の Issue にした場合のテストです。`Active Issue` の節が、題名と状態の行で終わることを確認します。')
    const { repository } = prepareSession()
    await startGithub([issueResponse({ number: 7, title: '題名だけ', state: 'CLOSED' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout.endsWith('\n## Active Issue\n\n#7 題名だけ (CLOSED)\n')).toBe(true)
  })

  it('別の番号の古い .pecot-active が残っていても読まず、ブランチ名の番号の Issue を出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-31')
    await explains('別の番号の古い `.pecot-active` が残っている場合のテストです。そのファイルは読み取らず、ブランチ名の番号（`7`）の Issue が表示されることを確認します。')
    const { repository } = prepareSession({ files: { '.pecot/state/.pecot-active': 'acme/demo/99\n' } })
    const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout).toBe(`${SUMMARY}\n## Active Issue\n\n#7 t (OPEN)\n`)
    expect(github.requests()).toMatchObject([{ operation: 'GetIssueSlim', variables: { number: 7 } }, { operation: 'ListPullRequestsByBase' }])
  })

  it('ブランチ名を読めないとき、Branch の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-08')
    await explains('Git リポジトリの外のディレクトリを指定した場合のテストです。`Branch` と `Repository` の行に `unknown` を、`Active Issue` の行に `none` を表示し、処理を続行することを確認します。')
    prepareSession()
    const outsideGit = makeTemporaryDirectory('pecot-plain-')

    const result = await status(outsideGit)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${HEADER}- Branch: unknown\n- Repository: unknown\n- Active Issue: none\n`)
  })

  it('origin も他の remote も無いとき、Repository の行に unknown を、Active Issue の行に none を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-10')
    await explains('origin も他の remote も存在しない場合のテストです。`Repository` の行に `unknown` を、`Active Issue` の行に `none` を表示し、処理を続行することを確認します。')
    const { repository } = prepareSession({ remotes: {} })

    const result = await status(repository)

    expect(result).toEqual({ code: 0, stdout: `${HEADER}- Branch: feat/demo/7\n- Repository: unknown\n- Active Issue: none\n`, stderr: '' })
  })

  it('remote の URL の形が合わないとき、Active Issue の行に none を出す', async () => {
    await explains('remote の URL の形式が不正な場合のテストです。`Active Issue` の行に `none` が表示され、終了コード 0 で終了することを確認します。')
    const { repository } = prepareSession({ remotes: { origin: 'not-a-url' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Active Issue: none\n')
  })

  it('origin が無くても、最初の remote のリポジトリを出し、そのリポジトリの Issue を作業中の Issue にする', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await explains('origin が存在せず、別の remote だけがある場合のテストです。最初の remote のリポジトリが表示され、そのリポジトリの Issue が作業中の Issue になることを確認します。')
    const { repository } = prepareSession({ remotes: { upstream: 'https://ghes.example.com/acme/other.git' }, repositories: ['other'] })
    const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout).toContain('- Repository: acme/other\n- Active Issue: acme/other#7\n')
    expect(github.requests()).toMatchObject([{ operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'other', number: 7 } }, { operation: 'ListPullRequestsByBase' }])
  })

  it.for([
    { branch: 'feat/no-number' },
    { branch: 'feat/demo/7a' },
    { branch: 'feat/demo/0' },
    { branch: 'wt4' },
  ])('ブランチ名 $branch の末尾が番号でないとき、Active Issue の行に none を出して続ける', async ({ branch }, context) => {
    await verifies(context, 'PW-SESSION-SHOW-12')
    await explains(`ブランチ名が \`${branch}\` の場合のテストです。末尾が番号でないため、\`Active Issue\` の行に \`none\` を表示し、\`Active Issue\` の節は表示しないことを確認します。`)
    const { repository } = prepareSession({ branch })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Active Issue: none\n')
    expect(result.stdout).not.toContain('## Active Issue')
  })

  it('作業中の Issue があるのに、そのリポを含む設定が 2 つあり .active も選べないとき、節を出さずに warning を標準エラーに出す', async () => {
    await explains('そのリポジトリを含むプロジェクトの設定が 2 つあり、`.active` でも選べない場合のテストです。`Active Issue` の節を表示せず、警告を標準エラーに出力して終了コード 0 で終了することを確認します。')
    const { project, repository } = prepareSession()
    makeAmbiguous(project)

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toBe('warning: cannot read the active Issue: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n')
  })

  it('作業中の Issue があるのに、そのリポを含む設定が無いとき、節を出さずに warning を標準エラーに出して終了コード 0 で終わる', async () => {
    await explains('そのリポジトリを含むプロジェクトの設定が存在しない場合のテストです。`Active Issue` の節を表示せず、警告を標準エラーに出力して終了コード 0 で終了することを確認します。')
    const { repository } = prepareSession({ repositories: ['other'] })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toBe('warning: cannot read the active Issue: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
  })

  it('project を渡すと、そのリポを含む設定が 2 つあってもその設定で作業中の Issue を読む', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-40')
    await explains('`project` を指定した場合のテストです。そのリポジトリを含む設定が 2 つあっても、指定した設定で作業中の Issue を読み取り、警告が出力されないことを確認します。')
    const { project, repository } = prepareSession()
    makeAmbiguous(project)
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await runInProcess('session_show', { directory: repository, project: SECOND_PROJECT }, SESSION_TOOLS)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Active Issue')
    expect(result.stderr).toBe('')
  })

  it('.active が無くても、そのリポを含む設定が 1 つならその設定で作業中の Issue を読む', async () => {
    await explains('`.active` が存在しない場合のテストです。そのリポジトリを含む設定が 1 つだけなら、その設定で作業中の Issue を読み取り、警告が出力されないことを確認します。')
    const { project, repository } = prepareSession()
    removeActive(project)
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Active Issue')
    expect(result.stderr).toBe('')
  })

  it('作業中の Issue があるのに Issue を GitHub から読めないとき、節を出さずに warning を標準エラーに出す', async () => {
    await explains('作業中の Issue を GitHub から取得できない（HTTP 502 を返す）場合のテストです。`Active Issue` の節を表示せず、`502` を含む警告を標準エラーに出力することを確認します。')
    const { repository } = prepareSession()
    await startGithub([issueFailure(502)])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: .*502/u)
  })

  it('directory が空文字のとき、cwd を対象にして終了コード 0 で終わる', async () => {
    await explains('`directory` に空文字を指定した場合のテストです。現在のディレクトリを対象にして、終了コード 0 でセッションの状態を表示することを確認します。')
    prepareSession()
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status('')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('# Session status')
    expect(result.stdout).toContain('- Branch: feat/demo/7')
  })

  it('directory がファイルとディレクトリのどちらでもないパスのとき、Usage ではなく error の 1 行を出して終了コード 1 で終わる', async () => {
    await explains('`directory` に、ファイルとディレクトリのどちらにも該当しないパス（`/dev/null`）を指定した場合のテストです。Usage ではなく `error:` で始まる 1 行を標準エラーに出力して、終了コード 1 で終了することを確認します。')
    prepareSession()

    const result = await status('/dev/null')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: [^\n]+\n$/u)
    expect(result.stderr).not.toContain('Invalid value')
  })

  it('アクティブな設定ファイルの形式が不正なとき、warning を標準エラーに出して終了コード 0 で終わる', async () => {
    await explains('アクティブな設定ファイルの形式が不正な場合のテストです。`Active Issue` の節を表示せず、警告を標準エラーに出力して終了コード 0 で終了することを確認します。')
    const { repository } = prepareSession({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: '{"host":"github.com"}' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: invalid config file/u)
  })

  describe('Stack の節', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }
    const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
    it('スタックして着手した作業ディレクトリでは、スタック先の Issue と PR を Stack の節に出す', async () => {
      await explains('スタックして着手した作業ディレクトリでのテストです。スタック先の Issue と PR が `Stack` の節に表示され、`readiness:` の行は表示されないことを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
      expect(result.stdout).not.toContain('readiness:')
    })

    it.for([
      { name: '親ブランチの remote の先頭が記録と同じ', scene: 'same', state: 'OPEN', expected: 'no', id: 'PW-SESSION-SHOW-28' },
      { name: '親ブランチの remote の先頭が記録と違い、追跡参照が古いまま', scene: 'moved', state: 'OPEN', expected: 'yes', id: 'PW-SESSION-SHOW-28' },
      { name: '親 PR がマージ済み', scene: 'same', state: 'MERGED', expected: 'yes', id: 'PW-SESSION-SHOW-28' },
      { name: '親 PR がマージ済みで、ブランチが開発ブランチの上に載り終えていて記録だけが古い', scene: 'rebased', state: 'MERGED', expected: 'no', id: 'PW-SESSION-SHOW-34' },
    ])('$name と、Stack の節に needs restack: $expected の行を出し、MCP の stack の needsRestack も合わせる', async (row, context) => {
      await verifies(context, row.id)
      await explains(`親ブランチの remote の状態と親 PR の状態を変えた場合のテストです。\`Stack\` の節に \`needs restack: ${row.expected}\` の行を表示し、MCP の \`stack\` の \`needsRestack\` も同じ結果になることを確認します。`)
      const bare = sshOrigin()
      const { project, repository } = prepareSession({ remotes: { origin: 'git@ghes.example.com:acme/demo.git' } })
      gitForTest(repository, ['push', '-q', bare, 'HEAD:refs/heads/feat/3'])
      const head = gitForTest(repository, ['rev-parse', 'HEAD']).trim()
      let recorded = head
      if (row.scene === 'moved') {
        gitForTest(repository, ['update-ref', 'refs/remotes/origin/feat/3', head])
        const tree = gitForTest(bare, ['rev-parse', 'feat/3^{tree}']).trim()
        gitForTest(bare, ['update-ref', 'refs/heads/feat/3', gitForTest(bare, ['commit-tree', tree, '-p', 'feat/3', '-m', 'advance']).trim()])
      }
      else if (row.scene === 'rebased') {
        // 記録は、手元が知っていて HEAD の履歴に無い古い親ブランチ。開発ブランチの追跡参照は HEAD を指す
        recorded = gitForTest(repository, ['commit-tree', [head, '^{tree}'].join(''), '-p', head, '-m', 'old lower']).trim()
        gitForTest(repository, ['update-ref', 'refs/remotes/origin/main', head])
      }
      mkdirSync(path.join(project.root, '.pecot/state'), { recursive: true })
      writeFileSync(path.join(project.root, '.pecot/state/.pecot-base'), `feat/3 ${recorded} acme/demo#3\n`)
      const github = (): ResponseRule[] => [issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, row.state)), prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()]
      await startGithub(github())

      const result = await status(repository)

      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith(`\n## Stack\n- base: feat/3 (#3, PR #30 ${row.state})\n- needs restack: ${row.expected}\n`)).toBe(true)
      await startGithub(github())
      const outcome = await showTool(repository)
      expect(outcome.structured['stack']).toMatchObject({ branch: 'feat/3', needsRestack: row.expected === 'yes' })
    })

    it('open の PR が無ければ fork でない最新の PR を、PR が無ければ no PR を出す', async () => {
      await explains('スタック先のブランチに、open の PR が存在しない場合のテストです。fork ではない最新の PR を表示し、PR が 1 つもない場合は `no PR` を表示することを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(32, 'OPEN', true), pullRequest(31, 'MERGED'), pullRequest(29, 'CLOSED')))
      const merged = await status(repository)
      expect(merged.stdout).toContain('- base: feat/3 (#3, PR #31 MERGED)\n')

      await startGithub(rules({ blockedBy: [inReview] }))
      const none = await status(repository)
      expect(none.stdout).toContain('- base: feat/3 (#3, no PR)\n')
    })

    it('着手中の Issue の判定が blocked なら、readiness の行を足す', async () => {
      await explains('着手中の Issue の判定が `blocked` の場合のテストです。`Stack` の節に `readiness` の行が追加されることを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [{ number: 3, title: '未着手' }] }, pullRequest(30, 'CLOSED')))

      const result = await status(repository)

      expect(result.stdout.endsWith('- base: feat/3 (#3, PR #30 CLOSED)\n- readiness: blocked by #3 (not in review: #3 (not started))\n')).toBe(true)
    })

    it('PR を読めなければ warning を出し、PR unknown と出す', async () => {
      await explains('スタック先のブランチの PR を取得できない場合のテストです。警告を標準エラーに出力し、`Stack` の節に `PR unknown` と表示することを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), failing, prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('- base: feat/3 (#3, PR unknown)\n')
      expect(result.stderr).toMatch(/^warning: cannot read the PR of the base branch: .+500/u)
    })

    it('.pecot-base の形が誤っていると、warning を出し、Stack の節を出さない', async () => {
      await explains('`.pecot-base` の形式が不正な場合のテストです。警告を標準エラーに出力し、`Stack` の節を表示しないことを確認します。')
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': 'garbage\n' } })
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('warning: .pecot-base is malformed: garbage\n')
    })

    it('判定を読めないとき、warning を出し、Stack の節の base の行は残す', async () => {
      await explains('着手中の Issue の判定を取得できない場合のテストです。警告を標準エラーに出力し、`Stack` の節の `base` の行は表示することを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), failing, stackedAbove()])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')
      expect(result.stdout).not.toContain('readiness:')
      expect(result.stderr).toMatch(/^warning: cannot judge readiness of the active Issue: .+500/u)
    })

    it('依存関係に対応しない GHES では、readiness の行と warning を出さず、base の行は残す', async () => {
      await explains('Issue の依存関係に対応しない GHES の場合のテストです。`readiness` の行と警告を出力せず、`Stack` の節の `base` の行は表示することを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), unsupported, stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).toContain('## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')
      expect(result.stdout).not.toContain('readiness:')
      expect(result.stderr).toBe('')
    })

    it.for([
      { name: '開発ブランチから着手した', files: { '.pecot/state/.pecot-base': `main ${SHA}\n` } },
      { name: '.pecot-base の形が誤っている', files: { '.pecot/state/.pecot-base': 'garbage\n' } },
    ])('$name ときは、Stack の節を出さず、判定も読まない', async ({ files }) => {
      await explains('開発ブランチから着手した場合と、`.pecot-base` の形式が不正な場合のテストです。どちらも `Stack` の節を表示せず、判定を取得しないことを確認します。')
      const { repository } = prepareSession({ files })
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'ListPullRequestsByBase'])
    })

    it('作業中の Issue が無ければ、.pecot-base があっても Stack の節を出さない', async () => {
      await explains('作業中の Issue が存在しない場合のテストです。`.pecot-base` があっても、`Stack` の節を表示しないことを確認します。')
      const { repository } = prepareSession({ branch: 'feat/no-number', files: STACKED })

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
    })

    it('directory の toplevel がプロジェクトのルートと違うと、.pecot-base のスタックの記録を Stack の節に出さず、判定から求め、子 PR は出す', async () => {
      await explains('`directory` の toplevel がプロジェクトのルートと異なる場合のテストです。`.pecot-base` の記録は使わず、判定から `Stack` の節を求め、子 PR（今のブランチを base にした PR）を表示することを確認します。')
      prepareSession({ files: STACKED })
      const clone = separateRepository()
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7 }), stackedAbove(above(40, 'feat/demo/8'))])

      const result = await status(clone)

      expect(result.code).toBe(0)
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- stacked above: PR #40 (feat/demo/8)\n')).toBe(true)
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'GetIssuePrerequisites', 'ListPullRequestsByBase'])
    })

    it('directory の toplevel がプロジェクトのルートと違っても、その worktree にスタックの記録があれば、判定から求めずにその記録を Stack の節に出す', async () => {
      await explains('`directory` の toplevel がプロジェクトのルートと異なり、その worktree にスタックの記録がある場合のテストです。判定は求めず、その記録を `Stack` の節に表示することを確認します。')
      prepareSession()
      const clone = separateRepository()
      mkdirSync(path.join(clone, '.pecot/state'), { recursive: true })
      writeFileSync(path.join(clone, '.pecot/state/.pecot-base'), STACKED['.pecot/state/.pecot-base'])
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

      const result = await status(clone)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
    })

    describe('記録が無い作業ディレクトリ', () => {
      it('判定が stackable で親ブランチの上にあると、Stack の節に求めた base を出し、判定を 1 回だけ読む', async () => {
        await explains('記録がない作業ディレクトリで、判定が `stackable` で、ブランチが親ブランチの上にある場合のテストです。求めた base を `Stack` の節に表示し、判定の取得は 1 回だけであることを確認します。')
        const repository = prepareLower(true)
        const github = await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

        const result = await status(repository)

        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
        expect(operationsOf(github).filter(operation => operation === 'GetIssuePrerequisites')).toEqual(['GetIssuePrerequisites'])
      })

      it('判定が blocked なら、warning を出し、Stack の節を出さない', async () => {
        await explains('記録がない作業ディレクトリで、判定が `blocked` の場合のテストです。警告を標準エラーに出力し、`Stack` の節を表示しないことを確認します。')
        const repository = prepareLower(true)
        await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, blockedBy: [{ number: 3 }] }), stackedAbove()])

        const result = await status(repository)

        expect(result.code).toBe(0)
        expect(result.stderr).toMatch(/^warning: cannot infer the stacked base: blocked by #3/u)
        expect(result.stdout).not.toContain('## Stack')
      })

      it.for([
        { name: '判定が startable', isStackable: false },
        { name: '判定が stackable でも、ブランチが親ブランチの変更を持たない', isStackable: true },
      ])('$name ときは、Stack の節を出さない', async (row) => {
        await explains('記録がない作業ディレクトリで、判定が `startable` の場合と、`stackable` でもブランチが親ブランチの変更を持たない場合のテストです。どちらも `Stack` の節を表示しないことを確認します。')
        const repository = prepareLower(false)
        await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, ...row.isStackable && { blockedBy: [inReview] } }), stackedAbove()])

        const result = await status(repository)

        expect(result).toMatchObject({ code: 0, stderr: '' })
        expect(result.stdout).not.toContain('## Stack')
      })
    })
  })

  describe('子 PR', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }

    it('今のブランチを base にした開いている PR があれば、スタックの記録が無くても Stack の節に PR ごとの stacked above の行を出す', async () => {
      await explains('今のブランチを base にした開いている PR（子 PR）がある場合のテストです。スタックの記録がなくても、PR ごとの `stacked above` の行を `Stack` の節に表示し、fork の PR は表示しないことを確認します。')
      const { repository } = prepareSession()
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(40, 'feat/demo/8'), above(41, 'feat/other/9', true), above(42, 'feat/demo/10'))])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- stacked above: PR #40 (feat/demo/8)\n- stacked above: PR #42 (feat/demo/10)\n')).toBe(true)
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'ListPullRequestsByBase'])
    })

    it('スタックの記録もあるとき、base と readiness の行の後に stacked above の行を並べる', async () => {
      await explains('スタックの記録と子 PR の両方がある場合のテストです。`Stack` の節で、`base` と `readiness` の行の後に `stacked above` の行が並ぶことを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'CLOSED')), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, title: '未着手' }] }), stackedAbove(above(40, 'feat/demo/8'))])

      const result = await status(repository)

      expect(result.stdout.endsWith('\n## Stack\n- base: feat/3 (#3, PR #30 CLOSED)\n- readiness: blocked by #3 (not in review: #3 (not started))\n- stacked above: PR #40 (feat/demo/8)\n')).toBe(true)
    })

    it('fork の PR しか無ければ、子 PR が無いものとして Stack の節を出さない', async () => {
      await explains('fork の PR しか存在しない場合のテストです。子 PR がないものとして扱い、`Stack` の節を表示しないことを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(41, 'feat/other/9', true))])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('')
    })

    it('子 PR を読めなければ、warning を出し、stacked above の行を省いて base の行は残す', async () => {
      await explains('スタックの記録があり、子 PR を取得できない場合のテストです。警告を標準エラーに出力し、`stacked above` の行は表示せず、`base` の行は表示することを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), prerequisitesRule({ number: 7, blockedBy: [inReview] }), failing])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout.endsWith('\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
      expect(result.stderr).toMatch(/^warning: cannot read the PRs stacked above: .+500/u)
    })

    it('スタックの記録が無く子 PR を読めなければ、warning を出し、Stack の節を出さない', async () => {
      await explains('スタックの記録がなく、子 PR を取得できない場合のテストです。警告を標準エラーに出力し、`Stack` の節を表示しないことを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toMatch(/^warning: cannot read the PRs stacked above: .+500/u)
    })

    it('remote が無いとき、作業中の Issue と子 PR を読まない', async () => {
      await explains('remote が存在しない場合のテストです。作業中の Issue と子 PR を GitHub から取得せず、`Stack` の節も表示しないことを確認します。')
      const { repository } = prepareSession({ remotes: {}, files: STACKED })
      const github = await startGithub([])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('')
      expect(operationsOf(github)).toEqual([])
    })

    it('アクティブな Issue を読めないとき、子 PR を読まない', async () => {
      await explains('作業中の Issue を取得できない場合のテストです。子 PR を取得せず、Issue の取得だけを GitHub へ要求することを確認します。')
      const { repository } = prepareSession()
      const github = await startGithub([issueFailure(502)])

      await status(repository)

      expect(operationsOf(github)).toEqual(['GetIssueSlim'])
    })
  })

  describe('MCP の data', () => {
    it('子 PR があれば、stackedAbove に PR の番号とブランチを返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-29')
      await explains('MCP の `session_show` で、子 PR がある場合のテストです。`stackedAbove` に、PR の番号とブランチが格納されることを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(40, 'feat/demo/8'), above(42, 'feat/demo/10'))])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN', body: '' },
        stackedAbove: [{ number: 40, branch: 'feat/demo/8' }, { number: 42, branch: 'feat/demo/10' }],
      })
    })

    it('子 PR を読めなければ、stackedAbove を省いて warning を返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-30')
      await explains('MCP の `session_show` で、子 PR を取得できない場合のテストです。`stackedAbove` を含めず、警告を `warnings` に含めることを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stackedAbove')
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot read the PRs stacked above: .+500/u)])
    })

    it('作業中の Issue が無いとき、ブランチとリポジトリだけを data に返し、activeIssue を省く', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-11')
      await verifies(context, 'PW-SESSION-SHOW-12')
      await explains('MCP の `session_show` で、作業中の Issue が存在しない場合のテストです。ブランチとリポジトリだけが `data` に含まれ、`activeIssue` は含まれないことを確認します。')
      const { repository } = prepareSession({ branch: 'feat/no-number', files: { '.pecot/state/.pecot-active': 'acme/demo/7\n' } })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ branch: 'feat/no-number', repository: 'acme/demo' })
    })

    it('そのリポを含む設定が無いとき、activeIssue に reference だけを返して warning を返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-15')
      await verifies(context, 'PW-SESSION-SHOW-16')
      await verifies(context, 'PW-SESSION-SHOW-39')
      await explains('MCP の `session_show` で、そのリポジトリを含む設定が存在しない場合のテストです。`activeIssue` には `reference` だけが含まれ、警告が `warnings` に含まれることを確認します。')
      const { repository } = prepareSession({ repositories: ['other'] })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7' },
        warnings: ['cannot read the active Issue: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme'],
      })
    })

    it('スタックして着手した作業ディレクトリでは、アクティブな Issue とスタック先を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      await verifies(context, 'PW-SESSION-SHOW-24')
      await explains('MCP の `session_show` を、スタックして着手した作業ディレクトリで呼び出した場合のテストです。作業中の Issue とスタック先の情報が `stack` に含まれることを確認します。')
      const SHA = '0123456789abcdef0123456789abcdef01234567'
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` } })
      await startGithub(rules({ blockedBy: [{ number: 3, title: '未着手' }] }, pullRequest(30, 'CLOSED')))

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN', body: '' },
        stack: { branch: 'feat/3', stackedOn: 'acme/demo/3', pullRequest: { number: 30, state: 'CLOSED' }, readiness: 'blocked by #3 (not in review: #3 (not started))' },
      })
    })

    it.for([
      { name: '404', status: 404, warning: /^cannot read the active Issue: .*404/u },
      { name: 'API エラー', status: 502, warning: /^cannot read the active Issue: .*502/u },
    ])('Issue の取得が $name で失敗すると、activeIssue の title と state を省いて reference を返し、warning を返す', async (row, context) => {
      await verifies(context, 'PW-SESSION-SHOW-17')
      await verifies(context, 'PW-SESSION-SHOW-18')
      await explains(`MCP の \`session_show\` で、Issue の取得が失敗する（HTTP ${String(row.status)} を返す）場合のテストです。\`activeIssue\` には \`reference\` だけが含まれ、警告が \`warnings\` に含まれることを確認します。`)
      const { repository } = prepareSession()
      await startGithub([issueFailure(row.status)])

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['activeIssue']).toEqual({ reference: 'acme/demo/7' })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(row.warning)])
    })

    it('Issue が閉じていると、activeIssue の state を CLOSED で返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-02')
      await verifies(context, 'PW-SESSION-SHOW-05')
      await explains('MCP の `session_show` で、Issue が閉じている場合のテストです。`activeIssue` の `state` が `CLOSED` で返ることを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: '閉じた Issue', state: 'CLOSED' }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: '閉じた Issue', state: 'CLOSED', body: '' },
      })
    })

    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }
    const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }

    it('directory を渡すと、ブランチ・リポジトリ・作業中の Issue を返し、Issue の本文を activeIssue の body に入れる', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-01')
      await verifies(context, 'PW-SESSION-SHOW-06')
      await explains('MCP の `session_show` に `directory` を指定した場合のテストです。ブランチ・リポジトリ・作業中の Issue が返り、Issue の本文が `activeIssue` の `body` に含まれることを確認します。')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: '見本の Issue', body: '本文の 1 行目\n本文の 2 行目\n' }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({ branch: 'feat/demo/7', repository: 'acme/demo', activeIssue: { reference: 'acme/demo/7', title: '見本の Issue', state: 'OPEN', body: '本文の 1 行目\n本文の 2 行目\n' } })
    })

    it('ブランチ名を読めないと、branch を入れずに続ける', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-07')
      await verifies(context, 'PW-SESSION-SHOW-08')
      await explains('MCP の `session_show` で、ブランチ名を取得できない場合のテストです。`branch` を含めず、成功の結果として空の `data` を返すことを確認します。')
      prepareSession()

      const outcome = await showTool(makeTemporaryDirectory('pecot-plain-'))

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({})
    })

    it('origin も他の remote も無いと、repository と activeIssue を入れずに続ける', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-09')
      await verifies(context, 'PW-SESSION-SHOW-10')
      await verifies(context, 'PW-SESSION-SHOW-33')
      await explains('MCP の `session_show` で、origin も他の remote も存在しない場合のテストです。`repository` と `activeIssue` を含めず、成功の結果を返すことを確認します。')
      const { repository } = prepareSession({ remotes: {} })

      const outcome = await showTool(repository)

      expect(outcome).toMatchObject({ isError: false, structured: { branch: 'feat/demo/7' } })
      expect(outcome.structured).not.toHaveProperty('repository')
      expect(outcome.structured).not.toHaveProperty('activeIssue')
    })

    it('remote の URL の形が合わないと、activeIssue を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-33')
      await explains('MCP の `session_show` で、remote の URL の形式が不正な場合のテストです。`activeIssue` を含めず、成功の結果を返すことを確認します。')
      const { repository } = prepareSession({ remotes: { origin: 'not-a-url' } })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).not.toHaveProperty('activeIssue')
    })

    it('directory を省くと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-19')
      await explains('MCP の `session_show` を、`directory` を省略して呼び出した場合のテストです。`kind` が `invalid-input` の失敗が返ることを確認します。')

      const outcome = await callToolOnce(SESSION_TOOLS, 'session_show', {})

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })

    it.for(INVALID_DIRECTORY_CASES)('directory が存在するディレクトリでないと（$name）、kind が invalid-input の失敗を返す', async ({ locked, prepare }, context) => {
      await verifies(context, 'PW-SESSION-SHOW-20')
      await explains('MCP の `session_show` で、`directory` に存在するディレクトリではない値を指定した場合のテストです。`kind` が `invalid-input` の失敗が返ることを確認します。')
      if (locked && isRoot()) context.skip()
      const { repository } = prepareSession()
      const target = prepare(repository)

      try {
        const outcome = await showTool(target)

        expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      }
      finally {
        if (locked) unlock(target)
      }
    })

    it('作業中の Issue があり、選んだ設定ファイルの形式が不正だと、warnings に 1 つ入れて成功を返す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-21')
      await verifies(context, 'PW-SESSION-SHOW-22')
      await explains('MCP の `session_show` で、選んだ設定ファイルの形式が不正な場合のテストです。警告が `warnings` に 1 つだけ含まれ、成功の結果が返ることを確認します。')
      const { repository } = prepareSession({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: '{"host":"github.com"}' } })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot read the active Issue: invalid config file/u)])
    })

    it('base のブランチの PR を読めないと、warnings に 1 つ入れ、stack に pullRequest を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-25')
      await explains('MCP の `session_show` で、base のブランチの PR を取得できない場合のテストです。警告が `warnings` に 1 つだけ含まれ、`stack` に `pullRequest` が含まれないことを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub([issueResponse({ number: 7, title: 't' }), failingOn('ListPullRequestsByHead'), prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured['stack']).toEqual({ branch: 'feat/3', stackedOn: 'acme/demo/3' })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot read the PR of the base branch: .+500/u)])
    })

    it('.pecot-base の形が誤っていると、warnings に 1 つ入れ、stack を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-26')
      await explains('MCP の `session_show` で、`.pecot-base` の形式が不正な場合のテストです。警告が `warnings` に 1 つだけ含まれ、`stack` が含まれないことを確認します。')
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': 'garbage\n' } })
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stack')
      expect(outcome.structured['warnings']).toEqual(['.pecot-base is malformed: garbage'])
    })

    it('着手中の Issue の判定を読めないと、warnings に 1 つ入れ、stack の base のブランチは入れる', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-27')
      await explains('MCP の `session_show` で、着手中の Issue の判定を取得できない場合のテストです。警告が `warnings` に 1 つだけ含まれ、`stack` の base のブランチは含まれることを確認します。')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), failingOn('GetIssuePrerequisites'), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured['stack']).toEqual({ branch: 'feat/3', stackedOn: 'acme/demo/3', pullRequest: { number: 30, state: 'OPEN' } })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot judge readiness of the active Issue: .+500/u)])
    })

    it('directory の toplevel がプロジェクトのルートと違うと、.pecot-base のスタックの記録を stack に使わない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-32')
      await explains('MCP の `session_show` で、`directory` の toplevel がプロジェクトのルートと異なる場合のテストです。`.pecot-base` の記録を `stack` に使わず、子 PR を `stackedAbove` に含めることを確認します。')
      prepareSession({ files: STACKED })
      const clone = separateRepository()
      await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7 }), stackedAbove(above(40, 'feat/demo/8'))])

      const outcome = await showTool(clone)

      expect(outcome.structured).not.toHaveProperty('stack')
      expect(outcome.structured['stackedAbove']).toEqual([{ number: 40, branch: 'feat/demo/8' }])
    })

    it('directory の worktree にスタックの記録があると、toplevel がプロジェクトのルートと違っても、その記録で stack を入れる', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-38')
      await explains('MCP の `session_show` で、`directory` の worktree にスタックの記録がある場合のテストです。toplevel がプロジェクトのルートと異なっても、その記録から `stack` を求めることを確認します。')
      prepareSession()
      const clone = separateRepository()
      mkdirSync(path.join(clone, '.pecot/state'), { recursive: true })
      writeFileSync(path.join(clone, '.pecot/state/.pecot-base'), STACKED['.pecot/state/.pecot-base'])
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

      const outcome = await showTool(clone)

      expect(outcome.structured['stack']).toMatchObject({ branch: 'feat/3', stackedOn: 'acme/demo/3', pullRequest: { number: 30, state: 'OPEN' } })
    })

    it('記録が無く、判定が stackable で親ブランチの変更を持つと、求めた base を stack に入れる', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-35')
      await explains('MCP の `session_show` で、記録がなく、判定が `stackable` かつ親ブランチの変更を持つ場合のテストです。求めた base を `stack` に含めることを確認します。')
      const repository = prepareLower(true)
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

      const outcome = await showTool(repository)

      expect(outcome.structured['stack']).toMatchObject({ branch: 'feat/3', pullRequest: { number: 30, state: 'OPEN' } })
    })

    it('記録が無く、判定が blocked だと、cannot infer the stacked base の知らせを warnings に入れ、stack を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-36')
      await explains('MCP の `session_show` で、記録がなく、判定が `blocked` の場合のテストです。`cannot infer the stacked base` の警告を `warnings` に含め、`stack` は含めないことを確認します。')
      const repository = prepareLower(true)
      await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, blockedBy: [{ number: 3 }] }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stack')
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot infer the stacked base: blocked by #3/u)])
    })

    it('記録が無く、依存関係に対応しない GHES では、判定できないので stack と warnings を入れない', async () => {
      await explains('MCP の `session_show` で、記録がなく、Issue の依存関係に対応しない GHES の場合のテストです。着手の基点を判定できないので、`stack` と `warnings` を含めないことを確認します。')
      const repository = prepareLower(true)
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), unsupported, stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stack')
      expect(outcome.structured).not.toHaveProperty('warnings')
    })

    it('記録が無く、判定は stackable でも親ブランチの変更をブランチに持たないと、stack を入れない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-37')
      await explains('MCP の `session_show` で、記録がなく、判定は `stackable` でもブランチが親ブランチの変更を持たない場合のテストです。`stack` を含めないことを確認します。')
      const repository = prepareLower(false)
      await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).not.toHaveProperty('stack')
    })
  })
})
