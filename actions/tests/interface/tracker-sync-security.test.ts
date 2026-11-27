// tracker-sync の source security と、source の入力の振る舞い（PA-TRACKER-SYNC-47〜99）を、action の処理をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { startGithub } from '../_helpers/action-case.js'
import type { ActionResult } from '../_helpers/action-case.js'
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
} from '../_helpers/tracker-sync-security-case.js'
import type { AlertResponses } from '../_helpers/tracker-sync-security-case.js'
import { boardRules, createdTracker, freezeClock, graphqlServerError, missingTokenStderr, prepareSync, runSync, STALE_OPTION_TEXT, staleOptionUpdate, TOKEN_VARIABLE, WORKFLOW_FIELD } from '../_helpers/tracker-sync-case.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function sync(inputs: Readonly<Record<string, string>> = {}): Promise<ActionResult> {
  return await runSync('security', inputs)
}

const LIST_END = '<!-- pecot-alert: list-end -->'
const OLD_ROW = '| <!-- pecot-alert: dependabot/1 state=open priority=medium pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#1](u) | medium | pkg | 要判断 |'
const UPDATE_FIELD = 'UpdateProjectItemField'
const TRACKER_5 = '/repos/acme/demo/issues/5'

const ONE_DEPENDABOT: AlertResponses = { dependabot: [dependabotAlert(1)] }
const NO_ALERTS: AlertResponses = {}
// startCreating の alert から作る本文（同じ GHSA の Dependabot の 2 件は 1 行にまとまる）
const CREATED_BODY = [
  '<!-- pecot-alert: tracker -->',
  '',
  '<!-- pecot-alert: list-begin -->',
  '## Dependabot',
  '',
  '| title | alert | Severity |',
  '|---|---|---|',
  '| <!-- pecot-alert: dependabot/1 severity=low pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> <!-- pecot-alert: dependabot/2 severity=high pkg=pkg ghsa=GHSA-aaaa-bbbb-cccc --> [GHSA-aaaa-bbbb-cccc](https://ghes.example.com/advisories/GHSA-aaaa-bbbb-cccc) | [#1](https://ghes.example.com/acme/demo/security/dependabot/1) [#2](https://ghes.example.com/acme/demo/security/dependabot/2) | high |',
  '',
  '## code scanning',
  '',
  '| title | alert | Severity |',
  '|---|---|---|',
  '| <!-- pecot-alert: code-scanning/10 severity=error --> masked | [#10](https://ghes.example.com/acme/demo/security/code-scanning/10) | error |',
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

// 既存の Tracker #5 を書き直す一連の応答
function existing(responses: Readonly<AlertResponses>, body: string): ResponseRule[] {
  return [...listings(responses, [trackerIssue(5, body)]), patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true })]
}

// 新しい Tracker #12 を作る一連の応答
function creating(responses: Readonly<AlertResponses>): ResponseRule[] {
  return [...listings(responses, []), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false })]
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
  return existing({ ...ONE_DEPENDABOT, secretScanningFailure: failure(500, 'boom') }, body)
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
  const github = await startGithub([...listings(ONE_DEPENDABOT, issues), ...boardRules(5, { onlyIfEmpty: true, filled })])
  const result = await sync()
  expect(result.code).toBe(0)
  return fieldUpdates(github.requests())
}

// 番号がいちばん小さい、印の無い open の Issue（label は security-alert）を含む
const SEVERAL_TRACKERS = [trackerIssue(9, trackerBody()), trackerIssue(5, trackerBody()), trackerIssue(3, 'マーカーの無い本文')]

function severalTrackers(): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, SEVERAL_TRACKERS), patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true })]
}

function sameBody(body: string): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, [trackerIssue(5, body)]), ...boardRules(5, { onlyIfEmpty: true })]
}

const GONE_BODY = trackerBody(dependabotEntry(1), trackerEntry('code-scanning', 2), trackerEntry('secret-scanning', 3))

function failingUpdate(): ResponseRule[] {
  return [...listings(ONE_DEPENDABOT, [trackerIssue(5, trackerBody())]), patchedTracker(5, 422), ...boardRules(5, { onlyIfEmpty: true })]
}

