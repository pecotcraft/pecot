// security alert の Tracker の本文の読み書きと、行の足し外しを決める純粋な処理（cli/core/security_alerts.py の移植）。
// 公開のリポとボードに載るので、本文に出すのは種類・番号・Priority・URL まで。Dependabot はパッケージ名と GHSA の ID も出す。

import { jsonField } from './json.js'
import { normalizeNewlines, parsePythonInteger, pythonStrip } from './python-format.js'
import type { JsonValue } from './python-format.js'
import { ALERT_KINDS, kindLabel, SecurityAlertError } from './security-alerts.js'
import type { AlertKind } from './security-alerts.js'
import { cell, listRegion, PYTHON_SPACE } from './tracker-body.js'

export const ALERT_LABEL = 'security-alert'
export const TRACKER_MARKER = '<!-- pecot-alert: tracker -->'
export const LIST_BEGIN = '<!-- pecot-alert: list-begin -->'
export const LIST_END = '<!-- pecot-alert: list-end -->'

const SEVERITY_PRIORITY: ReadonlyMap<string, string> = new Map([['critical', 'high'], ['high', 'high'], ['medium', 'medium'], ['low', 'low']])
const RULE_SEVERITY_PRIORITY: ReadonlyMap<string, string> = new Map([['error', 'high'], ['warning', 'medium'], ['note', 'low']])
const PRIORITY_RANK: ReadonlyMap<string, number> = new Map([['low', 0], ['medium', 1], ['high', 2]])
const DEFAULT_PRIORITY = 'medium'

// Python の `\s`・`\S`・`\d`（str）と同じ範囲を、文字クラスで明示する
const SPACE = `[${PYTHON_SPACE}]`
const NON_SPACE = `[^${PYTHON_SPACE}]`
const MARKER_SOURCE = String.raw`<!--${SPACE}*pecot-alert:${SPACE}*(dependabot|code-scanning|secret-scanning)/(\p{Nd}+)((?:${SPACE}+[a-z]+=${NON_SPACE}+)*)${SPACE}*-->`

// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
const MARKER_PATTERN = new RegExp(MARKER_SOURCE, 'gu')
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
const ATTRIBUTE_PATTERN = new RegExp(`([a-z]+)=(${NON_SPACE}+)`, 'gu')
// 行の 1 列目の先頭に並ぶ印（1 行に複数あってよい）
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
const ROW_MARKERS_PATTERN = new RegExp(String.raw`^\|${SPACE}*((?:<!--[^>]*?-->${SPACE}*)+)`, 'u')
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
const LIST_BEGIN_PATTERN = new RegExp(`<!--${SPACE}*pecot-alert:${SPACE}*list-begin${SPACE}*-->`, 'gu')
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
const LIST_END_PATTERN = new RegExp(`<!--${SPACE}*pecot-alert:${SPACE}*list-end${SPACE}*-->`, 'gu')
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列
export const TRACKER_PATTERN = new RegExp(`<!--${SPACE}*pecot-alert:${SPACE}*tracker${SPACE}*-->`, 'u')
// Python の `$` は末尾の改行 1 つの手前にも合う
// eslint-disable-next-line security/detect-unsafe-regex -- 繰り返しは固定の 3 回
const GHSA_PATTERN = /^GHSA(?:-[a-z0-9]{4}){3}\n?$/u

/**
open の alert 1 件の要点（Issue に出してよい情報だけ）
*/
export interface Alert {
  readonly kind: AlertKind
  readonly number: number
  /**
  high / medium / low
  */
  readonly priority: string
  readonly url: string
  /**
  Dependabot のパッケージ名（ほかの種類は undefined）
  */
  readonly package: string | undefined
  /**
  Dependabot の GHSA ID（ほかの種類は undefined）
  */
  readonly ghsa: string | undefined
  /**
  Dependabot の advisory の題（公開の情報。ほかの種類は undefined）
  */
  readonly summary: string | undefined
}

/**
Tracker の表の 1 行（open の alert）
*/
export interface TrackerEntry {
  readonly kind: AlertKind
  readonly number: number
  readonly priority: string
  readonly package: string | undefined
  readonly ghsa: string | undefined
  readonly summary: string | undefined
}

/**
行の識別子（種類と番号）
*/
export function entryKey(entry: Readonly<Pick<TrackerEntry, 'kind' | 'number'>>): string {
  return `${entry.kind}/${String(entry.number)}`
}

