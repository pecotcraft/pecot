// 対応する Python のテストは cli/tests/core/test_dependabot_prs.py。
// 期待値のうち Python と細かく違いうるもの（版の計算・時刻の読み）は、Python で実際に動かして確かめた値。
import { describe, expect, it } from 'vitest'

import {
  buildTrackerTitle,
  checksLabel,
  DependabotPrError,
  LIST_BEGIN,
  LIST_END,
  parseTrackerPullRequestNumbers,
  parseUpdateMetadata,
  planTracker,
  renderTrackerBody,
  rollupState,
  TRACKER_PATTERN,
  waitingReasons,
} from '../dependabot-pull-requests.js'
import type { PrEntry } from '../dependabot-pull-requests.js'
import type { JsonObject } from '../json.js'
import { JSON_NULL } from '../json-null.js'

const NOW = new Date('2026-11-09T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function iso(ageMs: number): string {
  return new Date(NOW.getTime() - ageMs).toISOString().replace('.000Z', 'Z')
}

type Dependency = readonly [string, string | undefined]

function message(...dependencies: readonly Dependency[]): string {
  const lines = ['Bump x', '', '---', 'updated-dependencies:']
  for (const [name, kind] of dependencies) {
    lines.push(`- dependency-name: "${name}"`, '  dependency-type: direct:development')
    if (kind !== undefined) lines.push(`  update-type: version-update:semver-${kind}`)
  }
  return [...lines, '...', '', 'Signed-off-by: dependabot[bot] <support@github.com>'].join('\n')
}

interface PrOptions {
  readonly dependencies?: readonly Dependency[]
  readonly message?: string
  readonly signature?: JsonObject | typeof JSON_NULL
  readonly commitAuthor?: string | typeof JSON_NULL
  readonly age?: number
  readonly autoMerge?: boolean
  readonly queue?: boolean
  readonly rollup?: string | typeof JSON_NULL
  readonly mergeable?: string
  readonly baseAge?: number
  readonly events?: readonly (readonly [string, number])[]
}

function last(kind: string, events: PrOptions['events']): JsonObject {
  const ages = (events ?? []).filter(([name]) => name === kind).map(([, age]) => age)
  return { nodes: ages.length > 0 ? [{ createdAt: iso(Math.min(...ages)) }] : [] }
}

function pr(options: Readonly<PrOptions> = {}): JsonObject {
  const age = options.age ?? 2 * HOUR
  const author = options.commitAuthor === undefined ? 'dependabot[bot]' : options.commitAuthor
  const rollup = options.rollup === undefined ? 'SUCCESS' : options.rollup
  return {
    number: 7,
    title: 'Bump left-pad',
    url: 'https://github.com/o/r/pull/7',
    createdAt: iso(age),
    author: { __typename: 'Bot', login: 'dependabot' },
    isInMergeQueue: options.queue ?? false,
    autoMergeRequest: options.autoMerge === false ? JSON_NULL : { enabledAt: iso(age) },
    mergeable: options.mergeable ?? 'MERGEABLE',
    baseRef: { target: { committedDate: iso(options.baseAge ?? 72 * HOUR) } },
    firstCommits: {
      nodes: [{
        commit: {
          message: options.message ?? message(...options.dependencies ?? [['left-pad', 'minor']]),
          signature: options.signature === undefined ? { isValid: true } : options.signature,
          author: { user: author === null ? JSON_NULL : { login: author } },
        },
      }],
    },
    headCommits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? JSON_NULL : { state: rollup } } }] },
    lastForcePush: last('HeadRefForcePushedEvent', options.events),
    lastDequeue: last('RemovedFromMergeQueueEvent', options.events),
  }
}

