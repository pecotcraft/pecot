// release_check・release_create・release_merge の振る舞い（PW-RELEASE-*）を、ツールをプロセス内で呼んで確かめる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { RELEASE_TOOLS } from '../../src/commands/release.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { startFakeGithub } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { alertPath, alertRules, compareRule, createProject, DEFAULT_REPOSITORY, failRemoteLookupFrom, NOTES_0_2_0, pathsOf, pullRequestResponse, rest, runRelease } from '../_helpers/release-sandbox.js'
import type { Project, ProjectOptions } from '../_helpers/release-sandbox.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'

useIsolatedEnvironment()

const WITH_BRANCHES: ProjectOptions = { remote: 'branches' }
const OTHER = { owner: 'acme', name: 'other', develop_branch: 'develop', release_branch: 'release' }
const PACKAGES = { ...DEFAULT_REPOSITORY, packages: [{ name: 'pkg-a', changelog: 'packages/a/CHANGELOG.md' }] }
const PACKAGE_FILES = { 'packages/a/CHANGELOG.md': `# Changelog\n\n## [0.2.0] - 2026-01-02\n\n${NOTES_0_2_0}\n` }
const NO_PACKAGE_FILES = { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n' }
const USAGE_ERROR = 2
const WITHOUT_RELEASE_BRANCH: ProjectOptions = { repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] }

interface CheckFailure { readonly name: string, readonly options: ProjectOptions, readonly input: Readonly<Record<string, unknown>>, readonly rules: readonly ResponseRule[], readonly kind: string, readonly detail: string, readonly id: string }

function runPreflight(project: Readonly<Project>, input: Readonly<Record<string, unknown>> = {}, rules: readonly ResponseRule[] = alertRules()): ReturnType<typeof runRelease> {
  return runRelease(project, 'release_check', input, rules)
}

function runCounted(project: Readonly<Project>, input: Readonly<Record<string, unknown>> = {}, rules: readonly ResponseRule[] = alertRules(), ahead = 1, repository = 'acme/demo'): ReturnType<typeof runRelease> {
  return runPreflight(project, input, [...rules, compareRule(ahead, repository)])
}

function runCreate(project: Readonly<Project>, input: Readonly<Record<string, unknown>>, rules: readonly ResponseRule[] = []): ReturnType<typeof runRelease> {
  return runRelease(project, 'release_create', input, rules)
}

const MERGE_INPUT = { pr_ref: 'acme/demo/31' }

function runMerge(project: Readonly<Project>, input: Readonly<Record<string, unknown>> = MERGE_INPUT, rules: readonly ResponseRule[] = []): ReturnType<typeof runRelease> {
  return runRelease(project, 'release_merge', input, rules)
}

function project(options: Readonly<ProjectOptions> = {}): Project {
  return createProject(options)
}

function projectWithBrokenRemote(options: Readonly<ProjectOptions> = {}): Project {
  const created = project(options)
  failRemoteLookupFrom(created, 2)
  return created
}

const UNREADABLE_REMOTE = 'could not read the repository from the URL of the Git remote origin'
const AMBIGUOUS_LINES = 'error: the repository is ambiguous\n  could not read the repository from the URL of the Git remote origin\n  give repo: <owner/repo>\n'

// origin を手元の bare リポのパスに付け替えて、URL から owner/repo を読めなくする
function projectWithBareOrigin(options: Readonly<ProjectOptions> = {}): Project {
  const created = project({ remote: 'empty', ...options })
  gitForTest(created.directory, ['remote', 'set-url', 'origin', path.join(created.root, 'remotes', 'acme', 'demo.git')])
  return created
}

function runMergeMismatch(): ReturnType<typeof runRelease> {
  return runMerge(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), { pr_ref: 'acme/other/31', repo: 'acme/other' }, [])
}

function releaseCreated(tag = 'v0.2.0', name = tag, repository = 'acme/demo'): ResponseRule {
  return rest('POST', `/repos/${repository}/releases`, 201, { id: 1, tag_name: tag, name, html_url: `https://ghes.example.com/${repository}/releases/tag/${tag}` })
}

const DEPENDABOT_ALERTS = [
  { number: 1, dependency: { package: { name: 'minimatch' } }, security_vulnerability: { severity: 'medium' } },
  { number: 2, dependency: { package: { name: 'glob' } }, security_vulnerability: { severity: 'critical' } },
]
const FORBIDDEN = { message: 'Resource not accessible by integration' }
const NOT_FOUND = { message: 'Not Found' }
const ALERTS_URL = 'https://ghes.example.com/acme/demo/security/dependabot'

// release の MCP のツールを、作業ディレクトリで同じプロセスの中のクライアントから 1 回呼ぶ
async function callTool(target: Readonly<Project>, name: string, arguments_: Readonly<Record<string, unknown>>, rules: readonly ResponseRule[]): Promise<ToolOutcome> {
  const server = await startFakeGithub(rules)
  setEnvironment({ PECOT_GITHUB_API_URL: server.url })
  const original = process.cwd()
  process.chdir(target.directory)
  try {
    const result = await callToolOnce(RELEASE_TOOLS, name, arguments_)
    expect({ problems: server.problems(), unused: server.unused() }).toEqual({ problems: [], unused: [] })
    return result
  }
  finally {
    process.chdir(original)
    await server.close()
  }
}