function valuesOf<T>(map: ReadonlyMap<string, T>): readonly T[] {
  const values: T[] = []
  for (const value of map.values()) values.push(value)
  return values
}

function isGhsa(value: string | undefined): value is string {
  return value !== undefined && GHSA_PATTERN.test(value)
}

// Python の `a or b`（空文字も無いものとして扱う）
function orElse(first: string | undefined, second: string | undefined): string | undefined {
  return first === undefined || first === '' ? second : first
}

function textField(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function alertNumber(raw: JsonValue): number | undefined {
  const number = jsonField(raw, 'number')
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined
}

function alertUrl(raw: JsonValue, host: string, owner: string, repository: string, kind: AlertKind, number: number): string {
  return textField(jsonField(raw, 'html_url')) ?? `https://${host}/${owner}/${repository}/security/${kind}/${String(number)}`
}

// Priority は security_vulnerability.severity、無ければ security_advisory.severity で決める
function normalizeDependabot(raw: JsonValue, host: string, owner: string, repository: string): Alert | undefined {
  const number = alertNumber(raw)
  if (number === undefined) return undefined
  const advisory = jsonField(raw, 'security_advisory')
  const dependency = jsonField(jsonField(raw, 'dependency'), 'package')
  const severity = textField(jsonField(jsonField(raw, 'security_vulnerability'), 'severity')) ?? textField(jsonField(advisory, 'severity'))
  const ghsa = textField(jsonField(advisory, 'ghsa_id'))
  return {
    kind: 'dependabot',
    number,
    priority: SEVERITY_PRIORITY.get(severity ?? '') ?? DEFAULT_PRIORITY,
    url: alertUrl(raw, host, owner, repository, 'dependabot', number),
    package: textField(jsonField(dependency, 'name')),
    ghsa: isGhsa(ghsa) ? ghsa : undefined,
    summary: textField(jsonField(advisory, 'summary')),
  }
}

// Priority は rule.security_severity_level、無ければ rule.severity で決める
function normalizeCodeScanning(raw: JsonValue, host: string, owner: string, repository: string): Alert | undefined {
  const number = alertNumber(raw)
  if (number === undefined) return undefined
  const rule = jsonField(raw, 'rule')
  const level = textField(jsonField(rule, 'security_severity_level'))
  const severity = textField(jsonField(rule, 'severity'))
  return {
    kind: 'code-scanning',
    number,
    priority: SEVERITY_PRIORITY.get(level ?? '') ?? RULE_SEVERITY_PRIORITY.get(severity ?? '') ?? DEFAULT_PRIORITY,
    url: alertUrl(raw, host, owner, repository, 'code-scanning', number),
    package: undefined,
    ghsa: undefined,
    summary: undefined,
  }
}

// secret scanning の Priority は常に high
function normalizeSecretScanning(raw: JsonValue, host: string, owner: string, repository: string): Alert | undefined {
  const number = alertNumber(raw)
  if (number === undefined) return undefined
  return {
    kind: 'secret-scanning',
    number,
    priority: 'high',
    url: alertUrl(raw, host, owner, repository, 'secret-scanning', number),
    package: undefined,
    ghsa: undefined,
    summary: undefined,
  }
}

/**
API の alert の並びを共通の形にする（番号の無いものは除く）
*/
export function normalizeAlerts(kind: AlertKind, raws: readonly JsonValue[], host: string, owner: string, repository: string): readonly Alert[] {
  const normalize = kind === 'dependabot' ? normalizeDependabot : (kind === 'code-scanning' ? normalizeCodeScanning : normalizeSecretScanning)
  return raws.map(raw => normalize(raw, host, owner, repository)).filter(alert => alert !== undefined)
}

const UNRESERVED = /^[\w.~-]$/u

/**
urllib.parse.quote(text, safe="") と同じ。英数字と `_.-~` 以外を UTF-8 の `%XX`（大文字）にする
*/
export function quoteComponent(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => {
    const character = String.fromCodePoint(byte)
    return byte < 0x80 && UNRESERVED.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }).join('')
}

// eslint-disable-next-line security/detect-unsafe-regex -- 1 つの繰り返しは固定の 3 文字で、バックトラックは増えない
const PERCENT_RUN = /(?:%[\dA-F]{2})+/giu
const UTF8_DECODER = new TextDecoder('utf-8', { ignoreBOM: true })