describe('parseUpdateMetadata', () => {
  it('依存が 1 つなら、その名前と update-type を返す', () => {
    expect(parseUpdateMetadata(message(['a', 'minor']))).toEqual([['a', 'minor']])
  })

  it('group の PR では依存ごとに返す', () => {
    expect(parseUpdateMetadata(message(['a', 'patch'], ['b', 'major']))).toEqual([['a', 'patch'], ['b', 'major']])
  })

  it('update-type が無いときは、group の Updates 行の版から計算する', () => {
    const text = message(['a', undefined], ['b', undefined]).replace(
      'Signed-off-by',
      'Updates `a` from 1.2.3 to 2.0.0\nUpdates `b` from v1.2.3 to v1.3.0\nSigned-off-by',
    )
    expect(parseUpdateMetadata(text)).toEqual([['a', 'major'], ['b', 'minor']])
  })

  it('同じ名前の依存は、Updates 行を出てきた順に当てる', () => {
    const text = message(['a', undefined], ['a', undefined]).replace(
      'Signed-off-by',
      'Updates `a` from 1.0.0 to 1.0.1\nUpdates `a` from 1.0.0 to 2.0.0\nSigned-off-by',
    )
    expect(parseUpdateMetadata(text)).toEqual([['a', 'patch'], ['a', 'major']])
  })

  it('update-type が無いときは、Bumps 行の版から計算する', () => {
    expect(parseUpdateMetadata(`Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n${message(['a', undefined])}`)).toEqual([['a', 'patch']])
  })

  it('Bumps 行は先頭の依存にだけ当てる', () => {
    const text = `Bumps [a](https://x) from 1.2.3 to 2.0.0.\n\n${message(['a', undefined], ['b', undefined])}`
    expect(parseUpdateMetadata(text)).toEqual([['a', 'major'], ['b', undefined]])
  })

  it('YAML の dependency-version を新しい版として使う', () => {
    const text = `Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n${message(['a', undefined]).replace('  dependency-type', '  dependency-version: 1.3.0\n  dependency-type')}`
    expect(parseUpdateMetadata(text)).toEqual([['a', 'minor']])
  })

  it('Updates 行は行全体が合うときだけ読む', () => {
    const text = message(['a', undefined]).replace('Signed-off-by', 'see Updates `a` from 1.0.0 to 2.0.0 here\nSigned-off-by')
    expect(parseUpdateMetadata(text)).toEqual([['a', undefined]])
  })

  it.for([
    { old: '1.2.3', next: '1.2.3', expected: undefined },
    { old: '1.2.3', next: '1.2.4', expected: 'patch' },
    { old: '1.2.3', next: '1.3.0', expected: 'minor' },
    { old: '1.2.3', next: '2.0.0', expected: 'major' },
    { old: '1', next: '1.0', expected: 'minor' },
    { old: '1.0.0-beta.1', next: '1.0.0', expected: 'patch' },
    { old: 'v1.2.3', next: 'v1.2.4', expected: 'patch' },
  ])('版が $old から $next に変わると、種類は $expected になる', ({ old, next, expected }) => {
    expect(parseUpdateMetadata(`Bumps [a](https://x) from ${old} to ${next}.\n\n${message(['a', undefined])}`)).toEqual([['a', expected]])
  })

  it('CRLF の message も読む', () => {
    expect(parseUpdateMetadata(message(['a', 'minor']).replaceAll('\n', '\r\n'))).toEqual([['a', 'minor']])
  })

  it('update-type が semver- を含まない値でも、末尾が種類ならそれを使う', () => {
    const text = message(['a', undefined]).replace('  dependency-type', '  update-type: minor\n  dependency-type')
    expect(parseUpdateMetadata(text)).toEqual([['a', 'minor']])
  })

  it('依存名が文字列でない項目は読み飛ばす', () => {
    const text = 'x\n\n---\nupdated-dependencies:\n- dependency-name: 1\n- just-a-string\n- dependency-name: b\n  update-type: version-update:semver-patch\n...\n'
    expect(parseUpdateMetadata(text)).toEqual([['b', 'patch']])
  })

  it('update-type と版の両方が無ければ、種類は undefined', () => {
    expect(parseUpdateMetadata(message(['a', undefined]))).toEqual([['a', undefined]])
  })

  it.for([
    { name: 'YAML が無い', text: 'Bump a from 1 to 2\n\nplain message' },
    { name: 'YAML が読めない', text: 'x\n\n---\nupdated-dependencies: [\n...\n' },
    { name: 'YAML が辞書でない', text: 'x\n\n---\n- a\n- b\n...\n' },
    { name: 'YAML が set のタグ', text: 'x\n\n---\n!!set {a, b}\n...\n' },
    { name: '依存の配列が無い', text: 'x\n\n---\nother: 1\n...\n' },
    { name: '依存の配列が空', text: 'x\n\n---\nupdated-dependencies: []\n...\n' },
  ])('$name と、undefined を返す', ({ text }) => {
    expect(parseUpdateMetadata(text)).toBeUndefined()
  })
})

