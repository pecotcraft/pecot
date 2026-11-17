// review finish の結果の決め方と、止まったことを知らせるコメントの本文。決まりは spec 027 の contracts/cli-commands.md。
// GitHub を読む・書くのは commands/review-finish.ts が受け持つ。
import { isJsonObject, jsonField, tryParseJsonText } from './json.js'
import { isJsonArray } from './python-format.js'
import type { JsonValue } from './python-format.js'

export type ReviewResult = 'reviewed' | 'failed' | 'limit' | 'setup-missing'
export type StoppedResult = Exclude<ReviewResult, 'reviewed'>
export type JobStatus = 'success' | 'failure' | 'cancelled'

/**
execution_file の最後の `type: result` の行。claude-code-action の base-action が SDK のメッセージの配列で書く
*/
export interface ExecutionResult {
  readonly subtype: string | undefined
  readonly isError: boolean
  readonly terminalReason: string | undefined
  readonly text: string
  readonly errors: readonly string[]
}

/**
execution_file の読み方。無い（absent）、JSON の配列として読めない（unreadable）、読めた（read。result の行が無ければ last は undefined）
*/
export type ExecutionReading
  = | { readonly kind: 'absent' }
    | { readonly kind: 'unreadable' }
    | { readonly kind: 'read', readonly last: ExecutionResult | undefined }

/**
自動レビューの step の `outcome`
*/
export type ReviewOutcome = 'success' | 'failure' | 'cancelled' | 'skipped'

/**
後始末の step が渡す値。`reviewConclusion` は action の出力 `conclusion` で、Claude Code を動かさなかった run では空
*/
export interface EnsureInput {
  readonly kind: 'ensure'
  readonly jobStatus: JobStatus
  readonly reviewOutcome: ReviewOutcome
  readonly reviewConclusion: string
  readonly hasToken: boolean
  readonly execution: ExecutionReading
}

export type FinishInput = EnsureInput | { readonly kind: 'result', readonly result: ReviewResult }

export type NextStep = 'retry' | 'auth' | 'app-token' | 'limit' | 'setup-detail'

export type SkipReason = 'reviewed' | 'job-succeeded' | 'workflow-mismatch'

export type FinishDecision
  = | { readonly action: 'skip', readonly reason: SkipReason }
    | {
      readonly action: 'write'
      readonly result: StoppedResult
      readonly next: NextStep
      // action が書いた人の権限で止めた場合と見分けがつかないので、起動した人の権限を確かめてから書く
      readonly shouldCheckActor: boolean
    }

function stringField(object: JsonValue, key: string): string | undefined {
  const value = jsonField(object, key)
  return typeof value === 'string' ? value : undefined
}

function readResultLine(line: JsonValue): ExecutionResult {
  const errors = jsonField(line, 'errors')
  return {
    subtype: stringField(line, 'subtype'),
    isError: jsonField(line, 'is_error') === true,
    terminalReason: stringField(line, 'terminal_reason'),
    text: stringField(line, 'result') ?? '',
    errors: isJsonArray(errors) ? errors.filter(entry => typeof entry === 'string') : [],
  }
}

/**
execution_file の本文を読む。JSON の配列でなければ unreadable、result の行が無ければ last は undefined
*/
export function readExecution(text: string): ExecutionReading {
  const parsed = tryParseJsonText(text)
  if (!isJsonArray(parsed)) return { kind: 'unreadable' }
  const last = parsed.findLast(line => isJsonObject(line) && jsonField(line, 'type') === 'result')
  return { kind: 'read', last: last === undefined ? undefined : readResultLine(last) }
}

const AUTHENTICATION_ERROR = 'authentication_error'

function isAuthenticationFailure(last: Readonly<ExecutionResult>): boolean {
  return last.text.includes(AUTHENTICATION_ERROR) || last.errors.some(entry => entry.includes(AUTHENTICATION_ERROR))
}

