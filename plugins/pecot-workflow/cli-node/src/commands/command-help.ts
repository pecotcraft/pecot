/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
// コマンドごとの --help。引数とオプションは、定義書の書き出しと同じ normalizeInput を通して作る。
import { z } from 'zod'

import type { AuthoredNotes, Constraint } from '../infra/authored-notes.js'
import { bulletSection, definitionSection, examplesSection, HELP_OPTION, helpWidth, paragraph, usageLines } from './help-layout.js'
import type { DefinitionRow } from './help-layout.js'
import { isRecord, normalizeInput } from './input-schema.js'
import type { InputSchema, JsonObject } from './input-schema.js'
import { flagOf } from './names.js'
import type { CommandDefinition } from './registry.js'
import { describeRange } from './value-types.js'

const MAX_INLINE_CHOICES = 24

function isList(property: JsonObject): boolean {
  return property['type'] === 'array'
}

/**
複数回渡せる引数の要素。list でなければ引数そのもの
*/
function elementOf(property: JsonObject): JsonObject {
  const items = property['items']
  return isList(property) && isRecord(items) ? items : property
}

function choicesOf(property: JsonObject): readonly string[] | undefined {
  const choices = elementOf(property)['enum']
  return Array.isArray(choices) ? choices.map(String) : undefined
}

/**
選択肢を名前の列に並べると、列が広がって説明を置けなくなる長さか。長いときは型を `<str>` にして、説明の末尾に `[choices: a, b]` の形で出す
*/
function isLongChoices(choices: readonly string[]): boolean {
  return choices.join('|').length > MAX_INLINE_CHOICES
}

/**
値の型。`<str>`・`<int>`、選択肢は `<task|bug|epic|tracker>`
*/
function metavarOf(property: JsonObject): string {
  const choices = choicesOf(property)
  if (choices !== undefined && !isLongChoices(choices)) return `<${choices.join('|')}>`
  return elementOf(property)['type'] === 'integer' ? '<int>' : '<str>'
}

function rangeOf(property: JsonObject): string | undefined {
  const element = elementOf(property)
  const min = element['minimum']
  const max = element['maximum']
  if (typeof min !== 'number' && typeof max !== 'number') return undefined
  return describeRange(typeof min === 'number' ? min : undefined, typeof max === 'number' ? max : undefined)
}

/**
初期値の表示。真偽値は、初期値が真で否定形を持つものだけ、正の形の名前を出す。初期値が偽のものは、付けないことが初期値なので出さない
*/
function defaultOf(name: string, property: JsonObject, hasNegation: boolean): string | undefined {
  const value = property['default']
  if (property['type'] === 'boolean') return value === true && hasNegation ? name.replaceAll('_', '-') : undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  return typeof value === 'number' ? String(value) : undefined
}

interface Described {
  readonly name: string
  readonly property: JsonObject
  readonly isRequired: boolean
  readonly hasNegation: boolean
  readonly isOption: boolean
  /**
  定義書の default_notes の文。無ければ undefined
  */
  readonly defaultNote: string | undefined
}

/**
説明、初期値の補足の文、末尾の `[repeatable]`・`[required]`・`[choices: …]`・`[default: …]`・`[0<=x<=20]`
*/
function describeProperty(described: Readonly<Described>): string {
  const { name, property, isRequired, hasNegation, isOption, defaultNote = '' } = described
  const description = property['description']
  const fallback = defaultOf(name, property, hasNegation)
  const allChoices = choicesOf(property)
  const choices = isOption && allChoices !== undefined && !isLongChoices(allChoices) ? undefined : allChoices
  const range = rangeOf(property)
  return [
    typeof description === 'string' ? description : '',
    defaultNote,
    isOption && isList(property) ? '[repeatable]' : '',
    isRequired && property['type'] !== 'boolean' ? '[required]' : '',
    choices === undefined ? '' : `[choices: ${choices.join(', ')}]`,
    fallback === undefined ? '' : `[default: ${fallback}]`,
    range === undefined ? '' : `[${range}]`,
  ].filter(part => part !== '').join(' ')
}

function inputOf(definition: Readonly<CommandDefinition>): InputSchema {
  return normalizeInput(z.toJSONSchema(definition.input, { io: 'input' }), definition.path.join(' '), definition.hasOwnRepo)
}

function propertyOf(input: InputSchema, name: string): JsonObject {
  return Object.entries(input.properties).find(([key]) => key === name)?.[1] ?? {}
}

/**
グローバルの --repo でも満たせるので、自分の `--repo` を持つコマンドの repo は必須として出さない
*/
function isRequiredField(definition: Readonly<CommandDefinition>, input: InputSchema, name: string): boolean {
  return input.required.includes(name) && !(name === 'repo' && definition.hasOwnRepo)
}

