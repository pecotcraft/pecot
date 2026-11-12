import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../python-format.js'
import { ALERT_KINDS, SecurityAlertError } from '../security-alerts.js'
import type { AlertKind } from '../security-alerts.js'
import {
  buildTrackerTitle,
  entryKey,
  maxPriority,
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

function dependabotRaw(number = 7, severity: string | null = 'high'): JsonValue {
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
  return { kind, number, priority: 'medium', url: 'u', package: undefined, ghsa: undefined, summary: undefined, ...fields }
}

function entryOf(kind: AlertKind, number: number, fields: Partial<TrackerEntry> = {}): TrackerEntry {
  return { kind, number, priority: 'medium', package: undefined, ghsa: undefined, summary: undefined, ...fields }
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
  const dependabotPriorities = [
    { severity: 'critical', expected: 'high' },
    { severity: 'high', expected: 'high' },
    { severity: 'medium', expected: 'medium' },
    { severity: 'low', expected: 'low' },
  ]

  it.for(dependabotPriorities)('Dependabot の severity が $severity なら、Priority は $expected', ({ severity, expected }) => {
    expect(normalizeOne('dependabot', dependabotRaw(7, severity)).priority).toBe(expected)
  })

  it('Dependabot の alert から、番号・URL・パッケージ・GHSA・題を読む', () => {
    expect(normalizeOne('dependabot', dependabotRaw())).toEqual({
      kind: 'dependabot',
      number: 7,
      priority: 'high',
      url: 'https://github.com/o/r/security/dependabot/7',
      package: 'left-pad',
      ghsa: GHSA,
      summary: 'Prototype Pollution in left-pad',
    })
  })

  it('Dependabot の severity が vulnerability に無ければ、advisory の severity を使う', () => {
    const raw = { number: 1, security_vulnerability: {}, security_advisory: { severity: 'critical' } }
    expect(normalizeOne('dependabot', raw).priority).toBe('high')
  })

  it('Dependabot の severity が無い、または未知の値なら、Priority は medium', () => {
    expect(normalizeOne('dependabot', { number: 1 }).priority).toBe('medium')
    expect(normalizeOne('dependabot', dependabotRaw(1, 'moderate')).priority).toBe('medium')
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
    { name: 'security_severity_level が critical なら、severity が note でも high', rule: { security_severity_level: 'critical', severity: 'note' }, expected: 'high' },
    { name: 'security_severity_level が medium なら、severity が error でも medium', rule: { security_severity_level: 'medium', severity: 'error' }, expected: 'medium' },
    // eslint-disable-next-line unicorn/no-null -- API の応答の null
    { name: 'security_severity_level が null なら、severity の error で high', rule: { security_severity_level: null, severity: 'error' }, expected: 'high' },
    { name: 'severity が warning なら medium', rule: { severity: 'warning' }, expected: 'medium' },
    { name: 'severity が note なら low', rule: { severity: 'note' }, expected: 'low' },
    { name: 'rule が空なら medium', rule: {}, expected: 'medium' },
  ]

  it.for(codeScanningRules)('code scanning は $name', ({ rule, expected }) => {
    const alert = normalizeOne('code-scanning', { number: 10, rule })
    expect(alert.priority).toBe(expected)
    expect(alert.url).toBe('https://github.com/o/r/security/code-scanning/10')
  })

  it('secret scanning は常に high で、パッケージを持たない', () => {
    const alert = normalizeOne('secret-scanning', { number: 2, secret_type: 'x', secret: 'v' })
    expect(alert).toEqual({ kind: 'secret-scanning', number: 2, priority: 'high', url: 'https://github.com/o/r/security/secret-scanning/2', package: undefined, ghsa: undefined, summary: undefined })
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
    const old = [entryOf('dependabot', 1, { priority: 'low', package: 'old', ghsa: GHSA, summary: 'old summary' })]
    const plan = planTracker(openMap({ dependabot: [alertOf('dependabot', 1, { priority: 'high', package: 'new', summary: '' })] }), old)
    expect(plan.entries).toEqual([entryOf('dependabot', 1, { priority: 'high', package: 'new', ghsa: GHSA, summary: 'old summary' })])
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

describe('maxPriority', () => {
  it('全行の Priority の最大を返し、行が無ければ undefined を返す', () => {
    const entries = [entryOf('dependabot', 1, { priority: 'low' }), entryOf('dependabot', 2, { priority: 'high' }), entryOf('dependabot', 3)]
    expect(maxPriority(entries)).toBe('high')
    expect(maxPriority([])).toBeUndefined()
  })

  it('未知の Priority は medium として比べ、同順位なら先の値を返す', () => {
    expect(maxPriority([entryOf('dependabot', 1, { priority: 'weird' }), entryOf('dependabot', 2)])).toBe('weird')
    expect(maxPriority([entryOf('dependabot', 1, { priority: 'weird' }), entryOf('dependabot', 2, { priority: 'low' })])).toBe('weird')
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
    entryOf('dependabot', 1, { priority: 'high', package: '@scope/left-pad', ghsa: GHSA, summary: 'Pollution -- in | [x] <b>\nnext' }),
    entryOf('dependabot', 3, { package: 'a--b' }),
    entryOf('code-scanning', 4, { priority: 'low' }),
    entryOf('secret-scanning', 5, { priority: 'high' }),
  ]

  it('書いた行を読み戻すと、優先度・パッケージ・GHSA・題が同じになる', () => {
    expect(parseTrackerEntries(render(entries))).toEqual(entries)
  })

  it('新しい本文は、印と種類ごとの見出しと表だけにする', () => {
    const body = render([entryOf('dependabot', 1, { priority: 'high', package: '日本語-pkg', ghsa: GHSA, summary: 'Pollution -- in | [x] <b>\nnext' }), entryOf('dependabot', 2, { priority: 'low' }), entryOf('code-scanning', 4, { priority: 'low' })])
    expect(body).toBe([
      '<!-- pecot-alert: tracker -->',
      '',
      '<!-- pecot-alert: list-begin -->',
      '## Dependabot',
      '',
      '| title | alert | Priority |',
      '|---|---|---|',
      '| <!-- pecot-alert: dependabot/1 priority=high pkg=%E6%97%A5%E6%9C%AC%E8%AA%9E%2Dpkg ghsa=GHSA-aaaa-bbbb-cccc sum=Pollution%20%2D%2D%20in%20%7C%20%5Bx%5D%20%3Cb%3E%0Anext --> [Pollution -- in \\| \\[x\\] &lt;b> next](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | [#1](https://github.com/o/r/security/dependabot/1) | high |',
      '| <!-- pecot-alert: dependabot/2 priority=low --> 不明 | [#2](https://github.com/o/r/security/dependabot/2) | low |',
      '',
      '## code scanning',
      '',
      '| title | alert | Priority |',
      '|---|---|---|',
      '| <!-- pecot-alert: code-scanning/4 priority=low --> masked | [#4](https://github.com/o/r/security/code-scanning/4) | low |',
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
    expect(markers.some(marker => marker.startsWith('dependabot/1 priority=high'))).toBe(true)
    expect(markers.filter(marker => marker.includes('--') || marker.includes('state='))).toEqual([])
  })

  it('code scanning と secret scanning の行は、題を masked に固定する', () => {
    const body = render([entryOf('code-scanning', 4, { priority: 'low' }), entryOf('secret-scanning', 5, { priority: 'high' })])
    expect(body).toContain('| <!-- pecot-alert: code-scanning/4 priority=low --> masked | [#4](')
    expect(body).toContain('| <!-- pecot-alert: secret-scanning/5 priority=high --> masked | [#5](')
    expect(parseTrackerEntries(body)).toEqual([entryOf('code-scanning', 4, { priority: 'low' }), entryOf('secret-scanning', 5, { priority: 'high' })])
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

  it('同じ advisory の alert は 1 行にまとめ、Priority は束の最大にする', () => {
    const grouped = [
      entryOf('dependabot', 13, { ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 9, { priority: 'high', ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 1, { priority: 'low', ghsa: 'GHSA-dddd-eeee-ffff', summary: 'Glob' }),
    ]
    const body = render(grouped)
    const rows = body.split('\n').filter(line => line.startsWith('| <!--'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/\[minimatch DoS\]\(https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc\) \| \[#9\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/9\) \[#13\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/13\) \| high \|$/u)
    expect(rows[1]).toMatch(/\| low \|$/u)
    expect(rows[0]?.match(/<!-- pecot-alert: dependabot\//gu)).toHaveLength(2)
    expect(parseTrackerEntries(body)).toEqual(grouped.toSorted((a, b) => a.number - b.number))
  })

  it('Priority が同じ行は、先頭の alert の番号の順に並べる', () => {
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

  it('code scanning と secret scanning は、Priority の高い順、同じなら番号順に並べる', () => {
    const body = render([
      entryOf('code-scanning', 1, { priority: 'low' }),
      entryOf('code-scanning', 7, { priority: 'high' }),
      entryOf('code-scanning', 3, { priority: 'high' }),
      entryOf('secret-scanning', 2),
      entryOf('secret-scanning', 1, { priority: 'high' }),
    ])
    expect(matchesOf(body, /code-scanning\/(\d+) /gu)).toEqual(['3', '7', '1'])
    expect(matchesOf(body, /secret-scanning\/(\d+) /gu)).toEqual(['1', '2'])
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
    expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 7, { priority: 'high', package: 'left-pad', ghsa: GHSA })])
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

  it('priority が未知の値なら medium、番号の桁が全角でも読む', () => {
    const row = '| <!-- pecot-alert: dependabot/１２ priority=urgent --> x | | |'
    const old = withListEnd(render([]), row)
    expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 12)])
  })

  it('priority の無い印は medium として読む', () => {
    const old = withListEnd(render([]), '| <!-- pecot-alert: code-scanning/2 --> x | | |')
    expect(parseTrackerEntries(old)).toEqual([entryOf('code-scanning', 2)])
  })

  it('同じ種類と番号の印が重なると、先に現れた印を使う', () => {
    const rows = '| <!-- pecot-alert: dependabot/1 priority=high --> a | | |\n| <!-- pecot-alert: dependabot/1 priority=low --> b | | |'
    const old = withListEnd(render([]), rows)
    expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 1, { priority: 'high' })])
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
