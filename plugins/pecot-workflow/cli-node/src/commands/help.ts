/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
// ルートとグループの説明。Python の CLI（typer）が rich で出していた枠付きの書式を写す。
//
// 表の幅は、各列の最大のセル数に列の間の空白 2 を足したもの。説明の列が残りを取る。
// 端末が狭く、説明の列が足りなくなるときの、rich の列の縮め方は写していない。
import type { CommandDefinition } from './registry.js'
import { cellLength, framePanel, padCells, wrapText } from './rich-panel.js'

export const PROGRAM_DESCRIPTION = 'pecot-workflow CLI - work tracking on GitHub Projects'

const GROUP_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['project', 'Manage projects through the GitHub API'],
  ['issue', 'Work with Issues'],
  ['pr', 'Work with PRs'],
  ['session', 'Manage the session'],
  ['release', 'Work with releases'],
  ['security', 'Put security alerts into a Tracker'],
  ['dependabot', 'Put Dependabot PRs waiting for a human decision into a Tracker'],
  ['worktree', 'Work with worktrees'],
])

/**
オプションの表の 1 行。列は rich の表と同じ並び。長い形、短い形、否定の長い形、否定の短い形、型、説明の順
*/
interface OptionRow {
  readonly cells: readonly [string, string, string, string, string]
  readonly help: string
}

function optionRow(long: string, short: string, metavar: string, help: string): OptionRow {
  return { cells: [long, short, '', '', metavar], help }
}

const HELP_ROW = optionRow('--help', '', '', 'Show this message and exit.')

const ROOT_OPTION_ROWS: readonly OptionRow[] = [
  optionRow('--version', '-v', '', 'Show the version'),
  optionRow('--repo', '', '<str>', 'Target repository, given explicitly as \'owner/repo\''),
  optionRow('--show-repo', '', '', 'Show the resolved repository and where it came from, then exit'),
  optionRow('--install-completion', '', '', 'Install completion for the current shell.'),
  optionRow('--show-completion', '', '', 'Show completion for the current shell, to copy it or customize the installation.'),
  HELP_ROW,
]

const COLUMN_GAP = 2

/**
表の行を、説明を折り返して並べる。最後の列が説明で、残りの幅を取る
*/
function tableLines(rows: readonly (readonly [readonly string[], string])[], inner: number): readonly string[] {
  const columnCount = Math.max(0, ...rows.map(([cells]) => cells.length))
  const widths = Array.from({ length: columnCount }, (_, column) => Math.max(0, ...rows.map(([cells]) => cellLength(cells.slice(column, column + 1).join('')))))
  const fixed = widths.reduce((total, width) => total + width + COLUMN_GAP, 0)
  const helpWidth = Math.max(1, inner - fixed)
  return rows.flatMap(([cells, help]) => {
    const prefix = cells.map((cell, column) => padCells(cell, Math.max(0, ...widths.slice(column, column + 1)) + COLUMN_GAP)).join('')
    const helpLines = wrapText(help, helpWidth, 'ellipsis')
    return helpLines.map((line, index) => index === 0 ? `${prefix}${line}` : `${' '.repeat(fixed)}${line}`)
  })
}

interface Entry {
  readonly name: string
  readonly description: string
}

/**
path の直下のコマンドとグループ。単独のコマンドが先、グループが後で、それぞれ登録順
*/
function entriesOf(path: readonly string[], commands: readonly CommandDefinition[]): readonly Entry[] {
  const level = path.length
  const direct = commands.filter(command => command.path.length === level + 1 && path.every((segment, index) => command.path.at(index) === segment))
  const groups = commands
    .filter(command => command.path.length > level + 1 && path.every((segment, index) => command.path.at(index) === segment))
    .map(command => command.path.slice(level, level + 1).join(''))
  return [
    ...direct.map(command => ({ name: command.path.slice(level, level + 1).join(''), description: command.description })),
    ...[...new Set(groups)].map(name => ({ name, description: GROUP_DESCRIPTIONS.get(name) ?? '' })),
  ]
}

function paddedLines(text: string, width: number): readonly string[] {
  return wrapText(text, width - 2).map(line => ` ${padCells(line, width - 2)} `)
}

/**
path のグループ（空ならルート）の説明。用法、説明、オプションの枠、コマンドの枠の順。
末尾は枠の改行で終わる。--help ではこの後ろに空行が付く
*/
export function helpText(path: readonly string[], commands: readonly CommandDefinition[], width = 80): string {
  const blank = ' '.repeat(width)
  const description = path.length === 0 ? PROGRAM_DESCRIPTION : GROUP_DESCRIPTIONS.get(path.slice(0, 1).join('')) ?? ''
  const usage = ['pecot', ...path, '[OPTIONS] COMMAND [ARGS]...'].join(' ')
  const header = [
    blank,
    ...paddedLines(`Usage: ${usage}`, width),
    blank,
    ...description === '' ? [] : [...paddedLines(description, width), blank],
  ]
  const inner = width - 4
  const optionRows = path.length === 0 ? ROOT_OPTION_ROWS : [HELP_ROW]
  const options = framePanel('Options', tableLines(optionRows.map(row => [row.cells, row.help]), inner), width)
  const entries = entriesOf(path, commands)
  const commandRows = entries.map((entry): readonly [readonly string[], string] => [[entry.name], entry.description])
  const commandsPanel = entries.length === 0 ? '' : framePanel('Commands', tableLines(commandRows, inner), width)
  return `${header.join('\n')}\n${options}${commandsPanel}`
}
