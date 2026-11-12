// help の共通の書式。枠を使わず、「見出し + 字下げした 2 列」で並べる。
// どの関数も、行を改行でつないだ文字列を返す（末尾の改行は付けない）。
import { cellLength, padCells, wrapText as wrapCells } from './rich-panel.js'

/**
help の幅の下限。これより狭い端末でも、Usage と名前の列が崩れないように 40 桁で組む
*/
const MIN_HELP_WIDTH = 40

/**
端末の幅から help を組む幅を返す。誤りの枠（rich-panel.ts の MIN_WIDTH）の下限は別
*/
export function helpWidth(columns: number): number {
  return Math.max(MIN_HELP_WIDTH, columns)
}

/**
2 列の節の 1 行。name は打つ形、description は説明（空でもよい）
*/
export interface DefinitionRow {
  readonly name: string
  readonly description: string
}

/**
全部の help の Options に並ぶ --help の行
*/
export const HELP_OPTION: DefinitionRow = { name: '--help', description: 'Show this message and exit.' }

const INDENT = 2
const COLUMN_GAP = 2
const BULLET_CONTINUATION = 4
const USAGE_CONTINUATION = 7
const WRAPPED_DESCRIPTION_INDENT = 6

/**
説明の幅がこの桁を切るなら、節の全行で説明を次の行に下げる
*/
const MIN_DESCRIPTION_WIDTH = 32

/**
幅より長い語を、`/` の後ろで折れる塊に分ける。塊は幅まで詰め、1 つの塊が幅を超えるものだけ、後段の wrapText が幅で折る
*/
function chunksOfLongWord(word: string, width: number): readonly string[] {
  const chunks: string[] = []
  for (const segment of word.split(/(?<=\/)/u)) {
    const last = chunks.at(-1)
    if (last !== undefined && cellLength(last) + cellLength(segment) <= width) chunks[chunks.length - 1] = `${last}${segment}`
    else chunks.push(segment)
  }
  return chunks
}

/**
行の中の、幅より長い語を `/` の後ろで折る。幅より長い語は必ず新しい行から始まる（wrapText と同じ）ので、その前に改行を入れ、塊ごとに行を分ける。後ろの語は最後の塊の行に続く。
`/` を持たない語は、そのまま後段の wrapText が幅で折る
*/
function breakLongWords(line: string, width: number): string {
  const parts = line.split(/(\s+)/u)
  return parts.map((part, index) => {
    if (part.trim() === '' || cellLength(part) <= width || !part.includes('/')) return part
    const hasTextBefore = parts.slice(0, index).join('').trim() !== ''
    return `${hasTextBefore ? '\n' : ''}${chunksOfLongWord(part, width).join('\n')}`
  }).join('')
}

/**
幅で折り返す。幅より長い語は `/` の後ろを折れる位置として扱い、それでも入らない塊だけを幅で折る。
wrapText は折り返した行に空白を残すことがあるので、行末の空白を落とす
*/
function wrapText(text: string, width: number): readonly string[] {
  return wrapCells(text.split('\n').map(line => breakLongWords(line, width)).join('\n'), width).map(line => line.trimEnd())
}

function indentOf(count: number): string {
  return ' '.repeat(count)
}

/**
名前と説明の組を 2 列で並べる。名前の列は「字下げ 2 + 最長の名前 + 間 2」で取る。
説明の幅が 32 桁を切るときは、節の全行で名前だけの行の次に、字下げ 6 の説明を置く。行ごとには切り替えない（列がそろわなくなる）
*/
export function definitionSection(title: string, rows: readonly DefinitionRow[], width: number): string {
  const nameWidth = Math.max(0, ...rows.map(row => cellLength(row.name)))
  const descriptionWidth = width - INDENT - nameWidth - COLUMN_GAP
  const isStacked = descriptionWidth < MIN_DESCRIPTION_WIDTH
  const lines = rows.flatMap(row => isStacked ? stackedLines(row, width) : columnLines(row, nameWidth, descriptionWidth))
  return [`${title}:`, ...lines].join('\n')
}

function columnLines(row: DefinitionRow, nameWidth: number, descriptionWidth: number): readonly string[] {
  const prefix = indentOf(INDENT)
  const continuation = indentOf(INDENT + nameWidth + COLUMN_GAP)
  return wrapText(row.description, descriptionWidth).map((line, index) => {
    const head = index === 0 ? `${prefix}${padCells(row.name, nameWidth + COLUMN_GAP)}` : continuation
    return `${head}${line}`.trimEnd()
  })
}

function stackedLines(row: DefinitionRow, width: number): readonly string[] {
  const nameLines = wrapText(row.name, width - INDENT).map(line => `${indentOf(INDENT)}${line}`)
  const descriptionLines = row.description === '' ? [] : wrapText(row.description, width - WRAPPED_DESCRIPTION_INDENT).map(line => `${indentOf(WRAPPED_DESCRIPTION_INDENT)}${line}`)
  return [...nameLines, ...descriptionLines]
}

/**
`Usage: ` の後ろを折り返す。続きの行は 7 桁下げる
*/
export function usageLines(text: string, width: number): string {
  return wrapText(text, width - USAGE_CONTINUATION).map((line, index) => index === 0 ? `Usage: ${line}` : `${indentOf(USAGE_CONTINUATION)}${line}`).join('\n')
}

/**
見出しの無い段落。幅で折り返す
*/
export function paragraph(text: string, width: number): string {
  return wrapText(text, width).join('\n')
}

/**
`- ` の箇条書きの節。続きの行は 4 桁下げる
*/
export function bulletSection(title: string, items: readonly string[], width: number): string {
  const lines = items.flatMap(item => wrapText(item, width - BULLET_CONTINUATION).map((line, index) => (index === 0 ? `${indentOf(INDENT)}- ${line}` : `${indentOf(BULLET_CONTINUATION)}${line}`).trimEnd()))
  return [`${title}:`, ...lines].join('\n')
}

/**
例の節。打つ形の行は、コピーして打てるように折り返さない。1 行の説明は字下げ 6 で折り返す
*/
export function examplesSection(examples: readonly Readonly<{ run: string, note: string }>[], width: number): string {
  const lines = examples.flatMap(example => [
    `${indentOf(INDENT)}${example.run}`.trimEnd(),
    ...example.note === '' ? [] : wrapText(example.note, width - WRAPPED_DESCRIPTION_INDENT).map(line => `${indentOf(WRAPPED_DESCRIPTION_INDENT)}${line}`),
  ])
  return ['Examples:', ...lines].join('\n')
}
