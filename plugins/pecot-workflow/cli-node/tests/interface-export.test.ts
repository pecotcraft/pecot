/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時ファイルと定義書 */
// cli-node の書き出しが、typer 側の書き出しと同じ input・cli を出すことを確かめる。
// typer 側の書き出し済みの見本（interface-export/typer-sample.json）を、Python 側のテストと共有する。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { authoredFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { COMMANDS, defineCommand, type CommandIo } from '../src/commands/registry.js'
import { compareText } from '../../../../libs/interface-spec/src/domain/utility.js'
import { collectVerifiedIds, missingIds } from './_helpers/behavior-ids.js'
import { makeTemporaryDirectory, writeTree } from '../src/tests/_helpers/temporary.js'
import vitestConfig from '../vitest.config.js'
import { exportEntries, main } from '../scripts/export-interface.js'
import { parseJson } from '../src/tests/_helpers/json.js'

const SampleEntrySchema = z.looseObject({ id: z.string() })
const SampleSchema = z.object({ entries: z.array(SampleEntrySchema) })
const sampleText = readFileSync(path.resolve(import.meta.dirname, 'interface-export/typer-sample.json'), 'utf8')
const sample = SampleSchema.parse(parseJson(sampleText))

function sampleEntry(id: string): Record<string, unknown> {
  const entry = sample.entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`見本に ${id} が無い`)
  return entry
}

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

