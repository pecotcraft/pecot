// 配布する board sync のワークフローの雛形が、安全な形・最新の正式版の取得・文書との一致を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { attachOutput } from '../../../../libs/interface-spec/src/vitest/attach.js'
import { markdownSection } from './_helpers/markdown-section.js'
import { explains } from './_helpers/explains.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-board-sync.yml'), 'utf8')
const document = readFileSync(path.join(pluginRoot, 'skills/w-help/references/board-sync-workflow.md'), 'utf8')
const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string
  concurrency?: Record<string, unknown>
  permissions?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: unknown
  jobs: Record<string, Job>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
const sync: Job = workflow.jobs['sync'] ?? { steps: [] }
const finish: Job = workflow.jobs['finish'] ?? { steps: [] }
const steps = sync.steps
const runLine = 'npx -y --prefix=/ @pecot/workflow-mcp@latest board sync'
const finishLine = 'npx -y --prefix=/ @pecot/workflow-mcp@latest session finish "$GITHUB_REPOSITORY/$PR" --skip-local-cleanup --delete-branch'
const tokenCondition = '(vars.PECOT_BOARD_SYNC_APP_CLIENT_ID != \'\' || vars.PECOT_BOARD_SYNC_USE_PAT == \'true\')'
const finishStep = finish.steps.find(step => step.run !== undefined) ?? {}

// finish の step の run を bash で動かし、npx の代わりに引数を出す関数で、打つ行を読む。
function finishCommand(headReference: string): string {
  const script = `npx() { printf '%s\\n' "npx $*"; }\n${finishStep.run ?? ''}`
  const stdout = execFileSync('bash', ['-e'], {
    input: script,
    env: { ...process.env, HEAD_REF: headReference, PR: '7', GITHUB_REPOSITORY: 'o/r' },
    encoding: 'utf8',
  })
  attachOutput('bash -e（finish の run）', 0, stdout, '')
  return stdout.trim()
}

