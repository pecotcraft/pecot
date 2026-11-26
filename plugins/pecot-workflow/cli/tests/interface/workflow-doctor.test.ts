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
    const result = await doctor(READY)
    expect(itemsOf(result)).toEqual([
      { name: DESTINATION, state: 'ok' },
      { name: 'workflow template review', state: 'ok' },
      { name: TOKEN_MISSING, state: 'ok' },
      { name: 'Claude GitHub App', state: 'skipped' },
    ])
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
  })

  it('ファイルと設定がそろっていると、ready を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
    const result = await doctor(READY)
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ repository: 'acme/demo', ready: true })
  })

  it('もしワークフローのファイルが無いなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-02')
    const result = await doctor(READY, {})
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: DESTINATION, state: 'missing' })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: 'workflow template review' }))
  })

  it('もしファイルの版が同梱の雛形より古いなら、その項目を outdated にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-03')
    const result = await doctor(READY, { [DESTINATION]: OLD })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: 'workflow template review', state: 'outdated' })
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false, detail: '1 item(s) of workflow review are missing or outdated' })
  })

  it('もし Client ID の変数を置き、秘密鍵の secret を置いていないなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-04')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: KEY_MISSING, state: 'missing' })
  })

  it('もしモデルの認証の secret も 4 つの変数のそろった組も無いなら、その項目を missing にして失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-05')
    const result = await doctor({ variables: ['PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID'] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', repository: 'acme/demo', ready: false })
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'missing' })
  })

  it('review では、Claude の App は確かめず、その項目を skipped で入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-07')
    const result = await doctor(READY)
    expect(itemsOf(result)).toContainEqual({ name: 'Claude GitHub App', state: 'skipped' })
  })

  it('secret の一覧を読めないと、その一覧に頼る項目を skipped で入れ、足りないと数えない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    const result = await doctor({ secrets: 403 })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'skipped' })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ state: 'missing' }))
  })

  it('一部の一覧を読めなくても、読めた一覧に名前があれば ok を入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], organizationSecrets: 403 })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: TOKEN_MISSING, state: 'ok' })
  })

  it('持ち主が organization だと、organization の secret と変数も見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-09')
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

  it('持ち主が個人だと、organization の一覧を読まない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-10')
    const result = await doctor({ ownerType: 'User', secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] })
    expect(result.isError).toBe(false)
    expect(requestLabels(result.requests).filter(label => label.includes('organization'))).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('secret と変数の値を結果に入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-11')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(JSON.stringify(result.structured)).not.toContain(SECRET_VALUE)
    expect(result.text ?? '').not.toContain(SECRET_VALUE)
  })

  it('名前が雛形の一覧に無いと、一覧の名前を detail に入れて invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-12')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'deploy' }, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input' })
    expect(result.structured['detail']).toContain('unknown workflow template: deploy')
    expect(result.structured['detail']).toContain('available: review, handoff, auto')
  })

  it('name に handoff を渡すと、引き継ぎの雛形と review と同じエージェント用の認証を確かめ、Claude の App の項目を入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-01')
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
    const old = BUNDLED_HANDOFF.replace(/^# pecot-workflow-template: handoff \d+/u, '# pecot-workflow-template: handoff 1')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'handoff' }, files: { [HANDOFF_DESTINATION]: old }, config: false, github: github(READY) })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toContainEqual({ name: 'workflow template handoff', state: 'outdated' })
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false })
  })

  it('もし auto で App の変数と secret が無いなら、その 2 つを missing にし、Claude の App の項目を入れずに失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-17')
    await verifies(context, 'PW-WORKFLOW-DOCTOR-16')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'auto' }, files: { [AUTO_DESTINATION]: bundledAuto() }, config: false, github: github(READY) })
    expect(result.isError).toBe(true)
    expect(itemsOf(result)).toEqual([
      { name: AUTO_DESTINATION, state: 'ok' },
      { name: 'workflow template auto', state: 'ok' },
      { name: CLIENT_ID_MISSING, state: 'missing' },
      { name: KEY_MISSING, state: 'missing' },
      { name: TOKEN_MISSING, state: 'ok' },
    ])
    expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', ready: false, detail: '2 item(s) of workflow auto are missing or outdated' })
  })

  it('auto で App の変数と secret とモデルの認証がそろっていると、ready を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
    const settings: Settings = { secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'PECOT_AGENT_APP_PRIVATE_KEY'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] }
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'auto' }, files: { [AUTO_DESTINATION]: bundledAuto() }, config: false, github: github(settings) })
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ ready: true })
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: 'Claude GitHub App' }))
  })

  it('git remote からリポジトリを読めないと、GitHub を読まずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, remoteUrl: '/srv/git/demo.git', config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.structured['detail']).toContain('cannot read the repository from the git remote')
    expect(result.requests).toEqual([])
  })

  it('Git リポジトリの外だと、GitHub を読まずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, remote: false, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.requests).toEqual([])
  })

  it('リポのサブディレクトリを directory に渡すと、リポのルートに置いたワークフローのファイルを見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-14')
    const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review', directory: 'sub' }, files: { ...INSTALLED, 'sub/.keep': '' }, config: false, github: github(READY) })
    expect(result.isError).toBe(false)
    expect(itemsOf(result)).toContainEqual({ name: DESTINATION, state: 'ok' })
  })

  it('Client ID の変数が無いと、秘密鍵の secret の項目を入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-15')
    const result = await doctor(READY)
    expect(itemsOf(result)).not.toContainEqual(expect.objectContaining({ name: KEY_MISSING }))
  })

  it('CLI で打つと、確かめた項目を状態と名前の行で標準出力に出す', async () => {
    const result = await runCommand({ argv: ['workflow', 'doctor', 'review'], files: INSTALLED, config: false, github: github(READY) })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe([
      `ok: ${DESTINATION}`,
      'ok: workflow template review',
      `ok: ${TOKEN_MISSING}`,
      'skipped: Claude GitHub App',
      '',
    ].join('\n'))
  })
})