describe('release_check', () => {
  it('版を省いて打つと、CHANGELOG の最初の版を対象にチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-01')
    await explains('`release_check` の対象の版のテストです。版を省略した場合は、CHANGELOG の最初の版を対象にチェックし、`version` と `tag` の行を出力することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('version: 0.2.0\ntag: v0.2.0\n')
  })

  it('版を渡して打つと、その版を対象にチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-02')
    await explains('`release_check` の対象の版のテストです。版を指定した場合は、その版を対象にチェックし、その版のリリースノートを標準出力へ出力することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES), { version: '0.1.0' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('version: 0.1.0\ntag: v0.1.0\n\n### 追加\n\n- 初回リリース\n')
  })

  it('package を付けて打つと、パッケージ名を接頭辞にしたタグ名でチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-03')
    await explains('`release_check` の `package` のテストです。`package` を指定した場合は、パッケージ名を接頭辞にしたタグ名でチェックすることを確認します。')
    const result = await runCounted(project({ ...WITH_BRANCHES, repositories: [PACKAGES], files: PACKAGE_FILES }), { package: 'pkg-a' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('tag: pkg-a-v0.2.0\n')
  })

  it('打つと、Dependabot・code scanning・secret scanning の open の alert を調べる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-04')
    await explains('`release_check` のアラート確認のテストです。実行した場合は、Dependabot など 3 種類の未解決のアラートを取得し、続けて release と develop の差分を取得することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(pathsOf(result)).toEqual([
      `GET ${alertPath('dependabot')}`,
      `GET ${alertPath('code')}`,
      `GET ${alertPath('secret')}`,
      'GET /repos/acme/demo/compare/release...develop',
    ])
    expect(result.requests.slice(0, 3).map(request => request.type === 'rest' ? request.query['state'] : undefined)).toEqual(['open', 'open', 'open'])
  })

  it('打つと、alert の結果の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-05')
    await explains('`release_check` のアラート件数の出力のテストです。実行した場合は、3 種類のアラートの件数を `count` の行として標準エラーへ出力することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.stderr).toContain('count: open Dependabot alerts: 0\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n')
  })

  it('3 種の機能が無効だと、skipped の行を標準エラーに出し、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-05')
    await explains('`release_check` の機能が無効な場合のテストです。3 種類の機能がすべて無効な場合は、`skipped` の行を標準エラーへ出力し、終了コード 0 で終わることを確認します。')
    const rules = alertRules({
      dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 404)],
      code: [rest('GET', alertPath('code'), 403, { message: 'Advanced Security must be enabled for this repository to use code scanning.' })],
      secret: [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, { security_and_analysis: { secret_scanning: { status: 'disabled' } } })],
    })
    const result = await runCounted(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('skipped: Dependabot alerts (feature disabled)\nskipped: code scanning (feature disabled)\nskipped: secret scanning (feature disabled)\n')
  })

  it('open の Dependabot alert があると、件数と最も重い severity を添えた warning の行を標準エラーに出す', async () => {
    await explains('`release_check` の Dependabot アラートのテストです。未解決の Dependabot アラートが存在する場合は、件数と最も重い severity を含む `warning` の行を出力し、リリースは止めないことを確認します。')
    const rules = alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 200, DEPENDABOT_ALERTS)] })
    const result = await runCounted(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: 2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n')
    expect(result.stderr).toContain('#1 (minimatch, medium)')
    expect(result.stderr).toContain('#2 (glob, critical)')
    expect(result.stderr).toContain('https://ghes.example.com/acme/demo/security/dependabot')
  })

  it('severity と package を持たない Dependabot alert が 1 件なら、単数の warning の行に番号だけを出す', async () => {
    await explains('`release_check` の Dependabot アラートのテストです。severity と package を持たないアラートが 1 件の場合は、単数形の `warning` の行に番号だけを出力することを確認します。')
    const rules = alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 200, [{ number: 3 }])] })
    const result = await runCounted(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: 1 open Dependabot alert. The release is not blocked.\n  #3\n')
  })

  it('open の code scanning alert が 2 件あると、複数形の error の行を出す', async () => {
    await explains('`release_check` の code scanning アラートのテストです。未解決のアラートが 2 件の場合は、複数形の `error` の行を出力し、終了コード 1 で終わることを確認します。')
    const rules = alertRules({ code: [rest('GET', alertPath('code'), 200, [{ number: 10, rule: { severity: 'error' } }, { number: 11, rule: { severity: 'error' } }])] })
    const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: code scanning has 2 open alerts\n  #10\n  #11\n')
  })

  it('release_type が nx のリポジトリに打つと、alert だけを調べる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-07')
    await explains('`release_check` の `release_type` が `nx` の場合のテストです。`nx` のリポジトリでは、アラートだけを確認し、リリースノートとコミット数は出力しないことを確認します。')
    const result = await runPreflight(project({ repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(pathsOf(result)).toHaveLength(3)
    expect(result.stderr).toContain('count: open secret scanning alerts: 0\n')
    expect(result.stderr).not.toContain('commits to release')
  })

  it('repo が今の git remote のリポジトリと食い違うと、warning の行を標準エラーに出す', async () => {
    await explains('`release_check` の `repo` のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、`warning` の行を標準エラーへ出力することを確認します。')
    const result = await runCounted(project({ ...WITH_BRANCHES, repositories: [DEFAULT_REPOSITORY, OTHER] }), { repo: 'acme/other' }, alertRules({}, 'acme/other'), 1, 'acme/other')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: using repo acme/other (current Git remote: acme/demo)\n')
  })

  it('チェックが通ると、version・tag の行とリリースノートを標準出力に出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-09')
    await explains('`release_check` の成功時の出力のテストです。チェックが通った場合は、`version` と `tag` の行とリリースノートを標準出力へ出力することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.stdout).toBe(`version: 0.2.0\ntag: v0.2.0\n\n${NOTES_0_2_0}\n`)
  })

  it('チェックが通ると、release へ入るコミット数の count の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-10')
    await explains('`release_check` のコミット数の出力のテストです。チェックが通った場合は、release へ入るコミット数を `count` の行として標準エラーへ出力することを確認します。')
    const result = await runCounted(project(WITH_BRANCHES), {}, alertRules(), 2)
    expect(result.stderr).toContain('count: commits to release (origin/develop -> origin/release): 2\n')
  })

  describe('Dependabot alert の状態を読めない', () => {
    const rules = alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 204)] })

    it('もし Dependabot alert の状態を読めないなら、warning の行を標準エラーに出す', async () => {
      await explains('`release_check` の Dependabot アラートを取得できない場合のテストです。アラートの状態を取得できなかった場合は、`warning` の行を標準エラーへ出力することを確認します。')
      const result = await runCounted(project(WITH_BRANCHES), {}, rules)
      expect(result.stderr).toContain('warning: could not check Dependabot alerts. The release is not blocked.\n')
      expect(result.stderr).toContain('reason: acme/demo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)')
    })

    it('もし Dependabot alert の状態を読めないなら、残りの確認を続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-12')
      await explains('`release_check` の Dependabot アラートを取得できない場合のテストです。アラートの状態を取得できなかった場合でも、残りの確認を続け、終了コード 0 で終わることを確認します。')
      const result = await runCounted(project(WITH_BRANCHES), {}, rules)
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('count: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n')
      expect(result.stdout).toContain('version: 0.2.0')
    })
  })

  it('もし open の code scanning alert があるなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の code scanning アラートのテストです。未解決のアラートが存在する場合は、`error` の行を出力し、終了コード 1 で終わることを確認します。')
    const rules = alertRules({ code: [rest('GET', alertPath('code'), 200, [{ number: 10, rule: { severity: 'error' } }])] })
    const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: code scanning has 1 open alert\n')
    expect(result.stdout).toBe('')
  })

  it('もし open の secret scanning alert があるなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の secret scanning アラートのテストです。未解決のアラートが存在する場合は、`error` の行を出力し、終了コード 1 で終わることを確認します。')
    const rules = alertRules({ secret: [rest('GET', alertPath('secret'), 200, [{ number: 5 }])] })
    const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: secret scanning has 1 open alert\n')
  })

  const undeterminable = [
    { kind: 'code scanning', rules: alertRules({ code: [rest('GET', alertPath('code'), 403, FORBIDDEN)] }) },
    { kind: 'secret scanning', rules: alertRules({ secret: [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, {})] }) },
  ]

  it.for(undeterminable)('もし $kind の状態を判定できないなら、終了コード 1 で終わる', async ({ kind, rules }) => {
    await explains('`release_check` のアラートの状態を判定できない場合のテストです。code scanning または secret scanning の状態を判定できない場合は、`error` の行を出力し、終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`error: could not check ${kind}: acme/demo: `)
  })

  describe('alert の確認が 1 つ失敗した', () => {
    const rules = alertRules({
      code: [rest('GET', alertPath('code'), 403, FORBIDDEN)],
      secret: [rest('GET', alertPath('secret'), 200, [{ number: 5 }])],
    })

    it('もし alert の確認が 1 つ失敗したなら、残りの確認も行う', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-16')
      await explains('`release_check` のアラート確認の失敗のテストです。アラートの確認が 1 つ失敗した場合でも、残りのアラートも確認し、それぞれの結果を出力することを確認します。')
      const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
      expect(pathsOf(result)).toContain(`GET ${alertPath('secret')}`)
      expect(result.stderr).toContain('error: could not check code scanning:')
      expect(result.stderr).toContain('error: secret scanning has 1 open alert')
    })

    it('もし alert の確認が 1 つ失敗したなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-17')
      await explains('`release_check` のアラート確認の失敗のテストです。アラートの確認が 1 つ失敗した場合は、終了コード 1 で終わり、標準出力には何も出力しないことを確認します。')
      const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
    })
  })

  describe('alert の確認が例外で失敗した', () => {
    it('もしトークンが存在しないなら、code・secret scanning の確認ごとに could not check alerts の行を出し、残りも続けて、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-16')
      await verifies(context, 'PW-RELEASE-CHECK-17')
      await explains('`release_check` の認証エラーのテストです。GitHub のトークンが存在しない場合は、種類ごとに `could not check alerts` の行を出力し、残りの処理も続けて、終了コード 1 で終わることを確認します。')
      const result = await runPreflight(project({ ...WITH_BRANCHES, hasToken: false }), {}, [])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('warning: could not check Dependabot alerts. The release is not blocked.\n')
      expect(result.stderr.split('error: could not check alerts: authentication error')).toHaveLength(3)
      expect(result.stdout).toBe('')
    })
  })

  it('もし git リポジトリのルートを見つけられないなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の git リポジトリの検出のテストです。git リポジトリのルートが見つからない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ isGit: false }), { repo: 'acme/demo' }, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not find the root directory of the git repository\n')
  })

  it('もし対象のリポを含む設定が 2 つ以上あり、アクティブなプロジェクトがそのどれも指さないなら、候補の名前と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`release_check` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), {}, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is in 2 project configs\n')
    expect(result.stderr).toContain('choose one with project: <NAME>')
    expect(result.stderr).toContain('available: ')
  })

  it('もし対象のリポを含む設定が存在しないなら、repo-not-in-project の行を出して終了コード 1 で終わる', async () => {
    await explains('`release_check` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ isActive: false }), {}, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is not in any project config\n')
  })

  it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-43')
    await explains('`release_check` の `project` のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、`project` で指定した設定を使ってチェックが通ることを確認します。')
    const result = await runCounted(project({ ...WITH_BRANCHES, extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), { project: 'second' })
    expect(result.code).toBe(0)
  })

  it.for([{ name: 'version', input: { version: '0.2.0' } }, { name: 'package', input: { package: 'pkg-a' } }])('もし nx のリポジトリに $name を渡したなら、終了コード 1 で終わる', async ({ input }) => {
    await explains('`release_check` の `nx` のリポジトリの引数のテストです。`release_type` が `nx` のリポジトリに、版またはパッケージを指定した場合は、使用できない旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }), input, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: version and package cannot be used when release_type is nx\n  call the tool without them (Nx Release decides the version)\n')
  })

  it('もし packages を設定したリポジトリに package を渡さなかったなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` のモノレポの `package` のテストです。`packages` を設定したリポジトリで `package` を省略した場合は、モノレポである旨と候補を出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), {}, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo is a monorepo')
    expect(result.stderr).toContain('available: pkg-a')
  })

  it('もし package が設定に登録していないパッケージ名なら、終了コード 1 で終わる', async () => {
    await explains('`release_check` のモノレポの `package` のテストです。設定に登録していないパッケージ名を指定した場合は、登録されていない旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), { package: 'unknown' }, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('package \'unknown\' is not registered in acme/demo')
  })

  it('もし packages を設定していないリポジトリに package を渡したなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の `package` のテストです。`packages` を設定していないリポジトリに `package` を指定した場合は、パッケージが未設定である旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project(), { package: 'pkg-a' }, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo has no packages configured\n  package can only be used in a monorepo\n')
  })

  it.for([
    { kind: 'develop', repository: { owner: 'acme', name: 'demo', release_branch: 'release' } },
    { kind: 'release', repository: { owner: 'acme', name: 'demo', develop_branch: 'develop' } },
  ])('もし $kind の branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async ({ kind, repository }) => {
    await explains('`release_check` のブランチ設定のテストです。`develop_branch` または `release_branch` が未設定の場合は、設定コマンドを案内する `error` の行を標準エラーへ出力することを確認します。')
    const result = await runPreflight(project({ repositories: [repository] }))
    expect(result.stderr).toContain(`error: ${kind}_branch is not set for acme/demo\n`)
    expect(result.stderr).toContain(`project_link with repo: "acme/demo", ${kind}_branch: <branch>`)
  })

  it.for([
    { kind: 'develop', repository: { owner: 'acme', name: 'demo', release_branch: 'release' } },
    { kind: 'release', repository: { owner: 'acme', name: 'demo', develop_branch: 'develop' } },
  ])('もし $kind の branch を設定していないなら、終了コード 1 で終わる', async ({ repository }) => {
    await explains('`release_check` のブランチ設定のテストです。`develop_branch` または `release_branch` が未設定の場合は、標準出力に何も出力せず、終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ repositories: [repository] }))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('もし CHANGELOG が存在しないなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の CHANGELOG のテストです。CHANGELOG が存在しない場合は、ファイル名を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ ...WITH_BRANCHES, files: { 'CHANGELOG.md': undefined } }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CHANGELOG.md')
  })

  it('もし版を省いて CHANGELOG に版が 1 つも存在しないなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の CHANGELOG のテストです。版を省略し、CHANGELOG に版が 1 つも存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ ...WITH_BRANCHES, files: NO_PACKAGE_FILES }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: ')
    expect(result.stdout).toBe('')
  })

  it('もし渡した版が X.Y.Z の形でないなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の版の形式のテストです。指定した版が `X.Y.Z` の形式でない場合は、その値を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project(WITH_BRANCHES), { version: '1.2' }, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('1.2')
  })

  it('もしタグがローカルに既にあるなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` のタグの重複のテストです。タグがローカルに既に存在する場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ ...WITH_BRANCHES, localTags: ['v0.2.0'] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: tag already exists locally: v0.2.0\n')
  })

  it('もしタグが remote に既にあるなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` のタグの重複のテストです。タグが remote に既に存在する場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ ...WITH_BRANCHES, remoteTags: ['v0.2.0'] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: tag already exists on the remote: v0.2.0\n')
  })

  it('もし <remote>/<develop_branch> のコミットがすべて <remote>/<release_branch> に含まれるなら、リリースするものが存在しないとして終了コード 1 で終わる', async () => {
    await explains('`release_check` のリリース対象のコミットのテストです。develop のコミットがすべて release に含まれる場合は、リリースするものがない旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCounted(project(WITH_BRANCHES), {}, alertRules(), 0)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: no difference between origin/release and origin/develop: there is nothing to release\n')
  })

  it('打つと、release から develop までのコミットを compare API で数え、git fetch を打たない', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-38')
    await explains('`release_check` のコミット数の取得のテストです。実行した場合は、release から develop までのコミット数を compare API で取得し、`git fetch` は実行しないことを確認します。')
    const created = project(WITH_BRANCHES)
    const result = await runCounted(created, {}, alertRules(), 3)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('count: commits to release (origin/develop -> origin/release): 3\n')
    expect(pathsOf(result)).toContain('GET /repos/acme/demo/compare/release...develop')
    expect(result.stderr).not.toContain('fetch')
  })

  it('もしコミットの数を GitHub から数えられないなら、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-39')
    await explains('`release_check` のコミット数の取得に失敗した場合のテストです。GitHub からコミット数を取得できなかった場合は、`error` の行を出力して終了コード 1 で終わることを確認します。')
    const rules = [...alertRules(), rest('GET', '/repos/acme/demo/compare/release...develop', 404, NOT_FOUND)]
    const result = await runPreflight(project(WITH_BRANCHES), {}, rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not count the commits from release to develop: .+\n/u)
    expect(result.stdout).toBe('')
  })

  it('もし compare の通信が切れたなら、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-39')
    await explains('`release_check` のコミット数の取得に失敗した場合のテストです。compare の通信が切断された場合は、`error` の行を出力して終了コード 1 で終わり、スタックトレースは出力しないことを確認します。')
    const dropped: ResponseRule = { match: { method: 'GET', path: '/repos/acme/demo/compare/release...develop' }, respond: { status: 200, disconnect: true }, times: 1 }
    const result = await runPreflight(project(WITH_BRANCHES), {}, [...alertRules(), dropped])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not count the commits from release to develop: .+\n/u)
    expect(result.stderr).not.toContain('    at ')
  })

  it('もし CHANGELOG に渡した版の節が存在しないなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の CHANGELOG のテストです。指定した版の節が CHANGELOG に存在しない場合は、その版を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCounted(project(WITH_BRANCHES), { version: '9.9.9' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('9.9.9')
  })

  it('もし git コマンドが失敗したなら、終了コード 1 で終わる', async () => {
    await explains('`release_check` の git コマンドの失敗のテストです。git コマンドが失敗した場合は、失敗したコマンドを含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runPreflight(project({ remote: 'none' }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: git command failed: git ls-remote --tags origin refs/tags/v0.2.0')
  })

  describe('repo を省いて git の remote のリポジトリを読めない', () => {
    it('もし repo を省いて git の remote のリポジトリを読めないなら、error の行を標準エラーに出す', async () => {
      await explains('`release_check` の remote のリポジトリを取得できない場合のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、`error` の行を標準エラーへ出力することを確認します。')
      const result = await runPreflight(projectWithBrokenRemote(WITH_BRANCHES), {}, [])
      expect(result.stderr).toBe('error: could not read the repository from the git remote\n')
    })

    it('もし repo を省いて git の remote のリポジトリを読めないなら、終了コード 1 で終わる', async () => {
      await explains('`release_check` の remote のリポジトリを取得できない場合のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、終了コード 1 で終わることを確認します。')
      const result = await runPreflight(projectWithBrokenRemote(WITH_BRANCHES), {}, [])
      expect(result.code).toBe(1)
    })
  })

  describe('repo を省いて git の外で打った', () => {
    it('もし repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async () => {
      await explains('`release_check` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、`the repository is ambiguous` の行を標準エラーへ出力することを確認します。')
      const result = await runPreflight(project({ isGit: false }), {}, [])
      expect(result.stderr).toContain('error: the repository is ambiguous\n')
    })

    it('もし repo を省いて git の外で打ったなら、終了コード 1 で終わる', async () => {
      await explains('`release_check` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、終了コード 1 で終わることを確認します。')
      const result = await runPreflight(project({ isGit: false }), {}, [])
      expect(result.code).toBe(1)
    })
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-40')
      await explains('`release_check` の remote の URL を解釈できない場合のテストです。`repo` を指定した場合は、`warning` の行を出力し、結果の `warnings` に同じ文を含め、処理を続けることを確認します。')
      const cli = await runCounted(projectWithBareOrigin(WITH_BRANCHES), { repo: 'acme/demo' }, alertRules())
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      const result = await callTool(projectWithBareOrigin(WITH_BRANCHES), 'release_check', { repo: 'acme/demo' }, [...alertRules(), compareRule(1)])
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-41')
      await explains('`release_check` の remote の URL を解釈できない場合のテストです。`repo` を省略した場合は、`the repository is ambiguous` と理由の行を出力して終了コード 1 で終わることを確認します。')
      const cli = await runPreflight(projectWithBareOrigin(WITH_BRANCHES), {}, [])
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      const result = await callTool(projectWithBareOrigin(WITH_BRANCHES), 'release_check', {}, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    })
  })

  describe('MCP の data', () => {
    it('チェックが通ると、版・タグ・リリースノート・コミット数と、Dependabot alert の件数を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-05')
      await verifies(context, 'PW-RELEASE-CHECK-06')
      await verifies(context, 'PW-RELEASE-CHECK-09')
      await verifies(context, 'PW-RELEASE-CHECK-10')
      await explains('`release_check` の MCP の結果のテストです。チェックが通った場合は、版・タグ・リリースノート・コミット数と、Dependabot アラートの件数を返すことを確認します。')
      const rules = [...alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 200, DEPENDABOT_ALERTS)] }), compareRule(1)]
      const result = await callTool(project(WITH_BRANCHES), 'release_check', {}, rules)
      expect(result.structured).toEqual({
        version: '0.2.0',
        tag: 'v0.2.0',
        releaseNotes: NOTES_0_2_0,
        commitCount: 1,
        skipped: [],
        dependabotAlerts: { enabled: true, openCount: 2, maxSeverity: 'critical', alertsUrl: ALERTS_URL },
        warnings: [`2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n  #1 (minimatch, medium)\n  #2 (glob, critical)\n  → ${ALERTS_URL}`],
      })
    })

    it('機能が無効なら、飛ばした確認の名前を skipped に返す', async () => {
      await explains('`release_check` の MCP の結果のテストです。機能が無効な場合は、確認を飛ばした項目の名前を `skipped` に含めて返すことを確認します。')
      const rules = [...alertRules({
        dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 404)],
        code: [rest('GET', alertPath('code'), 403, { message: 'Advanced Security must be enabled for this repository to use code scanning.' })],
        secret: [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, { security_and_analysis: { secret_scanning: { status: 'disabled' } } })],
      }), compareRule(1)]
      const result = await callTool(project(WITH_BRANCHES), 'release_check', {}, rules)
      expect(result.structured).toEqual({
        version: '0.2.0',
        tag: 'v0.2.0',
        releaseNotes: NOTES_0_2_0,
        commitCount: 1,
        skipped: ['Dependabot alerts (feature disabled)', 'code scanning (feature disabled)', 'secret scanning (feature disabled)'],
        dependabotAlerts: { enabled: false, openCount: 0, alertsUrl: ALERTS_URL },
      })
    })

    it('alert が残って失敗しても、alert の結果を data に残す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-14')
      await explains('`release_check` の MCP の結果のテストです。アラートが残って失敗した場合でも、アラートの結果を data に含めることを確認します。')
      const rules = alertRules({ secret: [rest('GET', alertPath('secret'), 200, [{ number: 5 }])] })
      const result = await callTool(project(WITH_BRANCHES), 'release_check', {}, rules)
      expect(result.isError).toBe(true)
      const { detail, ...collected } = result.structured
      expect(collected).toEqual({ skipped: [], dependabotAlerts: { enabled: true, openCount: 0, alertsUrl: ALERTS_URL }, kind: 'preflight-failed' })
      expect(detail).toMatch(/^secret scanning has 1 open alert\n/u)
    })

    it('repo が今の git remote のリポジトリと食い違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-08')
      await explains('`release_check` の MCP の結果のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、`warnings` に 1 件含めることを確認します。')
      const rules = [...alertRules({}, 'acme/other'), compareRule(1, 'acme/other')]
      const result = await callTool(project({ ...WITH_BRANCHES, repositories: [DEFAULT_REPOSITORY, OTHER] }), 'release_check', { repo: 'acme/other' }, rules)
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual(['using repo acme/other (current Git remote: acme/demo)'])
    })

    it('Dependabot alert の状態を読めないと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-11')
      await explains('`release_check` の MCP の結果のテストです。Dependabot アラートの状態を取得できない場合は、`warnings` に 1 件含めることを確認します。')
      const rules = [...alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 204)] }), compareRule(1)]
      const result = await callTool(project(WITH_BRANCHES), 'release_check', {}, rules)
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^could not check Dependabot alerts\. The release is not blocked\.\n/u)])
    })

    const codeForbidden = [rest('GET', alertPath('code'), 403, FORBIDDEN)]
    const openCode = [rest('GET', alertPath('code'), 200, [{ number: 10, rule: { severity: 'error' } }])]
    const secretUnknown = [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, {})]
    const failedOnce = alertRules({ code: codeForbidden, secret: [rest('GET', alertPath('secret'), 200, [{ number: 5 }])] })
    it.for<CheckFailure>([
      { name: 'open の code scanning alert がある', options: WITH_BRANCHES, input: {}, rules: alertRules({ code: openCode }), kind: 'preflight-failed', detail: 'code scanning has 1 open alert', id: 'PW-RELEASE-CHECK-13' },
      { name: 'code scanning の状態を判定できない', options: WITH_BRANCHES, input: {}, rules: alertRules({ code: codeForbidden }), kind: 'preflight-failed', detail: 'could not check code scanning: acme/demo: ', id: 'PW-RELEASE-CHECK-15' },
      { name: 'secret scanning の状態を判定できない', options: WITH_BRANCHES, input: {}, rules: alertRules({ secret: secretUnknown }), kind: 'preflight-failed', detail: 'could not check secret scanning: acme/demo: ', id: 'PW-RELEASE-CHECK-15' },
      { name: 'alert の確認が 1 つ失敗した', options: WITH_BRANCHES, input: {}, rules: failedOnce, kind: 'preflight-failed', detail: 'could not check code scanning', id: 'PW-RELEASE-CHECK-17' },
      { name: 'git リポジトリのルートを見つけられない', options: { isGit: false }, input: { repo: 'acme/demo' }, rules: [], kind: 'git-unresolved', detail: 'could not find the root directory of the git repository', id: 'PW-RELEASE-CHECK-18' },
      { name: 'nx のリポジトリに version を渡した', options: { repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }, input: { version: '0.2.0' }, rules: [], kind: 'invalid-input', detail: 'cannot be used when release_type is nx', id: 'PW-RELEASE-CHECK-20' },
      { name: 'nx のリポジトリに package を渡した', options: { repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }, input: { package: 'pkg-a' }, rules: [], kind: 'invalid-input', detail: 'cannot be used when release_type is nx', id: 'PW-RELEASE-CHECK-20' },
      { name: 'packages を設定したリポジトリに package を渡さない', options: { repositories: [PACKAGES], files: PACKAGE_FILES }, input: {}, rules: [], kind: 'invalid-input', detail: 'acme/demo is a monorepo', id: 'PW-RELEASE-CHECK-21' },
      { name: 'package が設定に登録していないパッケージ名', options: { repositories: [PACKAGES], files: PACKAGE_FILES }, input: { package: 'unknown' }, rules: [], kind: 'invalid-input', detail: 'package \'unknown\' is not registered in acme/demo', id: 'PW-RELEASE-CHECK-22' },
      { name: 'packages を設定していないリポジトリに package を渡した', options: {}, input: { package: 'pkg-a' }, rules: [], kind: 'invalid-input', detail: 'acme/demo has no packages configured', id: 'PW-RELEASE-CHECK-23' },
      { name: 'develop_branch を設定していない', options: { repositories: [{ owner: 'acme', name: 'demo', release_branch: 'release' }] }, input: {}, rules: alertRules(), kind: 'repo-setting-missing', detail: 'set it with: project_link with repo: "acme/demo", develop_branch: <branch>', id: 'PW-RELEASE-CHECK-24' },
      { name: 'release_branch を設定していない', options: { repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] }, input: {}, rules: alertRules(), kind: 'repo-setting-missing', detail: 'set it with: project_link with repo: "acme/demo", release_branch: <branch>', id: 'PW-RELEASE-CHECK-25' },
      { name: 'CHANGELOG が存在しない', options: { ...WITH_BRANCHES, files: { 'CHANGELOG.md': undefined } }, input: {}, rules: alertRules(), kind: 'preflight-failed', detail: 'CHANGELOG.md', id: 'PW-RELEASE-CHECK-26' },
      { name: 'version を省いて CHANGELOG に版が 1 つも存在しない', options: { ...WITH_BRANCHES, files: NO_PACKAGE_FILES }, input: {}, rules: alertRules(), kind: 'preflight-failed', detail: 'CHANGELOG', id: 'PW-RELEASE-CHECK-27' },
      { name: '渡した version が X.Y.Z の形でない', options: WITH_BRANCHES, input: { version: '1.2' }, rules: [], kind: 'invalid-input', detail: 'invalid version format: 1.2', id: 'PW-RELEASE-CHECK-28' },
      { name: '渡した version が空文字', options: WITH_BRANCHES, input: { version: '' }, rules: [], kind: 'invalid-input', detail: 'invalid version format: ', id: 'PW-RELEASE-CHECK-28' },
      { name: 'タグがローカルに既にある', options: { ...WITH_BRANCHES, localTags: ['v0.2.0'] }, input: {}, rules: alertRules(), kind: 'preflight-failed', detail: 'tag already exists locally: v0.2.0', id: 'PW-RELEASE-CHECK-29' },
      { name: 'タグが remote に既にある', options: { ...WITH_BRANCHES, remoteTags: ['v0.2.0'] }, input: {}, rules: alertRules(), kind: 'preflight-failed', detail: 'tag already exists on the remote: v0.2.0', id: 'PW-RELEASE-CHECK-30' },
      { name: 'develop_branch のコミットがすべて release_branch にある', options: WITH_BRANCHES, input: {}, rules: [...alertRules(), compareRule(0)], kind: 'preflight-failed', detail: 'there is nothing to release', id: 'PW-RELEASE-CHECK-31' },
      { name: 'CHANGELOG に渡した版の節が存在しない', options: WITH_BRANCHES, input: { version: '9.9.9' }, rules: [...alertRules(), compareRule(1)], kind: 'preflight-failed', detail: '9.9.9', id: 'PW-RELEASE-CHECK-32' },
      { name: 'git コマンドが失敗した', options: { remote: 'none' }, input: {}, rules: alertRules(), kind: 'preflight-failed', detail: 'git command failed: git ls-remote --tags origin refs/tags/v0.2.0', id: 'PW-RELEASE-CHECK-33' },
      { name: 'git の外で repo を省いた', options: { isGit: false }, input: {}, rules: [], kind: 'git-unresolved', detail: 'the repository is ambiguous', id: 'PW-RELEASE-CHECK-37' },
      { name: '対象のリポを含む設定が存在しない', options: { isActive: false }, input: {}, rules: [], kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config', id: 'PW-RELEASE-CHECK-42' },
    ])('$name と、kind が $kind の失敗を返す', async ({ name, options, input, rules, kind, detail, id }, context) => {
      await verifies(context, id)
      await explains(`\`release_check\` の MCP の失敗のテストです。条件が「${name}」の場合に、\`kind\` が \`${kind}\` の失敗を返し、\`detail\` に \`${detail}\` が含まれることを確認します。`)
      const result = await callTool(project(options), 'release_check', input, rules)
      expect(result).toMatchObject({ isError: true, structured: { kind } })
      expect(result.structured['detail']).toContain(detail)
    })

    it('リポを含む設定が 2 つ以上あってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-19')
      await explains('`release_check` の MCP の失敗のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補を `detail` に含め、`no-active-project` で失敗することを確認します。')
      const result = await callTool(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), 'release_check', {}, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(result.structured['detail']).toContain('choose one with project: <NAME>')
      expect(result.structured['detail']).toContain('available: ')
    })

    it('repo を省いて git の remote のリポジトリを読めないと、読めない理由を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-34')
      await verifies(context, 'PW-RELEASE-CHECK-35')
      await explains('`release_check` の MCP の失敗のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、`kind` が `git-unresolved` の失敗を返し、`detail` に理由を含めることを確認します。')
      const result = await callTool(projectWithBrokenRemote(WITH_BRANCHES), 'release_check', {}, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved', detail: 'could not read the repository from the git remote' } })
    })

    it('repo を省いて git の外で呼ぶと、the repository is ambiguous で始まる detail を入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-36')
      await explains('`release_check` の MCP の失敗のテストです。`repo` を省略して git の外で呼び出した場合は、`detail` が `the repository is ambiguous` で始まることを確認します。')
      const result = await callTool(project({ isGit: false }), 'release_check', {}, [])
      expect(result.structured['detail']).toMatch(/^the repository is ambiguous\n/u)
    })

    it('コミットの数を数えられないと、could not count the commits で始まる detail を入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-39')
      await explains('`release_check` の MCP の失敗のテストです。コミット数を取得できない場合は、`detail` が `could not count the commits` で始まる失敗を返すことを確認します。')
      const rules = [...alertRules(), rest('GET', '/repos/acme/demo/compare/release...develop', 404, NOT_FOUND)]
      const result = await callTool(project(WITH_BRANCHES), 'release_check', {}, rules)
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not count the commits from release to develop: /u)
    })
  })
})