function write(result: StoppedResult, next: NextStep, shouldCheckActor = false): FinishDecision {
  return { action: 'write', result, next, shouldCheckActor }
}

function decideFailure(input: Readonly<EnsureInput>): FinishDecision {
  const last = input.execution.kind === 'read' ? input.execution.last : undefined
  if (last?.isError === true && last.terminalReason === 'api_error') return write('failed', isAuthenticationFailure(last) ? 'auth' : 'retry')
  if (last?.subtype === 'error_max_turns') return write('limit', 'limit')
  // action は、Claude の App のトークンを受け取れずに止めたときも、空の github_token を出力する
  if (input.reviewOutcome === 'failure' && !input.hasToken) return write('setup-missing', 'app-token')
  // Claude Code が動かずに step が落ちた run には、action が書いた人の権限で止めた場合が入る
  return write('failed', 'retry', input.reviewOutcome === 'failure' && input.reviewConclusion === '')
}

/**
結果を決める。順は spec 027 の contracts/cli-commands.md の表のとおりで、最初に当たった行で決める
*/
export function decideReviewFinish(input: Readonly<FinishInput>): FinishDecision {
  if (input.kind === 'result') {
    switch (input.result) {
      case 'reviewed': { return { action: 'skip', reason: 'reviewed' } }
      case 'failed': { return write('failed', 'retry') }
      case 'limit': { return write('limit', 'limit') }
      case 'setup-missing': { return write('setup-missing', 'setup-detail') }
    }
  }
  // PR のブランチで雛形を変えた run は、Claude の App がトークンを出さず、action がレビューを飛ばして step を成功で終える
  if (input.reviewOutcome === 'success' && input.reviewConclusion === '') return { action: 'skip', reason: 'workflow-mismatch' }
  switch (input.jobStatus) {
    case 'success': { return { action: 'skip', reason: 'job-succeeded' } }
    // 時間の上限と、人が run を取り消したときは同じ cancelled で、見分けない（research の R9）
    case 'cancelled': { return write('limit', 'limit') }
    case 'failure': { return decideFailure(input) }
  }
}

export type StopLocation = 'before-findings' | 'after-inline' | 'unknown'

export interface ReviewCommentReading {
  readonly body: string
  readonly createdAt: string
}

// w-revise の指摘のインラインコメントの先頭。`**F-NN**` か、2 巡目以降の `**R<巡>/F-NN**`
const FINDING_HEAD = /^\*\*(?:R\d+\/F|F)-\d+\*\*/u

/**
止まった場所。since より後に作られた指摘のインラインコメントがあれば after-inline。since が無ければ unknown
*/
export function stopLocationOf(comments: readonly Readonly<ReviewCommentReading>[], since: Readonly<Date> | undefined): StopLocation {
  if (since === undefined) return 'unknown'
  const sinceTime = since.getTime()
  const hasPosted = comments.some(comment => FINDING_HEAD.test(comment.body) && Date.parse(comment.createdAt) >= sinceTime)
  return hasPosted ? 'after-inline' : 'before-findings'
}

export interface RunIdentity {
  readonly runId: string
  readonly attempt: string
}

/**
同じ実行で 2 度書かないための、画面に出ない目印の行。re-run では run の ID が変わらないので、試行の番号も入れる
*/
export function stoppedMarker(run: Readonly<RunIdentity>): string {
  return `<!-- pecot-review-stopped run=${run.runId} attempt=${run.attempt} -->`
}

export interface IssueCommentReading {
  readonly body: string
  readonly userType: string
}

/**
同じ実行の目印を持つコメントがあるか。人が目印を書き込んで記録を消せないよう、Bot のコメントだけを見る
*/
export function hasStoppedMarker(comments: readonly Readonly<IssueCommentReading>[], run: Readonly<RunIdentity>): boolean {
  const marker = stoppedMarker(run)
  return comments.some(comment => comment.userType === 'Bot' && comment.body.includes(marker))
}

