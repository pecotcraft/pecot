// workflow doctor の振る舞い（PW-WORKFLOW-DOCTOR-*）を、runCli をプロセス内で呼んで確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { pluginRoot } from '../../src/version.js'
import { requestLabels, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult } from '../_helpers/command-harness.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const DESTINATION = '.github/workflows/pecot-review.yml'
const TEMPLATE_FILE = path.join(pluginRoot(), 'cli/templates/workflow/pecot-review.yml')
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
const BUNDLED = readFileSync(TEMPLATE_FILE, 'utf8')
const OLD = BUNDLED.replace(/^# pecot-workflow-template: review \d+/u, '# pecot-workflow-template: review 0')
const REPO = '/repos/acme/demo'
const TOKEN_MISSING = 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*'
const KEY_MISSING = 'secret PECOT_AGENT_APP_PRIVATE_KEY'
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

async function doctor(settings: Readonly<Settings>, files = INSTALLED): Promise<CommandResult> {
  return await runCommand({ argv: ['workflow', 'doctor', 'review'], files, config: false, github: github(settings) })
}

function sortedLabels(result: Readonly<CommandResult>): readonly string[] {
  return requestLabels(result.requests).toSorted((left, right) => left.localeCompare(right))
}

const READY: Settings = { secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }

describe('workflow doctor', () => {
  it('打つと、確かめた項目を状態と名前の行で標準出力に出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-01')
    const result = await doctor(READY)
    expect(result.stdout).toBe([
      `ok: ${DESTINATION}`,
      'ok: workflow template review',
      `ok: ${TOKEN_MISSING}`,
      'skipped: Claude GitHub App',
      '',
    ].join('\n'))
    expect(result.problems).toEqual([])
    expect(result.unused).toEqual([])
  })

  it('全部そろっていると、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
    const result = await doctor(READY)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('雛形が無いと、missing の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-02')
    const result = await doctor(READY, {})
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`missing: ${DESTINATION}\n`)
    expect(result.stdout).not.toContain('workflow template review')
  })

  it('雛形の版が古いと、outdated の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-03')
    const result = await doctor(READY, { [DESTINATION]: OLD })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('outdated: workflow template review\n')
    expect(result.stderr).toBe('error: 1 item(s) of workflow review are missing or outdated\n')
  })

  it('App の Client ID の変数があり秘密鍵の secret の無いとき、秘密鍵の missing の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-04')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`missing: ${KEY_MISSING}\n`)
  })

  it('モデルの認証の secret も 4 つの変数も無いと、missing の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-05')
    const result = await doctor({ variables: ['PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID'] })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`missing: ${TOKEN_MISSING}\n`)
  })

  it('Claude の App は確かめず、skipped の行で出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-07')
    const result = await doctor(READY)
    expect(result.stdout).toContain('skipped: Claude GitHub App\n')
  })

  it('secret の一覧を読めないと、その一覧に頼る項目を skipped で出し、足りないと数えない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    const result = await doctor({ secrets: 403 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`skipped: ${TOKEN_MISSING}\n`)
    expect(result.stdout).not.toContain('missing:')
  })

  it('持ち主が organization だと、organization の secret と変数も見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-09')
    const result = await doctor({ organizationSecrets: ['CLAUDE_CODE_OAUTH_TOKEN'] })
    expect(result.code).toBe(0)
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
    expect(result.code).toBe(0)
    expect(requestLabels(result.requests).filter(label => label.includes('organization'))).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('secret と変数の値を出力に出さない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-11')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], variables: ['PECOT_AGENT_APP_CLIENT_ID'] })
    expect(result.stdout + result.stderr).not.toContain(SECRET_VALUE)
  })

  it('名前が一覧に無いと、一覧の名前を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-12')
    const result = await runCommand({ argv: ['workflow', 'doctor', 'deploy'], config: false, github: [] })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: unknown workflow template: deploy\n  available: review\n')
  })

  it('git remote からリポジトリを読めないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    const result = await runCommand({ argv: ['workflow', 'doctor', 'review'], remoteUrl: '/srv/git/demo.git', config: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: cannot read the repository from the git remote')
    expect(result.requests).toEqual([])
  })

  it('Git リポジトリの外で打つと、GitHub を読まずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-13')
    const result = await runCommand({ argv: ['workflow', 'doctor', 'review'], remote: false, config: false, github: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: .+ is not in a Git repository\n$/u)
    expect(result.requests).toEqual([])
  })

  it('リポのサブディレクトリを渡すと、リポのルートに置いた雛形を見る', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-14')
    const result = await runCommand({ argv: ['workflow', 'doctor', 'review', '-D', 'sub'], files: { ...INSTALLED, 'sub/.keep': '' }, config: false, github: github(READY) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`ok: ${DESTINATION}\n`)
  })

  it('Client ID の変数が無いと、秘密鍵の項目を出さない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-15')
    const result = await doctor(READY)
    expect(result.stdout).not.toContain(KEY_MISSING)
  })

  it('一部の一覧を読めなくても、読めた一覧に名前があれば ok を出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-DOCTOR-08')
    const result = await doctor({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], organizationSecrets: 403 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`ok: ${TOKEN_MISSING}\n`)
  })

  describe('MCP の結果', () => {
    it('足りないと、repo-setting-missing と項目を返す', async (context) => {
      await verifies(context, 'PW-WORKFLOW-DOCTOR-05')
      const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, config: false, files: { [DESTINATION]: BUNDLED }, github: github({}) })
      expect(result.isError).toBe(true)
      expect(result.structured).toMatchObject({ kind: 'repo-setting-missing', repository: 'acme/demo', ready: false })
      expect(result.structured).toHaveProperty('items', expect.arrayContaining([{ name: TOKEN_MISSING, state: 'missing' }]))
    })

    it('そろっていると、ready を true にして返す', async (context) => {
      await verifies(context, 'PW-WORKFLOW-DOCTOR-06')
      const result = await runTool({ tool: 'workflow_doctor', arguments: { name: 'review' }, config: false, files: { [DESTINATION]: BUNDLED }, github: github(READY) })
      expect(result.isError).toBeFalsy()
      expect(result.structured).toMatchObject({ repository: 'acme/demo', ready: true })
    })
  })
})
