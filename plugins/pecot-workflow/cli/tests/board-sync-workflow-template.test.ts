// 配布する board sync のワークフローの雛形が、安全な形・pecot の action の呼び方・文書との一致を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { readOutput } from '../../../../libs/interface-spec/src/vitest/attach.js'
import { makeTemporaryDirectory } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { markdownSection } from './_helpers/markdown-section.js'
import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'

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
const PECOT_ACTION = /^pecotcraft\/pecot\/actions\/([a-z-]+)@pecot-actions\/v\d+\.\d+\.\d+$/
const tokenCondition = '(vars.PECOT_BOARD_SYNC_APP_CLIENT_ID != \'\' || vars.PECOT_BOARD_SYNC_USE_PAT == \'true\')'
const finishStep = finish.steps.find(step => PECOT_ACTION.exec(step.uses ?? '')?.[1] === 'session-finish') ?? {}
const syncStep = steps.find(step => PECOT_ACTION.exec(step.uses ?? '')?.[1] === 'board-sync') ?? {}
const branchStep = finish.steps.find(step => step.id === 'branch') ?? {}

// head ブランチを見る step の run を bash で動かし、session-finish の step に渡す出力を読む。
function branchOutput(headReference: string): string {
  const output = path.join(makeTemporaryDirectory(), 'output')
  execFileSync('bash', ['-e'], {
    input: `: > "$GITHUB_OUTPUT"\n${branchStep.run ?? ''}`,
    env: { ...process.env, HEAD_REF: headReference, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  })
  return readOutput(output).trim()
}

describe('board sync のワークフローの雛形', () => {
  it('3 つの契機がそろっている', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。契機に `pull_request_target`・`issues`・`workflow_dispatch` の 3 つが含まれることを確認します。')
    stepSync('契機を比べる', () => {
      expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request_target', 'issues', 'workflow_dispatch']))
    })
  })

  it('pull_request_target を使い、pull_request は使わない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。契機に `pull_request_target` を使い、`pull_request` を使わないことを確認します。')
    stepSync('契機を比べる', () => {
      expect(workflow.on).toHaveProperty('pull_request_target')
      expect(workflow.on).not.toHaveProperty('pull_request')
    })
  })

  it('job の if が変数で実行を省き、Dependabot が起こした実行を除く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` の `if` が変数でトークンの有無を判定し、Dependabot が起こした実行を除き、`secrets` を参照しないことを確認します。')
    const condition = stepSync('sync の if を読む', () => sync.if ?? '')
    stepSync('if の条件を比べる', () => {
      expect(condition).toContain('vars.PECOT_BOARD_SYNC_APP_CLIENT_ID != \'\'')
      expect(condition).toContain('vars.PECOT_BOARD_SYNC_USE_PAT == \'true\'')
      expect(condition).toContain('github.actor != \'dependabot[bot]\'')
      expect(condition).not.toContain('secrets.')
    })
  })

  it('checkout は ref を指定せず、資格情報を残さない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`checkout` が `ref` を指定せず、`persist-credentials` を `false` にして資格情報を残さないことを確認します。')
    const checkout = stepSync('checkout の step を読む', () => steps.find(step => step.uses?.startsWith('actions/checkout@')))
    stepSync('checkout の with を比べる', () => {
      expect(checkout).toBeDefined()
      expect(checkout?.with).not.toHaveProperty('ref')
      expect(checkout?.with?.['persist-credentials']).toBe(false)
    })
  })

  it('workflow の permissions は contents: read だけで、concurrency の group には sync の job だけが入る', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。ワークフロー全体の `permissions` が `contents: read` だけで、`concurrency` の group を `sync` の job にだけ指定していることを確認します。')
    stepSync('permissions と concurrency を比べる', () => {
      expect(workflow.permissions).toEqual({ contents: 'read' })
      expect(workflow).not.toHaveProperty('concurrency')
      expect(sync.concurrency).toEqual({ 'group': 'pecot-board-sync', 'cancel-in-progress': false })
      expect(finish).not.toHaveProperty('concurrency')
    })
  })

  it('sync の job は finish の後に動き、finish が失敗しても取り消されない限り動く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` が `finish` の後に動き、`finish` が失敗しても、取り消されていない限り実行される条件であることを確認します。')
    stepSync('needs と if を比べる', () => {
      expect(sync.needs).toBe('finish')
      expect(sync.if?.startsWith('${{ !cancelled() && ')).toBe(true)
      expect(sync.if).toContain(tokenCondition)
    })
  })

  it('finish の job は、token の変数があり、同じリポの head の PR がマージされた closed の実行だけで動く', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` の `if` が、トークンの変数があり、同じリポジトリの head の PR がマージで閉じた実行だけを対象にし、`secrets` を参照しないことを確認します。')
    const condition = stepSync('finish の if を読む', () => finish.if ?? '')
    stepSync('if の条件を比べる', () => {
      expect(condition).toContain(tokenCondition)
      expect(condition).toContain('github.event_name == \'pull_request_target\'')
      expect(condition).toContain('github.event.action == \'closed\'')
      expect(condition).toContain('github.event.pull_request.merged')
      expect(condition).toContain('github.event.pull_request.head.repo.full_name == github.repository')
      expect(condition).not.toContain('secrets.')
    })
  })

  it('finish の job は、ブランチを消さないので contents に書かず、issues: write・pull-requests: read だけを広げる', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` の `permissions` が、`contents: read`・`issues: write`・`pull-requests: read` だけであることを確認します。')
    stepSync('finish の permissions を比べる', () => {
      expect(finish.permissions).toEqual({ 'contents': 'read', 'issues': 'write', 'pull-requests': 'read' })
    })
  })

  it('finish の job は ref を指定せずに checkout し、GITHUB_TOKEN と PR の番号を session-finish の action に渡す', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`finish` が `ref` を指定せずに `checkout` し、`GITHUB_TOKEN` と PR の番号を `session-finish` の action に渡すことを確認します。')
    const checkout = stepSync('finish の checkout の step を読む', () => finish.steps.find(step => step.uses?.startsWith('actions/checkout@')))
    stepSync('checkout と session-finish の with を比べる', () => {
      expect(checkout?.with).toEqual({ 'persist-credentials': false })
      expect(finishStep.with).toEqual({ token: '${{ github.token }}', pr: '${{ github.event.pull_request.number }}' })
      expect(finishStep.if).toBe('${{ steps.branch.outputs.ok == \'true\' }}')
    })
  })

  it.for([
    { name: 'feat/add-csv/732', expected: 'ok=true' },
    { name: 'develop', expected: '' },
    { name: 'feat/732-csv', expected: '' },
    { name: 'dependabot/npm_and_yarn/foo-1.2.3', expected: '' },
  ])('head ブランチが $name のとき、末尾が /<番号> のときだけ session-finish を動かす出力を出す', async ({ name, expected }) => {
    await explains(`board sync のワークフローの雛形 \`pecot-board-sync.yml\` のテストです。head ブランチが \`${name}\` の場合に、末尾が \`/<番号>\` のときだけ \`session-finish\` の action を動かす出力を出すことを確認します。`)
    const output = stepSync('head ブランチを見る step を bash で動かす', () => branchOutput(name))
    stepSync('step の定義と出力を比べる', () => {
      expect(branchStep.env).toEqual({ HEAD_REF: '${{ github.event.pull_request.head.ref }}' })
      expect(branchStep.run).not.toContain('${{')
      expect(output).toBe(expected)
    })
  })

  it('sync の job は、App の token か PAT を board-sync の action に渡す', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`sync` が、App のトークンか PAT（`PECOT_BOARD_SYNC_TOKEN`）を `board-sync` の action に渡すことを確認します。')
    stepSync('board-sync の with を比べる', () => {
      expect(syncStep.with).toEqual({ token: '${{ steps.app-token.outputs.token || secrets.PECOT_BOARD_SYNC_TOKEN }}' })
    })
  })

  it('npx で CLI を取らず、Node.js を用意しない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。`npx` で `@pecot/workflow-mcp` を取得せず、`setup-node` で Node.js を用意しないことを確認します。')
    stepSync('雛形の記述を比べる', () => {
      expect(active).not.toMatch(/\bnpx\b/)
      expect(active).not.toContain('@pecot/workflow-mcp')
      expect(active).not.toContain('actions/setup-node@')
    })
  })

  it('pecot の action はリリースのタグで指し、ほかの action は 40 桁の SHA で固定する', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。pecot の action をリリースのタグで指定し、ほかのすべての action を 40 桁の SHA で固定していることを確認します。')
    const uses = stepSync('step が使う action を集める', () => [...finish.steps, ...steps].map(step => step.uses).filter(use => use !== undefined))
    stepSync('pecot の action と、ほかの action の指定を比べる', () => {
      const pecot = uses.filter(use => use.startsWith('pecotcraft/pecot/'))
      expect(pecot.map(use => PECOT_ACTION.exec(use)?.[1])).toEqual(['session-finish', 'board-sync'])
      const others = uses.filter(use => !use.startsWith('pecotcraft/pecot/'))
      for (const action of others) expect(action).toMatch(/@[0-9a-f]{40}$/)
    })
  })

  it('文書に、マージで閉じた PR の片付けの節と、finish の job の権限がある', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。文書にマージで閉じた PR の後片付けの節と、`finish` の権限の節があり、雛形の権限と一致することを確認します。')
    const { section, permissions } = stepSync('文書の 2 つの節を読む', () => ({
      section: markdownSection(document, '## マージで閉じた PR の片付け'),
      permissions: markdownSection(document, '### `finish` の権限'),
    }))
    stepSync('節の記述と雛形の権限を比べる', () => {
      expect(section).toContain('Automatically delete head branches')
      expect(section).toContain('`/<番号>`')
      const scopes = Object.entries(finish.permissions ?? {})
      for (const [scope, access] of scopes) expect(permissions).toContain(`\`${scope}: ${access}\``)
    })
  })

  it('雛形の variable と secret の名前が、文書に出てくる', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。雛形が参照する変数と secret の名前が `PECOT_BOARD_SYNC_` で始まる 4 つで、いずれも文書に書かれていることを確認します。')
    const names = stepSync('雛形が参照する変数と secret の名前を集める', () => new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.(PECOT_BOARD_SYNC_[A-Z_]+)/g), match => match[1] ?? '')))
    stepSync('名前の一覧と文書の記述を比べる', () => {
      expect([...names].toSorted((a, b) => a.localeCompare(b))).toEqual([
        'PECOT_BOARD_SYNC_APP_CLIENT_ID',
        'PECOT_BOARD_SYNC_APP_PRIVATE_KEY',
        'PECOT_BOARD_SYNC_TOKEN',
        'PECOT_BOARD_SYNC_USE_PAT',
      ])
      for (const name of names) expect(document).toContain(`\`${name}\``)
    })
  })

  it('App の権限が、文書の「App の権限」と食い違わない', async () => {
    await explains('board sync のワークフローの雛形 `pecot-board-sync.yml` のテストです。App のトークンに要求する権限が、文書の「App の権限」の記述と一致することを確認します。')
    const { granted, fromTemplate, fromDocument, permissionLines } = stepSync('雛形と文書の App の権限を読む', () => {
      const appToken = steps.find(step => step.uses?.startsWith('actions/create-github-app-token@'))
      const granted = Object.entries(appToken?.with ?? {})
        .filter(([key]) => key.startsWith('permission-'))
        .map(([key, value]): [string, string] => [key.slice('permission-'.length), String(value)])

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
      return { granted, fromTemplate, fromDocument, permissionLines }
    })
    stepSync('雛形と文書の権限を比べる', () => {
      expect(granted.length).toBeGreaterThan(0)
      expect(fromDocument).toEqual(fromTemplate)
      expect(permissionLines).toHaveLength(2)
    })
  })
})
