import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../python-format.js'
import { ALERT_KINDS, SecurityAlertError } from '../security-alerts.js'
import type { AlertKind } from '../security-alerts.js'
import {
  buildTrackerTitle,
  entryKey,
  maxSeverity,
  normalizeAlerts,
  parseTrackerEntries,
  planTracker,
  quoteComponent,
  renderTrackerBody,
  sortedEntries,
  TRACKER_PATTERN,
  unquoteComponent,
} from '../security-tracker.js'
import type { Alert, TrackerEntry } from '../security-tracker.js'
import { findTracker } from '../tracker-body.js'

const HOST = 'github.com'
const GHSA = 'GHSA-aaaa-bbbb-cccc'

function dependabotRaw(severity: string | null = 'high'): JsonValue {
  const number = 7
  return {
    number,
    html_url: `https://github.com/o/r/security/dependabot/${String(number)}`,
    security_vulnerability: { severity },
    security_advisory: { ghsa_id: GHSA, severity: 'low', summary: 'Prototype Pollution in left-pad' },
    dependency: { package: { name: 'left-pad' } },
  }
}

function only(alerts: readonly Alert[]): Alert {
  const [alert] = alerts
  if (alert === undefined) throw new Error('alert が正規化で落ちた')
  return alert
}

function alertOf(kind: AlertKind, number: number, fields: Partial<Alert> = {}): Alert {
  return { kind, number, severity: 'medium', url: 'u', package: undefined, ghsa: undefined, summary: undefined, ...fields }
}

function entryOf(kind: AlertKind, number: number, fields: Partial<TrackerEntry> = {}): TrackerEntry {
  return { kind, number, severity: kind === 'secret-scanning' ? undefined : 'medium', package: undefined, ghsa: undefined, summary: undefined, ...fields }
}

function render(entries: readonly TrackerEntry[], existingBody?: string, failed: readonly AlertKind[] = []): string {
  return renderTrackerBody(entries, HOST, 'o', 'r', { existingBody, failedKinds: new Set(failed) })
}

function keysOf(entries: readonly TrackerEntry[]): readonly string[] {
  return entries.map(entry => entryKey(entry))
}

function openMap(alerts: Readonly<Partial<Record<AlertKind, readonly Alert[]>>>): ReadonlyMap<AlertKind, readonly Alert[]> {
  const map = new Map<AlertKind, readonly Alert[]>()
  // eslint-disable-next-line security/detect-object-injection -- kind は列挙型
  for (const kind of ALERT_KINDS) map.set(kind, alerts[kind] ?? [])
  return map
}

function normalizeOne(kind: AlertKind, raw: JsonValue, host = HOST): Alert {
  return only(normalizeAlerts(kind, [raw], host, 'o', 'r'))
}

function matchesOf(text: string, pattern: Readonly<RegExp>): readonly string[] {
  return Array.from(text.matchAll(pattern), match => match[1] ?? '')
}

function withListEnd(body: string, rows: string): string {
  return body.replace('<!-- pecot-alert: list-end -->', () => `${rows}\n<!-- pecot-alert: list-end -->`)
}

function trackerIssue(number: number, state = 'open'): JsonValue {
  return { number, state, body: '<!-- pecot-alert: tracker -->' }
}

