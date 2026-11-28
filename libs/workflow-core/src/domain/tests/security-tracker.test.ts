import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

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
  it.for(['critical', 'high', 'medium', 'low'])('Dependabot の severity が %s なら、重大度はその値のまま', async (severity) => {
    await explains('Dependabot の alert を正規化する `normalizeAlerts` のテストです。severity が `critical`・`high`・`medium`・`low` のそれぞれの場合に、重大度がその値のままになることを確認します。')
    stepSync('結果を比べる', () => {
      expect(normalizeOne('dependabot', dependabotRaw(severity)).severity).toBe(severity)
    })
  })

  it('Dependabot の alert から、番号・URL・重大度・パッケージ・GHSA・題を読む', async () => {
    await explains('`normalizeAlerts` のテストです。Dependabot の応答に、番号・URL・重大度・パッケージ・GHSA・題が揃っている場合に、それぞれを alert の項目として読み取ることを確認します。')
    stepSync('結果を比べる', () => {
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
  })

  it('Dependabot の severity が vulnerability に存在しなければ、advisory の severity を使う', async () => {
    await explains('`normalizeAlerts` のテストです。`security_vulnerability` に severity が存在しない場合は、`security_advisory` の severity を重大度として使うことを確認します。')
    const raw = stepSync('生のアラートを用意する', () => ({ number: 1, security_vulnerability: {}, security_advisory: { severity: 'critical' } }))
    stepSync('結果を比べる', () => {
      expect(normalizeOne('dependabot', raw).severity).toBe('critical')
    })
  })

  it('Dependabot の severity がどこにも存在しなければ、重大度を持たない', async () => {
    await explains('`normalizeAlerts` のテストです。severity が応答のどこにも存在しない場合と、空文字の場合に、重大度が `undefined` になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(normalizeOne('dependabot', { number: 1 }).severity).toBeUndefined()
      expect(normalizeOne('dependabot', { number: 1, security_vulnerability: { severity: '' }, security_advisory: {} }).severity).toBeUndefined()
    })
  })

  it.for(['not-a-ghsa', 'GHSA-AAAA-bbbb-cccc', 'GHSA-aaaa-bbbb'])('GHSA が %j なら、GHSA を捨てる', async (ghsa) => {
    await explains('GHSA の形式のテストです。`GHSA-xxxx-xxxx-xxxx` の形式でない値・大文字を含む値・区切りが不足している値を渡した場合に、GHSA が `undefined` になることを確認します。')
    const raw = stepSync('生のアラートを用意する', () => ({ number: 1, security_advisory: { ghsa_id: ghsa } }))
    stepSync('結果を比べる', () => {
      expect(normalizeOne('dependabot', raw).ghsa).toBeUndefined()
    })
  })

  it('html_url が存在しなければ、host と種類と番号から URL を作る', async () => {
    await explains('`normalizeAlerts` のテストです。応答に `html_url` が存在しない場合は、host・種類・番号から alert の URL を組み立てることを確認します。')
    stepSync('結果を比べる', () => {
      expect(normalizeOne('dependabot', { number: 3 }, 'ghes.example.com').url).toBe('https://ghes.example.com/o/r/security/dependabot/3')
    })
  })

  it('番号が整数でない alert と、オブジェクトでない要素を除く', async () => {
    await explains('`normalizeAlerts` のテストです。番号が整数でない alert や、オブジェクトでない要素を含む場合は、それらを除き、番号が整数の alert だけを返すことを確認します。')
    const raws = stepSync('生のアラートの並びを用意する', () => [{ html_url: 'x' }, { number: '1' }, { number: 1.5 }, 'x', { number: 2 }])
    stepSync('結果を比べる', () => {
      expect(normalizeAlerts('dependabot', raws, HOST, 'o', 'r').map(alert => alert.number)).toEqual([2])
    })
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

  it.for(codeScanningRules)('code scanning は $name', async ({ rule, expected }) => {
    await explains('code scanning の重大度の決め方のテストです。`security_severity_level` と `severity` の組み合わせごとに、期待する重大度になり、URL が alert の URL になることを確認します。')
    const alert = stepSync('アラートを正規化する', () => normalizeOne('code-scanning', { number: 10, rule }))
    stepSync('結果を比べる', () => {
      expect(alert.severity).toBe(expected)
      expect(alert.url).toBe('https://github.com/o/r/security/code-scanning/10')
    })
  })

  it('secret scanning は、重大度とパッケージを持たない', async () => {
    await explains('`normalizeAlerts` のテストです。secret scanning の alert は、重大度・パッケージ・GHSA・題を持たず、種類・番号・URL だけを持つことを確認します。')
    const alert = stepSync('アラートを正規化する', () => normalizeOne('secret-scanning', { number: 2, secret_type: 'x', secret: 'v' }))
    stepSync('結果を比べる', () => {
      expect(alert).toEqual({ kind: 'secret-scanning', number: 2, severity: undefined, url: 'https://github.com/o/r/security/secret-scanning/2', package: undefined, ghsa: undefined, summary: undefined })
    })
  })

  it('code scanning と secret scanning では、番号が存在しない alert を除く', async () => {
    await explains('`normalizeAlerts` のテストです。番号が存在しない alert を渡した場合は、どちらの種類でも、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(normalizeAlerts('code-scanning', [{}], HOST, 'o', 'r')).toEqual([])
      expect(normalizeAlerts('secret-scanning', [{}], HOST, 'o', 'r')).toEqual([])
    })
  })
})

