// 配布する自動レビューのワークフローの雛形が、specs/027-auto-revise-on-pr/contracts/workflow-template.md の形を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { stoppedMarker } from '../src/domain/review-finish.js'
import { markdownSection } from './_helpers/markdown-section.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-review.yml'), 'utf8')
const documentPath = path.join(pluginRoot, 'skills/w-help/references/review-workflow.md')

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
const checkFirst = steps.find(step => step.id === 'first') ?? {}
const laterCondition = '${{ (github.event_name == \'pull_request\' && steps.first.outputs.ok != \'false\') || steps.pr.outputs.ok == \'true\' }}'

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

  it('契機は pull_request の opened・ready_for_review・synchronize と、issue_comment の created だけになる', () => {
    expect(Object.keys(workflow.on).toSorted((a, b) => a.localeCompare(b))).toEqual(['issue_comment', 'pull_request'])
    expect(workflow.on['pull_request']?.types).toEqual(['opened', 'ready_for_review', 'synchronize'])
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

  it('前のレビューの確かめは、synchronize の run だけで動き、トークンと PR の番号を env で受ける', () => {
    expect(checkFirst.if).toBe('${{ github.event.action == \'synchronize\' }}')
    expect(steps.indexOf(checkFirst)).toBeGreaterThan(steps.indexOf(stepUsing('actions/create-github-app-token')))
    expect(checkFirst.env).toEqual({ GH_TOKEN: '${{ steps.token.outputs.token || github.token }}', PR: '${{ github.event.pull_request.number }}' })
    expect(checkFirst.run).toContain('gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments"')
    expect(checkFirst.run).toContain('echo "ok=$ok" >> "$GITHUB_OUTPUT"')
  })

  it('前のレビューの確かめは、API の失敗を握りつぶすパイプとプロセス置換を使わない', () => {
    expect(checkFirst.run).not.toContain('${{')
    expect(checkFirst.run).not.toContain('< <(')
    expect(checkFirst.run?.replace(/--jq '[^']*'/, '')).not.toContain('|')
  })

  it('前のレビューの確かめの jq は、Bot の指摘の一覧と止まったことのコメントだけを拾う', () => {
    const filter = /--jq '([^']*)'/.exec(checkFirst.run ?? '')?.[1] ?? ''
    const comments = [
      { id: 1, user: { type: 'Bot' }, body: '\n## Findings — 先頭に改行がある' },
      { id: 2, user: { type: 'Bot' }, body: `止まった\n\n${stoppedMarker({ runId: '9', attempt: '1' })}\n` },
      { id: 3, user: { type: 'User' }, body: '## Findings — 人が書いた' },
      { id: 4, user: { type: 'Bot' }, body: '## Resolution — 関係の無いコメント' },
      { id: 5, user: { type: 'User' }, body: stoppedMarker({ runId: '9', attempt: '1' }) },
    ]
    const found = execFileSync('jq', ['-r', filter], { input: JSON.stringify(comments), encoding: 'utf8' })
    expect(found.trim().split('\n')).toEqual(['1', '2'])
  })

  it('前のレビューの確かめが探す文字列は、指摘の一覧のテンプレートと止まったことの目印の書き出しと一致する', () => {
    const findings = readFileSync(path.join(pluginRoot, 'cli/templates/comment/review-findings.md'), 'utf8')
    const heading = /^## \S+/mu.exec(findings.replace(/<!--[\s\S]*?-->/u, ''))?.[0]
    expect(heading).toBe('## Findings')
    expect(checkFirst.run).toContain('test("\\\\A\\\\s*## Findings")')
    expect(stoppedMarker({ runId: '1', attempt: '1' }).startsWith('<!-- pecot-review-stopped ')).toBe(true)
    expect(checkFirst.run).toContain('contains("<!-- pecot-review-stopped ")')
  })

  it('Checkout から Review までの step は、前のレビューの跡で飛ばす run と、通らなかった合言葉の run で動かない', () => {
    for (const action of ['actions/checkout', 'actions/setup-node', 'anthropics/claude-code-action']) {
      expect(stepUsing(action).if).toBe(laterCondition)
    }
  })

  it('PR の確かめは書いた人の権限を読み、admin・maintain・write のときだけ通す', () => {
    expect(checkPr.env?.['COMMENTER']).toBe('${{ github.event.comment.user.login }}')
    expect(checkPr.run).toContain('collaborators/$COMMENTER/permission')
    expect(checkPr.run).toContain('admin|maintain|write) ok=true')
  })

  it('PR の確かめは、合言葉のコメントより後のコミットが head なら通さない', () => {
    expect(checkPr.env?.['COMMENT_AT']).toBe('${{ github.event.comment.created_at }}')
    // CodeQL の CommentVsHeadDateCheck は、`date -d` で *_at を読む 2 つのコマンドを確かめと認める
    expect(checkPr.run).toContain('commit_time=$(date -d "$COMMIT_AT" +%s)')
    expect(checkPr.run).toContain('comment_time=$(date -d "$COMMENT_AT" +%s)')
    expect(checkPr.run).toContain('[ "$commit_time" -le "$comment_time" ]')
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

  it('prompt は、変数 PECOT_REVIEW_PROJECT のあるときだけ、末尾に project=<名前> を足す', () => {
    const prompt = text(reviewInputs['prompt'])
    expect(prompt.endsWith('${{ vars.PECOT_REVIEW_PROJECT != \'\' && format(\' project={0}\', vars.PECOT_REVIEW_PROJECT) || \'\' }}')).toBe(true)
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

  it('job に timeout-minutes と、PR の番号ごとの concurrency があり、待ちの job を取り消さない', () => {
    expect(job).toHaveProperty('timeout-minutes')
    expect(job.concurrency).toEqual({
      'group': 'pecot-review-${{ github.event.pull_request.number || github.event.issue.number }}',
      'cancel-in-progress': false,
      'queue': 'max',
    })
  })

  it('claude_args は権限のモード・ターンの上限・許可・拒否を持ち、コメントの行を含まない', () => {
    expect(claudeArguments).toContain('--permission-mode default')
    expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_REVIEW_MAX_TURNS || \'60\' }}')
    expect(claudeArguments).toContain('--allowedTools "')
    expect(claudeArguments).toContain('--disallowedTools "')
    expect(claudeArguments).not.toContain('#')
  })

  it('Edit・Write を拒否し、Bash は PR を読む gh の規則だけを許す', () => {
    const allowed = toolList('--allowedTools')
    const disallowed = toolList('--disallowedTools')
    for (const tool of ['Edit', 'Write']) {
      expect(allowed.filter(entry => entry.startsWith(tool))).toEqual([])
      expect(disallowed).toContain(tool)
    }
    expect(allowed.filter(entry => entry.startsWith('Bash'))).toEqual(['Bash(gh pr diff:*)', 'Bash(gh pr view:*)'])
    for (const prefix of ['Bash(gh api', 'Bash(git', 'Bash(gh pr comment']) {
      expect(allowed.filter(entry => entry.startsWith(prefix))).toEqual([])
    }
    expect(disallowed).not.toContain('Bash')
  })

  it('hook が allow を返す clone と、環境変数を読める /proc を拒否する', () => {
    expect(toolList('--disallowedTools')).toEqual([
      'Edit',
      'Write',
      'NotebookEdit',
      'AskUserQuestion',
      'Agent',
      'Bash(git clone:*)',
      'Read(//proc/**)',
    ])
  })

  it('PECOT_REVIEW_WEB_ACCESS が false でないとき、Context7 を足し、WebSearch・docs.github.com・Context7 のツールを許す', () => {
    expect(claudeArguments).toContain('${{ vars.PECOT_REVIEW_WEB_ACCESS != \'false\' && format(\'--mcp-config \'\'{0}\'\'\', secrets.CONTEXT7_API_KEY != \'\' && env.PECOT_REVIEW_CONTEXT7_WITH_KEY || env.PECOT_REVIEW_CONTEXT7) || \'\' }}')
    expect(claudeArguments).toContain('${{ vars.PECOT_REVIEW_WEB_ACCESS != \'false\' && \',WebSearch,WebFetch(domain:docs.github.com),mcp__context7__resolve-library-id,mcp__context7__query-docs\' || \'\' }}')
  })

  it('WebFetch は docs.github.com だけをドメインつきで許し、全ドメインを許さない', () => {
    const allowed = /--allowedTools "([^"]*)"/.exec(claudeArguments)?.[1] ?? ''
    expect(Array.from(allowed.matchAll(/WebFetch[^,']*/g), match => match[0])).toEqual(['WebFetch(domain:docs.github.com)'])
  })

  it('PECOT_REVIEW_WEB_ACCESS が false のとき、WebFetch と WebSearch を拒否する', () => {
    expect(claudeArguments).toContain('Agent${{ vars.PECOT_REVIEW_WEB_ACCESS == \'false\' && \',WebFetch,WebSearch\' || \'\' }},Bash(git clone:*)')
  })

  it('Context7 は OAuth でない URL につなぎ、キーは step の env の CONTEXT7_API_KEY から渡す', () => {
    const withoutKey: unknown = JSON.parse(job.env?.['PECOT_REVIEW_CONTEXT7'] ?? '')
    const withKey: unknown = JSON.parse(job.env?.['PECOT_REVIEW_CONTEXT7_WITH_KEY'] ?? '')
    const server = { type: 'http', url: 'https://mcp.context7.com/mcp' }
    expect(withoutKey).toEqual({ mcpServers: { context7: server } })
    expect(withKey).toEqual({ mcpServers: { context7: { ...server, headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY}' } } } })
    expect(review.env?.['CONTEXT7_API_KEY']).toBe('${{ secrets.CONTEXT7_API_KEY }}')
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
      'mcp__github_inline_comment__create_inline_comment',
      'Bash(gh pr diff:*)',
      'Bash(gh pr view:*)',
    ])
    for (const tool of allowed) expect(tool).not.toMatch(/merge|close|release|session_finish|branch_delete/)
  })

  it('利用者が足す許可は、job の env の変数から --allowedTools の末尾に足す', () => {
    expect(job.env?.['PECOT_REVIEW_EXTRA_ALLOWED_TOOLS']).toBe('')
    expect(Object.keys(job.env ?? {})).toEqual(['PECOT_REVIEW_EXTRA_ALLOWED_TOOLS', 'PECOT_REVIEW_CONTEXT7', 'PECOT_REVIEW_CONTEXT7_WITH_KEY'])
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

  it('後始末の step は、前のレビューの跡で飛ばした run のほかは if: always() で動き、式を run に埋め込まない', () => {
    expect(finish.if).toBe('${{ always() && steps.first.outputs.ok != \'false\' }}')
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

  it('setup-node は、secret を持つ job なので npm のキャッシュを戻さず保存もしない', () => {
    expect(stepUsing('actions/setup-node').with?.['package-manager-cache']).toBe(false)
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

describe('自動レビューの導入の説明', () => {
  const document = existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : ''
  const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

  it('説明のファイルが w-help の参照にある', () => {
    expect(existsSync(documentPath)).toBe(true)
  })

  it('雛形の変数と secret の名前が、すべて説明に出てくる', () => {
    const names = new Set(Array.from(active.matchAll(/\b(?:vars|secrets)\.([A-Z][A-Z0-9_]+)/g), match => match[1] ?? ''))
    expect([...names].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CONTEXT7_API_KEY',
      'PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID',
      'PECOT_AGENT_ANTHROPIC_ORGANIZATION_ID',
      'PECOT_AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID',
      'PECOT_AGENT_ANTHROPIC_WORKSPACE_ID',
      'PECOT_AGENT_APP_CLIENT_ID',
      'PECOT_AGENT_APP_PRIVATE_KEY',
      'PECOT_REVIEW_ALLOWED_BOTS',
      'PECOT_REVIEW_MAX_TURNS',
      'PECOT_REVIEW_PROJECT',
      'PECOT_REVIEW_TIMEOUT_MINUTES',
      'PECOT_REVIEW_TRIGGER_PHRASE',
      'PECOT_REVIEW_WEB_ACCESS',
    ])
    for (const name of names) expect(document).toContain(`\`${name}\``)
  })

  it('利用者が変える 4 つの変数の既定値が、説明の表の同じ行にある', () => {
    const defaults = new Map(Array.from(active.matchAll(/vars\.(PECOT_REVIEW_[A-Z_]+) \|\| '([^']*)'/g), match => [match[1] ?? '', match[2] ?? '']))
    expect(defaults.size).toBe(4)
    const rows = document.split('\n').filter(line => line.startsWith('|'))
    for (const [name, value] of defaults) {
      const row = rows.find(line => line.startsWith(`| \`${name}\` |`))
      expect(row, `${name} の行が説明の表に無い`).toBeDefined()
      expect(row).toContain(`\`${value}\``)
    }
  })

  it('変数 PECOT_REVIEW_PROJECT が、説明の「変えられる値」の表にある', () => {
    const rows = markdownSection(document, '### 変えられる値').split('\n')
    expect(rows.some(line => line.startsWith('| `PECOT_REVIEW_PROJECT` |'))).toBe(true)
  })

  it('利用者が足す行の印の名前が、説明に出てくる', () => {
    for (const area of ['allowed-tools', 'prepare']) expect(document).toContain(`pecot-review:${area}`)
  })

  it('自前の App の権限が、説明の「自前の GitHub App」の節と食い違わない', () => {
    const appToken = stepUsing('actions/create-github-app-token')
    const labels = new Map([['pull-requests', 'Pull requests'], ['contents', 'Contents']])
    const fromTemplate = Object.entries(appToken.with ?? {})
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
})
