import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SESSION_COMMANDS } from '../../src/commands/session.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import { CONFIG_FILE, issueFailure, issueResponse, prepareSession } from '../_helpers/session-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const ACTIVE = { '.pecot/state/.pecot-active': 'acme/demo/7\n' }
const HEADER = '# Session status\n\n'
const TABLE_HEAD = '| Flag | State | Content |\n|------|-------|---------|\n'

async function status(directory: string): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['session', 'status', '-D', directory], SESSION_COMMANDS)
}

describe('session status', () => {
  it('--directory を渡すと、ブランチ・リポジトリ・推定した Issue・フラグの表を標準出力に出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-01')
    await verifies(context, 'PW-SESSION-STATUS-02')
    await verifies(context, 'PW-SESSION-STATUS-04')
    const { repository } = prepareSession()

    const result = await status(repository)

    expect(result).toEqual({
      code: 0,
      stdout: `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Inferred Issue: #7\n\n${TABLE_HEAD}| .pecot-active | unset |  |\n`,
      stderr: '',
    })
  })

  it('.pecot-active があるとき、表にその行を set と内容で出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-03')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueResponse({ number: 7, title: 't' })])
    const result = await status(repository)

    expect(result.stdout).toContain('| .pecot-active | set | acme/demo/7 |\n')
  })

  it('.pecot-active に参照があると、読んだ Issue の番号・題名・状態と本文を Active Issue の節に出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-05')
    await verifies(context, 'PW-SESSION-STATUS-06')
    const { repository } = prepareSession({ files: ACTIVE })
    const github = await startGithub([issueResponse({ number: 7, title: '見本の Issue', body: '本文の 1 行目\n本文の 2 行目\n' })])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      `${HEADER}- Branch: feat/demo/7\n- Repository: acme/demo\n- Inferred Issue: #7\n\n${TABLE_HEAD}| .pecot-active | set | acme/demo/7 |\n`
      + '\n## Active Issue\n\n#7 見本の Issue (OPEN)\n\n本文の 1 行目\n本文の 2 行目\n',
    )
    expect(github.requests()).toMatchObject([{ type: 'graphql', operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number: 7, commentLimit: 0 } }])
  })

  it('本文が空の Issue は、題名の行までで Active Issue の節を終える', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-05')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueResponse({ number: 7, title: '題名だけ', state: 'CLOSED' })])

    const result = await status(repository)

    expect(result.stdout.endsWith('\n## Active Issue\n\n#7 題名だけ (CLOSED)\n')).toBe(true)
  })

  it('ブランチ名を読めないとき、Branch の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-07')
    await verifies(context, 'PW-SESSION-STATUS-08')
    prepareSession()
    const outsideGit = makeTemporaryDirectory('pecot-plain-')

    const result = await status(outsideGit)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Branch: unknown\n')
  })

  it('origin も他の remote も無いとき、Repository の行に unknown を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-09')
    await verifies(context, 'PW-SESSION-STATUS-10')
    const { repository } = prepareSession({ remotes: {} })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Repository: unknown\n')
    expect(result.stdout).toContain('- Branch: feat/demo/7\n')
  })

  it('origin が無くても、最初の remote のリポジトリを出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-01')
    const { repository } = prepareSession({ remotes: { upstream: 'https://ghes.example.com/acme/other.git' } })

    const result = await status(repository)

    expect(result.stdout).toContain('- Repository: acme/other\n')
  })

  it('ブランチ名の末尾が番号でないとき、Inferred Issue の行に none を出して続ける', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-11')
    await verifies(context, 'PW-SESSION-STATUS-12')
    const { repository } = prepareSession({ branch: 'feat/no-number' })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('- Inferred Issue: none\n')
  })

  it('.pecot-active が Issue の参照として読めないとき、Active Issue の節を出さずに続ける', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-13')
    await verifies(context, 'PW-SESSION-STATUS-14')
    const { repository } = prepareSession({ files: { '.pecot/state/.pecot-active': 'not a reference\n' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stdout).toContain('| .pecot-active | set | not a reference |\n')
    expect(result.stderr).toBe('')
  })

  it('参照があるのにアクティブなプロジェクトが無いとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-15')
    await verifies(context, 'PW-SESSION-STATUS-16')
    const { project, repository } = prepareSession({ files: ACTIVE })
    rmSync(path.join(project.root, '.pecot/config/projects/.active'))

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toBe('warning: cannot read the active Issue: no active project\n')
  })

  it('参照があるのに Issue を GitHub から読めないとき、節を出さずに warning を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-17')
    await verifies(context, 'PW-SESSION-STATUS-18')
    const { repository } = prepareSession({ files: ACTIVE })
    await startGithub([issueFailure(502)])

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: .*502/u)
  })

  it('--directory を省くと、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-19')

    const result = await runInProcess(['session', 'status'], SESSION_COMMANDS)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing option \'--directory\' / \'-D\'.')
  })

  it('--directory が存在するディレクトリでないとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-20')
    const { repository } = prepareSession()
    const missing = path.join(repository, 'x')

    const result = await status(missing)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr.replaceAll(/[│\s]+/gu, ' ')).toContain(`Invalid value for '--directory' / '-D': Directory '${missing}' does not exist.`)
  })

  it('アクティブな設定ファイルの形式が不正なとき、warning を標準エラーに出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-SESSION-STATUS-21')
    await verifies(context, 'PW-SESSION-STATUS-22')
    const { repository } = prepareSession({ files: { ...ACTIVE, [`.pecot/config/projects/${CONFIG_FILE}`]: '{"host":"github.com"}' } })

    const result = await status(repository)

    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('## Active Issue')
    expect(result.stderr).toMatch(/^warning: cannot read the active Issue: invalid config file/u)
  })
})