describe('release_create', () => {
  const notes = { body: NOTES_0_2_0 }

  it('版を渡して打つと、CHANGELOG のその版の節をリリースノートにして GitHub のリリースを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-01')
    await explains('`release_create` のリリース作成のテストです。版を指定した場合は、CHANGELOG のその版の節をリリースノートにして、GitHub のリリースを作成することを確認します。')
    const result = await runCreate(project(), { version: '0.2.0' }, [releaseCreated()])
    expect(result.code).toBe(0)
    expect(result.requests).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/releases', body: { tag_name: 'v0.2.0', name: 'v0.2.0', ...notes } }])
  })

  it('リリースを作ると、release_branch の先頭にタグを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-02')
    await explains('`release_create` のタグの作成先のテストです。リリースを作成した場合は、`release_branch` の先頭にタグを作成することを確認します。')
    const result = await runCreate(project(), { version: '0.2.0' }, [releaseCreated()])
    expect(result.requests).toMatchObject([{ body: { target_commitish: 'release' } }])
  })

  it('package を付けて打つと、パッケージ名を接頭辞にしたタグと名前でリリースを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-03')
    await explains('`release_create` の `package` のテストです。`package` を指定した場合は、パッケージ名を接頭辞にしたタグと名前でリリースを作成することを確認します。')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), { version: '0.2.0', package: 'pkg-a' }, [releaseCreated('pkg-a-v0.2.0', 'pkg-a v0.2.0')])
    expect(result.code).toBe(0)
    expect(result.requests).toMatchObject([{ body: { tag_name: 'pkg-a-v0.2.0', name: 'pkg-a v0.2.0' } }])
  })

  it('repo が今の git remote のリポジトリと食い違うと、warning の行を標準エラーに出す', async () => {
    await explains('`release_create` の `repo` のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、`warning` の行を標準エラーへ出力することを確認します。')
    const result = await runCreate(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), { version: '0.2.0', repo: 'acme/other' }, [releaseCreated('v0.2.0', 'v0.2.0', 'acme/other')])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: using repo acme/other (current Git remote: acme/demo)\n')
  })

  it('リリースを作ると、リリースの URL を標準出力に出す', async () => {
    await explains('`release_create` の成功時の出力のテストです。リリースを作成した場合は、リリースの URL を標準出力へ出力することを確認します。')
    const result = await runCreate(project(), { version: '0.2.0' }, [releaseCreated()])
    expect(result.stdout).toBe('https://ghes.example.com/acme/demo/releases/tag/v0.2.0\n')
  })

  it('リリースを作ると、created の行を標準エラーに出す', async () => {
    await explains('`release_create` の成功時の出力のテストです。リリースを作成した場合は、`created` の行を標準エラーへ出力することを確認します。')
    const result = await runCreate(project(), { version: '0.2.0' }, [releaseCreated()])
    expect(result.stderr).toBe('created: release v0.2.0 on release\n')
  })

  it('もし版が X.Y.Z の形でないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の版の形式のテストです。版が `X.Y.Z` の形式でない場合は、その値を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project(), { version: '1.2' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('1.2')
  })

  it('もし git リポジトリのルートを見つけられないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の git リポジトリの検出のテストです。git リポジトリのルートが見つからない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ isGit: false }), { version: '0.2.0', repo: 'acme/demo' }, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not find the root directory of the git repository\n')
  })

  it('もし対象のリポを含む設定が 2 つ以上あり、アクティブなプロジェクトがそのどれも指さないなら、候補の名前と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`release_create` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is in 2 project configs\n')
    expect(result.stderr).toContain('choose one with project: <NAME>')
    expect(result.stderr).toContain('available: ')
  })

  it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-30')
    await explains('`release_create` の `project` のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、`project` で指定した設定を使ってリリースを作成することを確認します。')
    const result = await runCreate(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), { version: '0.2.0', project: 'second' }, [releaseCreated()])
    expect(result.code).toBe(0)
    expect(result.requests).toHaveLength(1)
  })

  it('もし対象のリポを含む設定が存在しないなら、repo-not-in-project の行を出して終了コード 1 で終わる', async () => {
    await explains('`release_create` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ isActive: false }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is not in any project config\n')
  })

  it('もし packages を設定したリポジトリに package を渡さなかったなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` のモノレポの `package` のテストです。`packages` を設定したリポジトリで `package` を省略した場合は、モノレポである旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo is a monorepo')
  })

  it('もし package が設定に登録していないパッケージ名なら、終了コード 1 で終わる', async () => {
    await explains('`release_create` のモノレポの `package` のテストです。設定に登録していないパッケージ名を指定した場合は、登録されていない旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), { version: '0.2.0', package: 'unknown' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('package \'unknown\' is not registered in acme/demo')
  })

  it('もし packages を設定していないリポジトリに package を渡したなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の `package` のテストです。`packages` を設定していないリポジトリに `package` を指定した場合は、パッケージが未設定である旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project(), { version: '0.2.0', package: 'pkg-a' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo has no packages configured\n  package can only be used in a monorepo\n')
  })

  it('もし CHANGELOG が存在しないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の CHANGELOG のテストです。CHANGELOG が存在しない場合は、ファイルが見つからない旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ files: { 'CHANGELOG.md': undefined } }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: CHANGELOG.md not found: /u)
  })

  it('もし CHANGELOG に渡した版の節が存在しないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の CHANGELOG のテストです。指定した版の節が CHANGELOG に存在しない場合は、その版を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project(), { version: '9.9.9' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('9.9.9')
  })

  it('もし release_branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async () => {
    await explains('`release_create` のブランチ設定のテストです。`release_branch` が未設定の場合は、設定コマンドを案内する `error` の行を標準エラーへ出力することを確認します。')
    const result = await runCreate(project(WITHOUT_RELEASE_BRANCH), { version: '0.2.0' })
    expect(result.stderr).toContain('error: release_branch is not set for acme/demo\n')
    expect(result.stderr).toContain('project_link with repo: "acme/demo", release_branch: <branch>')
  })

  it('もし release_branch を設定していないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` のブランチ設定のテストです。`release_branch` が未設定の場合は、GitHub へ要求を送信せず、終了コード 1 で終わることを確認します。')
    const result = await runCreate(project(WITHOUT_RELEASE_BRANCH), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
  })

  it('もしリリースの作成で GitHub API がエラーを返したなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の GitHub API のエラーのテストです。リリースの作成で GitHub API がエラーを返した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runCreate(project(), { version: '0.2.0' }, [rest('POST', '/repos/acme/demo/releases', 422, { message: 'Validation Failed' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not create release v0.2.0 in acme/demo: GitHub API error: 422 Validation Failed\n')
  })

  describe('repo を省いて git の remote のリポジトリを読めない', () => {
    it('もし repo を省いて git の remote のリポジトリを読めないなら、error の行を標準エラーに出す', async () => {
      await explains('`release_create` の remote のリポジトリを取得できない場合のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、`error` の行を標準エラーへ出力することを確認します。')
      const result = await runCreate(projectWithBrokenRemote(), { version: '0.2.0' })
      expect(result.stderr).toBe('error: could not read the repository from the git remote\n')
    })

    it('もし repo を省いて git の remote のリポジトリを読めないなら、終了コード 1 で終わる', async () => {
      await explains('`release_create` の remote のリポジトリを取得できない場合のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、終了コード 1 で終わることを確認します。')
      const result = await runCreate(projectWithBrokenRemote(), { version: '0.2.0' })
      expect(result.code).toBe(1)
    })
  })

  it('もし repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async () => {
    await explains('`release_create` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、`the repository is ambiguous` の行を標準エラーへ出力することを確認します。')
    const result = await runCreate(project({ isGit: false }), { version: '0.2.0' })
    expect(result.stderr).toContain('error: the repository is ambiguous\n')
  })

  it('もし repo を省いて git の外で打ったなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ isGit: false }), { version: '0.2.0' })
    expect(result.code).toBe(1)
  })

  it('もし GitHub のトークンが見つからないなら、error の行を標準エラーに出し、終了コード 1 で終わる', async () => {
    await explains('`release_create` の認証エラーのテストです。GitHub のトークンが見つからない場合は、`error` の行を標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ hasToken: false }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: authentication error: could not get a GitHub API token/u)
  })

  it('もし GitHub のトークンが見つからないなら、終了コード 1 で終わる', async () => {
    await explains('`release_create` の認証エラーのテストです。GitHub のトークンが見つからない場合は、GitHub へ要求を送信せず、終了コード 1 で終わることを確認します。')
    const result = await runCreate(project({ hasToken: false }), { version: '0.2.0' })
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-27')
      await explains('`release_create` の remote の URL を解釈できない場合のテストです。`repo` を指定した場合は、`warning` の行を出力し、結果の `warnings` に同じ文を含め、処理を続けることを確認します。')
      const cli = await runCreate(projectWithBareOrigin(), { version: '0.2.0', repo: 'acme/demo' }, [releaseCreated()])
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      const result = await callTool(projectWithBareOrigin(), 'release_create', { version: '0.2.0', repo: 'acme/demo' }, [releaseCreated()])
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-28')
      await explains('`release_create` の remote の URL を解釈できない場合のテストです。`repo` を省略した場合は、`the repository is ambiguous` と理由の行を出力して終了コード 1 で終わることを確認します。')
      const cli = await runCreate(projectWithBareOrigin(), { version: '0.2.0' })
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      expect(cli.requests).toEqual([])
      const result = await callTool(projectWithBareOrigin(), 'release_create', { version: '0.2.0' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    })
  })

  describe('MCP の data', () => {
    it('リリースを作ると、タグ・URL・リリースノートを返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-08')
      await verifies(context, 'PW-RELEASE-CREATE-09')
      await explains('`release_create` の MCP の結果のテストです。リリースを作成した場合は、タグ・URL・リリースノートを返すことを確認します。')
      const result = await callTool(project(), 'release_create', { version: '0.2.0' }, [releaseCreated()])
      expect(result.structured).toEqual({ tag: 'v0.2.0', url: 'https://ghes.example.com/acme/demo/releases/tag/v0.2.0', releaseNotes: NOTES_0_2_0 })
    })

    it('repo が今の git remote のリポジトリと食い違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-07')
      await explains('`release_create` の MCP の結果のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、`warnings` に 1 件含めることを確認します。')
      const result = await callTool(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), 'release_create', { version: '0.2.0', repo: 'acme/other' }, [releaseCreated('v0.2.0', 'v0.2.0', 'acme/other')])
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual(['using repo acme/other (current Git remote: acme/demo)'])
    })

    it.for([
      { name: '版が X.Y.Z の形でない', options: {}, input: { version: '1.2' }, kind: 'invalid-input', detail: 'invalid version format: 1.2', id: 'PW-RELEASE-CREATE-10' },
      { name: 'git リポジトリのルートを見つけられない', options: { isGit: false }, input: { repo: 'acme/demo' }, kind: 'git-unresolved', detail: 'could not find the root directory of the git repository', id: 'PW-RELEASE-CREATE-11' },
      { name: 'packages を設定したリポジトリに package を渡さない', options: { repositories: [PACKAGES], files: PACKAGE_FILES }, input: {}, kind: 'invalid-input', detail: 'acme/demo is a monorepo', id: 'PW-RELEASE-CREATE-13' },
      { name: 'package が設定に登録していないパッケージ名', options: { repositories: [PACKAGES], files: PACKAGE_FILES }, input: { package: 'unknown' }, kind: 'invalid-input', detail: 'package \'unknown\' is not registered in acme/demo', id: 'PW-RELEASE-CREATE-14' },
      { name: 'packages を設定していないリポジトリに package を渡す', options: {}, input: { package: 'pkg-a' }, kind: 'invalid-input', detail: 'acme/demo has no packages configured', id: 'PW-RELEASE-CREATE-15' },
      { name: 'CHANGELOG が存在しない', options: { files: { 'CHANGELOG.md': undefined } }, input: {}, kind: 'preflight-failed', detail: 'CHANGELOG.md not found: ', id: 'PW-RELEASE-CREATE-16' },
      { name: 'CHANGELOG に渡した版の節が存在しない', options: {}, input: { version: '9.9.9' }, kind: 'preflight-failed', detail: '9.9.9', id: 'PW-RELEASE-CREATE-17' },
      { name: 'release_branch を設定していない', options: WITHOUT_RELEASE_BRANCH, input: {}, kind: 'repo-setting-missing', detail: 'release_branch is not set for acme/demo', id: 'PW-RELEASE-CREATE-19' },
      { name: 'git の外で repo を省く', options: { isGit: false }, input: {}, kind: 'git-unresolved', detail: 'the repository is ambiguous', id: 'PW-RELEASE-CREATE-24' },
      { name: 'GitHub のトークンが見つからない', options: { hasToken: false }, input: {}, kind: 'github-auth', detail: 'could not get a GitHub API token', id: 'PW-RELEASE-CREATE-26' },
      { name: '対象のリポを含む設定が存在しない', options: { isActive: false }, input: {}, kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config', id: 'PW-RELEASE-CREATE-29' },
    ])('$name と、kind が $kind の失敗を返す', async ({ name, options, input, kind, detail, id }, context) => {
      await verifies(context, id)
      await explains(`\`release_create\` の MCP の失敗のテストです。条件が「${name}」の場合に、\`kind\` が \`${kind}\` の失敗を返し、\`detail\` に \`${detail}\` が含まれることを確認します。`)
      const result = await callTool(project(options), 'release_create', { version: '0.2.0', ...input }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind } })
      expect(result.structured['detail']).toContain(detail)
    })

    it('リポを含む設定が 2 つ以上あってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-12')
      await explains('`release_create` の MCP の失敗のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補を `detail` に含め、`no-active-project` で失敗することを確認します。')
      const result = await callTool(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), 'release_create', { version: '0.2.0' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(result.structured['detail']).toContain('acme/demo is in 2 project configs')
      expect(result.structured['detail']).toContain('available: ')
      expect(result.structured['detail']).toContain('choose one with project: <NAME>')
    })

    it('release_branch を設定していないと、設定の仕方を案内する文を detail に入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-18')
      await explains('`release_create` の MCP の失敗のテストです。`release_branch` が未設定の場合は、設定の方法を案内する文を `detail` に含めることを確認します。')
      const result = await callTool(project(WITHOUT_RELEASE_BRANCH), 'release_create', { version: '0.2.0' }, [])
      expect(result.structured['detail']).toContain('set it with: project_link with repo: "acme/demo", release_branch: <branch>')
    })

    it('リリースの作成で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-20')
      await explains('`release_create` の MCP の失敗のテストです。リリースの作成で GitHub API がエラーを返した場合は、その内容を `detail` に含む失敗を返すことを確認します。')
      const result = await callTool(project(), 'release_create', { version: '0.2.0' }, [rest('POST', '/repos/acme/demo/releases', 422, { message: 'Validation Failed' })])
      expect(result).toMatchObject({ isError: true, structured: { detail: 'could not create release v0.2.0 in acme/demo: GitHub API error: 422 Validation Failed' } })
    })

    it('repo を省いて git の remote のリポジトリを読めないと、読めない理由を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-21')
      await verifies(context, 'PW-RELEASE-CREATE-22')
      await explains('`release_create` の MCP の失敗のテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合は、`kind` が `git-unresolved` の失敗を返し、`detail` に理由を含めることを確認します。')
      const result = await callTool(projectWithBrokenRemote(), 'release_create', { version: '0.2.0' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved', detail: 'could not read the repository from the git remote' } })
    })

    it('repo を省いて git の外で呼ぶと、the repository is ambiguous で始まる detail を入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-23')
      await explains('`release_create` の MCP の失敗のテストです。`repo` を省略して git の外で呼び出した場合は、`detail` が `the repository is ambiguous` で始まることを確認します。')
      const result = await callTool(project({ isGit: false }), 'release_create', { version: '0.2.0' }, [])
      expect(result.structured['detail']).toMatch(/^the repository is ambiguous\n/u)
    })

    it('GitHub のトークンが見つからないと、トークンが見つからないことを detail に入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-25')
      await explains('`release_create` の MCP の失敗のテストです。GitHub のトークンが見つからない場合は、トークンが見つからない旨を `detail` に含めることを確認します。')
      const result = await callTool(project({ hasToken: false }), 'release_create', { version: '0.2.0' }, [])
      expect(result.structured['detail']).toMatch(/^authentication error: could not get a GitHub API token/u)
    })
  })
})

