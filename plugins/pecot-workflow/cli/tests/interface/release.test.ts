/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 読み取りの結果の形の値は readonly にしない */
// release_check の振る舞い（PW-RELEASE-CHECK-*）を、ツールをプロセス内で呼んで確かめる。読み取りは公式の GitHub MCP の結果の形で渡す。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { step } from '../_helpers/step.js'
import { verifies } from '../_helpers/verifies.js'
import { callRelease, createProject, DEFAULT_REPOSITORY, failRemoteLookupFrom, NOTES_0_2_0, releaseValues, runRelease } from '../_helpers/release-sandbox.js'
import type { Project, ProjectOptions } from '../_helpers/release-sandbox.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const PROBLEMS = z.array(z.record(z.string(), z.unknown()))
const WITH_BRANCHES: ProjectOptions = { remote: 'branches' }
const OTHER = { owner: 'acme', name: 'other', develop_branch: 'develop', release_branch: 'release' }
const NX = { repositories: [{ ...DEFAULT_REPOSITORY, release_type: 'nx' }] }
const PACKAGES = { ...DEFAULT_REPOSITORY, packages: [{ name: 'pkg-a', changelog: 'packages/a/CHANGELOG.md' }] }
const PACKAGE_FILES = { 'packages/a/CHANGELOG.md': `# Changelog\n\n## [0.2.0] - 2026-01-02\n\n${NOTES_0_2_0}\n` }
const ALERTS_URL = 'https://ghes.example.com/acme/demo/security/dependabot'
const NO_RELEASE = { error: 'failed to get release by tag: GET https://ghes.example.com/api/v3/repos/acme/demo/releases/tags/v0.2.0: 404 Not Found []' }

const page = (alerts: readonly Json[], hasNextPage = false): Json => ({ alerts, pageInfo: { hasNextPage } })
const listed = (...pages: readonly Json[]): Json => ({ pages: pages.length === 0 ? [page([])] : pages })
const failed = (error: string): Json => ({ error })

const DEPENDABOT_ALERTS = [
  { number: 1, dependency: { package: { name: 'minimatch' } }, security_vulnerability: { severity: 'medium' } },
  { number: 2, dependency: { package: { name: 'glob' } }, security_vulnerability: { severity: 'critical' } },
]

function reads(overrides: Readonly<Json> = {}): Json {
  return { dependabot_alerts: listed(), code_scanning_alerts: listed(), secret_scanning_alerts: listed(), release: NO_RELEASE, ...overrides }
}

function project(options: Readonly<ProjectOptions> = WITH_BRANCHES): Project {
  return createProject(options)
}