describe('quoteComponent と unquoteComponent', () => {
  const quoted = [
    { text: '日本語 a-b_c.d~e/f', expected: '%E6%97%A5%E6%9C%AC%E8%AA%9E%20a-b_c.d~e%2Ff' },
    { text: '@scope/pkg', expected: '%40scope%2Fpkg' },
    { text: '😀', expected: '%F0%9F%98%80' },
    { text: '', expected: '' },
  ]

  it.for(quoted)('$text を `%XX`（大文字）に符号化する', async ({ text, expected }) => {
    await explains('URL 用に符号化する `quoteComponent` と、復号する `unquoteComponent` のテストです。日本語・記号・絵文字・空文字を符号化すると大文字の `%XX` になり、復号すると元の文字列に戻ることを確認します。')
    stepSync('結果を比べる', () => {
      expect(quoteComponent(text)).toBe(expected)
      expect(unquoteComponent(expected)).toBe(text)
    })
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

  it.for(unquoted)('$name は Python の unquote と同じに復号する', async ({ text, expected }) => {
    await explains('`unquoteComponent` のテストです。不正な `%` の列や、途中で切れた UTF-8 のように復号できない入力でも、Python の `unquote` と同じ文字列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(unquoteComponent(text)).toBe(expected)
    })
  })
})

describe('planTracker', () => {
  it('Tracker が存在せず open の alert があれば、Tracker を作る計画にする', async () => {
    await explains('Tracker の更新の計画を立てる `planTracker` のテストです。Tracker が存在せず、open の alert がある場合は、`create` が真になり、すべての alert の行を計画に含めることを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ dependabot: [alertOf('dependabot', 1), alertOf('dependabot', 2)] }), undefined))
    stepSync('結果を比べる', () => {
      expect(plan.create).toBe(true)
      expect(keysOf(plan.entries)).toEqual(['dependabot/1', 'dependabot/2'])
    })
  })

  it('Tracker が存在せず open の alert も存在しなければ、Tracker を作らない', async () => {
    await explains('Tracker も open の alert も存在しない場合の、`planTracker` のテストです。`create` が偽になり、行・追加・削除がすべて空になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(planTracker(openMap({}), undefined)).toEqual({ create: false, entries: [], added: [], removed: [] })
    })
  })

  it('Tracker が既に存在すれば、作らずに追加する行だけを返す', async () => {
    await explains('Tracker が既に存在する場合の、`planTracker` のテストです。`create` が偽のまま、新しい alert の行だけを追加として返すことを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ dependabot: [alertOf('dependabot', 1)] }), []))
    stepSync('結果を比べる', () => {
      expect(plan.create).toBe(false)
      expect(plan.added.map(entry => entry.number)).toEqual([1])
    })
  })

  it('open でなくなった alert の行は、計画から外す', async () => {
    await explains('alert が open でなくなった場合の、`planTracker` のテストです。その alert の行を計画から外し、削除の一覧に入れることを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ dependabot: [alertOf('dependabot', 2)] }), [entryOf('dependabot', 1), entryOf('dependabot', 2)]))
    stepSync('結果を比べる', () => {
      expect(keysOf(plan.entries)).toEqual(['dependabot/2'])
      expect(keysOf(plan.removed)).toEqual(['dependabot/1'])
      expect(plan.added).toEqual([])
    })
  })

  it('新しい値があればそれを使い、存在しない値だけ前の行から引き継ぐ', async () => {
    await explains('既存の行がある場合の、`planTracker` のテストです。新しい alert の値を優先し、alert に存在しない項目だけを、前の行から引き継ぐことを確認します。')
    const old = stepSync('現在の行を用意する', () => [entryOf('dependabot', 1, { severity: 'low', package: 'old', ghsa: GHSA, summary: 'old summary' })])
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ dependabot: [alertOf('dependabot', 1, { severity: 'high', package: 'new', summary: '' })] }), old))
    stepSync('結果を比べる', () => {
      expect(plan.entries).toEqual([entryOf('dependabot', 1, { severity: 'high', package: 'new', ghsa: GHSA, summary: 'old summary' })])
    })
  })

  it('alert が重大度を持たなければ、前の行の重大度を引き継がない', async () => {
    await explains('重大度の引き継ぎのテストです。alert が重大度を持たない場合は、前の行に重大度があっても引き継がず、`undefined` にすることを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ 'code-scanning': [alertOf('code-scanning', 1, { severity: undefined })] }), [entryOf('code-scanning', 1, { severity: 'high' })]))
    stepSync('結果を比べる', () => {
      expect(plan.entries).toEqual([entryOf('code-scanning', 1, { severity: undefined })])
    })
  })

  it('一覧を取得できなかった種類は、前の行を残し、新しい行を足さない', async () => {
    await explains('一覧の取得に失敗した種類の、`planTracker` のテストです。その種類の前の行をそのまま残し、取得できた alert の行も追加しないことを確認します。')
    const old = stepSync('現在の行を用意する', () => [entryOf('secret-scanning', 1)])
    const alerts = stepSync('open のアラートを用意する', () => openMap({ 'dependabot': [alertOf('dependabot', 5)], 'secret-scanning': [alertOf('secret-scanning', 9)] }))
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(alerts, old, new Set<AlertKind>(['secret-scanning', 'code-scanning'])))
    stepSync('結果を比べる', () => {
      expect(keysOf(plan.entries)).toEqual(['dependabot/5', 'secret-scanning/1'])
      expect(plan.removed).toEqual([])
    })
  })

  it('open の alert の一覧に載っていない種類は、alert が 0 件として扱う', async () => {
    await explains('open の alert の一覧に含まれない種類の、`planTracker` のテストです。その種類の alert を 0 件として扱い、前の行を削除の対象にすることを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(new Map([['dependabot', [alertOf('dependabot', 1)]]]), [entryOf('code-scanning', 4)]))
    stepSync('結果を比べる', () => {
      expect(keysOf(plan.entries)).toEqual(['dependabot/1'])
      expect(keysOf(plan.removed)).toEqual(['code-scanning/4'])
    })
  })

  it('一覧を取得できなかった種類だけでは、Tracker を作らない', async () => {
    await explains('一覧の取得に失敗した種類しかない場合の、`planTracker` のテストです。open の alert を確認できないため、`create` が偽になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(planTracker(openMap({}), undefined, new Set<AlertKind>(['dependabot'])).create).toBe(false)
    })
  })

  it('無効な種類は行を持たず、前の行は外す', async () => {
    await explains('機能が無効な種類の、`planTracker` のテストです。その種類の alert があっても行に含めず、前の行を削除の対象にすることを確認します。')
    const old = stepSync('現在の行を用意する', () => [entryOf('code-scanning', 1), entryOf('dependabot', 2)])
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({ dependabot: [alertOf('dependabot', 2)], ['code-scanning']: [alertOf('code-scanning', 8)] }), old, new Set<AlertKind>(), new Set<AlertKind>(['code-scanning'])))
    stepSync('結果を比べる', () => {
      expect(keysOf(plan.entries)).toEqual(['dependabot/2'])
      expect(keysOf(plan.removed)).toEqual(['code-scanning/1'])
      expect(plan.added).toEqual([])
    })
  })

  it('同じ入力で 2 回目を実行すると、追加と削除の行は存在しない', async () => {
    await explains('計画の冪等性のテストです。同じ入力で 2 回続けて計画を立てた場合は、2 回目の追加と削除が空になり、行が 1 回目と同じになることを確認します。')
    const alerts = stepSync('open のアラートを用意する', () => openMap({ 'dependabot': [alertOf('dependabot', 1)], 'code-scanning': [alertOf('code-scanning', 3)] }))
    const first = stepSync('最初の計画を立てる', () => planTracker(alerts, []))
    const second = stepSync('2 回目の計画を立てる', () => planTracker(alerts, first.entries))
    stepSync('結果を比べる', () => {
      expect(second.added).toEqual([])
      expect(second.removed).toEqual([])
      expect(second.entries).toEqual(first.entries)
    })
  })

  it('行は種類の順、番号の昇順に並べる', async () => {
    await explains('行の並び順のテストです。種類の順（Dependabot・code scanning・secret scanning）に並べ、同じ種類の中では番号の昇順に並べることを確認します。')
    const alerts = stepSync('open のアラートを用意する', () => openMap({
      'secret-scanning': [alertOf('secret-scanning', 1)],
      'dependabot': [alertOf('dependabot', 10), alertOf('dependabot', 2)],
      'code-scanning': [alertOf('code-scanning', 5)],
    }))
    stepSync('結果を比べる', () => {
      expect(keysOf(planTracker(alerts, []).entries)).toEqual(['dependabot/2', 'dependabot/10', 'code-scanning/5', 'secret-scanning/1'])
    })
  })
})

