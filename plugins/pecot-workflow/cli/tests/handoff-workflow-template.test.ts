// 配布する引き継ぎのワークフローの雛形が、安全な形と文書との一致を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { attachOutput } from '../../../../libs/interface-spec/src/vitest/attach.js'
import { markdownSection } from './_helpers/markdown-section.js'
import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-handoff.yml'), 'utf8')
const documentPath = path.join(pluginRoot, 'skills/w-help/references/handoff-workflow.md')
const document = existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : ''
const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

interface Step {
  'name'?: string
  'id'?: string
  'if'?: string
  'continue-on-error'?: boolean
  'uses'?: string
  'run'?: string
  'with'?: Record<string, unknown>
  'env'?: Record<string, string>
}
interface Job {
  'if'?: string
  'timeout-minutes'?: string
  'concurrency'?: unknown
  'permissions'?: Record<string, string>
  'env'?: Record<string, string>
  'steps': Step[]
}
interface Workflow {
  on: Record<string, { types?: string[] } | null>
  permissions?: unknown
  jobs: Record<string, Job>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
const job: Job = workflow.jobs['handoff'] ?? { steps: [] }
const steps = job.steps
const condition = job.if ?? ''
const pecot = 'mcp__plugin_pecot-w_pecot-workflow__'
const official = 'mcp__github-official__'

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stepUsing(action: string): Step {
  const step = steps.find(candidate => candidate.uses?.startsWith(`${action}@`))
  expect(step, `${action} の step が無い`).toBeDefined()
  return step ?? {}
}

const handoff = stepUsing('anthropics/claude-code-action')
const inputs = handoff.with ?? {}
const claudeArguments = text(inputs['claude_args'])
const record = steps.find(step => step.name === 'Record the run') ?? {}

function toolList(flag: string): string[] {
  const start = claudeArguments.indexOf(`${flag} "`)
  expect(start, `${flag} が claude_args に無い`).toBeGreaterThanOrEqual(0)
  const valueStart = start + flag.length + 2
  return claudeArguments.slice(valueStart, claudeArguments.indexOf('"', valueStart)).split(',').map(tool => tool.trim())
}

function tableRow(label: string): string {
  return markdownSection(document, '## 権限').split('\n').find(line => line.startsWith(`| ${label} |`)) ?? ''
}

describe('handoff のワークフローの雛形', () => {
  it('1 行目に、雛形の名前と版の目印がある', async () => {
    await explains('配布する引き継ぎのワークフローの雛形（`pecot-handoff.yml`）のテストです。1 行目が `# pecot-workflow-template: handoff 4` という、雛形の名前と版を示すコメントであることを確認します。')
    const first = stepSync('雛形の 1 行目を読む', () => template.split('\n', 1)[0])
    stepSync('1 行目を比べる', () => {
      expect(first).toBe('# pecot-workflow-template: handoff 4')
    })
  })

  it('契機は pull_request_target の closed だけになる', async () => {
    await explains('引き継ぎのワークフローの雛形の、起動の契機（`on`）のテストです。`on` が `pull_request_target` の `closed` だけであることを確認します。')
    stepSync('契機を比べる', () => {
      expect(workflow.on).toEqual({ pull_request_target: { types: ['closed'] } })
    })
  })

  it('job の if は、マージされた・同じリポの head・bot でない PR だけを通す', async () => {
    await explains('引き継ぎのワークフローの雛形の、job の `if` のテストです。マージされた PR、同じリポジトリの head、Bot ではない作成者の条件を含み、`env.` と `secrets.` を参照しないことを確認します。')
    stepSync('job の if を比べる', () => {
      expect(condition).toContain('github.event.pull_request.merged')
      expect(condition).toContain('github.event.pull_request.head.repo.full_name == github.repository')
      expect(condition).toContain('github.event.pull_request.user.type != \'Bot\'')
      expect(condition).not.toContain('env.')
      expect(condition).not.toContain('secrets.')
    })
  })

  it('PR のコードを checkout せず、既定のブランチを資格情報を残さずに読む', async () => {
    await explains('引き継ぎのワークフローの雛形の、checkout の step のテストです。checkout が 1 回だけで `persist-credentials: false` を指定し、PR の `head.sha` と `head.ref` を使わないことを確認します。')
    const checkouts = stepSync('checkout の step を集める', () => steps.filter(step => step.uses?.startsWith('actions/checkout@')))
    stepSync('checkout の数と指定を比べる', () => {
      expect(checkouts).toHaveLength(1)
      expect(checkouts[0]?.with).toEqual({ 'persist-credentials': false })
      expect(active).not.toContain('head.sha')
      expect(active).not.toContain('head.ref')
    })
  })

  it('workflow 全体の permissions を持たず、job の permissions は 4 つだけになる', async () => {
    await explains('引き継ぎのワークフローの雛形の、権限のテストです。workflow 全体の `permissions` を持たず、job の `permissions` が 4 つの権限だけであることを確認します。')
    stepSync('permissions を比べる', () => {
      expect(workflow).not.toHaveProperty('permissions')
      expect(job.permissions).toEqual({ 'contents': 'read', 'issues': 'write', 'pull-requests': 'read', 'id-token': 'write' })
    })
  })

  it('トークンの発行は変数のあるときだけ動き、Issues の write と Pull requests・Contents の read だけを渡す', async () => {
    await explains('引き継ぎのワークフローの雛形の、GitHub App のトークンを発行する step のテストです。`PECOT_AGENT_APP_CLIENT_ID` の設定時だけ動き、`issues` の write と `pull-requests`・`contents` の read だけを要求することを確認します。')
    const token = stepSync('トークンを発行する step を読む', () => stepUsing('actions/create-github-app-token'))
    stepSync('step の id・条件・要求する権限を比べる', () => {
      expect(token.id).toBe('token')
      expect(token.if).toBe('${{ vars.PECOT_AGENT_APP_CLIENT_ID != \'\' }}')
      const granted = Object.fromEntries(Object.entries(token.with ?? {}).filter(([key]) => key.startsWith('permission-')))
      expect(granted).toEqual({ 'permission-issues': 'write', 'permission-pull-requests': 'read', 'permission-contents': 'read' })
    })
  })

  it('発行したトークンが存在しない場合は、github_token と PECOT_GITHUB_COM_TOKEN に GITHUB_TOKEN を渡し、OIDC の交換を避ける', async () => {
    await explains('引き継ぎのワークフローの雛形の、action に渡すトークンのテストです。App のトークンが発行されない場合に、`github_token` と `PECOT_GITHUB_COM_TOKEN` の両方へ `github.token` を渡すことを確認します。')
    stepSync('action に渡すトークンを比べる', () => {
      expect(inputs['github_token']).toBe('${{ steps.token.outputs.token || github.token }}')
      expect(handoff.env).toEqual({ PECOT_GITHUB_COM_TOKEN: '${{ steps.token.outputs.token || github.token }}' })
    })
  })

  it('OAuth のトークンを渡し、secret があれば Workload Identity Federation の 4 つの入力を空で渡す', async () => {
    await explains('引き継ぎのワークフローの雛形の、Claude の認証（OAuth と Workload Identity Federation）の入力のテストです。`claude_code_oauth_token` へ secret を渡し、4 つの入力は secret の設定時に空文字で渡すことを確認します。')
    const federation: [string, string][] = [
      ['anthropic_federation_rule_id', 'FEDERATION_RULE_ID'],
      ['anthropic_organization_id', 'ORGANIZATION_ID'],
      ['anthropic_service_account_id', 'SERVICE_ACCOUNT_ID'],
      ['anthropic_workspace_id', 'WORKSPACE_ID'],
    ]
    stepSync('OAuth と Federation の入力を比べる', () => {
      expect(inputs['claude_code_oauth_token']).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')
      for (const [input, variable] of federation) {
        expect(new Map(Object.entries(inputs)).get(input)).toBe(`\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && vars.PECOT_AGENT_ANTHROPIC_${variable} || '' }}`)
      }
    })
  })

  it('action に、書き込み権限を持たない人を通す入力・追跡のモード・API キーを渡さない', async () => {
    await explains('引き継ぎのワークフローの雛形の、action の入力のテストです。`allowed_non_write_users`・`track_progress`・`anthropic_api_key`・`allowed_bots` のいずれも指定されていないことを確認します。')
    stepSync('action の入力に無いキーを比べる', () => {
      for (const key of ['allowed_non_write_users', 'track_progress', 'anthropic_api_key', 'allowed_bots']) {
        expect(inputs).not.toHaveProperty(key)
      }
    })
  })

  it('プラグインを配布のマーケットプレイスから取る', async () => {
    await explains('引き継ぎのワークフローの雛形の、プラグインの取得元のテストです。`plugin_marketplaces` が `https://github.com/pecotcraft/pecot.git`、`plugins` が `pecot-w@pecot` であることを確認します。')
    stepSync('プラグインの取得元を比べる', () => {
      expect(inputs['plugin_marketplaces']).toBe('https://github.com/pecotcraft/pecot.git')
      expect(inputs['plugins']).toBe('pecot-w@pecot')
    })
  })

  it('prompt は w-handoff に PR を渡し、変数 PECOT_HANDOFF_PROJECT が設定されている場合だけ project=<名前> を足す', async () => {
    await explains('引き継ぎのワークフローの雛形の、`prompt` のテストです。`/pecot-w:w-handoff` に PR を渡し、変数 `PECOT_HANDOFF_PROJECT` が設定されている場合だけ `project=<名前>` を付けることを確認します。')
    stepSync('prompt を比べる', () => {
      expect(inputs['prompt']).toBe('/pecot-w:w-handoff ${{ github.repository }}/${{ github.event.pull_request.number }}${{ vars.PECOT_HANDOFF_PROJECT != \'\' && format(\' project={0}\', vars.PECOT_HANDOFF_PROJECT) || \'\' }}')
    })
  })

  it('claude_args は権限のモード・モデル・effort・ターンの上限を、既定値の式で持つ', async () => {
    await explains('引き継ぎのワークフローの雛形の、`claude_args` のテストです。権限のモード・モデル・effort・ターンの上限が、変数と既定値を使った式で指定されていることを確認します。')
    stepSync('claude_args の指定を比べる', () => {
      expect(claudeArguments).toContain('--permission-mode default')
      expect(claudeArguments).toContain('--model ${{ vars.PECOT_HANDOFF_MODEL || \'opus\' }}')
      expect(claudeArguments).toContain('--effort ${{ vars.PECOT_HANDOFF_EFFORT || \'medium\' }}')
      expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_HANDOFF_MAX_TURNS || \'30\' }}')
      expect(claudeArguments).not.toContain('#')
    })
  })

  it('timeout-minutes は、変数を fromJSON で数に直す', async () => {
    await explains('引き継ぎのワークフローの雛形の、`timeout-minutes` のテストです。変数 `PECOT_HANDOFF_TIMEOUT_MINUTES` を `fromJSON` で数値に変換する式であることを確認します。')
    stepSync('timeout-minutes を比べる', () => {
      expect(job['timeout-minutes']).toBe('${{ fromJSON(vars.PECOT_HANDOFF_TIMEOUT_MINUTES || \'20\') }}')
    })
  })

  it('許可するツールは、PR と Issue を読むものとコメントの投稿だけになる', async () => {
    await explains('引き継ぎのワークフローの雛形の、`--allowedTools` のテストです。PR と Issue の参照、コメントの投稿、`gh pr diff`・`gh pr view` に限られていることを確認します。')
    const tools = stepSync('許可するツールの一覧を読む', () => toolList('--allowedTools'))
    stepSync('許可するツールを比べる', () => {
      expect(tools).toEqual([
        'Read',
        `${pecot}issue_comment_check`,
        official + 'issue_read',
        official + 'pull_request_read',
        official + 'issue_dependency_read',
        official + 'add_issue_comment',
        official + 'update_issue_comment',
        'Bash(gh pr diff:*)',
        'Bash(gh pr view:*)',
      ])
    })
  })

  it('公式の GitHub の MCP サーバを digest で固定した docker で起動し、ツールを絞って --mcp-config で渡す', async () => {
    await explains('公式の GitHub の MCP サーバの設定のテストです。`github-official` が docker で `ghcr.io/github/github-mcp-server` の v2.3.0 を digest つきで起動することを確認します。token・ホスト・ツールを env で渡し、`--mcp-config` に job の env の値を渡すことも確認します。')
    const server = stepSync('job の env から MCP サーバの設定を読む', (): unknown => JSON.parse(job.env?.['PECOT_HANDOFF_GITHUB_MCP'] ?? ''))
    const image = 'ghcr.io/github/github-mcp-server:v2.3.0@sha256:f8ee4dedc7d5c8cb32854ab91cc92a31c55a8a5510708cf8742e9f9427588ca6'
    stepSync('サーバの設定と --mcp-config の指定を比べる', () => {
      expect(server).toEqual({
        mcpServers: {
          'github-official': {
            type: 'stdio',
            command: 'docker',
            args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_HOST', '-e', 'GITHUB_TOOLS', '-e', 'GITHUB_FEATURES', image],
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: '${PECOT_GITHUB_COM_TOKEN}',
              GITHUB_HOST: '${{ github.server_url }}',
              GITHUB_TOOLS: 'issue_read,issue_dependency_read,add_issue_comment,update_issue_comment,pull_request_read',
              GITHUB_FEATURES: 'issue_dependencies',
            },
          },
        },
      })
      expect(claudeArguments).toContain('--mcp-config \'${{ env.PECOT_HANDOFF_GITHUB_MCP }}\'')
    })
  })

