// 自動処理（spec 023）の結果と、結果のコメントの目印。決まりは specs/023-label-triggered-autofix/data-model.md の「結果」「結果のコメント」。
import { NEEDS_ATTENTION_LABEL } from './readiness.js'
import type { IssuePullRequest } from './readiness.js'
import type { ExecutionReading, IssueCommentReading, JobStatus, RunIdentity } from './review-finish.js'

export type AutoResult = 'pr-created' | 'ci-passed' | 'ci-fix-pushed' | 'question' | 'out-of-scope' | 'failed' | 'limit' | 'setup-missing'

export const AUTO_RESULTS: readonly AutoResult[] = ['pr-created', 'ci-passed', 'ci-fix-pushed', 'question', 'out-of-scope', 'failed', 'limit', 'setup-missing']

const AUTO_RESULT_SET: ReadonlySet<string> = new Set<AutoResult>(AUTO_RESULTS)

// 人の対応を待って終わり、札に待ちの値（Needs Attention）を書く結果
const WAITING_RESULTS: ReadonlySet<AutoResult> = new Set<AutoResult>(['question', 'failed', 'limit'])

// 起動ラベルを残す結果。PR の CI の後の結果で、ラベルは pr-created のときに外れている
const LABEL_KEEPING_RESULTS: ReadonlySet<AutoResult> = new Set<AutoResult>(['ci-passed', 'ci-fix-pushed'])

const MARKER_PATTERN = /^\s*<!-- pecot-auto: result=(\S+) run=(\S+) attempt=(\S+) branch=(\S+) -->/u

/**
目印の無いブランチ。目印の正規表現が空でない値を求めるので、`-` を置く
*/
export const NO_BRANCH = '-'

function isAutoResult(value: string): value is AutoResult {
  return AUTO_RESULT_SET.has(value)
}

interface Marker {
  readonly result: AutoResult
  readonly runId: string
  readonly attempt: string
  readonly branch: string
}

function markerOf(body: string): Marker | undefined {
  const match = MARKER_PATTERN.exec(body)
  const [, result = '', runId = '', attempt = '', branch = ''] = match ?? []
  return match !== null && isAutoResult(result) ? { result, runId, attempt, branch } : undefined
}

// 人が目印を書き込んで記録を変えられないよう、Bot のコメントだけを見る
function botMarkers<T extends IssueCommentReading>(comments: readonly Readonly<T>[]): readonly { readonly marker: Marker, readonly comment: Readonly<T> }[] {
  const found: { readonly marker: Marker, readonly comment: Readonly<T> }[] = []
  for (const comment of comments) {
    const marker = comment.userType === 'Bot' ? markerOf(comment.body) : undefined
    if (marker !== undefined) found.push({ marker, comment })
  }
  return found
}

/**
本文の先頭の目印から結果を読む。目印が無いか、知らない結果なら undefined
*/
export function autoResultOf(body: string): AutoResult | undefined {
  return markerOf(body)?.result
}

/**
今の札が、自動処理が書いた Needs Attention か。comments は List issue comments の順（古い順）で渡す
*/
export function isLabelWrittenByAutomation(label: string | undefined, comments: readonly Readonly<IssueCommentReading>[]): boolean {
  if (label !== NEEDS_ATTENTION_LABEL) return false
  const last = botMarkers(comments).at(-1)?.marker.result
  return last !== undefined && WAITING_RESULTS.has(last)
}

export interface ResultEffects {
  /**
  札に待ちの値（Needs Attention）を書く
  */
  readonly setsWaiting: boolean
  readonly removesLabel: boolean
}

export function resultEffects(result: AutoResult): ResultEffects {
  return { setsWaiting: WAITING_RESULTS.has(result), removesLabel: !LABEL_KEEPING_RESULTS.has(result) }
}

/**
本文の先頭に置く目印の行
*/
export function autoMarker(result: AutoResult, run: Readonly<RunIdentity>, branch: string): string {
  return `<!-- pecot-auto: result=${result} run=${run.runId} attempt=${run.attempt} branch=${branch} -->`
}

/**
同じ run・同じ試行の目印を持つ Bot のコメントの結果。無ければ undefined
*/
export function runResultOf(comments: readonly Readonly<IssueCommentReading>[], run: Readonly<RunIdentity>): AutoResult | undefined {
  return botMarkers(comments).findLast(({ marker }) => marker.runId === run.runId && marker.attempt === run.attempt)?.marker.result
}

function markersOn<T extends IssueCommentReading>(comments: readonly Readonly<T>[], branch: string): readonly { readonly marker: Marker, readonly comment: Readonly<T> }[] {
  return botMarkers(comments).filter(({ marker }) => marker.branch === branch)
}

