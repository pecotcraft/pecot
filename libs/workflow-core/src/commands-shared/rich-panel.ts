// 端末向けの枠付き表示。Python の CLI が使っていた表示ライブラリ（rich 15）の折り返し規則を写す。
//
// 規則は次のとおり。
//   - 単語は、前の空白・語・後ろの空白の並び。語が行に収まらなければ次の行へ送る。
//   - 1 行より長い語は、幅の単位で折る。
//   - 幅は端末のセル数で数える。幅の表は rich のもの（cell-table.ts）。
//   - 異体字セレクタ U+FE0F は、直前の文字を 2 セルにする場合がある。ゼロ幅接合子 U+200D は、次の文字を数えない。
import { splitCodePoints } from '../domain/python-format.js'
import { CELL_WIDTHS, NARROW_TO_WIDE } from './cell-table.js'

const ZERO_WIDTH_JOINER = '‍'
const VARIATION_SELECTOR_16 = '️'
const WHITESPACE = /^\s$/u
const NARROW_TO_WIDE_SET: ReadonlySet<number> = new Set(NARROW_TO_WIDE)
const LAST_RANGE_END = Math.max(...CELL_WIDTHS.map(([, end]) => end))

/**
先頭のコードポイント。空文字列は 0
*/
function codePointOf(character: string): number {
  /* v8 ignore next -- 呼び出し側は 1 文字以上を渡す */
  return character.codePointAt(0) ?? 0
}

/**
表の middle 番目の行。二分探索が範囲内の添字だけを渡す
*/
function tableEntry(index: number): readonly [number, number, number] {
  /* v8 ignore next -- 二分探索は範囲内の添字だけを渡す */
  return CELL_WIDTHS.at(index) ?? [0, 0, 1]
}

/**
index 番目の文字。範囲外は空文字列
*/
function characterAt(characters: readonly string[], index: number): string {
  /* v8 ignore next -- 呼び出し側は範囲内の添字を渡す */
  return characters.at(index) ?? ''
}

function characterCells(character: string): number {
  const code = codePointOf(character)
  if ((code > 0 && code < 32) || (code >= 0x7F && code < 0xA0)) return 0
  if (code > LAST_RANGE_END) return 1
  let low = 0
  let high = CELL_WIDTHS.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end, width] = tableEntry(middle)
    if (code < start) high = middle - 1
    else if (code > end) low = middle + 1
    else return width
  }
  return 1
}

function isSpecial(character: string): boolean {
  return character === ZERO_WIDTH_JOINER || character === VARIATION_SELECTOR_16
}

function cellLengthOf(characters: readonly string[]): number {
  if (characters.every(character => !isSpecial(character))) {
    return characters.reduce((total, character) => total + characterCells(character), 0)
  }
  let total = 0
  let lastMeasured: string | undefined
  for (let index = 0; index < characters.length; index += 1) {
    const character = characterAt(characters, index)
    if (character === ZERO_WIDTH_JOINER) {
      index += 1
    }
    else if (character === VARIATION_SELECTOR_16) {
      if (lastMeasured !== undefined) {
        total += NARROW_TO_WIDE_SET.has(codePointOf(lastMeasured)) ? 1 : 0
        lastMeasured = undefined
      }
    }
    else {
      const cells = characterCells(character)
      if (cells > 0) {
        lastMeasured = character
        total += cells
      }
    }
  }
  return total
}

/**
端末のセル数
*/
export function cellLength(text: string): number {
  return cellLengthOf(splitCodePoints(text))
}

interface Span {
  readonly start: number
  readonly end: number
  readonly cells: number
}

/**
文字を字素ごとの範囲に分ける。ゼロ幅の文字は直前の字素に付ける
*/
function splitGraphemes(characters: readonly string[]): readonly Span[] {
  const spans: Span[] = []
  let lastMeasured: string | undefined
  let index = 0
  while (index < characters.length) {
    const character = characterAt(characters, index)
    const previous = spans.at(-1)
    if (isSpecial(character)) {
      if (previous === undefined) {
        spans.push({ start: index, end: index + 1, cells: 0 })
        index += 1
      }
      else if (character === ZERO_WIDTH_JOINER) {
        index += index < characters.length - 1 ? 2 : 1
        spans[spans.length - 1] = { ...previous, end: index }
      }
      else {
        index += 1
        let cells = previous.cells
        if (lastMeasured !== undefined && NARROW_TO_WIDE_SET.has(codePointOf(lastMeasured))) {
          lastMeasured = undefined
          cells += 1
        }
        spans[spans.length - 1] = { ...previous, end: index, cells }
      }
      continue
    }
    const cells = characterCells(character)
    if (cells > 0) {
      lastMeasured = character
      spans.push({ start: index, end: index + 1, cells })
    }
    else if (previous === undefined) {
      spans.push({ start: index, end: index + 1, cells: 0 })
    }
    else {
      spans[spans.length - 1] = { ...previous, end: index + 1 }
    }
    index += 1
  }
  return spans
}

/**
行を幅の単位で折る。幅に収まらない字素は次の行へ送る
*/
function chopCells(characters: readonly string[], width: number): readonly (readonly string[])[] {
  const lines: (readonly string[])[] = []
  let lineSize = 0
  let lineOffset = 0
  for (const { start, cells } of splitGraphemes(characters)) {
    if (lineSize + cells > width) {
      lines.push(characters.slice(lineOffset, start))
      lineOffset = start
      lineSize = 0
    }
    lineSize += cells
  }
  if (lineSize > 0) lines.push(characters.slice(lineOffset))
  return lines
}

