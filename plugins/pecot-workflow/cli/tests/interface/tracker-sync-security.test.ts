// tracker sync security の振る舞い（PW-TRACKER-SYNC-47〜90）を、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

import { TRACKER_COMMANDS } from '../../src/commands/tracker.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult } from '../_helpers/interface-case.js'
import {
  codeScanningAlert,
  createdBody,
  dependabotAlert,
  dependabotEntry,
  failure,
  graphqlOperations,
  issueList,
  listings,
  patchedTracker,
  restWrites,
  secretScanningAlert,
  secretScanningStatus,
  TODAY_TITLE,
  trackerBody,
  trackerEntry,
  trackerIssue,
  updatedBody,
  vulnerabilityAlertsEnabled,
} from '../_helpers/security-case.js'
import type { AlertResponses } from '../_helpers/security-case.js'
import { boardRules, createdTracker, freezeClock, graphqlServerError, missingTokenStderr, PRIORITY_FIELD, prepareSync, WORKFLOW_FIELD } from '../_helpers/tracker-sync-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function sync(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['tracker', 'sync', 'security', ...argv], TRACKER_COMMANDS)
}

const LIST_END = '<!-- pecot-alert: list-end -->'
const OLD_ROW = '| <!-- pecot-alert: dependabot/1 state=open priority=medium pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#1](u) | medium | pkg | 要判断 |'
const UPDATE_FIELD = 'UpdateProjectItemField'
const TRACKER_5 = '/repos/acme/demo/issues/5'

const ONE_DEPENDABOT: AlertResponses = { dependabot: [dependabotAlert(1)] }
const NO_ALERTS: AlertResponses = {}
// startCreating の alert から作る本文。期待値は Python の render_tracker_body で出した（同じ GHSA の Dependabot の 2 件は 1 行にまとまる）
const CREATED_BODY = [
  '<!-- pecot-alert: tracker -->',
  '',
  '<!-- pecot-alert: list-begin -->',
  '## Dependabot',
  '',
  '| title | alert | Priority |',
  '|---|---|---|',
  '| <!-- pecot-alert: dependabot/1 priority=low pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> <!-- pecot-alert: dependabot/2 priority=high pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> [GHSA-aaaa-bbbb-cccc](https://ghes.example.com/advisories/GHSA-aaaa-bbbb-cccc) | [#1](https://ghes.example.com/acme/demo/security/dependabot/1) [#2](https://ghes.example.com/acme/demo/security/dependabot/2) | high |',
  '',
  '## code scanning',
  '',
  '| title | alert | Priority |',
  '|---|---|---|',
  '| <!-- pecot-alert: code-scanning/10 priority=high --> masked | [#10](https://ghes.example.com/acme/demo/security/code-scanning/10) | high |',
  '',
  '## secret scanning',
  '',
  'none',
  '<!-- pecot-alert: list-end -->',
  '',
].join('\n')
const BODY_WITH_ONE = trackerBody(dependabotEntry(1))

// 古い形式の行を 1 行持つ本文。行の足し外しは無く、本文だけが変わる
const OLD_FORMAT_BODY = trackerBody().replace(LIST_END, () => `${OLD_ROW}\n${LIST_END}`)

// 既存の Tracker #5 を書き直す一連の応答。priority は行の最大の Priority（行が無ければ undefined）
function existing(responses: Readonly<AlertResponses>, body: string, priority: string | undefined): ResponseRule[] {
  return [...listings(responses, [trackerIssue(5, body)]), patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true, priority })]
}

// 新しい Tracker #12 を作る一連の応答（Priority は high）
function creating(responses: Readonly<AlertResponses>): ResponseRule[] {
  return [...listings(responses, []), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false, priority: 'high' })]
}

function fieldUpdates(requests: readonly RecordedRequest[]): unknown[] {
  return requests.filter(request => request.type === 'graphql' && request.operation === UPDATE_FIELD).map(request => request.type === 'graphql' ? request.variables : undefined)
}

