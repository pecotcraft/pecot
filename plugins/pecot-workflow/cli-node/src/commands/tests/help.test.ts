import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { helpText } from '../help.js'
import { cellLength } from '../rich-panel.js'
import { defineCommand } from '../registry.js'
import type { CommandDefinition } from '../registry.js'
import { exitWith } from './support.js'

function define(path: readonly string[], description: string): CommandDefinition {
  return defineCommand({
    path,
    description,
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await exitWith(0),
  })
}

// グループのコマンドの間に単独のコマンドを置いても、単独のコマンドが先、グループが後（登録順）に並ぶ
const commands = [
  define(['issue', 'read'], 'Read an Issue'),
  define(['project', 'list'], 'List projects'),
  define(['create-branch'], 'Create a branch linked to an Issue (shown in the Development section of the Issue)'),
  define(['issue', 'comment'], 'Post a comment on an Issue'),
  define(['update-issue-status'], 'Update the status of an Issue'),
]

const ROOT_80 = `Usage: pecot [OPTIONS] COMMAND [ARGS]...

pecot-workflow CLI - work tracking on GitHub Projects

Options:
  -v, --version        Show the version
  --repo <owner/repo>  Target repository, given explicitly as 'owner/repo'
  --show-repo          Show the resolved repository and where it came from, then
                       exit
  --help               Show this message and exit.

Commands:
  create-branch        Create a branch linked to an Issue (shown in the
                       Development section of the Issue)
  update-issue-status  Update the status of an Issue
  issue                Work with Issues
  project              Manage projects through the GitHub API

Run 'pecot COMMAND --help' for the arguments and options of a command.
`

const GROUP_80 = `Usage: pecot issue [OPTIONS] COMMAND [ARGS]...

Work with Issues

Options:
  --help  Show this message and exit.

Commands:
  read     Read an Issue
  comment  Post a comment on an Issue
`

const ROOT_40 = `Usage: pecot [OPTIONS] COMMAND [ARGS]...

pecot-workflow CLI - work tracking on
GitHub Projects

Options:
  -v, --version
      Show the version
  --repo <owner/repo>
      Target repository, given
      explicitly as 'owner/repo'
  --show-repo
      Show the resolved repository and
      where it came from, then exit
  --help
      Show this message and exit.

Commands:
  create-branch
      Create a branch linked to an Issue
      (shown in the Development section
      of the Issue)
  update-issue-status
      Update the status of an Issue
  issue
      Work with Issues
  project
      Manage projects through the GitHub
      API

Run 'pecot COMMAND --help' for the
arguments and options of a command.
`

describe('helpText', () => {
  it('ルートは Usage・説明・Options・Commands の順で、枠なしの 2 列に並べ、末尾に案内を 1 行付ける', () => {
    expect(helpText([], commands, 80)).toBe(ROOT_80)
  })

  it('既定の幅は 80', () => {
    expect(helpText([], commands)).toBe(ROOT_80)
  })

  it('単独のコマンドが先、グループが後に並ぶ。補完のオプションは出さない', () => {
    const text = helpText([], commands, 80)
    expect(text.indexOf('update-issue-status')).toBeLessThan(text.indexOf('  project '))
    expect(text.indexOf('  issue ')).toBeLessThan(text.indexOf('  project '))
    expect(text).not.toContain('completion')
  })

  it('グループは Usage・説明・Options・Commands の順で、案内の行は付かない', () => {
    expect(helpText(['issue'], commands, 80)).toBe(GROUP_80)
  })

  it('説明を持たないグループは、説明の段落を出さない', () => {
    const text = helpText(['custom'], [define(['custom', 'run'], 'Run it')], 80)
    expect(text).toBe('Usage: pecot custom [OPTIONS] COMMAND [ARGS]...\n\nOptions:\n  --help  Show this message and exit.\n\nCommands:\n  run  Run it\n')
  })

  it('一覧のグループの説明が無ければ、名前だけの行にする', () => {
    const text = helpText([], [define(['custom', 'run'], 'Run it')], 80)
    expect(text).toContain('Commands:\n  custom\n')
  })

  it('コマンドが無ければ Commands の節を出さない', () => {
    const text = helpText([], [], 80)
    expect(text).not.toContain('Commands:')
    expect(text).toContain('Options:')
  })

  it('広い端末では説明が折り返さず 1 行に収まる', () => {
    const lines = helpText([], commands, 120).split('\n')
    expect(lines).toContain('  create-branch        Create a branch linked to an Issue (shown in the Development section of the Issue)')
  })

  it('狭い端末（40）では、節の全行で説明を次の行（字下げ 6）に下げる', () => {
    expect(helpText([], commands, 40)).toBe(ROOT_40)
  })

  it('罫線を使わず、行末の空白もない', () => {
    for (const width of [20, 40, 80, 120]) {
      const text = helpText([], commands, width)
      expect(text).not.toMatch(/[╭│╰]/u)
      expect(text).not.toMatch(/ $/mu)
    }
  })

  it('どの行も幅を超えない（全角の説明も、幅で数えて折り返す）', () => {
    const lines = helpText([], [define(['long'], 'あ'.repeat(60))], 40).split('\n')
    const wrapped = lines.filter(line => line.includes('あ'))
    expect(wrapped.map(line => cellLength(line))).toEqual([40, 40, 40, 8 + 24])
    expect(wrapped.join('').replaceAll(' ', '')).toBe(`long${'あ'.repeat(60)}`)
  })
})