  it('書き換え・外部からの取得・clone・/proc の読み取りを拒否する', async () => {
    await explains('引き継ぎのワークフローの雛形の、`--disallowedTools` のテストです。`Edit`・`Write`・`WebFetch`・`git clone`・`/proc` の読み取りなどを拒否する一覧であることを確認します。')
    const tools = stepSync('拒否するツールの一覧を読む', () => toolList('--disallowedTools'))
    stepSync('拒否するツールを比べる', () => {
      expect(tools).toEqual([
        'Edit',
        'Write',
        'NotebookEdit',
        'AskUserQuestion',
        'Agent',
        'WebFetch',
        'WebSearch',
        'Bash(git clone:*)',
        'Read(//proc/**)',
      ])
    })
  })

  it('settings は、使われた effort を RUNNER_TEMP のファイルに書く PreToolUse のフックだけを持つ', async () => {
    await explains('引き継ぎのワークフローの雛形の、`settings` のテストです。使われた effort を `RUNNER_TEMP` のファイルへ書き出す `PreToolUse` のフックだけを持つことを確認します。')
    const settings = stepSync('settings の入力を読む', (): unknown => JSON.parse(text(inputs['settings'])))
    stepSync('settings を比べる', () => {
      expect(settings).toEqual({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'printf %s "$CLAUDE_EFFORT" > "$RUNNER_TEMP/pecot-handoff-effort"' }] }],
        },
      })
    })
  })

  it('記録の step は、action の直後に置かれ、実行のファイルのある run で動き、失敗しても job を失敗にしない', async () => {
    await explains('引き継ぎのワークフローの雛形の、実行の記録を出す step のテストです。action の直後の最後の step であり、実行ファイルが存在する場合に動き、失敗しても job を失敗にしないことを確認します。')
    stepSync('記録の step の位置と指定を比べる', () => {
      expect(steps.at(-1)).toBe(record)
      expect(steps[steps.indexOf(handoff) + 1]).toBe(record)
      expect(record.if).toBe('${{ always() && steps.claude.outputs.execution_file != \'\' }}')
      expect(record['continue-on-error']).toBe(true)
      expect(record.env).toEqual({ EXECUTION_FILE: '${{ steps.claude.outputs.execution_file }}' })
      expect(record.run).not.toContain('${{')
    })
  })

  it('記録の jq は、モデル・effort・ツールの呼び出し・拒否を表に出し、コメントの本文を出さない', async () => {
    await explains('実行の記録を作る `jq` の式のテストです。模擬した実行ログを渡した場合に、モデル・effort・ツールの呼び出し・拒否を表に出力し、コメントの本文や考えた文は出力しないことを確認します。')
    const summary = stepSync('模擬した実行ログを記録の jq に渡す', () => {
      const filter = /jq -r --arg effort "\$effort" '([^']*)'/.exec(record.run ?? '')?.[1] ?? ''
      const execution = [
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { content: [
          { type: 'text', text: '考えた文' },
          { type: 'tool_use', name: `${pecot}issue_comment_check`, input: { issue_number: 7 } },
          { type: 'tool_use', name: `${pecot}issue_comment`, input: { issue_ref: 'o/r/1', template: 'merge-diff', message: '本文の中身' } },
        ] } },
        { type: 'result', subtype: 'success', num_turns: 3, permission_denials: [
          { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'gh issue close 1' } },
        ] },
      ]
      const output = execFileSync('jq', ['-r', '--arg', 'effort', 'medium', filter], { input: JSON.stringify(execution), encoding: 'utf8' })
      attachOutput('jq（Handoff run の要約）', 0, output, '')
      return output
    })
    stepSync('要約の表を比べる', () => {
      expect(summary).toContain('## Handoff run')
      expect(summary).toContain('| `claude-opus-5-5` | `medium` | `3` | `success` |')
      expect(summary).toContain(`| 1 | \`${pecot}issue_comment_check\` | \`issue_number\` |`)
      expect(summary).toContain(`| 2 | \`${pecot}issue_comment\` | \`o/r/1\` |`)
      expect(summary).toContain('| `Bash` | `gh issue close 1` |')
      for (const hidden of ['考えた文', '本文の中身']) expect(summary).not.toContain(hidden)
    })
  })

  it('setup-node は、secret を持つ job なので npm のキャッシュを戻さず保存もしない', async () => {
    await explains('引き継ぎのワークフローの雛形の、`actions/setup-node` のテストです。secret を持つ job のため、`package-manager-cache` が `false` で、npm のキャッシュを使わないことを確認します。')
    const setupNode = stepSync('setup-node の step を読む', () => stepUsing('actions/setup-node'))
    stepSync('package-manager-cache を比べる', () => {
      expect(setupNode.with?.['package-manager-cache']).toBe(false)
    })
  })

  it('すべての action を 40 桁の SHA で固定する', async () => {
    await explains('引き継ぎのワークフローの雛形の、action の指定のテストです。使っているすべての action が、40 桁の SHA で固定されていることを確認します。')
    const uses = stepSync('step が使う action を集める', () => steps.map(step => step.uses).filter(use => use !== undefined))
    stepSync('action の指定を比べる', () => {
      expect(uses.length).toBeGreaterThan(0)
      for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
    })
  })
})