describe('maxSeverity', () => {
  it('全行の重大度の最大を返し、行が存在しなければ undefined を返す', async () => {
    await explains('重大度の最大を求める `maxSeverity` のテストです。重大度の異なる行を渡すと最も高い重大度を返し、行を渡さないと `undefined` を返すことを確認します。')
    const entries = stepSync('Tracker の行を用意する', () => [entryOf('dependabot', 1, { severity: 'low' }), entryOf('dependabot', 2, { severity: 'critical' }), entryOf('dependabot', 3)])
    stepSync('結果を比べる', () => {
      expect(maxSeverity(entries)).toBe('critical')
      expect(maxSeverity([])).toBeUndefined()
    })
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

  it.for(orders)('$name を返す', async ({ values, expected }) => {
    await explains('`maxSeverity` の順位のテストです。Dependabot と code scanning の重大度が同じ順位になる組み合わせ、未知の値、重大度が存在しない行などで、期待する値を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(maxSeverity(values.map((severity, index) => entryOf('code-scanning', index + 1, { severity })))).toBe(expected)
    })
  })
})

describe('sortedEntries', () => {
  it('種類の順、番号の昇順に並べ直す', async () => {
    await explains('行を並べ直す `sortedEntries` のテストです。順序がばらばらの行を渡した場合に、種類の順、同じ種類の中では番号の昇順に並べ直すことを確認します。')
    const sorted = stepSync('sortedEntries を呼ぶ', () => sortedEntries([entryOf('secret-scanning', 1), entryOf('dependabot', 9), entryOf('code-scanning', 2), entryOf('dependabot', 3)]))
    stepSync('結果を比べる', () => {
      expect(keysOf(sorted)).toEqual(['dependabot/3', 'dependabot/9', 'code-scanning/2', 'secret-scanning/1'])
    })
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

  it('書いた行を読み戻すと、重大度・パッケージ・GHSA・題が同じになる', async () => {
    await explains('Tracker の本文を作る `renderTrackerBody` と、読む `parseTrackerEntries` のテストです。本文に書いた行を読み戻した場合に、重大度・パッケージ・GHSA・題が同じになることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseTrackerEntries(render(entries))).toEqual(entries)
    })
  })

  it('新しい本文は、印と種類ごとの見出しと表だけにする', async () => {
    await explains('新しく作る本文のテストです。印・種類ごとの見出し・表だけを持つ本文になり、題の記号がエスケープされ、行が存在しない種類は `none` と書くことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 1, { severity: 'high', package: '日本語-pkg', ghsa: GHSA, summary: 'Pollution -- in | [x] <b>\nnext' }), entryOf('dependabot', 2, { severity: 'low' }), entryOf('code-scanning', 4, { severity: 'low' })]))
    stepSync('結果を比べる', () => {
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
  })

  it('印の中に -- を含めず、state も書かない', async () => {
    await explains('本文に埋め込む HTML コメントのマーカーのテストです。マーカーの中に `--` を含めず、`state=` も書かないことで、本文が崩れないことを確認します。')
    const markers = stepSync('マーカーを取り出す', () => matchesOf(render(entries), /<!-- pecot-alert: (.*?) -->/gu))
    stepSync('結果を比べる', () => {
      expect(markers.some(marker => marker.startsWith('dependabot/1 severity=high'))).toBe(true)
      expect(markers.filter(marker => marker.includes('--') || marker.includes('state='))).toEqual([])
    })
  })

  it('code scanning と secret scanning の行は、題を masked に固定する', async () => {
    await explains('code scanning と secret scanning の行のテストです。題を `masked` に固定して書き、読み戻した結果が元の行と同じになることを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('code-scanning', 4, { severity: 'warning' }), entryOf('secret-scanning', 5)]))
    stepSync('結果を比べる', () => {
      expect(body).toContain('| <!-- pecot-alert: code-scanning/4 severity=warning --> masked | [#4](')
      expect(body).toContain('| <!-- pecot-alert: secret-scanning/5 --> masked | [#5](')
      expect(parseTrackerEntries(body)).toEqual([entryOf('code-scanning', 4, { severity: 'warning' }), entryOf('secret-scanning', 5)])
    })
  })

  it('重大度が存在しない行と secret scanning の行は、Severity の列を - にし、印に severity を書かない', async () => {
    await explains('重大度が存在しない行の本文のテストです。Dependabot・code scanning・secret scanning の行で、Severity の列を `-` にし、印に `severity=` を書かないことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 1, { severity: undefined }), entryOf('code-scanning', 4, { severity: undefined }), entryOf('secret-scanning', 5)]))
    stepSync('結果を比べる', () => {
      expect(body).toContain('| <!-- pecot-alert: dependabot/1 --> 不明 | [#1](https://github.com/o/r/security/dependabot/1) | - |')
      expect(body).toContain('| <!-- pecot-alert: code-scanning/4 --> masked | [#4](https://github.com/o/r/security/code-scanning/4) | - |')
      expect(body).toContain('| <!-- pecot-alert: secret-scanning/5 --> masked | [#5](https://github.com/o/r/security/secret-scanning/5) | - |')
    })
  })

  it.for(['high-ish', 'High', 'a b', ''])('重大度が英小文字だけでない値 %j なら、印に severity を書かない', async (severity) => {
    await explains('重大度の形式のテストです。英小文字だけではない値（大文字・空白を含む値・空文字）の場合は、印に `severity=` を書かないことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('code-scanning', 4, { severity })]))
    stepSync('結果を比べる', () => {
      expect(body).toContain('<!-- pecot-alert: code-scanning/4 -->')
    })
  })

  it('行が存在しない種類は none と書き、表を作らない', async () => {
    await explains('行が 1 つも存在しない場合のテストです。すべての種類の見出しの下に `none` と書き、表を作らず、読み戻した結果が空になることを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([]))
    stepSync('結果を比べる', () => {
      for (const label of ['Dependabot', 'code scanning', 'secret scanning']) expect(body).toContain(`## ${label}\n\nnone`)
      expect(body).not.toContain('|')
      expect(parseTrackerEntries(body)).toEqual([])
    })
  })

  it('無効な種類は、見出しの下に disabled だけを書く', async () => {
    await explains('無効な種類を指定した場合の本文のテストです。その種類の見出しの下に `disabled` だけを書き、ほかの種類の表は通常どおり作ることを確認します。')
    const body = stepSync('renderTrackerBody を呼ぶ', () => renderTrackerBody([entryOf('dependabot', 1)], HOST, 'o', 'r', { disabledKinds: new Set<AlertKind>(['code-scanning']) }))
    stepSync('結果を比べる', () => {
      expect(body).toContain('## code scanning\n\ndisabled\n\n## secret scanning\n\nnone')
      expect(body).toContain('## Dependabot\n\n| title')
    })
  })

  it('同じ advisory の alert は 1 行にまとめ、重大度は束の最大にする', async () => {
    await explains('同じ advisory の alert の本文のテストです。同じ GHSA の alert を 1 行にまとめ、重大度を束の最大にし、読み戻すとすべての alert が元の行に戻ることを確認します。')
    const grouped = stepSync('まとめる行を用意する', () => [
      entryOf('dependabot', 13, { ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 9, { severity: 'high', ghsa: GHSA, summary: 'minimatch DoS' }),
      entryOf('dependabot', 1, { severity: 'low', ghsa: 'GHSA-dddd-eeee-ffff', summary: 'Glob' }),
    ])
    const body = stepSync('Tracker の本文を組み立てる', () => render(grouped))
    const rows = stepSync('表の行を取り出す', () => body.split('\n').filter(line => line.startsWith('| <!--')))
    stepSync('結果を比べる', () => {
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatch(/\[minimatch DoS\]\(https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc\) \| \[#9\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/9\) \[#13\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/13\) \| high \|$/u)
      expect(rows[1]).toMatch(/\| low \|$/u)
      expect(rows[0]?.match(/<!-- pecot-alert: dependabot\//gu)).toHaveLength(2)
      expect(parseTrackerEntries(body)).toEqual(grouped.toSorted((a, b) => a.number - b.number))
    })
  })

  it('重大度が同じ行は、先頭の alert の番号の順に並べる', async () => {
    await explains('重大度が同じ行の並び順のテストです。先頭の alert の番号が小さい行を、先に書くことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 5, { ghsa: GHSA }), entryOf('dependabot', 2, { ghsa: 'GHSA-dddd-eeee-ffff' })]))
    stepSync('結果を比べる', () => {
      expect(body.indexOf('dependabot/2 ')).toBeLessThan(body.indexOf('dependabot/5 '))
    })
  })

  it('内容は、題、GHSA、パッケージの順に使い、GHSA の無い alert は束ねない', async () => {
    await explains('行の内容の選び方のテストです。題・GHSA・パッケージの順に、存在するものを使い、GHSA が存在しない alert は 1 行にまとめないことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 1, { ghsa: GHSA }), entryOf('dependabot', 2, { package: 'pkg' }), entryOf('dependabot', 3, { package: 'pkg' })]))
    stepSync('結果を比べる', () => {
      expect(body).toContain(`[${GHSA}](https://github.com/advisories/${GHSA})`)
      expect(body.split('--> pkg |')).toHaveLength(3)
    })
  })

  it('advisory のリンクは、渡された host を使う', async () => {
    await explains('advisory のリンクのテストです。`github.com` ではなく、渡された host を使った URL でリンクを書くことを確認します。')
    const body = stepSync('renderTrackerBody を呼ぶ', () => renderTrackerBody([entryOf('dependabot', 1, { ghsa: GHSA, summary: 's' })], 'ghes.example.com', 'o', 'r'))
    stepSync('結果を比べる', () => {
      expect(body).toContain(`(https://ghes.example.com/advisories/${GHSA})`)
    })
  })

  it('題に印を偽装する文字列があっても、印は 1 組のままで読み戻せる', async () => {
    await explains('題が印を偽装する文字列を含む場合のテストです。題の中の `-->` や `list-end` で印が増えず、印の組が 1 組のままで、読み戻した行が元と同じになることを確認します。')
    const entry = stepSync('記号を含む行を用意する', () => entryOf('dependabot', 1, { ghsa: GHSA, summary: 'a -- b | c --> <!-- pecot-alert: list-end --> d' }))
    const body = stepSync('Tracker の本文を組み立てる', () => render([entry]))
    stepSync('結果を比べる', () => {
      expect(body.split('<!-- pecot-alert: list-end -->')).toHaveLength(2)
      expect(parseTrackerEntries(body)).toEqual([entry])
    })
  })

  it('題に含まれる記号は、リンクの中でエスケープする', async () => {
    await explains('題に Markdown の記号（`[`・`]`・`\\`・`|`）を含む場合のテストです。リンクの中でエスケープして、表とリンクが崩れず、読み戻した行が元と同じになることを確認します。')
    const entry = stepSync('記号を含む行を用意する', () => entryOf('dependabot', 1, { ghsa: GHSA, summary: String.raw`a ] b [ c \ d | e \| f` }))
    const body = stepSync('Tracker の本文を組み立てる', () => render([entry]))
    const row = stepSync('対象の行を取り出す', () => body.split('\n').find(line => line.includes('dependabot/1 ')))
    stepSync('結果を比べる', () => {
      expect(row).toContain(String.raw`[a \] b \[ c \\ d \| e \\\| f](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)`)
      expect(parseTrackerEntries(body)).toEqual([entry])
    })
  })

  it('一覧を取得できなかった種類の束は、全 alert の題を保ち、同じ本文に戻る', async () => {
    await explains('一覧の取得に失敗した種類の、同じ advisory の束のテストです。束にまとめた全 alert の題を保ったまま計画に残し、本文を書き直すと、元と同じ本文になることを確認します。')
    const first = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 1, { ghsa: GHSA, summary: 'Glob | x' }), entryOf('dependabot', 5, { ghsa: GHSA, summary: 'Glob | x' })]))
    stepSync('結果を比べる', () => {
      expect(first.split('sum=')).toHaveLength(2)
    })
    const old = stepSync('parseTrackerEntries を呼ぶ', () => parseTrackerEntries(first))
    stepSync('結果を比べる', () => {
      expect(old.map(entry => entry.summary)).toEqual(['Glob | x', 'Glob | x'])
    })
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({}), old, new Set<AlertKind>(['dependabot'])))
    stepSync('結果を比べる', () => {
      expect(plan.entries).toEqual(old)
      expect(render(plan.entries, undefined, ['dependabot'])).toBe(first)
    })
  })

  it('一覧を取得できず前の行も存在しない種類は、unavailable と書く', async () => {
    await explains('一覧の取得に失敗し、前の行も存在しない場合のテストです。その種類の見出しの下に `unavailable` と書き、ほかの種類は `none` のままにすることを確認します。')
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({}), [], new Set<AlertKind>(['code-scanning'])))
    const body = stepSync('Tracker の本文を組み立てる', () => render(plan.entries, undefined, ['code-scanning']))
    stepSync('結果を比べる', () => {
      expect(body).toContain('## code scanning\n\nunavailable')
      expect(body).toContain('## Dependabot\n\nnone')
    })
  })

  it('無効だった種類が取れなくなると、disabled から unavailable に変わる', async () => {
    await explains('状態の遷移のテストです。無効だった種類が一覧を取得できなくなった場合は、本文が `disabled` から `unavailable` に変わることを確認します。')
    const before = stepSync('無効な種別の本文を組み立てる', () => renderTrackerBody([], HOST, 'o', 'r', { disabledKinds: new Set<AlertKind>(['secret-scanning']) }))
    const plan = stepSync('Tracker の計画を立てる', () => planTracker(openMap({}), parseTrackerEntries(before), new Set<AlertKind>(['secret-scanning'])))
    stepSync('結果を比べる', () => {
      expect(before).toContain('## secret scanning\n\ndisabled')
      expect(render(plan.entries, before, ['secret-scanning'])).toContain('## secret scanning\n\nunavailable')
    })
  })

  it('一覧を取得できなかった種類に前の行があれば、表を残す', async () => {
    await explains('一覧の取得に失敗したが、前の行が存在する場合のテストです。`unavailable` と書かず、前の行の表を残すことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([entryOf('code-scanning', 3)], undefined, ['code-scanning']))
    stepSync('結果を比べる', () => {
      expect(body).not.toContain('unavailable')
      expect(body).toContain('pecot-alert: code-scanning/3')
    })
  })

  it('code scanning と secret scanning は、重大度の高い順、同じなら番号順に並べる', async () => {
    await explains('code scanning と secret scanning の並び順のテストです。code scanning は重大度の高い順で、同じ重大度では番号の昇順に並び、secret scanning は番号の昇順に並ぶことを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([
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
    ]))
    stepSync('結果を比べる', () => {
      expect(matchesOf(body, /code-scanning\/(\d+) /gu)).toEqual(['8', '6', '7', '5', '9', '1', '10', '2', '4'])
      expect(matchesOf(body, /secret-scanning\/(\d+) /gu)).toEqual(['1', '3'])
    })
  })

  it('Dependabot の束の重大度は、束の中で最も高いものにし、束どうしもその順に並べる', async () => {
    await explains('Dependabot の束の並び順のテストです。束の重大度を、束の中で最も高い値にし、束どうしも重大度の高い順に並べることを確認します。')
    const body = stepSync('Tracker の本文を組み立てる', () => render([
      entryOf('dependabot', 1, { severity: 'low', ghsa: 'GHSA-dddd-eeee-ffff' }),
      entryOf('dependabot', 2, { severity: 'medium', ghsa: GHSA }),
      entryOf('dependabot', 3, { severity: 'critical', ghsa: GHSA }),
      entryOf('dependabot', 4, { severity: undefined }),
    ]))
    const rows = stepSync('表の行を取り出す', () => body.split('\n').filter(line => line.startsWith('| <!--')))
    stepSync('結果を比べる', () => {
      expect(rows.map(row => /\| (?<value>\S+) \|$/u.exec(row)?.groups?.['value'])).toEqual(['critical', 'low', '-'])
      expect(rows[0]).toContain('dependabot/2 severity=medium')
    })
  })

  it('表の外の文は残し、更新後の行だけを書き直す', async () => {
    await explains('人が書いた文の扱いのテストです。表の外に人が追加した文は残し、表の中の行だけを更新後の内容で書き直すことを確認します。')
    const existing = stepSync('現在の本文を組み立てる', () => render([entryOf('dependabot', 1)]))
    const edited = stepSync('人が足した文を入れた本文を用意する', () => existing.replace('<!-- pecot-alert: list-begin -->', () => '人が足した文\n\n<!-- pecot-alert: list-begin -->'))
    const out = stepSync('Tracker の本文を組み立てる', () => render([entryOf('dependabot', 1), entryOf('dependabot', 2)], edited))
    stepSync('結果を比べる', () => {
      expect(out).toContain('人が足した文')
      expect(out.split('pecot-alert: dependabot/')).toHaveLength(3)
    })
  })

  it('表に手で足された行は、書き直しで消える', async () => {
    await explains('表の中に手で追加した行の扱いのテストです。書き直したときに、手で追加した行が消えることを確認します。')
    const edited = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([entryOf('dependabot', 1)]), '| 手で足した行 | x |'))
    stepSync('結果を比べる', () => {
      expect(render([entryOf('dependabot', 1)], edited)).not.toContain('手で足した行')
    })
  })

  it('CRLF の本文は改行をそろえて読み、書き直すと LF の本文に戻る', async () => {
    await explains('改行が CRLF の本文のテストです。改行をそろえて読み、書き直した結果は LF の本文になることを確認します。')
    const existing = stepSync('現在の本文を組み立てる', () => render([entryOf('dependabot', 1)]))
    const crlf = stepSync('改行を CRLF にした本文を用意する', () => existing.replaceAll('\n', '\r\n'))
    const parsed = stepSync('parseTrackerEntries を呼ぶ', () => parseTrackerEntries(crlf))
    stepSync('結果を比べる', () => {
      expect(keysOf(parsed)).toEqual(['dependabot/1'])
      expect(render(parsed, crlf)).toBe(existing)
    })
  })

  it('旧い書式の state=open の印を読む', async () => {
    await explains('旧い書式の印のテストです。`state=open` と `priority=` を持つ印を、重大度・パッケージ・GHSA を持つ行として読むことを確認します。')
    const row = '| <!-- pecot-alert: dependabot/7 state=open priority=high pkg=left%2Dpad ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#7](u) | high | left-pad | 要判断 |'
    const old = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([]), row))
    stepSync('結果を比べる', () => {
      expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 7, { severity: 'high', package: 'left-pad', ghsa: GHSA })])
    })
  })

  const discarded = [
    'dependabot/7 state=exception priority=high',
    'dependabot/7 state=fixed priority=high',
    'dependabot/7 state=dismissed priority=high reason=tolerable_risk',
    'dependabot/7 state=gone priority=high',
    'folded count=3',
  ]

  it.for(discarded)('旧い印 %j の行は読み捨て、書き直しで表から消える', async (marker) => {
    await explains('読み捨てる旧い印のテストです。`state=exception` や `folded` などの印を持つ行は、読み取りの結果に含めず、書き直しで表から消えることを確認します。')
    const old = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([]), `| <!-- pecot-alert: ${marker} --> x | | | | |`))
    stepSync('結果を比べる', () => {
      expect(parseTrackerEntries(old)).toEqual([])
      expect(render([], old)).not.toContain('dependabot/7')
      expect(render([], old)).not.toContain('folded')
    })
  })

  const oldPriorities = [
    { name: 'priority= だけの印は、その値を重大度として読む', marker: 'code-scanning/2 priority=high', expected: entryOf('code-scanning', 2, { severity: 'high' }) },
    { name: 'severity= と priority= があれば、severity= を読む', marker: 'code-scanning/2 priority=high severity=note', expected: entryOf('code-scanning', 2, { severity: 'note' }) },
    { name: 'secret scanning の行の priority= は読み捨てる', marker: 'secret-scanning/2 priority=high', expected: entryOf('secret-scanning', 2) },
    { name: '重大度の無い印は、重大度を持たない', marker: 'code-scanning/2', expected: entryOf('code-scanning', 2, { severity: undefined }) },
    { name: '英小文字だけでない重大度は読み捨てる', marker: 'code-scanning/2 severity=High', expected: entryOf('code-scanning', 2, { severity: undefined }) },
    { name: '番号の桁が全角でも読む', marker: 'dependabot/１２ priority=urgent', expected: entryOf('dependabot', 12, { severity: 'urgent' }) },
  ]

  it.for(oldPriorities)('旧い本文では、$name', async ({ marker, expected }) => {
    await explains('旧い `priority=` の印の読み方のテストです。`priority=` と `severity=` の有無や、値の形式ごとに、期待する重大度として読み取ることを確認します。')
    const old = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([]), `| <!-- pecot-alert: ${marker} --> x | | |`))
    stepSync('結果を比べる', () => {
      expect(parseTrackerEntries(old)).toEqual([expected])
    })
  })

  it('旧い priority= の印は、書き直しで severity= の印と Severity の列に変わる', async () => {
    await explains('旧い `priority=` の印の書き直しのテストです。`severity=` の印と Severity の列に変わり、`priority=` は残らないことを確認します。')
    const old = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([]), '| <!-- pecot-alert: code-scanning/2 priority=high --> masked | [#2](u) | high |'))
    const body = stepSync('Tracker の本文を組み立てる', () => render(parseTrackerEntries(old), old))
    stepSync('結果を比べる', () => {
      expect(body).toContain('| <!-- pecot-alert: code-scanning/2 severity=high --> masked | [#2](https://github.com/o/r/security/code-scanning/2) | high |')
      expect(body).not.toContain('priority=')
    })
  })

  it('同じ種類と番号の印が重なると、先に現れた印を使う', async () => {
    await explains('同じ種類と番号の印が複数ある場合のテストです。先に現れた印だけを使うことを確認します。')
    const rows = '| <!-- pecot-alert: dependabot/1 severity=high --> a | | |\n| <!-- pecot-alert: dependabot/1 severity=low --> b | | |'
    const old = stepSync('末尾に行を足した本文を用意する', () => withListEnd(render([]), rows))
    stepSync('結果を比べる', () => {
      expect(parseTrackerEntries(old)).toEqual([entryOf('dependabot', 1, { severity: 'high' })])
    })
  })

  it('本文が存在しなければ、印の組が存在しないとして SecurityAlertError の例外が発生する', async () => {
    await explains('本文を渡さない場合の、`parseTrackerEntries` のテストです。印の組が存在しないものとして、`SecurityAlertError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseTrackerEntries()).toThrow(SecurityAlertError)
    })
  })

  const mutations = [
    { name: 'begin が無い', mutate: (body: string) => body.replace('<!-- pecot-alert: list-begin -->', '') },
    { name: 'end が無い', mutate: (body: string) => body.replace('<!-- pecot-alert: list-end -->', '') },
    { name: 'end が 2 つある', mutate: (body: string) => `${body}\n<!-- pecot-alert: list-end -->` },
    { name: 'begin が 2 つある', mutate: (body: string) => `${body}\n<!-- pecot-alert: list-begin -->` },
    { name: '順序が逆', mutate: (body: string) => body.replace('list-begin', 'TMP').replace('list-end', 'list-begin').replace('TMP', 'list-end') },
  ]

  it.for(mutations)('印の組が不正（$name）なら、読みと書き直しの両方で SecurityAlertError にする', async ({ mutate }) => {
    await explains('印の組が不正な本文のテストです。`begin` や `end` が存在しない場合・重複する場合・順序が逆の場合のいずれも、読み取りと書き直しの両方で、`SecurityAlertError` の例外が発生することを確認します。')
    const broken = stepSync('本文を壊す', () => mutate(render([entryOf('dependabot', 1)])))
    stepSync('例外を確かめる', () => {
      expect(() => parseTrackerEntries(broken)).toThrow(SecurityAlertError)
      expect(() => render([], broken)).toThrow(SecurityAlertError)
    })
  })
})

