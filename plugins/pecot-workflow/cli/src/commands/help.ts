/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
// ルートとグループの説明。枠を使わず、コマンドごとの --help と同じ「見出し + 字下げした 2 列」の書式で出す（help-layout.ts）。
// 節は Usage、説明、Options、Commands の順。中身の無い節は出さない。
import { definitionSection, HELP_OPTION, helpWidth, paragraph, usageLines } from './help-layout.js'
import type { DefinitionRow } from './help-layout.js'
import type { CommandDefinition } from './registry.js'

export const PROGRAM_DESCRIPTION = 'pecot-workflow CLI - work tracking on GitHub Projects'

const GROUP_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['project', 'Manage projects through the GitHub API'],
  ['issue', 'Work with Issues'],
  ['pr', 'Work with PRs'],
  ['session', 'Manage the session'],
  ['release', 'Work with releases'],
  ['security', 'Put security alerts into a Tracker'],
  ['dependabot', 'Put Dependabot PRs waiting for a human decision into a Tracker'],
  ['board', 'Keep the board columns in line with the judgment'],
  ['worktree', 'Work with worktrees'],
])

const ROOT_OPTIONS: readonly DefinitionRow[] = [
  { name: '-v, --version', description: 'Show the version' },
  { name: '--repo <owner/repo>', description: 'Target repository, given explicitly as \'owner/repo\'' },
  { name: '--show-repo', description: 'Show the resolved repository and where it came from, then exit' },
  HELP_OPTION,
]

const ROOT_FOOTER = 'Run \'pecot COMMAND --help\' for the arguments and options of a command.'

/**
path の直下のコマンドとグループ。単独のコマンドが先、グループが後で、それぞれ登録順
*/
function entriesOf(path: readonly string[], commands: readonly CommandDefinition[]): readonly DefinitionRow[] {
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

/**
path のグループ（空ならルート）の説明。Usage、説明、Options、Commands の順で、ルートだけ末尾に 1 行の案内が付く。
末尾は改行で終わる。幅は 40 を下限にする。--help と引数なしの呼び出しは、どちらもこの文字列をそのまま出す
*/
export function helpText(path: readonly string[], commands: readonly CommandDefinition[], columns = 80): string {
  const width = helpWidth(columns)
  const isRoot = path.length === 0
  const description = isRoot ? PROGRAM_DESCRIPTION : GROUP_DESCRIPTIONS.get(path.slice(0, 1).join('')) ?? ''
  const entries = entriesOf(path, commands)
  const sections = [
    usageLines(['pecot', ...path, '[OPTIONS] COMMAND [ARGS]...'].join(' '), width),
    ...description === '' ? [] : [paragraph(description, width)],
    definitionSection('Options', isRoot ? ROOT_OPTIONS : [HELP_OPTION], width),
    ...entries.length === 0 ? [] : [definitionSection('Commands', entries, width)],
    ...isRoot ? [paragraph(ROOT_FOOTER, width)] : [],
  ]
  return `${sections.join('\n\n')}\n`
}
