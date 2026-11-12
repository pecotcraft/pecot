/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SESSION_COMMANDS } from '../../src/commands/session.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { CONFIG_FILE, issueFailure, issueResponse, prepareSession } from '../_helpers/session-case.js'
import type { SessionCase } from '../_helpers/session-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function restore(directory: string, ...extra: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['session', 'restore', '-D', directory, ...extra], SESSION_COMMANDS)
}

function stateFile(session: Readonly<SessionCase>, name: string): string {
  return readFileSync(path.join(session.project.root, '.pecot/state', name), 'utf8')
}

const SET_LINE = (number: number): string => `set: work target acme/demo/${String(number)} (work directory .pecot/work/${String(number)}/)\n`

describe('session restore', () => {
  it('--issue に owner/repo/N を渡すと、その Issue を作業対象に記録し、ブランチと remote は読まない', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-01')
    await verifies(context, 'PW-SESSION-RESTORE-03')
    await verifies(context, 'PW-SESSION-RESTORE-08')
    const session = prepareSession({ branch: 'feat/no-number', remotes: {} })
    await startGithub([issueResponse({ number: 9, title: '明示した Issue' })])

    const result = await restore(session.repository, '--issue', 'acme/demo/9')

    expect(result).toEqual({ code: 0, stdout: '', stderr: SET_LINE(9) })
    expect(stateFile(session, '.pecot-active')).toBe('acme/demo/9')
  })

  it('-i の短い形でも --issue と同じに記録する', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-01')
    const session = prepareSession()
    await startGithub([issueResponse({ number: 9, title: 't' })])

    const result = await restore(session.repository, '-i', 'acme/demo/9')

    expect(result.code).toBe(0)
    expect(stateFile(session, '.pecot-active')).toBe('acme/demo/9')
  })

  it('--issue を省くと、ブランチ名の末尾の番号と origin のリポジトリから Issue を決めて記録する', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-02')
    const session = prepareSession()
    const github = await startGithub([issueResponse({ number: 7, title: '見本の Issue' })])

    const result = await restore(session.repository)

    expect(result).toEqual({ code: 0, stdout: '', stderr: SET_LINE(7) })
    expect(stateFile(session, '.pecot-active')).toBe('acme/demo/7')
    expect(github.requests()).toMatchObject([{ operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7 } }])
  })

  it('origin が無いとき、最初の remote のリポジトリで Issue を決める', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-02')
    const session = prepareSession({ remotes: { upstream: 'https://ghes.example.com/acme/demo.git' } })
    await startGithub([issueResponse({ number: 7, title: 't' })])

    const result = await restore(session.repository)

    expect(result.code).toBe(0)
    expect(stateFile(session, '.pecot-active')).toBe('acme/demo/7')
  })

  it('Issue の題名を読めると、セッション名に番号と題名を入れる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-04')
    await verifies(context, 'PW-SESSION-RESTORE-05')
    const session = prepareSession()
    await startGithub([issueResponse({ number: 7, title: '[Task] 見本の Issue' })])

    await restore(session.repository)

    expect(stateFile(session, '.pecot-session-title')).toBe('#7 見本の Issue')
  })

  it('作業対象を記録すると、作業ディレクトリ .pecot/work/N/ を作る', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-06')
    const session = prepareSession()
    await startGithub([issueResponse({ number: 7, title: 't' })])

    await restore(session.repository)

    expect(existsSync(path.join(session.project.root, '.pecot/work/7'))).toBe(true)
  })

  it('作業対象が既に記録されているとき、新しい作業対象で上書きする', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-07')
    const session = prepareSession({ files: { '.pecot/state/.pecot-active': 'acme/demo/1', '.pecot/state/.pecot-session-title': '#1 古い' } })
    await startGithub([issueResponse({ number: 7, title: '新しい' })])

    await restore(session.repository)

    expect(stateFile(session, '.pecot-active')).toBe('acme/demo/7')
    expect(stateFile(session, '.pecot-session-title')).toBe('#7 新しい')
  })

  it('Issue の題名を読めないとき、題名を入れずにセッション名を書いて続ける', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-09')
    await verifies(context, 'PW-SESSION-RESTORE-10')
    const session = prepareSession()
    await startGithub([issueFailure(404)])

    const result = await restore(session.repository)

    expect(result).toEqual({ code: 0, stdout: '', stderr: SET_LINE(7) })
    expect(stateFile(session, '.pecot-session-title')).toBe('#7')
  })

  it('アクティブなプロジェクトが無いとき、警告なしで題名なしのまま続ける', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-10')
    const session = prepareSession()
    rmSync(path.join(session.project.root, '.pecot/config/projects/.active'))

    const result = await restore(session.repository)

    expect(result).toEqual({ code: 0, stdout: '', stderr: SET_LINE(7) })
    expect(stateFile(session, '.pecot-session-title')).toBe('#7')
  })

  it('--issue が owner/repo/N の形でないとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-11')
    const session = prepareSession()

    const result = await restore(session.repository, '--issue', '9')

    expect(result).toEqual({ code: 2, stdout: '', stderr: 'error: the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'\n' })
    expect(existsSync(path.join(session.project.root, '.pecot/state/.pecot-active'))).toBe(false)
  })

  it('--directory を省くと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-12')

    const result = await runInProcess(['session', 'restore'], SESSION_COMMANDS)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })

  it.for([
    { name: '無いパス', reason: 'does not exist', prepare: (root: string): string => path.join(root, 'x') },
    { name: 'ファイル', reason: 'is a file', prepare: (root: string): string => {
      const file = path.join(root, 'plain.txt')
      writeFileSync(file, '')
      return file
    } },
    { name: '読めないディレクトリ', reason: 'is not readable', prepare: (root: string): string => {
      const locked = path.join(root, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      return locked
    } },
  ])('--directory が存在するディレクトリでないとき（$name）、終了コード 2 で終わる', async ({ reason, prepare }, context) => {
    await verifies(context, 'PW-SESSION-RESTORE-13')
    if (reason === 'is not readable' && process.getuid?.() === 0) context.skip()
    const session = prepareSession()
    const target = prepare(session.repository)

    try {
      const result = await restore(target)

      expect(result.code).toBe(2)
      expect(result.stderr.replaceAll(/[│\s]+/gu, ' ')).toContain(`Invalid value for '--directory' / '-D': Directory '${target}' ${reason}.`)
    }
    finally {
      if (reason === 'is not readable') chmodSync(target, 0o700)
    }
  })

  it('--issue を省いてブランチ名を読めないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-14')
    const session = prepareSession()

    const result = await restore(makeTemporaryDirectory('pecot-plain-'))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: cannot read the branch name\n' })
    expect(existsSync(path.join(session.project.root, '.pecot/state/.pecot-active'))).toBe(false)
  })

  it('--issue を省いてブランチ名の末尾が番号でないとき、--issue を使う案内を添えた error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-15')
    await verifies(context, 'PW-SESSION-RESTORE-16')
    const session = prepareSession({ branch: 'feat/no-number' })

    const result = await restore(session.repository)

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: cannot infer the Issue number from the branch name: feat/no-number\n  run: pecot session restore --issue <owner/repo/N>\n',
    })
  })

  it('--issue を省いて remote のリポジトリを読めないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-17')
    const session = prepareSession({ remotes: {} })

    const result = await restore(session.repository)

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: cannot read the repository information\n' })
  })

  it('作業対象のファイルを書けないとき、error の行を標準エラーに出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-RESTORE-18')
    await verifies(context, 'PW-SESSION-RESTORE-19')
    // 状態ディレクトリの場所に通常のファイルを置き、作れないようにする
    const session = prepareSession({ files: { '.pecot/state': 'not a directory' } })
    await startGithub([issueResponse({ number: 7, title: 't' })])

    const result = await restore(session.repository)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not record the work target: .+\n$/u)
  })

  it.for<readonly [string, string]>([
    ['JSON が不正', 'not json'],
    ['スキーマに違反', '{"host":"github.com"}'],
  ])('アクティブな設定ファイルが読めない（%s）とき、error の行を出して終了コード 1 で終わり、記録しない', async ([, content], context) => {
    await verifies(context, 'PW-SESSION-RESTORE-20')
    await verifies(context, 'PW-SESSION-RESTORE-21')
    const session = prepareSession({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: content } })

    const result = await restore(session.repository, '--issue', 'acme/demo/9')

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: invalid config file/u)
    expect(existsSync(path.join(session.project.root, '.pecot/state/.pecot-active'))).toBe(false)
  })
})
