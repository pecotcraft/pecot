/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時ファイルと定義書 */
// cli の書き出しの形と、--check / --write の動きを確かめる。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { authoredFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { COMMANDS } from '../src/commands/registry.js'
import { defineCommand, type CommandIo } from '../src/commands/registry.js'
import { compareText } from '../../../../libs/interface-spec/src/domain/utility.js'
import { collectVerifiedIds, missingIds } from './_helpers/behavior-ids.js'
import { makeTemporaryDirectory, writeTree } from '../src/tests/_helpers/temporary.js'
import vitestConfig from '../vitest.config.js'
import { exportEntries, exportNames, main } from '../scripts/export-interface.js'
import { COMMAND_GROUPS, COMMAND_VERBS } from '../src/commands/names.js'

const alpha = defineCommand({
  path: ['alpha'],
  description: 'Greet someone',
  input: z.strictObject({
    name: z.string().describe('Name to greet.'),
    count: z.int().default(3).describe('How many times.'),
    json: z.boolean().default(false).describe('Print JSON.'),
    mode: z.enum(['fast', 'slow']).default('fast').describe('Mode.'),
    verbose: z.boolean().default(true).describe('Be loud.'),
  }),
  positional: ['name'],
  shortFlags: { count: '-c', json: '-j' },
  negations: { verbose: '--no-verbose' },
  run: () => Promise.resolve(0),
  interactive: false,
})

const strings = z.array(z.string())

const beta = defineCommand({
  path: ['beta'],
  description: 'Read files.',
  input: z.strictObject({
    source: z.string().optional().describe('Optional source.'),
    files: strings.optional().describe('Files to read.'),
    label: strings.optional().describe('Labels.'),
    limit: z.int().min(1).max(10).default(5).describe('Upper limit.'),
  }),
  positional: ['source', 'files'],
  shortFlags: { label: '-l' },
  run: () => Promise.resolve(0),
  interactive: false,
})

function capture(): { io: CommandIo, out: string[], error: string[] } {
  const out: string[] = []
  const error: string[] = []
  const io: CommandIo = {
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      error.push(text)
    },
  }
  return { io, out, error }
}

const samples = [alpha, beta]

const SAMPLE_NAMES = exportNames([{ name: 'alpha', meaning: '見本のグループ' }], [{ name: 'show', meaning: '見本の読む動詞', readOnly: true }, { name: 'add', meaning: '見本の書く動詞' }])

describe('exportNames', () => {
  it('区切りは空白で、語の位置はグループと動詞の 2 つ。後ろに自由な語を許さない', () => {
    const names = exportNames()
    expect(names.separator).toBe(' ')
    expect(names.rest).toBe(false)
    expect(names.positions.map(words => words.map(item => item.word))).toStrictEqual([COMMAND_GROUPS.map(group => group.name), COMMAND_VERBS.map(verb => verb.name)])
  })

  it('読むだけの動詞（list・search・show・get・check）にだけ read_only を付ける', () => {
    const marked = exportNames().positions.flat().filter(item => item.read_only === true).map(item => item.word)
    expect(marked).toStrictEqual(['list', 'search', 'show', 'get', 'check'])
  })

  it('語と意味だけを書き、グループの help は書かない', () => {
    expect(SAMPLE_NAMES.positions).toStrictEqual([
      [{ word: 'alpha', meaning: '見本のグループ' }],
      [{ word: 'show', meaning: '見本の読む動詞', read_only: true }, { word: 'add', meaning: '見本の書く動詞' }],
    ])
  })
})