describe('waitingReasons の update-type', () => {
  it('良い状態の minor は載せない', () => {
    expect(waitingReasons(pr(), NOW)).toEqual([])
  })

  it('major は理由に出す', () => {
    expect(waitingReasons(pr({ dependencies: [['a', 'major']] }), NOW)).toEqual(['major'])
  })

  it('group に major が 1 つでもあれば major にする', () => {
    expect(waitingReasons(pr({ dependencies: [['a', 'patch'], ['b', 'major']] }), NOW)).toEqual(['major'])
  })

  it('依存名は minor に理由を足さない', () => {
    expect(waitingReasons(pr({ dependencies: [['@Playwright/test', 'minor']] }), NOW)).toEqual([])
  })

  it.for([{ author: 'someone' }, { author: JSON_NULL }])('最初の commit の author が $author だと、種類不明にする', ({ author }) => {
    expect(waitingReasons(pr({ commitAuthor: author }), NOW)).toEqual(['unknown update type'])
  })

  it('種類が 1 つも決まらなければ、種類不明にする', () => {
    expect(waitingReasons(pr({ dependencies: [['a', undefined]] }), NOW)).toEqual(['unknown update type'])
  })

  it.for([{ signature: { isValid: false } }, { signature: {} }, { signature: JSON_NULL }])('署名が $signature だと、種類不明にする', ({ signature }) => {
    expect(waitingReasons(pr({ signature }), NOW)).toEqual(['unknown update type'])
  })

  it('YAML の依存名が引用符なしの @scope だと、種類不明にする', () => {
    const text = 'Bump x\n\n---\nupdated-dependencies:\n- dependency-name: @scope/x\n  update-type: version-update:semver-minor\n...\n'
    expect(waitingReasons(pr({ message: text }), NOW)).toEqual(['unknown update type'])
  })

  it('対象でない PR は、状態の理由を足さない', () => {
    expect(waitingReasons(pr({ dependencies: [['a', 'major']], rollup: 'FAILURE', mergeable: 'CONFLICTING' }), NOW)).toEqual(['major'])
  })

  it('commit の message が無いと、種類不明にする', () => {
    const node = pr()
    expect(waitingReasons({ ...node, firstCommits: { nodes: [] } }, NOW)).toEqual(['unknown update type'])
  })
})

