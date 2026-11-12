// 人の判断を待つ dependabot の PR を Tracker に載せるための純粋な処理（cli/core/dependabot_prs.py の移植）。
// 自動マージの対象かは dependabot/fetch-metadata v3.1.0 と同じ情報源・規則で決める。
// 正規表現は m フラグと `.`・`\s`・`\d`・`$` に頼らず、Python と同じ範囲を明示する。

import { PecotError } from './errors.js'
import { isJsonObject, jsonField } from './json.js'
import type { JsonObject } from './json.js'
import { isJsonArray, normalizeNewlines, parsePythonInteger, pythonStrip } from './python-format.js'
import type { JsonValue } from './python-format.js'
import { compilePattern, listRegion, markerPatterns, NON_SPACE, SPACE } from './tracker-body.js'
import { parseYamlDocument } from './yaml-document.js'

export const PR_LABEL = 'dependabot-pr'
const TRACKER_MARKER = '<!-- pecot-dependabot-pr: tracker -->'
export const LIST_BEGIN = '<!-- pecot-dependabot-pr: list-begin -->'
export const LIST_END = '<!-- pecot-dependabot-pr: list-end -->'
export const PRIORITY = 'medium'
// security の Tracker の種類ごとの見出しと同じ形にする
const SECTION_HEADING = '## dependabot PR'

const REASON_UNKNOWN = 'unknown update type'
const REASON_MAJOR = 'major'
const REASON_FAILED = 'checks failed'
const REASON_STUCK = 'checks not finishing'
const REASON_CONFLICT = 'conflict'
const REASON_DEQUEUED = 'dequeued'
const REASON_NO_AUTO_MERGE = 'no auto-merge'

const MICROSECONDS_PER_MINUTE = 60_000_000n
// dependabot-auto-merge.yml が auto-merge を入れるまでの猶予と、検証の待ち時間の上限
const GRACE = 30n * MICROSECONDS_PER_MINUTE
const CHECKS_TIMEOUT = 24n * 60n * MICROSECONDS_PER_MINUTE

const LINE_START = '(?<![^\\n])'
const LINE_END = '(?![^\\n])'
const BACKTICK = '`'
const DIGIT = '\\p{Nd}'

const ROW_MARKER_PATTERN = compilePattern(`<!--${SPACE}*pecot-dependabot-pr:${SPACE}*pr/(${DIGIT}+)${SPACE}*-->`, 'u')
const MARKERS = markerPatterns('pecot-dependabot-pr')
export const TRACKER_PATTERN = MARKERS.tracker
const TABLE_LINE_PATTERN = compilePattern(String.raw`^${SPACE}*\|`, 'u')
const LINE_BREAK_RUN = compilePattern(String.raw`${SPACE}*[\r\n]+${SPACE}*`, 'gu')

// fetch-metadata v3.1.0 の parse・parseMetadataLinks と同じ。commit の message から YAML と版の記述を抜く
const YAML_PATTERN = compilePattern(String.raw`${LINE_START}-{3}\n([\s\S]*?)\n${LINE_START}\.{3}\n`, 'u')
const BUMP_PATTERN = compilePattern(String.raw`${LINE_START}Bumps [^\n]* from (v?${DIGIT}[^ ]*) to (v?${DIGIT}[^ ]*)\.${LINE_END}`, 'u')
const UPDATES_PATTERN = compilePattern(`${LINE_START}Updates ${BACKTICK}(${NON_SPACE}+)${BACKTICK} (?:from (${NON_SPACE}+) )?to (${NON_SPACE}+)${LINE_END}`, 'gu')
// eslint-disable-next-line security/detect-unsafe-regex -- 入力は GitHub が返す固定の形の時刻で、量指定子は入れ子にならない
const TIME_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d+))?(?:Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u
const UPDATE_TYPES: ReadonlySet<string> = new Set(['patch', 'minor', 'major'])
// GraphQL の commit.author.user.login。PR の author は `[bot]` が付かない
const BOT_LOGIN = 'dependabot[bot]'

const MAX_HOUR = 23
const MAX_MINUTE_OR_SECOND = 59
const MONTH_OFFSET = 1
const MICROSECOND_DIGITS = 6

/**
Tracker の本文を読み書きできない場合のエラー
*/
export class DependabotPrError extends PecotError {}

function ownField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? new Map(Object.entries(value)).get(key) : undefined
}