describe('normalizeAlerts', () => {
  it.for(['critical', 'high', 'medium', 'low'])('Dependabot の severity が %s なら、重大度はその値のまま', (severity) => {
    expect(normalizeOne('dependabot', dependabotRaw(severity)).severity).toBe(severity)
  })

  it('Dependabot の alert から、番号・URL・重大度・パッケージ・GHSA・題を読む', () => {
    expect(normalizeOne('dependabot', dependabotRaw())).toEqual({
      kind: 'dependabot',
      number: 7,
      severity: 'high',
      url: 'https://github.com/o/r/security/dependabot/7',
      package: 'left-pad',
      ghsa: GHSA,
      summary: 'Prototype Pollution in left-pad',
    })
  })

  it('Dependabot の severity が vulnerability に無ければ、advisory の severity を使う', () => {
    const raw = { number: 1, security_vulnerability: {}, security_advisory: { severity: 'critical' } }
    expect(normalizeOne('dependabot', raw).severity).toBe('critical')
  })

  it('Dependabot の severity がどこにも無ければ、重大度を持たない', () => {
    expect(normalizeOne('dependabot', { number: 1 }).severity).toBeUndefined()
    expect(normalizeOne('dependabot', { number: 1, security_vulnerability: { severity: '' }, security_advisory: {} }).severity).toBeUndefined()
  })

  it.for(['not-a-ghsa', 'GHSA-AAAA-bbbb-cccc', 'GHSA-aaaa-bbbb'])('GHSA が %j なら、GHSA を捨てる', (ghsa) => {
    const raw = { number: 1, security_advisory: { ghsa_id: ghsa } }
    expect(normalizeOne('dependabot', raw).ghsa).toBeUndefined()
  })

  it('html_url が無ければ、host と種類と番号から URL を作る', () => {
    expect(normalizeOne('dependabot', { number: 3 }, 'ghes.example.com').url).toBe('https://ghes.example.com/o/r/security/dependabot/3')
  })

  it('番号が整数でない alert と、オブジェクトでない要素を除く', () => {
    const raws = [{ html_url: 'x' }, { number: '1' }, { number: 1.5 }, 'x', { number: 2 }]
    expect(normalizeAlerts('dependabot', raws, HOST, 'o', 'r').map(alert => alert.number)).toEqual([2])
  })

  const codeScanningRules = [
    { name: 'security_severity_level が critical なら、severity が note でも critical', rule: { security_severity_level: 'critical', severity: 'note' }, expected: 'critical' },
    { name: 'security_severity_level が medium なら、severity が error でも medium', rule: { security_severity_level: 'medium', severity: 'error' }, expected: 'medium' },
    // eslint-disable-next-line unicorn/no-null -- API の応答の null
    { name: 'security_severity_level が null なら、severity の error', rule: { security_severity_level: null, severity: 'error' }, expected: 'error' },
    { name: 'severity が warning なら warning', rule: { severity: 'warning' }, expected: 'warning' },
    { name: 'severity が note なら note', rule: { severity: 'note' }, expected: 'note' },
    { name: 'severity が none なら none', rule: { severity: 'none' }, expected: 'none' },
    { name: 'rule が空なら重大度を持たない', rule: {}, expected: undefined },
  ]

  it.for(codeScanningRules)('code scanning は $name', ({ rule, expected }) => {
    const alert = normalizeOne('code-scanning', { number: 10, rule })
    expect(alert.severity).toBe(expected)
    expect(alert.url).toBe('https://github.com/o/r/security/code-scanning/10')
  })

  it('secret scanning は重大度とパッケージを持たない', () => {
    const alert = normalizeOne('secret-scanning', { number: 2, secret_type: 'x', secret: 'v' })
    expect(alert).toEqual({ kind: 'secret-scanning', number: 2, severity: undefined, url: 'https://github.com/o/r/security/secret-scanning/2', package: undefined, ghsa: undefined, summary: undefined })
  })

  it('code scanning と secret scanning も、番号の無い alert を除く', () => {
    expect(normalizeAlerts('code-scanning', [{}], HOST, 'o', 'r')).toEqual([])
    expect(normalizeAlerts('secret-scanning', [{}], HOST, 'o', 'r')).toEqual([])
  })
})

describe('quoteComponent と unquoteComponent', () => {
  const quoted = [
    { text: '日本語 a-b_c.d~e/f', expected: '%E6%97%A5%E6%9C%AC%E8%AA%9E%20a-b_c.d~e%2Ff' },
    { text: '@scope/pkg', expected: '%40scope%2Fpkg' },
    { text: '😀', expected: '%F0%9F%98%80' },
    { text: '', expected: '' },
  ]

  it.for(quoted)('$text を `%XX`（大文字）に符号化する', ({ text, expected }) => {
    expect(quoteComponent(text)).toBe(expected)
    expect(unquoteComponent(expected)).toBe(text)
  })

  const unquoted = [
    { name: '`%` だけ', text: '%', expected: '%' },
    { name: '16 進が 1 桁', text: '%4', expected: '%4' },
    { name: '16 進でない列のあとに有効な列', text: '%zz%41', expected: '%zzA' },
    { name: '途中で切れた UTF-8', text: '%E3%81', expected: '�' },
    { name: '正しい文字のあとに続きバイトだけ', text: '%E3%81%82%81', expected: 'あ�' },
    { name: 'BOM', text: '%EF%BB%BFx', expected: '\u{FEFF}x' },
    { name: '非 ASCII の文字との混在', text: 'é%C3%A9', expected: 'éé' },
    { name: '小文字の 16 進', text: '%e6%97%a5', expected: '日' },
  ]

  it.for(unquoted)('$name は Python の unquote と同じに復号する', ({ text, expected }) => {
    expect(unquoteComponent(text)).toBe(expected)
  })
})