/**
urllib.parse.unquote(text) と同じ。不正な `%` の列はそのまま残し、不正な UTF-8 は U+FFFD にする
*/
export function unquoteComponent(text: string): string {
  return text.replaceAll(PERCENT_RUN, run => UTF8_DECODER.decode(Uint8Array.from(run.slice(1).split('%'), hex => Number.parseInt(hex, 16))))
}

function entryMarker(entry: TrackerEntry): string {
  const parts = [entryKey(entry), `priority=${entry.priority}`]
  // `--` を含めないため、`-` も符号化する
  if (entry.package !== undefined && entry.package !== '') parts.push(`pkg=${quoteComponent(entry.package).replaceAll('-', '%2D')}`)
  if (isGhsa(entry.ghsa)) parts.push(`ghsa=${entry.ghsa}`)
  if (entry.summary !== undefined && entry.summary !== '') parts.push(`sum=${quoteComponent(entry.summary).replaceAll('-', '%2D')}`)
  return `<!-- pecot-alert: ${parts.join(' ')} -->`
}

// リンクの題に入れても表を壊さないよう `\` `[` `]` `|` `<` を無害にする
function titleText(text: string): string {
  return cell(text.replaceAll('\\', '\\\\').replaceAll('[', String.raw`\[`).replaceAll(']', String.raw`\]`))
}

function alertLink(entry: TrackerEntry, host: string, owner: string, repository: string): string {
  return `[#${String(entry.number)}](https://${host}/${owner}/${repository}/security/${entry.kind}/${String(entry.number)})`
}

// code scanning・secret scanning の行。title は固定の masked
function entryRow(entry: TrackerEntry, host: string, owner: string, repository: string): string {
  return `| ${entryMarker(entry)} masked | ${alertLink(entry, host, owner, repository)} | ${entry.priority} |`
}

function rankOf(priority: string): number {
  return PRIORITY_RANK.get(priority) ?? 1
}

/**
全行の Priority の最大。行が無ければ undefined。同順位は先の行の値
*/
export function maxPriority(entries: readonly TrackerEntry[]): string | undefined {
  let best: string | undefined
  for (const { priority } of entries) {
    if (best === undefined || rankOf(priority) > rankOf(best)) best = priority
  }
  return best
}

interface AdvisoryGroup {
  readonly first: TrackerEntry
  /**
  first のあとに続く、同じ GHSA の alert（番号の昇順）
  */
  readonly rest: readonly TrackerEntry[]
}

function hasGhsa(entry: TrackerEntry): entry is TrackerEntry & { readonly ghsa: string } {
  return entry.ghsa !== undefined && entry.ghsa !== ''
}

function membersOf(group: Readonly<AdvisoryGroup>): readonly TrackerEntry[] {
  return [group.first, ...group.rest]
}

function groupRank(group: Readonly<AdvisoryGroup>): number {
  let best = -Infinity
  for (const entry of membersOf(group)) best = Math.max(best, rankOf(entry.priority))
  return best
}

// GHSA ごとに束ねる（GHSA の無い alert は 1 件ずつ）。並びは Priority の高い順、同じなら先頭の番号順
function advisoryGroups(entries: readonly TrackerEntry[]): readonly AdvisoryGroup[] {
  const restByGhsa = new Map<string, TrackerEntry[]>()
  const groups: AdvisoryGroup[] = []
  const ordered = entries.toSorted((a, b) => a.number - b.number)
  for (const entry of ordered) {
    const existing = hasGhsa(entry) ? restByGhsa.get(entry.ghsa) : undefined
    if (existing !== undefined) {
      existing.push(entry)
      continue
    }
    const rest: TrackerEntry[] = []
    groups.push({ first: entry, rest })
    if (hasGhsa(entry)) restByGhsa.set(entry.ghsa, rest)
  }
  return groups.toSorted((a, b) => groupRank(b) - groupRank(a) || a.first.number - b.first.number)
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  return values.find(value => value !== undefined && value !== '')
}

// Dependabot の advisory 1 件の行（内容・alert・Priority）
function advisoryRow(group: Readonly<AdvisoryGroup>, host: string, owner: string, repository: string): string {
  const { first } = group
  const members = membersOf(group)
  // summary は束の先頭の alert の印にだけ付ける。読み戻しで束の残りに引き継ぐ
  const summary = firstNonEmpty(members.map(entry => entry.summary))
  const package_ = firstNonEmpty(members.map(entry => entry.package))
  const label = titleText(orElse(orElse(summary, first.ghsa), orElse(package_, '不明')) ?? '不明')
  const content = hasGhsa(first) ? `[${label}](https://${host}/advisories/${first.ghsa})` : label
  const markers = members.map((entry, index) => entryMarker({ ...entry, summary: index === 0 ? summary : undefined })).join(' ')
  const links = members.map(entry => alertLink(entry, host, owner, repository)).join(' ')
  return `| ${markers} ${content} | ${links} | ${maxPriority(members) ?? DEFAULT_PRIORITY} |`
}