// テンプレートのプレースホルダ。cli/templates/comment/review-stopped.md の本文と同じ文字列
export const REVIEW_STOPPED_PLACEHOLDERS: Readonly<Record<'summary' | 'result' | 'location' | 'next', string>> = {
  summary: '<止まった理由を1行で>',
  result: '<結果>',
  location: '<止まった場所>',
  next: '<次にすること>',
}

const SUMMARIES: Readonly<Record<StoppedResult, string>> = {
  'failed': '自動レビューが途中で失敗して止まった',
  'limit': '自動レビューがターンか時間の上限で止まった',
  'setup-missing': '自動レビューに要る設定が足りずに止まった',
}

const RESULT_LINES: Readonly<Record<StoppedResult, string>> = {
  'failed': '`failed`（途中で失敗した）',
  'limit': '`limit`（ターンか時間の上限で止まった）',
  'setup-missing': '`setup-missing`（要る権限か設定が足りない）',
}

const LOCATION_LINES: Readonly<Record<StopLocation, string>> = {
  'before-findings': '指摘を投稿する前',
  'after-inline': 'インラインコメントを投稿した後（指摘の一覧はまだ無い）',
  'unknown': '分からない',
}

// 利用者の値をコードの書き方の中に入れる。改行とバッククォートで書き方が崩れないよう、空白と引用符に替える
function code(text: string): string {
  return `\`${text.replaceAll(/\s+/gu, ' ').replaceAll('`', '\'')}\``
}

function nextLine(next: NextStep, triggerPhrase: string, detail: string | undefined): string {
  const retry = `PR に ${code(triggerPhrase)} とコメントして起動し直すか、端末で ${code('/pecot-w:w-revise')} を回す`
  switch (next) {
    case 'retry': { return `実行の記録で原因を確かめてから、${retry}` }
    case 'auth': { return `モデルの認証に失敗した。${code('claude setup-token')} でトークンを作り直し、secret ${code('CLAUDE_CODE_OAUTH_TOKEN')} に登録し直す。その後、${retry}` }
    case 'app-token': { return `リポに Claude の GitHub App を入れてから、${retry}` }
    case 'limit': { return `大きな PR は、端末で ${code('/pecot-w:w-revise')} を回す。自動で回すなら、変数 ${code('PECOT_REVIEW_MAX_TURNS')}・${code('PECOT_REVIEW_TIMEOUT_MINUTES')} で上限を上げる。その後、PR に ${code(triggerPhrase)} とコメントして起動し直す` }
    case 'setup-detail': {
      const missing = detail === undefined || detail.trim() === '' ? '' : `足りない設定は ${code(detail.trim())} だ。`
      return `${missing}設定を整えてから、${retry}`
    }
  }
}

export interface ReviewStoppedValues {
  readonly result: StoppedResult
  readonly next: NextStep
  readonly location: StopLocation
  readonly triggerPhrase: string
  readonly detail?: string
  readonly run?: RunIdentity
}

/**
テンプレートの本文（フロントマターと冒頭のコメントを外したもの）のプレースホルダを埋める。
run があれば、末尾に目印の行を足す
*/
export function renderReviewStopped(templateBody: string, values: Readonly<ReviewStoppedValues>): string {
  const filled = templateBody
    .replace(REVIEW_STOPPED_PLACEHOLDERS.summary, () => SUMMARIES[values.result])
    .replace(REVIEW_STOPPED_PLACEHOLDERS.result, () => RESULT_LINES[values.result])
    .replace(REVIEW_STOPPED_PLACEHOLDERS.location, () => LOCATION_LINES[values.location])
    .replace(REVIEW_STOPPED_PLACEHOLDERS.next, () => nextLine(values.next, values.triggerPhrase, values.detail))
    .trim()
  return values.run === undefined ? `${filled}\n` : `${filled}\n\n${stoppedMarker(values.run)}\n`
}
