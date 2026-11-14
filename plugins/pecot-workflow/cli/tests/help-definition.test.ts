/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
// コマンドごとの --help が定義書の中身を全部出すことを、全コマンドで確かめる。期待値は定義書だけから作る。
// 幅より長い 1 語は `/` の後ろで折るので、折り目の `/` の後ろの空白だけは除いて比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

import { runCli } from '../src/cli.js'
import { defineCommand, interfaceIdOf } from '../src/commands/command-definition.js'
import { COMMANDS } from '../src/commands/registry.js'
import type { CommandDefinition } from '../src/commands/registry.js'
import { cellLength } from '../src/commands/rich-panel.js'
import { capture, exitWith } from '../src/commands/tests/support.js'
import type { AuthoredNotes } from '../src/infra/authored-notes.js'
import { parseJson } from '../src/tests/_helpers/json.js'
import { missingHelpItems } from './_helpers/help-items.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const WIDTHS: readonly number[] = [80, 40]
const MAX_INLINE_CHOICES = 24

const NamesSchema = z.array(z.string())
const PropertySchema = z.looseObject({})
const InputSchema = z.object({ properties: z.record(z.string(), PropertySchema), required: NamesSchema })
const CliSchema = z.object({ positional: NamesSchema, flags: z.record(z.string(), NamesSchema) })
const EntrySchema = z.object({ id: z.string(), description: z.string(), input: InputSchema, cli: CliSchema })
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })

const RequiresSchema = z.record(z.string(), NamesSchema)
const ConstraintSchema = z.union([z.object({ conflicts: NamesSchema }), z.object({ requires: RequiresSchema })])
const ExampleSchema = z.object({ run: z.string(), note: z.string() })
const StringMapSchema = z.record(z.string(), z.string())
const ProseShape = { details: NamesSchema, examples: z.array(ExampleSchema), default_notes: StringMapSchema }
// help は --help に出す英語の文。日本語で書いた定義書では、同じ名前の 3 つの欄の代わりに出る
const AuthoredEntrySchema = z.object({ ...ProseShape, constraints: z.array(ConstraintSchema), help: z.object(ProseShape).optional() })
const AuthoredSchema = z.object({ entries: z.record(z.string(), AuthoredEntrySchema) })

type Entry = z.output<typeof EntrySchema>
type Property = Readonly<Record<string, unknown>>

// 定義書は 2 つとも、ここで 1 回だけ読む（authored.yaml は 250 KB 近く、コマンドごとに読むと 5 秒の時間切れに近づく）
function readInterfaceFile(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin の interface/ の下の固定のファイル
  return readFileSync(path.join(PLUGIN_ROOT, 'interface', name), 'utf8')
}

const generated = GeneratedSchema.parse(parseJson(readInterfaceFile('generated.json')))
const generatedById = new Map(generated.entries.map(entry => [entry.id, entry]))
const authored = AuthoredSchema.parse(parse(readInterfaceFile('authored.yaml'), { logLevel: 'error' }))
const authoredById = new Map(Object.entries(authored.entries))

