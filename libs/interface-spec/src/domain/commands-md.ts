import type { GeneratedEntry, GeneratedFile } from './schema.js'
import { compareText } from './utility.js'

export const OTHER_GROUP = 'その他'

interface Row {
  readonly path: readonly string[]
  readonly description: string
}

function escapeCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('<', String.raw`\<`)
}

function toRow(entry: Readonly<GeneratedEntry>): Row | undefined {
  const cli = entry.surfaces.cli
  if (cli === undefined || entry.hidden) return undefined
  return { path: cli.path, description: escapeCell(entry.description) + (entry.deprecated ? '（非推奨）' : '') }
}

function renderTable(rows: readonly Row[]): string[] {
  const sorted = rows.toSorted((left, right) => compareText(left.path.join(' '), right.path.join(' ')))
  return [
    '| コマンド | 説明 |',
    '| --- | --- |',
    ...sorted.map(row => `| \`${row.path.join(' ')}\` | ${row.description} |`),
  ]
}

// generated.json の CLI の面から commands.md を作る。regenerate は、1 行目のコメントに書く作り直すコマンド。
export function renderCommandsMd(file: Readonly<GeneratedFile>, regenerate: string): string {
  const rows = file.entries.map(entry => toRow(entry)).filter(row => row !== undefined)
  const nested = rows.filter(row => row.path.length > 1)
  const others = rows.filter(row => row.path.length < 2)
  const heads = [...new Set(nested.map(row => row.path[0] ?? ''))].toSorted(compareText)
  const sections = heads.map((head): [string, Row[]] => [head, nested.filter(row => row.path[0] === head)])
  if (others.length > 0) sections.push([OTHER_GROUP, others])
  const lines = [
    `<!-- このファイルは生成物です。手で直さず、\`${regenerate}\` で作り直してください。 -->`,
    '',
    '# コマンド一覧',
    '',
    '引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。',
  ]
  for (const [name, section] of sections) lines.push('', `## ${name}`, '', ...renderTable(section))
  return `${lines.join('\n')}\n`
}
