// help の共通の書式。枠を使わず、「見出し + 字下げした 2 列」で並べる。
// ルート・グループ・コマンドの 3 種類の help が、ここの関数で節を作る。
// どの関数も、行を改行でつないだ文字列を返す（末尾の改行は付けない）。
import { cellLength, padCells, wrapText as wrapCells } from './rich-panel.js'

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
幅で折り返す。wrapText は折り返した行に空白を残すことがあるので、行末の空白を落とす
*/
function wrapText(text: string, width: number): readonly string[] {
  return wrapCells(text, width).map(line => line.trimEnd())
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
  const lines = items.flatMap(item => wrapText(item, width - BULLET_CONTINUATION).map((line, index) => index === 0 ? `${indentOf(INDENT)}- ${line}` : `${indentOf(BULLET_CONTINUATION)}${line}`))
  return [`${title}:`, ...lines].join('\n')
}

/**
例の節。打つ形の行は、コピーして打てるように折り返さない。1 行の説明は字下げ 6 で折り返す
*/
export function examplesSection(examples: readonly Readonly<{ run: string, note: string }>[], width: number): string {
  const lines = examples.flatMap(example => [
    `${indentOf(INDENT)}${example.run}`,
    ...wrapText(example.note, width - WRAPPED_DESCRIPTION_INDENT).map(line => `${indentOf(WRAPPED_DESCRIPTION_INDENT)}${line}`),
  ])
  return ['Examples:', ...lines].join('\n')
}