function restPaths(requests: readonly RecordedRequest[]): string[] {
  return restWrites(requests).map(request => request.type === 'rest' ? request.path : '')
}

async function startCreating(): Promise<Awaited<ReturnType<typeof startGithub>>> {
  freezeClock()
  prepareSync()
  const responses: AlertResponses = { dependabot: [dependabotAlert(1, 'low'), dependabotAlert(2, 'high')], codeScanning: [codeScanningAlert(10)] }
  return await startGithub(creating(responses))
}

// secret scanning が 500 で、Tracker には secret scanning の行 #1 がある。Dependabot の #1 は足される
function failedSecret(body: string): ResponseRule[] {
  return existing({ ...ONE_DEPENDABOT, secretScanningFailure: failure(500, 'boom') }, body, 'medium')
}

const SECRET_ROW_BODY = trackerBody(trackerEntry('secret-scanning', 1))

// secret scanning の一覧が 404 になり、リポジトリの状態を確かめる。Tracker には secret scanning の行 #1 がある
function secretNotFound(status: string, alerts: Readonly<AlertResponses>, extra: readonly ResponseRule[]): ResponseRule[] {
  const responses: AlertResponses = { ...alerts, secretScanningFailure: failure(404, 'Not Found') }
  return [...listings(responses, [trackerIssue(5, SECRET_ROW_BODY)]), secretScanningStatus(status), ...extra]
}

async function boardUpdates(filled: readonly string[]): Promise<unknown[]> {
  prepareSync()
  const issues = [trackerIssue(5, BODY_WITH_ONE)]
  const github = await startGithub([...listings(ONE_DEPENDABOT, issues), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium', filled })])
  const result = await sync()
  expect(result.code).toBe(0)
  return fieldUpdates(github.requests())
}

// 番号がいちばん小さい、印の無い open の Issue（label は security-alert）を含む
const SEVERAL_TRACKERS = [trackerIssue(9, trackerBody()), trackerIssue(5, trackerBody()), trackerIssue(3, 'マーカーの無い本文')]

function severalTrackers(): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, SEVERAL_TRACKERS), patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium' })]
}

function sameBody(body: string): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, [trackerIssue(5, body)]), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium' })]
}

const GONE_BODY = trackerBody(dependabotEntry(1), trackerEntry('code-scanning', 2), trackerEntry('secret-scanning', 3))

function failingUpdate(): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, [trackerIssue(5, trackerBody())]), patchedTracker(5, 422), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium' })]
}

async function withoutToken(): Promise<{ readonly result: CliResult, readonly root: string }> {
  const project = prepareSync()
  await startGithub([])
  setEnvironment({ [project.tokenVariable]: undefined })
  return { result: await sync('--dry-run'), root: project.root }
}

function unlistable(): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, []).slice(0, 3), issueList([], 500)]
}

function brokenMarkers(): ResponseRule[] {
  const broken = trackerBody().replace(LIST_END, '')
  return listings(ONE_DEPENDABOT, [trackerIssue(5, broken)])
}