function positionalName(name: string, input: InputSchema, isRequired: boolean): string {
  const shown = isRequired ? `<${name}>` : `[${name}]`
  return isList(propertyOf(input, name)) ? `${shown}...` : shown
}

/**
Usage 行の `[OPTIONS]` と位置引数。必須は `<名前>`、任意は `[名前]`、複数は `...`。
使い方の誤りの `synopsisOf` は `{名前}` の書式で golden が固定しているので、別に持つ
*/
function synopsisFrom(definition: Readonly<CommandDefinition>, input: InputSchema): string {
  const names = definition.positional.map(name => positionalName(name, input, isRequiredField(definition, input, name)))
  return ['[OPTIONS]', ...names].join(' ')
}

function argumentRows(definition: Readonly<CommandDefinition>, input: InputSchema, defaultNotes: ReadonlyMap<string, string>): readonly DefinitionRow[] {
  return definition.positional.map((name) => {
    const isRequired = isRequiredField(definition, input, name)
    return {
      name: positionalName(name, input, isRequired),
      description: describeProperty({ name, property: propertyOf(input, name), isRequired, hasNegation: false, isOption: false, defaultNote: defaultNotes.get(name) }),
    }
  })
}

/**
オプションの打つ形。短い形、長い形、別名、否定形の順に `, ` でつなぎ、値を取るなら型を付ける
*/
function optionName(definition: Readonly<CommandDefinition>, name: string, property: JsonObject): string {
  const forms = [definition.shortFlags.get(name), flagOf(name), definition.aliases.get(name), definition.negations.get(name)]
  const joined = forms.filter(form => form !== undefined).join(', ')
  return property['type'] === 'boolean' ? joined : `${joined} ${metavarOf(property)}`
}

function optionRows(definition: Readonly<CommandDefinition>, input: InputSchema, defaultNotes: ReadonlyMap<string, string>): readonly DefinitionRow[] {
  const rows = Object.keys(definition.input.shape)
    .filter(name => !definition.positional.includes(name) && Object.hasOwn(input.properties, name))
    .map((name): DefinitionRow => {
      const property = propertyOf(input, name)
      const hasNegation = definition.negations.has(name)
      return {
        name: optionName(definition, name, property),
        description: describeProperty({ name, property, isRequired: isRequiredField(definition, input, name), hasNegation, isOption: true, defaultNote: defaultNotes.get(name) }),
      }
    })
  return [...rows, HELP_OPTION]
}

/**
入力名を打つ形にする。位置引数は `<file>`、オプションは `--screenshot`
*/
function referenceOf(definition: Readonly<CommandDefinition>, name: string): string {
  return definition.positional.includes(name) ? `<${name}>` : flagOf(name)
}

function joinNames(names: readonly string[]): string {
  const last = names.at(-1) ?? ''
  return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`
}

/**
`requires: {message: [issue, template]}` は `--message requires --issue and --template`。
`conflicts: [file, screenshot]` は `<file> and --screenshot cannot be used together`
*/
function constraintSentences(definition: Readonly<CommandDefinition>, constraint: Constraint): readonly string[] {
  const reference = (name: string): string => referenceOf(definition, name)
  const referencesOf = (names: readonly string[]): string => joinNames(names.map(name => reference(name)))
  return 'conflicts' in constraint
    ? [`${referencesOf(constraint.conflicts)} cannot be used together`]
    : Object.entries(constraint.requires).map(([name, required]) => `${reference(name)} requires ${referencesOf(required)}`)
}

/**
コマンドの help。notes が undefined（定義書の手書きの側が読めない）なら Constraints・Details・Examples と初期値の補足を出さない。
Examples の打つ形の行は折り返さないので、幅を超えることがある。幅は 40 を下限にする
*/
export function commandHelpText(definition: Readonly<CommandDefinition>, notes: Readonly<AuthoredNotes> | undefined, columns: number): string {
  const width = helpWidth(columns)
  const input = inputOf(definition)
  const defaultNotes = notes?.defaultNotes ?? new Map<string, string>()
  const positional = argumentRows(definition, input, defaultNotes)
  const constraints = notes?.constraints.flatMap(constraint => constraintSentences(definition, constraint)) ?? []
  const sections = [
    usageLines(`pecot ${definition.path.join(' ')} ${synopsisFrom(definition, input)}`, width),
    paragraph(definition.description, width),
    ...positional.length === 0 ? [] : [definitionSection('Arguments', positional, width)],
    definitionSection('Options', optionRows(definition, input, defaultNotes), width),
    ...constraints.length === 0 ? [] : [bulletSection('Constraints', constraints, width)],
    ...notes === undefined || notes.details.length === 0 ? [] : [bulletSection('Details', notes.details, width)],
    ...notes === undefined || notes.examples.length === 0 ? [] : [examplesSection(notes.examples, width)],
  ]
  return `${sections.join('\n\n')}\n`
}
