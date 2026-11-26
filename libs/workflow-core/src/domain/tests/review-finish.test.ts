// review finish の結果の決め方と、止まったことを知らせるコメントの本文を確かめる。
// 表は specs/027-auto-revise-on-pr/contracts/cli-commands.md の pecot review finish。

import { describe, expect, it } from 'vitest'

import { stripFrontmatter, stripLeadingHtmlComment } from '../frontmatter.js'
import { decideReviewFinish, hasStoppedMarker, readExecution, renderReviewStopped, REVIEW_STOPPED_PLACEHOLDERS, stopLocationOf, stoppedMarker } from '../review-finish.js'
import type { ExecutionReading, FinishInput, JobStatus, NextStep, ReviewOutcome, ReviewStoppedValues, StopLocation, StoppedResult } from '../review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '../sections.js'

// 配布テンプレートの comment/review-stopped.md を写す。実物がプレースホルダを持ち検証を通すことは、cli の review-finish.test.ts が確かめる
const TEMPLATE = '---\ntemplate: review-stopped\n---\n\n## Review stopped — <止まった理由を1行で>\n\n- 結果 — <結果>\n- 止まった場所 — <止まった場所>\n- 次にすること — <次にすること>\n'
const TEMPLATE_BODY = stripLeadingHtmlComment(stripFrontmatter(TEMPLATE))

function resultLine(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'assistant' }, { type: 'result', ...fields }])
}

const ABSENT: ExecutionReading = { kind: 'absent' }

interface EnsureValues {
  readonly job?: JobStatus
  readonly outcome?: ReviewOutcome
  readonly conclusion?: string
  readonly hasToken?: boolean
  readonly execution?: ExecutionReading
}

// 既定は、Claude Code が動いて失敗した run（job と step が failure、conclusion が failure、トークンあり）
function ensure(values: Readonly<EnsureValues> = {}): FinishInput {
  return {
    kind: 'ensure',
    jobStatus: values.job ?? 'failure',
    reviewOutcome: values.outcome ?? 'failure',
    reviewConclusion: values.conclusion ?? 'failure',
    hasToken: values.hasToken ?? true,
    execution: values.execution ?? ABSENT,
  }
}

function executionOf(fields: Readonly<Record<string, unknown>>): ExecutionReading {
  return readExecution(resultLine(fields))
}