// Python の dict だけを通す。Set・Buffer・Date などは辞書として読まない
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function objectOrEmpty(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

function arrayOrEmpty(value: JsonValue | undefined): readonly JsonValue[] {
  return isJsonArray(value) ? value : []
}

// キーをたどった先の値。途中がオブジェクトでなければ undefined
function dig(value: JsonValue | undefined, ...keys: readonly string[]): JsonValue | undefined {
  let current = value
  for (const key of keys) current = jsonField(current, key)
  return current
}

function firstNode(value: JsonValue | undefined): JsonObject {
  const [first] = arrayOrEmpty(jsonField(value, 'nodes'))
  return objectOrEmpty(first)
}

// Python の bool() と同じ
function isTruthyValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/**
fetch-metadata の calculateUpdateType と同じ。前後のどちらかが空・両方が同じなら undefined。
`v` は最初の 1 文字を除く。先頭が違えば major、要素が 2 つ未満か 2 番目が違えば minor、それ以外は patch
*/
function versionType(oldVersion: string, newVersion: string): string | undefined {
  if (oldVersion === '' || newVersion === '' || oldVersion === newVersion) return undefined
  const a = removeFirstV(oldVersion).split('.')
  const b = removeFirstV(newVersion).split('.')
  if (a[0] !== b[0]) return 'major'
  if (a.length < 2 || b.length < 2 || a[1] !== b[1]) return 'minor'
  return 'patch'
}

function removeFirstV(text: string): string {
  const index = text.indexOf('v')
  return index === -1 ? text : text.slice(0, index) + text.slice(index + 1)
}

function readYamlMapping(source: string): unknown {
  let data: unknown
  try {
    data = parseYamlDocument(source)
  }
  catch {
    return undefined
  }
  return isPlainObject(data) ? data : undefined
}

/**
commit の message から、依存ごとの [dependency-name, update-type] を読む。
update-type は major・minor・patch のどれか。YAML に無ければ message の版から計算し、版も無ければ undefined。
YAML の欠け・読めない YAML・依存の無い YAML では undefined
*/
export function parseUpdateMetadata(message: string): readonly (readonly [string, string | undefined])[] | undefined {
  const text = message.replaceAll('\r\n', '\n')
  const matched = YAML_PATTERN.exec(text)
  if (matched === null) return undefined
  const data = readYamlMapping(matched[1] ?? '')
  if (data === undefined) return undefined
  const dependencies: unknown = ownField(data, 'updated-dependencies')
  const items: readonly unknown[] = Array.isArray(dependencies) ? dependencies : []
  const bump = BUMP_PATTERN.exec(text)
  const links = new Map<string, (readonly [string, string])[]>()
  for (const link of text.matchAll(UPDATES_PATTERN)) {
    const name = link[1] ?? ''
    links.set(name, [...links.get(name) ?? [], [link[2] ?? '', link[3] ?? '']])
  }
  const seen = new Map<string, number>()
  const result: (readonly [string, string | undefined])[] = []
  for (const [index, item] of items.entries()) {
    const name = ownField(item, 'dependency-name')
    if (typeof name !== 'string') continue
    const nth = seen.get(name) ?? 0
    seen.set(name, nth + 1)
    const [linkOld, linkNew] = links.get(name)?.at(nth) ?? ['', '']
    // Bumps 行は先頭の依存にだけ当てる
    const [bumpOld, bumpNew] = index === 0 ? [bump?.[1] ?? '', bump?.[2] ?? ''] : ['', '']
    const version = ownField(item, 'dependency-version')
    const yamlNew = typeof version === 'string' ? version : ''
    const oldVersion = linkOld === '' ? bumpOld : linkOld
    const newVersion = (yamlNew === '' ? linkNew : yamlNew) || bumpNew
    result.push([name, rawUpdateType(ownField(item, 'update-type')) ?? versionType(oldVersion, newVersion)])
  }
  return result.length > 0 ? result : undefined
}

// `version-update:semver-minor` の最後の semver- より後ろ。major・minor・patch のどれでもなければ undefined
function rawUpdateType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const marker = raw.lastIndexOf('semver-')
  const type = marker === -1 ? raw : raw.slice(marker + 'semver-'.length)
  return UPDATE_TYPES.has(type) ? type : undefined
}