/**
行の並びを、種類の順・番号の順に固定する
*/
export function sortedEntries(entries: readonly TrackerEntry[]): readonly TrackerEntry[] {
  return entries.toSorted((a, b) => ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind) || a.number - b.number)
}

type SectionStatus = 'ok' | 'disabled' | 'failed'

// 行が無いときの語は、無効が disabled、取れず前の行も無いが unavailable、0 件が none
function section(kind: AlertKind, entries: readonly TrackerEntry[], status: SectionStatus, host: string, owner: string, repository: string): string {
  const head = `## ${kindLabel(kind)}\n\n`
  if (status === 'disabled') return `${head}disabled`
  const rows = entries.filter(entry => entry.kind === kind)
  if (rows.length === 0) return head + (status === 'failed' ? 'unavailable' : 'none')
  const bodyRows = kind === 'dependabot'
    ? advisoryGroups(rows).map(group => advisoryRow(group, host, owner, repository))
    // Priority の高い順、同じなら番号順
    : rows.toSorted((a, b) => rankOf(b.priority) - rankOf(a.priority) || a.number - b.number).map(entry => entryRow(entry, host, owner, repository))
  return head + ['| title | alert | Priority |', '|---|---|---|', ...bodyRows].join('\n')
}

export interface RenderOptions {
  /**
  既存の本文。あれば list-begin から list-end の間だけを書き直し、外の文は残す。無ければ Tracker の印と一覧だけの本文を作る
  */
  readonly existingBody?: string | undefined
  /**
  無効の種類。見出しの下に disabled だけを置く
  */
  readonly disabledKinds?: ReadonlySet<AlertKind>
  /**
  一覧を取れなかった種類。行が無ければ見出しの下に unavailable を置く
  */
  readonly failedKinds?: ReadonlySet<AlertKind>
}

/**
Tracker の本文を作る。一覧は種類ごとの見出しと表にする。
existingBody の印が 1 組でなければ SecurityAlertError
*/
export function renderTrackerBody(entries: readonly TrackerEntry[], host: string, owner: string, repository: string, options: Readonly<RenderOptions> = {}): string {
  const { existingBody, disabledKinds = new Set<AlertKind>(), failedKinds = new Set<AlertKind>() } = options
  const statusOf = (kind: AlertKind): SectionStatus => (disabledKinds.has(kind) ? 'disabled' : (failedKinds.has(kind) ? 'failed' : 'ok'))
  const sections = ALERT_KINDS.map(kind => section(kind, entries, statusOf(kind), host, owner, repository)).join('\n\n')
  if (existingBody === undefined) return `${TRACKER_MARKER}\n\n${LIST_BEGIN}\n${sections}\n${LIST_END}\n`
  const text = normalizeNewlines(existingBody)
  const region = listRegion(text, LIST_BEGIN_PATTERN, LIST_END_PATTERN, SecurityAlertError)
  return `${text.slice(0, region.begin)}\n${sections}\n${text.slice(region.end)}`
}

function attributesOf(text: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>()
  for (const [, name = '', value = ''] of text.matchAll(ATTRIBUTE_PATTERN)) attributes.set(name, value)
  return attributes
}

function kindOf(name: string | undefined): AlertKind {
  return ALERT_KINDS.find(kind => kind === name) ?? 'dependabot'
}

function entriesOfMarkers(markers: string): readonly TrackerEntry[] {
  const found: TrackerEntry[] = []
  for (const [, kind, digits = '', rest = ''] of markers.matchAll(MARKER_PATTERN)) {
    const attributes = attributesOf(rest)
    const number = parsePythonInteger(digits)
    if (number === undefined || (attributes.get('state') ?? 'open') !== 'open') continue
    const priority = attributes.get('priority') ?? DEFAULT_PRIORITY
    const ghsa = attributes.get('ghsa')
    const package_ = attributes.get('pkg')
    const summary = attributes.get('sum')
    found.push({
      kind: kindOf(kind),
      number,
      priority: PRIORITY_RANK.has(priority) ? priority : DEFAULT_PRIORITY,
      package: package_ === undefined ? undefined : unquoteComponent(package_),
      ghsa: isGhsa(ghsa) ? ghsa : undefined,
      summary: summary === undefined ? undefined : unquoteComponent(summary),
    })
  }
  return found
}

