// workflow doctor の振る舞い（PW-WORKFLOW-DOCTOR-*）を、MCP のツールをプロセス内で呼んで確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { pluginRoot } from '../../src/version.js'
import { requestLabels, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { ToolResult } from '../_helpers/command-harness.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { explains } from '../_helpers/explains.js'

useIsolatedEnvironment()

const DESTINATION = '.github/workflows/pecot-review.yml'
const TEMPLATE_FILE = path.join(pluginRoot(), 'cli/templates/workflow/pecot-review.yml')
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
const BUNDLED = readFileSync(TEMPLATE_FILE, 'utf8')
const OLD = BUNDLED.replace(/^# pecot-workflow-template: review \d+/u, '# pecot-workflow-template: review 0')
const HANDOFF_DESTINATION = '.github/workflows/pecot-handoff.yml'
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
const BUNDLED_HANDOFF = readFileSync(path.join(pluginRoot(), 'cli/templates/workflow/pecot-handoff.yml'), 'utf8')
const REPO = '/repos/acme/demo'
const TOKEN_MISSING = 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*'
const KEY_MISSING = 'secret PECOT_AGENT_APP_PRIVATE_KEY'
const CLIENT_ID_MISSING = 'variable PECOT_AGENT_APP_CLIENT_ID'
const AUTO_DESTINATION = '.github/workflows/pecot-auto.yml'
const ACTIONS_ITEM = `${DESTINATION} calls the pecot actions, not npx @pecot/workflow-mcp`
const AUTO_ACTIONS_ITEM = `${AUTO_DESTINATION} calls the pecot actions, not npx @pecot/workflow-mcp`

// 雛形が無くても、ほかのケースは流れるように、使うケースの中で読む
function bundledAuto(): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
  return readFileSync(path.join(pluginRoot(), 'cli/templates/workflow/pecot-auto.yml'), 'utf8')
}
const SECRET_VALUE = 'value-that-must-not-appear'

interface Settings {
  readonly ownerType?: string
  readonly secrets?: readonly string[] | number
  readonly variables?: readonly string[] | number
  readonly organizationSecrets?: readonly string[] | number
  readonly organizationVariables?: readonly string[] | number
}

// 名前の配列は 200 の一覧に、数は失敗の状態コードにする
function list(kind: string, key: 'secrets' | 'variables', value: readonly string[] | number): ResponseRule {
  return typeof value === 'number'
    ? restRule('GET', `${REPO}/actions/${kind}`, value, { message: 'Resource not accessible by integration' })
    : restRule('GET', `${REPO}/actions/${kind}`, 200, { total_count: value.length, [key]: value.map(name => ({ name, value: SECRET_VALUE })) })
}

function github(settings: Readonly<Settings> = {}): readonly ResponseRule[] {
  const ownerType = settings.ownerType ?? 'Organization'
  return [
    restRule('GET', REPO, 200, { owner: { type: ownerType } }),
    list('secrets', 'secrets', settings.secrets ?? []),
    list('variables', 'variables', settings.variables ?? []),
    ...ownerType === 'Organization'
      ? [list('organization-secrets', 'secrets', settings.organizationSecrets ?? []), list('organization-variables', 'variables', settings.organizationVariables ?? [])]
      : [],
  ]
}

const INSTALLED: Readonly<Record<string, string>> = { [DESTINATION]: BUNDLED }

async function doctor(settings: Readonly<Settings>, files = INSTALLED): Promise<ToolResult> {
  return await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, files, config: false, github: github(settings) })
}

function itemsOf(result: Readonly<ToolResult>): unknown {
  return result.structured['items']
}

function sortedLabels(result: Readonly<ToolResult>): readonly string[] {
  return requestLabels(result.requests).toSorted((left, right) => left.localeCompare(right))
}

const READY: Settings = { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }

describe('workflow doctor', () => {
  it('呼ぶと、確かめた項目を name と state の組で items に入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-01')
    await explains('ワークフローの診断（`workflow_doctor`）を、ファイルと設定がそろった状態で呼び出した場合のテストです。確認した項目が `name` と `state` の組として `items` に格納され、問題が 1 件も報告されないことを確認します。')
    const result = await doctor(READY)
    expect(itemsOf(result)).toEqual([
      { name: DESTINATION, state: 'ok' },
      { name: 'workflow template review', state: 'ok' },
      { name: ACTIONS_ITEM, state: 'ok' },
      { name: TOKEN_MISSING, state: 'ok' },
      { name: 'Claude GitHub App', state: 'skipped' },
    ])
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
  })

  it('ファイルと設定がそろっていると、ready を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
    await explains('ワークフローのファイルと設定がそろっている場合のテストです。`ready` が `true` になり、成功の結果が返ることを確認します。')
    const result = await doctor(READY)
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ repository: 'acme/demo', ready: true })
  })

  it('もしワークフローのファイルが存在しないなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-02')
    await explains('ワークフローのファイル（`.github/workflows/pecot-review.yml`）が存在しない場合のテストです。その項目が `missing` になって失敗の結果が返り、雛形の版の項目は `items` に含まれないことを確認します。')
    const result = await doctor(READY, {})
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: DESTINATION, state: 'missing' })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: 'workflow template review' }))
  })

  it('もしファイルの版が同梱の雛形より古いなら、その項目を outdated にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-03')
    await explains('ワークフローのファイルの版が、同梱の雛形より古い場合のテストです。雛形の項目が `outdated` になり、`repo-setting-missing` の失敗の結果が返ることを確認します。')
    const result = await doctor(READY, { [DESTINATION]: OLD })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: 'workflow template review', state: 'outdated' })
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false, detail: '1 item(s) of workflow review are missing or outdated' })
  })

  it('もし Client ID の変数を置き、秘密鍵の secret を置いていないなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-04')
    await explains('Client ID の変数のみを設定し、秘密鍵の secret（`PECOT_AGENT_APP_PRIVATE_KEY`）を設定していない場合のテストです。秘密鍵の項目が `missing` になり、失敗の結果が返ることを確認します。')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: KEY_MISSING, state: 'missing' })
  })

  it('もしモデルの認証の secret も 4 つの変数のそろった組も無いなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-05')
    await explains('モデルの認証の secret（`CLAUDE_CODE_OAUTH_TOKEN`）と、4 つの変数（`PECOT_AGENT_ANTHROPIC_*`）の完全な組のどちらも存在しない場合のテストです。モデルの認証の項目が `missing` になり、`repo-setting-missing` の失敗の結果が返ることを確認します。')
    const result = await doctor({ variables: ['PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID'] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', repository: 'acme/demo', ready: false })
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'missing' })
  })

  it('review では、Claude の App は確かめず、その項目を skipped で入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-07')
    await explains('ワークフロー `review` を診断した場合のテストです。Claude GitHub App の項目が確認されず、`skipped` として `items` に含まれることを確認します。')
    const result = await doctor(READY)
    expect(itemsOf(result)).toContainEqual({ name: 'Claude GitHub App', state: 'skipped' })
  })

  it('secret の一覧を取得できないと、その一覧に依存する項目を skipped にし、不足として数えない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    await explains('secret の一覧を取得できない（HTTP 403 を返す）場合のテストです。その一覧に依存する項目が `skipped` になり、不足（`missing`）として数えられないことを確認します。')
    const result = await doctor({ secrets: 403 })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'skipped' })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ state: 'missing' }))
  })

  it('一部の一覧を取得できなくても、取得できた一覧に名前があれば ok にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    await explains('一部の一覧を取得できない場合のテストです。Organization の secret の一覧が 403 でも、取得できたリポジトリの secret に名前があれば、その項目が `ok` になることを確認します。')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], organizationSecrets: 403 })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'ok' })
  })

  it('持ち主が organization だと、organization の secret と変数も見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-09')
    await explains('リポジトリの持ち主が Organization の場合のテストです。リポジトリの secret と変数に加えて、Organization の secret と変数の一覧も取得することを確認します。')
    const result = await doctor({ organizationSecrets: ['CLAUDE_CODE_OAUTH_TOKEN'] })
    expect(result.isError).toBe(false)
    expect(sortedLabels(result)).toEqual([
      `GET ${REPO}`,
      `GET ${REPO}/actions/organization-secrets`,
      `GET ${REPO}/actions/organization-variables`,
      `GET ${REPO}/actions/secrets`,
      `GET ${REPO}/actions/variables`,
    ])
  })

  it('持ち主が個人だと、organization の一覧を取得しない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-10')
    await explains('リポジトリの持ち主が個人（`User`）の場合のテストです。Organization の一覧を取得せず、問題が報告されないことを確認します。')
    const result = await doctor({ ownerType: 'User', secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] })
    expect(result.isError).toBe(false)
    expect(requestLabels(result.requests).filter(label => label.includes('organization'))).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('secret と変数の値を結果に含めない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-11')
    await explains('secret と変数の値の取り扱いのテストです。構造化された結果とテキストの出力のどちらにも、値が含まれないことを確認します。')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(JSON.stringify(result.structured)).not.toContain(SECRET_VALUE)
    expect(result.text ?? '').not.toContain(SECRET_VALUE)
  })

  it('名前が雛形の一覧に存在しないと、一覧の名前を detail に含めて invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-12')
    await explains('存在しない雛形の名前（`deploy`）を指定した場合のテストです。`invalid-input` の失敗が返り、`detail` に不明な雛形の名前と、指定できる名前の一覧が含まれることを確認します。')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'deploy' }, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input' })
    expect(result.structured['detail']).toContain('unknown workflow template: deploy')
    expect(result.structured['detail']).toContain('available: board-sync, review, handoff, auto')
  })

  it('name に handoff を渡すと、引き継ぎの雛形と review と同じエージェント用の認証を確かめ、Claude の App の項目を入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-01')
    await explains('`name` に `handoff` を指定した場合のテストです。引き継ぎの雛形と、`review` と同じエージェント用の認証が項目に含まれ、Claude GitHub App の項目は含まれないことを確認します。')
    await verifies(context, 'PW-WORKFLOW-DOCTOR-16')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'handoff' }, files: { [HANDOFF_DESTINATION]: BUNDLED_HANDOFF }, config: false, github: github(READY) })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toEqual([
      { name: HANDOFF_DESTINATION, state: 'ok' },
      { name: 'workflow template handoff', state: 'ok' },
      { name: TOKEN_MISSING, state: 'ok' },
    ])
  })

  it('もし handoff の 1 の版を置いているなら、その項目を outdated にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-03')
    await explains('`handoff` のワークフローのファイルが、古い版（`1`）の場合のテストです。その項目が `outdated` になり、失敗の結果が返ることを確認します。')
    const old = BUNDLED_HANDOFF.replace(/^# pecot-workflow-template: handoff \d+/u, '# pecot-workflow-template: handoff 1')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'handoff' }, files: { [HANDOFF_DESTINATION]: old }, config: false, github: github(READY) })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: 'workflow template handoff', state: 'outdated' })
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false })
  })

  it('もし auto で App の変数と secret が無いなら、その 2 つを missing にし、Claude の App の項目を入れずに失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-17')
    await explains('`name` に `auto` を指定し、App の変数と secret が存在しない場合のテストです。その 2 項目が `missing` になり、Claude GitHub App の項目は含まれず、失敗の結果が返ることを確認します。')
    await verifies(context, 'PW-WORKFLOW-DOCTOR-16')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'auto' }, files: { [AUTO_DESTINATION]: bundledAuto() }, config: false, github: github(READY) })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toEqual([
      { name: AUTO_DESTINATION, state: 'ok' },
      { name: 'workflow template auto', state: 'ok' },
      { name: AUTO_ACTIONS_ITEM, state: 'ok' },
      { name: CLIENT_ID_MISSING, state: 'missing' },
      { name: KEY_MISSING, state: 'missing' },
      { name: TOKEN_MISSING, state: 'ok' },
    ])
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false, detail: '2 item(s) of workflow auto are missing or outdated' })
  })

  it('auto で App の変数と secret とモデルの認証がそろっていると、ready を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
    await explains('`name` に `auto` を指定し、App の変数と secret、モデルの認証がそろっている場合のテストです。`ready` が `true` になり、成功の結果が返ることを確認します。')
    const settings: Settings = { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'PECOT_AGENT_APP_PRIVATE_KEY'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] }
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'auto' }, files: { [AUTO_DESTINATION]: bundledAuto() }, config: false, github: github(settings) })
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ ready: true })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: 'Claude GitHub App' }))
  })

  it('git remote からリポジトリを特定できないと、GitHub へ要求を送らずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    await explains('git remote の URL からリポジトリを特定できない場合のテストです。GitHub へ要求を送らずに、`git-unresolved` の失敗が返ることを確認します。')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, remoteUrl: '/srv/git/demo.git', config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.structured['detail']).toContain('cannot read the repository from the git remote')
    expect(result.requests).toEqual([])
  })

  it('Git リポジトリの外だと、GitHub へ要求を送らずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    await explains('Git リポジトリの外で実行した場合のテストです。GitHub へ要求を送らずに、`git-unresolved` の失敗が返ることを確認します。')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, remote: false, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.requests).toEqual([])
  })

  it('リポのサブディレクトリを directory に渡すと、リポのルートに置いたワークフローのファイルを見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-14')
    await explains('リポジトリのサブディレクトリを `directory` に指定した場合のテストです。リポジトリのルートに置いたワークフローのファイルが対象になり、その項目が `ok` になることを確認します。')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review', directory: 'sub' }, files: { ...INSTALLED, 'sub/.keep': '' }, config: false, github: github(READY) })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: DESTINATION, state: 'ok' })
  })

  it('Client ID の変数が存在しないと、秘密鍵の secret の項目を含めない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-15')
    await explains('Client ID の変数が存在しない場合のテストです。秘密鍵の secret の項目が、`items` に含まれないことを確認します。')
    const result = await doctor(READY)
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: KEY_MISSING }))
  })

  it('CLI で打つと、確かめた項目を状態と名前の行で標準出力に出す', async () => {
    await explains('`pecot workflow doctor review` を実行した場合のテストです。確認した項目が、状態と名前の行として標準出力に表示され、終了コード 0 で終了することを確認します。')
    const result = await runCommand({ argv: ['workflow', 'doctor', 'review'], files: INSTALLED, config: false, github: github(READY) })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe([
      `ok: ${DESTINATION}`,
      'ok: workflow template review',
      `ok: ${ACTIONS_ITEM}`,
      `ok: ${TOKEN_MISSING}`,
      'skipped: Claude GitHub App',
      '',
    ].join('\n'))
  })
  it.for([
    { name: 'npx で @pecot/workflow-mcp を呼ぶ', installed: BUNDLED.replace(/uses: pecotcraft\/pecot\/actions\/review-finish@\S+/u, 'run: npx -y --prefix=/ @pecot/workflow-mcp@latest review finish "$PR"') },
    { name: 'pecot の action を呼ばない', installed: BUNDLED.replace(/uses: pecotcraft\/pecot\/actions\/review-finish@\S+/u, 'run: echo finish') },
  ])('もし置いたファイルが $name なら、版が同じでも、その項目を outdated にして失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-18')
    await explains(`\`workflow doctor\` の、置いたワークフローの pecot の action の確認のテストです。置いたファイルが \`${row.name}\` 場合に、版が同じでもその項目を \`outdated\` にして失敗を返すことを確認します。`)
    const result = await doctor(READY, { [DESTINATION]: row.installed })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: 'workflow template review', state: 'ok' })
    expect(itemsOf(result)).toContainEqual({ name: ACTIONS_ITEM, state: 'outdated' })
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false })
  })

  it('SHA で固定した pecot の action を呼ぶファイルは、その項目を ok にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-18')
    await explains('`workflow doctor` の、置いたワークフローの pecot の action の確認のテストです。SHA で固定した pecot の action を呼ぶファイルの場合に、その項目を `ok` にすることを確認します。')
    const pinned = BUNDLED.replace(/(uses: pecotcraft\/pecot\/actions\/review-finish)@(\S+)/u, (_match, use: string, tag: string) => `${use}@${'a'.repeat(40)} # ${tag}`)
    const result = await doctor(READY, { [DESTINATION]: pinned })
    expect(itemsOf(result)).toContainEqual({ name: ACTIONS_ITEM, state: 'ok' })
  })

  it.for([
    { name: 'App の組', settings: { secrets: ['PECOT_BOARD_SYNC_APP_PRIVATE_KEY'], variables: ['PECOT_BOARD_SYNC_APP_CLIENT_ID'] }, state: 'ok' },
    { name: 'PAT の組', settings: { secrets: ['PECOT_BOARD_SYNC_TOKEN'], variables: ['PECOT_BOARD_SYNC_USE_PAT'] }, state: 'ok' },
    { name: 'App の変数だけ', settings: { variables: ['PECOT_BOARD_SYNC_APP_CLIENT_ID'] }, state: 'missing' },
  ])('board-sync で $name があると、token の組の項目を $state にする', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-19')
    await explains(`\`workflow doctor\` の、board sync のトークンの設定の確認のテストです。リポジトリに \`${row.name}\` がある場合に、トークンの組の項目を \`${row.state}\` にすることを確認します。`)
    const destination = '.github/workflows/pecot-board-sync.yml'
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
    const bundled = readFileSync(path.join(pluginRoot(), 'cli/templates/workflow/pecot-board-sync.yml'), 'utf8')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'board-sync' }, files: { [destination]: bundled }, config: false, github: github(row.settings) })
    expect(itemsOf(result)).toEqual([
      { name: destination, state: 'ok' },
      { name: 'workflow template board-sync', state: 'ok' },
      { name: `${destination} calls the pecot actions, not npx @pecot/workflow-mcp`, state: 'ok' },
      { name: 'variable PECOT_BOARD_SYNC_APP_CLIENT_ID and secret PECOT_BOARD_SYNC_APP_PRIVATE_KEY, or variable PECOT_BOARD_SYNC_USE_PAT and secret PECOT_BOARD_SYNC_TOKEN', state: row.state },
    ])
  })
})