// `YYYY-MM-DDTHH:MM:SS(.f+)?(Z|±HH:MM)` の形だけを読む。マイクロ秒の数。読めなければ undefined
function parseTime(value: JsonValue | undefined): bigint | undefined {
  const parts = typeof value === 'string' ? TIME_PATTERN.exec(value)?.groups : undefined
  if (parts === undefined) return undefined
  const { year = '', month = '', day = '', hour = '', minute = '', second = '', fraction = '', sign = '+', offsetHour = '0', offsetMinute = '0' } = parts
  const date = new Date(0)
  date.setUTCFullYear(Number(year), Number(month) - MONTH_OFFSET, Number(day))
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0)
  const isSameDay = Number(year) >= 1 && date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - MONTH_OFFSET && date.getUTCDate() === Number(day)
  const isTimeInRange = Number(hour) <= MAX_HOUR && Number(minute) <= MAX_MINUTE_OR_SECOND && Number(second) <= MAX_MINUTE_OR_SECOND
  if (!isSameDay || !isTimeInRange || Number(offsetHour) > MAX_HOUR || Number(offsetMinute) > MAX_MINUTE_OR_SECOND) return undefined
  const micros = BigInt(fraction.slice(0, MICROSECOND_DIGITS).padEnd(MICROSECOND_DIGITS, '0'))
  const offsetMinutes = BigInt(Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === '-' ? -1n : 1n)
  return BigInt(date.getTime()) * 1000n + micros - offsetMinutes * MICROSECONDS_PER_MINUTE
}

/**
検証の結果を表の語にする。結果が無ければ none
*/
export function checksLabel(state: string | undefined): string {
  if (state === 'SUCCESS') return 'passed'
  if (state === 'FAILURE' || state === 'ERROR') return 'failed'
  return state === undefined ? 'none' : 'pending'
}

/**
最後の commit の検証（statusCheckRollup）の state。結果が無ければ undefined
*/
export function rollupState(pr: JsonObject): string | undefined {
  const state = dig(firstNode(jsonField(pr, 'headCommits')), 'commit', 'statusCheckRollup', 'state')
  return typeof state === 'string' ? state : undefined
}

function commitOf(pr: JsonObject): JsonObject {
  const first = firstNode(jsonField(pr, 'firstCommits'))
  return objectOrEmpty(jsonField(first, 'commit'))
}

// update-type から決まる理由と、自動マージの対象か
function metadataReasons(pr: JsonObject): { readonly reasons: readonly string[], readonly isTarget: boolean } {
  const commit = commitOf(pr)
  // fetch-metadata は署名が有効でない commit の metadata を返さない（auto-merge も入らない）
  const isSigned = dig(commit, 'signature', 'isValid') === true
  const message = jsonField(commit, 'message')
  const isBot = dig(commit, 'author', 'user', 'login') === BOT_LOGIN
  const metadata = isBot && isSigned && typeof message === 'string' ? parseUpdateMetadata(message) : undefined
  if (metadata === undefined) return { reasons: [REASON_UNKNOWN], isTarget: false }
  const types = metadata.map(([, type]) => type).filter(type => type !== undefined)
  if (types.length === 0) return { reasons: [REASON_UNKNOWN], isTarget: false }
  if (types.includes('major')) return { reasons: [REASON_MAJOR], isTarget: false }
  return { reasons: [], isTarget: true }
}

function eventTimes(pr: JsonObject, alias: string): readonly bigint[] {
  const createdAt = arrayOrEmpty(dig(pr, alias, 'nodes')).map(node => jsonField(node, 'createdAt'))
  const times = createdAt.map(value => parseTime(value))
  return times.filter(time => time !== undefined)
}

// 読めた時刻のうち最も新しいもの
function latest(times: readonly (bigint | undefined)[]): bigint | undefined {
  let best: bigint | undefined
  for (const time of times) {
    if (time !== undefined && (best === undefined || time > best)) best = time
  }
  return best
}

/**
PR が人の判断を待っている理由の並び。空なら載せない。
pr は listOpenDependabotPullRequests が返す PR のノード、now は判定の時刻
*/
export function waitingReasons(pr: JsonObject, now: Readonly<Date>): readonly string[] {
  const { reasons: base, isTarget } = metadataReasons(pr)
  if (!isTarget) return base
  const reasons: string[] = [...base]
  const nowMicros = BigInt(now.getTime()) * 1000n
  const lastPush = latest([parseTime(jsonField(pr, 'createdAt')), ...eventTimes(pr, 'lastForcePush')])
  if (lastPush === undefined) return reasons
  const state = rollupState(pr)
  const autoMergeRequest = jsonField(pr, 'autoMergeRequest')
  const hasAutoMerge = autoMergeRequest !== undefined && autoMergeRequest !== null
  const isInQueue = isTruthyValue(jsonField(pr, 'isInMergeQueue'))

  if (state === 'FAILURE' || state === 'ERROR') reasons.push(REASON_FAILED)
  else if (hasAutoMerge && state !== 'SUCCESS' && nowMicros - lastPush > CHECKS_TIMEOUT) reasons.push(REASON_STUCK)
  if (jsonField(pr, 'mergeable') === 'CONFLICTING') {
    const baseTime = parseTime(dig(pr, 'baseRef', 'target', 'committedDate'))
    const since = latest([lastPush, baseTime]) ?? lastPush
    if (nowMicros - since > GRACE) reasons.push(REASON_CONFLICT)
  }
  if (!hasAutoMerge && !isInQueue) {
    if (eventTimes(pr, 'lastDequeue').some(time => time > lastPush)) reasons.push(REASON_DEQUEUED)
    else if (nowMicros - lastPush > GRACE) reasons.push(REASON_NO_AUTO_MERGE)
  }
  return reasons
}

