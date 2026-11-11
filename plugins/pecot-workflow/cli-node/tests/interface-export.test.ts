// cli-node の書き出しが、typer 側の書き出しと同じ input・cli を出すことを確かめる。
// typer 側の書き出し済みの見本（interface-export/typer-sample.json）を、Python 側のテストと共有する。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineCommand, type CommandIo } from '../src/commands/registry.js'
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
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
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

  it('登録がある場合は未対応として 2 を返す', () => {
    const { io, error } = capture()
    expect(main(['--check'], io, [alpha])).toBe(2)
    expect(error).toStrictEqual(['error: exporting registered commands is not supported yet\n'])
  })
})
