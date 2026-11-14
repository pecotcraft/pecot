// release check・create・merge の振る舞い（PW-RELEASE-*）を、runCli をプロセス内で呼んで確かめる。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { verifies } from '../_helpers/verifies.js'
import { alertPath, alertRules, compareRule, createProject, DEFAULT_REPOSITORY, failRemoteLookupFrom, NOTES_0_2_0, pathsOf, pullRequestResponse, rest, runRelease } from '../_helpers/release-sandbox.js'
import type { Project, ProjectOptions } from '../_helpers/release-sandbox.js'
import type { ResponseRule } from '../fake-github/server.js'

useIsolatedEnvironment()

const WITH_BRANCHES: ProjectOptions = { remote: 'branches' }
const OTHER = { owner: 'acme', name: 'other', develop_branch: 'develop', release_branch: 'release' }
const PACKAGES = { ...DEFAULT_REPOSITORY, packages: [{ name: 'pkg-a', changelog: 'packages/a/CHANGELOG.md' }] }
const PACKAGE_FILES = { 'packages/a/CHANGELOG.md': `# Changelog\n\n## [0.2.0] - 2026-01-02\n\n${NOTES_0_2_0}\n` }
const NO_PACKAGE_FILES = { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n' }
const USAGE_ERROR = 2
const WITHOUT_RELEASE_BRANCH: ProjectOptions = { repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] }

function runPreflight(project: Readonly<Project>, arguments_: readonly string[] = [], rules: readonly ResponseRule[] = alertRules(), global: readonly string[] = []): ReturnType<typeof runRelease> {
  return runRelease(project, [...global, 'release', 'check', ...arguments_], rules)
}

function runCounted(project: Readonly<Project>, arguments_: readonly string[] = [], rules: readonly ResponseRule[] = alertRules(), global: readonly string[] = [], ahead = 1, repository = 'acme/demo'): ReturnType<typeof runRelease> {
  return runPreflight(project, arguments_, [...rules, compareRule(ahead, repository)], global)
}

function runCreate(project: Readonly<Project>, arguments_: readonly string[], rules: readonly ResponseRule[] = [], global: readonly string[] = []): ReturnType<typeof runRelease> {
  return runRelease(project, [...global, 'release', 'create', ...arguments_], rules)
}

function runMerge(project: Readonly<Project>, arguments_: readonly string[] = ['acme/demo/31'], rules: readonly ResponseRule[] = [], global: readonly string[] = []): ReturnType<typeof runRelease> {
  return runRelease(project, [...global, 'release', 'merge', ...arguments_], rules)
}

function project(options: Readonly<ProjectOptions> = {}): Project {
  return createProject(options)
}

function projectWithBrokenRemote(options: Readonly<ProjectOptions> = {}): Project {
  const created = project(options)
  failRemoteLookupFrom(created, 2)
  return created
}

function runMergeDryRun(): ReturnType<typeof runRelease> {
  return runMerge(project(), ['acme/demo/31', '--dry-run', '--delete-branch'], [pullRequestResponse()])
}

function runMergeMismatch(): ReturnType<typeof runRelease> {
  return runMerge(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), ['acme/other/31'], [], ['--repo', 'acme/other'])
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

