/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SESSION_COMMANDS } from '../../src/commands/session.js'
import { installFakeExecutable } from '../../src/tests/_helpers/fake-executables.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import type { ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { RunningGithub } from '../_helpers/interface-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { TargetSpec } from '../_helpers/prerequisites.js'
import { INVALID_DIRECTORY_CASES, isRoot, unlock } from '../_helpers/directory-option-case.js'
import { CONFIG_FILE, issueFailure, issueResponse, prepareSession, separateRepository } from '../_helpers/session-case.js'
import { makeAmbiguous, removeActive, SECOND_CONFIG } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const HEADER = '# Session status\n\n'
const SUMMARY = `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Active Issue: acme/demo#7\n`

async function status(directory: string): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['session', 'show', '-D', directory], SESSION_COMMANDS)
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

// main の上に下の段 feat/3 のコミットを置き、追跡参照を向ける。isStacked なら今のブランチをその上に載せる
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
  return await callToolOnce(SESSION_COMMANDS, 'session_show', { directory })
}

describe('session show', () => {
  it('--directory を渡すと、ブランチ・リポジトリ・remote とブランチ名から求めた作業中の Issue を標準出力に出し、フラグの表を出さない', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await verifies(context, 'PW-SESSION-SHOW-02')
    const { repository } = prepareSession()
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result).toEqual({ code: 0, stdout: `${SUMMARY}\n## Active Issue\n\n#7 t (OPEN)\n`, stderr: '' })
  })

  it('作業中の Issue を、読んだ Issue の番号・題名・状態と本文で Active Issue の節に出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-05')
    await verifies(context, 'PW-SESSION-SHOW-06')
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

  it('本文が空の Issue は、題名の行までで Active Issue の節を終える', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-05')
    const { repository } = prepareSession()
    await startGithub([issueResponse({ number: 7, title: '題名だけ', state: 'CLOSED' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout.endsWith('\n## Active Issue\n\n#7 題名だけ (CLOSED)\n')).toBe(true)
  })

  it('別の番号の古い .pecot-active が残っていても読まず、ブランチ名の番号の Issue を出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-31')
    const { repository } = prepareSession({ files: { '.pecot/state/.pecot-active': 'acme/demo/99\n' } })
    const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout).toBe(`${SUMMARY}\n## Active Issue\n\n#7 t (OPEN)\n`)
    expect(github.requests()).toMatchObject([{ operation: 'GetIssueSlim', variables: { number: 7 } }, { operation: 'ListPullRequestsByBase' }])
  })

  it('ブランチ名を読めないとき、Branch の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-07')
    await verifies(context, 'PW-SESSION-SHOW-08')
    prepareSession()
    const outsideGit = makeTemporaryDirectory('pecot-plain-')

    const result = await status(outsideGit)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${HEADER}- Branch: unknown\n- Repository: unknown\n- Active Issue: none\n`)
  })

  it('origin も他の remote も無いとき、Repository の行に unknown を、Active Issue の行に none を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-09')
    await verifies(context, 'PW-SESSION-SHOW-10')
    await verifies(context, 'PW-SESSION-SHOW-33')
    const { repository } = prepareSession({ remotes: {} })

    const result = await status(repository)

    expect(result).toEqual({ code: 0, stdout: `${HEADER}- Branch: feat/demo/7\n- Repository: unknown\n- Active Issue: none\n`, stderr: '' })
  })

  it('remote の URL の形が合わないとき、Active Issue の行に none を出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-33')
    const { repository } = prepareSession({ remotes: { origin: 'not-a-url' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Active Issue: none\n')
  })

  it('origin が無くても、最初の remote のリポジトリを出し、そのリポジトリの Issue を作業中の Issue にする', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await verifies(context, 'PW-SESSION-SHOW-02')
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
    await verifies(context, 'PW-SESSION-SHOW-11')
    await verifies(context, 'PW-SESSION-SHOW-12')
    const { repository } = prepareSession({ branch })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Active Issue: none\n')
    expect(result.stdout).not.toContain('## Active Issue')
  })

  it('作業中の Issue があるのに、そのリポを含む設定が 2 つあり .active も選べないとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-15')
    await verifies(context, 'PW-SESSION-SHOW-16')
    await verifies(context, 'PW-SESSION-SHOW-39')
    const { project, repository } = prepareSession()
    makeAmbiguous(project)

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toBe('warning: cannot read the active Issue: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n')
  })

  it('作業中の Issue があるのに、そのリポを含む設定が無いとき、節を出さずに warning を標準エラーに出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-39')
    const { repository } = prepareSession({ repositories: ['other'] })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toBe('warning: cannot read the active Issue: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
  })

  it('--project を渡すと、そのリポを含む設定が 2 つあってもその設定で作業中の Issue を読む', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-40')
    const { project, repository } = prepareSession()
    makeAmbiguous(project)
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await runInProcess(['session', 'show', '-D', repository, '--project', SECOND_CONFIG], SESSION_COMMANDS)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Active Issue')
    expect(result.stderr).toBe('')
  })

  it('.active が無くても、そのリポを含む設定が 1 つならその設定で作業中の Issue を読む', async () => {
    const { project, repository } = prepareSession()
    removeActive(project)
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Active Issue')
    expect(result.stderr).toBe('')
  })

  it('作業中の Issue があるのに Issue を GitHub から読めないとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-17')
    await verifies(context, 'PW-SESSION-SHOW-18')
    const { repository } = prepareSession()
    await startGithub([issueFailure(502)])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(SUMMARY)
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: .*502/u)
  })

  it('--directory を省くと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-19')

    const result = await runInProcess(['session', 'show'], SESSION_COMMANDS)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })

  it.for(INVALID_DIRECTORY_CASES)('--directory が存在するディレクトリでないとき（$name）、終了コード 2 で終わる', async ({ reason, locked, prepare }, context) => {
    await verifies(context, 'PW-SESSION-SHOW-20')
    if (locked && isRoot()) context.skip()
    const { repository } = prepareSession()
    const target = prepare(repository)

    try {
      const result = await status(target)

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr.replaceAll(/[│\s]+/gu, ' ')).toContain(`Invalid value for '--directory' / '-D': Directory '${target}' ${reason}.`)
    }
    finally {
      if (locked) unlock(target)
    }
  })

  it('--directory が空文字のとき、cwd を対象にして終了コード 0 で終わる', async () => {
    prepareSession()
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

    const result = await status('')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('# Session status')
    expect(result.stdout).toContain('- Branch: feat/demo/7')
  })

  it('--directory がファイルとディレクトリのどちらでもないパスのとき、Usage ではなく error の 1 行を出して終了コード 1 で終わる', async () => {
    prepareSession()

    const result = await status('/dev/null')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: [^\n]+\n$/u)
    expect(result.stderr).not.toContain('Invalid value')
  })

  it('アクティブな設定ファイルの形式が不正なとき、warning を標準エラーに出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-21')
    await verifies(context, 'PW-SESSION-SHOW-22')
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
    it('積んで着手した作業ディレクトリでは、積んだ先の Issue と PR を Stack の節に出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
      expect(result.stdout).not.toContain('readiness:')
    })

    it.for([
      { name: '下の段の remote の先頭が記録と同じ', scene: 'same', state: 'OPEN', expected: 'no', id: 'PW-SESSION-SHOW-28' },
      { name: '下の段の remote の先頭が記録と違い、追跡参照が古いまま', scene: 'moved', state: 'OPEN', expected: 'yes', id: 'PW-SESSION-SHOW-28' },
      { name: '下の段の PR がマージ済み', scene: 'same', state: 'MERGED', expected: 'yes', id: 'PW-SESSION-SHOW-28' },
      { name: '下の段の PR がマージ済みで、ブランチが開発ブランチの上に載り終えていて記録だけが古い', scene: 'rebased', state: 'MERGED', expected: 'no', id: 'PW-SESSION-SHOW-34' },
    ])('$name と、Stack の節に needs restack: $expected の行を出す', async (row, context) => {
      await verifies(context, row.id)
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
        // 記録は、手元が知っていて HEAD の履歴に無い古い下の段。開発ブランチの追跡参照は HEAD を指す
        recorded = gitForTest(repository, ['commit-tree', [head, '^{tree}'].join(''), '-p', head, '-m', 'old lower']).trim()
        gitForTest(repository, ['update-ref', 'refs/remotes/origin/main', head])
      }
      mkdirSync(path.join(project.root, '.pecot/state'), { recursive: true })
      writeFileSync(path.join(project.root, '.pecot/state/.pecot-base'), `feat/3 ${recorded} acme/demo#3\n`)
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, row.state)), prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()])

      const result = await status(repository)

      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith(`\n## Stack\n- base: feat/3 (#3, PR #30 ${row.state})\n- needs restack: ${row.expected}\n`)).toBe(true)
    })

    it('open の PR が無ければ fork でない最新の PR を、PR が無ければ no PR を出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [inReview] }, pullRequest(32, 'OPEN', true), pullRequest(31, 'MERGED'), pullRequest(29, 'CLOSED')))
      const merged = await status(repository)
      expect(merged.stdout).toContain('- base: feat/3 (#3, PR #31 MERGED)\n')

      await startGithub(rules({ blockedBy: [inReview] }))
      const none = await status(repository)
      expect(none.stdout).toContain('- base: feat/3 (#3, no PR)\n')
    })

    it('着手中の Issue の判定が blocked なら、readiness の行を足す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-24')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub(rules({ blockedBy: [{ number: 3, title: '未着手' }] }, pullRequest(30, 'CLOSED')))

      const result = await status(repository)

      expect(result.stdout.endsWith('- base: feat/3 (#3, PR #30 CLOSED)\n- readiness: blocked by #3 (not in review: #3 (not started))\n')).toBe(true)
    })

    it('PR を読めなければ warning を出し、PR unknown と出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-25')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'ListPullRequestsByHead' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), failing, prerequisitesRule({ number: 7, blockedBy: [inReview] }), stackedAbove()])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('- base: feat/3 (#3, PR unknown)\n')
      expect(result.stderr).toMatch(/^warning: cannot read the PR of the base branch: .+500/u)
    })

    it('.pecot-base の形が誤っていると、warning を出し、Stack の節を出さない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-26')
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': 'garbage\n' } })
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('warning: .pecot-base is malformed: garbage\n')
    })

    it('判定を読めないとき、warning を出し、Stack の節の base の行は残す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-27')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), failing, stackedAbove()])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')
      expect(result.stdout).not.toContain('readiness:')
      expect(result.stderr).toMatch(/^warning: cannot judge readiness of the active Issue: .+500/u)
    })

    it('依存関係に対応しない GHES では、readiness の行と warning を出さず、base の行は残す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-24')
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
    ])('$name ときは、Stack の節を出さず、判定も読まない', async ({ files }, context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ files })
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'ListPullRequestsByBase'])
    })

    it('作業中の Issue が無ければ、.pecot-base があっても Stack の節を出さない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ branch: 'feat/no-number', files: STACKED })

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
    })

    it('--directory の toplevel がプロジェクトのルートと違うと、.pecot-base の積んだ記録を Stack の節に出さず、判定から求め、上の段は出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-32')
      prepareSession({ files: STACKED })
      const clone = separateRepository()
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7 }), stackedAbove(above(40, 'feat/demo/8'))])

      const result = await status(clone)

      expect(result.code).toBe(0)
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- stacked above: PR #40 (feat/demo/8)\n')).toBe(true)
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'GetIssuePrerequisites', 'ListPullRequestsByBase'])
    })

    it('--directory の toplevel がプロジェクトのルートと違っても、その worktree に積んだ記録があれば、判定から求めずにその記録を Stack の節に出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-38')
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
      it('判定が stackable で下の段の上にあると、Stack の節に求めた base を出し、判定を 1 回だけ読む', async (context) => {
        await verifies(context, 'PW-SESSION-SHOW-35')
        const repository = prepareLower(true)
        const github = await startGithub(rules({ blockedBy: [inReview] }, pullRequest(30, 'OPEN')))

        const result = await status(repository)

        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
        expect(operationsOf(github).filter(operation => operation === 'GetIssuePrerequisites')).toEqual(['GetIssuePrerequisites'])
      })

      it('判定が blocked なら、warning を出し、Stack の節を出さない', async (context) => {
        await verifies(context, 'PW-SESSION-SHOW-36')
        const repository = prepareLower(true)
        await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, blockedBy: [{ number: 3 }] }), stackedAbove()])

        const result = await status(repository)

        expect(result.code).toBe(0)
        expect(result.stderr).toMatch(/^warning: cannot infer the stacked base: blocked by #3/u)
        expect(result.stdout).not.toContain('## Stack')
      })

      it.for([
        { name: '判定が startable', isStackable: false },
        { name: '判定が stackable でも、ブランチが下の段の変更を持たない', isStackable: true },
      ])('$name ときは、Stack の節を出さない', async (row, context) => {
        await verifies(context, 'PW-SESSION-SHOW-37')
        const repository = prepareLower(false)
        await startGithub([issueResponse({ number: 7, title: 't' }), prerequisitesRule({ number: 7, ...row.isStackable && { blockedBy: [inReview] } }), stackedAbove()])

        const result = await status(repository)

        expect(result).toMatchObject({ code: 0, stderr: '' })
        expect(result.stdout).not.toContain('## Stack')
      })
    })
  })

  describe('上に積んだ段', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }

    it('今のブランチを base にした開いている PR があれば、積んだ記録が無くても Stack の節に PR ごとの stacked above の行を出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-29')
      const { repository } = prepareSession()
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(40, 'feat/demo/8'), above(41, 'feat/other/9', true), above(42, 'feat/demo/10'))])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.endsWith('\n## Active Issue\n\n#7 t (OPEN)\n\n## Stack\n- stacked above: PR #40 (feat/demo/8)\n- stacked above: PR #42 (feat/demo/10)\n')).toBe(true)
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'ListPullRequestsByBase'])
    })

    it('積んだ記録もあるとき、base と readiness の行の後に stacked above の行を並べる', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-29')
      const { repository } = prepareSession({ files: STACKED })
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'CLOSED')), prerequisitesRule({ number: 7, blockedBy: [{ number: 3, title: '未着手' }] }), stackedAbove(above(40, 'feat/demo/8'))])

      const result = await status(repository)

      expect(result.stdout.endsWith('\n## Stack\n- base: feat/3 (#3, PR #30 CLOSED)\n- readiness: blocked by #3 (not in review: #3 (not started))\n- stacked above: PR #40 (feat/demo/8)\n')).toBe(true)
    })

    it('fork の PR しか無ければ、上の段が無いものとして Stack の節を出さない', async () => {
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(41, 'feat/other/9', true))])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('')
    })

    it('上の段を読めなければ、warning を出し、stacked above の行を省いて base の行は残す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-30')
      const { repository } = prepareSession({ files: STACKED })
      const failing: ResponseRule = { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
      const inReview = { number: 3, column: 'In Review', branch: 'feat/3', pullRequests: [{ number: 30, head: 'feat/3' }] }
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, 'OPEN')), prerequisitesRule({ number: 7, blockedBy: [inReview] }), failing])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout.endsWith('\n## Stack\n- base: feat/3 (#3, PR #30 OPEN)\n')).toBe(true)
      expect(result.stderr).toMatch(/^warning: cannot read the PRs stacked above: .+500/u)
    })

    it('積んだ記録が無く上の段を読めなければ、warning を出し、Stack の節を出さない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-30')
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toMatch(/^warning: cannot read the PRs stacked above: .+500/u)
    })

    it('remote が無いとき、作業中の Issue も上の段も読まない', async () => {
      const { repository } = prepareSession({ remotes: {}, files: STACKED })
      const github = await startGithub([])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('')
      expect(operationsOf(github)).toEqual([])
    })

    it('アクティブな Issue を読めないとき、上の段を読まない', async () => {
      const { repository } = prepareSession()
      const github = await startGithub([issueFailure(502)])

      await status(repository)

      expect(operationsOf(github)).toEqual(['GetIssueSlim'])
    })
  })

  describe('MCP の data', () => {
    it('上の段があれば、stackedAbove に PR の番号とブランチを返す', async () => {
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(40, 'feat/demo/8'), above(42, 'feat/demo/10'))])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN' },
        stackedAbove: [{ number: 40, branch: 'feat/demo/8' }, { number: 42, branch: 'feat/demo/10' }],
      })
    })

    it('上の段を読めなければ、stackedAbove を省いて warning を返す', async () => {
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stackedAbove')
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot read the PRs stacked above: .+500/u)])
    })

    it('作業中の Issue が無いとき、ブランチとリポジトリだけを data に返し、activeIssue を省く', async () => {
      const { repository } = prepareSession({ branch: 'feat/no-number', files: { '.pecot/state/.pecot-active': 'acme/demo/7\n' } })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ branch: 'feat/no-number', repository: 'acme/demo' })
    })

    it('そのリポを含む設定が無いとき、activeIssue に reference だけを返して warning を返す', async () => {
      const { repository } = prepareSession({ repositories: ['other'] })

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7' },
        warnings: ['cannot read the active Issue: acme/demo is not in any project config\navailable: ghes.example.com_acme_board_acme'],
      })
    })

    it('積んで着手した作業ディレクトリでは、アクティブな Issue と積んだ先を data に返す', async () => {
      const SHA = '0123456789abcdef0123456789abcdef01234567'
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` } })
      await startGithub(rules({ blockedBy: [{ number: 3, title: '未着手' }] }, pullRequest(30, 'CLOSED')))

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN' },
        stack: { branch: 'feat/3', stackedOn: 'acme/demo/3', pullRequest: { number: 30, state: 'CLOSED' }, readiness: 'blocked by #3 (not in review: #3 (not started))' },
      })
    })

    it.for([
      { name: '404', status: 404, warning: /^cannot read the active Issue: .*404/u },
      { name: 'API エラー', status: 502, warning: /^cannot read the active Issue: .*502/u },
    ])('Issue の取得が $name で失敗すると、activeIssue の title と state を省いて reference を返し、warning を返す', async (row) => {
      const { repository } = prepareSession()
      await startGithub([issueFailure(row.status)])

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured['activeIssue']).toEqual({ reference: 'acme/demo/7' })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(row.warning)])
    })

    it('Issue が閉じていると、activeIssue の state を CLOSED で返す', async () => {
      const { repository } = prepareSession()
      await startGithub([issueResponse({ number: 7, title: '閉じた Issue', state: 'CLOSED' }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7', title: '閉じた Issue', state: 'CLOSED' },
      })
    })
  })
})
