// Tracker の本文の一覧の範囲と、open の Tracker の探し方（cli/core/tracker_body.py の移植）。2 つの Tracker が共有する。
// 印の正規表現とエラーの型は呼び出し側が渡す。改行の正規化は python-format.ts の normalizeNewlines を使う。
import { isJsonObject } from './json.js'
import type { PecotError } from './errors.js'
import { pythonStrip } from './python-format.js'
import type { JsonValue } from './python-format.js'

/**
Python の正規表現の `\s`（str）と同じ範囲の文字クラスの中身。JS の `\s` から U+FEFF を除き、U+001C〜U+001F と U+0085 を足す
*/
export const PYTHON_SPACE = String.raw`\t\n\v\f\r \u001C-\u001F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000`

// eslint-disable-next-line security/detect-non-literal-regexp -- PYTHON_SPACE は固定の文字クラス
const LINE_BREAK_RUN = new RegExp(String.raw`[${PYTHON_SPACE}]*[\r\n][${PYTHON_SPACE}]*`, 'gu')

export const MARKER_PAIR_MESSAGE = 'cannot rewrite the list: the Tracker body does not have exactly one pair of list-begin / list-end markers'

/**
表のセルに入る文。`|` と改行と `<` を無害にする
*/
export function cell(text: string): string {
  return pythonStrip(text.replaceAll(LINE_BREAK_RUN, ' ')).replaceAll('<', '&lt;').replaceAll('|', String.raw`\|`)
}

export interface ListRegion {
  /**
  begin の印の直後
  */
  readonly begin: number
  /**
  end の印の先頭
  */
  readonly end: number
}

interface Span {
  readonly start: number
  readonly end: number
}

function spanOf(match: Readonly<{ index: number, 0: string }>): Span {
  return { start: match.index, end: match.index + match[0].length }
}

/**
本文の一覧の範囲。印の組が 1 組でない（欠け・重なり・順序の逆転）なら、渡された型のエラーを投げる。
正規表現は g フラグ付きで渡す
*/
export function listRegion(body: string, beginPattern: Readonly<RegExp>, endPattern: Readonly<RegExp>, ErrorType: new (message: string) => PecotError): ListRegion {
  const begins = Array.from(body.matchAll(beginPattern), spanOf)
  const ends = Array.from(body.matchAll(endPattern), spanOf)
  const [begin] = begins
  const [end] = ends
  if (begin === undefined || end === undefined || begins.length !== 1 || ends.length !== 1 || begin.end > end.start) {
    throw new ErrorType(MARKER_PAIR_MESSAGE)
  }
  return { begin: begin.end, end: end.start }
}

export interface TrackerIssue {
  readonly number: number
  readonly body: string
}

export interface FoundTracker {
  /**
  使う Tracker。open のものが無ければ undefined
  */
  readonly tracker: TrackerIssue | undefined
  /**
  ほかの open の Tracker の番号（警告用。sync は閉じない）
  */
  readonly others: readonly number[]
}

function trackerOf(issue: JsonValue, trackerPattern: Readonly<RegExp>): TrackerIssue | undefined {
  if (!isJsonObject(issue) || issue['state'] !== 'open') return undefined
  const { body, number } = issue
  return typeof body === 'string' && typeof number === 'number' && trackerPattern.test(body) ? { number, body } : undefined
}

/**
ラベルで引いた Issue から、open で本文に Tracker の印があるものを探す。複数あれば番号が最小のものを使う。
正規表現は g フラグなしで渡す
*/
export function findTracker(issues: readonly JsonValue[], trackerPattern: Readonly<RegExp>): FoundTracker {
  const found = issues.map(issue => trackerOf(issue, trackerPattern)).filter(issue => issue !== undefined).toSorted((a, b) => a.number - b.number)
  const [tracker, ...rest] = found
  return { tracker, others: rest.map(issue => issue.number) }
}
