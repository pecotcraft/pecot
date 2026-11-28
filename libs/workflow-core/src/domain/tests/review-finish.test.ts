// review finish の結果の決め方と、止まったことを知らせるコメントの本文を確かめる。
// 表は specs/027-auto-revise-on-pr/contracts/cli-commands.md の pecot review finish。

import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { stripFrontmatter, stripLeadingHtmlComment } from '../frontmatter.js'
import { decideReviewFinish, hasStoppedMarker, readExecution, renderReviewStopped, REVIEW_STOPPED_PLACEHOLDERS, stopLocationOf, stoppedMarker } from '../review-finish.js'
import type { ExecutionReading, FinishInput, JobStatus, NextStep, ReviewOutcome, ReviewStoppedValues, StopLocation, StoppedResult } from '../review-finish.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateHeadingSummaries, validateSections } from '../sections.js'

// actions/src/templates/review-stopped.md を写す。実物がプレースホルダを持ち検証を通すことは、actions の review-stopped-template.test.ts が確かめる
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
  it('最後の result の行から、subtype・is_error・terminal_reason・result・errors を読み取る', async () => {
    await explains('Claude Code の実行結果を読み取る `readExecution` のテストです。JSON の配列に result の行が複数ある場合に、最後の行の `subtype` や `is_error` などを読み取り、文字列でない `errors` の要素は除くことを確認します。')
    const text = stepSync('入力の JSON を用意する', () => JSON.stringify([
      { type: 'result', subtype: 'success', is_error: false, result: 'first' },
      { type: 'assistant' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'tool_error', errors: ['boom', 1] },
    ]))
    stepSync('結果を比べる', () => {
      expect(readExecution(text)).toEqual({ kind: 'read', last: { subtype: 'error_during_execution', isError: true, terminalReason: 'tool_error', text: '', errors: ['boom'] } })
    })
  })

  it('result の行が存在しなければ、last を undefined にする', async () => {
    await explains('result の行が存在しない場合の、`readExecution` のテストです。`type` が `result` の行がないとき、`last` が `undefined` の `read` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(readExecution(JSON.stringify([{ type: 'assistant' }]))).toEqual({ kind: 'read', last: undefined })
    })
  })

  it.each(['not json', '{"type":"result"}'])('JSON の配列でない本文（%s）は、unreadable として扱う', async (text) => {
    await explains('JSON の配列として読めない場合の、`readExecution` のテストです。JSON ではない文字列や、配列ではない JSON を渡したとき、`unreadable` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(readExecution(text)).toEqual({ kind: 'unreadable' })
    })
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
  ])('%s の場合は、表のとおりの結果と次にすることを決める', async (_name, input, result, next, shouldCheckActor) => {
    await explains('自動レビューの終了時に、書く内容を決める `decideReviewFinish` のテストです。`--result` の指定や、job と step の結果、Claude Code の実行結果の組み合わせごとに、表のとおりの結果・次にすること・実行者の確認の要否を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish(input)).toEqual({ action: 'write', result, next, shouldCheckActor })
    })
  })

  it('subtype だけでは決めない。subtype が success でも、is_error が真で api_error なら failed にする', async () => {
    await explains('Claude Code の実行結果の判定のテストです。`subtype` が `success` でも、`is_error` が真で終了理由が `api_error` の場合は、結果を `failed`、次にすることを `retry` とすることを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish(ensure({ execution: SUCCESS_WITH_API_ERROR }))).toMatchObject({ result: 'failed', next: 'retry' })
    })
  })

  it('上限と認証の失敗は、トークンが存在しない場合より先に判定する', async () => {
    await explains('判定の優先順位のテストです。トークンがない場合でも、ターン数の上限なら `limit`、認証の失敗なら `failed` と `auth` を返し、トークンの不足を理由にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish(ensure({ hasToken: false, execution: MAX_TURNS }))).toMatchObject({ result: 'limit' })
      expect(decideReviewFinish(ensure({ hasToken: false, execution: AUTH_FAILURE }))).toMatchObject({ result: 'failed', next: 'auth' })
    })
  })

  it('--result が reviewed なら、コメントを書かない', async () => {
    await explains('`--result reviewed` を渡した場合のテストです。レビューが完了しているため、コメントを書かず、理由を `reviewed` として省略することを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish({ kind: 'result', result: 'reviewed' })).toEqual({ action: 'skip', reason: 'reviewed' })
    })
  })

  it.for<[string, FinishInput]>([
    ['job も成功', ensure({ job: 'success', outcome: 'success', conclusion: '' })],
    ['後の step で job が失敗', ensure({ job: 'failure', outcome: 'success', conclusion: '' })],
  ])('自動レビューの step が成功で conclusion が空の場合（%s）は、雛形の食い違いとして書かない', async ([, input]) => {
    await explains('Actions の雛形とのずれがある場合のテストです。自動レビューの step が成功なのに `conclusion` が空のとき、コメントを書かず、理由を `workflow-mismatch` として省略することを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish(input)).toEqual({ action: 'skip', reason: 'workflow-mismatch' })
    })
  })

  it.for<[string, FinishInput]>([
    ['レビューを終えた', ensure({ job: 'success', outcome: 'success', conclusion: 'success' })],
    ['PR の確かめで飛ばした', ensure({ job: 'success', outcome: 'skipped', conclusion: '', hasToken: false })],
  ])('job が success の場合（%s）は、コメントを書かない', async ([, input]) => {
    await explains('job が成功している場合のテストです。レビューを終えた場合と、PR の確認で step を省略した場合のどちらでも、コメントを書かず、理由を `job-succeeded` として省略することを確認します。')
    stepSync('結果を比べる', () => {
      expect(decideReviewFinish(input)).toEqual({ action: 'skip', reason: 'job-succeeded' })
    })
  })

  it('setup-missing は、--result で指定した場合と、step が failure でトークンが存在しない場合だけ返す', async () => {
    await explains('`setup-missing` を返さない場合のテストです。トークンがなくても step が失敗していない場合や、step が失敗してもトークンがある場合は、`setup-missing` にならないことを確認します。')
    const results = stepSync('入力の組み合わせを用意する', () => [
      ensure(),
      ensure({ hasToken: false, outcome: 'skipped' }),
      ensure({ job: 'cancelled', outcome: 'cancelled', hasToken: false }),
      ensure({ execution: { kind: 'unreadable' } }),
    ].map(input => decideReviewFinish(input)))
    stepSync('結果を比べる', () => {
      expect(results.filter(decision => decision.action === 'write' && decision.result === 'setup-missing')).toEqual([])
    })
  })
})