describe('waitingReasons の状態', () => {
  it.for(['FAILURE', 'ERROR'])('検証が %s なら、検証の失敗にする', (rollup) => {
    expect(waitingReasons(pr({ rollup }), NOW)).toEqual(['checks failed'])
  })

  it('検証が 24 時間以内の PENDING なら載せない', () => {
    expect(waitingReasons(pr({ rollup: 'PENDING', age: 23 * HOUR }), NOW)).toEqual([])
  })

  it.for(['PENDING', 'EXPECTED', JSON_NULL])('検証が %j のまま 24 時間を超えると、検証の停滞にする', (rollup) => {
    expect(waitingReasons(pr({ rollup, age: 25 * HOUR }), NOW)).toEqual(['checks not finishing'])
  })

  it.for([
    { age: 24 * HOUR, expected: [] },
    { age: 24 * HOUR + 1000, expected: ['checks not finishing'] },
  ])('PR を作って $age ミリ秒の PENDING は $expected になる', ({ age, expected }) => {
    expect(waitingReasons(pr({ rollup: 'PENDING', age }), NOW)).toEqual(expected)
  })

  it('検証の停滞は auto-merge がある PR にだけ当てる', () => {
    expect(waitingReasons(pr({ autoMerge: false, rollup: 'PENDING', age: 25 * HOUR }), NOW)).toEqual(['no auto-merge'])
  })

  it.for([
    { age: 30 * MINUTE, expected: [] },
    { age: 30 * MINUTE + 1000, expected: ['no auto-merge'] },
  ])('auto-merge が無く $age ミリ秒たつと $expected になる', ({ age, expected }) => {
    expect(waitingReasons(pr({ autoMerge: false, age }), NOW)).toEqual(expected)
  })

  it.for([
    { baseAge: 30 * MINUTE, expected: [] },
    { baseAge: 30 * MINUTE + 1000, expected: ['conflict'] },
  ])('base が $baseAge ミリ秒前に進んでいて競合なら $expected になる', ({ baseAge, expected }) => {
    expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge }), NOW)).toEqual(expected)
  })

  it.for([
    { age: 30 * MINUTE, expected: [] },
    { age: 30 * MINUTE + 1000, expected: ['conflict'] },
  ])('push が $age ミリ秒前で競合なら $expected になる', ({ age, expected }) => {
    expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age }), NOW)).toEqual(expected)
  })

  it('base の時刻が読めなくても、push の時刻で競合を判定する', () => {
    const node = pr({ mergeable: 'CONFLICTING', age: 2 * HOUR })
    expect(waitingReasons({ ...node, baseRef: { target: {} } }, NOW)).toEqual(['conflict'])
  })

  it('rebase の前の dequeue が猶予の中なら載せない', () => {
    const events: PrOptions['events'] = [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', 10 * MINUTE]]
    expect(waitingReasons(pr({ autoMerge: false, age: 5 * HOUR, events }), NOW)).toEqual([])
  })

  it('古い dequeue の後に auto-merge が戻っていれば載せない', () => {
    const events: PrOptions['events'] = [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', HOUR]]
    expect(waitingReasons(pr({ age: 5 * HOUR, events }), NOW)).toEqual([])
  })

  it('force push で 24 時間の時計が戻る', () => {
    expect(waitingReasons(pr({ rollup: 'PENDING', age: 72 * HOUR, events: [['HeadRefForcePushedEvent', HOUR]] }), NOW)).toEqual([])
  })

  it('猶予の中の競合は載せない', () => {
    expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 10 * MINUTE }), NOW)).toEqual([])
  })

  it('猶予を過ぎた競合は載せる', () => {
    expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR }), NOW)).toEqual(['conflict'])
  })

  it('base が進んだ直後の競合は載せない', () => {
    expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 5 * MINUTE }), NOW)).toEqual([])
  })

  it('mergeable が UNKNOWN なら理由にしない', () => {
    expect(waitingReasons(pr({ mergeable: 'UNKNOWN', age: 2 * HOUR }), NOW)).toEqual([])
  })

  it('最後の push の後に dequeue されていれば dequeued にする', () => {
    expect(waitingReasons(pr({ autoMerge: false, age: 2 * HOUR, events: [['RemovedFromMergeQueueEvent', 5 * MINUTE]] }), NOW)).toEqual(['dequeued'])
  })

  it('rebase の前の dequeue は、猶予を過ぎていれば no auto-merge にする', () => {
    const events: PrOptions['events'] = [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', HOUR]]
    expect(waitingReasons(pr({ autoMerge: false, age: 5 * HOUR, events }), NOW)).toEqual(['no auto-merge'])
  })

  it('猶予の中の auto-merge なしは載せない', () => {
    expect(waitingReasons(pr({ autoMerge: false, age: 10 * MINUTE, rollup: JSON_NULL }), NOW)).toEqual([])
  })

  it('猶予を過ぎた auto-merge なしは載せる', () => {
    expect(waitingReasons(pr({ autoMerge: false, age: HOUR }), NOW)).toEqual(['no auto-merge'])
  })

  it('merge queue に入っていれば載せない', () => {
    expect(waitingReasons(pr({ autoMerge: false, queue: true, age: HOUR }), NOW)).toEqual([])
  })

  it('検証の失敗と競合は両方載せる', () => {
    expect(waitingReasons(pr({ rollup: 'FAILURE', mergeable: 'CONFLICTING', age: 2 * HOUR }), NOW)).toEqual(['checks failed', 'conflict'])
  })

  it('作成時刻が読めなければ、理由を足さない', () => {
    expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: 'yesterday' }, NOW)).toEqual([])
  })

  it.for([
    { name: 'タイムゾーンが無い', value: '2026-11-09T00:00:00' },
    { name: '日付だけ', value: '2026-11-09' },
    { name: '存在しない日', value: '2026-02-30T00:00:00Z' },
    { name: '24 時', value: '2026-11-09T24:00:00Z' },
    { name: '秒が 60', value: '2026-11-09T00:00:60Z' },
    { name: 'オフセットが 24 時間', value: '2026-11-09T00:00:00+24:00' },
    { name: '末尾に改行', value: '2026-11-09T00:00:00Z\n' },
  ])('作成時刻が$name形だと、読めない時刻として扱う', ({ value }) => {
    expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: value }, NOW)).toEqual([])
  })

  it('オフセット付きの時刻は UTC に直して比べる', () => {
    // 2026-11-09T20:00:00+09:00 は 11:00Z で、NOW の 1 時間前
    expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: '2026-11-09T20:00:00+09:00' }, NOW)).toEqual(['no auto-merge'])
  })

  it('小数秒付きの時刻は、マイクロ秒までを読む', () => {
    const exactly = '2026-11-09T11:30:00.000000Z'
    const later = '2026-11-09T11:29:59.999999Z'
    expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: exactly }, NOW)).toEqual([])
    expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: later }, NOW)).toEqual(['no auto-merge'])
  })
})

