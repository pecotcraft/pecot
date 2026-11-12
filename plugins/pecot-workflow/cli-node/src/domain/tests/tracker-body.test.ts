import { describe, expect, it } from 'vitest'

import { PecotError } from '../errors.js'
import { cell, findTracker, listRegion, MARKER_PAIR_MESSAGE } from '../tracker-body.js'

class MarkerError extends PecotError {}

const BEGIN = /<!-- begin -->/gu
const END = /<!-- end -->/gu
const TRACKER = /<!-- tracker -->/u

describe('cell', () => {
  const rows = [
    { name: '`|` と `<` を無害にする', input: 'a | b <c>', expected: String.raw`a \| b &lt;c>` },
    { name: '前後の空白と改行を落とし、途中の改行を 1 つの空白にする', input: ' a\r\n b ', expected: 'a b' },
    { name: '改行を含む空白の連なりを 1 つの空白にする', input: 'a \t \n\n b', expected: 'a b' },
    { name: 'NBSP と全角の空白も、改行の前後なら取り込む', input: 'a\u{A0}\n\u{3000}b', expected: 'a b' },
    { name: '改行の無い NBSP は残す', input: 'a\u{A0}b', expected: 'a\u{A0}b' },
    { name: 'U+2028 は改行として扱わない', input: 'a\u{2028}b', expected: 'a\u{2028}b' },
    { name: 'U+FEFF は空白として扱わない', input: 'x\u{FEFF}\ny', expected: 'x\u{FEFF} y' },
    { name: 'U+200B は空白として扱わない', input: '\u{200B}\nq', expected: '\u{200B} q' },
    { name: 'U+001C〜U+001F と U+0085 は空白として扱う', input: '\u{1C}\n\u{1D}z\u{85}', expected: 'z' },
  ]

  it.for(rows)('$name と、期待の文にする', ({ input, expected }) => {
    expect(cell(input)).toBe(expected)
  })
})

describe('listRegion', () => {
  it('印の組が 1 組なら、begin の直後と end の先頭を返す', () => {
    const body = 'x<!-- begin -->mid<!-- end -->y'
    expect(listRegion(body, BEGIN, END, MarkerError)).toEqual({ begin: 15, end: 18 })
  })

  it('begin の直後に end が続く（間が空の）ときも受ける', () => {
    expect(listRegion('<!-- begin --><!-- end -->', BEGIN, END, MarkerError)).toEqual({ begin: 14, end: 14 })
  })

  const broken = [
    { name: 'begin が無い', body: 'a<!-- end -->' },
    { name: 'end が無い', body: '<!-- begin -->a' },
    { name: 'begin が 2 つある', body: '<!-- begin --><!-- begin --><!-- end -->' },
    { name: 'end が 2 つある', body: '<!-- begin --><!-- end --><!-- end -->' },
    { name: '順序が逆', body: '<!-- end --><!-- begin -->' },
  ]

  it.for(broken)('$name と、渡された型のエラーを投げる', ({ body }) => {
    expect(() => listRegion(body, BEGIN, END, MarkerError)).toThrow(new MarkerError(MARKER_PAIR_MESSAGE))
  })
})

function issue(number: number, state = 'open', body = '<!-- tracker -->'): { number: number, state: string, body: string } {
  return { number, state, body }
}

describe('findTracker', () => {
  it('Issue が無い、または印の無い本文だけなら、Tracker は無い', () => {
    expect(findTracker([], TRACKER)).toEqual({ tracker: undefined, others: [] })
    expect(findTracker([issue(1, 'open', '関係ない')], TRACKER)).toEqual({ tracker: undefined, others: [] })
  })

  it('closed の Tracker は無いものとして扱う', () => {
    expect(findTracker([issue(1, 'closed')], TRACKER)).toEqual({ tracker: undefined, others: [] })
  })

  it('open が複数あると、番号が最小のものを使い、ほかの番号を返す', () => {
    const found = findTracker([issue(9), issue(4), issue(6, 'closed'), issue(7)], TRACKER)
    expect(found).toEqual({ tracker: { number: 4, body: '<!-- tracker -->' }, others: [7, 9] })
  })

  it('オブジェクトでない要素と、本文・番号の型が違う要素は読み捨てる', () => {
    const found = findTracker(['x', { state: 'open', number: 1, body: 5 }, { state: 'open', number: '2', body: '<!-- tracker -->' }, issue(3)], TRACKER)
    expect(found).toEqual({ tracker: { number: 3, body: '<!-- tracker -->' }, others: [] })
  })
})
