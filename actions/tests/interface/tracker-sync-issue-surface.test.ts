// tracker-sync の source issue-surface（PA-TRACKER-SYNC-100〜113）を、action の処理をプロセス内で呼んで確かめる。
// GitHub は偽サーバにし、公開スキーマと OpenAPI の取得は fetch を差し替える。
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SURFACE_LABEL } from '@pecot/workflow-core/domain/issue-surface-tracker.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import { startGithub, writeFiles } from '../_helpers/action-case.js'
import type { ActionResult } from '../_helpers/action-case.js'
import { boardRules, createdTracker, freezeClock, issueListRule, prepareSync, runSync, WORKFLOW_FIELD } from '../_helpers/tracker-sync-case.js'
import {
  ADDED,
  ADDED_B,
  bodyOf,
  CHANGED,
  ISSUES_PATH,
  patched,
  REST_URL,
  restWrites,
  SNAPSHOT,
  stubSchemas,
  SURFACE_FILE,
  TODAY_TITLE,
  trackerIssue,
  trackers,
} from '../_helpers/tracker-sync-issue-surface-case.js'
import { GRAPHQL_SCHEMA_URL } from '../../src/infra/issue-surface.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

afterEach(() => {
  vi.unstubAllGlobals()
})

async function sync(inputs: Readonly<Record<string, string | undefined>> = {}): Promise<ActionResult> {
  return await runSync('issue-surface', { 'surface-file': SURFACE_FILE, ...inputs })
}

