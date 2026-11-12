/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
// コマンドごとの --help が、定義書（generated.json と authored.yaml）の中身を全部出していることを、全コマンドで確かめる。
// 空白を除いてから、定義書の項目が含まれることを見る。幅より長い 1 語（`backlog/pending/...` など）は幅で折るので、折り目の改行と字下げも除く。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runCli } from '../src/cli.js'
import { defineCommand, interfaceIdOf } from '../src/commands/command-definition.js'
import { COMMANDS } from '../src/commands/registry.js'
import type { CommandDefinition } from '../src/commands/registry.js'
import { cellLength } from '../src/commands/rich-panel.js'
import { capture, exitWith } from '../src/commands/tests/support.js'
import { readAuthoredNotes } from '../src/infra/authored-notes.js'
import type { AuthoredNotes } from '../src/infra/authored-notes.js'
import { parseJson } from '../src/tests/_helpers/json.js'
import { missingHelpItems } from './_helpers/help-items.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const WIDTHS: readonly number[] = [80, 40]

const NamesSchema = z.array(z.string())
const PropertySchema = z.looseObject({})
const InputSchema = z.object({ properties: z.record(z.string(), PropertySchema), required: NamesSchema })
const CliSchema = z.object({ positional: NamesSchema, flags: z.record(z.string(), NamesSchema) })
const EntrySchema = z.object({ id: z.string(), description: z.string(), input: InputSchema, cli: CliSchema })
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })

type Entry = z.output<typeof EntrySchema>

const generatedFile = path.join(PLUGIN_ROOT, 'interface', 'generated.json')
const generatedText = readFileSync(generatedFile, 'utf8')
const generated = GeneratedSchema.parse(parseJson(generatedText))

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryOf(definition: CommandDefinition): Entry {
  const id = interfaceIdOf(definition.path)
  const entry = generated.entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`generated.json に ${id} が無い`)
  return entry
}

function notesOf(definition: CommandDefinition): AuthoredNotes | undefined {
  return readAuthoredNotes(interfaceIdOf(definition.path), PLUGIN_ROOT)
}

async function helpOf(argv: readonly string[], width: number): Promise<string> {
  const io = capture()
  const code = await runCli([...argv, '--help'], { commands: COMMANDS, cwd: process.cwd(), io, environment: { TERMINAL_WIDTH: String(width) }, terminalColumns: undefined })
  expect(code).toBe(0)
  return io.out.join('')
}

/**
空白を全部除く。折り返しの改行・字下げ・語の間の空白を無視して、中身だけを比べる
*/
function collapsed(text: string): string {
  return text.replaceAll(/\s+/gu, '')
}

function referenceOf(definition: CommandDefinition, name: string): string {
  return definition.positional.includes(name) ? `<${name}>` : `--${name.replaceAll('_', '-')}`
}

function joinedReferences(definition: CommandDefinition, names: readonly string[]): string {
  const references = names.map(name => referenceOf(definition, name))
  const last = references.at(-1) ?? ''
  return references.length < 2 ? last : `${references.slice(0, -1).join(', ')} and ${last}`
}

function constraintSentences(definition: CommandDefinition, constraint: AuthoredNotes['constraints'][number]): readonly string[] {
  return 'conflicts' in constraint
    ? [`${joinedReferences(definition, constraint.conflicts)} cannot be used together`]
    : Object.entries(constraint.requires).map(([name, required]) => `${referenceOf(definition, name)} requires ${joinedReferences(definition, required)}`)
}

function rangeFragments(element: Readonly<Record<string, unknown>>): readonly string[] {
  const minimum = element['minimum']
  const maximum = element['maximum']
  if (typeof minimum === 'number' && typeof maximum === 'number') return [`[${String(minimum)}<=x<=${String(maximum)}]`]
  return [...typeof minimum === 'number' ? [`[x>=${String(minimum)}]`] : [], ...typeof maximum === 'number' ? [`[x<=${String(maximum)}]`] : []]
}

function defaultFragments(name: string, property: Readonly<Record<string, unknown>>, hasNegation: boolean): readonly string[] {
  const value = property['default']
  if (typeof value === 'string' && value !== '') return [`[default: ${value}]`]
  if (typeof value === 'number') return [`[default: ${String(value)}]`]
  return value === true && hasNegation ? [`[default: ${name.replaceAll('_', '-')}]`] : []
}

/**
generated.json の引数 1 つについて、help に出るはずの文字列
*/
function propertyFragments(entry: Entry, name: string, property: Readonly<Record<string, unknown>>): readonly string[] {
  const flags = new Map(Object.entries(entry.cli.flags)).get(name) ?? []
  const items = property['items']
  const element = isObject(items) ? items : property
  const choices = element['enum']
  const description = property['description']
  const positionalName = entry.input.required.includes(name) ? `<${name}>` : `[${name}]`
  return [
    ...flags,
    ...entry.cli.positional.includes(name) ? [positionalName] : [],
    ...typeof description === 'string' ? [description] : [],
    ...Array.isArray(choices) ? [`<${choices.map(String).join('|')}>`] : [],
    ...rangeFragments(element),
    ...defaultFragments(name, property, flags.some(flag => flag.startsWith('--no-'))),
  ]
}