describe('buildTrackerTitle', () => {
  it('渡された UTC の日付を題に入れる', async () => {
    await explains('Tracker の題を作る `buildTrackerTitle` のテストです。渡された UTC の日付を、`[Tracker] security alert — 2026-11-06` の形の題に入れることを確認します。')
    stepSync('結果を比べる', () => {
      expect(buildTrackerTitle('2026-11-06')).toBe('[Tracker] security alert — 2026-11-06')
    })
  })
})

describe('TRACKER_PATTERN', () => {
  it('Tracker の印を持つ open の Issue のうち、番号が最小のものを使う', async () => {
    await explains('Tracker を探す `findTracker` と `TRACKER_PATTERN` のテストです。印を持つ open の Issue が複数ある場合に、番号が最小の Issue を Tracker とし、ほかの番号を `others` に入れることを確認します。')
    stepSync('結果を比べる', () => {
      expect(findTracker([trackerIssue(9), trackerIssue(4), trackerIssue(6, 'closed')], TRACKER_PATTERN)).toEqual({ tracker: { number: 4, body: '<!-- pecot-alert: tracker -->' }, others: [9] })
    })
  })

  it('印の中の空白が全角でも合う', async () => {
    await explains('Tracker の印の `TRACKER_PATTERN` のテストです。印の中の空白が全角でも、印として一致することを確認します。')
    stepSync('結果を比べる', () => {
      expect(TRACKER_PATTERN.test('<!--\u{3000}pecot-alert:\u{3000}tracker\u{3000}-->')).toBe(true)
    })
  })
})