describe('exportEntries', () => {
  const entries = exportEntries([beta, alpha])

  it('見本の書き出し全体が node-sample.json と同じバイト列になる', () => {
    const file = { format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: SAMPLE_NAMES, entries: exportEntries(samples) }
    const expected = readFileSync(path.resolve(import.meta.dirname, 'interface-export/node-sample.json'), 'utf8')
    expect(`${JSON.stringify(file, undefined, 2)}\n`).toBe(expected)
  })

  it('項目は id の順に並ぶ', () => {
    expect(entries.map(entry => entry.id)).toStrictEqual(['PW-ALPHA', 'PW-BETA'])
  })

  it('surfaces は cli.path と mcp.tool の両方を持つ', () => {
    expect(entries.map(entry => entry.surfaces)).toStrictEqual([
      { cli: { path: ['alpha'] }, mcp: { tool: 'alpha' } },
      { cli: { path: ['beta'] }, mcp: { tool: 'beta' } },
    ])
  })

  it('項目のキーは contracts の例の順', () => {
    expect(Object.keys(entries[0] ?? {})).toStrictEqual(['id', 'name', 'description', 'surfaces', 'hidden', 'deprecated', 'input', 'cli', 'mcp'])
  })

  it('グローバルの repo は input に出さない', () => {
    expect(Object.keys(entries[0]?.input.properties ?? {})).not.toContain('repo')
  })

  it('自分の --repo を持つコマンド（hasOwnRepo）は、repo を input と cli.flags に出し、required には入れない', () => {
    const own = defineCommand({
      path: ['own'],
      description: 'Has its own repo.',
      input: z.strictObject({
        json: z.boolean().default(false).describe('Print JSON.'),
        repo: z.string().optional().describe('Target repository.'),
      }),
      hasOwnRepo: true,
      positional: [],
      shortFlags: { json: '-j' },
      run: () => Promise.resolve(0),
      interactive: false,
    })
    const [entry] = exportEntries([own])
    expect(entry?.input).toStrictEqual({
      type: 'object',
      properties: {
        json: { type: 'boolean', default: false, description: 'Print JSON.' },
        repo: { type: 'string', description: 'Target repository.' },
      },
      required: [],
      additionalProperties: false,
    })
    expect(entry?.cli).toStrictEqual({ positional: [], flags: { json: ['--json', '-j'], repo: ['--repo'] } })
  })

  it('input.properties と cli.flags のキーは名前の順、引数の中のキーは決めた順', () => {
    const alphaEntry = entries[0]
    expect(Object.keys(alphaEntry?.input.properties ?? {})).toStrictEqual(['count', 'json', 'mode', 'name', 'verbose'])
    expect(Object.keys(alphaEntry?.cli.flags ?? {})).toStrictEqual(['count', 'json', 'mode', 'verbose'])
    expect(Object.keys(alphaEntry?.input.properties['mode'] ?? {})).toStrictEqual(['type', 'enum', 'default', 'description'])
    expect(Object.keys(entries[1]?.input.properties['limit'] ?? {})).toStrictEqual(['type', 'minimum', 'maximum', 'default', 'description'])
    expect(Object.keys(entries[1]?.input.properties['files'] ?? {})).toStrictEqual(['type', 'items', 'description'])
  })

  it('required が空でも [] を出し、additionalProperties: false を付け、$schema を外す', () => {
    const input = entries[1]?.input
    expect(input?.required).toStrictEqual([])
    expect(input?.additionalProperties).toBe(false)
    expect(Object.keys(input ?? {})).toStrictEqual(['type', 'properties', 'required', 'additionalProperties'])
  })

  it('z.int() の安全な整数の端を、items の中も含めて外す', () => {
    const integers = z.array(z.int())
    const gamma = defineCommand({
      path: ['gamma'],
      description: 'Numbers.',
      input: z.strictObject({ one: z.int().optional(), many: integers.optional() }),
      positional: [],
      run: () => Promise.resolve(0),
      interactive: false,
    })
    const [entry] = exportEntries([gamma])
    expect(entry?.input.properties).toStrictEqual({
      many: { type: 'array', items: { type: 'integer' } },
      one: { type: 'integer' },
    })
  })

  it('id は名前を大文字にし、空白と _ を - にする', () => {
    const [entry] = exportEntries([defineCommand({
      path: ['sub', 'add-to_x'],
      description: 'Sub.',
      input: z.strictObject({}),
      positional: [],
      run: () => Promise.resolve(0),
      interactive: false,
    })])
    expect(entry?.id).toBe('PW-SUB-ADD-TO-X')
    expect(entry?.name).toBe('sub add-to_x')
  })
})

describe('exportEntries の別名', () => {
  const aliased = defineCommand({
    path: ['aliased'],
    description: 'Has aliases.',
    input: z.strictObject({
      allow_existing_branch: z.boolean().default(false),
      verbose: z.boolean().default(true),
      directory: z.string().optional(),
    }),
    positional: [],
    shortFlags: { directory: '-D' },
    aliases: { allow_existing_branch: '--force', verbose: '--loud' },
    negations: { verbose: '--no-verbose' },
    run: () => Promise.resolve(0),
    interactive: false,
  })

  it('旗は、長い形・短い形・別名・否定形の順に並ぶ', () => {
    expect(exportEntries([aliased])[0]?.cli.flags).toStrictEqual({
      allow_existing_branch: ['--allow-existing-branch', '--force'],
      verbose: ['--verbose', '--loud', '--no-verbose'],
      directory: ['--directory', '-D'],
    })
  })
})