/**
Tracker の本文から、一覧の行を読む。
1 行に印が複数あってよい。`sum=` は束の先頭の印にだけあるので、同じ GHSA の残りに引き継ぐ。
`state=` の無い行と `state=open` の行だけを読み、ほかの state・旧い `folded count=`・印の無い行は読み捨てる。
list-begin / list-end の印が 1 組でなければ SecurityAlertError
*/
export function parseTrackerEntries(body = ''): readonly TrackerEntry[] {
  const text = normalizeNewlines(body)
  const region = listRegion(text, LIST_BEGIN_PATTERN, LIST_END_PATTERN, SecurityAlertError)
  const entries = new Map<string, TrackerEntry>()
  for (const line of text.slice(region.begin, region.end).split('\n')) {
    const markers = ROW_MARKERS_PATTERN.exec(pythonStrip(line))?.[1]
    if (markers === undefined) continue
    for (const entry of entriesOfMarkers(markers)) {
      if (!entries.has(entryKey(entry))) entries.set(entryKey(entry), entry)
    }
  }
  const summaries = new Map<string, string>()
  for (const entry of valuesOf(entries)) {
    if (entry.summary !== undefined && entry.summary !== '' && hasGhsa(entry)) summaries.set(entry.ghsa, entry.summary)
  }
  const filled = valuesOf(entries).map((entry) => {
    const inherited = hasGhsa(entry) ? summaries.get(entry.ghsa) : undefined
    return { ...entry, summary: orElse(entry.summary, inherited) }
  })
  return sortedEntries(filled)
}

/**
Tracker の題。today は立てた日（UTC）の YYYY-MM-DD
*/
export function buildTrackerTitle(today: string): string {
  return `[Tracker] security alert — ${today}`
}

/**
alert と Tracker の一覧の突き合わせの結果
*/
export interface TrackerPlan {
  /**
  新しい Tracker を立てるか（open の Tracker が無く、表に載せる行があるとき）
  */
  readonly create: boolean
  /**
  書き直した後の行（並びは固定）
  */
  readonly entries: readonly TrackerEntry[]
  /**
  一覧に足した行
  */
  readonly added: readonly TrackerEntry[]
  /**
  一覧から外した行
  */
  readonly removed: readonly TrackerEntry[]
}

/**
open の alert と Tracker の今の行から、書き直した行を出す。entries が undefined なら open の Tracker が無い。
failedKinds の種類は前の行をそのまま使い、disabledKinds の種類は行を持たない
*/
export function planTracker(
  openAlerts: ReadonlyMap<AlertKind, readonly Alert[]>,
  entries: readonly TrackerEntry[] | undefined,
  failedKinds: ReadonlySet<AlertKind> = new Set<AlertKind>(),
  disabledKinds: ReadonlySet<AlertKind> = new Set<AlertKind>(),
): TrackerPlan {
  const oldByKey = new Map<string, TrackerEntry>()
  const rows = new Map<string, TrackerEntry>()
  const previous = entries ?? []
  for (const old of previous) {
    oldByKey.set(entryKey(old), old)
    if (failedKinds.has(old.kind)) rows.set(entryKey(old), old)
  }
  for (const kind of ALERT_KINDS) {
    if (failedKinds.has(kind) || disabledKinds.has(kind)) continue
    const alerts = openAlerts.get(kind) ?? []
    for (const alert of alerts) {
      const key = entryKey({ kind, number: alert.number })
      const old = oldByKey.get(key)
      rows.set(key, {
        kind,
        number: alert.number,
        priority: alert.priority,
        package: orElse(alert.package, old?.package),
        ghsa: orElse(alert.ghsa, old?.ghsa),
        summary: orElse(alert.summary, old?.summary),
      })
    }
  }
  const planned = sortedEntries(valuesOf(rows))
  return {
    create: entries === undefined && planned.length > 0,
    entries: planned,
    added: sortedEntries(planned.filter(entry => !oldByKey.has(entryKey(entry)))),
    removed: sortedEntries(valuesOf(oldByKey).filter(old => !rows.has(entryKey(old)))),
  }
}