/**
CI を直した回数。同じブランチの ci-fix-pushed を、最後の limit の後から数える（上限で止まった後は数え直す）
*/
export function countCiFixes(comments: readonly Readonly<IssueCommentReading>[], branch: string): number {
  const markers = markersOn(comments, branch)
  const lastLimit = markers.findLastIndex(({ marker }) => marker.result === 'limit')
  return markers.slice(lastLimit + 1).filter(({ marker }) => marker.result === 'ci-fix-pushed').length
}

/**
同じブランチの Bot の最後の結果と、そのコメント。無ければ undefined
*/
export function lastResultOn<T extends IssueCommentReading>(comments: readonly Readonly<T>[], branch: string): { readonly result: AutoResult, readonly comment: Readonly<T> } | undefined {
  const last = markersOn(comments, branch).at(-1)
  return last === undefined ? undefined : { result: last.marker.result, comment: last.comment }
}

/**
同じブランチに、その結果の Bot の目印があるか
*/
export function hasResultOn(comments: readonly Readonly<IssueCommentReading>[], branch: string, result: AutoResult): boolean {
  return markersOn(comments, branch).some(({ marker }) => marker.result === result)
}

/**
目印に書くブランチ。Issue に紐づく開いた PR の head を先に、無ければ Development のブランチのうち末尾が `/<Issue番号>` のものを取る
*/
export function markerBranch(branches: readonly string[], pullRequests: readonly Readonly<IssuePullRequest>[], number: number): string {
  const suffix = `/${String(number)}`
  // PR を開いたブランチは、GitHub が linkedBranches から外す
  const heads = pullRequests.filter(pullRequest => pullRequest.state === 'open' && !pullRequest.isCrossRepository).map(pullRequest => pullRequest.headRefName)
  return heads.find(head => head.endsWith(suffix)) ?? heads.at(0) ?? branches.find(branch => branch.endsWith(suffix)) ?? NO_BRANCH
}

export type AutoEnsureDecision = { readonly action: 'skip' } | { readonly action: 'write', readonly result: 'limit' | 'failed' }

/**
`auto finish --ensure` の結果。上から順に見て、最初に当たった行で決める（contracts/cli-commands.md）
*/
export function decideAutoEnsure(input: Readonly<{ jobStatus: JobStatus, execution: ExecutionReading }>): AutoEnsureDecision {
  if (input.jobStatus === 'success') return { action: 'skip' }
  // 時間の上限と、人が run を取り消したときは同じ cancelled で、見分けない
  if (input.jobStatus === 'cancelled') return { action: 'write', result: 'limit' }
  const last = input.execution.kind === 'read' ? input.execution.last : undefined
  return { action: 'write', result: last?.subtype === 'error_max_turns' ? 'limit' : 'failed' }
}

/**
次にすることの文の種類。default は結果ごとの既定の文。ほかは、対象外のとき gate が理由から選ぶ
*/
export type AutoNext = 'default' | 'ready' | 'prerequisites' | 'hand-over' | 'subtask' | 'tracker' | 'issue-only' | 'reopen'

// テンプレートのプレースホルダ。cli/templates/comment/auto-result.md の本文と同じ文字列
export const AUTO_RESULT_PLACEHOLDERS: Readonly<Record<'summary' | 'body' | 'result' | 'record' | 'next', string>> = {
  summary: '<結果を1行で>',
  body: '<結果ごとの本文>',
  result: '<結果>',
  record: '<実行の記録>',
  next: '<次にすること>',
}

const SUMMARIES: Readonly<Record<AutoResult, string>> = {
  'pr-created': '自動処理が PR を作った',
  'ci-passed': '自動処理が作った PR の CI が通った',
  'ci-fix-pushed': '自動処理が CI の失敗を直して push した',
  'question': '質問があり、自動処理が止まった',
  'out-of-scope': '対象外なので、自動処理が止まった',
  'failed': 'テストや検証を通せず、自動処理が止まった',
  'limit': '上限に達し、自動処理が止まった',
  'setup-missing': '設定が足りず、自動処理が止まった',
}

const RESULT_LINES: Readonly<Record<AutoResult, string>> = {
  'pr-created': '`pr-created`（PR を作った）',
  'ci-passed': '`ci-passed`（PR の CI が通った）',
  'ci-fix-pushed': '`ci-fix-pushed`（CI の失敗を直して push した）',
  'question': '`question`（質問を書いて止まった）',
  'out-of-scope': '`out-of-scope`（対象外で止まった）',
  'failed': '`failed`（テストや検証を通せずに止まった）',
  'limit': '`limit`（ターン・時間・CI を直す回数の上限で止まった）',
  'setup-missing': '`setup-missing`（設定が足りずに止まった）',
}