describe('stopLocationOf', () => {
  const since = new Date('2026-11-17T10:00:00Z')

  it.each<[string, readonly { body: string, createdAt: string }[], StopLocation]>([
    ['since より後の F-NN のインラインコメントがあれば、投稿した後', [{ body: '**F-01** [tech] 型が違う', createdAt: '2026-11-17T10:05:00Z' }], 'after-inline'],
    ['since より前の指摘は数えない', [{ body: '**F-01** [tech] 前の実行', createdAt: '2026-11-17T09:59:59Z' }], 'before-findings'],
    ['F-NN で始まらないコメントは数えない', [{ body: 'nit: **F-01**', createdAt: '2026-11-17T10:05:00Z' }], 'before-findings'],
    ['コメントが無ければ、投稿する前', [], 'before-findings'],
  ])('止まった場所は、%s', async (_name, comments, location) => {
    await explains('止まった場所を、既存のコメントから判断する `stopLocationOf` のテストです。実行の開始時刻より後で、`F-NN` で始まるインラインコメントがある場合だけ、投稿した後（`after-inline`）になり、それ以外は `before-findings` になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(stopLocationOf(comments, since)).toBe(location)
    })
  })

  it('since が存在しなければ、止まった場所を unknown とする', async () => {
    await explains('開始時刻が指定されていない場合の、`stopLocationOf` のテストです。`since` が `undefined` のとき、止まった場所を `unknown` として返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(stopLocationOf([{ body: '**F-01** [tech] x', createdAt: '2026-11-17T10:05:00Z' }], undefined)).toBe('unknown')
    })
  })
})

describe('目印', () => {
  const run = { runId: '44040534751', attempt: '1' }

  it('実行の ID と試行の番号を入れた、画面に表示されないコメントの行を返す', async () => {
    await explains('止まったことを知らせるコメントの目印を作る、`stoppedMarker` のテストです。実行の ID と試行の番号を含む、画面に表示されない HTML コメントの行を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(stoppedMarker(run)).toBe('<!-- pecot-review-stopped run=44040534751 attempt=1 -->')
    })
  })

  it('Bot のコメントが同じ実行と同じ試行の目印を持てば、書き込み済みとみなす', async () => {
    await explains('目印の有無を判定する `hasStoppedMarker` のテストです。Bot のコメントに、同じ実行と同じ試行の目印が含まれる場合に、真を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasStoppedMarker([{ body: `x\n${stoppedMarker(run)}\n`, userType: 'Bot' }], run)).toBe(true)
    })
  })

  it('re-run で試行の番号が異なれば、書き込み済みとみなさない', async () => {
    await explains('再実行した場合の、`hasStoppedMarker` のテストです。目印の試行の番号が現在と異なる場合に、書き込み済みとみなさず、偽を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasStoppedMarker([{ body: stoppedMarker(run), userType: 'Bot' }], { ...run, attempt: '2' })).toBe(false)
    })
  })

  it('人が書いた目印は、書き込み済みに数えない', async () => {
    await explains('コメントの投稿者の種別の、`hasStoppedMarker` のテストです。投稿者が人（`User`）の場合は、同じ目印があっても、偽を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasStoppedMarker([{ body: stoppedMarker(run), userType: 'User' }], run)).toBe(false)
    })
  })
})

