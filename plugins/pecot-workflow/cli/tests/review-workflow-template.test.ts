// 配布する自動レビューのワークフローの雛形が、specs/027-auto-revise-on-pr/contracts/workflow-template.md の形を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { explains } from './_helpers/explains.js'
import { stoppedMarker } from '@pecot/workflow-core/domain/review-finish.js'
import { attachOutput } from '../../../../libs/interface-spec/src/vitest/attach.js'
import { markdownSection } from './_helpers/markdown-section.js'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-review.yml'), 'utf8')
const documentPath = path.join(pluginRoot, 'skills/w-help/references/review-workflow.md')

// ワークフローの jq の式を動かし、受けた出力を添付して返す。
function runJq(arguments_: readonly string[], input: string): string {
  const stdout = execFileSync('jq', [...arguments_], { input, encoding: 'utf8' })
  attachOutput(`jq ${arguments_.join(' ').slice(0, 80)}`, 0, stdout, '')
  return stdout
}

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
const record = steps.find(step => step.name === 'Record the run') ?? {}
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
  it('1 行目に、テンプレートの名前と版を示すコメントが存在する', async () => {
    await explains('`pecot-review.yml` テンプレートの 1 行目のテストです。`# pecot-workflow-template: review <版の数字>` の形のコメントが存在することを確認します。')
    expect(template.split('\n', 1)[0]).toMatch(/^# pecot-workflow-template: review \d+$/)
  })

  it('YAML として読み込め、review の job にステップが存在する', async () => {
    await explains('`pecot-review.yml` の構造のテストです。YAML として読み込め、`review` の job に 1 つ以上のステップが存在することを確認します。')
    expect(steps.length).toBeGreaterThan(0)
  })

  it('pull_request_target のトリガーを持たない', async () => {
    await explains('ワークフローのトリガーのテストです。`on` に `pull_request_target` が含まれないことを確認します。')
    expect(workflow.on).not.toHaveProperty('pull_request_target')
  })

  it('トリガーは pull_request の opened', async () => {
    await explains('ワークフローのトリガーのテストです。`on` が `pull_request` と `issue_comment` だけで、種類が `opened`・`ready_for_review`・`synchronize`・`created` だけであることを確認します。')
    expect(Object.keys(workflow.on).toSorted((a, b) => a.localeCompare(b))).toEqual(['issue_comment', 'pull_request'])
    expect(workflow.on['pull_request']?.types).toEqual(['opened', 'ready_for_review', 'synchronize'])
    expect(workflow.on['issue_comment']?.types).toEqual(['created'])
  })

  it('pull_request の場合の条件は、fork・draft・bot の判定を持つ', async () => {
    await explains('job の `if` のうち、`pull_request` の側の条件のテストです。fork のリポジトリ・draft の PR・許可していない bot を除く判定が含まれることを確認します。')
    const pullRequest = branch('pull_request')
    expect(pullRequest).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(pullRequest).toContain('github.event.pull_request.draft')
    expect(pullRequest).toContain('contains(fromJSON(vars.PECOT_REVIEW_ALLOWED_BOTS || \'[]\'), github.event.pull_request.user.login)')
  })

  it('issue_comment の場合の条件は、PR へのコメント・人・author_association・起動用のフレーズの 4 つの判定を持つ', async () => {
    await explains('job の `if` のうち、`issue_comment` の側の条件のテストです。PR へのコメントであること、Bot でないこと、`author_association`、起動用のフレーズに一致することの判定が含まれることを確認します。')
    const comment = branch('issue_comment')
    expect(comment).toContain('github.event.issue.pull_request')
    expect(comment).toContain('github.event.comment.user.type != \'Bot\'')
    expect(comment).toContain('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association)')
    expect(comment).toContain(`github.event.comment.body == (${phrase})`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0} ', ${phrase}))`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0}{1}', ${phrase}, fromJSON('"\\n"')))`)
    expect(comment).toContain(`startsWith(github.event.comment.body, format('{0}{1}', ${phrase}, fromJSON('"\\r\\n"')))`)
  })

  it('issue_comment のときは PR の状態を確認し、checkout はその head.sha を使う', async () => {
    await explains('`issue_comment` で起動した場合のテストです。PR を確認するステップが結果を出力し、`checkout` がその `head.sha` を指定し、後続のステップが確認の結果に従うことを確認します。')
    expect(checkPr.if).toContain('github.event_name == \'issue_comment\'')
    expect(checkPr.run).toContain('GITHUB_OUTPUT')
    const checkout = stepUsing('actions/checkout')
    expect(checkout.with?.['ref']).toBe('${{ github.event.pull_request.head.sha || steps.pr.outputs.sha }}')
    expect(checkout.with?.['fetch-depth']).toBe(1)
    expect(checkout.with?.['persist-credentials']).toBe(false)
    const afterCheck = steps.slice(steps.indexOf(checkPr) + 1)
    for (const step of afterCheck) {
      if (step === finish || step === record) continue
      expect(step.if, `${step.name ?? ''} が PR の確かめの結果を見ない`).toContain('steps.pr.outputs.ok == \'true\'')
    }
  })

  it('前のレビューの確認ステップは、synchronize のときだけ動き、トークンと PR 番号を env で受け取る', async () => {
    await explains('前回のレビューの有無を確認するステップのテストです。`synchronize` のときだけ動き、トークンと PR 番号を環境変数で受け取って、結果を `GITHUB_OUTPUT` に書くことを確認します。')
    expect(checkFirst.if).toBe('${{ github.event.action == \'synchronize\' }}')
    expect(steps.indexOf(checkFirst)).toBeGreaterThan(steps.indexOf(stepUsing('actions/create-github-app-token')))
    expect(checkFirst.env).toEqual({ GH_TOKEN: '${{ steps.token.outputs.token || github.token }}', PR: '${{ github.event.pull_request.number }}' })
    expect(checkFirst.run).toContain('gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments"')
    expect(checkFirst.run).toContain('echo "ok=$ok" >> "$GITHUB_OUTPUT"')
  })

  it('前のレビューの確認ステップは、API の失敗を隠すパイプとプロセス置換を使わない', async () => {
    await explains('前回のレビューの有無を確認するステップのテストです。式の埋め込み・プロセス置換・パイプが含まれず、API の失敗が隠れないことを確認します。')
    expect(checkFirst.run).not.toContain('${{')
    expect(checkFirst.run).not.toContain('< <(')
    expect(checkFirst.run?.replace(/--jq '[^']*'/, '')).not.toContain('|')
  })

  it('前のレビューの確認ステップの jq は、Bot の指摘の一覧と、レビューが止まったことを示すコメントだけを抽出する', async () => {
    await explains('前回のレビューの有無を確認する jq のテストです。Bot が投稿した指摘の一覧と、止まったことを示すコメントの ID だけを抽出し、人が書いたコメントは抽出しないことを確認します。')
    const filter = /--jq '([^']*)'/.exec(checkFirst.run ?? '')?.[1] ?? ''
    const comments = [
      { id: 1, user: { type: 'Bot' }, body: '\n## Findings — 先頭に改行がある' },
      { id: 2, user: { type: 'Bot' }, body: `止まった\n\n${stoppedMarker({ runId: '9', attempt: '1' })}\n` },
      { id: 3, user: { type: 'User' }, body: '## Findings — 人が書いた' },
      { id: 4, user: { type: 'Bot' }, body: '## Resolution — 関係の無いコメント' },
      { id: 5, user: { type: 'User' }, body: stoppedMarker({ runId: '9', attempt: '1' }) },
    ]
    const found = runJq(['-r', filter], JSON.stringify(comments))
    expect(found.trim().split('\n')).toEqual(['1', '2'])
  })

  it('w-review が前回の指摘を取得する jq は、指摘の一覧と対応のコメントだけを抽出し、ログのコメントは抽出しない', async () => {
    await explains('`w-review` の `SKILL.md` にある、前回の指摘を取得する jq のテストです。`## Findings` と `## Resolution` のコメントだけを抽出し、CUJ のログに含まれる同じ見出しは抽出しないことを確認します。')
    const skill = readFileSync(path.join(pluginRoot, 'skills/w-review/SKILL.md'), 'utf8')
    const filter = /gh pr view [^\n]*--jq '([^']*)'/.exec(skill)?.[1] ?? ''
    const comments = [
      { body: '\n## Findings — 先頭に改行がある' },
      { body: '## Resolution — 書き手の対応' },
      { body: '<details>\n<summary>CUJ 1 のログ</summary>\n\n```text\n## Findings — ログの途中の行\n```\n\n</details>' },
      { body: 'ふつうのコメント' },
    ]
    const found = runJq(['-r', filter], JSON.stringify({ comments }))
    expect(found.trim().split('\n')).toEqual(['## Findings — 先頭に改行がある', '## Resolution — 書き手の対応'])
  })

  it('前のレビューの確認ステップが探す文字列は、指摘の一覧のテンプレートと、止まったことを示す目印の書き出しに一致する', async () => {
    await explains('前回のレビューの有無を確認するステップの検索文字列のテストです。指摘の一覧のテンプレートの見出し `## Findings` と、止まったことを示す目印の書き出しが、検索する文字列と一致することを確認します。')
    const findings = readFileSync(path.join(pluginRoot, 'cli/templates/comment/review-findings.md'), 'utf8')
    // 書き方の説明のコメントの後ろにある、本文の最初の見出しを読む
    const heading = /^## \S+/mu.exec(findings.slice(findings.indexOf('-->')))?.[0]
    expect(heading).toBe('## Findings')
    expect(checkFirst.run).toContain('test("\\\\A\\\\s*## Findings")')
    expect(stoppedMarker({ runId: '1', attempt: '1' }).startsWith('<!-- pecot-review-stopped ')).toBe(true)
    expect(checkFirst.run).toContain('contains("<!-- pecot-review-stopped ")')
  })

  it('Checkout から Review までのステップは、前回のレビューがある場合と、PR の確認を通らなかった場合に動かない', async () => {
    await explains('Checkout から Review までのステップのテストです。前回のレビューがある場合と PR の確認を通らなかった場合に動かない条件を持つことを確認します。')
    for (const action of ['actions/checkout', 'actions/setup-node', 'anthropics/claude-code-action']) {
      expect(stepUsing(action).if).toBe(laterCondition)
    }
  })

  it('PR の確認ステップは、コメントした人の permission を取得し、admin か write の場合だけ通す', async () => {
    await explains('PR を確認するステップのテストです。コメントした人の権限を取得し、`admin` と `write` の場合だけ通し、`role_name` は使わないことを確認します。')
    expect(checkPr.env?.['COMMENTER']).toBe('${{ github.event.comment.user.login }}')
    expect(checkPr.run).toContain('collaborators/$COMMENTER/permission" --jq .permission)')
    expect(checkPr.run).toContain('case "$permission" in admin|write) ok=true')
    // role_name はカスタムロールの名前を返すので、書き込みを基にしたカスタムロールの人が止まる
    expect(checkPr.run).not.toContain('role_name')
  })

  it('PR の確認ステップは、起動用のコメントより後のコミットが head の場合は通さない', async () => {
    await explains('PR を確認するステップのテストです。起動用のコメントより後に作成されたコミットが head の場合に通さないよう、コメントとコミットの時刻を比較していることを確認します。')
    expect(checkPr.env?.['COMMENT_AT']).toBe('${{ github.event.comment.created_at }}')
    // CodeQL の CommentVsHeadDateCheck は、`date -d` で *_at を読む 2 つのコマンドを確かめと認める
    expect(checkPr.run).toContain('commit_time=$(date -d "$COMMIT_AT" +%s)')
    expect(checkPr.run).toContain('comment_time=$(date -d "$COMMENT_AT" +%s)')
    expect(checkPr.run).toContain('[ "$commit_time" -le "$comment_time" ]')
  })

  it('PR の確認ステップは、API の失敗をプロセス置換で隠さない', async () => {
    await explains('PR を確認するステップのテストです。プロセス置換と式の埋め込みを使わず、`gh api` の結果を変数に受け取っていることを確認します。')
    expect(checkPr.run).not.toContain('< <(')
    expect(checkPr.run).toContain('pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR")')
    expect(checkPr.run).not.toContain('${{')
  })

  it('job の if・timeout-minutes・concurrency は、env を参照しない', async () => {
    await explains('job の設定のテストです。`if`・`timeout-minutes`・`concurrency` が `env` を参照しないことを確認します。')
    expect(condition).not.toContain('env.')
    expect(job['timeout-minutes']).not.toContain('env.')
    expect(JSON.stringify(job.concurrency)).not.toContain('env.')
  })

  it('利用者が変える 6 つの変数に、既定値の式がある', async () => {
    await explains('テンプレートの変数のテストです。利用者が変える 6 つの変数それぞれに、`vars.<名前> || \'<既定値>\'` の形で既定値を指定していることを確認します。')
    expect(template).toContain(phrase)
    expect(template).toContain('vars.PECOT_REVIEW_ALLOWED_BOTS || \'[]\'')
    expect(template).toContain('vars.PECOT_REVIEW_MODEL || \'opus\'')
    expect(template).toContain('vars.PECOT_REVIEW_EFFORT || \'high\'')
    expect(template).toContain('vars.PECOT_REVIEW_MAX_TURNS || \'60\'')
    expect(template).toContain('vars.PECOT_REVIEW_TIMEOUT_MINUTES || \'30\'')
  })

  it('timeout-minutes は、変数を fromJSON で数値に変換する', async () => {
    await explains('job の `timeout-minutes` のテストです。変数 `PECOT_REVIEW_TIMEOUT_MINUTES` を `fromJSON` で数値に変換し、既定値を 30 とした式であることを確認します。')
    expect(job['timeout-minutes']).toBe('${{ fromJSON(vars.PECOT_REVIEW_TIMEOUT_MINUTES || \'30\') }}')
  })

  it('action に、書き込み権限を持たない人を通す入力・追跡のモード・API キーを渡さない', async () => {
    await explains('`claude-code-action` の入力のテストです。`allowed_non_write_users`・`track_progress`・`anthropic_api_key`・`restrict_untrusted_prs` が含まれないことを確認します。')
    for (const key of ['allowed_non_write_users', 'track_progress', 'anthropic_api_key', 'restrict_untrusted_prs']) {
      expect(reviewInputs).not.toHaveProperty(key)
    }
  })

  it('OAuth のトークンを渡し、その secret が空の場合だけ Workload Identity Federation の 4 つの入力に変数の値を渡す', async () => {
    await explains('`claude-code-action` の認証の入力のテストです。OAuth のトークンを渡し、その secret が空の場合だけ Workload Identity Federation の入力を渡すことを確認します。')
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

  it('classify_inline_comments には "false" を指定する', async () => {
    await explains('`claude-code-action` の入力のテストです。`classify_inline_comments` に文字列 `false` を指定していることを確認します。')
    expect(reviewInputs['classify_inline_comments']).toBe('false')
  })

  it('issue_comment のときは、PR の確認の後で、起動用のコメントに eyes のリアクションを付ける', async () => {
    await explains('`issue_comment` で起動した場合のテストです。PR の確認ステップより後に、起動用のコメントへ `eyes` のリアクションを付けるステップがあり、確認を通った場合だけ動くことを確認します。')
    const acknowledge = steps.find(step => step.run?.includes('content=eyes') === true)
    expect(acknowledge).toBeDefined()
    expect(steps.indexOf(acknowledge ?? {})).toBeGreaterThan(steps.indexOf(checkPr))
    expect(acknowledge?.if).toContain('github.event_name == \'issue_comment\'')
    expect(acknowledge?.if).toContain('steps.pr.outputs.ok == \'true\'')
    expect(acknowledge?.run).not.toContain('${{')
  })

  it('prompt は、PR の本文・タイトル・ブランチ名・コメントを埋め込まない', async () => {
    await explains('`claude-code-action` の `prompt` のテストです。`/pecot-w:w-review ` で始まり、PR の本文・タイトル・ブランチ名・コメントを埋め込まないことを確認します。')
    const prompt = text(reviewInputs['prompt'])
    expect(prompt).toContain('/pecot-w:w-review ')
    for (const field of ['pull_request.body', 'pull_request.title', 'head.ref', 'comment.body', 'issue.title', 'issue.body']) {
      expect(prompt).not.toContain(field)
    }
  })

  it('prompt は、変数 PECOT_REVIEW_PROJECT が設定されているときだけ、末尾に project=<名前> を追加する', async () => {
    await explains('`prompt` の末尾のテストです。変数 `PECOT_REVIEW_PROJECT` が空でない場合だけ、末尾に ` project=<名前>` を追加する式であることを確認します。')
    const prompt = text(reviewInputs['prompt'])
    expect(prompt.endsWith('${{ vars.PECOT_REVIEW_PROJECT != \'\' && format(\' project={0}\', vars.PECOT_REVIEW_PROJECT) || \'\' }}')).toBe(true)
  })

  it('job の permissions は contents: read・pull-requests: write・id-token: write だけになる', async () => {
    await explains('job の `permissions` のテストです。`contents: read`・`pull-requests: write`・`id-token: write` の 3 つだけであることを確認します。')
    expect(job.permissions).toEqual({ 'contents': 'read', 'pull-requests': 'write', 'id-token': 'write' })
  })

  it('トークンの発行は変数が設定されているときだけ動き、Pull requests の write と Contents の read だけを要求する', async () => {
    await explains('GitHub App のトークンを発行するステップのテストです。変数 `PECOT_AGENT_APP_CLIENT_ID` が空でない場合だけ動き、Pull requests の write と Contents の read だけを要求することを確認します。')
    const token = stepUsing('actions/create-github-app-token')
    expect(token.id).toBe('token')
    expect(token.if).toBe('${{ vars.PECOT_AGENT_APP_CLIENT_ID != \'\' }}')
    const granted = Object.fromEntries(Object.entries(token.with ?? {}).filter(([key]) => key.startsWith('permission-')))
    expect(granted).toEqual({ 'permission-pull-requests': 'write', 'permission-contents': 'read' })
  })

  it('発行したトークンが存在しない場合は、github_token が空になり Claude の App を使い、PECOT_GITHUB_COM_TOKEN などには GITHUB_TOKEN を使う', async () => {
    await explains('トークンの代替のテストです。発行したトークンが存在しない場合に、`github_token` は空になり、`PECOT_GITHUB_COM_TOKEN` と `GH_TOKEN` には `github.token` を使うことを確認します。')
    expect(reviewInputs['github_token']).toBe('${{ steps.token.outputs.token }}')
    const fallback = '${{ steps.token.outputs.token || github.token }}'
    expect(review.env?.['PECOT_GITHUB_COM_TOKEN']).toBe(fallback)
    expect(finish.env?.['PECOT_GITHUB_COM_TOKEN']).toBe(fallback)
    expect(checkPr.env?.['GH_TOKEN']).toBe(fallback)
  })

  it('job に timeout-minutes と PR 番号ごとの concurrency があり、待機中の job を取り消さない', async () => {
    await explains('job の同時実行の設定のテストです。`timeout-minutes` が存在し、`concurrency` が PR 番号ごとのグループで、実行待ちの job を取り消さない設定であることを確認します。')
    expect(job).toHaveProperty('timeout-minutes')
    expect(job.concurrency).toEqual({
      'group': 'pecot-review-${{ github.event.pull_request.number || github.event.issue.number }}',
      'cancel-in-progress': false,
      'queue': 'max',
    })
  })

  it('claude_args は権限モード・ターン数の上限・許可・拒否を持ち、コメントの行を含まない', async () => {
    await explains('`claude_args` のテストです。権限モード・ターン数の上限・モデル・effort・許可・拒否を指定し、`#` のコメントを含まないことを確認します。')
    expect(claudeArguments).toContain('--permission-mode default')
    expect(claudeArguments).toContain('--max-turns ${{ vars.PECOT_REVIEW_MAX_TURNS || \'60\' }}')
    expect(claudeArguments).toContain('--model ${{ vars.PECOT_REVIEW_MODEL || \'opus\' }}')
    expect(claudeArguments).toContain('--effort ${{ vars.PECOT_REVIEW_EFFORT || \'high\' }}')
    expect(claudeArguments).toContain('--allowedTools "')
    expect(claudeArguments).toContain('--disallowedTools "')
    expect(claudeArguments).not.toContain('#')
  })

  it('Edit と Write を拒否し、Bash は PR を読み取る gh のコマンドだけを許可する', async () => {
    await explains('ツールの許可と拒否のテストです。`Edit` と `Write` は拒否し、`Bash` は `gh pr diff` と `gh pr view` だけを許可して、`gh api` や `git` は許可しないことを確認します。')
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

  it('hook が許可を返す git clone と、環境変数を読み取れる /proc を拒否する', async () => {
    await explains('`--disallowedTools` の内容のテストです。`Edit`・`Write`・`NotebookEdit`・`AskUserQuestion`・`Agent` に加え、`Bash(git clone:*)` と `Read(//proc/**)` を拒否することを確認します。')
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

  it('PECOT_REVIEW_WEB_ACCESS が false でないとき、Context7 を追加し、WebSearch・docs.github.com・Context7 のツールを許可する', async () => {
    await explains('変数 `PECOT_REVIEW_WEB_ACCESS` が `false` でない場合のテストです。Context7 の MCP 設定を追加し、`WebSearch`・`docs.github.com` の `WebFetch`・Context7 のツールを許可する式であることを確認します。')
    expect(claudeArguments).toContain('${{ vars.PECOT_REVIEW_WEB_ACCESS != \'false\' && format(\'--mcp-config \'\'{0}\'\'\', secrets.CONTEXT7_API_KEY != \'\' && env.PECOT_REVIEW_CONTEXT7_WITH_KEY || env.PECOT_REVIEW_CONTEXT7) || \'\' }}')
    expect(claudeArguments).toContain('${{ vars.PECOT_REVIEW_WEB_ACCESS != \'false\' && \',WebSearch,WebFetch(domain:docs.github.com),mcp__context7__resolve-library-id,mcp__context7__query-docs\' || \'\' }}')
  })

  it('WebFetch は docs.github.com だけをドメインつきで許可し、すべてのドメインは許可しない', async () => {
    await explains('`WebFetch` の許可のテストです。`--allowedTools` に含まれる `WebFetch` が、`WebFetch(domain:docs.github.com)` だけであることを確認します。')
    const allowed = /--allowedTools "([^"]*)"/.exec(claudeArguments)?.[1] ?? ''
    expect(Array.from(allowed.matchAll(/WebFetch[^,']*/g), match => match[0])).toEqual(['WebFetch(domain:docs.github.com)'])
  })

  it('PECOT_REVIEW_WEB_ACCESS が false のとき、WebFetch と WebSearch を拒否する', async () => {
    await explains('変数 `PECOT_REVIEW_WEB_ACCESS` が `false` の場合のテストです。`--disallowedTools` に `WebFetch` と `WebSearch` を追加する式であることを確認します。')
    expect(claudeArguments).toContain('Agent${{ vars.PECOT_REVIEW_WEB_ACCESS == \'false\' && \',WebFetch,WebSearch\' || \'\' }},Bash(git clone:*)')
  })

  it('Context7 には OAuth を使わない URL で接続し、キーは step の env の CONTEXT7_API_KEY から渡す', async () => {
    await explains('Context7 の MCP 設定のテストです。`https://mcp.context7.com/mcp` に接続し、キーがある場合だけ `Authorization` ヘッダーに `CONTEXT7_API_KEY` を渡すことを確認します。')
    const withoutKey: unknown = JSON.parse(job.env?.['PECOT_REVIEW_CONTEXT7'] ?? '')
    const withKey: unknown = JSON.parse(job.env?.['PECOT_REVIEW_CONTEXT7_WITH_KEY'] ?? '')
    const server = { type: 'http', url: 'https://mcp.context7.com/mcp' }
    expect(withoutKey).toEqual({ mcpServers: { context7: server } })
    expect(withKey).toEqual({ mcpServers: { context7: { ...server, headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY}' } } } })
    expect(review.env?.['CONTEXT7_API_KEY']).toBe('${{ secrets.CONTEXT7_API_KEY }}')
  })

  it('許可するツールは仕様で定めたものだけで、マージ・クローズ・リリースのツールを含まない', async () => {
    await explains('`--allowedTools` の内容のテストです。`Read`・`Glob`・`Grep` と、PR・Issue の参照とコメントのツールなど 9 件だけで、マージ・クローズ・リリースに関わるツールを含まないことを確認します。')
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

  it('利用者が追加する許可は、job の env の変数から --allowedTools の末尾に追加する', async () => {
    await explains('利用者によるツールの追加のテストです。job の `env` の `PECOT_REVIEW_EXTRA_ALLOWED_TOOLS` が空で、値があるときだけ `--allowedTools` の末尾に追加する式であることを確認します。')
    expect(job.env?.['PECOT_REVIEW_EXTRA_ALLOWED_TOOLS']).toBe('')
    expect(Object.keys(job.env ?? {})).toEqual(['PECOT_REVIEW_EXTRA_ALLOWED_TOOLS', 'PECOT_REVIEW_CONTEXT7', 'PECOT_REVIEW_CONTEXT7_WITH_KEY'])
    expect(claudeArguments).toContain('${{ env.PECOT_REVIEW_EXTRA_ALLOWED_TOOLS != \'\' && format(\',{0}\', env.PECOT_REVIEW_EXTRA_ALLOWED_TOOLS) || \'\' }}"')
  })

  it('利用者が追加する行の範囲は、開始と終了を示すコメントで囲む', async () => {
    await explains('利用者が追加する行の範囲のテストです。`allowed-tools` と `prepare` のそれぞれに、開始と終了のコメント（`# pecot-review:<名前>:begin` と `:end`）が存在することを確認します。')
    for (const area of ['allowed-tools', 'prepare']) {
      const begin = template.indexOf(`# pecot-review:${area}:begin`)
      const end = template.indexOf(`# pecot-review:${area}:end`)
      expect(begin, `${area} の開始の印が無い`).toBeGreaterThanOrEqual(0)
      expect(end, `${area} の終了の印が無い`).toBeGreaterThan(begin)
    }
  })

  it('後始末のステップは、前回のレビューがあった場合を除き、常に動き、式を run に埋め込まない', async () => {
    await explains('後始末のステップ（`review finish`）のテストです。前回のレビューがあった場合を除いて `always()` で動き、式を `run` に埋め込まず、必要な引数を渡すことを確認します。')
    expect(finish.if).toBe('${{ always() && steps.first.outputs.ok != \'false\' }}')
    expect(finish.run).not.toContain('${{')
    expect(finish.run).toContain('"$GITHUB_REPOSITORY/$PR" --ensure --job-status "$JOB_STATUS" --review-outcome "$REVIEW_OUTCOME" --review-conclusion "$REVIEW_CONCLUSION" --review-has-token "$REVIEW_HAS_TOKEN"')
  })

  it('後始末のステップは、自動レビューの 4 つの値を env で受け取り、トークンの値そのものは受け取らない', async () => {
    await explains('後始末のステップの入力のテストです。job の状態など 4 つの値を `env` で受け取り、トークンの値そのものは受け取らないことを確認します。')
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

  it('後始末のステップは、実行結果のファイル・最初のステップが記録した開始時刻・起動用のフレーズの変数を env で受け取って渡す', async () => {
    await explains('後始末のステップの入力のテストです。実行結果のファイル・開始時刻・起動用のフレーズの変数を `env` で受け取り、`--execution-file` と `--since` で渡すことを確認します。')
    expect(steps[0]?.id).toBe('start')
    expect(steps[0]?.run).toBe('echo "time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"')
    expect(finish.env).toMatchObject({
      EXECUTION_FILE: '${{ steps.claude.outputs.execution_file }}',
      REVIEW_STARTED_AT: '${{ steps.start.outputs.time }}',
      PECOT_REVIEW_TRIGGER_PHRASE: '${{ vars.PECOT_REVIEW_TRIGGER_PHRASE }}',
    })
    expect(finish.run).toContain('--execution-file "$EXECUTION_FILE" --since "$REVIEW_STARTED_AT"')
  })

  it('Review の settings は、使われた effort を RUNNER_TEMP のファイルに書き出す PreToolUse の hook だけを持つ', async () => {
    await explains('Review ステップの `settings` のテストです。使われた effort を `RUNNER_TEMP` のファイルへ書き出す `PreToolUse` の hook だけを持つことを確認します。')
    const settings: unknown = JSON.parse(text(reviewInputs['settings']))
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'printf %s "$CLAUDE_EFFORT" > "$RUNNER_TEMP/pecot-review-effort"' }] }],
      },
    })
  })

  it('記録のステップは、Review の直後に置かれ、実行結果のファイルがある場合に動き、失敗しても job を失敗にしない', async () => {
    await explains('記録のステップ（`Record the run`）のテストです。Review の直後にあり、実行結果のファイルがある場合に動き、`continue-on-error` で job を失敗にしないことを確認します。')
    expect(steps[steps.indexOf(review) + 1]).toBe(record)
    expect(record.if).toBe('${{ always() && steps.claude.outputs.execution_file != \'\' }}')
    expect(record['continue-on-error']).toBe(true)
    expect(record.env).toEqual({ EXECUTION_FILE: '${{ steps.claude.outputs.execution_file }}' })
    expect(record.run).not.toContain('${{')
  })

  it('記録の jq は、モデル・effort・ツールの呼び出し・拒否を表に表示し、出力と本文は表示しない', async () => {
    await explains('記録のステップの jq のテストです。実行結果からモデル・effort・ツールの呼び出し・拒否を Markdown の表に出力し、AI の発言やツールの出力、コメントの本文は出力しないことを確認します。')
    const filter = /jq -r --arg effort "\$effort" '([^']*)'/.exec(record.run ?? '')?.[1] ?? ''
    const execution = [
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
      { type: 'assistant', message: { content: [
        { type: 'text', text: '考えた文' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/a|b.ts' } },
        { type: 'tool_use', name: 'mcp__pecot-workflow__issue_comment', input: { issue_ref: 'o/r/1', message: '本文の中身' } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ファイルの中身' }] } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'echo ![x](https://example.com/a.png)\n<b>`x`' } },
        { type: 'tool_use', name: 'Other', input: { body: 'コメントの本文', line: 3 } },
      ] } },
      { type: 'result', subtype: 'error_max_turns', num_turns: 4, permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'gh pr merge 1' } },
      ] },
    ]
    const summary = runJq(['-r', '--arg', 'effort', 'high', filter], JSON.stringify(execution))
    expect(summary).toContain('| `claude-opus-5-5` | `high` | `4` | `error_max_turns` |')
    expect(summary).toContain('| 1 | `Read` | `src/a\\|b.ts` |')
    expect(summary).toContain('| 2 | `mcp__pecot-workflow__issue_comment` | `o/r/1` |')
    expect(summary).toContain('| 3 | `Bash` | `echo ![x](https://example.com/a.png) <b>x` |')
    expect(summary).toContain('| 4 | `Other` | `body, line` |')
    expect(summary).toContain('| `Bash` | `gh pr merge 1` |')
    for (const hidden of ['考えた文', '本文の中身', 'ファイルの中身', 'コメントの本文']) expect(summary).not.toContain(hidden)
  })

  it('記録の jq は、ツールの呼び出しと拒否が存在しない場合は、None. を表示する', async () => {
    await explains('記録のステップの jq のテストです。ツールの呼び出しと拒否が存在しない場合に、それぞれの表の代わりに `None.` を 2 回出力することを確認します。')
    const filter = /jq -r --arg effort "\$effort" '([^']*)'/.exec(record.run ?? '')?.[1] ?? ''
    const summary = runJq(['-r', '--arg', 'effort', 'unknown', filter], '[]')
    expect(summary).toContain('| `unknown` | `unknown` |  |  |')
    expect(summary.match(/^None\.$/gm)).toHaveLength(2)
  })

  it('setup-node は、npm のキャッシュを復元せず、保存しない', async () => {
    await explains('`actions/setup-node` のテストです。secret を扱う job のため、`package-manager-cache` を `false` にして、キャッシュを復元せず保存しないことを確認します。')
    expect(stepUsing('actions/setup-node').with?.['package-manager-cache']).toBe(false)
  })

  it('すべての action を 40 桁の SHA で固定する', async () => {
    await explains('ステップが使う action のテストです。すべての `uses` が、40 桁の SHA で固定されていることを確認します。')
    const uses = steps.map(step => step.uses).filter(use => use !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })

  it('後始末のステップは、最新の正式版の CLI を取得する', async () => {
    await explains('後始末のステップの CLI のテストです。`@pecot/workflow-mcp@latest` で最新の正式版を取得して、`review finish` を実行することを確認します。')
    expect(finish.run).toMatch(/^npx -y --prefix=\/ @pecot\/workflow-mcp@latest review finish /)
  })
})

describe('自動レビューの導入の説明', () => {
  const document = existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : ''
  const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

  it('導入の説明のファイルが、w-help の参照に存在する', async () => {
    await explains('自動レビューの導入の説明のテストです。`skills/w-help/references/review-workflow.md` が存在することを確認します。')
    expect(existsSync(documentPath)).toBe(true)
  })

  it('テンプレートの変数と secret の名前が、すべて説明に記載されている', async () => {
    await explains('導入の説明の網羅のテストです。テンプレートが使う変数と secret の 16 個の名前が、すべて説明にバッククォートつきで記載されていることを確認します。')
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
      'PECOT_REVIEW_EFFORT',
      'PECOT_REVIEW_MAX_TURNS',
      'PECOT_REVIEW_MODEL',
      'PECOT_REVIEW_PROJECT',
      'PECOT_REVIEW_TIMEOUT_MINUTES',
      'PECOT_REVIEW_TRIGGER_PHRASE',
      'PECOT_REVIEW_WEB_ACCESS',
    ])
    for (const name of names) expect(document).toContain(`\`${name}\``)
  })

  it('利用者が変える 6 つの変数の既定値が、説明の表の同じ行に記載されている', async () => {
    await explains('導入の説明の表のテストです。利用者が変える 6 つの変数について、テンプレートの既定値が、説明の表の変数と同じ行に記載されていることを確認します。')
    const defaults = new Map(Array.from(active.matchAll(/vars\.(PECOT_REVIEW_[A-Z_]+) \|\| '([^']*)'/g), match => [match[1] ?? '', match[2] ?? '']))
    expect(new Set(defaults.keys())).toEqual(new Set([
      'PECOT_REVIEW_ALLOWED_BOTS',
      'PECOT_REVIEW_EFFORT',
      'PECOT_REVIEW_MAX_TURNS',
      'PECOT_REVIEW_MODEL',
      'PECOT_REVIEW_TIMEOUT_MINUTES',
      'PECOT_REVIEW_TRIGGER_PHRASE',
    ]))
    const rows = document.split('\n').filter(line => line.startsWith('|'))
    for (const [name, value] of defaults) {
      const row = rows.find(line => line.startsWith(`| \`${name}\` |`))
      expect(row, `${name} の行が説明の表に無い`).toBeDefined()
      expect(row).toContain(`\`${value}\``)
    }
  })

  it('変数 PECOT_REVIEW_PROJECT が、説明の「変えられる値」の表に記載されている', async () => {
    await explains('導入の説明の表のテストです。変数 `PECOT_REVIEW_PROJECT` の行が、「変えられる値」の節の表に含まれることを確認します。')
    const rows = markdownSection(document, '### 変えられる値').split('\n')
    expect(rows.some(line => line.startsWith('| `PECOT_REVIEW_PROJECT` |'))).toBe(true)
  })

  it('利用者が追加する行の印の名前が、説明に記載されている', async () => {
    await explains('導入の説明のテストです。`pecot-review:allowed-tools` と `pecot-review:prepare` の印の名前が、説明に記載されていることを確認します。')
    for (const area of ['allowed-tools', 'prepare']) expect(document).toContain(`pecot-review:${area}`)
  })

  it('自前の App の権限が、説明の「自前の GitHub App」の節と一致する', async () => {
    await explains('導入の説明の権限のテストです。トークンの発行ステップで要求する権限は、「自前の GitHub App」の節に記載された権限の一覧と一致することを確認します。')
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
