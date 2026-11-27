import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import type { AuthoredNotes } from '../../infra/authored-notes.js'
import { cliTextOf, commandHelpText } from '../command-help.js'
import { defineCommand } from '../registry.js'
import { cellLength } from '@pecot/workflow-core/commands-shared/rich-panel.js'
import { ATTRIBUTES_INPUT, exitWith } from './support.js'

const STRINGS = z.array(z.string())

const demo = defineCommand({
  path: ['demo', 'run'],
  title: 'Test command',
  description: 'Run the demo',
  input: z.object({
    target: z.string().describe('Target to run'),
    extras: STRINGS.optional().describe('Extra names'),
    mode: z.enum(['fast', 'slow']).default('fast').describe('Speed of the run'),
    limit: z.int().min(0).max(20).default(5).describe('Maximum count'),
    least: z.int().min(1).optional().describe('Lower bound'),
    most: z.int().max(9).optional().describe('Upper bound'),
    tag: STRINGS.optional().describe('Tag to put on the result'),
    verbose: z.boolean().default(false).describe('Print more'),
    color: z.boolean().default(true).describe('Colored output'),
    file: z.string().optional().describe('Path of a file'),
    screenshot: z.string().optional().describe('Path of a screenshot'),
    required_flag: z.string().describe('A value that must be given'),
    nodesc: z.string().optional(),
  }),
  output: z.strictObject({}),
  positional: ['target', 'extras'],
  shortFlags: { limit: '-l', verbose: '-V' },
  aliases: { mode: '--speed' },
  negations: { color: '--no-color' },
  interactive: false,
  run: async () => await exitWith(0),
})

const withRepository = defineCommand({
  path: ['own'],
  title: 'Test command',
  description: 'Has its own repo',
  input: z.object({ repo: z.string().describe('Repository to use'), item: z.string().optional().describe('An item') }),
  hasOwnRepo: true,
  output: z.strictObject({}),
  positional: [],
  interactive: false,
  run: async () => await exitWith(0),
})

const bare = defineCommand({
  path: ['bare'],
  title: 'Test command',
  description: 'Does nothing',
  input: z.object({}),
  output: z.strictObject({}),
  positional: [],
  interactive: false,
  run: async () => await exitWith(0),
})

const notes: AuthoredNotes = {
  details: ['Runs the demo.', 'A second detail that is long enough to wrap around the line when the width is narrow.'],
  constraints: [
    { requires: { tag: ['target', 'verbose'], least: ['most'] } },
    { conflicts: ['file', 'screenshot'] },
    { conflicts: ['target', 'file', 'screenshot'] },
  ],
  examples: [
    { run: 'pecot demo run alpha --limit 3', note: 'Run alpha with at most 3.' },
    { run: 'pecot demo run alpha beta gamma delta --limit 3 --speed slow --tag one --tag two', note: 'Run many names with a very long command line that must not wrap.' },
  ],
  defaultNotes: new Map(),
}

function linesOf(width: number): readonly string[] {
  return commandHelpText(demo, notes, width).split('\n')
}

/**
Options の節の、名前の列（2 列の左）
*/
function optionNames(lines: readonly string[]): readonly string[] {
  const start = lines.indexOf('Options:')
  const end = lines.indexOf('', start)
  return lines.slice(start + 1, end).filter(line => /^ {2}\S/u.test(line)).map(line => line.slice(2).split(/ {2,}/u, 1)[0] ?? '')
}

describe('Usage の行', () => {
  it('位置引数は、必須なら <名前>、任意なら [名前] で表示し、複数なら末尾に ... を付けた Usage の行を作成する', async () => {
    await explains('`--help` の先頭に表示する、`Usage` の行のテストです。必須の位置引数は `<target>`、任意の位置引数は `[extras]...` の形で表示し、位置引数がない場合は `Usage: pecot bare [OPTIONS]` になることを確認します。')
    expect(commandHelpText(demo, undefined, 80).split('\n', 1)[0]).toBe('Usage: pecot demo run [OPTIONS] <target> [extras]...')
    expect(commandHelpText(bare, undefined, 80).split('\n', 1)[0]).toBe('Usage: pecot bare [OPTIONS]')
  })
})