describe('release_merge', () => {
  const merged = rest('PUT', '/repos/acme/demo/pulls/31/merge', 200, { sha: 'abcdef0', merged: true, message: 'Pull Request successfully merged' })
  const deleted = rest('DELETE', '/repos/acme/demo/git/refs/heads/develop', 204)

  it('PR の参照を渡して打つと、その PR を通常のマージ（マージコミット）でマージする', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-01')
    await explains('`release_merge` のマージ方法のテストです。PR の参照を指定した場合は、その PR を通常のマージ（マージコミット）でマージすることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse(), merged])
    expect(result.code).toBe(0)
    expect(result.requests.at(-1)).toMatchObject({ type: 'rest', method: 'PUT', path: '/repos/acme/demo/pulls/31/merge', body: { merge_method: 'merge' } })
  })

  it('delete_branch を付けて打つと、マージの後に PR の head ブランチをリモートから削除する', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-02')
    await explains('`release_merge` の `delete_branch` のテストです。`delete_branch` を指定した場合は、マージの後に PR の head ブランチをリモートから削除することを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31', delete_branch: true }, [pullRequestResponse(), merged, deleted])
    expect(pathsOf(result).slice(-2)).toEqual(['PUT /repos/acme/demo/pulls/31/merge', 'DELETE /repos/acme/demo/git/refs/heads/develop'])
  })

  it('admin を付けて打つと、衝突のある PR でもマージを試みる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-03')
    await explains('`release_merge` の `admin` のテストです。`admin` を指定した場合は、衝突のある PR でもマージを試みることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31', admin: true }, [pullRequestResponse({ mergeable: 'CONFLICTING' }), merged])
    expect(result.code).toBe(0)
    expect(pathsOf(result)).toContain('PUT /repos/acme/demo/pulls/31/merge')
  })

  it('PR をマージすると、merged の行を標準エラーに出す', async () => {
    await explains('`release_merge` の成功時の出力のテストです。PR をマージした場合は、`merged` の行を標準エラーへ出力することを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse(), merged])
    expect(result.stderr).toBe('merged: PR acme/demo/31 (develop -> release, merge commit)\n')
  })

  it('head ブランチを削除すると、deleted の行を標準エラーに出す', async () => {
    await explains('`release_merge` の成功時の出力のテストです。head ブランチを削除した場合は、`deleted` の行を標準エラーへ出力することを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31', delete_branch: true }, [pullRequestResponse(), merged, deleted])
    expect(result.stderr).toContain('deleted: remote branch develop in acme/demo\n')
  })

  describe('head ブランチを削除できない', () => {
    const failing = [pullRequestResponse(), merged, rest('DELETE', '/repos/acme/demo/git/refs/heads/develop', 422, { message: 'Reference does not exist' })]

    it('もし head ブランチを削除できなかったなら、warning の行を標準エラーに出す', async () => {
      await explains('`release_merge` の head ブランチの削除に失敗した場合のテストです。削除できなかった場合は、`warning` の行を標準エラーへ出力することを確認します。')
      const result = await runMerge(project(), { pr_ref: 'acme/demo/31', delete_branch: true }, failing)
      expect(result.stderr).toContain('warning: deleting remote branch develop failed: ')
    })

    it('もし head ブランチを削除できなかったなら、終了コード 0 で終わる', async () => {
      await explains('`release_merge` の head ブランチの削除に失敗した場合のテストです。削除できなかった場合でも、終了コード 0 で終わることを確認します。')
      const result = await runMerge(project(), { pr_ref: 'acme/demo/31', delete_branch: true }, failing)
      expect(result.code).toBe(0)
    })
  })

  describe('repo が今の git remote のリポジトリと食い違う', () => {
    it('もし repo が今の git remote のリポジトリと食い違うなら、error の行を標準エラーに出す', async () => {
      await explains('`release_merge` の `repo` のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、`error` の行を標準エラーへ出力することを確認します。')
      const result = await runMergeMismatch()
      expect(result.stderr).toContain('error: repo acme/other differs from the current Git remote (acme/demo)\n')
    })

    it('もし repo が今の git remote のリポジトリと食い違うなら、終了コード 1 で終わる', async () => {
      await explains('`release_merge` の `repo` のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、終了コード 1 で終わり、GitHub へ要求を送信しないことを確認します。')
      const result = await runMergeMismatch()
      expect(result.code).toBe(1)
      expect(result.requests).toEqual([])
    })
  })

  it('もし対象のリポを含む設定が 2 つ以上あり、アクティブなプロジェクトがそのどれも指さないなら、候補の名前と project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`release_merge` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is in 2 project configs\n')
    expect(result.stderr).toContain('choose one with project: <NAME>')
    expect(result.stderr).toContain('available: ')
  })

  it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-29')
    await explains('`release_merge` の `project` のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、`project` で指定した設定を使って PR をマージすることを確認します。')
    const result = await runMerge(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), { pr_ref: 'acme/demo/31', project: 'second' }, [pullRequestResponse(), merged])
    expect(result.code).toBe(0)
  })

  it('もし対象のリポを含む設定が存在しないなら、repo-not-in-project の行を出して終了コード 1 で終わる', async () => {
    await explains('`release_merge` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project({ isActive: false }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: acme/demo is not in any project config\n')
  })

  it('もし PR の参照が owner/repo/N の形でないなら、終了コード 2 で終わる', async () => {
    await explains('`release_merge` の PR の参照の形式のテストです。参照が `owner/repo/N` の形式でない場合は、完全な形式を案内して終了コード 2 で終わることを確認します。')
    const result = await runMerge(project(), { pr_ref: '31' })
    expect(result.code).toBe(USAGE_ERROR)
    expect(result.stderr).toContain('use the full form \'owner/repo/N\'')
  })

  it('もし PR が見つからないなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の PR の取得のテストです。PR が見つからない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const rule: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 200, text: '{"data":{"repository":{"pullRequest":null}}}' }, times: 1 }
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [rule])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR acme/demo/31 not found\n')
  })

  it('もし PR の取得で GitHub API がエラーを返したなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の PR の取得のテストです。PR の取得で GitHub API がエラーを返した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const rule: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 422, body: { message: 'Validation Failed' } }, times: 1 }
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [rule])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: could not read PR acme/demo/31: ')
  })

  it('もし PR が既にマージ済みなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の PR の状態のテストです。PR が既にマージ済みの場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse({ state: 'MERGED' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR #31 is already merged\n')
  })

  it('もし PR が閉じているなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の PR の状態のテストです。PR が閉じている場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse({ state: 'CLOSED' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR #31 is closed\n')
  })

  it('もし PR に衝突があって admin を付けていないなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の衝突のテストです。PR に衝突があり、`admin` を指定していない場合は、`admin` を案内して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse({ mergeable: 'CONFLICTING' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: PR #31 has conflicts that must be resolved\n')
    expect(result.stderr).toContain('to try a forced merge, add admin: true')
  })

  it('もし release_branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async () => {
    await explains('`release_merge` のブランチ設定のテストです。`release_branch` が未設定の場合は、設定コマンドを案内する `error` の行を標準エラーへ出力することを確認します。')
    const result = await runMerge(project(WITHOUT_RELEASE_BRANCH), { pr_ref: 'acme/demo/31' }, [pullRequestResponse()])
    expect(result.stderr).toContain('error: release_branch is not set for acme/demo\n')
    expect(result.stderr).toContain('project_link with repo: "acme/demo", release_branch: <branch>')
  })

  it('もし release_branch を設定していないなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` のブランチ設定のテストです。`release_branch` が未設定の場合は、終了コード 1 で終わることを確認します。')
    const result = await runMerge(project(WITHOUT_RELEASE_BRANCH), { pr_ref: 'acme/demo/31' }, [pullRequestResponse()])
    expect(result.code).toBe(1)
  })

  it('もし PR の base ブランチが release_branch でないなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の base ブランチのテストです。PR の base ブランチが `release_branch` と異なる場合は、エラーを出力して終了コード 1 で終わり、マージを実行しないことを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse({ base: 'main' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the base branch of PR #31 does not match release_branch')
    expect(pathsOf(result)).not.toContain('PUT /repos/acme/demo/pulls/31/merge')
  })

  it('もしマージで GitHub API がエラーを返したなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の GitHub API のエラーのテストです。マージで GitHub API がエラーを返した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await runMerge(project(), { pr_ref: 'acme/demo/31' }, [pullRequestResponse(), rest('PUT', '/repos/acme/demo/pulls/31/merge', 405, { message: 'Pull Request is not mergeable' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not merge PR acme/demo/31: GitHub API error: 405 Pull Request is not mergeable\n')
  })

  it('もし repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async () => {
    await explains('`release_merge` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、`the repository is ambiguous` の行を標準エラーへ出力することを確認します。')
    const result = await runMerge(project({ isGit: false }))
    expect(result.stderr).toContain('error: the repository is ambiguous\n')
  })

  it('もし repo を省いて git の外で打ったなら、終了コード 1 で終わる', async () => {
    await explains('`release_merge` の git の外での実行のテストです。`repo` を省略して git の外で実行した場合は、終了コード 1 で終わることを確認します。')
    const result = await runMerge(project({ isGit: false }))
    expect(result.code).toBe(1)
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-26')
      await explains('`release_merge` の remote の URL を解釈できない場合のテストです。`repo` を指定した場合は、`warning` の行を出力し、結果の `warnings` に同じ文を含め、処理を続けることを確認します。')
      const cli = await runMerge(projectWithBareOrigin(), { pr_ref: 'acme/demo/31', repo: 'acme/demo' }, [pullRequestResponse(), merged])
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      const result = await callTool(projectWithBareOrigin(), 'release_merge', { pr_ref: 'acme/demo/31', repo: 'acme/demo' }, [pullRequestResponse(), merged])
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-27')
      await explains('`release_merge` の remote の URL を解釈できない場合のテストです。`repo` を省略した場合は、`the repository is ambiguous` と理由の行を出力して終了コード 1 で終わることを確認します。')
      const cli = await runMerge(projectWithBareOrigin())
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      const result = await callTool(projectWithBareOrigin(), 'release_merge', { pr_ref: 'acme/demo/31' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    })
  })

  describe('MCP の data', () => {
    it('マージして head ブランチを削除すると、PR・ブランチと deletedBranch を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-07')
      await verifies(context, 'PW-RELEASE-MERGE-08')
      await explains('`release_merge` の MCP の結果のテストです。マージして head ブランチを削除した場合は、PR・ブランチ・`deletedBranch` を返すことを確認します。')
      const result = await callTool(project(), 'release_merge', { pr_ref: 'acme/demo/31', delete_branch: true }, [pullRequestResponse(), merged, deleted])
      expect(result.structured).toEqual({ pullRequest: 'acme/demo/31', head: 'develop', base: 'release', deletedBranch: true })
    })

    it('repo が今の git remote のリポジトリと食い違うと、食い違いを detail に入れ、kind が repo-mismatch の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-11')
      await verifies(context, 'PW-RELEASE-MERGE-12')
      await explains('`release_merge` の MCP の失敗のテストです。`repo` が現在の git remote のリポジトリと異なる場合は、食い違いを `detail` に含め、`kind` が `repo-mismatch` の失敗を返すことを確認します。')
      const result = await callTool(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), 'release_merge', { pr_ref: 'acme/other/31', repo: 'acme/other' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(result.structured['detail']).toMatch(/^repo acme\/other differs from the current Git remote \(acme\/demo\)\n/u)
    })

    it('リポを含む設定が 2 つ以上あってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-13')
      await explains('`release_merge` の MCP の失敗のテストです。対象のリポジトリを含む設定が 2 つ以上あり、アクティブな設定がそのどれでもない場合は、候補を `detail` に含め、`no-active-project` で失敗することを確認します。')
      const result = await callTool(project({ extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }), 'release_merge', { pr_ref: 'acme/demo/31' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(result.structured['detail']).toContain('choose one with project: <NAME>')
      expect(result.structured['detail']).toContain('available: ')
    })

    const notFound: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 200, text: '{"data":{"repository":{"pullRequest":null}}}' }, times: 1 }
    const unreadable: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 422, body: { message: 'Validation Failed' } }, times: 1 }
    it.for([
      { name: 'PR が見つからない', options: {}, pr_ref: 'acme/demo/31', rules: [notFound], kind: 'github-not-found', detail: 'PR acme/demo/31 not found', id: 'PW-RELEASE-MERGE-15' },
      { name: 'PR が既にマージ済み', options: {}, pr_ref: 'acme/demo/31', rules: [pullRequestResponse({ state: 'MERGED' })], kind: 'pr-state', detail: 'PR #31 is already merged', id: 'PW-RELEASE-MERGE-17' },
      { name: 'PR が閉じている', options: {}, pr_ref: 'acme/demo/31', rules: [pullRequestResponse({ state: 'CLOSED' })], kind: 'pr-state', detail: 'PR #31 is closed', id: 'PW-RELEASE-MERGE-18' },
      { name: 'PR に衝突があって admin を付けない', options: {}, pr_ref: 'acme/demo/31', rules: [pullRequestResponse({ mergeable: 'CONFLICTING' })], kind: 'pr-state', detail: 'PR #31 has conflicts that must be resolved', id: 'PW-RELEASE-MERGE-19' },
      { name: 'release_branch を設定していない', options: WITHOUT_RELEASE_BRANCH, pr_ref: 'acme/demo/31', rules: [pullRequestResponse()], kind: 'repo-setting-missing', detail: 'release_branch is not set for acme/demo', id: 'PW-RELEASE-MERGE-21' },
      { name: 'PR の base ブランチが release_branch でない', options: {}, pr_ref: 'acme/demo/31', rules: [pullRequestResponse({ base: 'main' })], kind: 'pr-state', detail: 'the base branch of PR #31 does not match release_branch', id: 'PW-RELEASE-MERGE-22' },
      { name: 'git の外で repo を省く', options: { isGit: false }, pr_ref: 'acme/demo/31', rules: [], kind: 'git-unresolved', detail: 'the repository is ambiguous', id: 'PW-RELEASE-MERGE-25' },
      { name: '対象のリポを含む設定が存在しない', options: { isActive: false }, pr_ref: 'acme/demo/31', rules: [], kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config', id: 'PW-RELEASE-MERGE-28' },
    ])('$name と、kind が $kind の失敗を返す', async ({ name, options, pr_ref, rules, kind, detail, id }, context) => {
      await verifies(context, id)
      await explains(`\`release_merge\` の MCP の失敗のテストです。条件が「${name}」の場合に、\`kind\` が \`${kind}\` の失敗を返し、\`detail\` に \`${detail}\` が含まれることを確認します。`)
      const result = await callTool(project(options), 'release_merge', { pr_ref }, rules)
      expect(result).toMatchObject({ isError: true, structured: { kind } })
      expect(result.structured['detail']).toContain(detail)
    })

    it('pr_ref が owner/repo/N の形でないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-14')
      await explains('`release_merge` の MCP の失敗のテストです。`pr_ref` が `owner/repo/N` の形式でない場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await callTool(project(), 'release_merge', { pr_ref: '31' }, [])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.structured['detail']).toContain('owner/repo/N')
    })

    it('PR の取得で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-16')
      await explains('`release_merge` の MCP の失敗のテストです。PR の取得で GitHub API がエラーを返した場合は、その内容を `detail` に含む失敗を返すことを確認します。')
      const result = await callTool(project(), 'release_merge', { pr_ref: 'acme/demo/31' }, [unreadable])
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not read PR acme\/demo\/31: /u)
    })

    it('release_branch を設定していないと、設定の仕方を案内する文を detail に入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-20')
      await explains('`release_merge` の MCP の失敗のテストです。`release_branch` が未設定の場合は、設定の方法を案内する文を `detail` に含めることを確認します。')
      const result = await callTool(project(WITHOUT_RELEASE_BRANCH), 'release_merge', { pr_ref: 'acme/demo/31' }, [pullRequestResponse()])
      expect(result.structured['detail']).toContain('set it with: project_link with repo: "acme/demo", release_branch: <branch>')
    })

    it('マージで GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-23')
      await explains('`release_merge` の MCP の失敗のテストです。マージで GitHub API がエラーを返した場合は、失敗を返すことを確認します。')
      const rejected = rest('PUT', '/repos/acme/demo/pulls/31/merge', 405, { message: 'Pull Request is not mergeable' })
      const result = await callTool(project(), 'release_merge', { pr_ref: 'acme/demo/31' }, [pullRequestResponse(), rejected])
      expect(result.isError).toBe(true)
    })

    it('repo を省いて git の外で呼ぶと、the repository is ambiguous で始まる detail を入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-24')
      await explains('`release_merge` の MCP の失敗のテストです。`repo` を省略して git の外で呼び出した場合は、`detail` が `the repository is ambiguous` で始まることを確認します。')
      const result = await callTool(project({ isGit: false }), 'release_merge', { pr_ref: 'acme/demo/31' }, [])
      expect(result.structured['detail']).toMatch(/^the repository is ambiguous\n/u)
    })

    it('マージの後に head ブランチを削除できないと、マージした PR と warning を data に返し、deletedBranch を false にする', async (context) => {
      await verifies(context, 'PW-COMMON-19')
      await verifies(context, 'PW-RELEASE-MERGE-09')
      await verifies(context, 'PW-RELEASE-MERGE-10')
      await explains('`release_merge` の MCP の結果のテストです。マージの後に head ブランチを削除できなかった場合は、マージした PR と `warning` を data に含め、`deletedBranch` を `false` にすることを確認します。')
      const failing = rest('DELETE', '/repos/acme/demo/git/refs/heads/develop', 422, { message: 'Reference does not exist' })
      const result = await callTool(project(), 'release_merge', { pr_ref: 'acme/demo/31', delete_branch: true }, [pullRequestResponse(), merged, failing])
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({
        pullRequest: 'acme/demo/31',
        head: 'develop',
        base: 'release',
        deletedBranch: false,
        warnings: [expect.stringMatching(/^deleting remote branch develop failed: /u)],
      })
    })

    it('マージが失敗すると、data に reason と detail だけを入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-COMMON-18')
      await explains('`release_merge` の MCP の失敗のテストです。マージが失敗した場合は、data に `kind` と `detail` だけを含む失敗を返すことを確認します。')
      const rejected = rest('PUT', '/repos/acme/demo/pulls/31/merge', 405, { message: 'Pull Request is not mergeable' })
      const result = await callTool(project(), 'release_merge', { pr_ref: 'acme/demo/31' }, [pullRequestResponse(), rejected])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(result.structured).toEqual({ kind: 'github-api', detail: 'could not merge PR acme/demo/31: GitHub API error: 405 Pull Request is not mergeable' })
    })
  })
})
