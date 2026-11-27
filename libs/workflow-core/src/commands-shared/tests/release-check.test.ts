/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// リリース前の確認 runReleaseCheck。GitHub は偽サーバ、作業場所は一時リポにする。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { step, stepSync } from '../../../tests/_helpers/step.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
import { setEnvironment } from '../../../tests/_helpers/environment.js'
import { explains } from '../../../tests/_helpers/explains.js'
import type { ResponseRule } from '../../../tests/_helpers/fake-github/server.js'
import { gitForTest, createGitRepository } from '../../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { startServer, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { CommandExit } from '../command-definition.js'
import { runReleaseCheck } from '../release-check.js'
import type { ReleaseCheckInput } from '../release-check.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

useFakeGithub()

const startingDirectory = process.cwd()
const REPOSITORY = '/repos/acme/demo'
const CHANGELOG = '# Changelog\n\n## [0.2.0] - 2026-01-02\n\n### 追加\n\n- 新機能 A\n\n## [0.1.0] - 2026-01-01\n\n### 追加\n\n- 初回リリース\n'
const OPEN = { state: 'open', per_page: '100' }
const SECRET = { state: 'open', hide_secret: 'true', per_page: '100' }
const COUNTS = 'count: open Dependabot alerts: 0\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n'

afterEach(() => {
  process.chdir(startingDirectory)
})

function listRule(kind: string, query: Readonly<Record<string, string>>, body: unknown, status = 200): ResponseRule {
  return { match: { method: 'GET', path: `${REPOSITORY}/${kind}/alerts`, query }, respond: { status, body }, times: 1 }
}

interface Alerts {
  readonly dependabot?: ResponseRule
  readonly codeScanning?: ResponseRule
  readonly secretScanning?: ResponseRule
}

function alertRules(alerts: Readonly<Alerts> = {}): ResponseRule[] {
  return [
    alerts.dependabot ?? listRule('dependabot', OPEN, []),
    alerts.codeScanning ?? listRule('code-scanning', OPEN, []),
    alerts.secretScanning ?? listRule('secret-scanning', OPEN, []),
  ]
}

const compareRule = (aheadBy: number): ResponseRule => ({ match: { method: 'GET', path: `${REPOSITORY}/compare/main...develop` }, respond: { status: 200, body: { ahead_by: aheadBy } }, times: 1 })

interface Setup {
  readonly repository?: Record<string, unknown>
  readonly files?: Readonly<Record<string, string>>
  readonly origin?: boolean
}

// プロジェクトの設定と origin（ssh の形）を持つ一時リポを作り、そこへ移る。偽の ssh は空のリポにつなぐ
function prepare(setup: Readonly<Setup> = {}): string {
  const repository = { owner: 'acme', name: 'demo', develop_branch: 'develop', release_branch: 'main', ...setup.repository }
  const config = { host: 'github.com', owner: 'acme', project: { number: 1, id: 'PVT_1', board_url: 'https://github.com/users/acme/projects/1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } } } }, repositories: [repository] }
  const root = createGitRepository({ '.pecot/config/projects/github.com_acme_board_acme.json': `${JSON.stringify(config)}\n`, ...setup.files })
  if (setup.origin !== false) {
    const remote = makeTemporaryDirectory('pecot-origin-')
    gitForTest(remote, ['init', '-q', '--bare'])
    const ssh = path.join(remote, 'fake-ssh')
    writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o755 })
    gitForTest(root, ['remote', 'add', 'origin', 'git@github.com:acme/demo.git'])
    gitForTest(root, ['config', 'core.sshCommand', ssh])
  }
  process.chdir(root)
  setEnvironment({ PECOT_GITHUB_COM_TOKEN: 'ghs_secret-token-value', GITHUB_REPOSITORY: 'acme/demo' })
  return root
}

interface Outcome {
  readonly code: number
  readonly kind: string | undefined
  readonly stdout: string
  readonly stderr: string
}

async function check(rules: readonly ResponseRule[], input: Readonly<ReleaseCheckInput> = {}): Promise<Outcome> {
  await startServer(rules)
  const io = capture()
  try {
    const code = await runReleaseCheck(input, io)
    return { code, kind: undefined, stdout: io.out.join(''), stderr: io.err.join('') }
  }
  catch (error: unknown) {
    if (!(error instanceof CommandExit)) throw error
    return { code: error.exitCode, kind: error.kind, stdout: io.out.join(''), stderr: io.err.join('') }
  }
}

const stderrOf = (outcome: Readonly<Outcome>): string => outcome.stderr

