// 配布する自動レビューのワークフローの雛形が、specs/027-auto-revise-on-pr/contracts/workflow-template.md の形を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-review.yml'), 'utf8')

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
  'if'?: string
  'timeout-minutes'?: string
  'concurrency'?: Record<string, unknown>
  'permissions'?: Record<string, string>
  'env'?: Record<string, string>
  'steps': Step[]
}
interface Workflow {
  on: Record<string, { types?: string[] } | null>
  jobs: Record<string, Job>
}

// parse は unknown を返す。雛形は下のテストが形を確かめる。
// eslint-disable-next-line no-restricted-syntax
const workflow = parse(template) as Workflow
const job: Job = workflow.jobs['review'] ?? { steps: [] }
const steps = job.steps
const condition = job.if ?? ''
const phrase = 'vars.PECOT_REVIEW_TRIGGER_PHRASE || \'@pecotbot review\''

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stepUsing(action: string): Step {
  const step = steps.find(candidate => candidate.uses?.startsWith(`${action}@`))
  expect(step, `${action} の step が無い`).toBeDefined()
  return step ?? {}
}

const review = stepUsing('anthropics/claude-code-action')
const reviewInputs = review.with ?? {}
const claudeArguments = text(reviewInputs['claude_args'])
const finish = steps.find(step => step.run?.includes('review finish') === true) ?? {}
const checkPr = steps.find(step => step.id === 'pr') ?? {}

// job の if を、event_name の比べで始まる 2 つの枝に分ける。
function branch(event: string): string {
  const start = condition.indexOf(`github.event_name == '${event}'`)
  expect(start, `${event} の枝が無い`).toBeGreaterThanOrEqual(0)
  const others = ['pull_request', 'issue_comment'].filter(name => name !== event)
  const ends = others.map(name => condition.indexOf(`github.event_name == '${name}'`, start)).filter(index => index > start)
  return condition.slice(start, ends.length > 0 ? Math.min(...ends) : undefined)
}

function toolList(flag: string): string[] {
  const start = claudeArguments.indexOf(`${flag} "`)
  expect(start, `${flag} が claude_args に無い`).toBeGreaterThanOrEqual(0)
  const valueStart = start + flag.length + 2
  const value = claudeArguments.slice(valueStart, claudeArguments.indexOf('"', valueStart))
  return value.replaceAll(/\$\{\{.*?\}\}/g, '').split(',').map(tool => tool.trim()).filter(tool => tool !== '')
}