function expectedFragments(definition: CommandDefinition): readonly string[] {
  const entry = entryOf(definition)
  const notes = notesOf(definition)
  const properties = Object.entries(entry.input.properties).flatMap(([name, property]) => propertyFragments(entry, name, property))
  const constraints = notes?.constraints.flatMap(constraint => constraintSentences(definition, constraint)) ?? []
  const examples = notes?.examples.flatMap(example => [example.run, example.note]) ?? []
  return [`pecot ${definition.path.join(' ')}`, entry.description, ...properties, ...notes?.details ?? [], ...constraints, ...examples]
}

const commandRows = COMMANDS.flatMap(definition => WIDTHS.map(width => ({ name: definition.path.join(' '), definition, width })))

describe('全コマンドの --help は定義書の中身を全部出す', () => {
  it.for(commandRows)('$name を幅 $width で打つと、定義書の項目を全部出す', async ({ definition, width }) => {
    const text = await helpOf(definition.path, width)
    const flat = collapsed(text)
    expect(expectedFragments(definition).filter(fragment => !flat.includes(collapsed(fragment)))).toEqual([])
    // 幅を超えてよいのは、Examples の打つ形の行だけ
    const runs = new Set(notesOf(definition)?.examples.map(example => `  ${example.run}`))
    expect(text.split('\n').filter(line => cellLength(line) > width && !runs.has(line))).toEqual([])
    expect(text).not.toMatch(/[╭│╰…]/u)
    expect(text).not.toMatch(/ $/mu)
  })

  it('全コマンドで、説明の欠けた項目が無い', () => {
    const missing = COMMANDS
      .map(definition => ({ path: definition.path.join(' '), items: missingHelpItems(definition, notesOf(definition)) }))
      .filter(entry => entry.items.length > 0)
    expect(missing).toEqual([])
  })
})

function sampleCommand(description: string, argumentDescription: string | undefined): CommandDefinition {
  const field = z.string()
  return defineCommand({
    path: ['sample'],
    description,
    input: z.object({ name: argumentDescription === undefined ? field : field.describe(argumentDescription) }),
    positional: ['name'],
    interactive: false,
    run: async () => await exitWith(0),
  })
}

describe('missingHelpItems', () => {
  const notes: AuthoredNotes = { details: ['A detail.'], constraints: [], examples: [] }

  it('欠けが無ければ空', () => {
    expect(missingHelpItems(sampleCommand('Sample', 'A name'), notes)).toEqual([])
  })

  it('コマンドの説明が空なら description を返す', () => {
    expect(missingHelpItems(sampleCommand('', 'A name'), notes)).toEqual(['description'])
  })

  it('引数の説明が無ければ argument:名前 を返す', () => {
    expect(missingHelpItems(sampleCommand('Sample', undefined), notes)).toEqual(['argument:name'])
  })

  it('details が空か、定義書の項目が無ければ details を返す', () => {
    expect(missingHelpItems(sampleCommand('Sample', 'A name'), { ...notes, details: [] })).toEqual(['details'])
    expect(missingHelpItems(sampleCommand('Sample', 'A name'), undefined)).toEqual(['details'])
  })

  it('空白だけの説明も欠けとして数え、全部を順に返す', () => {
    expect(missingHelpItems(sampleCommand(' ', ' '), { ...notes, details: [] })).toEqual(['description', 'argument:name', 'details'])
  })
})

/**
path の直下の名前と、単独のコマンドなら説明
*/
function childrenOf(group: readonly string[]): readonly (readonly [string, string | undefined])[] {
  const below = COMMANDS.filter(definition => definition.path.length > group.length && group.every((segment, index) => definition.path.at(index) === segment))
  const names = new Set(below.map(definition => definition.path.at(group.length) ?? ''))
  return Array.from(names, (name): readonly [string, string | undefined] => [name, below.find(definition => definition.path.length === group.length + 1 && definition.path.at(group.length) === name)?.description])
}

const groupNames = new Set(COMMANDS.flatMap(definition => definition.path.slice(0, -1).map((_, index) => definition.path.slice(0, index + 1).join(' '))))
const groupRows = ['', ...groupNames].flatMap(group => WIDTHS.map(width => ({ name: group === '' ? 'ルート' : group, group: group === '' ? [] : group.split(' '), width })))

describe('ルートとグループの --help', () => {
  it.for(groupRows)('$name を幅 $width で打つと、直下のコマンドの名前と説明を全部出す', async ({ group, width }) => {
    const text = await helpOf(group, width)
    const flat = collapsed(text)
    const expected = childrenOf(group).flatMap(([name, description = '']) => [name, description])
    expect(expected.filter(fragment => !flat.includes(collapsed(fragment)))).toEqual([])
    expect(text.split('\n').filter(line => cellLength(line) > width)).toEqual([])
    expect(text).not.toMatch(/[╭│╰…]/u)
  })
})