describe('runReleaseCheck', () => {
  it('Nx のリポで alert が 0 件なら、3 種の件数を出して CHANGELOG を読まずに通る', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。`release_type` が `nx` のリポジトリで alert が 0 件の場合に、3 つの `count` の行を出して 0 を返すことを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await step('リリース前の確認を呼ぶ', async () => await check(alertRules()))
    stepSync('結果を確認する', () => {
      expect(outcome.code).toBe(0)
      expect(stderrOf(outcome)).toBe(COUNTS)
      expect(outcome.stdout).toBe('')
    })
  })

  it('Dependabot の open の alert は、件数と重大度を warning に出して通る', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。open の Dependabot alert が 2 件ある場合に、重大度と一覧を `warning` の行に出し、止めずに 0 を返すことを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const alerts = [{ number: 3, dependency: { package: { name: 'glob' } }, security_vulnerability: { severity: 'critical' } }, { number: 4 }]
    const outcome = await check(alertRules({ dependabot: listRule('dependabot', OPEN, alerts) }))
    expect(outcome.code).toBe(0)
    expect(stderrOf(outcome)).toContain('warning: 2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n  #3 (glob, critical)\n  #4\n')
  })

  it('Dependabot の alert が 1 件で重大度が無ければ、単数形で重大度を省いた warning を出す', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。重大度の無い open の Dependabot alert が 1 件ある場合に、単数形で重大度の無い `warning` の行を出すことを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check(alertRules({ dependabot: listRule('dependabot', OPEN, [{ number: 8 }]) }))
    expect(outcome.code).toBe(0)
    expect(stderrOf(outcome)).toContain('warning: 1 open Dependabot alert. The release is not blocked.\n  #8\n')
  })

  it('Dependabot の alert が無効のリポジトリでは、skip の行を出して通る', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。Dependabot alert の機能が無効のリポジトリで、`skipped` の行を出して 0 を返すことを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check([...alertRules({ dependabot: listRule('dependabot', OPEN, { message: 'disabled' }, 403) }), { match: { method: 'GET', path: `${REPOSITORY}/vulnerability-alerts` }, respond: { status: 404, body: { message: 'Not Found' } }, times: 1 }])
    expect(outcome.code).toBe(0)
    expect(stderrOf(outcome)).toContain('skipped: Dependabot alerts (feature disabled)')
  })

  it('Dependabot alert を読めなくても、理由を warning に出して通る', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。Dependabot alert の取得が 502 で失敗した場合に、理由を `warning` の行に出し、残りの確認を続けて 0 を返すことを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check(alertRules({ dependabot: listRule('dependabot', OPEN, { message: 'Bad Gateway' }, 502) }))
    expect(outcome.code).toBe(0)
    expect(stderrOf(outcome)).toMatch(/^warning: could not check Dependabot alerts\. The release is not blocked\.\n {2}reason: .*502/u)
  })

  it('code scanning に open の alert があると、error を出して失敗にするが、残りの確認は続ける', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。code scanning に open の alert が 1 件ある場合に、`error` の行を出して終了コード 1 で止め、secret scanning の確認は続けることを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check(alertRules({ codeScanning: listRule('code-scanning', OPEN, [{ number: 10, rule: { severity: 'error' } }]) }))
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('preflight-failed')
    expect(stderrOf(outcome)).toContain('error: code scanning has 1 open alert\n  #10\n')
    expect(stderrOf(outcome)).toContain('count: open secret scanning alerts: 0\n')
  })

  it('secret scanning に open の alert が複数あると、複数形の error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。secret scanning に open の alert が 2 件ある場合に、複数形の `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check(alertRules({ secretScanning: listRule('secret-scanning', SECRET, [{ number: 4 }, { number: 5 }]) }))
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('error: secret scanning has 2 open alerts\n  #4\n  #5\n')
  })

  it('code scanning の alert を読めないと、理由を error に出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。code scanning の取得が権限不足の 403 で失敗した場合に、理由を `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check(alertRules({ codeScanning: listRule('code-scanning', OPEN, { message: 'Resource not accessible by integration' }, 403) }))
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('error: could not check code scanning:')
  })

  it('Nx のリポで version を渡すと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。`release_type` が `nx` のリポジトリで `version` を渡した場合に、GitHub を読まずに `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { release_type: 'nx' } })
    const outcome = await check([], { version: '0.2.0' })
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('invalid-input')
    expect(stderrOf(outcome)).toMatch(/^error: version and package cannot be used when release_type is nx/u)
  })

  it('version の形が誤っていると、alert を読まずに error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。`version` が semver の形でない場合に、GitHub を読まずに `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check([], { version: 'abc' })
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('invalid-input')
    expect(stderrOf(outcome)).toMatch(/^error: .*abc/u)
  })

  it('Nx でないリポで通ると、コミット数を出し、バージョン・タグ・リリースノートを標準出力に出す', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。Nx でないリポジトリで alert が 0 件、開発ブランチが 2 コミット進んでいる場合に、CHANGELOG の最新のバージョンとリリースノートを標準出力に出して 0 を返すことを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check([...alertRules(), compareRule(2)])
    expect(outcome.code).toBe(0)
    expect(stderrOf(outcome)).toBe(`${COUNTS}count: commits to release (origin/develop -> origin/main): 2\n`)
    expect(outcome.stdout).toBe('version: 0.2.0\ntag: v0.2.0\n\n### 追加\n\n- 新機能 A\n')
  })

  it('CHANGELOG が無いと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。Nx でないリポジトリに CHANGELOG が無い場合に、見つからないファイルを `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare()
    const outcome = await check(alertRules())
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('preflight-failed')
    expect(stderrOf(outcome)).toContain('error: CHANGELOG.md not found:')
  })

  it('リリースするコミットが無いと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。開発ブランチとリリースブランチに差が無い場合に、リリースするものが無いことを `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check([...alertRules(), compareRule(0)])
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('there is nothing to release')
  })

  it('コミット数の取得が GitHub のエラーで失敗すると、取得できなかった旨の error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。ブランチの比較が 404 で失敗した場合に、コミットを数えられなかった旨を `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check([...alertRules(), { match: { method: 'GET', path: `${REPOSITORY}/compare/main...develop` }, respond: { status: 404, body: { message: 'Not Found' } }, times: 1 }])
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('error: could not count the commits from main to develop:')
  })

  it('開発ブランチが未設定だと、設定の案内つきの error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。リポジトリに開発ブランチが設定されていない場合に、設定の方法を添えた `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { develop_branch: '' }, files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check(alertRules())
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('repo-setting-missing')
    expect(stderrOf(outcome)).toContain('develop_branch is not set for acme/demo')
  })

  it('リリースブランチが未設定だと、設定の案内つきの error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。リポジトリにリリースブランチが設定されていない場合に、設定の方法を添えた `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { release_branch: '' }, files: { 'CHANGELOG.md': CHANGELOG } })
    const outcome = await check(alertRules())
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('repo-setting-missing')
    expect(stderrOf(outcome)).toContain('release_branch is not set for acme/demo')
  })

  it('monorepo で package を渡さないと、候補を並べた error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。パッケージを登録したリポジトリで `package` を渡さない場合に、登録済みの名前を並べた `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { packages: [{ name: 'core', changelog: 'core/CHANGELOG.md' }, { name: 'cli', changelog: 'cli/CHANGELOG.md' }] } })
    const outcome = await check([])
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('invalid-input')
    expect(stderrOf(outcome)).toContain('acme/demo is a monorepo')
    expect(stderrOf(outcome)).toContain('available: core, cli')
  })

  it('monorepo で未登録の package を渡すと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。パッケージを登録したリポジトリで未登録の名前を `package` として渡した場合に、`error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ repository: { packages: [{ name: 'core', changelog: 'core/CHANGELOG.md' }] } })
    const outcome = await check([], { package: 'other' })
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('package \'other\' is not registered in acme/demo')
  })

  it('monorepo で package を渡すと、そのパッケージの CHANGELOG とタグの接頭辞で確認する', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。パッケージを登録したリポジトリで `package` を渡した場合に、そのパッケージの CHANGELOG を読み、パッケージ名を接頭辞としたタグを出力することを確認します。')
    prepare({ repository: { packages: [{ name: 'core', changelog: 'core/CHANGELOG.md' }] }, files: { 'core/CHANGELOG.md': CHANGELOG } })
    const outcome = await check([...alertRules(), compareRule(1)], { package: 'core' })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/^version: 0\.2\.0\ntag: core-v?0\.2\.0\n/u)
  })

  it('packages の無いリポジトリで package を渡すと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。パッケージを登録していないリポジトリで `package` を渡した場合に、monorepo でのみ使える旨の `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare()
    const outcome = await check([], { package: 'core' })
    expect(outcome.code).toBe(1)
    expect(stderrOf(outcome)).toContain('acme/demo has no packages configured')
  })

  it('repo の形が誤っていると、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。`repo` が `owner/repo` の形でない場合に、形式を案内する `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare()
    const outcome = await check([], { repo: 'not-a-repo' })
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('invalid-input')
    expect(stderrOf(outcome)).toContain('repo has an invalid form')
  })

  it('対象のリポジトリを決められないと、error を出して失敗にする', async () => {
    await explains('リリース前の確認 `runReleaseCheck` のテストです。`repo` を渡さず、git の remote も無い場合に、リポジトリを読めない旨の `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ origin: false })
    const outcome = await check([])
    expect(outcome.code).toBe(1)
    expect(outcome.kind).toBe('git-unresolved')
    expect(stderrOf(outcome)).toContain('the repository is ambiguous')
  })
})