describe('exportEntries の失敗と refine', () => {
  function commandOf(shape: Readonly<Record<string, z.ZodType>>): ReturnType<typeof defineCommand> {
    return defineCommand({ path: ['bad', 'cmd'], description: 'Bad.', input: z.strictObject(shape), positional: [], run: () => Promise.resolve(0), interactive: false })
  }

  it('全体の refine を持つ input でも書き出せ、repo を出さない', () => {
    const refined = defineCommand({
      path: ['refined'],
      description: 'Refined.',
      input: z.strictObject({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a !== undefined || value.b !== undefined),
      positional: [],
      run: () => Promise.resolve(0),
      interactive: false,
    })
    const [entry] = exportEntries([refined])
    expect(Object.keys(entry?.input.properties ?? {})).toStrictEqual(['a', 'b'])
    expect(entry?.input.required).toStrictEqual([])
  })

  it.each([
    ['exclusiveMinimum', z.number().int().gt(0), 'bad cmd: n: unsupported JSON Schema key exclusiveMinimum'],
    ['minLength', z.string().min(1), 'bad cmd: n: unsupported JSON Schema key minLength'],
    ['pattern', z.string().regex(/^a$/), 'bad cmd: n: unsupported JSON Schema key pattern'],
    ['format', z.email(), 'bad cmd: n: unsupported JSON Schema key format'],
    ['anyOf', z.union([z.string(), strings]), 'bad cmd: n: unsupported JSON Schema key anyOf'],
    ['number', z.number(), 'bad cmd: n: unsupported type "number"'],
    ['items の中の type', z.array(z.number()), 'bad cmd: n: unsupported type "number"'],
  ])('表に無い %s は、コマンドと引数の名前を付けて止める', (_label, schema, message) => {
    expect(() => exportEntries([commandOf({ n: schema })])).toThrow(message)
  })
})

const IncludeSchema = z.object({ include: z.array(z.string()) })
const ProjectSchema = z.object({ test: IncludeSchema })
const ConfigSchema = z.object({ test: z.object({ projects: z.array(ProjectSchema) }) })

const generated = path.resolve(import.meta.dirname, '../../interface/generated.json')
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/export-interface.ts --write'

function fileOf(commands: Parameters<typeof exportEntries>[0]): Record<string, unknown> {
  return { format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries: exportEntries(commands) }
}

const EntriesSchema = z.array(z.custom<Record<string, unknown>>(value => typeof value === 'object' && value !== null))

function entryOf(file: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> {
  const entries = EntriesSchema.parse(file['entries'])
  const entry = entries.find(candidate => candidate['id'] === id)
  if (entry === undefined) throw new TypeError(`定義書に ${id} が無い`)
  return entry
}

function temporaryTarget(text?: string): string {
  const target = path.join(makeTemporaryDirectory(), 'generated.json')
  if (text !== undefined) writeFileSync(target, text)
  return target
}

function run(mode: string, target: string, commands: Parameters<typeof exportEntries>[0] = samples): { code: number, out: string[], error: string[] } {
  const { io, out, error } = capture()
  return { code: main([mode], io, commands, { target }), out, error }
}

describe('main の --write', () => {
  it('挿入順のまま、字下げ 2・末尾に改行 1 つで書き、wrote の行を出して 0 を返す', () => {
    const target = temporaryTarget()
    const result = run('--write', target)
    expect(result.code).toBe(0)
    expect(result.out).toStrictEqual([`wrote: ${target}\n`])
    expect(result.error).toStrictEqual([])
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify(fileOf(samples), undefined, 2)}\n`)
  })

  it('書いたファイルは --check が 0 を返す', () => {
    const target = temporaryTarget()
    run('--write', target)
    expect(run('--check', target)).toStrictEqual({ code: 0, out: [], error: [] })
  })

  it('古い定義書を書き換える', () => {
    const target = temporaryTarget('{}')
    expect(run('--write', target).code).toBe(0)
    expect(run('--check', target).code).toBe(0)
  })

  it('書けなければ、cannot write の行を出して 1 を返す', () => {
    const target = path.join(makeTemporaryDirectory(), 'missing', 'generated.json')
    const result = run('--write', target)
    expect(result.code).toBe(1)
    expect(result.error).toHaveLength(1)
    expect(result.error[0]).toMatch(/^error: cannot write \S+generated\.json: ENOENT/v)
  })

  it('登録が 0 件でも、空の項目で書く', () => {
    const target = temporaryTarget()
    expect(run('--write', target, []).code).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries: [] }, undefined, 2)}\n`)
  })

  it('モードの指定が無い・不正なら 2 を返す', () => {
    const { io, error } = capture()
    expect(main([], io)).toBe(2)
    expect(main(['--check', '--write'], io)).toBe(2)
    expect(error.every(line => line.startsWith('error: '))).toBe(true)
  })
})