describe('commandHelpText', () => {
  it('ヘルプの節は、Usage・説明・Arguments・Options・Constraints・Details・Examples の順に表示する', async () => {
    await explains('コマンドのヘルプ（`commandHelpText`）の構成のテストです。補足情報を渡した場合に、`Usage` から `Examples` までの見出しが決まった順に並び、3 行目がコマンドの説明になることを確認します。')
    const lines = linesOf(80)
    const headings = lines.filter(line => /^[A-Z][a-z]+:/u.test(line)).map(line => line.split(':', 1)[0])
    expect(headings).toEqual(['Usage', 'Arguments', 'Options', 'Constraints', 'Details', 'Examples'])
    expect(lines[0]).toBe('Usage: pecot demo run [OPTIONS] <target> [extras]...')
    expect(lines[2]).toBe('Run the demo')
  })

  it('Arguments には位置引数を定義の順に並べ、必須の位置引数に [required] を付けて表示する', async () => {
    await explains('ヘルプの `Arguments` の節のテストです。位置引数が定義の順に並び、必須の `<target>` にだけ `[required]` が付くことを確認します。')
    const lines = linesOf(80)
    const start = lines.indexOf('Arguments:')
    expect(lines.slice(start, start + 3)).toEqual([
      'Arguments:',
      '  <target>     Target to run [required]',
      '  [extras]...  Extra names',
    ])
  })

  it('Options には、定義の順にオプション名を並べ、値を取るものには型を付けて表示する', async () => {
    await explains('ヘルプの `Options` の節のテストです。オプションが定義の順に並び、短い形・長い形・別名・否定形の順で名前を表示し、値を取るものに `<int>` や `<str>` などの型が付き、最後に `--help` が並ぶことを確認します。')
    expect(optionNames(linesOf(80))).toEqual([
      '--mode, --speed <fast|slow>',
      '-l, --limit <int>',
      '--least <int>',
      '--most <int>',
      '--tag <str>',
      '-V, --verbose',
      '--color, --no-color',
      '--file <str>',
      '--screenshot <str>',
      '--required-flag <str>',
      '--nodesc <str>',
      '--help',
    ])
  })

  it('オブジェクトの配列は、値の型を <json> にして、[repeatable] を付けて表示する', async () => {
    await explains('オブジェクトの配列を受け取る `--attributes` のヘルプのテストです。値の型が `<json>` になり、説明の末尾に `[repeatable]` が付くことを確認します。')
    const edit = defineCommand({
      path: ['issue', 'edit'],
      title: 'Test command',
      description: 'Edit attributes',
      input: z.object({ attributes: ATTRIBUTES_INPUT }),
      output: z.strictObject({}),
      positional: [],
      aliases: { attributes: '--attribute' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    const lines = commandHelpText(edit, undefined, 80).split('\n')
    expect(optionNames(lines)).toEqual(['--attributes, --attribute <json>', '--help'])
    expect(lines).toContain('  --attributes, --attribute <json>  Attributes to write [repeatable]')
  })

  it('説明の末尾に [repeatable]・[required]・[default: …]・範囲を付けて表示する', async () => {
    await explains('ヘルプの `Options` の説明のテストです。`[default: fast]` や `[0<=x<=20]`、`[x>=1]`、`[repeatable]`、`[required]` が、項目に応じて説明の末尾に付くことを確認します。')
    const text = commandHelpText(demo, notes, 120)
    expect(text).toContain('Speed of the run [default: fast]')
    expect(text).toContain('Maximum count [default: 5] [0<=x<=20]')
    expect(text).toContain('Lower bound [x>=1]')
    expect(text).toContain('Upper bound [x<=9]')
    expect(text).toContain('Tag to put on the result [repeatable]')
    expect(text).toContain('A value that must be given [required]')
  })

  it('真偽値のうち、初期値が true で否定形を持つものだけに [default: …] を表示する', async () => {
    await explains('ヘルプの真偽値のオプションのテストです。初期値が `true` で否定形を持つ `--color` には `[default: color]` を表示し、初期値が `false` の `--verbose` には何も付けないことを確認します。')
    const text = commandHelpText(demo, notes, 120)
    expect(text).toContain('Colored output [default: color]')
    expect(text).toMatch(/Print more$/mu)
    expect(text).not.toContain('Print more [')
  })

  it('説明が存在しない引数は、行末に空白を付けず、名前だけの行にする', async () => {
    await explains('説明を持たない `--nodesc` のヘルプのテストです。行が `  --nodesc <str>` だけになり、行末に空白が含まれないことを確認します。')
    const line = linesOf(80).find(entry => entry.includes('--nodesc'))
    expect(line).toBe('  --nodesc <str>')
  })

  it('hasOwnRepo を指定したコマンドの repo は、Options に表示し、[required] を付けない', async () => {
    await explains('`hasOwnRepo` を指定したコマンドのヘルプのテストです。入力の `repo` を `--repo <str>` として `Options` に表示し、`[required]` を付けないことを確認します。')
    const text = commandHelpText(withRepository, undefined, 80)
    expect(text).toContain('--repo <str>  Repository to use\n')
    expect(text).not.toContain('[required]')
    expect(text).toContain('--item <str>')
  })

  it('repo を持たないコマンドの Options には、グローバルの --repo を表示しない', async () => {
    await explains('`repo` を入力に持たないコマンドのヘルプのテストです。`Options` に `--repo` が含まれないことを確認します。')
    expect(commandHelpText(demo, notes, 80)).not.toContain('--repo')
  })

  it('Constraints には、requires を ... requires ...、conflicts を ... cannot be used together の文にして表示する', async () => {
    await explains('ヘルプの `Constraints` の節のテストです。`requires` と `conflicts` の制約を、`--file and --screenshot cannot be used together` のような英文で表示することを確認します。')
    const lines = linesOf(80)
    const start = lines.indexOf('Constraints:')
    expect(lines.slice(start + 1, start + 5)).toEqual([
      '  - --tag requires <target> and --verbose',
      '  - --least requires --most',
      '  - --file and --screenshot cannot be used together',
      '  - <target>, --file and --screenshot cannot be used together',
    ])
  })

  it('Details は - の箇条書きにして全項目を表示し、折り返した行を 4 桁字下げする', async () => {
    await explains('ヘルプの `Details` の節のテストです。幅 40 で表示した場合に、全項目を `- ` の箇条書きにし、折り返した続きの行を 4 桁字下げすることを確認します。')
    const lines = linesOf(40)
    const start = lines.indexOf('Details:')
    expect(lines.slice(start + 1, start + 8)).toEqual([
      '  - Runs the demo.',
      '  - A second detail that is long enough',
      '    to wrap around the line when the',
      '    width is narrow.',
      '',
      'Examples:',
      '  pecot demo run alpha --limit 3',
    ])
  })

  it('Examples は、実行するコマンドを折り返さず、説明を 6 桁字下げして表示する', async () => {
    await explains('ヘルプの `Examples` の節のテストです。幅 40 でも、実行するコマンドの行は折り返さず、説明は 6 桁字下げして折り返すことを確認します。')
    const lines = linesOf(40)
    const long = 'pecot demo run alpha beta gamma delta --limit 3 --speed slow --tag one --tag two'
    const start = lines.indexOf(`  ${long}`)
    expect(start).toBeGreaterThan(0)
    expect(lines.slice(start - 2, start + 3)).toEqual([
      '  pecot demo run alpha --limit 3',
      '      Run alpha with at most 3.',
      `  ${long}`,
      '      Run many names with a very long',
      '      command line that must not wrap.',
    ])
  })

  it('補足情報（notes）が undefined の場合は、Constraints・Details・Examples を表示しない', async () => {
    await explains('補足情報を渡さない場合のヘルプのテストです。`Constraints`・`Details`・`Examples` の節を表示せず、`Options` の節は表示することを確認します。')
    const text = commandHelpText(demo, undefined, 80)
    expect(text).not.toContain('Constraints:')
    expect(text).not.toContain('Details:')
    expect(text).not.toContain('Examples:')
    expect(text).toContain('Options:')
  })

  it('中身が存在しない節は表示しない（引数が存在しなければ Arguments も表示しない）', async () => {
    await explains('引数と補足情報を持たないコマンドのヘルプのテストです。`Arguments` などの節を省き、`Usage`・説明・`Options`（`--help` だけ）の文になることを確認します。')
    const text = commandHelpText(bare, { details: [], constraints: [], examples: [], defaultNotes: new Map() }, 80)
    expect(text).toBe('Usage: pecot bare [OPTIONS]\n\nDoes nothing\n\nOptions:\n  --help  Show this message and exit.\n')
  })

  it('幅 40 で、説明の幅が 32 桁を下回る項目は、説明を名前の次の行に表示する', async () => {
    await explains('幅 40 で表示した `Options` の節のテストです。名前の列を取ると説明の幅が不足する項目で、説明を名前の次の行に字下げして表示することを確認します。')
    const lines = linesOf(40)
    const start = lines.indexOf('Options:')
    expect(lines.slice(start + 1, start + 5)).toEqual([
      '  --mode, --speed <fast|slow>',
      '      Speed of the run [default: fast]',
      '  -l, --limit <int>',
      '      Maximum count [default: 5]',
    ])
  })

  it('Examples のコマンドの行を除いて、どの行も指定した幅を超えない', async () => {
    await explains('幅を 40・60・80・120 に変えて表示するテストです。`Examples` のコマンドの行を除き、どの行も指定した幅を超えないことを確認します。')
    for (const width of [40, 60, 80, 120]) {
      const over = linesOf(width).filter(line => cellLength(line) > width)
      expect(over.every(line => line.startsWith('  pecot demo run'))).toBe(true)
    }
  })

  it('行末に空白を含めずに表示する', async () => {
    await explains('幅 40 と 80 で表示したヘルプのテストです。どの行の末尾にも空白が含まれないことを確認します。')
    for (const width of [40, 80]) expect(commandHelpText(demo, notes, width)).not.toMatch(/ $/mu)
  })

  it('幅が 40 より狭い場合も、幅 40 として表示する', async () => {
    await explains('ヘルプの幅の最小値のテストです。幅に `1`・`5`・`20` を指定した場合に、幅 `40` で表示した結果と同じになることを確認します。')
    for (const width of [1, 5, 20]) expect(commandHelpText(demo, notes, width)).toBe(commandHelpText(demo, notes, 40))
  })

  it('全角文字の説明は、表示の幅で数えて折り返す', async () => {
    await explains('全角文字の説明を持つコマンドのヘルプのテストです。幅 40 で表示した場合に、全角文字を 2 桁として数え、どの行も 40 桁以内に折り返すことを確認します。')
    const wide = defineCommand({
      path: ['wide'],
      title: 'Test command',
      description: '全角の説明を持つコマンド。幅が狭くても折り返して表示します。',
      input: z.object({ name: z.string().describe('名前をここに書いてください。長い説明は折り返されます。') }),
      output: z.strictObject({}),
      positional: ['name'],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const lines = commandHelpText(wide, undefined, 40).split('\n')
    expect(lines.every(line => cellLength(line) <= 40)).toBe(true)
    expect(lines.join('')).toContain('名前をここに')
  })
})

describe('初期値の補足（default_notes）', () => {
  const withDefaultNotes: AuthoredNotes = {
    ...notes,
    defaultNotes: new Map([['limit', 'Counts above 20 are refused.'], ['target', 'The first target of the config.'], ['verbose', 'Only the first run prints more.']]),
  }

  it('説明の後ろに補足の文を続け、その後ろに [required] や [default: …] を表示する', async () => {
    await explains('初期値の補足（`defaultNotes`）を渡した場合のヘルプのテストです。説明の後ろに補足の文をそのまま続け、その後ろに `[required]` や `[default: 5]` などを表示することを確認します。')
    const text = commandHelpText(demo, withDefaultNotes, 200)
    expect(text).toContain('  <target>     Target to run The first target of the config. [required]\n')
    expect(text).toContain('Maximum count Counts above 20 are refused. [default: 5] [0<=x<=20]\n')
    expect(text).toMatch(/-V, --verbose +Print more Only the first run prints more\.\n/u)
  })

  it('補足が存在しない引数は、説明に何も続けずに表示する', async () => {
    await explains('初期値の補足を持たない `--least` のヘルプのテストです。説明が `Lower bound [x>=1]` のまま変わらないことを確認します。')
    expect(commandHelpText(demo, withDefaultNotes, 200)).toMatch(/--least <int> +Lower bound \[x>=1\]\n/u)
  })

  it('補足情報（notes）が undefined の場合は、初期値の補足を表示しない', async () => {
    await explains('補足情報を渡さない場合のヘルプのテストです。初期値の補足 `Counts above 20 are refused.` が表示されないことを確認します。')
    expect(commandHelpText(demo, undefined, 200)).not.toContain('Counts above 20')
  })
})

describe('未対応の zod のキー', () => {
  it('未対応の JSON Schema のキーを持つ入力は、握りつぶさずに TypeError を送出する', async () => {
    await explains('未対応の JSON Schema のキー `pattern` を持つ入力のヘルプのテストです。`odd: code: unsupported JSON Schema key pattern` のメッセージで `TypeError` が発生することを確認します。')
    const unsupported = defineCommand({
      path: ['odd'],
      title: 'Test command',
      description: 'Has a pattern',
      input: z.object({ code: z.string().regex(/^[a-z]+$/u).describe('Lowercase code') }),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(() => commandHelpText(unsupported, undefined, 80)).toThrow(TypeError)
    expect(() => commandHelpText(unsupported, undefined, 80)).toThrow('odd: code: unsupported JSON Schema key pattern')
  })
})

describe('選択肢の長いオプション', () => {
  const long = defineCommand({
    path: ['pick'],
    title: 'Test command',
    description: 'Pick a template',
    input: z.object({
      template: z.enum(['plan', 'merge-diff', 'review-findings', 'review-resolution']).optional().describe('Template type'),
      kind: z.enum(['task', 'bug']).optional().describe('Kind of the item'),
    }),
    output: z.strictObject({}),
    positional: [],
    interactive: false,
    run: async () => await exitWith(0),
  })

  it('選択肢の表記が 24 桁を超える場合は、型を <str> にして、説明の末尾に [choices: …] を表示する', async () => {
    await explains('選択肢の長い `--template` のヘルプのテストです。選択肢をすべて並べると 24 桁を超えるため、型を `<str>` にして、説明の末尾に `[choices: …]` として選択肢を表示することを確認します。')
    const text = commandHelpText(long, undefined, 120)
    expect(text).toContain('--template <str>   Template type [choices: plan, merge-diff, review-findings, review-resolution]')
  })

  it('選択肢の表記が 24 桁以内の場合は、型の位置に <a|b> の形で表示する', async () => {
    await explains('選択肢の短い `--kind` のヘルプのテストです。型の位置に `<task|bug>` を表示し、`[choices: …]` は付けないことを確認します。')
    const text = commandHelpText(long, undefined, 120)
    expect(text).toContain('--kind <task|bug>')
    expect(text).not.toContain('[choices: task')
  })
})

describe('cliTextOf', () => {
  it.for([
    { name: 'オプションの名前', text: 'Needs `required_flag`', expected: 'Needs `--required-flag`' },
    { name: '位置引数の名前', text: 'Unlike `target`', expected: 'Unlike `<target>`' },
    { name: 'グローバルの repo', text: 'Of `repo`', expected: 'Of `--repo`' },
    { name: '入力名でない語', text: 'As `owner/repo/N` or `N` or `unknown`', expected: 'As `owner/repo/N` or `N` or `unknown`' },
  ])('$name をバッククォートで囲むと、CLI で入力する形にする', async ({ text, expected }) => {
    await explains('説明の文の中の入力名を、CLI で入力する形に変換する `cliTextOf` のテストです。バッククォートで囲んだオプション名は `--required-flag`、位置引数名は `<target>`、グローバルの `repo` は `--repo` に変換し、入力名でない語は変換しないことを確認します。')
    expect(cliTextOf(demo, text)).toBe(expected)
  })

  it('コマンドの説明の文に含まれる入力名は、ヘルプの説明の段落でフラグの形にして表示する', async () => {
    await explains('コマンドの説明の文に `verbose` を含むコマンドのヘルプのテストです。説明の段落で、バッククォートで囲んだ入力名が `--verbose` の形で表示されることを確認します。')
    const described = defineCommand({ path: ['demo', 'say'], title: 'Test command', description: 'Run it with `verbose`', input: z.object({ verbose: z.boolean().default(false).describe('Print more') }), output: z.strictObject({}), positional: [], interactive: false, run: async () => await exitWith(0) })
    expect(commandHelpText(described, undefined, 80)).toContain('\n\nRun it with `--verbose`\n\n')
  })
})
