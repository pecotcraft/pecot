// 配布する引き継ぎのワークフローの雛形が、安全な形と文書との一致を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { markdownSection } from './_helpers/markdown-section.js'

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
  it('1 行目に、雛形の名前と版の目印がある', () => {
    expect(template.split('\n', 1)[0]).toBe('# pecot-workflow-template: handoff 1')
  })

  it('契機は pull_request_target の closed だけになる', () => {
    expect(workflow.on).toEqual({ pull_request_target: { types: ['closed'] } })
  })

  it('job の if は、マージされた・同じリポの head・bot でない PR だけを通す', () => {
    expect(condition).toContain('github.event.pull_request.merged')
    expect(condition).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(condition).toContain('github.event.pull_request.user.type != \'Bot\'')
    expect(condition).not.toContain('env.')
    expect(condition).not.toContain('secrets.')
  })

  it('PR のコードを checkout せず、既定のブランチを資格情報を残さずに読む', () => {
    const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]?.with).toEqual({ 'persist-credentials': false })
    expect(active).not.toContain('head.sha')
    expect(active).not.toContain('head.ref')
  })

  it('workflow 全体の permissions を持たず、job の permissions は 4 つだけになる', () => {
    expect(workflow).not.toHaveProperty('permissions')
    expect(job.permissions).toEqual({ 'contents': 'read', 'issues': 'write', 'pull-requests': 'read', 'id-token': 'write' })
  })

  it('トークンの発行は変数のあるときだけ動き、Issues の write と Pull requests・Contents の read だけを渡す', () => {
    const token = stepUsing('actions/create-github-app-token')
    expect(token.id).toBe('token')
    expect(token.if).toBe('${{ vars.PECOT_AGENT_APP_CLIENT_ID != \'\' }}')
    const granted = Object.fromEntries(Object.entries(token.with ?? {}).filter(([key]) => key.startsWith('permission-')))
    expect(granted).toEqual({ 'permission-issues': 'write', 'permission-pull-requests': 'read', 'permission-contents': 'read' })
  })

  it('発行したトークンが無いとき、github_token を空で渡して Claude の App を使い、PECOT_GITHUB_COM_TOKEN は GITHUB_TOKEN を使う', () => {
    expect(inputs['github_token']).toBe('${{ steps.token.outputs.token }}')
    expect(handoff.env).toEqual({ PECOT_GITHUB_COM_TOKEN: '${{ steps.token.outputs.token || github.token }}' })
  })

  it('OAuth のトークンを渡し、secret があれば Workload Identity Federation の 4 つの入力を空で渡す', () => {
    expect(inputs['claude_code_oauth_token']).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')
    const federation: [string, string][] = [
      ['anthropic_federation_rule_id', 'FEDERATION_RULE_ID'],
      ['anthropic_organization_id', 'ORGANIZATION_ID'],
      ['anthropic_service_account_id', 'SERVICE_ACCOUNT_ID'],
      ['anthropic_workspace_id', 'WORKSPACE_ID'],
    ]
    for (const [input, variable] of federation) {
      expect(new Map(Object.entries(inputs)).get(input)).toBe(`\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && vars.PECOT_AGENT_ANTHROPIC_${variable} || '' }}`)
    }
  })

  it('action に、書き込み権限の無い人を通す入力・追跡のモード・API キーを渡さない', () => {
    for (const key of ['allowed_non_write_users', 'track_progress', 'anthropic_api_key', 'allowed_bots']) {
      expect(inputs).not.toHaveProperty(key)
    }
  })

  it('プラグインを配布のマーケットプレイスから取る', () => {
    expect(inputs['plugin_marketplaces']).toBe('https://github.com/pecotcraft/pecot.git')
    expect(inputs['plugins']).toBe('pecot-w@pecot')
  })

  it('prompt は w-handoff に PR を渡し、変数 PECOT_HANDOFF_PROJECT のあるときだけ project=<名前> を足す', () => {
    expect(inputs['prompt']).toBe('/pecot-w:w-handoff ${{ github.repository }}/${{ github.event.pull_request.number }}${{ vars.PECOT_HANDOFF_PROJECT != \'\' && format(\' project={0}\', vars.PECOT_HANDOFF_PROJECT) || \'\' }}')
  })

  it('claude_args は権限のモード・モデル・effort・ターンの上限を、既定値の式で持つ', () => {
    expect(claudeArguments).toContain('--permission-mode default')
    expect(claudeArguments).toContain('--model ${{ vars.PECOT_HANDOFF_MODEL || \'opus\' }}')
    expect(claudeArguments).toContain('--effort ${{ vars.PECOT_HANDOFF_EFFORT || \'medium\' }}')
    expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_HANDOFF_MAX_TURNS || \'30\' }}')
    expect(claudeArguments).not.toContain('#')
  })

  it('timeout-minutes は、変数を fromJSON で数に直す', () => {
    expect(job['timeout-minutes']).toBe('${{ fromJSON(vars.PECOT_HANDOFF_TIMEOUT_MINUTES || \'20\') }}')
  })

  it('許すツールは、PR と Issue を読むものとコメントの投稿だけになる', () => {
    expect(toolList('--allowedTools')).toEqual([
      'Read',
      `${pecot}pr_show`,
      `${pecot}issue_show`,
      `${pecot}issue_comment`,
      'Bash(gh pr diff:*)',
      'Bash(gh pr view:*)',
    ])
  })

  it('書き換え・外への取得・clone・/proc の読みを拒む', () => {
    expect(toolList('--disallowedTools')).toEqual([
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

  it('settings は、使われた effort を RUNNER_TEMP のファイルに書く PreToolUse のフックだけを持つ', () => {
    const settings: unknown = JSON.parse(text(inputs['settings']))
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'printf %s "$CLAUDE_EFFORT" > "$RUNNER_TEMP/pecot-handoff-effort"' }] }],
      },
    })
  })

  it('記録の step は、action の直後に置かれ、実行のファイルのある run で動き、失敗しても job を失敗にしない', () => {
    expect(steps.at(-1)).toBe(record)
    expect(steps[steps.indexOf(handoff) + 1]).toBe(record)
    expect(record.if).toBe('${{ always() && steps.claude.outputs.execution_file != \'\' }}')
    expect(record['continue-on-error']).toBe(true)
    expect(record.env).toEqual({ EXECUTION_FILE: '${{ steps.claude.outputs.execution_file }}' })
    expect(record.run).not.toContain('${{')
  })

  it('記録の jq は、モデル・effort・ツールの呼び出し・拒否を表に出し、コメントの本文を出さない', () => {
    const filter = /jq -r --arg effort "\$effort" '([^']*)'/.exec(record.run ?? '')?.[1] ?? ''
    const execution = [
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
      { type: 'assistant', message: { content: [
        { type: 'text', text: '考えた文' },
        { type: 'tool_use', name: `${pecot}pr_show`, input: { pr_ref: 'o/r/7' } },
        { type: 'tool_use', name: `${pecot}issue_comment`, input: { issue_ref: 'o/r/1', template: 'merge-diff', message: '本文の中身' } },
      ] } },
      { type: 'result', subtype: 'success', num_turns: 3, permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'gh issue close 1' } },
      ] },
    ]
    const summary = execFileSync('jq', ['-r', '--arg', 'effort', 'medium', filter], { input: JSON.stringify(execution), encoding: 'utf8' })
    expect(summary).toContain('## Handoff run')
    expect(summary).toContain('| `claude-opus-5-5` | `medium` | `3` | `success` |')
    expect(summary).toContain(`| 1 | \`${pecot}pr_show\` | \`o/r/7\` |`)
    expect(summary).toContain(`| 2 | \`${pecot}issue_comment\` | \`o/r/1\` |`)
    expect(summary).toContain('| `Bash` | `gh issue close 1` |')
    for (const hidden of ['考えた文', '本文の中身']) expect(summary).not.toContain(hidden)
  })

  it('setup-node は、secret を持つ job なので npm のキャッシュを戻さず保存もしない', () => {
    expect(stepUsing('actions/setup-node').with?.['package-manager-cache']).toBe(false)
  })

  it('すべての action を 40 桁の SHA で固定する', () => {
    const uses = steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })
})

