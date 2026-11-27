// 配布する github-ops のワークフローの雛形が、安全な形・token の分け方・pecot の action の呼び方を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { explains } from './_helpers/explains.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-github-ops.yml'), 'utf8')
const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

interface Step {
  id?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}
interface Job {
  if?: string
  permissions?: Record<string, string>
  steps: Step[]
}
interface Input {
  required?: boolean
  type?: string
  options?: string[]
}
interface Workflow {
  'run-name': string
  'on': { workflow_dispatch: { inputs: Record<string, Input> } }
  'permissions': Record<string, string>
  'jobs': Record<string, Job>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
const githubTokenJob: Job = workflow.jobs['github-token'] ?? { steps: [] }
const appJob: Job = workflow.jobs['app'] ?? { steps: [] }
const allSteps = [...githubTokenJob.steps, ...appJob.steps]
const PECOT_ACTION = /^pecotcraft\/pecot\/actions\/([a-z-]+)@pecot-actions\/v\d+\.\d+\.\d+$/
const OPERATIONS = ['link-branch', 'stack-register', 'project-fields', 'project-view', 'project-link', 'repo-settings', 'workflow-doctor', 'release-create']
const GITHUB_TOKEN_OPERATIONS = ['link-branch', 'stack-register', 'repo-settings']
const appToken = appJob.steps.find(step => step.uses?.startsWith('actions/create-github-app-token@')) ?? {}

// job の if の fromJSON('[...]') に並べた operation を読む
function operationsIn(condition = ''): string[] {
  const list = /fromJSON\('(\[[^\]]*\])'\)/u.exec(condition)?.[1]
  // eslint-disable-next-line no-restricted-syntax -- 雛形の if に書いた JSON の配列
  return list === undefined ? [] : JSON.parse(list) as string[]
}

describe('github-ops のワークフローの雛形', () => {
  it('workflow_dispatch だけで起動し、operation を 8 つの操作の選択肢で受ける', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。契機が `workflow_dispatch` だけで、`operation` が 8 つの操作を選択肢に持つ必須の入力であることを確認します。')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['operation', 'request_id', 'params'])
    expect(inputs['operation']).toMatchObject({ required: true, type: 'choice', options: OPERATIONS })
  })

  it('run-name に operation と request_id を入れ、呼び出し元が実行を探せるようにする', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。実行の名前に `operation` と `request_id` の入力が含まれ、スキルが実行の一覧から自分の実行を探せることを確認します。')
    expect(workflow['run-name']).toBe('pecot github-ops ${{ inputs.operation }} ${{ inputs.request_id }}')
  })

  it('GITHUB_TOKEN の job と App の job は、同じ 3 つの操作の一覧で、どの操作もどちらか一方だけで動く', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。2 つの job の `if` が同じ操作の一覧を逆の条件で参照し、どの操作もどちらか一方の job だけで動くことを確認します。')
    expect(operationsIn(githubTokenJob.if)).toEqual(GITHUB_TOKEN_OPERATIONS)
    expect(operationsIn(appJob.if)).toEqual(GITHUB_TOKEN_OPERATIONS)
    expect(githubTokenJob.if?.startsWith('${{ contains(')).toBe(true)
    expect(appJob.if?.startsWith('${{ !contains(')).toBe(true)
  })

  it('workflow の permissions は contents: read だけで、GITHUB_TOKEN の job だけが書き込める', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。全体の `permissions` が `contents: read` だけで、書き込みを `GITHUB_TOKEN` の job にだけ許すことを確認します。')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(githubTokenJob.permissions).toEqual({ 'contents': 'write', 'issues': 'write', 'pull-requests': 'write' })
    expect(appJob).not.toHaveProperty('permissions')
  })

  it('App の token を、ワークフローのリポの持ち主に向け、操作ごとに要る権限だけに絞る', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。App のトークンをリポの持ち主に対して作り、操作ごとに必要な権限だけを要求する式になっていることを確認します。')
    expect(appToken.if).toBe('${{ vars.PECOT_AGENT_APP_CLIENT_ID != \'\' }}')
    expect(appToken.with).toEqual({
      'client-id': '${{ vars.PECOT_AGENT_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.PECOT_AGENT_APP_PRIVATE_KEY }}',
      'owner': '${{ github.repository_owner }}',
      'permission-organization-projects': '${{ contains(fromJSON(\'["project-fields","project-view","project-link"]\'), inputs.operation) && \'write\' || \'\' }}',
      'permission-contents': '${{ contains(fromJSON(\'["project-link","release-create"]\'), inputs.operation) && \'write\' || \'\' }}',
      'permission-secrets': '${{ inputs.operation == \'workflow-doctor\' && \'read\' || \'\' }}',
      'permission-actions-variables': '${{ inputs.operation == \'workflow-doctor\' && \'read\' || \'\' }}',
    })
  })

  it('どちらの job も、入力を run に埋めず、github-ops の action の with にだけ渡す', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。`run` の step を持たず、入力を `github-ops` の action の `with` にだけ渡して、シェルへの埋め込みが起きないことを確認します。')
    expect(allSteps.filter(step => step.run !== undefined)).toEqual([])
    const jobs: readonly (readonly [Job, string])[] = [[githubTokenJob, '${{ github.token }}'], [appJob, '${{ steps.app-token.outputs.token }}']]
    for (const [job, token] of jobs) {
      const step = job.steps.find(candidate => PECOT_ACTION.exec(candidate.uses ?? '')?.[1] === 'github-ops')
      expect(step?.with).toEqual({ 'token': token, 'operation': '${{ inputs.operation }}', 'request-id': '${{ inputs.request_id }}', 'params': '${{ inputs.params }}' })
    }
  })

  it('checkout は ref を指定せず、資格情報を残さない', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。どちらの job の `checkout` も `ref` を指定せず、`persist-credentials` を `false` にして資格情報を残さないことを確認します。')
    for (const job of [githubTokenJob, appJob]) {
      const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
      expect(checkout?.with).toEqual({ 'persist-credentials': false })
    }
  })

  it('pecot の action はリリースのタグで指し、ほかの action は 40 桁の SHA で固定し、npx で CLI を取らない', async () => {
    await explains('github-ops のワークフローの雛形 `pecot-github-ops.yml` のテストです。pecot の action をリリースのタグで、ほかの action を 40 桁の SHA で指定し、`npx` で `@pecot/workflow-mcp` を取得しないことを確認します。')
    const uses = allSteps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.filter(use => use.startsWith('pecotcraft/pecot/')).map(use => PECOT_ACTION.exec(use)?.[1])).toEqual(['github-ops', 'github-ops'])
    const others = uses.filter(use => !use.startsWith('pecotcraft/pecot/'))
    for (const action of others) expect(action).toMatch(/@[0-9a-f]{40}$/u)
    expect(active).not.toMatch(/\bnpx\b/u)
  })
})
