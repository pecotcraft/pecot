/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下と雛形のみ */
// 配布する自動処理のワークフローの雛形が、specs/023-label-triggered-autofix/contracts/workflow-template.md の形を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'
import { parse } from 'yaml'

import { attachOutput, readOutput } from '../../../../libs/interface-spec/src/vitest/attach.js'
import { validateBodyStyle } from '@pecot/workflow-core/domain/sections.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const templateDirectory = path.join(pluginRoot, 'cli/templates/workflow')
const template = readFileSync(path.join(templateDirectory, 'pecot-auto.yml'), 'utf8')
const reviewTemplate = readFileSync(path.join(templateDirectory, 'pecot-review.yml'), 'utf8')

interface Step {
  readonly 'name'?: string
  readonly 'id'?: string
  readonly 'if'?: string
  readonly 'uses'?: string
  readonly 'run'?: string
  readonly 'with'?: Readonly<Record<string, unknown>>
  readonly 'env'?: Readonly<Record<string, string>>
  readonly 'continue-on-error'?: boolean
}
interface Job {
  readonly 'if'?: string
  readonly 'needs'?: string
  readonly 'timeout-minutes'?: string | number
  readonly 'concurrency'?: Readonly<Record<string, unknown>>
  readonly 'permissions'?: Readonly<Record<string, string>>
  readonly 'outputs'?: Readonly<Record<string, string>>
  readonly 'env'?: Readonly<Record<string, string>>
  readonly 'steps': readonly Step[]
}
interface Workflow {
  on: Record<string, { types?: string[] } | null>
  jobs: Record<string, Job>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
// eslint-disable-next-line no-restricted-syntax
const review = parse(reviewTemplate) as Workflow
const gate: Job = workflow.jobs['gate'] ?? { steps: [] }
const run: Job = workflow.jobs['run'] ?? { steps: [] }
const setup: Job = workflow.jobs['setup'] ?? { steps: [] }
const label = 'vars.PECOT_AUTO_LABEL || \'pecot-auto\''
const pecot = 'mcp__plugin_pecot-w_pecot-workflow__'
const actions = 'pecotcraft/pecot/actions'
const project = '${{ vars.PECOT_AUTO_PROJECT }}'

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stepUsing(job: Readonly<Job>, action: string): Step {
  const step = job.steps.find(candidate => candidate.uses?.startsWith(`${action}@`))
  expect(step, `${action} の step が無い`).toBeDefined()
  return step ?? {}
}

function stepRunning(job: Readonly<Job>, command: string): Step {
  const step = job.steps.find(candidate => candidate.run?.includes(command) === true)
  expect(step, `${command} を打つ step が無い`).toBeDefined()
  return step ?? {}
}

function grantedPermissions(step: Readonly<Step>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(step.with ?? {}).filter(([key]) => key.startsWith('permission-')))
}

const fix = stepUsing(run, 'anthropics/claude-code-action')
const fixInputs = fix.with ?? {}
const claudeArguments = text(fixInputs['claude_args'])
const decide = stepUsing(gate, `${actions}/auto-gate`)
const start = stepUsing(run, `${actions}/auto-start`)
const finish = stepUsing(run, `${actions}/auto-finish`)
const check = stepRunning(setup, 'gh api')
const report = stepUsing(setup, `${actions}/auto-finish`)

function toolList(flag: string): string[] {
  const start = claudeArguments.indexOf(`${flag} "`)
  expect(start, `${flag} が claude_args に無い`).toBeGreaterThanOrEqual(0)
  const valueStart = start + flag.length + 2
  const value = claudeArguments.slice(valueStart, claudeArguments.indexOf('"', valueStart))
  return value.replaceAll(/\$\{\{.*?\}\}/g, '').split(',').map(tool => tool.trim()).filter(tool => tool !== '')
}