describe('planTracker', () => {
  it('Tracker が無く open の alert があれば、立てる', () => {
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 1), alertOf('dependabot', 2)] }), undefined)
    expect(plan.create).toBe(true)
    expect(keysOf(plan.entries)).toEqual(['dependabot/1', 'dependabot/2'])
  })

  it('Tracker が無く open の alert も無ければ、立てない', () => {
    expect(planTracker(openMap({}), undefined)).toEqual({ create: false, entries: [], added: [], removed: [] })
  })

  it('Tracker が既にあれば、立てずに足す行だけを返す', () => {
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 1)] }), [])
    expect(plan.create).toBe(false)
    expect(plan.added.map(entry => entry.number)).toEqual([1])
  })

  it('もう open でない alert の行は外す', () => {
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 2)] }), [entryOf('dependabot', 1), entryOf('dependabot', 2)])
    expect(keysOf(plan.entries)).toEqual(['dependabot/2'])
    expect(keysOf(plan.removed)).toEqual(['dependabot/1'])
    expect(plan.added).toEqual([])
  })

  it('新しい値を使い、無い値だけ前の行から引き継ぐ', () => {
    const old = [entryOf('dependabot', 1, { severity: 'low', package: 'old', ghsa: GHSA, summary: 'old summary' })]
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 1, { severity: 'high', package: 'new', summary: '' })] }), old)
    expect(plan.entries).toEqual([entryOf('dependabot', 1, { severity: 'high', package: 'new', ghsa: GHSA, summary: 'old summary' })])
  })

  it('alert が重大度を持たなければ、前の行の重大度を引き継がない', () => {
    const plan = planTracker(openMap({ 'code-scanning': [alertOf('code-scanning', 1, { severity: undefined })] }), [entryOf('code-scanning', 1, { severity: 'high' })])
    expect(plan.entries).toEqual([entryOf('code-scanning', 1, { severity: undefined })])
  })

  it('一覧を取れなかった種類は、前の行をそのまま残し、足さない', () => {
    const old = [entryOf('secret-scanning', 1)]
    const alerts = openMap({ 'dependabot': [alertOf('dependabot', 5)], 'secret-scanning': [alertOf('secret-scanning', 9)] })
    const plan = planTracker(alerts, old, new Set<AlertKind>(['secret-scanning', 'code-scanning']))
    expect(keysOf(plan.entries)).toEqual(['dependabot/5', 'secret-scanning/1'])
    expect(plan.removed).toEqual([])
  })

  it('open の alert の一覧に載っていない種類は、alert が 0 件として扱う', () => {
    const plan = planTracker(new Map([['dependabot', [alertOf('dependabot', 1)]]]), [entryOf('code-scanning', 4)])
    expect(keysOf(plan.entries)).toEqual(['dependabot/1'])
    expect(keysOf(plan.removed)).toEqual(['code-scanning/4'])
  })

  it('一覧を取れなかった種類だけでは、Tracker を立てない', () => {
    expect(planTracker(openMap({}), undefined, new Set<AlertKind>(['dependabot'])).create).toBe(false)
  })

  it('無効の種類は行を持たず、前の行は外す', () => {
    const old = [entryOf('code-scanning', 1), entryOf('dependabot', 2)]
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 2)], ['code-scanning']: [alertOf('code-scanning', 8)] }), old, new Set<AlertKind>(), new Set<AlertKind>(['code-scanning']))
    expect(keysOf(plan.entries)).toEqual(['dependabot/2'])
    expect(keysOf(plan.removed)).toEqual(['code-scanning/1'])
    expect(plan.added).toEqual([])
  })

  it('同じ入力で 2 回目を回すと、足す行と外す行が無い', () => {
    const alerts = openMap({ 'dependabot': [alertOf('dependabot', 1)], 'code-scanning': [alertOf('code-scanning', 3)] })
    const first = planTracker(alerts, [])
    const second = planTracker(alerts, first.entries)
    expect(second.added).toEqual([])
    expect(second.removed).toEqual([])
    expect(second.entries).toEqual(first.entries)
  })

  it('行は種類の順、番号の昇順に並べる', () => {
    const alerts = openMap({
      'secret-scanning': [alertOf('secret-scanning', 1)],
      'dependabot': [alertOf('dependabot', 10), alertOf('dependabot', 2)],
      'code-scanning': [alertOf('code-scanning', 5)],
    })
    expect(keysOf(planTracker(alerts, []).entries)).toEqual(['dependabot/2', 'dependabot/10', 'code-scanning/5', 'secret-scanning/1'])
  })
})