// 利用者の値をコードの書き方の中に入れる。改行とバッククォートで書き方が崩れないよう、空白と引用符に替える
export function inlineCode(text: string): string {
  return `\`${text.replaceAll(/\s+/gu, ' ').replaceAll('`', '\'')}\``
}

function defaultNext(result: AutoResult, relabel: string): string {
  switch (result) {
    case 'pr-created': { return 'PR の CI の結果を待ち、CI が通ったら PR をレビューする' }
    case 'ci-passed': { return 'PR をレビューする' }
    case 'ci-fix-pushed': { return 'CI の結果を待つ。落ちたら、自動処理がもう一度直す' }
    case 'question': { return `答えを Issue にコメントで書き、${relabel}` }
    case 'out-of-scope': { return `対象外の理由を取り除いてから、${relabel}` }
    case 'failed': { return `実行の記録で原因を確かめてから、${relabel}` }
    case 'limit': { return `変数 ${inlineCode('PECOT_AUTO_MAX_TURNS')}・${inlineCode('PECOT_AUTO_TIMEOUT_MINUTES')}・${inlineCode('PECOT_AUTO_MAX_CI_ATTEMPTS')} で上限を上げるか、手で直す。その後、${relabel}` }
    case 'setup-missing': { return `足りない設定を整えてから、${relabel}` }
  }
}

function nextLine(result: AutoResult, next: AutoNext, label: string): string {
  const relabel = `起動ラベル ${inlineCode(label)} を付け直す`
  switch (next) {
    case 'default': { return defaultNext(result, relabel) }
    case 'ready': { return `${inlineCode('/pecot-w:w-ready')} の手順で Issue を Ready に置いてから、${relabel}` }
    case 'prerequisites': { return `前提が済み、Issue が Ready に移ってから、${relabel}` }
    case 'hand-over': { return `自動処理に任せるときは、Issue を Ready に戻してから、${relabel}` }
    case 'subtask': { return `サブタスクの Issue に、起動ラベル ${inlineCode(label)} を付ける` }
    case 'tracker': { return `Tracker の一覧の Issue へ、起動ラベル ${inlineCode(label)} を付ける` }
    case 'issue-only': { return `起動ラベル ${inlineCode(label)} は、PR でなく Issue に付ける` }
    case 'reopen': { return `続けるときは、Issue を開き直してから、${relabel}` }
  }
}

export interface AutoResultValues {
  readonly result: AutoResult
  /**
  起動ラベルの名前
  */
  readonly label: string
  /**
  結果ごとの本文。無ければ本文の行ごと消す
  */
  readonly body?: string
  /**
  札を書けなかったときの、足りない設定の名前
  */
  readonly missing?: readonly string[]
  readonly runUrl?: string
  readonly next?: AutoNext
  /**
  本文の先頭に置く目印の行
  */
  readonly marker?: string
}

function bodyBlock(values: Readonly<AutoResultValues>): string {
  const missing = values.missing ?? []
  const missingText = missing.length === 0 ? '' : `札を ${inlineCode(NEEDS_ATTENTION_LABEL)} にできなかった。足りない設定は ${missing.map(name => inlineCode(name)).join('・')} だ。`
  return [values.body?.trim() ?? '', missingText].filter(text => text !== '').join('\n\n')
}

/**
テンプレートの本文（フロントマターと冒頭のコメントを外したもの）のプレースホルダを埋める。marker があれば先頭に置く
*/
export function renderAutoResult(templateBody: string, values: Readonly<AutoResultValues>): string {
  const block = bodyBlock(values)
  const withBody = block === ''
    ? templateBody.replace(`${AUTO_RESULT_PLACEHOLDERS.body}\n\n`, '')
    : templateBody.replace(AUTO_RESULT_PLACEHOLDERS.body, () => block)
  const filled = withBody
    .replace(AUTO_RESULT_PLACEHOLDERS.summary, () => SUMMARIES[values.result])
    .replace(AUTO_RESULT_PLACEHOLDERS.result, () => RESULT_LINES[values.result])
    .replace(AUTO_RESULT_PLACEHOLDERS.record, () => values.runUrl ?? `分からない（${inlineCode('GITHUB_RUN_ID')} が無い）`)
    .replace(AUTO_RESULT_PLACEHOLDERS.next, () => nextLine(values.result, values.next ?? 'default', values.label))
    .trim()
  return values.marker === undefined ? `${filled}\n` : `${values.marker}\n\n${filled}\n`
}