const MAX_TURNS = executionOf({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' })
const AUTH_FAILURE = executionOf({ subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'API Error: Token exchange failed with status 401: {"error":{"type":"authentication_error"}}' })
const SUCCESS_WITH_API_ERROR = executionOf({ subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'error 4012 tokens' })

describe('readExecution', () => {
  it('最後の type: result の行の subtype・is_error・terminal_reason・result・errors を読む', () => {
    const text = JSON.stringify([
      { type: 'result', subtype: 'success', is_error: false, result: 'first' },
      { type: 'assistant' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'tool_error', errors: ['boom', 1] },
    ])
    expect(readExecution(text)).toEqual({ kind: 'read', last: { subtype: 'error_during_execution', isError: true, terminalReason: 'tool_error', text: '', errors: ['boom'] } })
  })

  it('result の行が無ければ last を undefined にする', () => {
    expect(readExecution(JSON.stringify([{ type: 'assistant' }]))).toEqual({ kind: 'read', last: undefined })
  })

  it.each(['not json', '{"type":"result"}'])('JSON の配列でない本文（%s）は unreadable にする', (text) => {
    expect(readExecution(text)).toEqual({ kind: 'unreadable' })
  })
})

describe('decideReviewFinish', () => {
  it.each<[string, FinishInput, StoppedResult, NextStep, boolean]>([
    ['--result failed', { kind: 'result', result: 'failed' }, 'failed', 'retry', false],
    ['--result limit', { kind: 'result', result: 'limit' }, 'limit', 'limit', false],
    ['--result setup-missing', { kind: 'result', result: 'setup-missing' }, 'setup-missing', 'setup-detail', false],
    ['job が cancelled', ensure({ job: 'cancelled', outcome: 'cancelled' }), 'limit', 'limit', false],
    ['api_error（クレジット）', ensure({ execution: executionOf({ subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Credit balance is too low' }) }), 'failed', 'retry', false],
    ['api_error（認証。result の文）', ensure({ execution: AUTH_FAILURE }), 'failed', 'auth', false],
    ['api_error（認証。errors の配列）', ensure({ execution: executionOf({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error', errors: ['authentication_error'] }) }), 'failed', 'auth', false],
    ['subtype が error_max_turns', ensure({ execution: MAX_TURNS }), 'limit', 'limit', false],
    ['step が failure で、github_token が無い', ensure({ conclusion: '', hasToken: false }), 'setup-missing', 'app-token', false],
    ['step が failure で、トークンはあるが Claude Code が動いていない', ensure({ conclusion: '' }), 'failed', 'retry', true],
    ['step が failure で、Claude Code が動いた', ensure(), 'failed', 'retry', false],
    ['自動レビューより前の step が落ちた', ensure({ outcome: 'skipped', conclusion: '', hasToken: false }), 'failed', 'retry', false],
    ['execution_file を読めない', ensure({ execution: { kind: 'unreadable' } }), 'failed', 'retry', false],
    ['result の行が無い', ensure({ execution: { kind: 'read', last: undefined } }), 'failed', 'retry', false],
    ['subtype が success でも、api_error でない（上限を超えたターン数）', ensure({ execution: executionOf({ subtype: 'success', is_error: false, num_turns: 99 }) }), 'failed', 'retry', false],
    ['ほかの subtype', ensure({ execution: executionOf({ subtype: 'error_during_execution', is_error: true }) }), 'failed', 'retry', false],
  ])('%s のとき、表の結果と次にすることを返す', (_name, input, result, next, shouldCheckActor) => {
    expect(decideReviewFinish(input)).toEqual({ action: 'write', result, next, shouldCheckActor })
  })

  it('subtype だけでは決めない。subtype が success でも is_error と api_error なら failed', () => {
    expect(decideReviewFinish(ensure({ execution: SUCCESS_WITH_API_ERROR }))).toMatchObject({ result: 'failed', next: 'retry' })
  })

  it('上限と認証の失敗は、トークンの無さより先に見る', () => {
    expect(decideReviewFinish(ensure({ hasToken: false, execution: MAX_TURNS }))).toMatchObject({ result: 'limit' })
    expect(decideReviewFinish(ensure({ hasToken: false, execution: AUTH_FAILURE }))).toMatchObject({ result: 'failed', next: 'auth' })
  })

  it('--result reviewed は書かない', () => {
    expect(decideReviewFinish({ kind: 'result', result: 'reviewed' })).toEqual({ action: 'skip', reason: 'reviewed' })
  })

  it.for<[string, FinishInput]>([
    ['job も成功', ensure({ job: 'success', outcome: 'success', conclusion: '' })],
    ['後の step で job が失敗', ensure({ job: 'failure', outcome: 'success', conclusion: '' })],
  ])('自動レビューの step が成功で conclusion が空なら（%s）、雛形の食い違いとして書かない', ([, input]) => {
    expect(decideReviewFinish(input)).toEqual({ action: 'skip', reason: 'workflow-mismatch' })
  })

  it.for<[string, FinishInput]>([
    ['レビューを終えた', ensure({ job: 'success', outcome: 'success', conclusion: 'success' })],
    ['PR の確かめで飛ばした', ensure({ job: 'success', outcome: 'skipped', conclusion: '', hasToken: false })],
  ])('job が success なら（%s）書かない', ([, input]) => {
    expect(decideReviewFinish(input)).toEqual({ action: 'skip', reason: 'job-succeeded' })
  })

  it('setup-missing は、--result か、step が failure でトークンが無いときだけ出る', () => {
    const results = [
      ensure(),
      ensure({ hasToken: false, outcome: 'skipped' }),
      ensure({ job: 'cancelled', outcome: 'cancelled', hasToken: false }),
      ensure({ execution: { kind: 'unreadable' } }),
    ].map(input => decideReviewFinish(input))
    expect(results.filter(decision => decision.action === 'write' && decision.result === 'setup-missing')).toEqual([])
  })
})

describe('stopLocationOf', () => {
  const since = new Date('2026-11-17T10:00:00Z')

  it.each<[string, readonly { body: string, createdAt: string }[], StopLocation]>([
    ['since より後の F-NN のインラインコメントがあれば、投稿した後', [{ body: '**F-01** [tech] 型が違う', createdAt: '2026-11-17T10:05:00Z' }], 'after-inline'],
    ['since より前の指摘は数えない', [{ body: '**F-01** [tech] 前の実行', createdAt: '2026-11-17T09:59:59Z' }], 'before-findings'],
    ['F-NN で始まらないコメントは数えない', [{ body: 'nit: **F-01**', createdAt: '2026-11-17T10:05:00Z' }], 'before-findings'],
    ['コメントが無ければ、投稿する前', [], 'before-findings'],
  ])('%s を返す', (_name, comments, location) => {
    expect(stopLocationOf(comments, since)).toBe(location)
  })

  it('since が無ければ、分からない', () => {
    expect(stopLocationOf([{ body: '**F-01** [tech] x', createdAt: '2026-11-17T10:05:00Z' }], undefined)).toBe('unknown')
  })
})

describe('目印', () => {
  const run = { runId: '44040534751', attempt: '1' }

  it('実行の ID と試行の番号を入れた、画面に出ないコメントの行にする', () => {
    expect(stoppedMarker(run)).toBe('<!-- pecot-review-stopped run=44040534751 attempt=1 -->')
  })

  it('Bot のコメントが同じ実行・同じ試行の目印を持てば、書いたとみなす', () => {
    expect(hasStoppedMarker([{ body: `x\n${stoppedMarker(run)}\n`, userType: 'Bot' }], run)).toBe(true)
  })

  it('re-run で試行の番号が違えば、書いていないとみなす', () => {
    expect(hasStoppedMarker([{ body: stoppedMarker(run), userType: 'Bot' }], { ...run, attempt: '2' })).toBe(false)
  })

  it('人が書いた目印は数えない', () => {
    expect(hasStoppedMarker([{ body: stoppedMarker(run), userType: 'User' }], run)).toBe(false)
  })
})

describe('renderReviewStopped', () => {
  const sections = extractSectionsFromTemplate(TEMPLATE)

  it('テンプレートの本文が、埋めるプレースホルダをすべて持つ', () => {
    for (const placeholder of Object.values(REVIEW_STOPPED_PLACEHOLDERS)) expect(TEMPLATE_BODY).toContain(placeholder)
  })

  it.each<ReviewStoppedValues>([
    { result: 'failed', next: 'retry', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'failed', next: 'auth', location: 'unknown', triggerPhrase: '@pecotbot review', run: { runId: '1', attempt: '1' } },
    { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '2', attempt: '3' } },
    { result: 'setup-missing', next: 'app-token', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret <X> `Y`' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret X\nと変数 Y' },
  ])('%$ 行目の $result と $next の本文が、テンプレートの検証を通る', (values) => {
    const body = renderReviewStopped(TEMPLATE_BODY, values)
    expect(validateSections(body, sections)).toEqual([])
    expect(validateHeadingSummaries(body, sections)).toEqual([])
    expect(validateBodyStyle(body)).toEqual([])
  })

  it('結果・止まった場所・次にすることと目印を書く', () => {
    const body = renderReviewStopped(TEMPLATE_BODY, { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '7', attempt: '2' } })
    expect(body).toBe([
      '## Review stopped — 自動レビューがターンか時間の上限で止まった',
      '',
      '- 結果 — `limit`（ターンか時間の上限で止まった）',
      '- 止まった場所 — インラインコメントを投稿した後（指摘の一覧はまだ無い）',
      '- 次にすること — 変数 `PECOT_REVIEW_MAX_TURNS`・`PECOT_REVIEW_TIMEOUT_MINUTES` で上限を上げる。その後、PR に `@my-bot review` とコメントして起動し直す',
      '',
      '<!-- pecot-review-stopped run=7 attempt=2 -->',
      '',
    ].join('\n'))
  })

  it('setup-missing の detail を、足りない設定の名前として書く', () => {
    const body = renderReviewStopped(TEMPLATE_BODY, { result: 'setup-missing', next: 'setup-detail', location: 'before-findings', triggerPhrase: '@pecotbot review', detail: 'pull-requests: write' })
    expect(body).toContain('足りない設定は `pull-requests: write` だ。')
  })

  it('detail の改行と続く空白は、1 つの空白にまとめて 1 行のコードに書く', () => {
    const body = renderReviewStopped(TEMPLATE_BODY, { result: 'setup-missing', next: 'setup-detail', location: 'before-findings', triggerPhrase: '@pecotbot review', detail: 'secret X\n  と変数 Y' })
    expect(body).toContain('足りない設定は `secret X と変数 Y` だ。')
  })
})
