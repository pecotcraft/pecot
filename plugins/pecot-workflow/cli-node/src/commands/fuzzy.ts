// 近い語の候補。Python の difflib.get_close_matches（n=3、cutoff=0.6）を写す。
// click の `Possible options` と `Did you mean` の元になる。
import { splitCodePoints } from '../domain/python-format.js'

const MAX_MATCHES = 3
const CUTOFF = 0.6

interface Match {
  readonly aStart: number
  readonly bStart: number
  readonly size: number
}

/**
b の各文字が現れる位置
*/
function indexPositions(characters: readonly string[]): ReadonlyMap<string, readonly number[]> {
  const positions = new Map<string, number[]>()
  for (const [index, character] of characters.entries()) {
    positions.set(character, [...positions.get(character) ?? [], index])
  }
  return positions
}

/**
a の aStart 以上 aEnd 未満、b の bStart 以上 bEnd 未満で、最長の一致を探す。同じ長さなら a で最初、次に b で最初のもの
*/
function longestMatch(
  a: readonly string[],
  positions: ReadonlyMap<string, readonly number[]>,
  range: Readonly<{ aStart: number, aEnd: number, bStart: number, bEnd: number }>,
): Match {
  let best: Match = { aStart: range.aStart, bStart: range.bStart, size: 0 }
  let previous = new Map<number, number>()
  for (let index = range.aStart; index < range.aEnd; index += 1) {
    const current = new Map<number, number>()
    const candidates = (positions.get(a.at(index) ?? '') ?? []).filter(position => position >= range.bStart && position < range.bEnd)
    for (const position of candidates) {
      const size = (previous.get(position - 1) ?? 0) + 1
      current.set(position, size)
      if (size > best.size) best = { aStart: index - size + 1, bStart: position - size + 1, size }
    }
    previous = current
  }
  return best
}

/**
SequenceMatcher.ratio() と同じ。2 * 一致した文字数 / 全文字数
*/
function ratio(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length
  if (total === 0) return 1
  const positions = indexPositions(b)
  const queue = [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }]
  let matched = 0
  for (let range = queue.pop(); range !== undefined; range = queue.pop()) {
    const match = longestMatch(a, positions, range)
    if (match.size === 0) continue
    matched += match.size
    if (range.aStart < match.aStart && range.bStart < match.bStart) {
      queue.push({ ...range, aEnd: match.aStart, bEnd: match.bStart })
    }
    const aAfter = match.aStart + match.size
    const bAfter = match.bStart + match.size
    if (aAfter < range.aEnd && bAfter < range.bEnd) queue.push({ ...range, aStart: aAfter, bStart: bAfter })
  }
  return (2 * matched) / total
}

/**
word に近い候補を、近い順に最大 3 件返す。近さが同じなら、文字列の大きい方が先。
Python の heapq.nlargest が (近さ, 候補) の組で比べるため
*/
export function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function closeMatches(word: string, possibilities: readonly string[]): readonly string[] {
  const wordCharacters = splitCodePoints(word)
  const scored = possibilities
    .map(candidate => ({ candidate, score: ratio(splitCodePoints(candidate), wordCharacters) }))
    .filter(entry => entry.score >= CUTOFF)
  const ordered = scored.toSorted((left, right) => {
    return left.score === right.score ? compareCodePoints(right.candidate, left.candidate) : right.score - left.score
  })
  return ordered.slice(0, MAX_MATCHES).map(entry => entry.candidate)
}
