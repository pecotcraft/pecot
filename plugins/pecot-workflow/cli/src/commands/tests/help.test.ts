import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { helpText } from '../help.js'
import { cellLength } from '@pecot/workflow-core/commands-shared/rich-panel.js'
import { defineCommand } from '../registry.js'
import type { CommandDefinition } from '../registry.js'
import { exitWith } from './support.js'

function define(path: readonly string[], description: string): CommandDefinition {
  return defineCommand({
    path,
    title: 'Test command',
    description,
    input: z.object({}),
    output: z.strictObject({}),
    positional: [],
    interactive: false,
    run: async () => await exitWith(0),
  })
}

// グループのコマンドの間に単独のコマンドを置いても、単独のコマンドが先、グループが後（登録順）に並ぶ
const commands = [
  define(['issue', 'read'], 'Read an Issue'),
  define(['project', 'list'], 'List projects'),
  define(['branch-create'], 'Create a branch linked to an Issue (shown in the Development section of the Issue)'),
  define(['issue', 'comment'], 'Post a comment on an Issue'),
  define(['issue-status-update'], 'Update the status of an Issue'),
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
  branch-create        Create a branch linked to an Issue (shown in the
                       Development section of the Issue)
  issue-status-update  Update the status of an Issue
  issue                Work with Issues
  project              Connect to projects and manage the project config

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
  branch-create
      Create a branch linked to an Issue
      (shown in the Development section
      of the Issue)
  issue-status-update
      Update the status of an Issue
  issue
      Work with Issues
  project
      Connect to projects and manage the
      project config

Run 'pecot COMMAND --help' for the
arguments and options of a command.
`

describe('helpText', () => {
  it('ルートのヘルプは、Usage・説明・Options・Commands の順に、枠なしの 2 列で並べ、末尾に案内を 1 行付ける', async () => {
    await explains('ルートのヘルプ（`helpText`）のテストです。幅 80 の場合に、`Usage`・説明・`Options`・`Commands` の順に枠のない 2 列で並べ、末尾に `pecot COMMAND --help` の案内を 1 行付けることを確認します。')
    expect(helpText([], commands, 80)).toBe(ROOT_80)
  })

  it('幅が 40 より狭い場合は、幅 40 として表示する', async () => {
    await explains('ヘルプの幅の最小値のテストです。ルートとグループのどちらでも、幅に `5` や `1` を指定した場合に、幅 `40` で表示した結果と同じになることを確認します。')
    expect(helpText([], commands, 5)).toBe(helpText([], commands, 40))
    expect(helpText(['issue'], commands, 1)).toBe(helpText(['issue'], commands, 40))
  })

  it('幅を指定しない場合は、幅 80 として表示する', async () => {
    await explains('幅を省略した `helpText` のテストです。幅 `80` を指定した場合と同じ結果になることを確認します。')
    expect(helpText([], commands)).toBe(ROOT_80)
  })

  it('単独のコマンドを先、グループを後に並べ、補完のオプションは表示しない', async () => {
    await explains('ルートのヘルプの `Commands` の並び順のテストです。単独のコマンドがグループより先に並び、`completion` に関するオプションが表示されないことを確認します。')
    const text = helpText([], commands, 80)
    expect(text.indexOf('issue-status-update')).toBeLessThan(text.indexOf('  project '))
    expect(text.indexOf('  issue ')).toBeLessThan(text.indexOf('  project '))
    expect(text).not.toContain('completion')
  })

  it('グループのヘルプは、Usage・説明・Options・Commands の順に並べ、末尾の案内の行は付けない', async () => {
    await explains('グループ `issue` のヘルプのテストです。`Usage`・説明・`Options`・`Commands` の順に並び、ルートにある末尾の案内の行は付かないことを確認します。')
    expect(helpText(['issue'], commands, 80)).toBe(GROUP_80)
  })

  // COMMANDS の全グループが説明を持つことは、tests/help-definition.test.ts が見る
  it('説明が存在しないグループは、説明の段落を表示しない', async () => {
    await explains('説明を持たないグループ `custom` のヘルプのテストです。説明の段落を表示せず、`Usage`・`Options`・`Commands` だけを表示することを確認します。')
    const text = helpText(['custom'], [define(['custom', 'run'], 'Run it')], 80)
    expect(text).toBe('Usage: pecot custom [OPTIONS] COMMAND [ARGS]...\n\nOptions:\n  --help  Show this message and exit.\n\nCommands:\n  run  Run it\n')
  })

  it('Commands の一覧で、説明が存在しないグループは、名前だけの行にする', async () => {
    await explains('説明を持たないグループを含むルートのヘルプのテストです。`Commands` の一覧で、そのグループが説明を付けずに名前だけの行になることを確認します。')
    const text = helpText([], [define(['custom', 'run'], 'Run it')], 80)
    expect(text).toContain('Commands:\n  custom\n')
  })

  it('コマンドの説明の文にあるバッククォートの引数名は、Commands の行でフラグの形にする', async () => {
    await explains('コマンドの説明の文に、バッククォートで囲んだ入力名を含む場合のテストです。`Commands` の行で、入力名の `repo` が `--repo` の形で表示され、`owner/repo` は変換されないことを確認します。')
    const text = helpText(['custom'], [define(['custom', 'run'], 'Run it in `repo`, not `owner/repo`')], 80)
    expect(text).toContain('  run  Run it in `--repo`, not `owner/repo`\n')
  })

  it('コマンドが存在しない場合は、Commands の節を表示しない', async () => {
    await explains('コマンドを 1 つも持たないルートのヘルプのテストです。`Commands` の節を表示せず、`Options` の節は表示することを確認します。')
    const text = helpText([], [], 80)
    expect(text).not.toContain('Commands:')
    expect(text).toContain('Options:')
  })

  it('幅が広い場合は、説明を折り返さず 1 行に表示する', async () => {
    await explains('幅 120 で表示したルートのヘルプのテストです。長い説明も折り返さず、コマンド名と同じ 1 行に表示することを確認します。')
    const lines = helpText([], commands, 120).split('\n')
    expect(lines).toContain('  branch-create        Create a branch linked to an Issue (shown in the Development section of the Issue)')
  })

  it('幅 40 の場合は、節のすべての項目で説明を次の行（6 桁字下げ）に表示する', async () => {
    await explains('幅 40 で表示したルートのヘルプのテストです。`Options` と `Commands` のすべての項目で、説明を名前の次の行に 6 桁字下げして表示することを確認します。')
    expect(helpText([], commands, 40)).toBe(ROOT_40)
  })

  it('罫線を使わず、行末に空白を含めない', async () => {
    await explains('幅を 20・40・80・120 に変えたルートのヘルプのテストです。罫線の文字（`╭`・`│`・`╰`）を含まず、行末に空白が残らないことを確認します。')
    for (const width of [20, 40, 80, 120]) {
      const text = helpText([], commands, width)
      expect(text).not.toMatch(/[╭│╰]/u)
      expect(text).not.toMatch(/ $/mu)
    }
  })

  it('全角文字の説明も、幅で数えて折り返し、どの行も幅を超えない', async () => {
    await explains('全角文字の説明を持つコマンドのヘルプのテストです。幅 40 の場合に、全角文字を 2 桁として数えて折り返し、どの行も 40 桁以内で、文字が欠けないことを確認します。')
    const lines = helpText([], [define(['long'], 'あ'.repeat(60))], 40).split('\n')
    const wrapped = lines.filter(line => line.includes('あ'))
    expect(wrapped.map(line => cellLength(line))).toEqual([40, 40, 40, 8 + 24])
    expect(wrapped.join('').replaceAll(' ', '')).toBe(`long${'あ'.repeat(60)}`)
  })
})