describe('checksLabel と rollupState', () => {
  it.for([
    { state: 'SUCCESS', label: 'passed' },
    { state: 'FAILURE', label: 'failed' },
    { state: 'ERROR', label: 'failed' },
    { state: 'PENDING', label: 'pending' },
    { state: 'EXPECTED', label: 'pending' },
    { state: undefined, label: 'none' },
  ])('検証が $state なら $label にする', ({ state, label }) => {
    expect(checksLabel(state)).toBe(label)
  })

  it('最後の commit の検証の state を返す', () => {
    expect(rollupState(pr({ rollup: 'FAILURE' }))).toBe('FAILURE')
  })

  it.for([{ name: '検証が無い', node: pr({ rollup: JSON_NULL }) }, { name: 'commit が無い', node: {} }])('$name と、undefined を返す', ({ node }) => {
    expect(rollupState(node)).toBeUndefined()
  })
})

function entry(number: number, title = 'Bump a', ...reasons: readonly string[]): PrEntry {
  return { number, title, url: `https://github.com/o/r/pull/${String(number)}`, reasons: reasons.length > 0 ? reasons : ['major'], checks: 'failed' }
}

const OLD_FORM_BODY = [
  '<!-- pecot-dependabot-pr: tracker -->',
  '',
  '<!-- pecot-dependabot-pr: list-begin -->',
  '| PR | 待っている理由 |',
  '|---|---|',
  '| <!-- pecot-dependabot-pr: pr/120 --> [#120](https://github.com/o/r/pull/120) `build(repo): bump ajv from 6.15.0 to 8.20.0` | major |',
  '| <!-- pecot-dependabot-pr: pr/166 --> [#166](https://github.com/o/r/pull/166) `build(repo): bump jsdom from 29.1.1 to 31.0.0` | major |',
  '<!-- pecot-dependabot-pr: list-end -->',
].join('\n')

