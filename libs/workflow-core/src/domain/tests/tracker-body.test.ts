import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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

  it.for(rows)('セルを作成すると、$name', async ({ input, expected }) => {
    await explains('表のセルに入れる文字列を作成する関数のテストです。`|` や `<` の変換、改行と空白の整形、特殊な空白の扱いが、行ごとの期待どおりになることを確認します。')
    expect(cell(input)).toBe(expected)
  })
})

describe('listRegion', () => {
  it('印の組が 1 組なら、begin の直後と end の先頭を返す', async () => {
    await explains('Tracker の本文から一覧の範囲を求める関数のテストです。begin と end の印が 1 組の場合に、begin の直後の位置と end の先頭の位置を返すことを確認します。')
    const body = 'x<!-- begin -->mid<!-- end -->y'
    expect(listRegion(body, BEGIN, END, MarkerError)).toEqual({ begin: 15, end: 18 })
  })

  it('begin の直後に end が続く（間が空の）場合も、範囲を返す', async () => {
    await explains('Tracker の本文から一覧の範囲を求める関数のテストです。begin の直後に end が続く（間が空の）場合にも、範囲を返すことを確認します。')
    expect(listRegion('<!-- begin --><!-- end -->', BEGIN, END, MarkerError)).toEqual({ begin: 14, end: 14 })
  })

  const broken = [
    { name: 'begin が無い', body: 'a<!-- end -->' },
    { name: 'end が無い', body: '<!-- begin -->a' },
    { name: 'begin が 2 つある', body: '<!-- begin --><!-- begin --><!-- end -->' },
    { name: 'end が 2 つある', body: '<!-- begin --><!-- end --><!-- end -->' },
    { name: '順序が逆', body: '<!-- end --><!-- begin -->' },
  ]

  it.for(broken)('印の組が正しくない場合（$name）は、渡された型の例外が発生する', async ({ body }) => {
    await explains('Tracker の本文から一覧の範囲を求める関数のテストです。begin か end が存在しない場合、2 つある場合、順序が逆の場合に、指定した型の例外が発生することを確認します。')
    expect(() => listRegion(body, BEGIN, END, MarkerError)).toThrow(new MarkerError(MARKER_PAIR_MESSAGE))
  })
})

function issue(number: number, state = 'open', body = '<!-- tracker -->'): { number: number, state: string, body: string } {
  return { number, state, body }
}

describe('findTracker', () => {
  it('Issue が存在しない、または印を持たない本文だけの場合は、Tracker が存在しないものとして返す', async () => {
    await explains('Tracker の Issue を探す関数のテストです。Issue が存在しない場合と、印を持たない本文だけの場合に、Tracker が存在しないものとして返すことを確認します。')
    expect(findTracker([], TRACKER)).toEqual({ tracker: undefined, others: [] })
    expect(findTracker([issue(1, 'open', '関係ない')], TRACKER)).toEqual({ tracker: undefined, others: [] })
  })

  it('Issue が closed の場合は、Tracker が存在しないものとして扱う', async () => {
    await explains('Tracker の Issue を探す関数のテストです。Issue が closed の場合に、Tracker として扱わないことを確認します。')
    expect(findTracker([issue(1, 'closed')], TRACKER)).toEqual({ tracker: undefined, others: [] })
  })

  it('open が複数あると、番号が最小のものを使い、ほかの番号を返す', async () => {
    await explains('Tracker の Issue を探す関数のテストです。open の Issue が複数ある場合に、番号が最小のものを Tracker とし、残りの番号を `others` に返すことを確認します。')
    const found = findTracker([issue(9), issue(4), issue(6, 'closed'), issue(7)], TRACKER)
    expect(found).toEqual({ tracker: { number: 4, body: '<!-- tracker -->' }, others: [7, 9] })
  })

  it('オブジェクトでない要素と、本文や番号の型が誤っている要素は、無視する', async () => {
    await explains('Tracker の Issue を探す関数のテストです。オブジェクトでない要素と、本文や番号の型が誤っている要素を、無視して探すことを確認します。')
    const found = findTracker(['x', { state: 'open', number: 1, body: 5 }, { state: 'open', number: '2', body: '<!-- tracker -->' }, issue(3)], TRACKER)
    expect(found).toEqual({ tracker: { number: 3, body: '<!-- tracker -->' }, others: [] })
  })
})
