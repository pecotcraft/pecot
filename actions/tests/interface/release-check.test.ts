/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// release-check の action を、inputs を置いてプロセス内で呼んで確かめる。GitHub は偽サーバ、作業場所は一時リポにする。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { main } from '../../src/release-check.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { gitForTest } from '../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../libs/workflow-core/tests/_helpers/temporary.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runActionCase, setUpProject, startGithub } from '../_helpers/action-case.js'
import type { ActionResult } from '../_helpers/action-case.js'
import { restRule } from '../_helpers/github-rules.js'

useIsolatedEnvironment()

const TOKEN = 'ghs_secret-token-value'
const REPOSITORY = '/repos/acme/demo'
const CHANGELOG = '# Changelog\n\n## [0.2.0] - 2026-01-02\n\n### 追加\n\n- 新機能 A\n- 新機能 B\n\n## [0.1.0] - 2026-01-01\n\n### 追加\n\n- 初回リリース\n'

const OPEN = { state: 'open', per_page: '100' }
const SECRET = { state: 'open', hide_secret: 'true', per_page: '100' }

interface Alerts {
  readonly dependabot?: ResponseRule
  readonly codeScanning?: ResponseRule
  readonly secretScanning?: ResponseRule
}

function listRule(kind: string, query: Readonly<Record<string, string>>, body: unknown): ResponseRule {
  return { match: { method: 'GET', path: `${REPOSITORY}/${kind}/alerts`, query }, respond: { status: 200, body }, times: 1 }
}

function failedList(kind: string, status: number, message: string): ResponseRule {
  return { match: { method: 'GET', path: `${REPOSITORY}/${kind}/alerts`, query: OPEN }, respond: { status, body: { message } }, times: 1 }
}

// 3 種の一覧の応答（この順で要求される）。省いた種類は 0 件
function alertRules(alerts: Readonly<Alerts> = {}): ResponseRule[] {
  return [
    alerts.dependabot ?? listRule('dependabot', OPEN, []),
    alerts.codeScanning ?? listRule('code-scanning', OPEN, []),
    alerts.secretScanning ?? listRule('secret-scanning', OPEN, []),
  ]
}

const COUNTS = 'count: open Dependabot alerts: 0\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n'

interface Setup {
  readonly releaseType?: 'nx'
  readonly files?: Readonly<Record<string, string>>
}

// プロジェクトの設定には、開発ブランチ develop とリリースブランチ main を置く。origin（ssh の形）は、偽の ssh で空のリポにつなぐ
function prepare(setup: Readonly<Setup> = {}): string {
  const config = { host: 'github.com', owner: 'acme', project: { number: 1, id: 'PVT_1', board_url: 'https://github.com/users/acme/projects/1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } } } }, repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop', release_branch: 'main', ...setup.releaseType !== undefined && { release_type: setup.releaseType } }] }
  const { root } = setUpProject({ files: { '.pecot/config/projects/github.com_acme_board_acme.json': `${JSON.stringify(config)}\n`, ...setup.files } })
  const remote = makeTemporaryDirectory('pecot-origin-')
  gitForTest(remote, ['init', '-q', '--bare'])
  const ssh = path.join(remote, 'fake-ssh')
  writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o755 })
  gitForTest(root, ['remote', 'add', 'origin', 'git@github.com:acme/demo.git'])
  gitForTest(root, ['config', 'core.sshCommand', ssh])
  return root
}

async function check(rules: readonly ResponseRule[], inputs: Readonly<Record<string, string | undefined>> = {}): Promise<ActionResult> {
  await startGithub(rules)
  return await runActionCase(main, { token: TOKEN, ...inputs })
}