describe('exportEntries', () => {
  const entries = exportEntries([beta, alpha])

  it('見本の書き出し全体が node-sample.json と同じバイト列になる', () => {
    const file = { format: 1, plugin: 'pecot-workflow', prefix: 'PW', entries: exportEntries(samples) }
    const expected = readFileSync(path.resolve(import.meta.dirname, 'interface-export/node-sample.json'), 'utf8')
    expect(`${JSON.stringify(file, undefined, 2)}\n`).toBe(expected)
  })

  it('項目は id の順に並ぶ', () => {
    expect(entries.map(entry => entry.id)).toStrictEqual(['PW-ALPHA', 'PW-BETA'])
  })

  it.each(['PW-ALPHA', 'PW-BETA'])('%s の input・cli が typer の書き出しと同じ', (id) => {
    const entry = entries.find(candidate => candidate.id === id)
    const expected = sampleEntry(id)
    expect(entry?.input).toStrictEqual(expected['input'])
    expect(entry?.cli).toStrictEqual(expected['cli'])
    expect(entry?.name).toBe(expected['name'])
    expect(entry?.description).toBe(expected['description'])
    expect(entry?.hidden).toBe(expected['hidden'])
    expect(entry?.deprecated).toBe(expected['deprecated'])
  })

  it('surfaces は cli.path と mcp.tool の両方を持つ', () => {
    expect(entries.map(entry => entry.surfaces)).toStrictEqual([
      { cli: { path: ['alpha'] }, mcp: { tool: 'alpha' } },
      { cli: { path: ['beta'] }, mcp: { tool: 'beta' } },
    ])
  })

  it('項目のキーは contracts の例の順', () => {
    expect(Object.keys(entries[0] ?? {})).toStrictEqual(['id', 'name', 'description', 'surfaces', 'hidden', 'deprecated', 'input', 'cli'])
  })

  it('グローバルの repo は input に出さない', () => {
    expect(Object.keys(entries[0]?.input.properties ?? {})).not.toContain('repo')
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

describe('main', () => {
  const generated = path.resolve(import.meta.dirname, '../../interface/generated.json')

  it('COMMANDS が空なら、警告を標準エラーに出して 0 を返し、generated.json を変えない', () => {
    const before = readFileSync(generated)
    const { io, out, error } = capture()
    expect(main(['--check'], io)).toBe(0)
    expect(out).toStrictEqual([])
    expect(error).toStrictEqual(['warning: no commands are registered in cli-node; generated.json is left as is\n'])
    expect(readFileSync(generated).equals(before)).toBe(true)
  })

  it('--write でも同じで、generated.json を変えない', () => {
    const before = readFileSync(generated)
    const { io, error } = capture()
    expect(main(['--write'], io)).toBe(0)
    expect(error).toHaveLength(1)
    expect(readFileSync(generated).equals(before)).toBe(true)
  })

  it('モードの指定が無い・不正なら 2 を返す', () => {
    const { io, error } = capture()
    expect(main([], io)).toBe(2)
    expect(main(['--check', '--write'], io)).toBe(2)
    expect(error.every(line => line.startsWith('error: '))).toBe(true)
  })
})

const IncludeSchema = z.object({ include: z.array(z.string()) })
const ProjectSchema = z.object({ test: IncludeSchema })
const ConfigSchema = z.object({ test: z.object({ projects: z.array(ProjectSchema) }) })

interface Definition { format: 1, plugin: string, prefix: string, entries: Record<string, unknown>[] }

// 定義書は Python 側の書き出しと同じく surfaces.mcp を持たない
function definitionOf(commands: Parameters<typeof exportEntries>[0]): Definition {
  const entries = exportEntries(commands).map(({ surfaces, ...rest }) => ({ ...rest, surfaces: { cli: surfaces.cli } }))
  return { format: 1, plugin: 'pecot-workflow', prefix: 'PW', entries }
}

function entryOf(definition: Definition, id: string): Record<string, unknown> {
  const entry = definition.entries.find(candidate => candidate['id'] === id)
  if (entry === undefined) throw new Error(`定義書に ${id} が無い`)
  return entry
}

function checkText(text: string | undefined): { code: number, error: string[] } {
  const target = path.join(makeTemporaryDirectory(), 'generated.json')
  if (text !== undefined) writeFileSync(target, text)
  const { io, error } = capture()
  return { code: main(['--check'], io, [alpha, beta], { target }), error }
}

describe('main の --check', () => {
  const generated = path.resolve(import.meta.dirname, '../../interface/generated.json')

  function check(definition: Definition): { code: number, error: string[] } {
    const target = path.join(makeTemporaryDirectory(), 'generated.json')
    writeFileSync(target, JSON.stringify(definition))
    const { io, error } = capture()
    return { code: main(['--check'], io, samples, { target }), error }
  }

  it('定義書と差が無ければ 0 を返し、何も出さない', () => {
    expect(check(definitionOf(samples))).toStrictEqual({ code: 0, error: [] })
  })

  it('定義書だけが持つ ID があっても、0 を返す', () => {
    const definition = definitionOf(samples)
    definition.entries.push({ ...entryOf(definition, 'PW-BETA'), id: 'PW-OTHER', name: 'other' })
    expect(check(definition)).toStrictEqual({ code: 0, error: [] })
  })

  it('surfaces.mcp だけの差は 0 を返す', () => {
    const definition = definitionOf(samples)
    entryOf(definition, 'PW-ALPHA')['surfaces'] = { cli: { path: ['alpha'] }, mcp: { tool: 'renamed' } }
    expect(check(definition).code).toBe(0)
  })

  it('Node にあって定義書に無い ID は 1 を返し、entry: added の行を出す', () => {
    const definition = definitionOf([alpha])
    expect(check(definition)).toStrictEqual({ code: 1, error: ['error: PW-BETA: entry: added\n'] })
  })

  it('欄の値の差は 1 を返し、前と後の値を出す', () => {
    const definition = definitionOf(samples)
    entryOf(definition, 'PW-ALPHA')['description'] = 'Changed'
    expect(check(definition)).toStrictEqual({ code: 1, error: ['error: PW-ALPHA: description: "Changed" -> "Greet someone"\n'] })
  })

  it('Node にだけある欄のキーは 1 を返し、added の行を出す', () => {
    const definition = definitionOf(samples)
    Reflect.deleteProperty(entryOf(definition, 'PW-BETA'), 'cli')
    expect(check(definition)).toStrictEqual({ code: 1, error: ['error: PW-BETA: cli: added\n'] })
  })

  it('定義書にだけある欄のキーは 1 を返し、removed の行を出す', () => {
    const definition = definitionOf(samples)
    entryOf(definition, 'PW-BETA')['mcp'] = {}
    expect(check(definition)).toStrictEqual({ code: 1, error: ['error: PW-BETA: mcp: removed\n'] })
  })

  describe('定義書を読めないとき', () => {
    it('ファイルが無ければ、cannot read の行を出して 1 を返す', () => {
      const result = checkText(undefined)
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: ENOENT/v)
    })

    it('JSON でなければ、cannot read の行を出して 1 を返す', () => {
      const result = checkText('{')
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: .*JSON/v)
    })

    it('スキーマに合わなければ、欄のパスと文を 1 行で出して 1 を返す', () => {
      const result = checkText('{"a":1}')
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: format: /v)
      expect(result.error[0]).not.toMatch(/generated\.json: \[/v)
      expect(result.error[0]?.trimEnd().split('\n')).toHaveLength(1)
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

    it('項目がスキーマに合わなければ、コマンドの項目を示す error の行を出して 1 を返す', () => {
      const emptyPath = { ...broken, path: [] }
      const target = path.join(makeTemporaryDirectory(), 'generated.json')
      writeFileSync(target, JSON.stringify(definitionOf(samples)))
      const { io, error } = capture()
      expect(main(['--check'], io, [emptyPath], { target })).toBe(1)
      expect(error).toHaveLength(1)
      expect(error[0]).toMatch(/^error: PW-: invalid entry: /v)
    })

    it('同じ ID のコマンドが 2 つあれば、重複した ID を示す error の行を出して 1 を返す', () => {
      const target = path.join(makeTemporaryDirectory(), 'generated.json')
      writeFileSync(target, JSON.stringify(definitionOf(samples)))
      const { io, error } = capture()
      expect(main(['--check'], io, [alpha, alpha, beta], { target })).toBe(1)
      expect(error).toStrictEqual(['error: duplicate ids: PW-ALPHA\n'])
    })
  })

  it('登録が 1 件以上の --write は、使い方のエラーで 2 を返し、ファイルを書かない', () => {
    const target = path.join(makeTemporaryDirectory(), 'generated.json')
    const { io, error } = capture()
    expect(main(['--write'], io, samples, { target })).toBe(2)
    expect(error).toHaveLength(1)
    expect(error[0]).toMatch(/^error: /v)
    expect(() => readFileSync(target)).toThrow('ENOENT')
  })

  it('実物の generated.json を書き換えない', () => {
    const before = readFileSync(generated)
    check(definitionOf(samples))
    expect(readFileSync(generated).equals(before)).toBe(true)
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
