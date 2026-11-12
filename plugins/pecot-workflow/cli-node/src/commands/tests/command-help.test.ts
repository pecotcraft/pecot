import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { AuthoredNotes } from '../../infra/authored-notes.js'
import { commandHelpText, helpSynopsisOf } from '../command-help.js'
import { defineCommand } from '../registry.js'
import { cellLength } from '../rich-panel.js'
import { exitWith } from './support.js'

const STRINGS = z.array(z.string())

const demo = defineCommand({
  path: ['demo', 'run'],
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
  positional: ['target', 'extras'],
  shortFlags: { limit: '-l', verbose: '-V' },
  aliases: { mode: '--speed' },
  negations: { color: '--no-color' },
  interactive: false,
  run: async () => await exitWith(0),
})

const withRepository = defineCommand({
  path: ['own'],
  description: 'Has its own repo',
  input: z.object({ repo: z.string().describe('Repository to use'), item: z.string().optional().describe('An item') }),
  hasOwnRepo: true,
  positional: [],
  interactive: false,
  run: async () => await exitWith(0),
})

const bare = defineCommand({
  path: ['bare'],
  description: 'Does nothing',
  input: z.object({}),
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

describe('helpSynopsisOf', () => {
  it('位置引数を、必須なら <名前>、任意なら [名前] で出し、複数なら ... を付ける', () => {
    expect(helpSynopsisOf(demo)).toBe('[OPTIONS] <target> [extras]...')
    expect(helpSynopsisOf(bare)).toBe('[OPTIONS]')
  })
})

describe('commandHelpText', () => {
  it('節は Usage・説明・Arguments・Options・Constraints・Details・Examples の順', () => {
    const lines = linesOf(80)
    const headings = lines.filter(line => /^[A-Z][a-z]+:/u.test(line)).map(line => line.split(':', 1)[0])
    expect(headings).toEqual(['Usage', 'Arguments', 'Options', 'Constraints', 'Details', 'Examples'])
    expect(lines[0]).toBe('Usage: pecot demo run [OPTIONS] <target> [extras]...')
    expect(lines[2]).toBe('Run the demo')
  })

  it('Arguments は位置引数の順に並べ、必須には [required] を付ける', () => {
    const lines = linesOf(80)
    const start = lines.indexOf('Arguments:')
    expect(lines.slice(start, start + 3)).toEqual([
      'Arguments:',
      '  <target>     Target to run [required]',
      '  [extras]...  Extra names',
    ])
  })

  it('Options は定義の順に、短い形・長い形・別名・否定形の順で名前を並べ、値を取るものに型を付ける', () => {
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

  it('説明の末尾に [repeatable]・[required]・[default: …]・範囲を付ける', () => {
    const text = commandHelpText(demo, notes, 120)
    expect(text).toContain('Speed of the run [default: fast]')
    expect(text).toContain('Maximum count [default: 5] [0<=x<=20]')
    expect(text).toContain('Lower bound [x>=1]')
    expect(text).toContain('Upper bound [x<=9]')
    expect(text).toContain('Tag to put on the result [repeatable]')
    expect(text).toContain('A value that must be given [required]')
  })

  it('真偽値は、初期値が真で否定形を持つものだけ [default: …] を出す', () => {
    const text = commandHelpText(demo, notes, 120)
    expect(text).toContain('Colored output [default: color]')
    expect(text).toMatch(/Print more$/mu)
    expect(text).not.toContain('Print more [')
  })

  it('説明の無い引数は名前だけの行にする（行末の空白なし）', () => {
    const line = linesOf(80).find(entry => entry.includes('--nodesc'))
    expect(line).toBe('  --nodesc <str>')
  })

  it('自分の --repo を持つコマンドの repo は Options に出し、[required] を付けない', () => {
    const text = commandHelpText(withRepository, undefined, 80)
    expect(text).toContain('--repo <str>  Repository to use\n')
    expect(text).not.toContain('[required]')
    expect(text).toContain('--item <str>')
  })

  it('グローバルの --repo は、自分の repo を持たないコマンドの Options に出さない', () => {
    expect(commandHelpText(demo, notes, 80)).not.toContain('--repo')
  })

  it('Constraints は文にする。requires は ... requires ... and ...、conflicts は ... cannot be used together', () => {
    const lines = linesOf(80)
    const start = lines.indexOf('Constraints:')
    expect(lines.slice(start + 1, start + 5)).toEqual([
      '  - --tag requires <target> and --verbose',
      '  - --least requires --most',
      '  - --file and --screenshot cannot be used together',
      '  - <target>, --file and --screenshot cannot be used together',
    ])
  })

  it('Details は - の箇条書きで全項目を出し、続きの行を 4 桁下げる', () => {
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

  it('Examples は打つ形を折り返さず、説明を字下げ 6 で出す', () => {
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

  it('notes が undefined なら Constraints・Details・Examples を出さない', () => {
    const text = commandHelpText(demo, undefined, 80)
    expect(text).not.toContain('Constraints:')
    expect(text).not.toContain('Details:')
    expect(text).not.toContain('Examples:')
    expect(text).toContain('Options:')
  })

  it('中身の無い節は出さない（引数が無ければ Arguments も出さない）', () => {
    const text = commandHelpText(bare, { details: [], constraints: [], examples: [] }, 80)
    expect(text).toBe('Usage: pecot bare [OPTIONS]\n\nDoes nothing\n\nOptions:\n  --help  Show this message and exit.\n')
  })

  it('幅 40 では、名前の列を取ると説明が 32 桁を切る節で、説明を次の行に下げる', () => {
    const lines = linesOf(40)
    const start = lines.indexOf('Options:')
    expect(lines.slice(start + 1, start + 5)).toEqual([
      '  --mode, --speed <fast|slow>',
      '      Speed of the run [default: fast]',
      '  -l, --limit <int>',
      '      Maximum count [default: 5]',
    ])
  })

  it('Examples の打つ形の行を除いて、どの行も幅を超えない', () => {
    for (const width of [40, 60, 80, 120]) {
      const over = linesOf(width).filter(line => cellLength(line) > width)
      expect(over.every(line => line.startsWith('  pecot demo run'))).toBe(true)
    }
  })

  it('行末に空白を残さない', () => {
    for (const width of [40, 80]) expect(commandHelpText(demo, notes, width)).not.toMatch(/ $/mu)
  })

  it('全角の説明も、幅で数えて折り返す', () => {
    const wide = defineCommand({
      path: ['wide'],
      description: '全角の説明を持つコマンド。幅が狭くても折り返して表示します。',
      input: z.object({ name: z.string().describe('名前をここに書いてください。長い説明は折り返されます。') }),
      positional: ['name'],
      interactive: false,
      run: async () => await exitWith(0),
    })
    const lines = commandHelpText(wide, undefined, 40).split('\n')
    expect(lines.every(line => cellLength(line) <= 40)).toBe(true)
    expect(lines.join('')).toContain('名前をここに')
  })
})