describe('release check', () => {
  it('版を省いて打つと、CHANGELOG の最初の版を対象にチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-01')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('version: 0.2.0\ntag: v0.2.0\n')
  })

  it('版を渡して打つと、その版を対象にチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-02')
    const result = await runCounted(project(WITH_BRANCHES), ['0.1.0'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('version: 0.1.0\ntag: v0.1.0\n\n### 追加\n\n- 初回リリース\n')
  })

  it('--package を付けて打つと、パッケージ名を接頭辞にしたタグ名でチェックする', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-03')
    const result = await runCounted(project({ ...WITH_BRANCHES, repositories: [PACKAGES], files: PACKAGE_FILES }), ['--package', 'pkg-a'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('tag: pkg-a-v0.2.0\n')
  })

  it('打つと、Dependabot・code scanning・secret scanning の open の alert を調べる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-04')
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
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.stderr).toContain('count: open Dependabot alerts: 0\ncount: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n')
  })

  it('3 種の機能が無効だと、skipped の行を標準エラーに出し、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-05')
    const rules = alertRules({
      dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 404)],
      code: [rest('GET', alertPath('code'), 403, { message: 'Advanced Security must be enabled for this repository to use code scanning.' })],
      secret: [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, { security_and_analysis: { secret_scanning: { status: 'disabled' } } })],
    })
    const result = await runCounted(project(WITH_BRANCHES), [], rules)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('skipped: Dependabot alerts (feature disabled)\nskipped: code scanning (feature disabled)\nskipped: secret scanning (feature disabled)\n')
  })

  it('open の Dependabot alert があると、件数と最も重い severity を添えた warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-06')
    const rules = alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 200, DEPENDABOT_ALERTS)] })
    const result = await runCounted(project(WITH_BRANCHES), [], rules)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: 2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n')
    expect(result.stderr).toContain('#1 (minimatch, medium)')
    expect(result.stderr).toContain('#2 (glob, critical)')
    expect(result.stderr).toContain('https://ghes.example.com/acme/demo/security/dependabot')
  })

  it('release_type が nx のリポジトリに打つと、alert だけを調べる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-07')
    const result = await runPreflight(project({ repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(pathsOf(result)).toHaveLength(3)
    expect(result.stderr).toContain('count: open secret scanning alerts: 0\n')
    expect(result.stderr).not.toContain('commits to release')
  })

  it('--repo が今の git remote のリポジトリと食い違うと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-08')
    const result = await runCounted(project({ ...WITH_BRANCHES, repositories: [DEFAULT_REPOSITORY, OTHER] }), [], alertRules({}, 'acme/other'), ['--repo', 'acme/other'], 1, 'acme/other')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: using --repo acme/other (current Git remote: acme/demo)\n')
  })

  it('チェックが通ると、version・tag の行とリリースノートを標準出力に出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-09')
    const result = await runCounted(project(WITH_BRANCHES))
    expect(result.stdout).toBe(`version: 0.2.0\ntag: v0.2.0\n\n${NOTES_0_2_0}\n`)
  })

  it('チェックが通ると、release へ入るコミット数の count の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-10')
    const result = await runCounted(project(WITH_BRANCHES), [], alertRules(), [], 2)
    expect(result.stderr).toContain('count: commits to release (origin/develop -> origin/release): 2\n')
  })

  describe('Dependabot alert の状態を読めない', () => {
    const rules = alertRules({ dependabot: [rest('GET', alertPath('dependabot'), 403, FORBIDDEN), rest('GET', '/repos/acme/demo/vulnerability-alerts', 204)] })

    it('もし Dependabot alert の状態を読めないなら、warning の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-11')
      const result = await runCounted(project(WITH_BRANCHES), [], rules)
      expect(result.stderr).toContain('warning: could not check Dependabot alerts. The release is not blocked.\n')
      expect(result.stderr).toContain('reason: acme/demo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)')
    })

    it('もし Dependabot alert の状態を読めないなら、残りの確認を続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-12')
      const result = await runCounted(project(WITH_BRANCHES), [], rules)
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('count: open code scanning alerts: 0\ncount: open secret scanning alerts: 0\n')
      expect(result.stdout).toContain('version: 0.2.0')
    })
  })

  it('もし open の code scanning alert があるなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-13')
    const rules = alertRules({ code: [rest('GET', alertPath('code'), 200, [{ number: 10, rule: { severity: 'error' } }])] })
    const result = await runPreflight(project(WITH_BRANCHES), [], rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: code scanning has 1 open alert\n')
    expect(result.stdout).toBe('')
  })

  it('もし open の secret scanning alert があるなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-14')
    const rules = alertRules({ secret: [rest('GET', alertPath('secret'), 200, [{ number: 5 }])] })
    const result = await runPreflight(project(WITH_BRANCHES), [], rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: secret scanning has 1 open alert\n')
  })

  const undeterminable = [
    { kind: 'code scanning', rules: alertRules({ code: [rest('GET', alertPath('code'), 403, FORBIDDEN)] }) },
    { kind: 'secret scanning', rules: alertRules({ secret: [rest('GET', alertPath('secret'), 404, NOT_FOUND), rest('GET', '/repos/acme/demo', 200, {})] }) },
  ]

  it.for(undeterminable)('もし $kind の状態を判定できないなら、終了コード 1 で終わる', async ({ kind, rules }, context) => {
    await verifies(context, 'PW-RELEASE-CHECK-15')
    const result = await runPreflight(project(WITH_BRANCHES), [], rules)
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
      const result = await runPreflight(project(WITH_BRANCHES), [], rules)
      expect(pathsOf(result)).toContain(`GET ${alertPath('secret')}`)
      expect(result.stderr).toContain('error: could not check code scanning:')
      expect(result.stderr).toContain('error: secret scanning has 1 open alert')
    })

    it('もし alert の確認が 1 つ失敗したなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-17')
      const result = await runPreflight(project(WITH_BRANCHES), [], rules)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
    })
  })

  describe('alert の確認が例外で失敗した', () => {
    it('もしトークンが無いなら、code・secret scanning の確認ごとに could not check alerts の行を出し、残りも続けて、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-16')
      await verifies(context, 'PW-RELEASE-CHECK-17')
      const result = await runPreflight(project({ ...WITH_BRANCHES, hasToken: false }), [], [])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('warning: could not check Dependabot alerts. The release is not blocked.\n')
      expect(result.stderr.split('error: could not check alerts: authentication error')).toHaveLength(3)
      expect(result.stdout).toBe('')
    })
  })

  it('もし git リポジトリのルートを見つけられないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-18')
    const result = await runPreflight(project({ isGit: false }), [], [], ['--repo', 'acme/demo'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not find the root directory of the git repository\n')
  })

  it('もしアクティブなプロジェクトが無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-19')
    const result = await runPreflight(project({ isActive: false }), [], [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: no active project\n')
  })

  it.for([{ arguments_: ['0.2.0'] }, { arguments_: ['--package', 'pkg-a'] }])('もし nx のリポジトリに $arguments_ を渡したなら、終了コード 1 で終わる', async ({ arguments_ }, context) => {
    await verifies(context, 'PW-RELEASE-CHECK-20')
    const result = await runPreflight(project({ repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }), arguments_, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the version argument and --package cannot be used when release_type is nx')
  })

  it('もし packages を設定したリポジトリに --package を渡さなかったなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-21')
    const result = await runPreflight(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), [], [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo is a monorepo')
    expect(result.stderr).toContain('available: pkg-a')
  })

  it('もし --package が設定に登録していないパッケージ名なら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-22')
    const result = await runPreflight(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), ['--package', 'unknown'], [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('package \'unknown\' is not registered in acme/demo')
  })

  it('もし packages を設定していないリポジトリに --package を渡したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-23')
    const result = await runPreflight(project(), ['--package', 'pkg-a'], [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo has no packages configured')
  })

  it.for([
    { kind: 'develop', repository: { owner: 'acme', name: 'demo', release_branch: 'release' } },
    { kind: 'release', repository: { owner: 'acme', name: 'demo', develop_branch: 'develop' } },
  ])('もし $kind の branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async ({ kind, repository }, context) => {
    await verifies(context, 'PW-RELEASE-CHECK-24')
    const result = await runPreflight(project({ repositories: [repository] }))
    expect(result.stderr).toContain(`error: ${kind}_branch is not set for acme/demo\n`)
    expect(result.stderr).toContain(`pecot project link acme/demo --${kind}-branch <branch>`)
  })

  it.for([
    { repository: { owner: 'acme', name: 'demo', release_branch: 'release' } },
    { repository: { owner: 'acme', name: 'demo', develop_branch: 'develop' } },
  ])('もし develop_branch か release_branch を設定していないなら、終了コード 1 で終わる', async ({ repository }, context) => {
    await verifies(context, 'PW-RELEASE-CHECK-25')
    const result = await runPreflight(project({ repositories: [repository] }))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('もし CHANGELOG が無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-26')
    const result = await runPreflight(project({ ...WITH_BRANCHES, files: { 'CHANGELOG.md': undefined } }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CHANGELOG.md')
  })

  it('もし版を省いて CHANGELOG に版が 1 つも無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-27')
    const result = await runPreflight(project({ ...WITH_BRANCHES, files: NO_PACKAGE_FILES }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: ')
    expect(result.stdout).toBe('')
  })

  it('もし渡した版が X.Y.Z の形でないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-28')
    const result = await runPreflight(project(WITH_BRANCHES), ['1.2'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('1.2')
  })

  it('もしタグがローカルに既にあるなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-29')
    const result = await runPreflight(project({ ...WITH_BRANCHES, localTags: ['v0.2.0'] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: tag already exists locally: v0.2.0\n')
  })

  it('もしタグが remote に既にあるなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-30')
    const result = await runPreflight(project({ ...WITH_BRANCHES, remoteTags: ['v0.2.0'] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: tag already exists on the remote: v0.2.0\n')
  })

  it('もし <remote>/<release_branch> に無いコミットが <remote>/<develop_branch> から 1 つも見つからないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-31')
    const result = await runCounted(project(WITH_BRANCHES), [], alertRules(), [], 0)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: no difference between origin/release and origin/develop: there is nothing to release\n')
  })

  it('打つと、release から develop までのコミットを compare API で数え、git fetch を打たない', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-38')
    const created = project(WITH_BRANCHES)
    const result = await runCounted(created, [], alertRules(), [], 3)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('count: commits to release (origin/develop -> origin/release): 3\n')
    expect(pathsOf(result)).toContain('GET /repos/acme/demo/compare/release...develop')
    expect(result.stderr).not.toContain('fetch')
  })

  it('もしコミットの数を GitHub から数えられないなら、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-39')
    const rules = [...alertRules(), rest('GET', '/repos/acme/demo/compare/release...develop', 404, NOT_FOUND)]
    const result = await runPreflight(project(WITH_BRANCHES), [], rules)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not count the commits from release to develop: .+\n/u)
    expect(result.stdout).toBe('')
  })

  it('もし compare の通信が切れたなら、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-39')
    const dropped: ResponseRule = { match: { method: 'GET', path: '/repos/acme/demo/compare/release...develop' }, respond: { status: 200, drop: true }, times: 1 }
    const result = await runPreflight(project(WITH_BRANCHES), [], [...alertRules(), dropped])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not count the commits from release to develop: .+\n/u)
    expect(result.stderr).not.toContain('    at ')
  })

  it('もし CHANGELOG に渡した版の節が無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-32')
    const result = await runCounted(project(WITH_BRANCHES), ['9.9.9'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('9.9.9')
  })

  it('もし git コマンドが失敗したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CHECK-33')
    const result = await runPreflight(project({ remote: 'none' }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: git command failed: git ls-remote --tags origin refs/tags/v0.2.0')
  })

  describe('--repo を省いて git の remote のリポジトリを読めない', () => {
    it('もし --repo を省いて git の remote のリポジトリを読めないなら、error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-34')
      const result = await runPreflight(projectWithBrokenRemote(WITH_BRANCHES), [], [])
      expect(result.stderr).toBe('error: could not read the repository from the git remote\n')
    })

    it('もし --repo を省いて git の remote のリポジトリを読めないなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-35')
      const result = await runPreflight(projectWithBrokenRemote(WITH_BRANCHES), [], [])
      expect(result.code).toBe(1)
    })
  })

  describe('--repo を省いて git の外で打った', () => {
    it('もし --repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-36')
      const result = await runPreflight(project({ isGit: false }), [], [])
      expect(result.stderr).toContain('error: the repository is ambiguous\n')
    })

    it('もし --repo を省いて git の外で打ったなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-37')
      const result = await runPreflight(project({ isGit: false }), [], [])
      expect(result.code).toBe(1)
    })
  })
})