describe('review のワークフローの雛形', () => {
  it('1 行目に、雛形の名前と版の目印がある', () => {
    expect(template.split('\n', 1)[0]).toMatch(/^# pecot-workflow-template: review \d+$/)
  })

  it('YAML として読めると、review の job を持つ', () => {
    expect(steps.length).toBeGreaterThan(0)
  })

  it('pull_request_target の契機を持たない', () => {
    expect(workflow.on).not.toHaveProperty('pull_request_target')
  })

  it('契機は pull_request の opened・ready_for_review と、issue_comment の created だけになる', () => {
    expect(Object.keys(workflow.on).toSorted((a, b) => a.localeCompare(b))).toEqual(['issue_comment', 'pull_request'])
    expect(workflow.on['pull_request']?.types).toEqual(['opened', 'ready_for_review'])
    expect(workflow.on['issue_comment']?.types).toEqual(['created'])
  })

  it('pull_request の枝は、fork・draft・bot の判定を持つ', () => {
    const pullRequest = branch('pull_request')
    expect(pullRequest).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(pullRequest).toContain('github.event.pull_request.draft')
    expect(pullRequest).toContain('contains(fromJSON(vars.PECOT_REVIEW_ALLOWED_BOTS || \'[]\'), github.event.pull_request.user.login)')
  })

  it('issue_comment の枝は、PR へのコメント・人・author_association・合言葉の 4 つの比べ方を持つ', () => {
    const comment = branch('issue_comment')
    expect(comment).toContain('github.event.issue.pull_request')
    expect(comment).toContain('github.event.comment.user.type != \'Bot\'')
    expect(comment).toContain('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association)')
    expect(comment).toContain(`github.event.comment.body == (${phrase})`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0} ', ${phrase}))`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0}{1}', ${phrase}, fromJSON('"\\n"')))`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0}{1}', ${phrase}, fromJSON('"\\r\\n"')))`)
  })

  it('issue_comment の run は PR を確かめ、checkout はその head.sha を読む', () => {
    expect(checkPr.if).toContain('github.event_name == \'issue_comment\'')
    expect(checkPr.run).toContain('GITHUB_OUTPUT')
    const checkout = stepUsing('actions/checkout')
    expect(checkout.with?.['ref']).toBe('${{ github.event.pull_request.head.sha || steps.pr.outputs.sha }}')
    expect(checkout.with?.['fetch-depth']).toBe(1)
    expect(checkout.with?.['persist-credentials']).toBe(false)
    const afterCheck = steps.slice(steps.indexOf(checkPr) + 1)
    for (const step of afterCheck) {
      if (step === finish) continue
      expect(step.if, `${step.name ?? ''} が PR の確かめの結果を見ない`).toContain('steps.pr.outputs.ok == \'true\'')
    }
  })

  it('PR の確かめは書いた人の権限を読み、admin・maintain・write のときだけ通す', () => {
    expect(checkPr.env?.['COMMENTER']).toBe('${{ github.event.comment.user.login }}')
    expect(checkPr.run).toContain('collaborators/$COMMENTER/permission')
    expect(checkPr.run).toContain('admin|maintain|write) ok=true')
  })

  it('PR の確かめは、API の失敗をプロセス置換で握りつぶさない', () => {
    expect(checkPr.run).not.toContain('< <(')
    expect(checkPr.run).toContain('pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR")')
    expect(checkPr.run).not.toContain('${{')
  })

  it('job の if・timeout-minutes・concurrency は env を読まない', () => {
    expect(condition).not.toContain('env.')
    expect(job['timeout-minutes']).not.toContain('env.')
    expect(JSON.stringify(job.concurrency)).not.toContain('env.')
  })

  it('利用者が変える 4 つの変数に、既定値の式がある', () => {
    expect(template).toContain(phrase)
    expect(template).toContain('vars.PECOT_REVIEW_ALLOWED_BOTS || \'[]\'')
    expect(template).toContain('vars.PECOT_REVIEW_MAX_TURNS || \'60\'')
    expect(template).toContain('vars.PECOT_REVIEW_TIMEOUT_MINUTES || \'30\'')
  })

  it('timeout-minutes は、変数を fromJSON で数に直す', () => {
    expect(job['timeout-minutes']).toBe('${{ fromJSON(vars.PECOT_REVIEW_TIMEOUT_MINUTES || \'30\') }}')
  })

  it('action に、書き込み権限の無い人を通す入力・追跡のモード・API キーを渡さない', () => {
    for (const key of ['allowed_non_write_users', 'track_progress', 'anthropic_api_key', 'restrict_untrusted_prs']) {
      expect(reviewInputs).not.toHaveProperty(key)
    }
  })

  it('OAuth のトークンを渡し、secret があれば Workload Identity Federation の 4 つの入力を空で渡す', () => {
    expect(reviewInputs['claude_code_oauth_token']).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')
    const federation: [string, string][] = [
      ['anthropic_federation_rule_id', 'FEDERATION_RULE_ID'],
      ['anthropic_organization_id', 'ORGANIZATION_ID'],
      ['anthropic_service_account_id', 'SERVICE_ACCOUNT_ID'],
      ['anthropic_workspace_id', 'WORKSPACE_ID'],
    ]
    for (const [input, variable] of federation) {
      expect(new Map(Object.entries(reviewInputs)).get(input)).toBe(`\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && vars.PECOT_AGENT_ANTHROPIC_${variable} || '' }}`)
    }
  })

  it('classify_inline_comments は "false" になる', () => {
    expect(reviewInputs['classify_inline_comments']).toBe('false')
  })

  it('issue_comment の run は、PR の確かめの後で合言葉のコメントに eyes のリアクションを付ける', () => {
    const acknowledge = steps.find(step => step.run?.includes('content=eyes') === true)
    expect(acknowledge).toBeDefined()
    expect(steps.indexOf(acknowledge ?? {})).toBeGreaterThan(steps.indexOf(checkPr))
    expect(acknowledge?.if).toContain('github.event_name == \'issue_comment\'')
    expect(acknowledge?.if).toContain('steps.pr.outputs.ok == \'true\'')
    expect(acknowledge?.run).not.toContain('${{')
  })

  it('prompt は、PR の本文・タイトル・ブランチ名・コメントを埋め込まない', () => {
    const prompt = text(reviewInputs['prompt'])
    expect(prompt).toContain('/pecot-w:w-review ')
    for (const field of ['pull_request.body', 'pull_request.title', 'head.ref', 'comment.body', 'issue.title', 'issue.body']) {
      expect(prompt).not.toContain(field)
    }
  })

  it('job の permissions は contents: read・pull-requests: write・id-token: write だけになる', () => {
    expect(job.permissions).toEqual({ 'contents': 'read', 'pull-requests': 'write', 'id-token': 'write' })
  })

  it('トークンの発行は変数のあるときだけ動き、Pull requests の write と Contents の read だけを渡す', () => {
    const token = stepUsing('actions/create-github-app-token')
    expect(token.id).toBe('token')
    expect(token.if).toBe('${{ vars.PECOT_AGENT_APP_CLIENT_ID != \'\' }}')
    const granted = Object.fromEntries(Object.entries(token.with ?? {}).filter(([key]) => key.startsWith('permission-')))
    expect(granted).toEqual({ 'permission-pull-requests': 'write', 'permission-contents': 'read' })
  })

  it('発行したトークンが無いとき、github_token を空で渡して Claude の App を使い、PECOT_GITHUB_COM_TOKEN は GITHUB_TOKEN を使う', () => {
    expect(reviewInputs['github_token']).toBe('${{ steps.token.outputs.token }}')
    const fallback = '${{ steps.token.outputs.token || github.token }}'
    expect(review.env?.['PECOT_GITHUB_COM_TOKEN']).toBe(fallback)
    expect(finish.env?.['PECOT_GITHUB_COM_TOKEN']).toBe(fallback)
    expect(checkPr.env?.['GH_TOKEN']).toBe(fallback)
  })

  it('job に timeout-minutes と、PR の番号ごとの concurrency がある', () => {
    expect(job).toHaveProperty('timeout-minutes')
    expect(job.concurrency).toEqual({
      'group': 'pecot-review-${{ github.event.pull_request.number || github.event.issue.number }}',
      'cancel-in-progress': false,
    })
  })

  it('claude_args は権限のモード・ターンの上限・許可・拒否を持ち、コメントの行を含まない', () => {
    expect(claudeArguments).toContain('--permission-mode default')
    expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_REVIEW_MAX_TURNS || \'60\' }}')
    expect(claudeArguments).toContain('--allowedTools "')
    expect(claudeArguments).toContain('--disallowedTools "')
    expect(claudeArguments).not.toContain('#')
  })

  it('Edit・Write は拒否され、Bash は gh api だけを許す', () => {
    const allowed = toolList('--allowedTools')
    const disallowed = toolList('--disallowedTools')
    for (const tool of ['Bash', 'Edit', 'Write']) expect(allowed).not.toContain(tool)
    expect(allowed.filter(tool => tool.startsWith('Bash'))).toEqual(['Bash(gh api:*)'])
    expect(disallowed).toEqual(['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'Agent', 'WebFetch', 'WebSearch'])
  })

  it('許可は契約のツールだけで、マージ・クローズ・リリースのツールを含まない', () => {
    const allowed = toolList('--allowedTools')
    const pecot = 'mcp__plugin_pecot-w_pecot-workflow__'
    expect(allowed).toEqual([
      'Read',
      'Glob',
      'Grep',
      `${pecot}pr_show`,
      `${pecot}issue_show`,
      `${pecot}issue_comment`,
      'Bash(gh api:*)',
    ])
    for (const tool of allowed) expect(tool).not.toMatch(/merge|close|release|session_finish|branch_delete/)
  })

  it('利用者が足す許可は、job の env の変数から --allowedTools の末尾に足す', () => {
    expect(job.env).toEqual({ PECOT_REVIEW_EXTRA_ALLOWED_TOOLS: '' })
    expect(claudeArguments).toContain('${{ env.PECOT_REVIEW_EXTRA_ALLOWED_TOOLS != \'\' && format(\',{0}\', env.PECOT_REVIEW_EXTRA_ALLOWED_TOOLS) || \'\' }}"')
  })

  it('利用者が足す行は、開始と終了の印のコメントで囲む', () => {
    for (const area of ['allowed-tools', 'prepare']) {
      const begin = template.indexOf(`# pecot-review:${area}:begin`)
      const end = template.indexOf(`# pecot-review:${area}:end`)
      expect(begin, `${area} の開始の印が無い`).toBeGreaterThanOrEqual(0)
      expect(end, `${area} の終了の印が無い`).toBeGreaterThan(begin)
    }
  })

  it('後始末の step は if: always() で動き、式を run に埋め込まない', () => {
    expect(finish.if).toBe('${{ always() }}')
    expect(finish.run).not.toContain('${{')
    expect(finish.run).toContain('"$GITHUB_REPOSITORY/$PR" --ensure --job-status "$JOB_STATUS" --review-outcome "$REVIEW_OUTCOME" --review-conclusion "$REVIEW_CONCLUSION" --review-has-token "$REVIEW_HAS_TOKEN"')
  })

  it('後始末の step は自動レビューの 4 つの値を env で受け、トークンの値そのものは受けない', () => {
    expect(finish.env).toMatchObject({
      JOB_STATUS: '${{ job.status }}',
      REVIEW_OUTCOME: '${{ steps.claude.outcome }}',
      REVIEW_CONCLUSION: '${{ steps.claude.outputs.conclusion }}',
      REVIEW_HAS_TOKEN: '${{ steps.claude.outputs.github_token != \'\' }}',
    })
    const finishValues = Object.values(finish.env ?? {})
    for (const value of finishValues) {
      expect(value).not.toBe('${{ steps.claude.outputs.github_token }}')
    }
  })

  it('後始末の step は、実行のファイル・最初の step が記録した開始時刻・合言葉の変数を env で受けて渡す', () => {
    expect(steps[0]?.id).toBe('start')
    expect(steps[0]?.run).toBe('echo "time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"')
    expect(finish.env).toMatchObject({
      EXECUTION_FILE: '${{ steps.claude.outputs.execution_file }}',
      REVIEW_STARTED_AT: '${{ steps.start.outputs.time }}',
      PECOT_REVIEW_TRIGGER_PHRASE: '${{ vars.PECOT_REVIEW_TRIGGER_PHRASE }}',
    })
    expect(finish.run).toContain('--execution-file "$EXECUTION_FILE" --since "$REVIEW_STARTED_AT"')
  })

  it('すべての action を 40 桁の SHA で固定する', () => {
    const uses = steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })

  it('後始末の step は、最新の正式版の CLI を取る', () => {
    expect(finish.run).toMatch(/^npx -y --prefix=\/ @pecot\/workflow-mcp@latest review finish /)
  })
})