/**
Tracker の表の 1 行（人の判断を待つ PR）。reasons は実行のログにだけ出し、表には出さない。
checks は最後の commit の検証の結果（passed・failed・pending・none）
*/
export interface PrEntry {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly reasons: readonly string[]
  readonly checks: string
}

/**
PR と Tracker の一覧の突き合わせの結果
*/
export interface PrPlan {
  /**
  新しい Tracker を立てるか（open の Tracker が無く、載せる行があるとき）
  */
  readonly create: boolean
  /**
  Tracker を閉じるか（open の Tracker があり、載せる行が無いとき）
  */
  readonly close: boolean
  /**
  書き直した後の行（番号順）
  */
  readonly entries: readonly PrEntry[]
  readonly added: readonly PrEntry[]
  readonly removed: readonly number[]
}

// PR の題のセル。`@scope/pkg` をメンションとして読ませないため、コードスパンで囲む。囲いは題のバッククォートの連なりより長くする
function titleCell(title: string): string {
  const oneLine = pythonStrip(title.replaceAll(LINE_BREAK_RUN, ' ')).replaceAll('|', String.raw`\|`)
  const longest = Math.max(0, ...(oneLine.match(/`+/gu) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = oneLine.startsWith('`') || oneLine.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${oneLine}${pad}${fence}`
}

function row(entry: PrEntry): string {
  return `| <!-- pecot-dependabot-pr: pr/${String(entry.number)} --> ${titleCell(entry.title)} | [#${String(entry.number)}](${entry.url}) | ${entry.checks} |`
}

/**
Tracker の本文から、一覧に載っている PR 番号を読む（番号順）。
list-begin / list-end の印が 1 組でなければ DependabotPrError
*/
export function parseTrackerPullRequestNumbers(body = ''): readonly number[] {
  const text = normalizeNewlines(body)
  const { begin, end } = listRegion(text, MARKERS.begin, MARKERS.end, DependabotPrError)
  const numbers = new Set<number>()
  for (const line of text.slice(begin, end).split('\n')) {
    if (!TABLE_LINE_PATTERN.test(line)) continue
    const parsed = parsePythonInteger(ROW_MARKER_PATTERN.exec(line)?.[1] ?? '')
    if (parsed !== undefined) numbers.add(parsed)
  }
  return [...numbers].toSorted((a, b) => a - b)
}

/**
Tracker の本文を作る。existingBody があれば list-begin から list-end の間だけを書き直し、外の文は残す。
無ければ Tracker の印と一覧だけの本文を作る。existingBody の印が 1 組でなければ DependabotPrError
*/
export function renderTrackerBody(entries: readonly PrEntry[], existingBody?: string): string {
  const table = entries.length > 0
    ? ['| title | PR | checks |', '|---|---|---|', ...entries.map(entry => row(entry))].join('\n')
    : 'none'
  const section = `${SECTION_HEADING}\n\n${table}`
  if (existingBody === undefined) return `${TRACKER_MARKER}\n\n${LIST_BEGIN}\n${section}\n${LIST_END}\n`
  const text = normalizeNewlines(existingBody)
  const { begin, end } = listRegion(text, MARKERS.begin, MARKERS.end, DependabotPrError)
  return `${text.slice(0, begin)}\n${section}\n${text.slice(end)}`
}

/**
Tracker の題。today は立てた日（UTC）の YYYY-MM-DD
*/
export function buildTrackerTitle(today: string): string {
  return `[Tracker] dependabot PR — ${today}`
}

/**
待つ PR と Tracker の今の行から、書き直した行を出す。
oldNumbers が undefined のときは open の Tracker が無い。載せる行があるときだけ立てる。
open の Tracker があり、載せる行が無いときは閉じる
*/
export function planTracker(entries: readonly PrEntry[], oldNumbers: readonly number[] | undefined): PrPlan {
  const rows = entries.toSorted((a, b) => a.number - b.number)
  const old = new Set(oldNumbers)
  const current = new Set(rows.map(entry => entry.number))
  return {
    create: oldNumbers === undefined && rows.length > 0,
    close: oldNumbers !== undefined && rows.length === 0,
    entries: rows,
    added: rows.filter(entry => !old.has(entry.number)),
    removed: [...old].filter(number => !current.has(number)).toSorted((a, b) => a - b),
  }
}