describe('release create', () => {
  const notes = { body: NOTES_0_2_0 }

  it('版を渡して打つと、CHANGELOG のその版の節をリリースノートにして GitHub のリリースを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-01')
    const result = await runCreate(project(), ['0.2.0'], [releaseCreated()])
    expect(result.code).toBe(0)
    expect(result.requests).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/releases', body: { tag_name: 'v0.2.0', name: 'v0.2.0', ...notes } }])
  })

  it('リリースを作ると、release_branch の先頭にタグを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-02')
    const result = await runCreate(project(), ['0.2.0'], [releaseCreated()])
    expect(result.requests).toMatchObject([{ body: { target_commitish: 'release' } }])
  })

  it('--package を付けて打つと、パッケージ名を接頭辞にしたタグと名前でリリースを作る', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-03')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), ['0.2.0', '--package', 'pkg-a'], [releaseCreated('pkg-a-v0.2.0', 'pkg-a v0.2.0')])
    expect(result.code).toBe(0)
    expect(result.requests).toMatchObject([{ body: { tag_name: 'pkg-a-v0.2.0', name: 'pkg-a v0.2.0' } }])
  })

  describe('--dry-run', () => {
    it('--dry-run を付けて打つと、リリースを作らない', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-04')
      const result = await runCreate(project(), ['0.2.0', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.requests).toEqual([])
    })

    it('--dry-run を付けて打つと、予定の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-05')
      const result = await runCreate(project(), ['0.2.0', '--dry-run'])
      expect(result.stderr).toBe('dry-run: would create release v0.2.0 on release\n')
    })

    it('--dry-run を付けて打つと、リリースノートを標準出力に出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-06')
      const result = await runCreate(project(), ['0.2.0', '--dry-run'])
      expect(result.stdout).toBe(`${NOTES_0_2_0}\n`)
    })
  })

  it('--repo が今の git remote のリポジトリと食い違うと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-07')
    const result = await runCreate(project({ repositories: [DEFAULT_REPOSITORY, OTHER] }), ['0.2.0'], [releaseCreated('v0.2.0', 'v0.2.0', 'acme/other')], ['--repo', 'acme/other'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: using --repo acme/other (current Git remote: acme/demo)\n')
  })

  it('リリースを作ると、リリースの URL を標準出力に出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-08')
    const result = await runCreate(project(), ['0.2.0'], [releaseCreated()])
    expect(result.stdout).toBe('https://ghes.example.com/acme/demo/releases/tag/v0.2.0\n')
  })

  it('リリースを作ると、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-09')
    const result = await runCreate(project(), ['0.2.0'], [releaseCreated()])
    expect(result.stderr).toBe('created: release v0.2.0 on release\n')
  })

  it('もし版が X.Y.Z の形でないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-10')
    const result = await runCreate(project(), ['1.2'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('1.2')
  })

  it('もし git リポジトリのルートを見つけられないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-11')
    const result = await runCreate(project({ isGit: false }), ['0.2.0'], [], ['--repo', 'acme/demo'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not find the root directory of the git repository\n')
  })

  it('もしアクティブなプロジェクトが無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-12')
    const result = await runCreate(project({ isActive: false }), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: no active project\n')
  })

  it('もし packages を設定したリポジトリに --package を渡さなかったなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-13')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo is a monorepo')
  })

  it('もし --package が設定に登録していないパッケージ名なら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-14')
    const result = await runCreate(project({ repositories: [PACKAGES], files: PACKAGE_FILES }), ['0.2.0', '--package', 'unknown'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('package \'unknown\' is not registered in acme/demo')
  })

  it('もし packages を設定していないリポジトリに --package を渡したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-15')
    const result = await runCreate(project(), ['0.2.0', '--package', 'pkg-a'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acme/demo has no packages configured')
  })

  it('もし CHANGELOG が無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-16')
    const result = await runCreate(project({ files: { 'CHANGELOG.md': undefined } }), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: CHANGELOG.md not found: /u)
  })

  it('もし CHANGELOG に渡した版の節が無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-17')
    const result = await runCreate(project(), ['9.9.9'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('9.9.9')
  })

  it('もし release_branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-18')
    const result = await runCreate(project(WITHOUT_RELEASE_BRANCH), ['0.2.0'])
    expect(result.stderr).toContain('error: release_branch is not set for acme/demo\n')
    expect(result.stderr).toContain('pecot project link acme/demo --release-branch <branch>')
  })

  it('もし release_branch を設定していないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-19')
    const result = await runCreate(project(WITHOUT_RELEASE_BRANCH), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
  })

  it('もしリリースの作成で GitHub API がエラーを返したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-20')
    const result = await runCreate(project(), ['0.2.0'], [rest('POST', '/repos/acme/demo/releases', 422, { message: 'Validation Failed' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not create release v0.2.0 in acme/demo: GitHub API error: 422 Validation Failed\n')
  })

  describe('--repo を省いて git の remote のリポジトリを読めない', () => {
    it('もし --repo を省いて git の remote のリポジトリを読めないなら、error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-21')
      const result = await runCreate(projectWithBrokenRemote(), ['0.2.0'])
      expect(result.stderr).toBe('error: could not read the repository from the git remote\n')
    })

    it('もし --repo を省いて git の remote のリポジトリを読めないなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CREATE-22')
      const result = await runCreate(projectWithBrokenRemote(), ['0.2.0'])
      expect(result.code).toBe(1)
    })
  })

  it('もし --repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-23')
    const result = await runCreate(project({ isGit: false }), ['0.2.0'])
    expect(result.stderr).toContain('error: the repository is ambiguous\n')
  })

  it('もし --repo を省いて git の外で打ったなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-24')
    const result = await runCreate(project({ isGit: false }), ['0.2.0'])
    expect(result.code).toBe(1)
  })

  it('もし GitHub のトークンが見つからないなら、error の行を標準エラーに出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-25')
    const result = await runCreate(project({ hasToken: false }), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: authentication error: could not get a GitHub API token/u)
  })

  it('もし GitHub のトークンが見つからないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-CREATE-26')
    const result = await runCreate(project({ hasToken: false }), ['0.2.0'])
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
  })
})