describe('tracker sync', () => {
  describe('issue-surface の今のスキーマを取る', () => {
    it('呼ぶと、公開スキーマの SDL と、DEFAULT_API_VERSION の版の OpenAPI を取る', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-100')
      await explains('`issue-surface` の今のスキーマの取得のテストです。公開スキーマの SDL と、`DEFAULT_API_VERSION` の版の OpenAPI の 2 つの URL だけを取りに行くことを確認します。')
      prepareSync()
      const requested = stubSchemas(SNAPSHOT.items)
      await startGithub([trackers()])
      const result = await sync()
      expect(result.code).toBe(0)
      expect(requested).toHaveLength(2)
      expect(new Set(requested)).toEqual(new Set([GRAPHQL_SCHEMA_URL, REST_URL]))
    })

    it('写しの REST の版が、pecot が REST に送る DEFAULT_API_VERSION と同じ', async () => {
      await explains('写しに記録した REST API の版のテストです。写しの `rest_api_version` が、pecot が REST の呼び出しに使う `DEFAULT_API_VERSION` と一致することを確認します。')
      expect(SNAPSHOT.sources.rest_api_version).toBe(DEFAULT_API_VERSION)
    })
  })

  describe('issue-surface の Tracker を作る', () => {
    it('差があって開いた Tracker が無いと、ラベル付きの Tracker を作ってボードの Backlog に載せる', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-101')
      await explains('写しとの差があり、開いた Tracker が存在しない場合のテストです。ラベル `issue-surface` を付けた Tracker を、差の項目を本文に含めて作成し、ボードに足して `created` の行を出力することを確認します。')
      freezeClock()
      prepareSync()
      stubSchemas(CHANGED)
      const listing = trackers(trackerIssue(3, bodyOf(CHANGED), 'closed'))
      const github = await startGithub([listing, createdTracker(12), ...boardRules(12, { onlyIfEmpty: false })])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: `created: Tracker "${TODAY_TITLE}"\n` })
      const [created] = restWrites(github.requests())
      expect(created).toMatchObject({ method: 'POST', path: ISSUES_PATH, body: { title: TODAY_TITLE, body: bodyOf(CHANGED), labels: [SURFACE_LABEL] } })
      expect(JSON.stringify(created)).toContain(`- \`${ADDED}\``)
    })

    it('差がなく開いた Tracker も無いと、Tracker を作らずに skipped の行を出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-102')
      await explains('写しとの差がなく、開いた Tracker も存在しない場合のテストです。Tracker を作成せず、`skipped: Tracker creation` を出力することを確認します。')
      prepareSync()
      stubSchemas(SNAPSHOT.items)
      const github = await startGithub([trackers()])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'skipped: Tracker creation\n' })
      expect(restWrites(github.requests())).toEqual([])
    })

    it('作成した Tracker のボードの列を設定できないと、error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-113')
      await explains('作成した Tracker のボード上の Status を設定できない場合のテストです。`error: could not set status backlog of Tracker #12` を出力して、終了コード 1 で step を失敗にすることを確認します。')
      freezeClock()
      prepareSync()
      stubSchemas(CHANGED)
      const rules = boardRules(12, { onlyIfEmpty: false }).filter(rule => rule.match.operation !== 'UpdateProjectItemField')
      await startGithub([
        trackers(),
        createdTracker(12),
        ...rules,
        { match: { operation: 'UpdateProjectItemField', variables: { fieldId: WORKFLOW_FIELD } }, respond: { status: 200, body: { errors: [{ message: 'boom' }] } }, times: 1 },
      ])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/error: could not set status backlog of Tracker #12:/u)
    })

    it('Tracker の作成が失敗すると、Tracker の error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-113')
      await explains('Tracker の作成が失敗した場合のテストです。`error: Tracker: GitHub API error: 502` の行を出力して、終了コード 1 で step を失敗にすることを確認します。')
      freezeClock()
      prepareSync()
      stubSchemas(CHANGED)
      await startGithub([trackers(), createdTracker(12, 502)])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: `error: Tracker: GitHub API error: 502\n` })
    })
  })

  describe('issue-surface の Tracker を書き直す', () => {
    it('差が変わると、開いた Tracker の本文の一覧の部分だけを書き換え、前後の文を残す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-103')
      await explains('開いた Tracker の本文に人の追記を含む状態で、差の内容が変わった場合のテストです。差の一覧の部分だけを書き換え、追記した文を残して本文を更新することを確認します。')
      prepareSync()
      const changed = [...CHANGED, ADDED_B]
      stubSchemas(changed)
      const existing = `人が足した文。\n\n${bodyOf(CHANGED)}`
      const expected = bodyOf(changed, existing)
      const github = await startGithub([trackers(trackerIssue(5, existing)), patched({ body: expected }), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: Tracker #5 body\n' })
      expect(expected).toContain('人が足した文。')
      expect(expected).toContain(`- \`${ADDED_B}\``)
      expect(restWrites(github.requests())).toHaveLength(1)
    })

    it('開いた Tracker の本文の一覧が現在の差と同じだと、本文を更新せずに unchanged の行を出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-104')
      await explains('開いた Tracker の本文に記載した差の一覧が、現在の差と同じ場合のテストです。本文を更新せず、`unchanged: Tracker #5` を出力することを確認します。')
      prepareSync()
      stubSchemas(CHANGED)
      const tracker = trackerIssue(5, bodyOf(CHANGED))
      const github = await startGithub([trackers(tracker), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: Tracker #5\n' })
      expect(restWrites(github.requests())).toEqual([])
    })

    it('差がなくなると、開いた Tracker の本文の一覧を none に書き換えてから閉じる', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-105')
      await explains('写しとの差がなくなった場合のテストです。開いた Tracker の本文の一覧を `none` に書き換えてから、その Tracker を `completed` として閉じることを確認します。')
      prepareSync()
      stubSchemas(SNAPSHOT.items)
      const existing = bodyOf(CHANGED)
      const github = await startGithub([trackers(trackerIssue(5, existing)), patched({ body: bodyOf(SNAPSHOT.items, existing) }), patched({ state: 'closed', state_reason: 'completed' })])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: Tracker #5 body\nclosed: Tracker #5\n' })
      expect(restWrites(github.requests())).toHaveLength(2)
    })

    it('開いた Tracker が 2 件以上あると、番号が最も小さいものを対象にし、ほかを警告に挙げる', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-106')
      await explains('開いた Tracker が 3 件ある場合のテストです。番号が最も小さい `#5` を対象にし、ほかの `#7` と `#9` を開いたままにして、警告を出力することを確認します。')
      prepareSync()
      stubSchemas(CHANGED)
      const body = bodyOf(CHANGED)
      const github = await startGithub([trackers(trackerIssue(9, body), trackerIssue(5, body), trackerIssue(7, body)), ...boardRules(5, { onlyIfEmpty: true, filled: [WORKFLOW_FIELD] })])
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'warning: multiple open Trackers; using #5 (lowest number) and leaving #7, #9 open\nunchanged: Tracker #5\n' })
      expect(restWrites(github.requests())).toEqual([])
    })

    it('開いた Tracker の本文で一覧の範囲を示すコメントが 1 組そろっていないと、書き込まずに error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-112')
      await explains('開いた Tracker の本文で、一覧の範囲を示すコメントが 1 組そろっていない場合のテストです。書き込みを行わずに、`error: Tracker #5: cannot rewrite the list` で始まる行を出力して、終了コード 1 で step を失敗にすることを確認します。')
      prepareSync()
      stubSchemas(CHANGED)
      const github = await startGithub([trackers(trackerIssue(5, '<!-- pecot-issue-surface: tracker -->\n'))])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: Tracker #5: cannot rewrite the list/u)
      expect(restWrites(github.requests())).toEqual([])
    })
  })

  describe('issue-surface の dry-run', () => {
    it('作成するときは、書き込まずに作成の予定の行を出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-107')
      await explains('`dry-run` を `true` にして、Tracker を作成する場合のテストです。書き込みを行わず、`dry-run: would create Tracker` の行を出力することを確認します。')
      freezeClock()
      prepareSync()
      stubSchemas(CHANGED)
      const github = await startGithub([trackers()])
      const result = await sync({ 'dry-run': 'true' })
      expect(result).toEqual({ code: 0, stdout: '', stderr: `dry-run: would create Tracker "${TODAY_TITLE}"\n` })
      expect(restWrites(github.requests())).toEqual([])
    })

    it('差がなくなったときは、書き込まずに更新と閉じる予定の行を出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-107')
      await explains('`dry-run` を `true` にして、写しとの差がなくなった場合のテストです。書き込みを行わず、本文の更新と Tracker を閉じる予定の行を出力することを確認します。')
      prepareSync()
      stubSchemas(SNAPSHOT.items)
      const tracker = trackerIssue(5, bodyOf(CHANGED))
      const github = await startGithub([trackers(tracker)])
      const result = await sync({ 'dry-run': 'true' })
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'dry-run: would update Tracker #5 body\ndry-run: would close Tracker #5\n' })
      expect(restWrites(github.requests())).toEqual([])
    })
  })

  describe('issue-surface の入力と読み込みの失敗', () => {
    it('surface-file を省くと、GitHub とスキーマの取得先を呼ばずに、入力の誤りとして終了コード 2 で step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-108')
      await explains('`source` が `issue-surface` で、input の `surface-file` を省いた場合のテストです。GitHub とスキーマの取得先を呼び出さず、項目 `surface_file` を示す入力の誤りとして終了コード 2 で step を失敗にすることを確認します。')
      prepareSync()
      const requested = stubSchemas(SNAPSHOT.items)
      const github = await startGithub([])
      const result = await sync({ 'surface-file': undefined })
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/^error: invalid input: .*surface-file is required when source is issue-surface\n {2}→ at surface_file\n$/su)
      expect(requested).toEqual([])
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: '存在しない', files: {}, pattern: /^error: could not read surface-file .*missing\.json: /u },
      { name: 'JSON でない', files: { 'missing.json': '{' }, pattern: /^error: surface-file .*missing\.json is not an issue surface: /u },
      { name: '写しの形でない', files: { 'missing.json': '{"items":[]}' }, pattern: /^error: surface-file .*missing\.json is not an issue surface: /u },
    ])('surface-file が$name と、スキーマを取らずに error の行を出して step を失敗にする', async ({ files, pattern }, context) => {
      await verifies(context, 'PA-TRACKER-SYNC-109')
      await explains('input の `surface-file` を読めない場合と、写しの形でない場合のテストです。スキーマの取得先と GitHub を呼び出さず、`error` の行を出力して終了コード 1 で step を失敗にすることを確認します。')
      prepareSync()
      const requested = stubSchemas(SNAPSHOT.items)
      const github = await startGithub([])
      const result = await sync({ 'surface-file': path.join(writeFiles(files), 'missing.json') })
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(pattern)
      expect(requested).toEqual([])
      expect(github.requests()).toEqual([])
    })

    it('OpenAPI の取得先が 503 を返すと、Tracker を探さずに error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-110')
      await explains('今のスキーマの取得先がエラーを返す場合のテストです。OpenAPI の取得先が 503 を返したときに、Tracker を検索せず、URL と状態を含む `error` の行を出力して終了コード 1 で step を失敗にすることを確認します。')
      prepareSync()
      stubSchemas(SNAPSHOT.items, new Map([[REST_URL, new Response('', { status: 503, statusText: 'Service Unavailable' })]]))
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: `error: could not read the current GitHub schema: GET ${REST_URL} failed: 503 Service Unavailable\n` })
      expect(github.requests()).toEqual([])
    })

    it('SDL の構文が誤っていると、Tracker を探さずに error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-110')
      await explains('公開スキーマの SDL の構文が誤っている場合のテストです。Tracker を検索せず、`Syntax Error` を含む `error` の行を出力して終了コード 1 で step を失敗にすることを確認します。')
      prepareSync()
      stubSchemas(SNAPSHOT.items, new Map([[GRAPHQL_SCHEMA_URL, new Response('input {')]]))
      const github = await startGithub([])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: could not read the current GitHub schema: Syntax Error/u)
      expect(github.requests()).toEqual([])
    })

    it('Tracker を検索できないと、error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-111')
      await explains('Tracker の検索が失敗する（HTTP 500 を返す）場合のテストです。`error: could not list issues:` で始まる行を出力して、終了コード 1 で step を失敗にすることを確認します。')
      prepareSync()
      stubSchemas(CHANGED)
      await startGithub([issueListRule(SURFACE_LABEL, [], 500)])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: could not list issues: /u)
    })

    it('ボードの設定が見つからないと、スキーマと Tracker を取らずに error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-95')
      await explains('対象のリポジトリ（`acme/demo`）がボードの設定に存在しない場合の、`issue-surface` のテストです。スキーマの取得先と GitHub へ要求を送らず、`error:` で始まる行を出力して、終了コード 1 で step を失敗にすることを確認します。')
      prepareSync({ repositories: ['other'] })
      const requested = stubSchemas(CHANGED)
      const github = await startGithub([])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: /u)
      expect(requested).toEqual([])
      expect(github.requests()).toEqual([])
    })
  })
})