describe('tracker sync', () => {
  describe('Tracker を作る', () => {
    it('open の Tracker が無く、載せる alert があると、label が security-alert の Tracker の Issue を作る', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-47')
      const github = await startCreating()
      const result = await sync()
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
      expect(createdBody(github.requests())).toEqual({ title: TODAY_TITLE, body: CREATED_BODY, labels: ['security-alert'] })
      const lines = result.stderr.split('\n')
      expect(lines[0]).toBe(`created: Tracker "${TODAY_TITLE}" with priority high`)
      expect(lines.slice(1)).toEqual(['added: dependabot #1 to new Tracker', 'added: dependabot #2 to new Tracker', 'added: code-scanning #10 to new Tracker', ''])
    })

    it('Tracker の Issue を作ると、ボードに足す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-48')
      const github = await startCreating()
      await sync()
      expect(graphqlOperations(github.requests())).toEqual(['GetIssueNodeId', 'AddToProject', UPDATE_FIELD, UPDATE_FIELD])
    })

    it('Tracker の Issue を作ると、Status を Backlog にする', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-49')
      const github = await startCreating()
      await sync()
      expect(fieldUpdates(github.requests())).toContainEqual({ projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'PVTSSF_workflow', optionId: 'o1' })
    })

    it('Tracker の Issue を作ると、Priority を行の最大にする', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-50')
      const github = await startCreating()
      await sync()
      expect(fieldUpdates(github.requests())).toContainEqual({ projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'PVTSSF_priority', optionId: 'p1' })
    })

    it('open の Tracker が無く、載せる alert も無いと、Tracker の Issue を作らない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-51')
      prepareSync()
      const github = await startGithub(listings(NO_ALERTS, []))
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('open の Tracker が無く、載せる alert も無いと、skipped の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-52')
      prepareSync()
      await startGithub(listings(NO_ALERTS, []))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'skipped: Tracker creation\n' })
    })

    it('閉じた Tracker は使い回さない', async () => {
      freezeClock()
      prepareSync()
      const closed = [trackerIssue(5, trackerBody(), 'closed')]
      const github = await startGithub([...listings(ONE_DEPENDABOT, closed), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false, priority: 'medium' })])
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restPaths(github.requests())).toEqual(['/repos/acme/demo/issues'])
    })

    it('Tracker の作成が失敗すると、Tracker の error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-89')
      freezeClock()
      prepareSync()
      await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12, 502)])
      const result = await sync()
      expect(result.stderr).toBe('error: Tracker: GitHub API error: 502\n')
    })

    it('ボードへの追加が失敗すると、Tracker の error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-89')
      freezeClock()
      prepareSync()
      const github = await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false, priority: 'medium', failsToAdd: true })])
      const result = await sync()
      expect(result.stderr).toBe(`created: Tracker "${TODAY_TITLE}" with priority medium\nadded: dependabot #1 to new Tracker\nerror: Tracker: ${graphqlServerError(github.url, '502 Bad Gateway')}\n`)
    })

    it('Tracker の作成に失敗すると、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-90')
      freezeClock()
      prepareSync()
      await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12, 502)])
      const result = await sync()
      expect(result.code).toBe(1)
    })

    it('ボードへの追加に失敗すると、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-90')
      freezeClock()
      prepareSync()
      await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(13), ...boardRules(13, { onlyIfEmpty: false, priority: 'medium', failsToAdd: true })])
      const result = await sync()
      expect(result.code).toBe(1)
    })
  })

  describe('Tracker の本文を書き直す', () => {
    it('open の Tracker があると、list-begin と list-end の間を、Dependabot・code scanning・secret scanning の見出しと表に書き直す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-53')
      prepareSync()
      const outside = '\nこの文は残す\n'
      const responses: AlertResponses = { dependabot: [dependabotAlert(1), dependabotAlert(2)], codeScanning: [codeScanningAlert(3)], secretScanning: [secretScanningAlert(4)] }
      const github = await startGithub(existing(responses, BODY_WITH_ONE + outside, 'high'))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      const headings = ['## Dependabot\n\n| title | alert | Priority |', '## code scanning\n\n| title | alert | Priority |', '## secret scanning\n\n| title | alert | Priority |']
      const positions = headings.map(heading => body.indexOf(heading))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect(positions).toEqual(positions.toSorted((a, b) => a - b))
      expect(body.endsWith(outside)).toBe(true)
    })

    it('表に alert を足すと、added の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-54')
      prepareSync()
      await startGithub(existing({ dependabot: [dependabotAlert(1), dependabotAlert(2)] }, BODY_WITH_ONE, 'medium'))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: dependabot #2 to Tracker #5\n' })
    })

    it('表から alert を外すと、removed の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-55')
      prepareSync()
      const body = trackerBody(dependabotEntry(1), trackerEntry('code-scanning', 9))
      const github = await startGithub(existing(ONE_DEPENDABOT, body, 'medium'))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: code-scanning #9 from Tracker #5\n' })
      expect(updatedBody(github.requests(), 5)).not.toContain('pecot-alert: code-scanning/9')
    })

    it('行の足し外しが無く本文だけが変わると、本文を書き直す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-56')
      prepareSync()
      const github = await startGithub(existing(ONE_DEPENDABOT, OLD_FORMAT_BODY, 'medium'))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('pecot-alert: dependabot/1')
      expect(body).not.toContain('state=open')
    })

    it('行の足し外しが無く本文だけが変わると、updated の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-57')
      prepareSync()
      await startGithub(existing(ONE_DEPENDABOT, OLD_FORMAT_BODY, 'medium'))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: Tracker #5 body\n' })
    })

    it('書き直した本文が今の本文と同じだと、本文を書き直さない（改行が CRLF でも同じとみなす）', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-58')
      prepareSync()
      const github = await startGithub(sameBody(BODY_WITH_ONE.replaceAll('\n', '\r\n')))
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('書き直した本文が今の本文と同じだと、unchanged の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-59')
      prepareSync()
      await startGithub(sameBody(BODY_WITH_ONE))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: Tracker #5\n' })
    })

    it('open の alert がすべて無くなると、各種類の見出しの下に none を書く', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-60')
      prepareSync()
      const github = await startGithub(existing(NO_ALERTS, GONE_BODY, undefined))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      for (const heading of ['Dependabot', 'code scanning', 'secret scanning']) expect(body).toContain(`## ${heading}\n\nnone`)
    })

    it('open の alert がすべて無くなると、Tracker を閉じない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-61')
      prepareSync()
      const github = await startGithub(existing(NO_ALERTS, GONE_BODY, undefined))
      await sync()
      const writes = restWrites(github.requests())
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ method: 'PATCH', path: TRACKER_5 })
      expect(JSON.stringify(writes[0])).not.toContain('closed')
    })

    it('code scanning と secret scanning の行を書くと、title を masked にする', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-62')
      freezeClock()
      prepareSync()
      const github = await startGithub(creating({ codeScanning: [codeScanningAlert(10)], secretScanning: [secretScanningAlert(11)] }))
      await sync()
      const body = String(createdBody(github.requests())?.['body'])
      const rows = body.split('\n').filter(line => line.includes('pecot-alert: code-scanning/') || line.includes('pecot-alert: secret-scanning/'))
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row).toContain('--> masked |')
      expect(body).not.toContain('js/xss')
    })

    it('機能が無効の種類があると、その見出しの下に disabled を書き、行を足さない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-63')
      prepareSync()
      const github = await startGithub(secretNotFound('disabled', ONE_DEPENDABOT, [patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium' })]))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('## secret scanning\n\ndisabled')
      expect(body).not.toContain('pecot-alert: secret-scanning/')
    })

    it('機能が無効の種類があると、skipped の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-64')
      prepareSync()
      await startGithub(secretNotFound('disabled', ONE_DEPENDABOT, [patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true, priority: 'medium' })]))
      const result = await sync()
      expect(result.stderr).toBe('skipped: secret scanning alerts (feature disabled)\nadded: dependabot #1 to Tracker #5\nremoved: secret-scanning #1 from Tracker #5\n')
    })

    it('code scanning の解析が無いリポジトリだと、code scanning の alert を 0 件として扱う', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-65')
      prepareSync()
      const responses: AlertResponses = { codeScanningFailure: failure(404, 'no analysis found') }
      const body = trackerBody(trackerEntry('code-scanning', 9))
      const github = await startGithub(existing(responses, body, undefined))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: code-scanning #9 from Tracker #5\n' })
      expect(updatedBody(github.requests(), 5)).toContain('## code scanning\n\nnone')
    })

    it('既存の Tracker の Status か Priority が空だと、空の欄だけに Backlog か行の最大の Priority を入れる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-66')
      const workflow = { projectId: 'PVT_1', itemId: 'PVTI_5', fieldId: 'PVTSSF_workflow', optionId: 'o1' }
      const priority = { projectId: 'PVT_1', itemId: 'PVTI_5', fieldId: 'PVTSSF_priority', optionId: 'p2' }
      expect(await boardUpdates([])).toEqual([workflow, priority])
      expect(await boardUpdates([WORKFLOW_FIELD])).toEqual([priority])
      expect(await boardUpdates([WORKFLOW_FIELD, PRIORITY_FIELD])).toEqual([])
    })

    it('open の Tracker が複数あると、番号が最小のものを使う', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-67')
      prepareSync()
      const github = await startGithub(severalTrackers())
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restPaths(github.requests())).toEqual([TRACKER_5])
    })

    it('open の Tracker が複数あると、使わないものを閉じない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-68')
      prepareSync()
      const github = await startGithub(severalTrackers())
      await sync()
      expect(restPaths(github.requests())).not.toContain('/repos/acme/demo/issues/9')
    })

    it('open の Tracker が複数あると、warning の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-69')
      prepareSync()
      await startGithub(severalTrackers())
      const result = await sync()
      expect(result.stderr).toBe('warning: multiple open Trackers; using #5 (lowest number) and leaving #9 open\nadded: dependabot #1 to Tracker #5\n')
    })

    it('Tracker の本文の書き直しに失敗したなら、error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-87')
      prepareSync()
      await startGithub(failingUpdate())
      const result = await sync()
      expect(result.stderr).toBe('error: could not update Tracker #5 body: GitHub API error: 422\n')
    })

    it('Tracker の本文の書き直しに失敗したなら、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-88')
      prepareSync()
      await startGithub(failingUpdate())
      const result = await sync()
      expect(result.code).toBe(1)
    })
  })

  describe('--dry-run', () => {
    // 書き込みの応答を持たない。書き込みの要求があれば、表に無い要求としてテストが落ちる
    const responses: AlertResponses = { dependabot: [dependabotAlert(1, 'high')], codeScanning: [codeScanningAlert(10)] }

    it('GitHub への書き込みをしない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-70')
      freezeClock()
      prepareSync()
      const github = await startGithub(listings(responses, []))
      const result = await sync('--dry-run')
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
      expect(graphqlOperations(github.requests())).toEqual([])
    })

    it('予定の行を標準エラーに出す（Tracker を作る場合）', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-71')
      freezeClock()
      prepareSync()
      await startGithub(listings(responses, []))
      const result = await sync('--dry-run')
      const lines = [`dry-run: would create Tracker "${TODAY_TITLE}" with priority high`, 'dry-run: would add dependabot #1 to new Tracker', 'dry-run: would add code-scanning #10 to new Tracker', '']
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(lines.join('\n'))
    })

    it('予定の行を標準エラーに出す（既存の Tracker を書き直す場合）', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-71')
      prepareSync()
      const body = trackerBody(dependabotEntry(2), trackerEntry('code-scanning', 9))
      await startGithub(listings({ dependabot: [dependabotAlert(2), dependabotAlert(3)] }, [trackerIssue(5, body)]))
      const result = await sync('--dry-run')
      expect(result.stderr).toBe('dry-run: would add dependabot #3 to Tracker #5\ndry-run: would remove code-scanning #9 from Tracker #5\n')
    })
  })

  describe('実行できない', () => {
    it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-72')
      prepareSync({ hasConfig: false })
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
      expect(github.requests()).toEqual([])
    })

    it('--repo を省いて git の remote のリポジトリを読めないと、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-73')
      prepareSync({ hasRemote: false })
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not read the repository from the git remote\n' })
      expect(github.requests()).toEqual([])
    })

    it('GitHub のトークンが見つからないと、error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-74')
      const { result, root } = await withoutToken()
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(missingTokenStderr(root))
    })

    it('GitHub のトークンが見つからないと、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-75')
      const { result } = await withoutToken()
      expect(result.code).toBe(1)
    })
  })

  describe('ある種類の alert の一覧を取れない', () => {
    it('その種類の前の行を残す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-76')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      await sync()
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('## secret scanning\n\n| title')
      expect(body).toContain('pecot-alert: secret-scanning/1 ')
    })

    it('前の行も無いと、見出しの下に unavailable を書く', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-77')
      prepareSync()
      const github = await startGithub(failedSecret(trackerBody()))
      await sync()
      expect(updatedBody(github.requests(), 5)).toContain('## secret scanning\n\nunavailable')
    })

    it('その種類を触らない旨の error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-78')
      prepareSync()
      await startGithub(failedSecret(SECRET_ROW_BODY))
      const result = await sync()
      expect(result.stderr).toBe('error: could not list secret scanning alerts (leaving its rows untouched): acme/demo: secret scanning: GitHub API error: 500 boom\nadded: dependabot #1 to Tracker #5\n')
    })

    it('ほかの種類を書き直す', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-79')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      await sync()
      expect(updatedBody(github.requests(), 5)).toContain('pecot-alert: dependabot/1 ')
    })

    it('ほかの種類を書き直した後に終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-80')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(restPaths(github.requests())).toEqual([TRACKER_5])
      expect(result.stderr).toContain('added: dependabot #1 to Tracker #5\n')
    })

    it('Tracker が無く、取れなかった種類しか無いと、Tracker を作らず終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-80')
      prepareSync()
      const github = await startGithub(listings({ dependabotFailure: failure(500, 'boom') }, []))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('Dependabot alert が有効なのに一覧を 403 で取れないと、その種類を取れなかったものとして扱う', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-81')
      prepareSync()
      await startGithub([...listings({ dependabotFailure: failure(403, 'Resource not accessible by integration') }, []), vulnerabilityAlertsEnabled()])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: could not list Dependabot alerts (leaving its rows untouched): acme/demo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)\nskipped: Tracker creation\n')
    })

    it('secret scanning の一覧を 404 で取れず、無効とも確かめられないと、その種類を取れなかったものとして扱う', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-82')
      prepareSync()
      const github = await startGithub(secretNotFound('enabled', NO_ALERTS, boardRules(5, { onlyIfEmpty: true, priority: 'medium' })))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: could not list secret scanning alerts (leaving its rows untouched): acme/demo: cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)\nunchanged: Tracker #5\n')
      expect(restWrites(github.requests())).toEqual([])
    })
  })

  describe('Issue の一覧を取れない', () => {
    it('何も書かない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-83')
      prepareSync()
      const github = await startGithub(unlistable())
      const result = await sync()
      expect(result.stderr).toBe('error: could not list issues: GitHub API error: 500\n')
      expect(restWrites(github.requests())).toEqual([])
      expect(graphqlOperations(github.requests())).toEqual([])
    })

    it('終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-84')
      prepareSync()
      await startGithub(unlistable())
      const result = await sync()
      expect(result.code).toBe(1)
    })
  })

  describe('使う Tracker の本文に list-begin と list-end の印が 1 組だけ無い', () => {
    it('何も書かない', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-85')
      prepareSync()
      const github = await startGithub(brokenMarkers())
      const result = await sync()
      expect(result.stderr).toBe('error: Tracker #5: cannot rewrite the list: the Tracker body does not have exactly one pair of list-begin / list-end markers\n')
      expect(restWrites(github.requests())).toEqual([])
      expect(graphqlOperations(github.requests())).toEqual([])
    })

    it('終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-86')
      prepareSync()
      await startGithub(brokenMarkers())
      const result = await sync()
      expect(result.code).toBe(1)
    })
  })
  describe('source が使えない', () => {
    it('source を省くと、使い方の誤りとして終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-91')
      const result = await runInProcess(['tracker', 'sync'], TRACKER_COMMANDS)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Missing argument \'source\'.')
    })

    it('dependabot でも security でもない値を渡すと、使い方の誤りとして終了コード 2 で終わる', async (context) => {
      await verifies(context, 'PW-TRACKER-SYNC-92')
      const result = await runInProcess(['tracker', 'sync', 'foo'], TRACKER_COMMANDS)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Invalid value for \'source\': \'foo\' is not one of \'dependabot\', \'security\'.')
    })
  })
})