describe('引き継ぎの導入の説明', () => {
  it('説明のファイルが w-help の参照にある', () => {
    expect(existsSync(documentPath)).toBe(true)
  })

  it('雛形の変数と secret の名前が、すべて説明に出てくる', () => {
    const names = new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.([A-Z][A-Z0-9_]+)/g), match => match[1] ?? ''))
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

  it('変数の既定値が、説明の「変えられる値」の表の同じ行にある', () => {
    const defaults = new Map(Array.from(active.matchAll(/vars\.(PECOT_HANDOFF_[A-Z_]+) \|\| '([^']*)'/g), match => [match[1] ?? '', match[2] ?? '']))
    expect(new Set(defaults.keys())).toEqual(new Set(['PECOT_HANDOFF_EFFORT', 'PECOT_HANDOFF_MAX_TURNS', 'PECOT_HANDOFF_MODEL', 'PECOT_HANDOFF_TIMEOUT_MINUTES']))
    const rows = markdownSection(document, '### 変えられる値').split('\n')
    for (const [name, value] of defaults) {
      const row = rows.find(line => line.startsWith(`| \`${name}\` |`))
      expect(row, `${name} の行が説明の表に無い`).toBeDefined()
      expect(row).toContain(`\`${value}\``)
    }
    expect(rows.some(line => line.startsWith('| `PECOT_HANDOFF_PROJECT` |'))).toBe(true)
  })

  it('job の権限が、説明の「権限」の表と一致する', () => {
    const row = tableRow('job の権限')
    const scopes = Object.entries(job.permissions ?? {})
    for (const [scope, access] of scopes) expect(row).toContain(`\`${scope}: ${access}\``)
  })

  it('許すツールと拒むツールが、説明の「権限」の表に出てくる', () => {
    const allowedRow = tableRow('許すツール')
    for (const tool of toolList('--allowedTools')) {
      const shown = tool.replace(pecot, '').replace(/^Bash\((.*):\*\)$/, '$1')
      expect(allowedRow, `${tool} が許すツールの行に無い`).toContain(`\`${shown}\``)
    }
    const deniedRow = tableRow('拒むツール')
    for (const tool of toolList('--disallowedTools')) {
      const shown = tool === 'Read(//proc/**)' ? '/proc' : tool.replace(/^Bash\((.*):\*\)$/, '$1')
      expect(deniedRow, `${tool} が拒むツールの行に無い`).toContain(`\`${shown}\``)
    }
  })

  it('自前の App の権限が、説明の「自前の GitHub App」の節と食い違わない', () => {
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
    expect(permissionLines).toEqual(fromTemplate)
  })

  it('雛形の名前で workflow_install と workflow_doctor を呼ぶ手順がある', () => {
    expect(document).toContain('`workflow_install`（`name: "handoff"`）')
    expect(document).toContain('`workflow_doctor`（`name: "handoff"`）')
  })
})