async function check(target: Readonly<Project>, overrides: Readonly<Json> = {}, readValues: Readonly<Json> = reads(), extra: Readonly<Json> = {}): Promise<ToolOutcome> {
  return await callRelease(target, { params: releaseValues(target, overrides), reads: readValues, ...extra })
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Json>[] {
  expect(outcome.isError).toBe(false)
  return PROBLEMS.parse(outcome.structured['problems'])
}

const codesOf = (outcome: Readonly<ToolOutcome>): readonly (readonly unknown[])[] => problemsOf(outcome).map(problem => [problem['field'], problem['code']])

// 既定の環境で params の一部を差し替えたときの problems
async function problemsForValues(overrides: Readonly<Json>): Promise<readonly Readonly<Json>[]> {
  return problemsOf(await check(project(), overrides))
}

// 既定の環境で読み取りの一部を差し替えたときの結果
async function checkReads(overrides: Readonly<Json>): Promise<ToolOutcome> {
  return await check(project(), {}, reads(overrides))
}

const openAlerts = (...numbers: readonly number[]): Json => listed(page(numbers.map(number => ({ number }))))

// origin を手元の bare リポのパスに付け替えて、URL から owner/repo を読めなくする
function projectWithBareOrigin(): Project {
  const created = project()
  gitForTest(created.directory, ['remote', 'set-url', 'origin', path.join(created.root, 'remotes', 'acme', 'demo.git')])
  return created
}

// main に v0.1.0 のタグを付け、その後に 1 つ commit して release へ push する
function projectAfterTag(): Project {
  const created = project({ ...WITH_BRANCHES, localTags: ['v0.1.0'] })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 一時ディレクトリの中
  writeFileSync(path.join(created.directory, 'next.txt'), 'x\n')
  gitForTest(created.directory, ['add', 'next.txt'])
  gitForTest(created.directory, ['commit', '-q', '-m', 'next'])
  gitForTest(created.directory, ['push', '-q', path.join(created.root, 'remotes', 'acme', 'demo.git'), 'main:release'])
  return created
}

describe('release_check', () => {
  describe('通る値', () => {
    it('決まりに合う params と読み取りの結果を渡すと、problem の無い結果と版・リリースノート・コミット数を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-01')
      await explains('`release_check` の通る値のテストです。CHANGELOG の節と同じ本文と release の先頭の sha を渡した場合に、問題の無い結果と版・リリースノート・コミット数を返すことを確認します。')
      const target = projectAfterTag()
      const result = await check(target)
      await step('ok の文言と、版・リリースノート・コミット数を比べる', () => {
        expect(result.text).toBe('ok')
        expect(result.structured).toEqual({
          problems: [],
          skipped: [],
          dependabotAlerts: { enabled: true, openCount: 0, alertsUrl: ALERTS_URL },
          version: '0.2.0',
          releaseNotes: NOTES_0_2_0,
          commitCount: 1,
        })
      })
    })

    it('前のリリースのタグが無いと、コミット数を省いた結果を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-10')
      await explains('`release_check` のコミット数のテストです。`v*` のタグが手元に存在しない場合は、問題を返さず、結果から `commitCount` を省くことを確認します。')
      const result = await check(project())
      await step('problem が無く、commitCount が無いことを確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured).not.toHaveProperty('commitCount')
      })
    })

    it('名前を省くと、タグをリリースの名前とみなす', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-06')
      await explains('`release_check` のリリース名のテストです。`params.name` を省略した場合と、タグと同じ名前を渡した場合のどちらでも、問題を返さないことを確認します。')
      const target = project()
      const omitted = await check(target)
      const same = await check(target, { name: 'v0.2.0' })
      await step('どちらも problem が無いことを確かめる', () => {
        expect(problemsOf(omitted)).toEqual([])
        expect(problemsOf(same)).toEqual([])
      })
    })

    it('本文の前後の空白だけが CHANGELOG の節と違うと、同じ本文とみなす', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-05')
      await explains('`release_check` の本文のテストです。CHANGELOG の節の前後に改行と空白を付けた本文を渡した場合に、問題を返さないことを確認します。')
      const problems = await problemsForValues({ body: `\n${NOTES_0_2_0}\n  ` })
      await step('problem が無いことを確かめる', () => {
        expect(problems).toEqual([])
      })
    })

    it('CHANGELOG の末尾にリンク定義があると、本文が使う定義だけを加えたリリースノートを返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-23')
      await explains('`release_check` のリリースノートのテストです。ファイル末尾に版と参照リンクの定義を置いた CHANGELOG の場合に、本文が使う定義だけを末尾に加えた本文を返すことを確認します。')
      const changelog = '# Changelog\n\n## [0.2.0] - 2026-01-02\n\n- [docs][d]\n\n## [0.1.0] - 2026-01-01\n\n- 初回リリース\n\n[0.2.0]: https://example.com/v0.2.0\n[0.1.0]: https://example.com/v0.1.0\n[d]: https://example.com/docs\n'
      const notes = '- [docs][d]\n\n[d]: https://example.com/docs'
      const result = await check(project({ ...WITH_BRANCHES, files: { 'CHANGELOG.md': changelog } }), { body: notes })
      expect(problemsOf(result)).toEqual([])
      expect(result.structured['releaseNotes']).toBe(notes)
    })

    it('monorepo のリポジトリでは、パッケージ名を接頭辞にしたタグとそのパッケージの CHANGELOG で確かめる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-03')
      await explains('`release_check` の monorepo のテストです。登録したパッケージの `pkg-a-v0.2.0` のタグと `pkg-a v0.2.0` の名前を渡した場合に、そのパッケージの CHANGELOG と照らして問題を返さないことを確認します。')
      const target = project({ ...WITH_BRANCHES, repositories: [PACKAGES], files: { 'CHANGELOG.md': undefined, ...PACKAGE_FILES } })
      const result = await check(target, { tag: 'pkg-a-v0.2.0', name: 'pkg-a v0.2.0' })
      await step('problem が無く、版が 0.2.0 であることを確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['version']).toBe('0.2.0')
      })
    })
  })

  describe('タグ・本文・名前', () => {
    it.for([
      { name: 'v の無いタグ', tag: '0.2.0', candidates: ['v<version>'] },
      { name: '版が X.Y.Z の形でないタグ', tag: 'v1.2', candidates: ['v<version>'] },
      { name: '接頭辞の付いたタグ', tag: 'pkg-a-v0.2.0', candidates: ['v0.2.0'] },
    ])('$name を渡すと、tag-name の項目と候補を返す', async ({ name, tag, candidates }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-02')
      await explains(`\`release_check\` のタグの名前のテストです。${name}の \`${tag}\` を渡した場合に、\`tag-name\` の項目と期待するタグの候補だけを返すことを確認します。`)
      const outcome = await check(project(), { tag })
      await step('tag-name の problem と候補を比べる', () => {
        const problems = problemsOf(outcome)
        expect(problems).toEqual([{ field: 'params.tag', code: 'tag-name', message: `the tag must be v<version> with a semantic version (got ${tag})`, candidates }])
      })
    })

    it('monorepo のリポジトリに登録の無い接頭辞のタグを渡すと、登録したパッケージのタグを候補に返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-03')
      await explains('`release_check` の monorepo のテストです。パッケージを登録したリポジトリに `v0.2.0` を渡した場合に、`tag-name` の項目と `pkg-a-v0.2.0` の候補を返すことを確認します。')
      const target = project({ ...WITH_BRANCHES, repositories: [PACKAGES], files: PACKAGE_FILES })
      const outcome = await check(target)
      await step('monorepo の tag-name の problem と候補を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'params.tag', code: 'tag-name', message: 'this repository is a monorepo; the tag must be <package>-v<version> with a registered package (got v0.2.0)', candidates: ['pkg-a-v0.2.0'] }])
      })
    })

    it.for([
      { name: 'CHANGELOG が存在しない', files: { 'CHANGELOG.md': undefined }, tag: 'v0.2.0', message: 'CHANGELOG.md not found: ' },
      { name: 'CHANGELOG に版の節が存在しない', files: {}, tag: 'v9.9.9', message: '9.9.9' },
    ])('$name と、changelog-missing の項目を返す', async ({ name, files, tag, message }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-04')
      await explains(`\`release_check\` の CHANGELOG のテストです。条件が「${name}」の場合に、\`params.body\` に \`changelog-missing\` の項目を返すことを確認します。`)
      const outcome = await check(project({ ...WITH_BRANCHES, files }), { tag, name: tag })
      await step('changelog-missing の problem と文を確かめる', () => {
        const problems = problemsOf(outcome)
        expect(problems.map(problem => [problem['field'], problem['code']])).toEqual([['params.body', 'changelog-missing']])
        expect(problems[0]?.['message']).toContain(message)
      })
    })

    it('本文が CHANGELOG の節と違うと、body-mismatch の項目と節の本文の候補を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-05')
      await explains('`release_check` の本文のテストです。CHANGELOG の節と異なる本文を渡した場合に、`body-mismatch` の項目と、節の本文を候補に返すことを確認します。')
      const problems = await problemsForValues({ body: '### 追加\n\n- 新機能 A' })
      await step('body-mismatch の problem と節の本文の候補を比べる', () => {
        expect(problems).toEqual([{ field: 'params.body', code: 'body-mismatch', message: 'body must be the CHANGELOG section of 0.2.0', candidates: [NOTES_0_2_0] }])
      })
    })

    it.for([
      { name: 'タグと違う名前', options: WITH_BRANCHES, tag: 'v0.2.0', given: 'Release 0.2.0', expected: 'v0.2.0' },
      { name: 'monorepo でタグと同じ名前', options: { ...WITH_BRANCHES, repositories: [PACKAGES], files: PACKAGE_FILES }, tag: 'pkg-a-v0.2.0', given: undefined, expected: 'pkg-a v0.2.0' },
    ])('$name を渡すと、release-name の項目と期待する名前を返す', async ({ name, options, tag, given, expected }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-06')
      await explains(`\`release_check\` のリリース名のテストです。${name}を渡した場合に、\`release-name\` の項目と \`${expected}\` の候補を返すことを確認します。`)
      const outcome = await check(project(options), { tag, ...given !== undefined && { name: given } })
      await step('release-name の problem と候補を比べる', () => {
        const problems = problemsOf(outcome)
        expect(problems).toEqual([{ field: 'params.name', code: 'release-name', message: `the release name must be ${expected}`, candidates: [expected] }])
      })
    })
  })

  describe('タグとリリースの重なり', () => {
    it.for([
      { name: 'タグが手元に既にある', options: { ...WITH_BRANCHES, localTags: ['v0.2.0'] }, message: 'tag v0.2.0 already exists locally; release a new version' },
      { name: 'タグが remote に既にある', options: { ...WITH_BRANCHES, remoteTags: ['v0.2.0'] }, message: 'tag v0.2.0 already exists on origin; release a new version' },
    ])('$name と、tag-exists の項目を返す', async ({ name, options, message }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-07')
      await explains(`\`release_check\` のタグの重なりのテストです。条件が「${name}」の場合に、\`params.tag\` に \`tag-exists\` の項目を返すことを確認します。`)
      const outcome = await check(project(options))
      await step('tag-exists の problem を比べる', () => {
        const problems = problemsOf(outcome)
        expect(problems.filter(problem => problem['code'] === 'tag-exists')).toEqual([{ field: 'params.tag', code: 'tag-exists', message }])
      })
    })

    it('get_release_by_tag の結果にリリースがあると、URL を添えた tag-exists の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-07')
      await explains('`release_check` のリリースの重なりのテストです。`reads.release.result` にリリースを渡した場合に、その URL を添えた `tag-exists` の項目を返すことを確認します。')
      const release = { result: { tag_name: 'v0.2.0', html_url: 'https://ghes.example.com/acme/demo/releases/tag/v0.2.0' } }
      const outcome = await checkReads({ release })
      await step('リリースの URL を添えた tag-exists の problem を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'params.tag', code: 'tag-exists', message: 'the release of v0.2.0 already exists (https://ghes.example.com/acme/demo/releases/tag/v0.2.0); release a new version' }])
      })
    })

    it.for([
      { name: 'reads.release が無い', release: undefined, message: 'read the release of v0.2.0 with get_release_by_tag and pass its result as reads.release.result, or its error text (404 when there is none) as reads.release.error' },
      { name: 'get_release_by_tag が 404 でない誤りを返した', release: failed('failed to get release by tag: 502 Bad Gateway\nretry later'), message: 'get_release_by_tag failed: failed to get release by tag: 502 Bad Gateway; read it again' },
    ])('$name と、reads.release に read-required の項目を返す', async ({ name, release, message }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-15')
      await explains(`\`release_check\` のリリースの読み取りのテストです。条件が「${name}」の場合に、\`reads.release\` に \`read-required\` の項目を返すことを確認します。`)
      const outcome = await checkReads({ release })
      await step('read-required の problem を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'reads.release', code: 'read-required', message }])
      })
    })
  })

  describe('sha', () => {
    it('sha が release の先頭でないと、sha-mismatch の項目と先頭の sha の候補を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-08')
      await explains('`release_check` の `sha` のテストです。remote の release の先頭と異なる commit を渡した場合に、`sha-mismatch` の項目と、先頭の sha を候補に返すことを確認します。')
      const target = project()
      const head = gitForTest(target.directory, ['rev-parse', 'main']).trim()
      const develop = gitForTest(target.directory, ['rev-parse', 'develop']).trim()
      const outcome = await check(target, { sha: develop })
      await step('sha-mismatch の problem と先頭の sha の候補を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'params.sha', code: 'sha-mismatch', message: 'sha must be the head of release branch release on origin', candidates: [head] }])
      })
    })

    it('release のブランチが remote に無いと、sha-mismatch の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-08')
      await explains('`release_check` の `sha` のテストです。remote に release のブランチが存在しない場合に、`sha-mismatch` の項目を返すことを確認します。')
      const target = project()
      gitForTest(path.join(target.root, 'remotes', 'acme', 'demo.git'), ['branch', '-D', 'release'])
      const outcome = await check(target)
      await step('release のブランチが無いときの sha-mismatch の problem を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'params.sha', code: 'sha-mismatch', message: 'release branch release is not on origin' }])
      })
    })

    it('sha の commit が手元に無いと、not-found の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-09')
      await explains('`release_check` の `sha` のテストです。手元のリポジトリに存在しない commit を渡した場合に、`not-found` の項目で `fetch` を案内することを確認します。')
      const sha = 'f'.repeat(40)
      const outcome = await check(project(), { sha })
      await step('not-found の problem と fetch の案内を比べる', () => {
        const problems = problemsOf(outcome)
        expect(problems.find(problem => problem['code'] === 'not-found')).toEqual({ field: 'params.sha', code: 'not-found', message: `commit ${sha} is not in the local repository; fetch origin and check again` })
      })
    })

    it('前のリリースのタグから sha までにコミットが無いと、no-commits の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-10')
      await explains('`release_check` のコミット数のテストです。前のリリースのタグ `v0.1.0` が `sha` と同じ commit を指す場合に、`no-commits` の項目とコミット数 0 を返すことを確認します。')
      const result = await check(project({ ...WITH_BRANCHES, localTags: ['v0.1.0'] }))
      await step('no-commits の problem とコミット数 0 を確かめる', () => {
        expect(problemsOf(result)).toEqual([{ field: 'params.sha', code: 'no-commits', message: 'there are no commits from v0.1.0 to sha; there is nothing to release' }])
        expect(result.structured['commitCount']).toBe(0)
      })
    })
  })

  describe('alert', () => {
    it('open の code scanning と secret scanning の alert があると、番号と URL を添えた blocking-alert の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-11')
      await explains('`release_check` の alert のテストです。code scanning と secret scanning に open の alert がある場合に、種類ごとに `blocking-alert` の項目を返すことを確認します。')
      const result = await checkReads({ code_scanning_alerts: openAlerts(12, 10), secret_scanning_alerts: openAlerts(5) })
      await step('blocking-alert の problem を比べる', () => {
        expect(problemsOf(result)).toEqual([
          { field: 'reads.code_scanning_alerts', code: 'blocking-alert', message: 'code scanning has 2 open alerts (#10, #12) → https://ghes.example.com/acme/demo/security/code-scanning; close them (fixed, or dismissed with a reason) and check again' },
          { field: 'reads.secret_scanning_alerts', code: 'blocking-alert', message: 'secret scanning has 1 open alert (#5) → https://ghes.example.com/acme/demo/security/secret-scanning; close them (fixed, or dismissed with a reason) and check again' },
        ])
      })
    })

    it('open の Dependabot alert があると、止めずに件数と最も重い severity を warnings と結果に入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-12')
      await explains('`release_check` の Dependabot alert のテストです。open の alert が 2 件ある場合に、問題を返さず、alert ごとの行を並べた警告と件数を返すことを確認します。')
      const dependabot = listed(page(DEPENDABOT_ALERTS))
      const result = await checkReads({ dependabot_alerts: dependabot })
      await step('problem が無く、Dependabot の件数と warnings を確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['dependabotAlerts']).toEqual({ enabled: true, openCount: 2, maxSeverity: 'critical', alertsUrl: ALERTS_URL })
        expect(result.structured['warnings']).toEqual([`2 open Dependabot alerts (highest severity: critical). The release is not blocked.\n  #1 (minimatch, medium)\n  #2 (glob, critical)\n  → ${ALERTS_URL}`])
      })
    })

    it('Dependabot の一覧が誤りを返すと、止めずに読めなかった理由を warnings に入れる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-12')
      await explains('`release_check` の Dependabot alert のテストです。一覧の読み取りが権限の誤りを返した場合に、問題を返さず、理由を添えた警告を返すことを確認します。')
      const result = await check(project(), {}, reads({ dependabot_alerts: failed('403 Resource not accessible by integration.\nmore') }))
      await step('problem が無く、読めなかった理由の warnings を確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['warnings']).toEqual(['could not check Dependabot alerts. The release is not blocked.\n  reason: 403 Resource not accessible by integration'])
        expect(result.structured).not.toHaveProperty('dependabotAlerts')
      })
    })

    it('3 種の機能が無効だと、飛ばした確認を skipped に入れて通る', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-13')
      await explains('`release_check` の機能が無効な場合のテストです。3 種類の一覧が機能の無効を示す誤りを返した場合に、問題を返さず、飛ばした確認を `skipped` に含めることを確認します。')
      const result = await check(project(), {}, reads({
        dependabot_alerts: failed('Dependabot alerts are disabled for this repository.'),
        code_scanning_alerts: failed('Advanced Security must be enabled for this repository to use code scanning.'),
        secret_scanning_alerts: failed('Secret scanning is disabled on this repository.'),
      }))
      await step('problem が無く、skipped と Dependabot の結果を確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['skipped']).toEqual(['Dependabot alerts (feature disabled)', 'code scanning (feature disabled)', 'secret scanning (feature disabled)'])
        expect(result.structured['dependabotAlerts']).toEqual({ enabled: false, openCount: 0, alertsUrl: ALERTS_URL })
      })
    })

    it('code scanning の解析がまだ無いと、alert が 0 件とみなす', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-14')
      await explains('`release_check` の code scanning のテストです。一覧が `no analysis found` の誤りを返した場合に、alert を 0 件とみなして問題を返さないことを確認します。')
      const result = await checkReads({ code_scanning_alerts: failed('no analysis found') })
      await step('problem が無いことを確かめる', () => {
        expect(problemsOf(result)).toEqual([])
      })
    })

    it.for([
      { name: '一覧が無い', read: undefined, message: 'read the open alerts with list_secret_scanning_alerts (state open, every page) and pass the results as reads.secret_scanning_alerts.pages, or its error text as reads.secret_scanning_alerts.error' },
      { name: '一覧が誤りを返した', read: failed('403 Forbidden\nmore'), message: 'list_secret_scanning_alerts failed: 403 Forbidden; read it again once it can be read (a token with access to the alerts)' },
      { name: '最後のページに続きがある', read: listed(page([], true)), message: 'the last page of list_secret_scanning_alerts has a next page; read it with after and add it to reads.secret_scanning_alerts.pages' },
    ])('secret scanning の $name と、alerts-unread の項目を返す', async ({ name, read, message }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-14')
      await explains(`\`release_check\` の alert の読み取りのテストです。secret scanning の条件が「${name}」の場合に、\`alerts-unread\` の項目を返すことを確認します。`)
      const outcome = await checkReads({ secret_scanning_alerts: read })
      await step('alerts-unread の problem を比べる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'reads.secret_scanning_alerts', code: 'alerts-unread', message }])
      })
    })

    it('平らな配列の一覧と、続きのページを足した一覧を受ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-11')
      await explains('`release_check` の alert の一覧の形のテストです。配列だけの一覧と、2 ページに分かれた一覧を渡した場合に、すべてのページの alert を数えることを確認します。')
      const secret = listed(page([{ number: 1 }], true), page([{ number: 2 }]))
      const result = await checkReads({ code_scanning_alerts: { pages: [[{ number: 3 }]] }, secret_scanning_alerts: secret })
      await step('ページを足した alert の件数を確かめる', () => {
        expect(codesOf(result)).toEqual([['reads.code_scanning_alerts', 'blocking-alert'], ['reads.secret_scanning_alerts', 'blocking-alert']])
        expect(problemsOf(result)[1]?.['message']).toContain('has 2 open alerts (#1, #2)')
      })
    })
  })

  describe('リリースの種類', () => {
    it('release_type が nx のリポジトリでは、alert だけを確かめる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-16')
      await explains('`release_check` の nx のリポジトリのテストです。`params` を省略した場合に、alert だけを確かめ、版とリリースノートを省いた結果を返すことを確認します。')
      const target = project({ ...WITH_BRANCHES, ...NX })
      const result = await callRelease(target, { reads: reads({ release: undefined }) })
      await step('alert だけを確かめた結果を比べる', () => {
        expect(result.structured).toEqual({ problems: [], skipped: [], dependabotAlerts: { enabled: true, openCount: 0, alertsUrl: ALERTS_URL } })
      })
    })

    it('release_type が nx のリポジトリに params を渡すと、unexpected の項目を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-16')
      await explains('`release_check` の nx のリポジトリのテストです。`params` を渡した場合に、`params` に `unexpected` の項目を返すことを確認します。')
      const result = await check(project({ ...WITH_BRANCHES, ...NX }))
      await step('params の unexpected の problem を比べる', () => {
        expect(codesOf(result)).toEqual([['params', 'unexpected']])
      })
    })

    it('nx でないリポジトリで params を省くと、required の項目と alert の結果を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-17')
      await explains('`release_check` の `params` のテストです。nx でないリポジトリで `params` を省略した場合に、`required` の項目と、alert の確認の項目を合わせて返すことを確認します。')
      const result = await callRelease(project(), { reads: { secret_scanning_alerts: listed(page([{ number: 5 }])) } })
      await step('required と alert の problem を比べる', () => {
        expect(codesOf(result)).toEqual([
          ['reads.dependabot_alerts', 'alerts-unread'],
          ['reads.code_scanning_alerts', 'alerts-unread'],
          ['reads.secret_scanning_alerts', 'blocking-alert'],
          ['params', 'required'],
        ])
      })
    })
  })

  describe('止まる場合', () => {
    it.for([
      { name: 'alert の一覧', readValues: reads({ code_scanning_alerts: { pages: [{ alerts: 'none' }] } }), detail: 'list_code_scanning_alerts' },
      { name: 'リリース', readValues: reads({ release: { result: { html_url: 'x' } } }), detail: 'get_release_by_tag' },
    ])('$name の形が公式の MCP の結果と違うと、github-mcp-shape の失敗を返す', async ({ name, readValues, detail }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-19')
      await explains(`\`release_check\` の読み取りの形のテストです。${name}の読み取りに公式の MCP の結果と異なる形を渡した場合に、\`github-mcp-shape\` の失敗を返すことを確認します。`)
      const result = await check(project(), {}, readValues)
      await step('github-mcp-shape の失敗と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'github-mcp-shape' } })
        expect(result.structured['detail']).toContain(detail)
      })
    })

    it('release_branch を設定していないと、設定を案内して repo-setting-missing の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-18')
      await explains('`release_check` のブランチの設定のテストです。リポジトリに `release_branch` が設定されていない場合に、`project_link` を案内して失敗を返すことを確認します。')
      const result = await check(project({ ...WITH_BRANCHES, repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }] }))
      await step('repo-setting-missing の失敗と設定の案内を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-setting-missing' } })
        expect(result.structured['detail']).toContain('release_branch: <branch>')
      })
    })

    it('remote のタグを読めないと、git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-20')
      await explains('`release_check` の git の remote のテストです。remote のリポジトリが存在せずタグを読めない場合に、`git-unresolved` の失敗を返すことを確認します。')
      const result = await check(project({ remote: 'none' }))
      await step('git-unresolved の失敗と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(result.structured['detail']).toMatch(/^could not read the tags of remote origin: /u)
      })
    })

    it('git のリポジトリのルートを見つけられないと、git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-20')
      await explains('`release_check` の git のリポジトリの検出のテストです。git のリポジトリの外で `repo` を渡して実行した場合に、エラーを出力して終了コード 1 で終わることを確認します。')
      const result = await runRelease(project({ isGit: false }), { repo: 'acme/demo' })
      await step('終了コード 1 と標準エラーを比べる', () => {
        expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not find the root directory of the git repository\n' })
      })
    })

    it('repo を省いて git の remote のリポジトリを読めないと、git-unresolved の失敗を返す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-20')
      await explains('`release_check` の対象のリポジトリのテストです。`repo` を省略し、git の remote のリポジトリを取得できない場合に、`git-unresolved` の失敗を返すことを確認します。')
      const target = project()
      failRemoteLookupFrom(target, 2)
      const result = await callRelease(target, { reads: reads() })
      await step('git-unresolved の失敗と detail を比べる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved', detail: 'could not read the repository from the git remote' } })
      })
    })
  })

  describe('対象のリポジトリと設定', () => {
    it('repo が今の git remote のリポジトリと食い違うと、warnings に入れて repo を使う', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-21')
      await explains('`release_check` の `repo` のテストです。`repo` が現在の git remote のリポジトリと異なる場合に、警告を返し、`repo` の設定で確かめることを確認します。')
      const target = project({ ...WITH_BRANCHES, repositories: [DEFAULT_REPOSITORY, OTHER] })
      const result = await check(target, {}, reads(), { repo: 'acme/other' })
      await step('食い違いの warnings と、repo で確かめた結果を比べる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['warnings']).toEqual(['using repo acme/other (current Git remote: acme/demo)'])
        expect(result.structured['dependabotAlerts']).toMatchObject({ alertsUrl: 'https://ghes.example.com/acme/other/security/dependabot' })
      })
    })

    it('remote の URL から owner/repo を読めず repo を渡すと、warnings に入れて続ける', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-21')
      await explains('`release_check` の remote の URL を解釈できない場合のテストです。`repo` を指定した場合に、警告を返して確認を続けることを確認します。')
      const result = await check(projectWithBareOrigin(), {}, reads(), { repo: 'acme/demo' })
      await step('続けた確認の warnings を確かめる', () => {
        expect(problemsOf(result)).toEqual([])
        expect(result.structured['warnings']).toEqual(['using repo acme/demo (could not read the repository from the URL of the Git remote origin)'])
      })
    })

    it('remote の URL から owner/repo を読めず repo を省くと、the repository is ambiguous と理由の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-21')
      await explains('`release_check` の remote の URL を解釈できない場合のテストです。`repo` を省略した場合に、`the repository is ambiguous` と理由の行を出力して終了コード 1 で終わることを確認します。')
      const result = await runRelease(projectWithBareOrigin(), { reads: reads() })
      await step('終了コード 1 と、ambiguous の標準エラーを比べる', () => {
        expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: the repository is ambiguous\n  could not read the repository from the URL of the Git remote origin\n  give repo: <owner/repo>\n' })
      })
    })

    it.for([
      { name: '対象のリポを含む設定が 2 つ以上あり、アクティブな設定がどれも指さない', options: { ...WITH_BRANCHES, extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false }, kind: 'no-active-project', detail: 'choose one with project: <NAME>' },
      { name: '対象のリポを含む設定が存在しない', options: { ...WITH_BRANCHES, isActive: false }, kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config' },
    ])('$name と、kind が $kind の失敗を返す', async ({ name, options, kind, detail }, context) => {
      await verifies(context, 'PW-RELEASE-CHECK-22')
      await explains(`\`release_check\` のプロジェクトの設定の選択のテストです。条件が「${name}」の場合に、\`kind\` が \`${kind}\` の失敗を返すことを確認します。`)
      const result = await check(project(options))
      await step('失敗の種別と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind } })
        expect(result.structured['detail']).toContain(detail)
      })
    })

    it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-22')
      await explains('`release_check` の `project` のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、`project` で指定した設定を使って確かめることを確認します。')
      const target = project({ ...WITH_BRANCHES, extraProjects: { second: [DEFAULT_REPOSITORY] }, hasActiveMark: false })
      const result = await check(target, {}, reads(), { project: 'second' })
      await step('problem が無いことを確かめる', () => {
        expect(problemsOf(result)).toEqual([])
      })
    })
  })

  describe('CLI の出力', () => {
    it('problem があると、項目ごとに引数と内容の行を標準出力に出し、終了コード 0 で終わる', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-01')
      await explains('`release_check` の CLI の出力のテストです。本文と名前が決まりから外れる場合は、項目ごとの `<引数>: <内容>` の行を出力し、終了コード 0 で終わることを確認します。')
      const target = project()
      const result = await runRelease(target, { params: releaseValues(target, { body: 'x', name: 'y' }), reads: reads() })
      await step('problem の行と終了コードを比べる', () => {
        expect(result).toEqual({ code: 0, stdout: 'params.body: body must be the CHANGELOG section of 0.2.0\nparams.name: the release name must be v0.2.0\n', stderr: '' })
      })
    })

    it('機能が無効で飛ばした確認と Dependabot の警告を、標準エラーに出す', async (context) => {
      await verifies(context, 'PW-RELEASE-CHECK-13')
      await explains('`release_check` の CLI の出力のテストです。code scanning が無効で Dependabot の alert が 1 件ある場合に、`skipped` と `warning` の行を標準エラーに出力することを確認します。')
      const target = project()
      const result = await runRelease(target, {
        params: releaseValues(target),
        reads: reads({ code_scanning_alerts: failed('code scanning is not enabled'), dependabot_alerts: openAlerts(7) }),
      })
      await step('標準エラーの skipped と warning の行を比べる', () => {
        expect(result).toEqual({
          code: 0,
          stdout: 'ok\n',
          stderr: `warning: 1 open Dependabot alert. The release is not blocked.\n  #7\n  → ${ALERTS_URL}\nskipped: code scanning (feature disabled)\n`,
        })
      })
    })
  })
})