describe('board sync のワークフローの雛形', () => {
  it('文書に、雛形の実行の行がそのまま書かれている', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。雛形の実行の行が、文書 `board-sync-workflow.md` にそのまま書かれていることを確認します。')
    const run = steps.find(step => step.run !== undefined)?.run ?? ''
    expect(run).not.toBe('')
    expect(document).toContain(run)
  })

  it('ワークフローの契機が 3 つそろっている', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。契機に `pull_request_target`・`issues`・`workflow_dispatch` の 3 つが含まれることを確認します。')
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request_target', 'issues', 'workflow_dispatch']))
  })

  it('pull_request_target を使い、pull_request は使わない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。契機に `pull_request_target` を使い、`pull_request` を使わないことを確認します。')
    expect(workflow.on).toHaveProperty('pull_request_target')
    expect(workflow.on).not.toHaveProperty('pull_request')
  })

  it('job の if が変数で実行を省き、Dependabot が起こした実行を除く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` の `if` が変数でトークンの有無を判定し、Dependabot が起こした実行を除き、`secrets` を参照しないことを確認します。')
    const condition = sync.if ?? ''
    expect(condition).toContain('vars.PECOT_BOARD_SYNC_APP_CLIENT_ID != \'\'')
    expect(condition).toContain('vars.PECOT_BOARD_SYNC_USE_PAT == \'true\'')
    expect(condition).toContain('github.actor != \'dependabot[bot]\'')
    expect(condition).not.toContain('secrets.')
  })

  it('checkout は ref を指定せず、資格情報を残さない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`checkout` が `ref` を指定せず、`persist-credentials` を `false` にして資格情報を残さないことを確認します。')
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()
    expect(checkout?.with).not.toHaveProperty('ref')
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('workflow の permissions は contents: read だけで、concurrency の group には sync の job だけが入る', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。ワークフロー全体の `permissions` が `contents: read` だけで、`concurrency` の group を `sync` の job にだけ指定していることを確認します。')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow).not.toHaveProperty('concurrency')
    expect(sync.concurrency).toEqual({ 'group': 'pecot-board-sync', 'cancel-in-progress': false })
    expect(finish).not.toHaveProperty('concurrency')
  })

  it('sync の job は finish の後に動き、finish が失敗しても取り消されない限り動く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` が `finish` の後に動き、`finish` が失敗しても、取り消されていない限り実行される条件であることを確認します。')
    expect(sync.needs).toBe('finish')
    expect(sync.if?.startsWith('${{ !cancelled() && ')).toBe(true)
    expect(sync.if).toContain(tokenCondition)
  })

  it('finish の job は、token の変数があり、同じリポの head の PR がマージされた closed の実行だけで動く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` の `if` が、トークンの変数があり、同じリポジトリの head の PR がマージされて閉じた実行だけを対象にし、`secrets` を参照しないことを確認します。')
    const condition = finish.if ?? ''
    expect(condition).toContain(tokenCondition)
    expect(condition).toContain('github.event_name == \'pull_request_target\'')
    expect(condition).toContain('github.event.action == \'closed\'')
    expect(condition).toContain('github.event.pull_request.merged')
    expect(condition).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(condition).not.toContain('secrets.')
  })

  it('finish の job の permissions は contents: write・issues: write・pull-requests: read だけになる', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` の `permissions` が、`contents: write`・`issues: write`・`pull-requests: read` だけであることを確認します。')
    expect(finish.permissions).toEqual({ 'contents': 'write', 'issues': 'write', 'pull-requests': 'read' })
  })

  it('finish の job は ref を指定せずに checkout し、GITHUB_TOKEN で session finish を打つ', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` が `ref` を指定せずに `checkout` し、`GITHUB_TOKEN` で `session finish` を実行し、`run` に式を埋め込まないことを確認します。')
    const checkout = finish.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
    expect(finishStep.env).toEqual({
      PECOT_GITHUB_COM_TOKEN: '${{ github.token }}',
      PR: '${{ github.event.pull_request.number }}',
      HEAD_REF: '${{ github.event.pull_request.head.ref }}',
    })
    expect(finishStep.run).not.toContain('${{')
    expect(finishStep.run).toContain(finishLine)
  })

  it.for([
    { name: 'feat/add-csv/732', expected: 'npx -y --prefix=/ @pecot/workflow-mcp@latest session finish o/r/7 --skip-local-cleanup --delete-branch' },
    { name: 'develop', expected: '' },
    { name: 'feat/732-csv', expected: '' },
    { name: 'dependabot/npm_and_yarn/foo-1.2.3', expected: '' },
  ])('head ブランチが $name のとき、finish の job は末尾が /<番号> のときだけ session finish を打つ', async ({ name, expected }) => {
    await explains(`board sync のワークフローの雛形 \`pecot-board-sync.yml\` のテストです。head ブランチが \`${name}\` の場合に、末尾が \`/<番号>\` のときだけ \`session finish\` を実行し、それ以外は何も実行しないことを確認します。`)
    expect(finishCommand(name)).toBe(expected)
  })

  it('finish の job も、すべての action を 40 桁の SHA で固定し、npm のキャッシュを使わない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` のすべての action を 40 桁の SHA で固定し、npm のキャッシュを使わないことを確認します。')
    const uses = finish.steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
    const setupNode = finish.steps.find(step => step.uses?.startsWith('actions/setup-node@'))
    expect(setupNode?.with?.['package-manager-cache']).toBe(false)
  })

  it('文書に、マージで閉じた PR の片付けの節と、finish の job の権限がある', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。文書にマージで閉じた PR の後片付けの節と、`finish` の権限の節があり、雛形の権限と一致することを確認します。')
    const section = markdownSection(document, '## マージで閉じた PR の片付け')
    expect(section).toContain('`--skip-local-cleanup`')
    expect(section).toContain('`/<番号>`')
    const permissions = markdownSection(document, '### `finish` の権限')
    const scopes = Object.entries(finish.permissions ?? {})
    for (const [scope, access] of scopes) expect(permissions).toContain(`\`${scope}: ${access}\``)
  })

  it('run は最新の正式版を取る 1 行だけで、式を埋め込まない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` の `run` が最新の正式版を取得する 1 行だけで、式を埋め込まないことを確認します。')
    const runs = steps.filter(step => step.run !== undefined)
    expect(runs.map(step => step.run)).toEqual([runLine])
    for (const step of runs) expect(step.run).not.toContain('${{')
  })

  it('setup-node は、secret を持つ job なので npm のキャッシュを戻さず保存もしない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。secret を持つ job の `setup-node` が、npm のキャッシュを復元せず保存もしないことを確認します。')
    const setupNode = steps.find(step => step.uses?.startsWith('actions/setup-node@'))
    expect(setupNode).toBeDefined()
    expect(setupNode?.with?.['package-manager-cache']).toBe(false)
  })

  it('すべての action を 40 桁の SHA で固定する', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` のすべての action が 40 桁の SHA で固定されていることを確認します。')
    const uses = steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })

  it('雛形の variable と secret の名前が、文書に出てくる', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。雛形が参照する変数と secret の名前が `PECOT_BOARD_SYNC_` で始まる 4 つで、いずれも文書に書かれていることを確認します。')
    const names = new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.(PECOT_BOARD_SYNC_[A-Z_]+)/g), match => match[1] ?? ''))
    expect([...names].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'PECOT_BOARD_SYNC_APP_CLIENT_ID',
      'PECOT_BOARD_SYNC_APP_PRIVATE_KEY',
      'PECOT_BOARD_SYNC_TOKEN',
      'PECOT_BOARD_SYNC_USE_PAT',
    ])
    for (const name of names) expect(document).toContain(`\`${name}\``)
  })

  it('App の権限が、文書の「App の権限」と食い違わない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。App のトークンに要求する権限が、文書の「App の権限」の記述と一致することを確認します。')
    const appToken = steps.find(step => step.uses?.startsWith('actions/create-github-app-token@'))
    const granted = Object.entries(appToken?.with ?? {})
      .filter(([key]) => key.startsWith('permission-'))
      .map(([key, value]): [string, string] => [key.slice('permission-'.length), String(value)])
    expect(granted.length).toBeGreaterThan(0)

    const labels = new Map([
      ['organization-projects', '組織の Projects'],
      ['issues', 'Issues'],
      ['pull-requests', 'Pull requests'],
      ['contents', 'Contents'],
    ])
    const lines = markdownSection(document, '### GitHub App').split('\n')
    const permissionLines = lines.slice(lines.findIndex(line => line.includes('App の権限')) + 1).filter(line => line.startsWith('  - '))

    const fromTemplate = granted.map(([key, access]) => `${labels.get(key) ?? key}: ${access === 'write' ? 'read and write' : 'read'}`)
    const fromDocument = fromTemplate.map((entry) => {
      const label = entry.slice(0, entry.indexOf(':'))
      const line = permissionLines.find(candidate => candidate.includes(label)) ?? ''
      return `${label}: ${/: (read and write|read)$/.exec(line)?.[1] ?? '文書に無い'}`
    })
    expect(fromDocument).toEqual(fromTemplate)
    expect(permissionLines).toHaveLength(2)
  })
})