function textOf(file: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(file, undefined, 2)}\n`
}

function checkOf(file: Readonly<Record<string, unknown>>): ReturnType<typeof run> {
  return run('--check', temporaryTarget(textOf(file)))
}

describe('main の --check', () => {
  it('実物の generated.json は、登録済みのコマンドと一致して 0 を返す', () => {
    const { io, out, error } = capture()
    expect(main(['--check'], io)).toBe(0)
    expect({ out, error }).toStrictEqual({ out: [], error: [] })
  })

  it('実物の generated.json を書き換えない', () => {
    const before = readFileSync(generated)
    run('--check', generated)
    run('--write', temporaryTarget())
    expect(readFileSync(generated).equals(before)).toBe(true)
  })

  it('書式が違っても中身が同じなら、差の行は出さずに stale の行だけで 1 を返す', () => {
    const compact = temporaryTarget(JSON.stringify(fileOf(samples)))
    const result = run('--check', compact)
    expect(result.code).toBe(1)
    expect(result.error).toStrictEqual([
      expect.stringMatching(/^error: \S+generated\.json is stale\n$/v),
      `  run: ${WRITE_COMMAND}\n`,
    ])
  })

  it('欄の値の差は 1 を返し、前と後の値と直すコマンドを formatStale の形で出す', () => {
    const file = fileOf(samples)
    entryOf(file, 'PW-ALPHA')['description'] = 'Changed'
    const result = checkOf(file)
    expect(result.code).toBe(1)
    expect(result.error).toStrictEqual([
      expect.stringMatching(/^error: \S+generated\.json is stale\n$/v),
      '  PW-ALPHA: description: "Changed" -> "Greet someone"\n',
      `  run: ${WRITE_COMMAND}\n`,
    ])
  })

  it('surfaces.mcp の差も 1 を返す', () => {
    const file = fileOf(samples)
    entryOf(file, 'PW-ALPHA')['surfaces'] = { cli: { path: ['alpha'] }, mcp: { tool: 'renamed' } }
    const result = checkOf(file)
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-ALPHA: surfaces.mcp.tool: "renamed" -> "alpha"\n')
  })

  it('語彙の差も 1 を返し、names の欄のパスを出す', () => {
    const file = fileOf(samples)
    file['names'] = { ...exportNames(), rest: true }
    const result = checkOf(file)
    expect(result.code).toBe(1)
    expect(result.error).toContain('  file: names.rest: true -> false\n')
  })

  it('Node にあって定義書に無い ID は 1 を返し、entry: added の行を出す', () => {
    const result = checkOf(fileOf([alpha]))
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-BETA: entry: added\n')
  })

  it('定義書にあって Node に無い ID も 1 を返し、entry: removed の行を出す', () => {
    const target = temporaryTarget(textOf(fileOf(samples)))
    const result = run('--check', target, [alpha])
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-BETA: entry: removed\n')
  })

  it('Node にだけある欄のキーは 1 を返し、added の行を出す', () => {
    const file = fileOf(samples)
    Reflect.deleteProperty(entryOf(file, 'PW-BETA'), 'cli')
    expect(checkOf(file).error).toContain('  PW-BETA: cli: added\n')
  })

  it('定義書にだけある欄のキーは 1 を返し、removed の行を出す', () => {
    const file = fileOf(samples)
    entryOf(file, 'PW-BETA')['mcp'] = { output: exportEntries([beta])[0]?.mcp.output, annotations: { readOnlyHint: true } }
    expect(checkOf(file).error).toContain('  PW-BETA: mcp.annotations: removed\n')
  })

  describe('定義書を読めないとき', () => {
    it('ファイルが無ければ、cannot read と直すコマンドを出して 1 を返す', () => {
      const result = run('--check', temporaryTarget())
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: ENOENT.*\n {2}run: pnpm /v)
    })

    it('JSON でなければ、cannot read の行を出して 1 を返す', () => {
      const result = run('--check', temporaryTarget('{'))
      expect(result.code).toBe(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: .*JSON/v)
    })

    it('スキーマに合わなければ、cannot read の行を出して 1 を返す', () => {
      const result = run('--check', temporaryTarget('{"a":1}'))
      expect(result.code).toBe(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: /v)
    })
  })

  describe('Node の側の項目が不正なとき', () => {
    const broken = defineCommand({
      path: ['broken'],
      description: 'Has an invalid path',
      input: z.strictObject({}),
      positional: [],
      run: () => Promise.resolve(0),
      interactive: false,
    })

    it('項目がスキーマに合わなければ、invalid entries の行を出して 1 を返し、ファイルを書かない', () => {
      const target = temporaryTarget()
      const result = run('--write', target, [{ ...broken, path: [] }])
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: invalid entries: /v)
      expect(() => readFileSync(target)).toThrow('ENOENT')
    })

    it('同じ ID のコマンドが 2 つあれば、重複した ID を示す error の行を出して 1 を返す', () => {
      const result = run('--check', temporaryTarget(), [alpha, alpha, beta])
      expect(result.code).toBe(1)
      expect(result.error).toStrictEqual(['error: duplicate ids: PW-ALPHA\n'])
    })
  })
})

// 見本の ID は、定義書の ID の形をそのまま書かないよう連結で作る
const PREFIX = 'PW'
const SUFFIX = '01'
const CALL = ['verifies', '('].join('')
const idOf = (name: string): string => `${PREFIX}-${name}-${SUFFIX}`
const callOf = (name: string): string => `await ${CALL}context, '${idOf(name)}')`

describe('振る舞いの項目のつなぎ', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const { projects } = ConfigSchema.parse(vitestConfig).test
  const include = projects.flatMap(project => project.test.include)

  const authoredText = readFileSync(path.resolve(root, '../interface/authored.yaml'), 'utf8')
  const authored = authoredFileSchema.parse(parseYaml(authoredText))

  function expectedIds(commands: Parameters<typeof exportEntries>[0]): string[] {
    return exportEntries(commands).flatMap((entry) => {
      const found = authored.entries[entry.id]
      if (found === undefined) throw new Error(`authored.yaml に ${entry.id} が無い`)
      return found.behaviors.map(behavior => behavior.id)
    })
  }

  describe('collectVerifiedIds', () => {
    const files = {
      'tests/interface/a.test.ts': `${callOf('A')}\n// ${callOf('B')}\n/* ${callOf('C')} */\n`,
      'tests/interface/rows.test.ts': `it.for([{ id: '${idOf('D')}' }])('x', async (row, context) => {\n  await ${CALL}context, row.id)\n})\n// '${idOf('E')}'\n`,
      'tests/parity/p.test.ts': callOf('F'),
      'tests/other/o.test.ts': callOf('G'),
      'src/commands/tests/s.test.ts': callOf('H'),
    }

    it('verifies の引数の ID を集め、コメントの中の ID を数えない', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      const ids = collectVerifiedIds(directory, ['tests/interface/**/*.test.ts', 'src/**/tests/**/*.test.ts'])
      expect([...ids].toSorted(compareText)).toStrictEqual([idOf('A'), idOf('D'), idOf('H')])
    })

    it('引数がリテラルでない verifies を持つファイルでは、行の ID を数える', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      expect(collectVerifiedIds(directory, ['tests/interface/rows.test.ts'])).toStrictEqual(new Set([idOf('D')]))
    })

    it('リテラルだけのファイルでは、verifies の外にある ID のリテラルを数えない', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/lit.test.ts': `const x = '${idOf('X')}'\n${callOf('Y')}\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set([idOf('Y')]))
    })

    it('桁が続く ID は、前の桁までの ID として数えない', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/long.test.ts': `${CALL}context, row.id)\nconst x = '${idOf('L')}1'\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set())
    })

    it('文字列の中の // をコメントとして扱わない', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/str.test.ts': `const a = 'a // b'; ${callOf('S')}\nconst b = "/* c"; ${callOf('T')} */\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set([idOf('S'), idOf('T')]))
    })

    it('include に当たらないファイルと tests/parity の ID を数えない', () => {
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      const ids = collectVerifiedIds(directory, ['tests/**/*.test.ts'])
      expect(ids.has(idOf('F'))).toBe(false)
      expect(ids.has(idOf('H'))).toBe(false)
      expect(ids.has(idOf('G'))).toBe(true)
    })

    it('無い ID を、並べて返す', () => {
      const missing = missingIds([idOf('Z'), idOf('A'), idOf('A')], new Set([idOf('B')]))
      expect(missing).toStrictEqual([idOf('A'), idOf('Z')])
    })
  })

  it('登録済みのコマンドの項目の ID が、すべて vitest の verifies につながる', () => {
    const missing = missingIds(expectedIds(COMMANDS), collectVerifiedIds(root, include))
    expect(missing).toStrictEqual([])
  })

  it('共通の項目の ID が、すべて vitest の verifies につながる', () => {
    const common = authored.common_behaviors.map(behavior => behavior.id)
    expect(common).toHaveLength(17)
    expect(missingIds(common, collectVerifiedIds(root, include))).toStrictEqual([])
  })
})