describe('maxSeverity', () => {
  it('全行の重大度の最大を返し、行が無ければ undefined を返す', () => {
    const entries = [entryOf('dependabot', 1, { severity: 'low' }), entryOf('dependabot', 2, { severity: 'critical' }), entryOf('dependabot', 3)]
    expect(maxSeverity(entries)).toBe('critical')
    expect(maxSeverity([])).toBeUndefined()
  })

  const orders = [
    { name: 'high と error は同じ順位で、先の値', values: ['error', 'high'], expected: 'error' },
    { name: 'medium と warning は同じ順位で、先の値', values: ['warning', 'medium'], expected: 'warning' },
    { name: 'low と note は同じ順位で、先の値', values: ['note', 'low'], expected: 'note' },
    { name: 'note は none より高い', values: ['none', 'note'], expected: 'note' },
    { name: '未知の値は none と同じ順位', values: ['weird', 'none'], expected: 'weird' },
    { name: '未知の値は low より低い', values: ['weird', 'low'], expected: 'low' },
    { name: '重大度の無い行と none が並ぶと、値のある none', values: [undefined, 'none'], expected: 'none' },
    { name: 'どの行も重大度を持たないと undefined', values: [undefined, undefined], expected: undefined },
  ]

  it.for(orders)('$name を返す', ({ values, expected }) => {
    expect(maxSeverity(values.map((severity, index) => entryOf('code-scanning', index + 1, { severity })))).toBe(expected)
  })
})

describe('sortedEntries', () => {
  it('種類の順、番号の昇順に並べ直す', () => {
    const sorted = sortedEntries([entryOf('secret-scanning', 1), entryOf('dependabot', 9), entryOf('code-scanning', 2), entryOf('dependabot', 3)])
    expect(keysOf(sorted)).toEqual(['dependabot/3', 'dependabot/9', 'code-scanning/2', 'secret-scanning/1'])
  })
})