describe('引き継ぎの導入の説明', () => {
  it('説明のファイルが w-help の参照にある', async () => {
    await explains('引き継ぎの導入の説明のテストです。説明のファイル `skills/w-help/references/handoff-workflow.md` が存在することを確認します。')
    const isExisting = stepSync('説明のファイルの有無を調べる', () => existsSync(documentPath))
    stepSync('ファイルが存在することを比べる', () => {
      expect(isExisting).toBe(true)
    })
  })

  it('雛形の変数と secret の名前が、すべて説明に記載されている', async () => {
    await explains('引き継ぎの導入の説明のテストです。雛形が参照する変数と secret の名前がすべて説明に記載され、`PECOT_HANDOFF_` で始まる変数が 5 つであることを確認します。')
    const names = stepSync('雛形が参照する変数と secret の名前を集める', () => new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.([A-Z][A-Z0-9_]+)/g), match => match[1] ?? '')))
    stepSync('名前が説明に記載されていることを比べる', () => {
      for (const name of names) {
        const isDocumented = document.includes(`\`${name}\``) || (name.startsWith('PECOT_AGENT_') && document.includes('review-workflow.md'))
        expect(isDocumented, `${name} が説明に無い`).toBe(true)
      }
      expect([...names].filter(name => name.startsWith('PECOT_HANDOFF_')).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'PECOT_HANDOFF_EFFORT',
        'PECOT_HANDOFF_MAX_TURNS',
        'PECOT_HANDOFF_MODEL',
        'PECOT_HANDOFF_PROJECT',
        'PECOT_HANDOFF_TIMEOUT_MINUTES',
      ])
    })
  })

  it('変数の既定値が、説明の「変えられる値」の表の同じ行にある', async () => {
    await explains('引き継ぎの導入の説明の、「変えられる値」の表のテストです。雛形の変数の既定値が、説明の表の同じ変数の行に記載されていることを確認します。')
    const { defaults, rows } = stepSync('雛形の既定値と説明の表を読む', () => ({
      defaults: new Map(Array.from(active.matchAll(/vars\.(PECOT_HANDOFF_[A-Z_]+) \|\| '([^']*)'/g), match => [match[1] ?? '', match[2] ?? ''])),
      rows: markdownSection(document, '### 変えられる値').split('\n'),
    }))
    stepSync('既定値と表の行を比べる', () => {
      expect(new Set(defaults.keys())).toEqual(new Set(['PECOT_HANDOFF_EFFORT', 'PECOT_HANDOFF_MAX_TURNS', 'PECOT_HANDOFF_MODEL', 'PECOT_HANDOFF_TIMEOUT_MINUTES']))
      for (const [name, value] of defaults) {
        const row = rows.find(line => line.startsWith(`| \`${name}\` |`))
        expect(row, `${name} の行が説明の表に無い`).toBeDefined()
        expect(row).toContain(`\`${value}\``)
      }
      expect(rows.some(line => line.startsWith('| `PECOT_HANDOFF_PROJECT` |'))).toBe(true)
    })
  })

  it('job の権限が、説明の「権限」の表と一致する', async () => {
    await explains('引き継ぎの導入の説明の、「権限」の表のテストです。雛形の job の権限が、「job の権限」の行にすべて記載されていることを確認します。')
    const row = stepSync('「job の権限」の行を読む', () => tableRow('job の権限'))
    stepSync('権限が行に記載されていることを比べる', () => {
      const scopes = Object.entries(job.permissions ?? {})
      for (const [scope, access] of scopes) expect(row).toContain(`\`${scope}: ${access}\``)
    })
  })

  it('許可するツールと拒否するツールが、説明の「権限」の表に記載されている', async () => {
    await explains('引き継ぎの導入の説明の、「権限」の表のテストです。雛形が許可するツールと拒否するツールが、それぞれの行にすべて記載されていることを確認します。')
    const { allowedRow, deniedRow } = stepSync('許すツールと拒むツールの行を読む', () => ({ allowedRow: tableRow('許すツール'), deniedRow: tableRow('拒むツール') }))
    stepSync('許可するツールが行に記載されていることを比べる', () => {
      for (const tool of toolList('--allowedTools')) {
        const shown = tool.replace(pecot, '').replace(/^Bash\((.*):\*\)$/, '$1')
        expect(allowedRow, `${tool} が許すツールの行に無い`).toContain(`\`${shown}\``)
      }
    })
    stepSync('拒否するツールが行に記載されていることを比べる', () => {
      for (const tool of toolList('--disallowedTools')) {
        const shown = tool === 'Read(//proc/**)' ? '/proc' : tool.replace(/^Bash\((.*):\*\)$/, '$1')
        expect(deniedRow, `${tool} が拒むツールの行に無い`).toContain(`\`${shown}\``)
      }
    })
  })

  it('自前の App の権限が、説明の「自前の GitHub App」の節と一致する', async () => {
    await explains('引き継ぎの導入の説明の、「自前の GitHub App」の節のテストです。トークンを発行する step の権限が、節に記載された App の権限の一覧と一致することを確認します。')
    const { fromTemplate, permissionLines } = stepSync('雛形と説明の App の権限を読む', () => {
      const labels = new Map([['issues', 'Issues'], ['pull-requests', 'Pull requests'], ['contents', 'Contents']])
      const fromTemplate = Object.entries(stepUsing('actions/create-github-app-token').with ?? {})
        .filter(([key]) => key.startsWith('permission-'))
        .map(([key, access]) => {
          const name = key.slice('permission-'.length)
          return `${labels.get(name) ?? name}: ${String(access) === 'write' ? 'read and write' : 'read'}`
        })
      const lines = markdownSection(document, '## 自前の GitHub App').split('\n')
      const permissionLines = lines.slice(lines.findIndex(line => line.includes('App の権限')) + 1)
        .filter(line => line.startsWith('  - '))
        .map(line => line.slice('  - '.length))
      return { fromTemplate, permissionLines }
    })
    stepSync('権限の一覧を比べる', () => {
      expect(permissionLines).toEqual(fromTemplate)
    })
  })

  it('雛形の名前で workflow_install と workflow_doctor を呼ぶ手順がある', async () => {
    await explains('引き継ぎの導入の説明のテストです。`name: "handoff"` を指定して `workflow_install` と `workflow_doctor` を呼ぶ手順が、説明に記載されていることを確認します。')
    stepSync('説明の手順を比べる', () => {
      expect(document).toContain('`workflow_install`（`name: "handoff"`）')
      expect(document).toContain('`workflow_doctor`（`name: "handoff"`）')
    })
  })
})
