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

describe('exportEntries', () => {
  const entries = exportEntries([beta, alpha])

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

  it('--write でも同じ', () => {
    const { io, error } = capture()
    expect(main(['--write'], io)).toBe(0)
    expect(error).toHaveLength(1)
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