describe('release check', () => {
  it('Nx のリポで alert が 0 件なら、3 種の件数を count の行で出し、CHANGELOG とタグを確かめずに通る', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-01')
    await verifies(context, 'PA-RELEASE-CHECK-06')
    await explains('`release-check` の action のテストです。`release_type` が `nx` のリポジトリで、3 種類の alert がどれも 0 件のときを確かめます。3 つの `count` の行を出し、終了コード 0 で終わることを確認します。CHANGELOG が無くても通ります。')
    prepare({ releaseType: 'nx' })
    const result = await check(alertRules())
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(COUNTS)
    expect(result.stdout).toBe('')
  })

  it('Dependabot の open の alert は warning の行で知らせ、通る', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-03')
    await explains('`release-check` の action のテストです。open の Dependabot alert が 2 件あるとき、件数・最も高い重大度・一覧を `warning` の行に出し、終了コード 0 で通ることを確認します。')
    prepare({ releaseType: 'nx' })
    const alerts = [
      { number: 1, dependency: { package: { name: 'minimatch' } }, security_vulnerability: { severity: 'medium' } },
      { number: 3, dependency: { package: { name: 'glob' } }, security_vulnerability: { severity: 'critical' } },
    ]
    const result = await check(alertRules({ dependabot: listRule('dependabot', OPEN, alerts) }))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: 2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n  #1 (minimatch, medium)\n  #3 (glob, critical)\n  → https://github.com/acme/demo/security/dependabot\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n')
  })

  it('Dependabot alert を読めなくても、理由を warning の行に出して通る', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-04')
    await explains('`release-check` の action のテストです。Dependabot alert の取得が 502 で失敗しても、理由を `warning` の行に出し、残りの確認を続けて終了コード 0 で通ることを確認します。')
    prepare({ releaseType: 'nx' })
    const result = await check(alertRules({ dependabot: failedList('dependabot', 502, 'Bad Gateway') }))
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: could not check Dependabot alerts\. The release is not blocked\.\n {2}reason: acme\/demo: GitHub API error: 502 Bad Gateway\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n$/u)
  })

  it('code scanning に open の alert があると、error の行を出して失敗にするが、残りの確認は続ける', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-02')
    await explains('`release-check` の action のテストです。code scanning に open の alert が 1 件あるときを確かめます。番号と一覧の URL を `error` の行に出して終了コード 1 で止め、secret scanning の確認は続けることを確認します。')
    prepare({ releaseType: 'nx' })
    const result = await check(alertRules({ codeScanning: listRule('code-scanning', OPEN, [{ number: 10, rule: { severity: 'error' } }]) }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('count: open Dependabot alerts: 0\nerror: code scanning has 1 open alert\n  #10\n  → https://github.com/acme/demo/security/code-scanning\n  close them (fixed, or dismissed with a reason) and run the check again\ncount: open secret scanning alerts: 0\n')
  })

  it('secret scanning に open の alert があると、error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-02')
    await explains('`release-check` の action のテストです。secret scanning に open の alert が 2 件あるとき、番号と一覧の URL を `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare({ releaseType: 'nx' })
    const result = await check(alertRules({ secretScanning: listRule('secret-scanning', SECRET, [{ number: 4, secret_type: 'token' }, { number: 5, secret_type: 'token' }]) }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('count: open Dependabot alerts: 0\ncount: open code scanning alerts: 0\nerror: secret scanning has 2 open alerts\n  #4\n  #5\n  → https://github.com/acme/demo/security/secret-scanning\n  close them (fixed, or dismissed with a reason) and run the check again\n')
  })

  it('code scanning の alert を読めないと、理由を error の行に出して失敗にし、残りの確認は続ける', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-05')
    await explains('`release-check` の action のテストです。code scanning の取得が権限不足の 403 で失敗するとき、理由を `error` の行に出して終了コード 1 で止め、secret scanning の確認は続けることを確認します。')
    prepare({ releaseType: 'nx' })
    const result = await check(alertRules({ codeScanning: failedList('code-scanning', 403, 'Resource not accessible by integration') }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('count: open Dependabot alerts: 0\nerror: could not check code scanning: acme/demo: code scanning: access denied Resource not accessible by integration\ncount: open secret scanning alerts: 0\n')
  })

  it('Nx のリポで version を渡すと、alert を読まずに error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-07')
    await explains('`release-check` の action のテストです。`release_type` が `nx` のリポジトリで `version` を渡すと、GitHub を読まずに `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ releaseType: 'nx' })
    const result = await check([], { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: version and package cannot be used when release_type is nx\n/u)
  })

  it('Nx でないリポで通ると、リリースするコミットの数を count の行で出し、バージョン・タグ・リリースノートを標準出力に出す', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-08')
    await explains('`release-check` の action のテストです。Nx でないリポジトリで、alert が 0 件、タグが無く、開発ブランチがリリースブランチより 2 コミット進んでいるときを確かめます。CHANGELOG の最新のバージョンを、`version:`・`tag:` の行とリリースノートで標準出力に出し、終了コード 0 で通ることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const result = await check([...alertRules(), restRule('GET', `${REPOSITORY}/compare/main...develop`, 200, { ahead_by: 2 })])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${COUNTS}count: commits to release (origin/develop -> origin/main): 2\n`)
    expect(result.stdout).toBe('version: 0.2.0\ntag: v0.2.0\n\n### 追加\n\n- 新機能 A\n- 新機能 B\n')
  })

  it('CHANGELOG が無いと、error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-09')
    await explains('`release-check` の action のテストです。Nx でないリポジトリに CHANGELOG が無いとき、見つからないファイルのパスを `error` の行に出して終了コード 1 で止めることを確認します。')
    const root = prepare()
    const result = await check(alertRules())
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${COUNTS}error: CHANGELOG.md not found: ${path.join(root, 'CHANGELOG.md')}\n`)
  })

  it('同じ名前のタグがローカルにあると、error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-09')
    await explains('`release-check` の action のテストです。リリースするバージョンと同じ名前のタグがローカルにすでにあるとき、`error` の行を出して終了コード 1 で止めることを確認します。')
    const root = prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    gitForTest(root, ['tag', 'v0.2.0'])
    const result = await check(alertRules(), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${COUNTS}error: tag already exists locally: v0.2.0\n`)
  })

  it('リリースするコミットが無いと、error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-09')
    await explains('`release-check` の action のテストです。開発ブランチとリリースブランチに差が無いとき、リリースするものが無いことを `error` の行に出して終了コード 1 で止めることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const result = await check([...alertRules(), restRule('GET', `${REPOSITORY}/compare/main...develop`, 200, { ahead_by: 0 })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${COUNTS}error: no difference between origin/main and origin/develop: there is nothing to release\n`)
  })

  it('version の形が誤っていると、alert を読まずに error の行を出して失敗にする', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-10')
    await explains('`release-check` の action のテストです。`version` が semver の形でないとき、GitHub を読まずに `error` の行を出して終了コード 1 で止めることを確認します。')
    prepare({ files: { 'CHANGELOG.md': CHANGELOG } })
    const result = await check([], { version: 'abc' })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: .*abc/u)
    expect(result.stderr).not.toContain('count:')
  })

  it('log-file を渡すと、出力の行を同じ順でそのファイルにも書く', async (context) => {
    await verifies(context, 'PA-RELEASE-CHECK-11')
    await explains('`release-check` の action のテストです。`log-file` に、まだ無いディレクトリの下のファイルを渡したとき、ディレクトリを作り、実行のログと同じ行を同じ順で書くことを確認します。失敗した確認の行も書きます。')
    const root = prepare({ releaseType: 'nx' })
    const result = await check(alertRules({ codeScanning: listRule('code-scanning', OPEN, [{ number: 10, rule: { severity: 'error' } }]) }), { 'log-file': '.pecot/tmp/release/preflight.log' })
    expect(result.code).toBe(1)
    expect(readFileSync(path.join(root, '.pecot/tmp/release/preflight.log'), 'utf8')).toBe(result.stderr)
  })
})