async function withoutToken(): Promise<{ readonly result: ActionResult, readonly root: string }> {
  const project = prepareSync()
  await startGithub([])
  setEnvironment({ [TOKEN_VARIABLE]: undefined })
  return { result: await sync({ 'dry-run': 'true' }), root: project.root }
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
      await verifies(context, 'PA-TRACKER-SYNC-47')
      await explains('open の Tracker が存在せず、載せる alert がある場合のテストです。ラベル `security-alert` を付けた Tracker の Issue を作成し、標準エラーに `created` と `added` の行を出力することを確認します。')
      const github = await startCreating()
      const result = await sync()
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
      expect(createdBody(github.requests())).toEqual({ title: TODAY_TITLE, body: CREATED_BODY, labels: ['security-alert'] })
      const lines = result.stderr.split('\n')
      expect(lines[0]).toBe(`created: Tracker "${TODAY_TITLE}"`)
      expect(lines.slice(1)).toEqual(['added: dependabot #1 to new Tracker', 'added: dependabot #2 to new Tracker', 'added: code-scanning #10 to new Tracker', ''])
    })

    it('Tracker の Issue を作ると、ボードに足す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-48')
      await explains('Tracker の Issue を作成した場合のテストです。作成した Issue をボードに追加することを確認します。')
      const github = await startCreating()
      await sync()
      expect(graphqlOperations(github.requests())).toEqual(['GetIssueNodeId', 'AddToProject', UPDATE_FIELD])
    })

    it('Tracker の Issue を作ると、Status を Backlog にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-49')
      await explains('Tracker の Issue を作成した場合のテストです。ボード上の Status を `Backlog` にすることを確認します。')
      const github = await startCreating()
      await sync()
      expect(fieldUpdates(github.requests())).toContainEqual({ projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'PVTSSF_workflow', optionId: 'o1' })
    })

    it('Tracker の Issue を作ると、ボードの欄は Status だけを入れ、Priority を入れない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-50')
      await explains('Tracker の Issue を作成した場合に、ボードへ書き込む欄のテストです。Status だけを書き込み、Priority は書き込まないことを確認します。')
      const github = await startCreating()
      const result = await sync()
      expect(result.code).toBe(0)
      expect(fieldUpdates(github.requests())).toEqual([{ projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'PVTSSF_workflow', optionId: 'o1' }])
    })

    it('open の Tracker が無く、載せる alert も無いと、Tracker の Issue を作らない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-51')
      await explains('open の Tracker が存在せず、載せる alert も存在しない場合のテストです。Tracker の Issue を作成せず、GitHub への書き込みも発生しないことを確認します。')
      prepareSync()
      const github = await startGithub(listings(NO_ALERTS, []))
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('open の Tracker が無く、載せる alert も無いと、skipped の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-52')
      await explains('open の Tracker が存在せず、載せる alert も存在しない場合のテストです。`skipped: Tracker creation` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(listings(NO_ALERTS, []))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'skipped: Tracker creation\n' })
    })

    it('閉じた Tracker は使い回さない', async () => {
      await explains('閉じた Tracker が存在する場合のテストです。閉じた Tracker を再利用せず、新しい Issue を作成することを確認します。')
      freezeClock()
      prepareSync()
      const closed = [trackerIssue(5, trackerBody(), 'closed')]
      const github = await startGithub([...listings(ONE_DEPENDABOT, closed), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false })])
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restPaths(github.requests())).toEqual(['/repos/acme/demo/issues'])
    })

    it('Tracker の作成が失敗すると、Tracker の error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-89')
      await verifies(context, 'PA-TRACKER-SYNC-90')
      await explains('Tracker の作成が失敗した場合のテストです。`error: Tracker: GitHub API error: 502` の行を標準エラーに出力して step を失敗にすることを確認します。')
      freezeClock()
      prepareSync()
      await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12, 502)])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: Tracker: GitHub API error: 502\n' })
    })

    it('ボードへの追加が失敗すると、Tracker の error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-89')
      await verifies(context, 'PA-TRACKER-SYNC-90')
      await explains('Tracker の作成後にボードへの追加が失敗した場合のテストです。`created` と `added` の行に続いて、Tracker の `error` の行を標準エラーに出力し、step を失敗にすることを確認します。')
      freezeClock()
      prepareSync()
      const github = await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12), ...boardRules(12, { onlyIfEmpty: false, failsToAdd: true })])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`created: Tracker "${TODAY_TITLE}"\nadded: dependabot #1 to new Tracker\nerror: Tracker: ${graphqlServerError(github.url, '502 Bad Gateway')}\n`)
    })

    it('選択肢の ID が古くて Status を書けないと、error の行と ID を読み直す案内を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-94')
      await explains('ボードの選択肢の ID が古く、作成した Tracker の Status を書き込めない場合のテストです。書き込めなかった欄と、ID を読み直す案内を `error` の行に出して step を失敗にすることを確認します。')
      freezeClock()
      prepareSync()
      const added = boardRules(12, { onlyIfEmpty: false }).filter(rule => rule.match.operation !== UPDATE_FIELD)
      await startGithub([...listings(ONE_DEPENDABOT, []), createdTracker(12), ...added, staleOptionUpdate()])
      const result = await sync()
      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: [
          `created: Tracker "${TODAY_TITLE}"`,
          'added: dependabot #1 to new Tracker',
          `error: could not set status backlog of Tracker #12: ${STALE_OPTION_TEXT}`,
          '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
          '',
        ].join('\n'),
      })
    })
  })

  describe('Tracker の本文を書き直す', () => {
    it('open の Tracker があると、list-begin と list-end の間を、Dependabot・code scanning・secret scanning の見出しと表に書き直す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-53')
      await explains('open の Tracker が存在する場合のテストです。`list-begin` と `list-end` の間を、Dependabot・code scanning・secret scanning の見出しと表に書き直し、範囲の外の文は残すことを確認します。')
      prepareSync()
      const outside = '\nこの文は残す\n'
      const responses: AlertResponses = { dependabot: [dependabotAlert(1), dependabotAlert(2)], codeScanning: [codeScanningAlert(3)], secretScanning: [secretScanningAlert(4)] }
      const github = await startGithub(existing(responses, BODY_WITH_ONE + outside))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      const headings = ['## Dependabot\n\n| title | alert | Severity |', '## code scanning\n\n| title | alert | Severity |', '## secret scanning\n\n| title | alert | Severity |']
      const positions = headings.map(heading => body.indexOf(heading))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect(positions).toEqual(positions.toSorted((a, b) => a - b))
      expect(body.endsWith(outside)).toBe(true)
    })

    it('表に alert を足すと、added の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-54')
      await explains('既存の Tracker に alert を追加する場合のテストです。`added: dependabot #2 to Tracker #5` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(existing({ dependabot: [dependabotAlert(1), dependabotAlert(2)] }, BODY_WITH_ONE))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'added: dependabot #2 to Tracker #5\n' })
    })

    it('表から alert を外すと、removed の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-55')
      await explains('既存の Tracker から alert を削除する場合のテストです。`removed` の行を標準エラーに出力し、書き直した本文に該当の行が残らないことを確認します。')
      prepareSync()
      const body = trackerBody(dependabotEntry(1), trackerEntry('code-scanning', 9))
      const github = await startGithub(existing(ONE_DEPENDABOT, body))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: code-scanning #9 from Tracker #5\n' })
      expect(updatedBody(github.requests(), 5)).not.toContain('pecot-alert: code-scanning/9')
    })

    it('行の足し外しが無く本文だけが変わると、本文を書き直す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-56')
      await explains('表の行の増減がなく、本文の形式だけが変わる場合のテストです。古い形式の印を持つ本文を、新しい形式に書き直すことを確認します。')
      prepareSync()
      const github = await startGithub(existing(ONE_DEPENDABOT, OLD_FORMAT_BODY))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('pecot-alert: dependabot/1')
      expect(body).not.toContain('state=open')
    })

    it('行の足し外しが無く本文だけが変わると、updated の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-57')
      await explains('表の行の増減がなく、本文の形式だけが変わる場合のテストです。`updated: Tracker #5 body` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(existing(ONE_DEPENDABOT, OLD_FORMAT_BODY))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'updated: Tracker #5 body\n' })
    })

    it('書き直した本文が今の本文と同じだと、本文を書き直さない（改行が CRLF でも同じとみなす）', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-58')
      await explains('書き直した本文が現在の本文と同じ場合のテストです。改行が CRLF の本文でも同じとみなして、GitHub へ書き込まないことを確認します。')
      prepareSync()
      const github = await startGithub(sameBody(BODY_WITH_ONE.replaceAll('\n', '\r\n')))
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('書き直した本文が今の本文と同じだと、unchanged の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-59')
      await explains('書き直した本文が現在の本文と同じ場合のテストです。`unchanged: Tracker #5` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(sameBody(BODY_WITH_ONE))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'unchanged: Tracker #5\n' })
    })

    it('open の alert がすべて無くなると、各種類の見出しの下に none を書く', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-60')
      await explains('open の alert がすべてなくなった場合のテストです。3 種類の見出しの下に、それぞれ `none` を書くことを確認します。')
      prepareSync()
      const github = await startGithub(existing(NO_ALERTS, GONE_BODY))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      for (const heading of ['Dependabot', 'code scanning', 'secret scanning']) expect(body).toContain(`## ${heading}\n\nnone`)
    })

    it('open の alert がすべて無くなると、Tracker を閉じない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-61')
      await explains('open の alert がすべてなくなった場合のテストです。Tracker を閉じず、本文の書き換えだけを行うことを確認します。')
      prepareSync()
      const github = await startGithub(existing(NO_ALERTS, GONE_BODY))
      await sync()
      const writes = restWrites(github.requests())
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ method: 'PATCH', path: TRACKER_5 })
      expect(JSON.stringify(writes[0])).not.toContain('closed')
    })

    it('code scanning と secret scanning の行を書くと、title を masked にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-62')
      await explains('code scanning と secret scanning の行を書き込む場合のテストです。どちらの行も title を `masked` にし、元の title を本文に含めないことを確認します。')
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
      await verifies(context, 'PA-TRACKER-SYNC-63')
      await explains('機能を無効にした種類がある場合のテストです。その種類の見出しの下に `disabled` を書き、表の行を追加しないことを確認します。')
      prepareSync()
      const github = await startGithub(secretNotFound('disabled', ONE_DEPENDABOT, [patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true })]))
      const result = await sync()
      expect(result.code).toBe(0)
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('## secret scanning\n\ndisabled')
      expect(body).not.toContain('pecot-alert: secret-scanning/')
    })

    it('機能が無効の種類があると、skipped の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-64')
      await explains('機能を無効にした種類がある場合のテストです。`skipped: secret scanning alerts (feature disabled)` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(secretNotFound('disabled', ONE_DEPENDABOT, [patchedTracker(5), ...boardRules(5, { onlyIfEmpty: true })]))
      const result = await sync()
      expect(result.stderr).toBe('skipped: secret scanning alerts (feature disabled)\nadded: dependabot #1 to Tracker #5\nremoved: secret-scanning #1 from Tracker #5\n')
    })

    it('code scanning の解析が無いリポジトリだと、code scanning の alert を 0 件として扱う', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-65')
      await explains('code scanning の解析が存在しないリポジトリの場合のテストです。code scanning の alert を 0 件として扱い、見出しの下に `none` を書くことを確認します。')
      prepareSync()
      const responses: AlertResponses = { codeScanningFailure: failure(404, 'no analysis found') }
      const body = trackerBody(trackerEntry('code-scanning', 9))
      const github = await startGithub(existing(responses, body))
      const result = await sync()
      expect(result).toEqual({ code: 0, stdout: '', stderr: 'removed: code-scanning #9 from Tracker #5\n' })
      expect(updatedBody(github.requests(), 5)).toContain('## code scanning\n\nnone')
    })

    it('既存の Tracker の Status が空だと、Status だけに Backlog を入れ、Priority を入れない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-66')
      await explains('既存の Tracker の Status が空の場合のテストです。Status だけに `Backlog` を書き込み、Priority は書き込まないことを確認します。')
      const workflow = { projectId: 'PVT_1', itemId: 'PVTI_5', fieldId: 'PVTSSF_workflow', optionId: 'o1' }
      expect(await boardUpdates([])).toEqual([workflow])
      expect(await boardUpdates([WORKFLOW_FIELD])).toEqual([])
    })

    it('表の 3 列目を Severity にし、GitHub の重大度の値をそのまま出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-97')
      await explains('Tracker の表の 3 列目のテストです。列の名前を Severity にし、GitHub の重大度の値を変換せずに出力することを確認します。')
      freezeClock()
      prepareSync()
      const codeScanning = [codeScanningAlert(10, { security_severity_level: 'medium', severity: 'error' }), codeScanningAlert(11, { severity: 'warning' }), codeScanningAlert(12, { severity: 'none' })]
      const github = await startGithub(creating({ dependabot: [dependabotAlert(1, 'critical')], codeScanning }))
      const { code } = await sync()
      expect(code).toBe(0)
      const rows = String(createdBody(github.requests())?.['body']).split('\n').filter(line => line.startsWith('| <!--'))
      expect(rows.map(row => /\| (?<value>\S+) \|$/u.exec(row)?.groups?.['value'])).toEqual(['critical', 'medium', 'warning', 'none'])
      expect(rows.map(row => /severity=(?<value>[a-z]+)/u.exec(row)?.groups?.['value'])).toEqual(['critical', 'medium', 'warning', 'none'])
    })

    it('secret scanning の alert と重大度の無い alert は、Severity の列に - を出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-98')
      await explains('重大度が存在しない alert の場合のテストです。secret scanning の alert と重大度のない alert は、Severity の列に `-` を出力することを確認します。')
      freezeClock()
      prepareSync()
      const dependabot = [{ ...dependabotAlert(1), security_vulnerability: {} }]
      const github = await startGithub(creating({ dependabot, codeScanning: [codeScanningAlert(10, {})], secretScanning: [secretScanningAlert(11)] }))
      const { code } = await sync()
      expect(code).toBe(0)
      const rows = String(createdBody(github.requests())?.['body']).split('\n').filter(line => line.startsWith('| <!--'))
      expect(rows).toHaveLength(3)
      for (const row of rows) {
        expect(row).toMatch(/ \| - \|$/u)
        expect(row).not.toContain('severity=')
      }
    })

    it('旧い本文の priority= の印を重大度として読み、書き直しで severity= にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-99')
      await explains('古い本文が `priority=` の印を持つ場合のテストです。その値を重大度として読み取り、書き直した本文では `severity=` の印にすることを確認します。')
      prepareSync()
      const oldRows = [
        '| <!-- pecot-alert: code-scanning/9 priority=high --> masked | [#9](u) | high |',
        '| <!-- pecot-alert: secret-scanning/4 priority=high --> masked | [#4](u) | high |',
      ].join('\n')
      const body = trackerBody().replace(LIST_END, () => `${oldRows}\n${LIST_END}`)
      const failed: AlertResponses = { codeScanningFailure: failure(500, 'boom'), secretScanningFailure: failure(500, 'boom') }
      const github = await startGithub(existing(failed, body))
      const { code } = await sync()
      expect(code).toBe(1)
      const rewritten = updatedBody(github.requests(), 5)
      expect(rewritten).not.toContain('priority=')
      expect(rewritten).toContain('| <!-- pecot-alert: code-scanning/9 severity=high --> masked | [#9](https://ghes.example.com/acme/demo/security/code-scanning/9) | high |')
      expect(rewritten).toContain('| <!-- pecot-alert: secret-scanning/4 --> masked | [#4](https://ghes.example.com/acme/demo/security/secret-scanning/4) | - |')
    })

    it('open の Tracker が複数あると、番号が最小のものを使う', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-67')
      await explains('open の Tracker が 2 件以上ある場合のテストです。番号が最も小さい Tracker だけを対象にして更新することを確認します。')
      prepareSync()
      const github = await startGithub(severalTrackers())
      const result = await sync()
      expect(result.code).toBe(0)
      expect(restPaths(github.requests())).toEqual([TRACKER_5])
    })

    it('open の Tracker が複数あると、使わないものを閉じない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-68')
      await explains('open の Tracker が 2 件以上ある場合のテストです。対象にしなかった Tracker を閉じないことを確認します。')
      prepareSync()
      const github = await startGithub(severalTrackers())
      await sync()
      expect(restPaths(github.requests())).not.toContain('/repos/acme/demo/issues/9')
    })

    it('open の Tracker が複数あると、warning の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-69')
      await explains('open の Tracker が 2 件以上ある場合のテストです。`warning` の行を標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(severalTrackers())
      const result = await sync()
      expect(result.stderr).toBe('warning: multiple open Trackers; using #5 (lowest number) and leaving #9 open\nadded: dependabot #1 to Tracker #5\n')
    })

    it('Tracker の本文の書き直しに失敗したなら、error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-87')
      await verifies(context, 'PA-TRACKER-SYNC-88')
      await explains('Tracker の本文の書き直しが失敗した場合のテストです。`error: could not update Tracker #5 body` の行を標準エラーに出力して step を失敗にすることを確認します。')
      prepareSync()
      await startGithub(failingUpdate())
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: could not update Tracker #5 body: GitHub API error: 422\n' })
    })
  })

  describe('dry-run が true', () => {
    // 書き込みの応答を持たない。書き込みの要求があれば、表に無い要求としてテストが落ちる
    const responses: AlertResponses = { dependabot: [dependabotAlert(1, 'high')], codeScanning: [codeScanningAlert(10)] }

    it('GitHub への書き込みをしない', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-70')
      await explains('input の `dry-run` を `true` にして実行した場合のテストです。GitHub へ REST と GraphQL のどちらの書き込みも送信しないことを確認します。')
      freezeClock()
      prepareSync()
      const github = await startGithub(listings(responses, []))
      const result = await sync({ 'dry-run': 'true' })
      expect(result.code).toBe(0)
      expect(restWrites(github.requests())).toEqual([])
      expect(graphqlOperations(github.requests())).toEqual([])
    })

    it('予定の行を標準エラーに出す（Tracker を作る場合）', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-71')
      await explains('input の `dry-run` を `true` にし、Tracker を新しく作成する場合のテストです。作成の予定を `dry-run: would` で始まる行にして、標準エラーに出力することを確認します。')
      freezeClock()
      prepareSync()
      await startGithub(listings(responses, []))
      const result = await sync({ 'dry-run': 'true' })
      const lines = [`dry-run: would create Tracker "${TODAY_TITLE}"`, 'dry-run: would add dependabot #1 to new Tracker', 'dry-run: would add code-scanning #10 to new Tracker', '']
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(lines.join('\n'))
    })

    it('予定の行を標準エラーに出す（既存の Tracker を書き直す場合）', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-71')
      await explains('input の `dry-run` を `true` にし、既存の Tracker を書き直す場合のテストです。追加と削除の予定を、標準エラーに出力することを確認します。')
      prepareSync()
      const body = trackerBody(dependabotEntry(2), trackerEntry('code-scanning', 9))
      await startGithub(listings({ dependabot: [dependabotAlert(2), dependabotAlert(3)] }, [trackerIssue(5, body)]))
      const result = await sync({ 'dry-run': 'true' })
      expect(result.stderr).toBe('dry-run: would add dependabot #3 to Tracker #5\ndry-run: would remove code-scanning #9 from Tracker #5\n')
    })
  })

  describe('実行できない', () => {
    it('対象のリポを含む設定が 2 つ以上あると、候補の名前と project の案内を error の行に出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-72')
      await explains('対象のリポジトリを含むプロジェクトの設定が 2 つ以上ある場合のテストです。候補の名前と設定の選び方の案内を `error` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
      prepareSync({ ambiguous: true })
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
      expect(github.requests()).toEqual([])
    })

    it('対象のリポを含む設定が無いと、error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-95')
      await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合のテストです。設定の候補を `error` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
      prepareSync({ repositories: ['other'] })
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
      expect(github.requests()).toEqual([])
    })

    it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-96')
      await explains('input の `project` に設定の名前を渡した場合のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、指定した設定を使って成功することを確認します。')
      prepareSync({ ambiguous: true })
      await startGithub(listings({}, []))
      const result = await sync({ project: 'second' })
      expect(result.code).toBe(0)
    })

    it('GITHUB_REPOSITORY が owner/repo の形でないと、error の行を出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-34')
      await explains('環境変数 `GITHUB_REPOSITORY` が `owner/repo` の形でない場合のテストです。値を示す `error` の行を出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
      prepareSync({ repository: 'acme/demo/extra' })
      const github = await startGithub([])
      const result = await sync()
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: GITHUB_REPOSITORY is not owner/repo: \'acme/demo/extra\'\n' })
      expect(github.requests()).toEqual([])
    })

    it('GitHub のトークンが見つからないと、error の行を標準エラーに出して step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-74')
      await explains('GitHub のトークンが存在しない場合のテストです。標準出力は空のまま、`error` の行を標準エラーに出力して step を失敗にすることを確認します。')
      const { result, root } = await withoutToken()
      expect(result).toEqual({ code: 1, stdout: '', stderr: missingTokenStderr(root) })
    })
  })

  describe('ある種類の alert の一覧を取れない', () => {
    it('その種類の前の行を残す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-76')
      await explains('ある種類の alert の一覧を取得できず、Tracker にその種類の行が存在する場合のテストです。見出しの下の表と既存の行を、そのまま残すことを確認します。')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      await sync()
      const body = updatedBody(github.requests(), 5)
      expect(body).toContain('## secret scanning\n\n| title')
      expect(body).toContain('pecot-alert: secret-scanning/1 ')
    })

    it('前の行も無いと、見出しの下に unavailable を書く', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-77')
      await explains('ある種類の alert の一覧を取得できず、Tracker にその種類の行も存在しない場合のテストです。見出しの下に `unavailable` を書くことを確認します。')
      prepareSync()
      const github = await startGithub(failedSecret(trackerBody()))
      await sync()
      expect(updatedBody(github.requests(), 5)).toContain('## secret scanning\n\nunavailable')
    })

    it('その種類を触らない旨の error の行を標準エラーに出す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-78')
      await explains('ある種類の alert の一覧を取得できない場合のテストです。その種類の行に触れない旨の `error` の行を、標準エラーに出力することを確認します。')
      prepareSync()
      await startGithub(failedSecret(SECRET_ROW_BODY))
      const result = await sync()
      expect(result.stderr).toBe('error: could not list secret scanning alerts (leaving its rows untouched): acme/demo: secret scanning: GitHub API error: 500 boom\nadded: dependabot #1 to Tracker #5\n')
    })

    it('ほかの種類を書き直す', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-79')
      await explains('ある種類の alert の一覧を取得できない場合のテストです。ほかの種類の行は、通常どおり書き直すことを確認します。')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      await sync()
      expect(updatedBody(github.requests(), 5)).toContain('pecot-alert: dependabot/1 ')
    })

    it('ほかの種類を書き直した後に、step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-80')
      await explains('ある種類の alert の一覧を取得できない場合のテストです。ほかの種類の行を書き直したうえで、step を失敗にすることを確認します。')
      prepareSync()
      const github = await startGithub(failedSecret(SECRET_ROW_BODY))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(restPaths(github.requests())).toEqual([TRACKER_5])
    })

    it('Tracker が無く、取れなかった種類しか無いと、Tracker を作らずに step を失敗にする', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-80')
      await explains('Tracker が存在せず、一覧を取得できなかった種類しか存在しない場合のテストです。Tracker を作成せず、GitHub へ書き込まずに step を失敗にすることを確認します。')
      prepareSync()
      const github = await startGithub(listings({ dependabotFailure: failure(500, 'boom') }, []))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(restWrites(github.requests())).toEqual([])
    })

    it('Dependabot alert が有効なのに一覧を 403 で取れないと、その種類を取れなかったものとして扱う', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-81')
      await explains('Dependabot alert が有効で、一覧の取得が 403 で失敗する場合のテストです。その種類を取得できなかったものとして `error` の行に出し、step を失敗にすることを確認します。')
      prepareSync()
      await startGithub([...listings({ dependabotFailure: failure(403, 'Resource not accessible by integration') }, []), vulnerabilityAlertsEnabled()])
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: could not list Dependabot alerts (leaving its rows untouched): acme/demo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)\nskipped: Tracker creation\n')
    })

    it('secret scanning の一覧を 404 で取れず、無効とも確かめられないと、その種類を取れなかったものとして扱う', async (context) => {
      await verifies(context, 'PA-TRACKER-SYNC-82')
      await explains('secret scanning の一覧が 404 になり、無効であることも確認できない場合のテストです。その種類を取得できなかったものとして扱い、GitHub へ書き込まないことを確認します。')
      prepareSync()
      const github = await startGithub(secretNotFound('enabled', NO_ALERTS, boardRules(5, { onlyIfEmpty: true })))
      const result = await sync()
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: could not list secret scanning alerts (leaving its rows untouched): acme/demo: cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)\nunchanged: Tracker #5\n')
      expect(restWrites(github.requests())).toEqual([])
    })
  })

  it.for([
    { name: 'GitHub API がエラーを返す', failure: issueList([], 500), stderr: 'error: could not list issues: GitHub API error: 500\n' },
    { name: '接続が切れる', failure: { ...issueList([]), respond: { status: 200, disconnect: true } }, stderr: 'error: could not list issues: other side closed\n' },
    { name: '応答が JSON でない', failure: { ...issueList([]), respond: { status: 200, text: '' } }, stderr: 'error: Unexpected end of JSON input\n' },
  ])('Issue の一覧を読むとき $name と、何も書かずに step を失敗にする', async (row, context) => {
    await verifies(context, 'PA-TRACKER-SYNC-83')
    await verifies(context, 'PA-TRACKER-SYNC-84')
    await explains(`Issue の一覧を読むときに${row.name}場合のテストです。原因を示す \`error\` の行を標準エラーに出し、GitHub へ何も書き込まずに step を失敗にすることを確認します。`)
    prepareSync()
    const github = await startGithub([...unlistable().slice(0, 3), row.failure])
    const result = await sync()
    expect(result).toEqual({ code: 1, stdout: '', stderr: row.stderr })
    expect(restWrites(github.requests())).toEqual([])
    expect(graphqlOperations(github.requests())).toEqual([])
  })

  it('使う Tracker の本文に list-begin と list-end の印が 1 組だけ無いと、何も書かずに step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-85')
    await verifies(context, 'PA-TRACKER-SYNC-86')
    await explains('使う Tracker の本文に `list-begin` と `list-end` の印が 1 組そろっていない場合のテストです。表を書き換えられないことを `error` の行に出し、GitHub へ何も書き込まずに step を失敗にすることを確認します。')
    prepareSync()
    const github = await startGithub(brokenMarkers())
    const result = await sync()
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: Tracker #5: cannot rewrite the list: the Tracker body does not have exactly one pair of list-begin / list-end markers\n' })
    expect(restWrites(github.requests())).toEqual([])
    expect(graphqlOperations(github.requests())).toEqual([])
  })

  describe('source が使えない', () => {
    it.for([
      { name: 'source を省く', source: undefined, id: 'PA-TRACKER-SYNC-91' },
      { name: 'source に dependabot でも security でもない値を渡す', source: 'foo', id: 'PA-TRACKER-SYNC-92' },
    ])('$name と、GitHub を呼ばずに入力の誤りとして終了コード 2 で step を失敗にする', async (row, context) => {
      await verifies(context, row.id)
      await explains(`input の \`source\` が使えない場合のテストです。${row.name}と、GitHub を呼び出さず、項目 \`source\` を示す入力の誤りとして終了コード 2 で step を失敗にすることを確認します。`)
      prepareSync()
      const github = await startGithub([])
      const result = await runSync(row.source)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: invalid input: .*\n {2}→ at source\n$/su)
      expect(github.requests()).toEqual([])
    })
  })
})