describe('Tracker の本文', () => {
  it('新しい本文は印と表を持つ', () => {
    expect(renderTrackerBody([entry(2, 'Bump a', 'major', 'conflict')])).toBe([
      '<!-- pecot-dependabot-pr: tracker -->',
      '',
      '<!-- pecot-dependabot-pr: list-begin -->',
      '## dependabot PR',
      '',
      '| title | PR | checks |',
      '|---|---|---|',
      '| <!-- pecot-dependabot-pr: pr/2 --> `Bump a` | [#2](https://github.com/o/r/pull/2) | failed |',
      '<!-- pecot-dependabot-pr: list-end -->',
      '',
    ].join('\n'))
  })

  it('scope 付きの題はメンションでなくコードスパンにする', () => {
    const body = renderTrackerBody([entry(4, 'Bump @vueuse/core from 1.0.0 to 1.1.0')])
    expect(body).toContain('`Bump @vueuse/core from 1.0.0 to 1.1.0`')
    expect(parseTrackerPullRequestNumbers(body)).toEqual([4])
  })

  it('題にバッククォートがあれば、囲いを長くする', () => {
    expect(renderTrackerBody([entry(4, 'Bump `@scope/pkg` | x')])).toContain('``Bump `@scope/pkg` \\| x``')
    expect(renderTrackerBody([entry(5, '`@scope/pkg`')])).toContain('`` `@scope/pkg` ``')
  })

  it('題の改行と前後の空白は 1 つの空白にする', () => {
    expect(renderTrackerBody([entry(6, '  a \r\n  b\nc  ')])).toContain('`a b c`')
  })

  it('書き出した本文から番号を番号順に読める', () => {
    const body = renderTrackerBody([entry(5), entry(2)])
    expect(parseTrackerPullRequestNumbers(body)).toEqual([2, 5])
  })

  it('一覧の外の文は残して、一覧だけを書き直す', () => {
    const existing = renderTrackerBody([entry(1)]).replace(LIST_END, () => `${LIST_END}\n\n人の注記`)
    const body = renderTrackerBody([entry(2)], existing)
    expect(body.endsWith('list-end -->\n\n人の注記\n')).toBe(true)
    expect(body).not.toContain('pr/1 ')
    expect(body).toContain('pr/2 ')
  })

  it('既存の本文の CRLF は LF にそろえて書き直す', () => {
    const existing = renderTrackerBody([entry(1)]).replaceAll('\n', '\r\n')
    expect(renderTrackerBody([entry(2)], existing)).not.toContain('\r')
  })

  it('題が表を壊すことはない', () => {
    const body = renderTrackerBody([entry(3, 'a | b <!-- pecot-dependabot-pr: pr/99 -->')])
    expect(parseTrackerPullRequestNumbers(body)).toEqual([3])
  })

  it('題に | とバッククォートがあっても、区切りは 4 つ', () => {
    const body = renderTrackerBody([entry(3, 'a | `b` | c')])
    const line = body.split('\n').find(candidate => candidate.includes('pr/3 ')) ?? ''
    expect(line.match(/(?<!\\)\|/gu)).toHaveLength(4)
  })

  it('空の一覧は none だけを書く', () => {
    const body = renderTrackerBody([])
    const begin = body.indexOf(LIST_BEGIN) + LIST_BEGIN.length
    expect(body.slice(begin, body.indexOf(LIST_END))).toBe('\n## dependabot PR\n\nnone\n')
    expect(parseTrackerPullRequestNumbers(body)).toEqual([])
  })

  it('前の形（2 列）の本文も読める', () => {
    expect(parseTrackerPullRequestNumbers(OLD_FORM_BODY)).toEqual([120, 166])
  })

  it('前の形の本文は、一覧の外の文を残して今の形に書き直す', () => {
    const body = renderTrackerBody([entry(120)], `${OLD_FORM_BODY}\n\n人の注記\n`)
    expect(body).toContain('| title | PR | checks |')
    expect(body).not.toContain('待っている理由')
    expect(body).not.toContain('pr/166 ')
    expect(body.endsWith('list-end -->\n\n人の注記\n')).toBe(true)
  })

  it('本文が無ければ、印が無いので DependabotPrError にする', () => {
    expect(() => parseTrackerPullRequestNumbers(undefined)).toThrow(DependabotPrError)
  })

  it.for(['no markers', `${LIST_END}\n${LIST_BEGIN}`, `${LIST_BEGIN}\n${LIST_BEGIN}\n${LIST_END}`])('印が 1 組でない本文 %j は、読みと書きの両方で DependabotPrError にする', (body) => {
    expect(() => parseTrackerPullRequestNumbers(body)).toThrow(DependabotPrError)
    expect(() => renderTrackerBody([], body)).toThrow(DependabotPrError)
  })

  it('表の行でない行の印は番号に数えない', () => {
    const body = `${LIST_BEGIN}\nnote <!-- pecot-dependabot-pr: pr/9 -->\n| <!-- pecot-dependabot-pr: pr/3 --> x |\n${LIST_END}`
    expect(parseTrackerPullRequestNumbers(body)).toEqual([3])
  })

  it('Tracker の印を持つ本文だけに TRACKER_PATTERN が合う', () => {
    expect(TRACKER_PATTERN.test(renderTrackerBody([]))).toBe(true)
    expect(TRACKER_PATTERN.test('none')).toBe(false)
  })

  it('題は立てた日を持つ', () => {
    expect(buildTrackerTitle('2026-11-09')).toBe('[Tracker] dependabot PR — 2026-11-09')
  })
})