describe('renderReviewStopped', () => {
  const sections = extractSectionsFromTemplate(TEMPLATE)

  it('テンプレートの本文が、埋めるプレースホルダをすべて含む', async () => {
    await explains('止まったことを知らせるコメントのテンプレートのテストです。本文が、`renderReviewStopped` で埋めるプレースホルダをすべて含むことを確認します。')
    stepSync('結果を比べる', () => {
      for (const placeholder of Object.values(REVIEW_STOPPED_PLACEHOLDERS)) expect(TEMPLATE_BODY).toContain(placeholder)
    })
  })

  it.each<ReviewStoppedValues>([
    { result: 'failed', next: 'retry', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'failed', next: 'auth', location: 'unknown', triggerPhrase: '@pecotbot review', run: { runId: '1', attempt: '1' } },
    { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '2', attempt: '3' } },
    { result: 'setup-missing', next: 'app-token', location: 'before-findings', triggerPhrase: '@pecotbot review' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret <X> `Y`' },
    { result: 'setup-missing', next: 'setup-detail', location: 'unknown', triggerPhrase: '@pecotbot review', detail: 'secret X\nと変数 Y' },
  ])('%$ 番目の例（$result と $next）の本文は、テンプレートの検証を通る', async (values) => {
    await explains('コメントの本文を作る `renderReviewStopped` のテストです。結果・次にすること・止まった場所・detail の値の組み合わせごとに、作った本文がテンプレートの節・見出し・書式の検証を通ることを確認します。')
    const body = stepSync('renderReviewStopped を呼ぶ', () => renderReviewStopped(TEMPLATE_BODY, values))
    stepSync('結果を比べる', () => {
      expect(validateSections(body, sections)).toEqual([])
      expect(validateHeadingSummaries(body, sections)).toEqual([])
      expect(validateBodyStyle(body)).toEqual([])
    })
  })

  it('結果・止まった場所・次にすることと目印を、本文に書く', async () => {
    await explains('上限で止まった場合の本文のテストです。見出し・結果・止まった場所・次にすること・目印の行が、期待どおりの文面で出力されることを確認します。')
    const body = stepSync('renderReviewStopped を呼ぶ', () => renderReviewStopped(TEMPLATE_BODY, { result: 'limit', next: 'limit', location: 'after-inline', triggerPhrase: '@my-bot review', run: { runId: '7', attempt: '2' } }))
    stepSync('結果を比べる', () => {
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
  })

  it('setup-missing の detail を、不足している設定の名前として書く', async () => {
    await explains('`setup-missing` の本文のテストです。`detail` に渡した設定の名前が、不足している設定として本文に含まれることを確認します。')
    const body = stepSync('renderReviewStopped を呼ぶ', () => renderReviewStopped(TEMPLATE_BODY, { result: 'setup-missing', next: 'setup-detail', location: 'before-findings', triggerPhrase: '@pecotbot review', detail: 'pull-requests: write' }))
    stepSync('結果を比べる', () => {
      expect(body).toContain('足りない設定は `pull-requests: write` だ。')
    })
  })

  it('detail の改行と続く空白は、1 つの空白にまとめ、1 行のコードとして書く', async () => {
    await explains('改行を含む `detail` の本文のテストです。改行と続く空白を 1 つの空白にまとめ、1 行のコードとして本文に含めることを確認します。')
    const body = stepSync('renderReviewStopped を呼ぶ', () => renderReviewStopped(TEMPLATE_BODY, { result: 'setup-missing', next: 'setup-detail', location: 'before-findings', triggerPhrase: '@pecotbot review', detail: 'secret X\n  と変数 Y' }))
    stepSync('結果を比べる', () => {
      expect(body).toContain('足りない設定は `secret X と変数 Y` だ。')
    })
  })
})