describe('renderTrackerBody と parseTrackerEntries', () => {
  const entries = [
    entryOf('dependabot', 1, { severity: 'high', package: '@scope/left-pad', ghsa: GHSA, summary: 'Pollution -- in | [x] <b>\nnext' }),
    entryOf('dependabot', 3, { package: 'a--b' }),
    entryOf('code-scanning', 4, { severity: 'note' }),
    entryOf('code-scanning', 6, { severity: undefined }),
    entryOf('secret-scanning', 5),
  ]

  it('書いた行を読み戻すと、重大度・パッケージ・GHSA・題が同じになる', () => {
    expect(parseTrackerEntries(render(entries))).toEqual(entries)
  })

  it('新しい本文は、印と種類ごとの見出しと表だけにする', () => {
    const body = render([entryOf('dependabot', 1, { severity: 'high', package: '日本語-pkg', ghsa: GHSA, summary: 'Pollution -- in | [x] <b>\nnext' }), entryOf('dependabot', 2, { severity: 'low' }), entryOf('code-scanning', 4, { severity: 'low' })])
    expect(body).toBe([
      '<!-- pecot-alert: tracker -->',
      '',
      '<!-- pecot-alert: list-begin -->',
      '## Dependabot',
      '',
      '| title | alert | Severity |',
      '|---|---|---|',
      '| <!-- pecot-alert: dependabot/1 severity=high pkg=%E6%97%A5%E6%9C%AC%E8%AA%9E%2Dpkg ghsa=GHSA-aaaa-bbbb-cccc sum=Pollution%20%2D%2D%20in%20%7C%20%5Bx%5D%20%3Cb%3E%0Anext --> [Pollution -- in \\| \\[x\\] &lt;b> next](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | [#1](https://github.com/o/r/security/dependabot/1) | high |',
      '| <!-- pecot-alert: dependabot/2 severity=low --> 不明 | [#2](https://github.com/o/r/security/dependabot/2) | low |',
      '',
      '## code scanning',
      '',
      '| title | alert | Severity |',
      '|---|---|---|',
      '| <!-- pecot-alert: code-scanning/4 severity=low --> masked | [#4](https://github.com/o/r/security/code-scanning/4) | low |',
      '',
      '## secret scanning',
      '',
      'none',
      '<!-- pecot-alert: list-end -->',
      '',
    ].join('\n'))
  })

  it('印の中に `--` を含めず、state も書かない', () => {
    const markers = matchesOf(render(entries), /<!-- pecot-alert: (.*?) -->/gu)
    expect(markers.some(marker => marker.startsWith('dependabot/1 severity=high'))).toBe(true)
    expect(markers.filter(marker => marker.includes('--') || marker.includes('state='))).toEqual([])
  })

  it('code scanning と secret scanning の行は、題を masked に固定する', () => {
    const body = render([entryOf('code-scanning', 4, { severity: 'warning' }), entryOf('secret-scanning', 5)])
    expect(body).toContain('| <!-- pecot-alert: code-scanning/4 severity=warning --> masked | [#4](')
    expect(body).toContain('| <!-- pecot-alert: secret-scanning/5 --> masked | [#5](')
    expect(parseTrackerEntries(body)).toEqual([entryOf('code-scanning', 4, { severity: 'warning' }), entryOf('secret-scanning', 5)])
  })

  it('重大度の無い行と secret scanning の行は、Severity の列を - にし、印に severity を書かない', () => {
    const body = render([entryOf('dependabot', 1, { severity: undefined }), entryOf('code-scanning', 4, { severity: undefined }), entryOf('secret-scanning', 5)])
    expect(body).toContain('| <!-- pecot-alert: dependabot/1 --> 不明 | [#1](https://github.com/o/r/security/dependabot/1) | - |')
    expect(body).toContain('| <!-- pecot-alert: code-scanning/4 --> masked | [#4](https://github.com/o/r/security/code-scanning/4) | - |')
    expect(body).toContain('| <!-- pecot-alert: secret-scanning/5 --> masked | [#5](https://github.com/o/r/security/secret-scanning/5) | - |')
  })

  it.for(['high-ish', 'High', 'a b', ''])('重大度が英小文字だけでない値 %j なら、印に severity を書かない', (severity) => {
    const body = render([entryOf('code-scanning', 4, { severity })])
    expect(body).toContain('<!-- pecot-alert: code-scanning/4 -->')
  })

  it('行が無い種類は none と書き、表を作らない', () => {
    const body = render([])
    for (const label of ['Dependabot', 'code scanning', 'secret scanning']) expect(body).toContain(`## ${label}\n\nnone`)
    expect(body).not.toContain('|')
    expect(parseTrackerEntries(body)).toEqual([])
  })

  it('無効の種類は見出しの下に disabled だけを置く', () => {
    const body = renderTrackerBody([entryOf('dependabot', 1)], HOST, 'o', 'r', { disabledKinds: new Set<AlertKind>(['code-scanning']) })
    expect(body).toContain('## code scanning\n\ndisabled\n\n## secret scanning\n\nnone')
    expect(body).toContain('## Dependabot\n\n| title')
  })

  it('同じ advisory の alert は 1 行にまとめ、重大度は束の最大にする', () => {
    const grouped = [
      entryOf('dependabot', 13, { ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 9, { severity: 'high', ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 1, { severity: 'low', ghsa: 'GHSA-dddd-eeee-ffff', summary: 'Glob' }),
    ]
    const body = render(grouped)
    const rows = body.split('\n').filter(line => line.startsWith('| <!--'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/\[minimatch DoS\]\(https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc\) \| \[#9\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/9\) \[#13\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/13\) \| high \|$/u)
    expect(rows[1]).toMatch(/\| low \|$/u)
    expect(rows[0]?.match(/<!-- pecot-alert: dependabot\//gu)).toHaveLength(2)
    expect(parseTrackerEntries(body)).toEqual(grouped.toSorted((a, b) => a.number - b.number))
  })

  it('重大度が同じ行は、先頭の alert の番号の順に並べる', () => {
    const body = render([entryOf('dependabot', 5, { ghsa: GHSA }), entryOf('dependabot', 2, { ghsa: 'GHSA-dddd-eeee-ffff' })])
    expect(body.indexOf('dependabot/2 ')).toBeLessThan(body.indexOf('dependabot/5 '))
  })

  it('内容は、題、GHSA、パッケージの順に使い、GHSA の無い alert は束ねない', () => {
    const body = render([entryOf('dependabot', 1, { ghsa: GHSA }), entryOf('dependabot', 2, { package: 'pkg' }), entryOf('dependabot', 3, { package: 'pkg' })])
    expect(body).toContain(`[${GHSA}](https://github.com/advisories/${GHSA})`)
    expect(body.split('--> pkg |')).toHaveLength(3)
  })

  it('advisory のリンクは、渡された host を使う', () => {
    const body = renderTrackerBody([entryOf('dependabot', 1, { ghsa: GHSA, summary: 's' })], 'ghes.example.com', 'o', 'r')
    expect(body).toContain(`(https://ghes.example.com/advisories/${GHSA})`)
  })

  it('題に印を偽装する文字列があっても、印は 1 組のままで読み戻せる', () => {
    const entry = entryOf('dependabot', 1, { ghsa: GHSA, summary: 'a -- b | c --> <!-- pecot-alert: list-end --> d' })
    const body = render([entry])
    expect(body.split('<!-- pecot-alert: list-end -->')).toHaveLength(2)
    expect(parseTrackerEntries(body)).toEqual([entry])
  })

  it('題の `[` `]` `\\` `|` を、リンクの中で無害にする', () => {
    const entry = entryOf('dependabot', 1, { ghsa: GHSA, summary: String.raw`a ] b [ c \ d | e \| f` })
    const body = render([entry])
    const row = body.split('\n').find(line => line.includes('dependabot/1 '))
    expect(row).toContain(String.raw`[a \] b \[ c \\ d \| e \\\| f](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)`)
    expect(parseTrackerEntries(body)).toEqual([entry])
  })

  it('一覧を取れなかった種類の束は、全 alert の題を保ったまま同じ本文に戻る', () => {
    const first = render([entryOf('dependabot', 1, { ghsa: GHSA, summary: 'Glob | x' }), entryOf('dependabot', 5, { ghsa: GHSA, summary: 'Glob | x' })])
    expect(first.split('sum=')).toHaveLength(2)
    const old = parseTrackerEntries(first)
    expect(old.map(entry => entry.summary)).toEqual(['Glob | x', 'Glob | x'])
    const plan = planTracker(openMap({}), old, new Set<AlertKind>(['dependabot']))
    expect(plan.entries).toEqual(old)
    expect(render(plan.entries, undefined, ['dependabot'])).toBe(first)
  })

  it('一覧を取れず前の行も無い種類は unavailable と書く', () => {
    const plan = planTracker(openMap({}), [], new Set<AlertKind>(['code-scanning']))
    const body = render(plan.entries, undefined, ['code-scanning'])
    expect(body).toContain('## code scanning\n\nunavailable')
    expect(body).toContain('## Dependabot\n\nnone')
  })

  it('無効だった種類が取れなくなると、disabled から unavailable に変わる', () => {
    const before = renderTrackerBody([], HOST, 'o', 'r', { disabledKinds: new Set<AlertKind>(['secret-scanning']) })
    const plan = planTracker(openMap({}), parseTrackerEntries(before), new Set<AlertKind>(['secret-scanning']))
    expect(before).toContain('## secret scanning\n\ndisabled')
    expect(render(plan.entries, before, ['secret-scanning'])).toContain('## secret scanning\n\nunavailable')
  })

  it('一覧を取れなかった種類に前の行があれば、表を残す', () => {
    const body = render([entryOf('code-scanning', 3)], undefined, ['code-scanning'])
    expect(body).not.toContain('unavailable')
    expect(body).toContain('pecot-alert: code-scanning/3')
  })

  it('code scanning と secret scanning は、重大度の高い順、同じなら番号順に並べる', () => {
    const body = render([
      entryOf('code-scanning', 1, { severity: 'note' }),
      entryOf('code-scanning', 2, { severity: undefined }),
      entryOf('code-scanning', 4, { severity: 'none' }),
      entryOf('code-scanning', 5, { severity: 'warning' }),
      entryOf('code-scanning', 6, { severity: 'error' }),
      entryOf('code-scanning', 7, { severity: 'high' }),
      entryOf('code-scanning', 8, { severity: 'critical' }),
      entryOf('code-scanning', 9, { severity: 'medium' }),
      entryOf('code-scanning', 10, { severity: 'low' }),
      entryOf('secret-scanning', 3),
      entryOf('secret-scanning', 1),
    ])
    expect(matchesOf(body, /code-scanning\/(\d+) /gu)).toEqual(['8', '6', '7', '5', '9', '1', '10', '2', '4'])
    expect(matchesOf(body, /secret-scanning\/(\d+) /gu)).toEqual(['1', '3'])
  })

  it('Dependabot の束の重大度は、束の中で最も高いものにし、束どうしもその順に並べる', () => {
    const body = render([
      entryOf('dependabot', 1, { severity: 'low', ghsa: 'GHSA-dddd-eeee-ffff' }),
      entryOf('dependabot', 2, { severity: 'medium', ghsa: GHSA }),
      entryOf('dependabot', 3, { severity: 'critical', ghsa: GHSA }),
      entryOf('dependabot', 4, { severity: undefined }),
    ])
    const rows = body.split('\n').filter(line => line.startsWith('| <!--'))
    expect(rows.map(row => /\| (?<value>\S+) \|$/u.exec(row)?.groups?.['value'])).toEqual(['critical', 'low', '-'])
    expect(rows[0]).toContain('dependabot/2 severity=medium')
  })

  it('表の外の文は残し、更新後の行だけを書き直す', () => {
    const existing = render([entryOf('dependabot', 1)])
    const edited = existing.replace('<!-- pecot-alert: list-begin -->', () => '人が足した文\n\n<!-- pecot-alert: list-begin -->')
    const out = render([entryOf('dependabot', 1), entryOf('dependabot', 2)], edited)
    expect(out).toContain('人が足した文')
    expect(out.split('pecot-alert: dependabot/')).toHaveLength(3)
  })

  it('表に手で足された行は、書き直しで消える', () => {
    const edited = withListEnd(render([entryOf('dependabot', 1)]), '| 手で足した行 | x |')
    expect(render([entryOf('dependabot', 1)], edited)).not.toContain('手で足した行')
  })

  it('CRLF の本文は改行をそろえて読み、書き直すと LF の本文に戻る', () => {
    const existing = render([entryOf('dependabot', 1)])
    const crlf = existing.replaceAll('\n', '\r\n')
    const parsed = parseTrackerEntries(crlf)
    expect(keysOf(parsed)).toEqual(['dependabot/1'])
    expect(render(parsed, crlf)).toBe(existing)
  })

  it('旧い書式の state=open の印を読む', () => {
    const row = '| <!-- pecot-alert: dependabot/7 state=open priority=high pkg=left%2Dpad ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#7](u) | high | left-pad | 要判断 |'
    const old = withListEnd(render([]), row)
    expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 7, { severity: 'high', package: 'left-pad', ghsa: GHSA })])
  })

  const discarded = [
    'dependabot/7 state=exception priority=high',
    'dependabot/7 state=fixed priority=high',
    'dependabot/7 state=dismissed priority=high reason=tolerable_risk',
    'dependabot/7 state=gone priority=high',
    'folded count=3',
  ]

  it.for(discarded)('旧い印 %j の行は読み捨て、書き直しで表から消える', (marker) => {
    const old = withListEnd(render([]), `| <!-- pecot-alert: ${marker} --> x | | | | |`)
    expect(parseTrackerEntries(old)).toEqual([])
    expect(render([], old)).not.toContain('dependabot/7')
    expect(render([], old)).not.toContain('folded')
  })

  const oldPriorities = [
    { name: 'priority= だけの印は、その値を重大度として読む', marker: 'code-scanning/2 priority=high', expected: entryOf('code-scanning', 2, { severity: 'high' }) },
    { name: 'severity= と priority= があれば、severity= を読む', marker: 'code-scanning/2 priority=high severity=note', expected: entryOf('code-scanning', 2, { severity: 'note' }) },
    { name: 'secret scanning の行の priority= は読み捨てる', marker: 'secret-scanning/2 priority=high', expected: entryOf('secret-scanning', 2) },
    { name: '重大度の無い印は、重大度を持たない', marker: 'code-scanning/2', expected: entryOf('code-scanning', 2, { severity: undefined }) },
    { name: '英小文字だけでない重大度は読み捨てる', marker: 'code-scanning/2 severity=High', expected: entryOf('code-scanning', 2, { severity: undefined }) },
    { name: '番号の桁が全角でも読む', marker: 'dependabot/１２ priority=urgent', expected: entryOf('dependabot', 12, { severity: 'urgent' }) },
  ]

  it.for(oldPriorities)('$name（旧い本文の印の読み方）', ({ marker, expected }) => {
    const old = withListEnd(render([]), `| <!-- pecot-alert: ${marker} --> x | | |`)
    expect(parseTrackerEntries(old)).toEqual([expected])
  })

  it('旧い priority= の印は、書き直しで severity= の印と Severity の列に変わる', () => {
    const old = withListEnd(render([]), '| <!-- pecot-alert: code-scanning/2 priority=high --> masked | [#2](u) | high |')
    const body = render(parseTrackerEntries(old), old)
    expect(body).toContain('| <!-- pecot-alert: code-scanning/2 severity=high --> masked | [#2](https://github.com/o/r/security/code-scanning/2) | high |')
    expect(body).not.toContain('priority=')
  })

  it('同じ種類と番号の印が重なると、先に現れた印を使う', () => {
    const rows = '| <!-- pecot-alert: dependabot/1 severity=high --> a | | |\n| <!-- pecot-alert: dependabot/1 severity=low --> b | | |'
    const old = withListEnd(render([]), rows)
    expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 1, { severity: 'high' })])
  })

  it('本文が無いなら、印の組が無いとして SecurityAlertError にする', () => {
    expect(() => parseTrackerEntries()).toThrow(SecurityAlertError)
  })

  const mutations = [
    { name: 'begin が無い', mutate: (body: string) => body.replace('<!-- pecot-alert: list-begin -->', '') },
    { name: 'end が無い', mutate: (body: string) => body.replace('<!-- pecot-alert: list-end -->', '') },
    { name: 'end が 2 つある', mutate: (body: string) => `${body}\n<!-- pecot-alert: list-end -->` },
    { name: 'begin が 2 つある', mutate: (body: string) => `${body}\n<!-- pecot-alert: list-begin -->` },
    { name: '順序が逆', mutate: (body: string) => body.replace('list-begin', 'TMP').replace('list-end', 'list-begin').replace('TMP', 'list-end') },
  ]

  it.for(mutations)('印の組が不正（$name）なら、読みと書き直しの両方で SecurityAlertError にする', ({ mutate }) => {
    const broken = mutate(render([entryOf('dependabot', 1)]))
    expect(() => parseTrackerEntries(broken)).toThrow(SecurityAlertError)
    expect(() => render([], broken)).toThrow(SecurityAlertError)
  })
})

describe('buildTrackerTitle', () => {
  it('渡された UTC の日付を題に入れる', () => {
    expect(buildTrackerTitle('2026-11-06')).toBe('[Tracker] security alert — 2026-11-06')
  })
})

describe('TRACKER_PATTERN', () => {
  it('Tracker の印を持つ open の Issue のうち、番号が最小のものを使う', () => {
    expect(findTracker([trackerIssue(9), trackerIssue(4), trackerIssue(6, 'closed')], TRACKER_PATTERN)).toEqual({ tracker: { number: 4, body: '<!-- pecot-alert: tracker -->' }, others: [9] })
  })

  it('印の中の空白が全角でも合う', () => {
    expect(TRACKER_PATTERN.test('<!--\u{3000}pecot-alert:\u{3000}tracker\u{3000}-->')).toBe(true)
  })
})
