import type { GeneratedEntry, GeneratedFile } from './schema.js'
import { compareText } from './utility.js'

export const OTHER_GROUP = 'その他'

interface Row {
  readonly words: readonly string[]
  readonly tool: string
  readonly description: string
}

function escapeCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('<', String.raw`\<`)
}

function toRow(entry: Readonly<GeneratedEntry>, separator: string): Row | undefined {
  const mcp = entry.surfaces.mcp
  if (mcp === undefined || entry.hidden) return undefined
  return { words: entry.name.split(separator), tool: mcp.tool, description: escapeCell(entry.description) + (entry.deprecated ? '（非推奨）' : '') }
}

function renderTable(rows: readonly Row[]): string[] {
  const sorted = rows.toSorted((left, right) => compareText(left.tool, right.tool))
  return [
    '| ツール | 説明 |',
    '| --- | --- |',
    ...sorted.map(row => `| \`${row.tool}\` | ${row.description} |`),
  ]
}

// generated.json の MCP の面から commands.md を作る。見出しは名前の最初の語。regenerate は、1 行目のコメントに書く作り直すコマンド。
export function renderCommandsMd(file: Readonly<GeneratedFile>, regenerate: string): string {
  const rows = file.entries.map(entry => toRow(entry, file.names.separator)).filter(row => row !== undefined)
  const nested = rows.filter(row => row.words.length > 1)
  const others = rows.filter(row => row.words.length < 2)
  const heads = [...new Set(nested.map(row => row.words[0] ?? ''))].toSorted(compareText)
  const sections = heads.map((head): [string, Row[]] => [head, nested.filter(row => row.words[0] === head)])
  if (others.length > 0) sections.push([OTHER_GROUP, others])
  const lines = [
    `<!-- このファイルは生成物です。手で直さず、\`${regenerate}\` で作り直してください。 -->`,
    '',
    '# ツール一覧',
    '',
    '入力と詳しい振る舞いは、MCP のツールの定義（tools/list）で確かめてください。',
  ]
  for (const [name, section] of sections) lines.push('', `## ${name}`, '', ...renderTable(section))
  return `${lines.join('\n')}\n`
}