function isObject(value: unknown): value is Property {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryOf(definition: CommandDefinition): Entry {
  const id = interfaceIdOf(definition.path)
  const entry = generatedById.get(id)
  if (entry === undefined) throw new Error(`generated.json に ${id} が無い`)
  return entry
}

function notesOf(definition: CommandDefinition): AuthoredNotes | undefined {
  const entry = authoredById.get(interfaceIdOf(definition.path))
  if (entry === undefined) return undefined
  const prose = entry.help ?? entry
  return { details: prose.details, constraints: entry.constraints, examples: prose.examples, defaultNotes: new Map(Object.entries(prose.default_notes)) }
}

async function helpOf(argv: readonly string[], width: number): Promise<string> {
  const io = capture()
  const code = await runCli([...argv, '--help'], { commands: COMMANDS, cwd: process.cwd(), io, environment: { TERMINAL_WIDTH: String(width) }, terminalColumns: undefined })
  expect(code).toBe(0)
  return io.out.join('')
}

/**
空白（改行・字下げを含む）を 1 つに畳む。折り目の `/` の後ろの空白は除く
*/
function normalized(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().replaceAll('/ ', '/')
}

function unwrapped(lines: readonly string[]): string {
  return normalized(lines.join(' '))
}

/**
help を節に分ける。先頭は Usage、その次は説明、あとは `見出し:` で始まる節（値は見出しの次の行から）
*/
function sectionsOf(text: string): ReadonlyMap<string, readonly string[]> {
  const blocks = text.trimEnd().split('\n\n').map(block => block.split('\n'))
  const entries = blocks.map((lines, index): readonly [string, readonly string[]] => {
    const heading = /^([A-Z][a-z]+):$/u.exec(lines[0] ?? '')?.[1]
    if (heading !== undefined && index > 1) return [heading, lines.slice(1)]
    return [index === 0 ? 'Usage' : 'Description', lines]
  })
  return new Map(entries)
}

/**
先頭の行（isHead）から、次の先頭の行の前までを 1 つのかたまりにする
*/
function chunksOf(lines: readonly string[], isHead: (line: string) => boolean): readonly (readonly string[])[] {
  const chunks: string[][] = []
  for (const line of lines) {
    const last = chunks.at(-1)
    if (last === undefined || isHead(line)) chunks.push([line])
    else last.push(line)
  }
  return chunks
}

const isNameLine = (line: string): boolean => /^ {2}\S/u.test(line)
const isBulletLine = (line: string): boolean => line.startsWith('  - ')

interface ExpectedRow {
  /**
  名前の列。字下げ 2 の後ろに、完全一致で出る
  */
  readonly name: string
  /**
  名前と説明を空白 1 つで続けた、行のかたまり全体
  */
  readonly text: string
}

function propertyOf(entry: Entry, name: string): Property {
  return new Map(Object.entries(entry.input.properties)).get(name) ?? {}
}

function flagsOf(entry: Entry, name: string): readonly string[] {
  return new Map(Object.entries(entry.cli.flags)).get(name) ?? []
}

function elementOf(property: Property): Property {
  const items = property['items']
  return isObject(items) ? items : property
}

function choicesOf(property: Property): readonly string[] | undefined {
  const choices = elementOf(property)['enum']
  return Array.isArray(choices) ? choices.map(String) : undefined
}

function isLongChoices(choices: readonly string[]): boolean {
  return choices.join('|').length > MAX_INLINE_CHOICES
}

function rangeMarks(element: Property): readonly string[] {
  const minimum = element['minimum']
  const maximum = element['maximum']
  if (typeof minimum === 'number' && typeof maximum === 'number') return [`[${String(minimum)}<=x<=${String(maximum)}]`]
  return [...typeof minimum === 'number' ? [`[x>=${String(minimum)}]`] : [], ...typeof maximum === 'number' ? [`[x<=${String(maximum)}]`] : []]
}

function defaultMarks(flags: readonly string[], property: Property): readonly string[] {
  const value = property['default']
  if (typeof value === 'string' && value !== '') return [`[default: ${value}]`]
  if (typeof value === 'number') return [`[default: ${String(value)}]`]
  const hasNegation = flags.slice(1).some(flag => flag.startsWith('--no-'))
  return value === true && hasNegation ? [`[default: ${(flags.at(0) ?? '').slice(2)}]`] : []
}

function isRequired(entry: Entry, name: string, property: Property): boolean {
  return property['type'] !== 'boolean' && entry.input.required.includes(name)
}

/**
引数 1 つの説明の欄。説明、default_notes の文、その後ろに印（[repeatable]・[required]・[choices: …]・[default: …]・範囲）の順
*/
function descriptionOf(entry: Entry, name: string, notes: AuthoredNotes | undefined, isOption: boolean): string {
  const property = propertyOf(entry, name)
  const choices = choicesOf(property)
  const description = property['description']
  return normalized([
    typeof description === 'string' ? description : '',
    notes?.defaultNotes.get(name) ?? '',
    isOption && property['type'] === 'array' ? '[repeatable]' : '',
    isRequired(entry, name, property) ? '[required]' : '',
    choices !== undefined && (!isOption || isLongChoices(choices)) ? `[choices: ${choices.join(', ')}]` : '',
    ...defaultMarks(flagsOf(entry, name), property),
    ...rangeMarks(elementOf(property)),
  ].filter(part => part !== '').join(' '))
}

function positionalRow(entry: Entry, name: string, notes: AuthoredNotes | undefined): ExpectedRow {
  const shown = entry.input.required.includes(name) ? `<${name}>` : `[${name}]`
  const label = propertyOf(entry, name)['type'] === 'array' ? `${shown}...` : shown
  return { name: label, text: normalized(`${label} ${descriptionOf(entry, name, notes, false)}`) }
}

/**
オプションの名前。短い形、長い形、別名、否定形の順に `, ` でつなぎ、値を取るなら型を付ける
*/
function optionRow(entry: Entry, name: string, notes: AuthoredNotes | undefined): ExpectedRow {
  const property = propertyOf(entry, name)
  const [long = '', ...others] = flagsOf(entry, name)
  const short = others.filter(flag => /^-[^-]/u.test(flag))
  const alias = others.filter(flag => flag.startsWith('--') && !flag.startsWith('--no-'))
  const negation = others.filter(flag => flag.startsWith('--no-'))
  const choices = choicesOf(property)
  const fallback = elementOf(property)['type'] === 'integer' ? '<int>' : '<str>'
  const metavar = choices === undefined || isLongChoices(choices) ? fallback : `<${choices.join('|')}>`
  const forms = [...short, long, ...alias, ...negation].join(', ')
  const label = property['type'] === 'boolean' ? forms : `${forms} ${metavar}`
  return { name: label, text: normalized(`${label} ${descriptionOf(entry, name, notes, true)}`) }
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

/**
2 列の節（Arguments・Options）の行のかたまりを、期待した行と 1 対 1 で比べ、合わなかった行の名前か中身を返す。
名前は行の先頭の完全一致（字下げ 2 + 名前 + 行末か空白 2 つ以上）で見る
*/
function unmatchedRows(lines: readonly string[], rows: readonly ExpectedRow[]): readonly string[] {
  const chunks = chunksOf(lines, isNameLine)
  const isRowAt = (row: ExpectedRow, chunk: readonly string[]): boolean => unwrapped(chunk) === row.text && (chunk[0] === `  ${row.name}` || chunk[0]?.startsWith(`  ${row.name}  `) === true)
  const missing = rows.filter(row => chunks.every(chunk => !isRowAt(row, chunk))).map(row => row.name)
  const extra = chunks.filter(chunk => rows.every(row => unwrapped(chunk) !== row.text)).map(chunk => unwrapped(chunk))
  return [...missing, ...extra]
}

function expectBullets(lines: readonly string[] | undefined, items: readonly string[]): void {
  expect(lines === undefined).toBe(items.length === 0)
  expect(chunksOf(lines ?? [], isBulletLine).map(chunk => unwrapped(chunk))).toEqual(items.map(item => normalized(`- ${item}`)))
}

function expectHelpMatchesDefinition(definition: CommandDefinition, text: string): void {
  const entry = entryOf(definition)
  const notes = notesOf(definition)
  const sections = sectionsOf(text)
  const positional = entry.cli.positional.map(name => positionalRow(entry, name, notes))
  const options = Object.keys(entry.input.properties).filter(name => !entry.cli.positional.includes(name)).map(name => optionRow(entry, name, notes))
  expect(unwrapped(sections.get('Usage') ?? [])).toBe(['Usage: pecot', ...definition.path, '[OPTIONS]', ...positional.map(row => row.name)].join(' '))
  expect(unwrapped(sections.get('Description') ?? [])).toBe(normalized(entry.description))

  const argumentLines = sections.get('Arguments')
  expect(argumentLines === undefined).toBe(positional.length === 0)
  expect(unmatchedRows(argumentLines ?? [], positional)).toEqual([])
  expect(chunksOf(argumentLines ?? [], isNameLine).map(chunk => unwrapped(chunk))).toEqual(positional.map(row => row.text))

  const optionLines = sections.get('Options') ?? []
  expect(unmatchedRows(optionLines, [...options, { name: '--help', text: '--help Show this message and exit.' }])).toEqual([])
  expect(optionLines.findLast(line => isNameLine(line))).toMatch(/^ {2}--help(?: |$)/u)

  expectBullets(sections.get('Constraints'), notes?.constraints.flatMap(constraint => constraintSentences(definition, constraint)) ?? [])
  expectBullets(sections.get('Details'), notes?.details ?? [])
  const examples = notes?.examples ?? []
  const exampleLines = sections.get('Examples')
  expect(exampleLines === undefined).toBe(examples.length === 0)
  const exampleChunks = chunksOf(exampleLines ?? [], isNameLine)
  expect(exampleChunks.map(chunk => chunk[0])).toEqual(examples.map(example => `  ${example.run}`))
  expect(exampleChunks.map(chunk => unwrapped(chunk))).toEqual(examples.map(example => normalized(`${example.run} ${example.note}`)))
}

const commandRows = COMMANDS.flatMap(definition => WIDTHS.map(width => ({ name: definition.path.join(' '), definition, width })))

describe('全コマンドの --help は定義書の中身を全部出す', () => {
  it.for(commandRows)('$name を幅 $width で打つと、定義書の項目を全部出す', async ({ definition, width }) => {
    const text = await helpOf(definition.path, width)
    expectHelpMatchesDefinition(definition, text)
    // 幅を超えてよいのは、Examples の打つ形の行だけ
    const runs = new Set(notesOf(definition)?.examples.map(example => `  ${example.run}`))
    expect(text.split('\n').filter(line => cellLength(line) > width && !runs.has(line))).toEqual([])
    expect(text).not.toMatch(/[╭│╰…]/u)
    expect(text).not.toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u)
    expect(text).not.toMatch(/ $/mu)
  })

  it('全コマンドで、説明の欠けた項目が無い', () => {
    const missing = COMMANDS
      .map(definition => ({ path: definition.path.join(' '), items: missingHelpItems(definition, notesOf(definition)) }))
      .filter(entry => entry.items.length > 0)
    expect(missing).toEqual([])
  })

  it('定義書の項目を持たないコマンドは無く、default_notes を持つ項目がある', () => {
    expect(COMMANDS.filter(definition => notesOf(definition) === undefined).map(definition => definition.path.join(' '))).toEqual([])
    expect(COMMANDS.some(definition => (notesOf(definition)?.defaultNotes.size ?? 0) > 0)).toBe(true)
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
  const notes: AuthoredNotes = { details: ['A detail.'], constraints: [], examples: [], defaultNotes: new Map() }

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
    const rows = chunksOf(sectionsOf(text).get('Commands') ?? [], isNameLine)
    const children = childrenOf(group)
    expect(rows.map(row => row[0]?.trimStart().split(/ {2,}/u, 1)[0])).toEqual(expect.arrayContaining(children.map(([name]) => name)))
    expect(rows).toHaveLength(children.length)
    // 単独のコマンドは、名前と説明が 1 つのかたまりに完全一致で出る。グループの説明は、次のケースで見る
    for (const [name, description] of children) {
      if (description === undefined) continue
      const row = rows.find(candidate => candidate[0] === `  ${name}` || candidate[0]?.startsWith(`  ${name}  `) === true)
      expect(row === undefined ? undefined : unwrapped(row)).toBe(normalized(`${name} ${description}`))
    }
    expect(text.split('\n').filter(line => cellLength(line) > width)).toEqual([])
    expect(text).not.toMatch(/[╭│╰…]/u)
  })

  it('COMMANDS の全グループが、ルートの Commands の行とグループの help の両方で、空でない説明を持つ', async () => {
    const root = chunksOf(sectionsOf(await helpOf([], 80)).get('Commands') ?? [], isNameLine)
    const withoutRootDescription = [...groupNames].filter(name => !name.includes(' ')).filter((name) => {
      const row = root.find(candidate => candidate[0]?.startsWith(`  ${name}  `) === true)
      return row === undefined || unwrapped(row) === name
    })
    expect(withoutRootDescription).toEqual([])
    const withoutGroupDescription: string[] = []
    for (const name of groupNames) {
      const description = sectionsOf(await helpOf(name.split(' '), 80)).get('Description') ?? []
      // 説明が無いと、2 つ目のかたまりが Options の節になり、Description には Options の見出しが入る
      if (description.length === 0 || description[0] === 'Options:') withoutGroupDescription.push(name)
    }
    expect(withoutGroupDescription).toEqual([])
  })
})