describe('release merge', () => {
  const merged = rest('PUT', '/repos/acme/demo/pulls/31/merge', 200, { sha: 'abcdef0', merged: true, message: 'Pull Request successfully merged' })
  const deleted = rest('DELETE', '/repos/acme/demo/git/refs/heads/develop', 204)

  it('PR の参照を渡して打つと、その PR を通常のマージ（マージコミット）でマージする', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-01')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse(), merged])
    expect(result.code).toBe(0)
    expect(result.requests.at(-1)).toMatchObject({ type: 'rest', method: 'PUT', path: '/repos/acme/demo/pulls/31/merge', body: { merge_method: 'merge' } })
  })

  it.for([{ flag: '--delete-branch' }, { flag: '-d' }])('$flag を付けて打つと、マージの後に PR の head ブランチをリモートから削除する', async ({ flag }, context) => {
    await verifies(context, 'PW-RELEASE-MERGE-02')
    const result = await runMerge(project(), ['acme/demo/31', flag], [pullRequestResponse(), merged, deleted])
    expect(pathsOf(result).slice(-2)).toEqual(['PUT /repos/acme/demo/pulls/31/merge', 'DELETE /repos/acme/demo/git/refs/heads/develop'])
  })

  it('--admin を付けて打つと、衝突のある PR でもマージを試みる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-03')
    const result = await runMerge(project(), ['acme/demo/31', '--admin'], [pullRequestResponse({ mergeable: 'CONFLICTING' }), merged])
    expect(result.code).toBe(0)
    expect(pathsOf(result)).toContain('PUT /repos/acme/demo/pulls/31/merge')
  })

  describe('--dry-run', () => {
    it('--dry-run を付けて打つと、マージしない', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-04')
      const result = await runMergeDryRun()
      expect(result.code).toBe(0)
      expect(pathsOf(result)).not.toContain('PUT /repos/acme/demo/pulls/31/merge')
    })

    it('--dry-run を付けて打つと、予定の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-05')
      const result = await runMergeDryRun()
      expect(result.stderr).toBe('dry-run: would merge PR acme/demo/31 (develop -> release, merge commit)\n')
    })

    it('--dry-run と --delete-branch を付けて打つと、ブランチを削除しない', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-06')
      const result = await runMergeDryRun()
      expect(pathsOf(result).some(entry => entry.startsWith('DELETE'))).toBe(false)
    })
  })

  it('PR をマージすると、merged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-07')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse(), merged])
    expect(result.stderr).toBe('merged: PR acme/demo/31 (develop -> release, merge commit)\n')
  })

  it('head ブランチを削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-08')
    const result = await runMerge(project(), ['acme/demo/31', '-d'], [pullRequestResponse(), merged, deleted])
    expect(result.stderr).toContain('deleted: remote branch develop in acme/demo\n')
  })

  describe('head ブランチを削除できない', () => {
    const failing = [pullRequestResponse(), merged, rest('DELETE', '/repos/acme/demo/git/refs/heads/develop', 422, { message: 'Reference does not exist' })]

    it('もし head ブランチを削除できなかったなら、warning の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-09')
      const result = await runMerge(project(), ['acme/demo/31', '-d'], failing)
      expect(result.stderr).toContain('warning: deleting remote branch develop failed: ')
    })

    it('もし head ブランチを削除できなかったなら、終了コード 0 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-10')
      const result = await runMerge(project(), ['acme/demo/31', '-d'], failing)
      expect(result.code).toBe(0)
    })
  })

  describe('--repo が今の git remote のリポジトリと食い違う', () => {
    it('もし --repo が今の git remote のリポジトリと食い違うなら、error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-11')
      const result = await runMergeMismatch()
      expect(result.stderr).toContain('error: --repo acme/other differs from the current Git remote (acme/demo)\n')
    })

    it('もし --repo が今の git remote のリポジトリと食い違うなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-MERGE-12')
      const result = await runMergeMismatch()
      expect(result.code).toBe(1)
      expect(result.requests).toEqual([])
    })
  })

  it('もしアクティブなプロジェクトが無いなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-13')
    const result = await runMerge(project({ isActive: false }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: no active project\n')
  })

  it('もし PR の参照が owner/repo/N の形でないなら、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-14')
    const result = await runMerge(project(), ['31'])
    expect(result.code).toBe(USAGE_ERROR)
    expect(result.stderr).toContain('use the full form \'owner/repo/N\'')
  })

  it('もし PR が見つからないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-15')
    const rule: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 200, text: '{"data":{"repository":{"pullRequest":null}}}' }, times: 1 }
    const result = await runMerge(project(), ['acme/demo/31'], [rule])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR acme/demo/31 not found\n')
  })

  it('もし PR の取得で GitHub API がエラーを返したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-16')
    const rule: ResponseRule = { match: { operation: 'GetPullRequestSlim' }, respond: { status: 422, body: { message: 'Validation Failed' } }, times: 1 }
    const result = await runMerge(project(), ['acme/demo/31'], [rule])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: could not read PR acme/demo/31: ')
  })

  it('もし PR が既にマージ済みなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-17')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse({ state: 'MERGED' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR #31 is already merged\n')
  })

  it('もし PR が閉じているなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-18')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse({ state: 'CLOSED' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: PR #31 is closed\n')
  })

  it('もし PR に衝突があって --admin を付けていないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-19')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse({ mergeable: 'CONFLICTING' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: PR #31 has conflicts that must be resolved\n')
    expect(result.stderr).toContain('to try a forced merge, add --admin')
  })

  it('もし release_branch を設定していないなら、設定コマンドを案内する error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-20')
    const result = await runMerge(project(WITHOUT_RELEASE_BRANCH), ['acme/demo/31'], [pullRequestResponse()])
    expect(result.stderr).toContain('error: release_branch is not set for acme/demo\n')
    expect(result.stderr).toContain('pecot project link acme/demo --release-branch <branch>')
  })

  it('もし release_branch を設定していないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-21')
    const result = await runMerge(project(WITHOUT_RELEASE_BRANCH), ['acme/demo/31'], [pullRequestResponse()])
    expect(result.code).toBe(1)
  })

  it('もし PR の base ブランチが release_branch でないなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-22')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse({ base: 'main' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the base branch of PR #31 does not match release_branch')
    expect(pathsOf(result)).not.toContain('PUT /repos/acme/demo/pulls/31/merge')
  })

  it('もしマージで GitHub API がエラーを返したなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-23')
    const result = await runMerge(project(), ['acme/demo/31'], [pullRequestResponse(), rest('PUT', '/repos/acme/demo/pulls/31/merge', 405, { message: 'Pull Request is not mergeable' })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: could not merge PR acme/demo/31: GitHub API error: 405 Pull Request is not mergeable\n')
  })

  it('もし --repo を省いて git の外で打ったなら、the repository is ambiguous の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-24')
    const result = await runMerge(project({ isGit: false }))
    expect(result.stderr).toContain('error: the repository is ambiguous\n')
  })

  it('もし --repo を省いて git の外で打ったなら、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-RELEASE-MERGE-25')
    const result = await runMerge(project({ isGit: false }))
    expect(result.code).toBe(1)
  })
})