describe('planTracker', () => {
  it('Tracker が無いとき、行があれば立てる', () => {
    const plan = planTracker([entry(1)], undefined)
    expect(plan.create).toBe(true)
    expect(plan.close).toBe(false)
    expect(plan.added.map(added => added.number)).toEqual([1])
  })

  it('Tracker が無く行も無ければ何もしない', () => {
    const plan = planTracker([], undefined)
    expect([plan.create, plan.close]).toEqual([false, false])
  })

  it('行の足し外しを番号順に出す', () => {
    const plan = planTracker([entry(3), entry(2)], [4, 1, 2])
    expect(plan.entries.map(row => row.number)).toEqual([2, 3])
    expect(plan.added.map(added => added.number)).toEqual([3])
    expect(plan.removed).toEqual([1, 4])
    expect([plan.create, plan.close]).toEqual([false, false])
  })

  it('Tracker があるとき、行が無ければ閉じる', () => {
    const plan = planTracker([], [1])
    expect(plan.close).toBe(true)
    expect(plan.removed).toEqual([1])
  })
})

function withType(type: string): string {
  return `x\n\n---\nupdated-dependencies:\n- dependency-name: a\n  update-type: ${type}\n...\n`
}

describe('parseUpdateMetadata の Python との細部', () => {
  it.for([
    { type: 'semver-semver-minor', expected: 'minor' },
    { type: 'foo-semver-major', expected: 'major' },
  ])('update-type が $type なら、最後の semver- より後ろを種類にする', ({ type, expected }) => {
    expect(parseUpdateMetadata(withType(type))).toEqual([['a', expected]])
  })

  it.for([
    { range: 'from v1.0 to 1.v1', expected: 'minor' },
    { range: 'from 1.0 to 1v.0', expected: 'patch' },
  ])('版 $range の v は、先頭でなくても最初の 1 つを除く', ({ range, expected }) => {
    const text = `Bumps [a] ${range}.\n\n---\nupdated-dependencies:\n- dependency-name: a\n...\n`
    expect(parseUpdateMetadata(text)).toEqual([['a', expected]])
  })
})