/**
先頭から cells セル分を残す。字素の途中で切れるときは、半端な 1 セルを空白にする
*/
function keepCells(characters: readonly string[], cells: number): readonly string[] {
  if (cells <= 0) return []
  const spans = splitGraphemes(characters)
  let left = 0
  for (const span of spans) {
    if (left + span.cells > cells) {
      const rest = cells - left
      return [...characters.slice(0, span.start), ...Array.from({ length: rest }, () => ' ')]
    }
    left += span.cells
    if (left === cells) return characters.slice(0, span.end)
  }
  return characters
}

function truncateCells(characters: readonly string[], width: number): readonly string[] {
  return cellLengthOf(characters) <= width ? characters : keepCells(characters, width)
}

function isSpaceAt(characters: readonly string[], index: number): boolean {
  return WHITESPACE.test(characterAt(characters, index))
}

interface Word {
  readonly start: number
  readonly end: number
  /**
  後ろの空白を除いた終端
  */
  readonly bodyEnd: number
}

function nextWord(characters: readonly string[], start: number): Word | undefined {
  let index = start
  while (index < characters.length && isSpaceAt(characters, index)) index += 1
  if (index >= characters.length) return undefined
  while (index < characters.length && !isSpaceAt(characters, index)) index += 1
  const bodyEnd = index
  while (index < characters.length && isSpaceAt(characters, index)) index += 1
  return { start, end: index, bodyEnd }
}

/**
折り返す位置（文字の添字）を返す。長すぎる語は幅の単位で折る
*/
function divideLine(characters: readonly string[], width: number): readonly number[] {
  const breaks: number[] = []
  let cellOffset = 0
  let word = nextWord(characters, 0)
  while (word !== undefined) {
    const { start, end, bodyEnd } = word
    const wordLength = cellLengthOf(characters.slice(start, bodyEnd))
    const wholeWord = characters.slice(start, end)
    if (width - cellOffset >= wordLength) {
      cellOffset += cellLengthOf(wholeWord)
    }
    else if (wordLength > width) {
      const pieces = chopCells(wholeWord, width)
      let position = start
      for (const [pieceIndex, piece] of pieces.entries()) {
        if (position > 0) breaks.push(position)
        if (pieceIndex === pieces.length - 1) cellOffset = cellLengthOf(piece)
        else position += piece.length
      }
    }
    else if (cellOffset > 0) {
      breaks.push(start)
      cellOffset = cellLengthOf(wholeWord)
    }
    word = nextWord(characters, end)
  }
  return breaks
}

/**
行がコードポイント数で幅を超えるとき、超えた分だけ末尾の空白を落とす
*/
function stripExcessWhitespace(characters: readonly string[], width: number): readonly string[] {
  if (characters.length <= width) return characters
  let whitespace = 0
  while (whitespace < characters.length && isSpaceAt(characters, characters.length - 1 - whitespace)) whitespace += 1
  return characters.slice(0, characters.length - Math.min(whitespace, characters.length - width))
}

/**
幅に収まるように折り返した行を返す。短い行を空白で埋めはしない。
入力の改行はそのまま行の区切りにする。長すぎる語は幅の単位で折る
*/
export function wrapText(text: string, width: number): readonly string[] {
  return text.split('\n').flatMap((line) => {
    const characters = splitCodePoints(line)
    const offsets = [0, ...divideLine(characters, width), characters.length]
    return offsets.slice(0, -1).map((from, index) => {
      const piece = characters.slice(from, offsets.at(index + 1))
      return truncateCells(stripExcessWhitespace(piece, width), width).join('')
    })
  })
}

/**
行を幅のセル数まで空白で埋める
*/
export function padCells(line: string, width: number): string {
  return `${line}${' '.repeat(Math.max(0, width - cellLength(line)))}`
}

const MIN_WIDTH = 10
const DEFAULT_WIDTH = 80

function isDigits(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/u.test(value)
}

/**
枠の幅。typer と rich に合わせた順で決める。TERMINAL_WIDTH、COLUMNS、端末の幅、無ければ 80
*/
export function outputWidth(environment: Readonly<Record<string, string | undefined>>, terminalColumns: number | undefined): number {
  const terminalWidth = environment['TERMINAL_WIDTH']
  const columns = environment['COLUMNS']
  let width = DEFAULT_WIDTH
  if (isDigits(terminalWidth) && Number(terminalWidth) > 0) width = Number(terminalWidth)
  else if (isDigits(columns) && Number(columns) > 0) width = Number(columns)
  else if (terminalColumns !== undefined && terminalColumns > 0) width = terminalColumns
  return Math.max(MIN_WIDTH, width)
}

/**
枠付きの表示。左上にタイトルを置く。lines は枠の内側の幅に収まっている行。末尾は改行で終わる
*/
function framePanel(title: string, lines: readonly string[], width: number): string {
  const inner = width - 4
  const titleText = ` ${title} `
  const top = `╭─${titleText}${'─'.repeat(Math.max(0, width - 3 - cellLength(titleText)))}╮`
  const body = lines.map(line => `│ ${padCells(line, inner)} │`)
  return `${[top, ...body, `╰${'─'.repeat(width - 2)}╯`].join('\n')}\n`
}

/**
枠付きの表示。本文は幅に合わせて折り返す。末尾は改行で終わる
*/
export function renderPanel(title: string, body: string, width: number): string {
  return framePanel(title, wrapText(body, width - 4), width)
}