describe('auto のワークフローの雛形', () => {
  it('1 行目に、雛形の名前と版の目印がある', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。1 行目に、雛形の名前と版を示す `# pecot-workflow-template: auto 2` があることを確認します。')
    expect(template.split('\n', 1)[0]).toBe('# pecot-workflow-template: auto 2')
  })

  it('YAML として読めると、gate・run・setup の 3 つの job を持つ', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。YAML として読み込んだ場合に、`gate`・`run`・`setup` の 3 つの job を持ち、どの job にも step があることを確認します。')
    expect(Object.keys(workflow.jobs)).toEqual(['gate', 'run', 'setup'])
    for (const job of [gate, run, setup]) expect(job.steps.length).toBeGreaterThan(0)
  })

  it('契機は issues の labeled だけになり、pull_request_target を持たない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。ワークフローの契機が `issues` の `labeled` だけで、`pull_request_target` を含まないことを確認します。')
    expect(Object.keys(workflow.on)).toEqual(['issues'])
    expect(workflow.on['issues']?.types).toEqual(['labeled'])
    expect(workflow.on).not.toHaveProperty('pull_request_target')
  })

  it('gate の if は、変数 PECOT_AGENT_APP_CLIENT_ID が空でないことと起動ラベルの名前を vars で読み、env を読まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` の `if` が、変数 `PECOT_AGENT_APP_CLIENT_ID` が空でないことと起動ラベルの名前を `vars` で参照し、`env` を参照しないことを確認します。')
    const condition = gate.if ?? ''
    expect(condition).toContain('vars.PECOT_AGENT_APP_CLIENT_ID != \'\'')
    expect(condition).toContain(`github.event.label.name == (${label})`)
    expect(condition).not.toContain('env.')
  })

  it('setup は gate の後に動き、gate が飛ばされても、変数が空かトークンを作れなかった起動ラベルで動く', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup` が `gate` の後に動き、`gate` が実行されなくても、変数が空かトークンを作成できなかった場合に起動ラベルで動く条件であることを確認します。')
    expect(setup.needs).toBe('gate')
    const condition = setup.if ?? ''
    expect(condition).toContain('always()')
    expect(condition).toContain(`github.event.label.name == (${label})`)
    expect(condition).toContain('(vars.PECOT_AGENT_APP_CLIENT_ID == \'\' || needs.gate.outputs.token-failed == \'true\')')
    expect(condition).not.toContain('env.')
  })

  it('gate は、トークンの発行が失敗しても job を続け、Decide を飛ばし、失敗を token-failed に出す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` でトークンの発行に失敗しても job を続け、`Decide` の step を実行せず、失敗を `token-failed` に出力することを確認します。')
    const gateToken = stepUsing(gate, 'actions/create-github-app-token')
    expect(gateToken.id).toBe('token')
    expect(gateToken['continue-on-error']).toBe(true)
    expect(decide.if).toBe('${{ steps.token.outcome == \'success\' }}')
    expect(gate.outputs?.['token-failed']).toBe('${{ steps.token.outcome == \'failure\' }}')
  })

  it('run のトークンの発行は、失敗したら job を止める', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`run` のトークンの発行に `continue-on-error` を指定せず、失敗した場合に job が止まることを確認します。')
    expect(stepUsing(run, 'actions/create-github-app-token')['continue-on-error']).toBeUndefined()
  })

  it('run は gate の後に、gate の proceed が真のときだけ動く', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`run` が `gate` の後に動き、`gate` の `proceed` が `true` の場合だけ実行されることを確認します。')
    expect(run.needs).toBe('gate')
    expect(run.if).toBe('${{ needs.gate.outputs.proceed == \'true\' }}')
  })

  it('gate は、Decide の step が書いた proceed・kind・issue・number・branch と、token-failed を job の出力にする', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` の job の出力が、`Decide` の step が書く `proceed`・`kind`・`issue`・`number`・`branch` と `token-failed` であることを確認します。')
    expect(decide.id).toBe('decide')
    const { 'token-failed': tokenFailed, ...decided } = gate.outputs ?? {}
    expect(tokenFailed).toBeDefined()
    expect(decided).toEqual(Object.fromEntries(
      ['proceed', 'kind', 'issue', 'number', 'branch'].map(name => [name, `\${{ steps.decide.outputs.${name} }}`]),
    ))
  })

  it('gate と setup の時間の上限は 5 分になる', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` と `setup` の `timeout-minutes` がどちらも 5 であることを確認します。')
    expect(gate['timeout-minutes']).toBe(5)
    expect(setup['timeout-minutes']).toBe(5)
  })

  it('run の timeout-minutes は、変数を fromJSON で数に直し、concurrency は gate の number ごとで待ちを取り消さない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`run` の `timeout-minutes` が変数を `fromJSON` で数値にした式で、`concurrency` が `gate` の `number` ごとに待機を取り消さない設定であることを確認します。')
    expect(run['timeout-minutes']).toBe('${{ fromJSON(vars.PECOT_AUTO_TIMEOUT_MINUTES || \'30\') }}')
    expect(run.concurrency).toEqual({ 'group': 'pecot-auto-${{ needs.gate.outputs.number }}', 'cancel-in-progress': false })
  })

  it('利用者が変える 4 つの変数に、既定値の式がある', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。利用者が変更できる 4 つの変数のそれぞれに、既定値を指定する式が含まれることを確認します。')
    expect(template).toContain(label)
    expect(template).toContain('vars.PECOT_AUTO_MAX_TURNS || \'80\'')
    expect(template).toContain('vars.PECOT_AUTO_TIMEOUT_MINUTES || \'30\'')
    expect(template).toContain('vars.PECOT_AUTO_MAX_CI_ATTEMPTS || \'3\'')
  })

  it('job の permissions は、gate・run・setup の job ごとの表のとおりになる', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate`・`run`・`setup` の各 job の `permissions` が、定めた表のとおりであることを確認します。')
    expect(gate.permissions).toEqual({ contents: 'read' })
    expect(run.permissions).toEqual({ 'contents': 'read', 'id-token': 'write' })
    expect(setup.permissions).toEqual({ contents: 'read', issues: 'write' })
  })

  it('トークンの発行は、gate と run の job ごとの表の権限だけを、変数と secret の App で渡す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` と `run` のトークンの発行が、変数と secret で指定した App に対し、job ごとに定めた権限だけを要求していることを確認します。')
    const app = {
      'client-id': '${{ vars.PECOT_AGENT_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.PECOT_AGENT_APP_PRIVATE_KEY }}',
    }
    const gateToken = stepUsing(gate, 'actions/create-github-app-token')
    const runToken = stepUsing(run, 'actions/create-github-app-token')
    expect(gateToken.with).toMatchObject(app)
    expect(runToken.with).toMatchObject(app)
    expect(grantedPermissions(gateToken)).toEqual({
      'permission-issues': 'write',
      'permission-actions': 'read',
      'permission-organization-projects': 'write',
      'permission-contents': 'read',
      'permission-pull-requests': 'read',
    })
    expect(grantedPermissions(runToken)).toEqual({
      'permission-contents': 'write',
      'permission-issues': 'write',
      'permission-pull-requests': 'write',
      'permission-actions': 'read',
      'permission-organization-projects': 'write',
    })
  })

  it('setup は App のトークンを発行しない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup` の job に、App のトークンを発行する step が含まれないことを確認します。')
    expect(setup.steps.filter(step => step.uses?.startsWith('actions/create-github-app-token@') === true)).toEqual([])
  })

  it('gate の step は、Checkout・トークンの発行・Decide の順に並ぶ', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`gate` の step が、`Checkout`・トークンの発行・`auto-gate` の action の順に並ぶことを確認します。')
    expect(gate.steps.map(step => step.uses?.split('@', 1)[0] ?? step.id)).toEqual([
      'actions/checkout',
      'actions/create-github-app-token',
      `${actions}/auto-gate`,
    ])
  })

  it('run の step は、Checkout・Set up Node.js・トークンの発行・Start・action・Finish の順に並び、準備の囲みが Start と action の間にある', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`run` の step が `auto-start` と `auto-finish` を含む 6 つの順に並び、準備の囲みが `auto-start` と action の間にあることを確認します。')
    expect(run.steps.map(step => step.uses?.split('@', 1)[0] ?? step.name)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'actions/create-github-app-token',
      `${actions}/auto-start`,
      'anthropics/claude-code-action',
      `${actions}/auto-finish`,
    ])
    const prepare = template.indexOf('# pecot-auto:prepare:begin')
    expect(prepare).toBeGreaterThan(template.indexOf(`${actions}/auto-start@`))
    expect(prepare).toBeLessThan(template.indexOf('anthropics/claude-code-action@'))
  })

  it('setup の step は、Checkout・Check・Report の 3 つになる', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup` の step が、`Checkout`・`Check`・`auto-finish` の action を使う `Report` の 3 つであることを確認します。')
    expect(setup.steps.map(step => step.uses?.split('@', 1)[0] ?? step.name)).toEqual(['actions/checkout', 'Check', `${actions}/auto-finish`])
    expect(check.id).toBe('check')
    expect(report.name).toBe('Report')
  })

  it('Checkout は、どの job も既定のブランチを persist-credentials: false で読む', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。どの job の `Checkout` も、既定のブランチを `persist-credentials: false` で取得することを確認します。')
    for (const job of [gate, run, setup]) {
      expect(stepUsing(job, 'actions/checkout').with).toEqual({ 'persist-credentials': false })
    }
  })

  it('setup-node は、プラグインの MCP サーバを動かす run の job にだけあり、review と同じ版の Node で、npm のキャッシュを戻さず保存もしない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup-node` は `run` の job にだけあり、`pecot-review.yml` と同じ版の Node を使い、npm のキャッシュを復元せず保存もしないことを確認します。')
    const reviewNode = stepUsing(review.jobs['review'] ?? { steps: [] }, 'actions/setup-node').with?.['node-version']
    expect(stepUsing(run, 'actions/setup-node').with).toEqual({ 'node-version': reviewNode, 'package-manager-cache': false })
    for (const job of [gate, setup]) {
      expect(job.steps.filter(step => step.uses?.startsWith('actions/setup-node@') === true)).toEqual([])
    }
  })

  it('action に、書き込み権限の無い人を通す入力・追跡のモード・API キーを渡さない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。action の入力に、書き込み権限のない人を許可する入力・進捗の追跡・API キーが含まれないことを確認します。')
    for (const key of ['allowed_non_write_users', 'track_progress', 'anthropic_api_key']) {
      expect(fixInputs).not.toHaveProperty(key)
    }
  })

  it('OAuth のトークンを渡し、secret があれば Workload Identity Federation の 4 つの入力を空で渡す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。action に OAuth のトークンを渡し、その secret が空の場合だけ Workload Identity Federation の 4 つの入力を変数から渡す式であることを確認します。')
    expect(fixInputs['claude_code_oauth_token']).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')
    const federation: [string, string][] = [
      ['anthropic_federation_rule_id', 'FEDERATION_RULE_ID'],
      ['anthropic_organization_id', 'ORGANIZATION_ID'],
      ['anthropic_service_account_id', 'SERVICE_ACCOUNT_ID'],
      ['anthropic_workspace_id', 'WORKSPACE_ID'],
    ]
    for (const [input, variable] of federation) {
      expect(new Map(Object.entries(fixInputs)).get(input)).toBe(`\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && vars.PECOT_AGENT_ANTHROPIC_${variable} || '' }}`)
    }
  })

  it('action には、発行した App のトークンと、pecot のマーケットプレイスの pecot-w を渡す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。action に、発行した App のトークンと、pecot のマーケットプレイスの `pecot-w` プラグインを渡していることを確認します。')
    expect(fixInputs['github_token']).toBe('${{ steps.token.outputs.token }}')
    expect(fixInputs['plugin_marketplaces']).toBe('https://github.com/pecotcraft/pecot.git')
    expect(fixInputs['plugins']).toBe('pecot-w@pecot')
  })

  it('allowed_bots は、発行の step の出力 app-slug を読み、* を使わない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`allowed_bots` が、トークンの発行の step の出力 `app-slug` を参照し、`*` を使わないことを確認します。')
    expect(fixInputs['allowed_bots']).toBe('${{ steps.token.outputs.app-slug }}')
  })

  it('prompt は、gate の kind と issue・文脈と結果のファイルを w-auto に渡し、変数があれば project=<名前> を足す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` の `prompt` のテストです。`gate` の `kind`・`issue` と文脈・結果のファイルを `w-auto` に渡し、変数 `PECOT_AUTO_PROJECT` があるときだけ `project=<名前>` を追加することを確認します。')
    expect(fixInputs['prompt']).toBe('/pecot-w:w-auto ${{ needs.gate.outputs.kind }} ${{ needs.gate.outputs.issue }} context=${{ steps.start.outputs.context-file }} result=${{ runner.temp }}/pecot-auto/result.md${{ vars.PECOT_AUTO_PROJECT != \'\' && format(\' project={0}\', vars.PECOT_AUTO_PROJECT) || \'\' }}')
  })

  it('action の step は、Start が成功したときだけ動く', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。action の step の `if` が、`auto-start` の step が成功した場合だけ動く条件であることを確認します。')
    expect(fix.if).toBe('${{ success() && steps.start.outcome == \'success\' }}')
  })

  it('prompt は、Issue の本文・タイトル・コメントを埋め込まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`prompt` に、Issue の本文・タイトル・コメントの式を埋め込んでいないことを確認します。')
    const prompt = text(fixInputs['prompt'])
    for (const field of ['github.event.issue.body', 'github.event.issue.title', 'github.event.comment.body']) {
      expect(prompt).not.toContain(field)
    }
  })

  it('claude_args は権限のモード・ターンの上限・文脈と結果の置き場所・許可・拒否の 5 つを持ち、# を含まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`claude_args` が、権限のモード・ターンの上限・`--add-dir`・許可・拒否の 5 つのオプションだけを持ち、`#` を含まないことを確認します。')
    expect(claudeArguments).toContain('--permission-mode default')
    expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_AUTO_MAX_TURNS || \'80\' }}')
    expect(claudeArguments).toContain('--add-dir "${{ runner.temp }}/pecot-auto"')
    expect(claudeArguments).toContain('--allowedTools "')
    expect(claudeArguments).toContain('--disallowedTools "')
    expect(Array.from(claudeArguments.matchAll(/(?:^|\s)(--[a-z-]+)/gi), match => match[1])).toEqual([
      '--permission-mode',
      '--max-turns',
      '--add-dir',
      '--allowedTools',
      '--disallowedTools',
    ])
    expect(claudeArguments).not.toContain('#')
  })

  it('許可は契約のツールだけで、Edit・Write と 4 つの MCP ツールを含み、pecot の CLI を Bash で許さない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`--allowedTools` が定めたツールだけで、`Edit`・`Write` と 4 つの MCP ツールを含み、pecot の CLI を `Bash` で許可しないことを確認します。')
    const allowed = toolList('--allowedTools')
    expect(allowed).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      `${pecot}session_start`,
      `${pecot}issue_comment`,
      `${pecot}pr_check`,
      `${pecot}pr_create`,
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git fetch:*)',
      'Bash(git checkout:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh run view:*)',
    ])
    expect(allowed.filter(tool => tool.startsWith('Bash(pecot'))).toEqual([])
  })

  it('許可に、マージ・クローズ・リリースのツールを含まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`--allowedTools` のどのツールにも、マージ・クローズ・リリースに関わるものが含まれないことを確認します。')
    for (const tool of toolList('--allowedTools')) {
      expect(tool).not.toMatch(/merge|close|release|session_finish|branch_delete|auto_|gh api|gh issue/)
    }
  })

  it('拒否は、人に聞くツール・外へ送るツール・clone・/proc の読み取りで、Edit・Write を含まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`--disallowedTools` が、人に聞くツール・外部へ送信するツール・clone・`/proc` の読み取りで、`Edit` と `Write` を含まないことを確認します。')
    const disallowed = toolList('--disallowedTools')
    expect(disallowed).toEqual(['Agent', 'AskUserQuestion', 'WebFetch', 'WebSearch', 'Bash(git clone:*)', 'Read(//proc/**)'])
    expect(disallowed).not.toContain('Edit')
    expect(disallowed).not.toContain('Write')
  })

  it('利用者が足す許可は、job の env の空の変数から、空でないときだけ --allowedTools の末尾に足す', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。利用者が追加する許可は、job の `env` の空の変数から、空でない場合だけ `--allowedTools` の末尾に追加される式であることを確認します。')
    expect(run.env).toEqual({ PECOT_AUTO_EXTRA_ALLOWED_TOOLS: '' })
    expect(claudeArguments).toContain('${{ env.PECOT_AUTO_EXTRA_ALLOWED_TOOLS != \'\' && format(\',{0}\', env.PECOT_AUTO_EXTRA_ALLOWED_TOOLS) || \'\' }}"')
  })

  it('利用者が足す許可と準備の行は、開始と終了の印のコメントで囲む', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。利用者が追加する許可と準備の行が、開始と終了の印のコメントで囲まれていることを確認します。')
    for (const area of ['allowed-tools', 'prepare']) {
      const begin = template.indexOf(`# pecot-auto:${area}:begin`)
      const end = template.indexOf(`# pecot-auto:${area}:end`)
      expect(begin, `${area} の開始の印が無い`).toBeGreaterThanOrEqual(0)
      expect(end, `${area} の終了の印が無い`).toBeGreaterThan(begin)
    }
    const allowedTools = template.slice(template.indexOf('# pecot-auto:allowed-tools:begin'), template.indexOf('# pecot-auto:allowed-tools:end'))
    expect(allowedTools).toContain('PECOT_AUTO_EXTRA_ALLOWED_TOOLS: ""')
  })

  it('action の step は、App のトークンだけを env で受ける', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。action の step が、`env` で App のトークンだけを受け取ることを確認します。')
    expect(fix.id).toBe('claude')
    expect(fix.env).toEqual({ PECOT_GITHUB_COM_TOKEN: '${{ steps.token.outputs.token }}' })
  })

  it('Decide は、起動ラベルを env で、App のトークン・CI を直す回数の上限・プロジェクトを入力で受ける', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`Decide` が起動ラベルを `env` で受け取り、App のトークン・CI の修正回数の上限・プロジェクトを `with` で受け取ることを確認します。')
    expect(decide.env).toEqual({ PECOT_AUTO_LABEL: `\${{ ${label} }}` })
    expect(decide.with).toEqual({
      'token': '${{ steps.token.outputs.token }}',
      'max-ci-attempts': '${{ vars.PECOT_AUTO_MAX_CI_ATTEMPTS || \'3\' }}',
      project,
    })
  })

  it('Start は、App のトークン・gate の issue・プロジェクトを入力で受ける', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`auto-start` の step が、App のトークン・`gate` の `issue`・プロジェクトを `with` で受け取ることを確認します。')
    expect(start.id).toBe('start')
    expect(start.with).toEqual({ token: '${{ steps.token.outputs.token }}', issue: '${{ needs.gate.outputs.issue }}', project })
  })

  it('Finish は if: always() で動き、起動ラベルを env で、job の様子と結果と実行のファイルを入力で受ける', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`auto-finish` の step が `if: always()` で動き、起動ラベルを `env` で、job の状態や結果のファイルなど 7 つの値を `with` で受け取ることを確認します。')
    expect(finish.if).toBe('${{ always() }}')
    expect(finish.env).toEqual({ PECOT_AUTO_LABEL: `\${{ ${label} }}` })
    expect(finish.with).toEqual({
      'token': '${{ steps.token.outputs.token }}',
      'issue': '${{ needs.gate.outputs.issue }}',
      'job-status': '${{ job.status }}',
      'start-outcome': '${{ steps.start.outcome }}',
      'result-file': '${{ runner.temp }}/pecot-auto/result.md',
      'execution-file': '${{ steps.claude.outputs.execution_file }}',
      project,
    })
  })

  it('setup の Check は、run のトークンとラベルを付けた人と本文を env で受け、run に式を埋め込まない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup` の `Check` が、トークン・ラベルを付けた人・本文を `env` で受け取り、`run` に式を埋め込まないことを確認します。')
    const { BODY_NO_APP: noApp, BODY_NO_TOKEN: noToken, ...expressions } = check.env ?? {}
    expect(expressions).toEqual({
      GH_TOKEN: '${{ github.token }}',
      SENDER: '${{ github.event.sender.login }}',
      NO_APP: '${{ vars.PECOT_AGENT_APP_CLIENT_ID == \'\' }}',
    })
    for (const body of [noApp, noToken]) {
      expect(body).toContain('PECOT_AGENT_APP_CLIENT_ID')
      expect(body).not.toContain('${{')
    }
    expect(check.run).not.toContain('${{')
  })

  it('setup の Report は、Check が通ったときだけ、run のトークンで Check の本文を setup-missing の結果として書く', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。`setup` の `Report` が `Check` を通った場合だけ動き、`Check` の本文を `setup-missing` の結果として `auto-finish` の action に渡すことを確認します。')
    expect(report.if).toBe('${{ steps.check.outputs.ok == \'true\' }}')
    expect(report.env).toEqual({ PECOT_AUTO_LABEL: `\${{ ${label} }}` })
    expect(report.with).toEqual({
      'token': '${{ github.token }}',
      'issue': '${{ github.event.issue.number }}',
      'result': 'setup-missing',
      'body-file': '${{ steps.check.outputs.body-file }}',
      project,
    })
  })

  it('pecot の 4 つの action はリリースのタグで指し、npx で CLI を取らない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。pecot の 4 つの action をリリースのタグで指定し、`npx` で CLI を取得しないことを確認します。')
    const pecotUses = Array.from(template.matchAll(/uses: (pecotcraft\/pecot\/actions\/[a-z-]+)@(\S+)$/gm), match => [match[1], match[2]])
    expect(pecotUses).toEqual([
      [`${actions}/auto-gate`, 'pecot-actions/v0.0.0'],
      [`${actions}/auto-start`, 'pecot-actions/v0.0.0'],
      [`${actions}/auto-finish`, 'pecot-actions/v0.0.0'],
      [`${actions}/auto-finish`, 'pecot-actions/v0.0.0'],
    ])
    expect(template).not.toMatch(/\bnpx\b/)
  })

  it('pecot 以外の action を 40 桁の SHA で固定し、review の雛形と同じ版にそろえる', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。pecot 以外のすべての action を 40 桁の SHA で固定し、`pecot-review.yml` と同じ版にそろえていることを確認します。')
    const reviewUses = new Map(Array.from(reviewTemplate.matchAll(/uses: ([^@\s]+)(@\S+ # \S+)/g), match => [match[1] ?? '', match[2] ?? '']))
    const uses = Array.from(template.matchAll(/uses: ([^@\s]+)(@.*)$/gm), match => ({ action: match[1] ?? '', ref: match[2] ?? '' }))
      .filter(({ action }) => !action.startsWith(`${actions}/`))
    expect(uses.length).toBe(7)
    for (const { action, ref } of uses) {
      expect(ref).toMatch(/^@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
      expect(ref, `${action} の版が review と違う`).toBe(reviewUses.get(action))
    }
  })

  it('このリポ固有の設定の名前と CI の名前を持たない', async () => {
    await explains('自動処理のワークフローの雛形 `pecot-auto.yml` のテストです。このリポジトリに固有の設定の名前と CI の名前が、雛形に含まれないことを確認します。')
    for (const name of ['github.com_pecotcraft', 'ci-result', 'pecot-sandbox']) {
      expect(template).not.toContain(name)
    }
  })
})

function readLines(file: string): string[] | undefined {
  return existsSync(file) ? readOutput(file).split('\n').slice(0, -1) : undefined
}

// Check の run を、偽の gh を PATH の先頭に置いた bash で動かし、outputs と書く本文を見る。
describe('auto のワークフローの雛形の Check の中身', () => {
  let work = ''
  let bin = ''
  let log = ''
  let output = ''

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'pecot-auto-template-'))
    bin = path.join(work, 'bin')
    log = path.join(work, 'log')
    output = path.join(work, 'github-output')
    for (const directory of [bin, log]) mkdirSync(directory)
    const fakeGh = [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$@" > "$FAKE_LOG/gh-args"',
      'if [ -z "${FAKE_ROLE:-}" ]; then exit 1; fi',
      'echo "$FAKE_ROLE"',
    ].join('\n')
    writeFileSync(path.join(bin, 'gh'), `${fakeGh}\n`, { mode: 0o755 })
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  // GitHub Actions の既定の shell と同じく、bash --noprofile --norc -eo pipefail でファイルを動かす。式の無い env はそのまま渡す。
  function runCheck(environment: Readonly<Record<string, string>>): number {
    const script = path.join(work, 'step.sh')
    writeFileSync(script, check.run ?? '')
    const literal = Object.fromEntries(Object.entries(check.env ?? {}).filter(([, value]) => !value.includes('${{')))
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, FAKE_LOG: log, RUNNER_TEMP: work, GITHUB_REPOSITORY: 'owner/repo', GITHUB_OUTPUT: output, ...literal, ...environment },
      encoding: 'utf8',
    })
    attachOutput(`bash step.sh（${check.name ?? ''}）`, result.status ?? undefined, result.stdout, result.stderr)
    return result.status ?? -1
  }

  function writtenBody(): string {
    return readOutput(path.join(work, 'pecot-auto-setup.md'))
  }

  it.for([
    { role: 'admin' },
    { role: 'write' },
  ])('ラベルを付けた人の権限が $role なら、本文のファイルを書いて、ok とファイルのパスを outputs に出す', async ({ role }) => {
    await explains(`雛形の \`Check\` の step を実行するテストです。ラベルを付けた人の権限が \`${role}\` の場合に、本文のファイルを書き込み、\`ok=true\` とファイルのパスを outputs に出力することを確認します。`)
    expect(runCheck({ SENDER: 'alice', FAKE_ROLE: role })).toBe(0)
    expect(readLines(path.join(log, 'gh-args'))).toEqual(['api', 'repos/owner/repo/collaborators/alice/permission', '--jq', '.permission'])
    expect(readLines(output)).toEqual(['ok=true', `body-file=${path.join(work, 'pecot-auto-setup.md')}`])
  })

  it('変数が空なら、足りない変数と secret の名前と workflow_doctor を本文に書き、結果のコメントの書き方を守る', async () => {
    await explains('雛形の `Check` の step を実行するテストです。変数が空の場合に、不足している変数と secret の名前と `workflow_doctor` を本文に含め、結果のコメントの書式に従うことを確認します。')
    expect(runCheck({ SENDER: 'alice', FAKE_ROLE: 'write', NO_APP: 'true' })).toBe(0)
    const body = writtenBody()
    for (const name of ['`PECOT_AGENT_APP_CLIENT_ID`', '`PECOT_AGENT_APP_PRIVATE_KEY`', '`workflow_doctor`']) {
      expect(body).toContain(name)
    }
    expect(validateBodyStyle(body)).toEqual([])
  })

  it('変数があれば、トークンを作れなかったことと確かめる設定と権限を本文に書き、書き方を守る', async () => {
    await explains('雛形の `Check` の step を実行するテストです。変数がある場合に、トークンを作成できなかったことと、確認する設定と権限を本文に含め、書式に従うことを確認します。')
    expect(runCheck({ SENDER: 'alice', FAKE_ROLE: 'write', NO_APP: 'false' })).toBe(0)
    const body = writtenBody()
    expect(body).toContain('トークンを作れなかった')
    for (const name of ['`PECOT_AGENT_APP_CLIENT_ID`', '`PECOT_AGENT_APP_PRIVATE_KEY`', '`gate`', 'Contents: write', 'Issues: write', 'Pull requests: write', 'Actions: read', 'Projects: write']) {
      expect(body).toContain(name)
    }
    expect(body).not.toContain('`workflow_doctor`')
    expect(validateBodyStyle(body)).toEqual([])
  })

  it.for([
    { role: 'read' },
    { role: 'triage' },
    { role: 'none' },
  ])('ラベルを付けた人の権限が $role なら、本文と outputs を書かずに成功で終わる', async ({ role }) => {
    await explains(`雛形の \`Check\` の step を実行するテストです。ラベルを付けた人の権限が \`${role}\` の場合に、本文と outputs を書き込まずに成功で終了することを確認します。`)
    expect(runCheck({ SENDER: 'bob', FAKE_ROLE: role })).toBe(0)
    expect(readLines(output)).toBeUndefined()
    expect(existsSync(path.join(work, 'pecot-auto-setup.md'))).toBe(false)
  })

  it('権限を読めないとき、本文と outputs を書かずに成功で終わる', async () => {
    await explains('雛形の `Check` の step を実行するテストです。ラベルを付けた人の権限を取得できない場合に、本文と outputs を書き込まずに成功で終了することを確認します。')
    expect(runCheck({ SENDER: 'bob' })).toBe(0)
    expect(readLines(output)).toBeUndefined()
  })

  it('ラベルを付けた人の名前が [bot] で終わると、権限を読まずに何も書かずに終わる', async () => {
    await explains('雛形の `Check` の step を実行するテストです。ラベルを付けた人の名前が `[bot]` で終わる場合に、権限を取得せず、何も書き込まずに終了することを確認します。')
    expect(runCheck({ SENDER: 'some-app[bot]', FAKE_ROLE: 'write' })).toBe(0)
    expect(readLines(path.join(log, 'gh-args'))).toBeUndefined()
    expect(readLines(output)).toBeUndefined()
  })
})
