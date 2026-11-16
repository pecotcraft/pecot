/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SESSION_COMMANDS } from '../../src/commands/session.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
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
import { CONFIG_FILE, issueFailure, issueResponse, prepareSession } from '../_helpers/session-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const ACTIVE = { '.pecot/state/.pecot-active': 'acme/demo/7\n' }
const HEADER = '# Session status\n\n'
const TABLE_HEAD = '| Flag | State | Content |\n|------|-------|---------|\n'

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

async function showTool(directory: string): Promise<ToolOutcome> {
  return await callToolOnce(SESSION_COMMANDS, 'session_show', { directory })
}

describe('session show', () => {
  it('--directory を渡すと、ブランチ・リポジトリ・推定した Issue・フラグの表を標準出力に出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await verifies(context, 'PW-SESSION-SHOW-02')
    await verifies(context, 'PW-SESSION-SHOW-04')
    const { repository } = prepareSession()

    const result = await status(repository)

    expect(result).toEqual({
      code: 0,
      stdout: `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Inferred Issue: #7\n\n${TABLE_HEAD}| .pecot-active | unset |  |\n`,
      stderr: '',
    })
  })

  it('.pecot-active があるとき、表にその行を set と内容で出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-03')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])
    const result = await status(repository)

    expect(result.stdout).toContain('| .pecot-active | set | acme/demo/7 |\n')
  })

  it('.pecot-active に参照があると、読んだ Issue の番号・題名・状態と本文を Active Issue の節に出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-05')
    await verifies(context, 'PW-SESSION-SHOW-06')
    const { repository } = prepareSession({ files: ACTIVE })
    const github = await startGithub([issueResponse({ number: 7, title: '見本の Issue', body: '本文の 1 行目\n本文の 2 行目\n' }), stackedAbove()])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Inferred Issue: #7\n\n${TABLE_HEAD}| .pecot-active | set | acme/demo/7 |\n`
      + '\n## Active Issue\n\n#7 見本の Issue (OPEN)\n\n本文の 1 行目\n本文の 2 行目\n',
    )
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 0 } },
      { type: 'graphql', operation: 'ListPullRequestsByBase', variables: { owner: 'acme', repo: 'demo', baseRefName: 'feat/demo/7' } },
    ])
  })

  it('本文が空の Issue は、題名の行までで Active Issue の節を終える', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-05')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueResponse({ number: 7, title: '題名だけ', state: 'CLOSED' }), stackedAbove()])

    const result = await status(repository)

    expect(result.stdout.endsWith('\n## Active Issue\n\n#7 題名だけ (CLOSED)\n')).toBe(true)
  })

  it('ブランチ名を読めないとき、Branch の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-07')
    await verifies(context, 'PW-SESSION-SHOW-08')
    prepareSession()
    const outsideGit = makeTemporaryDirectory('pecot-plain-')

    const result = await status(outsideGit)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Branch: unknown\n')
  })

  it('origin も他の remote も無いとき、Repository の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-09')
    await verifies(context, 'PW-SESSION-SHOW-10')
    const { repository } = prepareSession({ remotes: {} })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Repository: unknown\n')
    expect(result.stdout).toContain('- Branch: feat/demo/7\n')
  })

  it('origin が無くても、最初の remote のリポジトリを出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    const { repository } = prepareSession({ remotes: { upstream: 'https://ghes.example.com/acme/other.git' } })

    const result = await status(repository)

    expect(result.stdout).toContain('- Repository: acme/other\n')
  })

  it('ブランチ名の末尾が番号でないとき、Inferred Issue の行に none を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-11')
    await verifies(context, 'PW-SESSION-SHOW-12')
    const { repository } = prepareSession({ branch: 'feat/no-number' })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Inferred Issue: none\n')
  })

  it('.pecot-active が Issue の参照として読めないとき、Active Issue の節を出さずに続ける', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-13')
    await verifies(context, 'PW-SESSION-SHOW-14')
    const { repository } = prepareSession({ files: { '.pecot/state/.pecot-active': 'not a reference\n' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stdout).toContain('| .pecot-active | set | not a reference |\n')
    expect(result.stderr).toBe('')
  })

  it('参照があるのにアクティブなプロジェクトが無いとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-15')
    await verifies(context, 'PW-SESSION-SHOW-16')
    const { project, repository } = prepareSession({ files: ACTIVE })
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toBe('warning: cannot read the active Issue: no active project\n')
  })

  it('参照があるのに Issue を GitHub から読めないとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-17')
    await verifies(context, 'PW-SESSION-SHOW-18')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueFailure(502)])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
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
    const { repository } = prepareSession({ files: { ...ACTIVE, [`.pecot/config/projects/${CONFIG_FILE}`]: '{"host":"github.com"}' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: invalid config file/u)
  })

  describe('Stack の節', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { ...ACTIVE, '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }
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
      { name: '下の段の remote の先頭が記録と同じ', isMoved: false, state: 'OPEN', expected: 'no' },
      { name: '下の段の remote の先頭が記録と違う', isMoved: true, state: 'OPEN', expected: 'yes' },
      { name: '下の段の PR がマージ済み', isMoved: false, state: 'MERGED', expected: 'yes' },
    ])('$name と、Stack の節に needs restack: $expected の行を出す', async (row, context) => {
      await verifies(context, 'PW-SESSION-SHOW-28')
      const bare = makeTemporaryDirectory('pecot-bare-')
      gitForTest(bare, ['init', '-q', '--bare'])
      const { project, repository } = prepareSession({ remotes: { origin: bare }, files: ACTIVE })
      gitForTest(repository, ['push', '-q', 'origin', 'HEAD:refs/heads/feat/3'])
      const recorded = row.isMoved ? SHA : gitForTest(repository, ['rev-parse', 'HEAD']).trim()
      writeFileSync(path.join(project.root, '.pecot/state/.pecot-base'), `feat/3 ${recorded} acme/demo#3\n`)
      await startGithub([issueResponse({ number: 7, title: 't' }), pullRequests(pullRequest(30, row.state)), prerequisitesRule({ number: 7, blockedBy: [inReview] })])

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
      const { repository } = prepareSession({ files: { ...ACTIVE, '.pecot/state/.pecot-base': 'garbage\n' } })
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
      { name: '.pecot-base が無い', files: ACTIVE },
      { name: '開発ブランチから着手した', files: { ...ACTIVE, '.pecot/state/.pecot-base': `main ${SHA}\n` } },
      { name: '.pecot-base の形が誤っている', files: { ...ACTIVE, '.pecot/state/.pecot-base': 'garbage\n' } },
    ])('$name ときは、Stack の節を出さず、判定も読まない', async ({ files }, context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ files })
      const github = await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove()])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(operationsOf(github)).toEqual(['GetIssueSlim', 'ListPullRequestsByBase'])
    })

    it('.pecot-active が無ければ、.pecot-base があっても Stack の節を出さない', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-23')
      const { repository } = prepareSession({ files: { '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` } })

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
    })
  })

  describe('上に積んだ段', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const STACKED = { ...ACTIVE, '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` }

    it('今のブランチを base にした開いている PR があれば、積んだ記録が無くても Stack の節に PR ごとの stacked above の行を出す', async (context) => {
      await verifies(context, 'PW-SESSION-SHOW-29')
      const { repository } = prepareSession({ files: ACTIVE })
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
      const { repository } = prepareSession({ files: ACTIVE })
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
      const { repository } = prepareSession({ files: ACTIVE })
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const result = await status(repository)

      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toMatch(/^warning: cannot read the PRs stacked above: .+500/u)
    })

    it('remote が無いとき、上の段を読まない', async () => {
      const { repository } = prepareSession({ files: ACTIVE, remotes: {} })
      const github = await startGithub([issueResponse({ number: 7, title: 't' })])

      const result = await status(repository)

      expect(result.stdout).not.toContain('## Stack')
      expect(result.stderr).toBe('')
      expect(operationsOf(github)).toEqual(['GetIssueSlim'])
    })

    it('アクティブな Issue を読めないとき、上の段を読まない', async () => {
      const { repository } = prepareSession({ files: ACTIVE })
      const github = await startGithub([issueFailure(502)])

      await status(repository)

      expect(operationsOf(github)).toEqual(['GetIssueSlim'])
    })
  })

  describe('MCP の data', () => {
    it('上の段があれば、stackedAbove に PR の番号とブランチを返す', async () => {
      const { repository } = prepareSession({ files: ACTIVE })
      await startGithub([issueResponse({ number: 7, title: 't' }), stackedAbove(above(40, 'feat/demo/8'), above(42, 'feat/demo/10'))])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        inferredIssue: 7,
        flags: [{ name: '.pecot-active', isSet: true, content: 'acme/demo/7' }],
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN' },
        stackedAbove: [{ number: 40, branch: 'feat/demo/8' }, { number: 42, branch: 'feat/demo/10' }],
      })
    })

    it('上の段を読めなければ、stackedAbove を省いて warning を返す', async () => {
      const { repository } = prepareSession({ files: ACTIVE })
      await startGithub([issueResponse({ number: 7, title: 't' }), { match: { operation: 'ListPullRequestsByBase' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])

      const outcome = await showTool(repository)

      expect(outcome.structured).not.toHaveProperty('stackedAbove')
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot read the PRs stacked above: .+500/u)])
    })

    it('.pecot-active が無いとき、ブランチ・リポジトリ・推定した Issue・フラグを data に返す', async () => {
      const { repository } = prepareSession()

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        inferredIssue: 7,
        flags: [{ name: '.pecot-active', isSet: false, content: '' }],
      })
    })

    it('積んで着手した作業ディレクトリでは、アクティブな Issue と積んだ先を data に返す', async () => {
      const SHA = '0123456789abcdef0123456789abcdef01234567'
      const { repository } = prepareSession({ files: { ...ACTIVE, '.pecot/state/.pecot-base': `feat/3 ${SHA} acme/demo#3\n` } })
      await startGithub(rules({ blockedBy: [{ number: 3, title: '未着手' }] }, pullRequest(30, 'CLOSED')))

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        inferredIssue: 7,
        flags: [{ name: '.pecot-active', isSet: true, content: 'acme/demo/7' }],
        activeIssue: { reference: 'acme/demo/7', title: 't', state: 'OPEN' },
        stack: { branch: 'feat/3', stackedOn: 'acme/demo/3', pullRequest: { number: 30, state: 'CLOSED' }, readiness: 'blocked by #3 (not in review: #3 (not started))' },
      })
    })

    it.for([
      { name: '404', status: 404, warning: /^cannot read the active Issue: .*404/u },
      { name: 'API エラー', status: 502, warning: /^cannot read the active Issue: .*502/u },
    ])('Issue の取得が $name で失敗すると、activeIssue を返さず、flags の content に参照を残す', async (row) => {
      const { repository } = prepareSession({ files: ACTIVE })
      await startGithub([issueFailure(row.status)])

      const outcome = await showTool(repository)

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).not.toHaveProperty('activeIssue')
      expect(outcome.structured).toMatchObject({ flags: [{ name: '.pecot-active', isSet: true, content: 'acme/demo/7' }] })
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(row.warning)])
    })

    it('Issue が閉じていると、activeIssue の state を CLOSED で返す', async () => {
      const { repository } = prepareSession({ files: ACTIVE })
      await startGithub([issueResponse({ number: 7, title: '閉じた Issue', state: 'CLOSED' }), stackedAbove()])

      const outcome = await showTool(repository)

      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        inferredIssue: 7,
        flags: [{ name: '.pecot-active', isSet: true, content: 'acme/demo/7' }],
        activeIssue: { reference: 'acme/demo/7', title: '閉じた Issue', state: 'CLOSED' },
      })
    })
  })
})
