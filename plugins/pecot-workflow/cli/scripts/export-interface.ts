// MCP のツールの一覧（TOOLS）から、interface/generated.json の項目を作る。
// 形と決定性の決めは specs/022-interface-definitions/contracts/definition-format.md にある。
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/server'

import { diffGenerated, formatStale } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema, type GeneratedFile, type Names } from '../../../../libs/interface-spec/src/domain/schema.js'
import { interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { normalizeInput } from '../src/commands/input-schema.js'
import { byName, COMMAND_GROUPS, COMMAND_VERBS } from '@pecot/workflow-core/commands-shared/names.js'
import type { CommandWord } from '@pecot/workflow-core/commands-shared/names.js'
import type { InputSchema } from '../src/commands/input-schema.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { TOOLS } from '../src/commands/registry.js'
import type { CommandIo, ToolDefinition } from '../src/commands/registry.js'
import { toolAnnotationsOf } from '../src/mcp/annotations.js'
import { toolOutputSchema } from '../src/mcp/result.js'
import { TEMPLATE_MIME_TYPE, TEMPLATE_RESOURCES, templateResourceName, templateUri } from '../src/mcp/templates.js'

export interface InterfaceEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly surfaces: { readonly mcp: { readonly tool: string } }
  readonly hidden: false
  readonly deprecated: false
  readonly input: InputSchema
  readonly mcp: { readonly title: string, readonly output: unknown, readonly annotations: Readonly<ToolAnnotations> }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function entryOf(tool: ToolDefinition): InterfaceEntry {
  return {
    id: interfaceIdOf(tool.name),
    name: tool.name,
    description: tool.description,
    surfaces: { mcp: { tool: tool.name } },
    hidden: false,
    deprecated: false,
    input: normalizeInput(z.toJSONSchema(z.strictObject(tool.input.shape), { io: 'input' }), tool.name, tool.hasOwnRepo),
    mcp: { title: tool.title, output: toolOutputSchema(tool.output), annotations: toolAnnotationsOf(tool) },
  }
}

/**
ツールの一覧から、generated.json の項目を id の順に作る
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
export function exportEntries(tools: readonly ToolDefinition[]): InterfaceEntry[] {
  return tools.map(tool => entryOf(tool)).toSorted((left, right) => byName(left.id, right.id))
}

function wordsOf(words: readonly CommandWord[]): Names['positions'][number] {
  return words.map(word => word.readOnly === true
    ? { word: word.name, meaning: word.meaning, read_only: true }
    : { word: word.name, meaning: word.meaning })
}

/**
ツール名の語彙（対象と動詞の 2 語、区切りは `_`）を、generated.json の names の形にする
*/
export function exportNames(groups: readonly CommandWord[] = COMMAND_GROUPS, verbs: readonly CommandWord[] = COMMAND_VERBS): Names {
  return { separator: '_', positions: [wordsOf(groups), wordsOf(verbs)], rest: false }
}

/**
MCP の resource（テンプレート）を、generated.json の resources の形にする。並びは TEMPLATE_RESOURCES の順
*/
export function exportResources(): NonNullable<GeneratedFile['resources']> {
  return TEMPLATE_RESOURCES.map(template => ({
    uri: templateUri(template),
    name: templateResourceName(template),
    title: template.title,
    description: template.description,
    mimeType: TEMPLATE_MIME_TYPE,
  }))
}

export interface MainOptions {
  // 比べる・書く定義書。既定は plugins/pecot-workflow/interface/generated.json
  readonly target?: string
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..')
const DEFAULT_TARGET = path.resolve(import.meta.dirname, '../../interface/generated.json')
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/export-interface.ts --write'

function reasonOf(error: unknown): string {
  if (error instanceof z.ZodError) return issuesOf(error)
  return error instanceof Error ? (error.message.split('\n', 1)[0] ?? 'unknown') : 'unknown'
}

/**
zod のエラーを「欄のパス: 文」に直す。複数あるときは先頭の 3 件を "; " でつなぐ
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function issuesOf(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  return shown.join('; ') + (error.issues.length > shown.length ? `; and ${String(error.issues.length - shown.length)} more` : '')
}

function duplicatesOf(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id)
    seen.add(id)
  }
  return [...duplicated].toSorted(byName)
}

function shownOf(target: string): string {
  const relative = path.relative(REPOSITORY_ROOT, target)
  return relative.startsWith('..') ? target : relative.split(path.sep).join('/')
}

/**
ツールの項目を、generated.json の書式（挿入順・字下げ 2・末尾に改行 1 つ）の文字列にする
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function serialize(file: Readonly<GeneratedFile>): string {
  return `${JSON.stringify(file, undefined, 2)}\n`
}

function build(entries: readonly InterfaceEntry[]): GeneratedFile {
  return generatedFileSchema.parse({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries, resources: exportResources() })
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function write(file: Readonly<GeneratedFile>, target: string, io: CommandIo): number {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    writeFileSync(target, serialize(file))
  }
  catch (error) {
    io.stderr(`error: cannot write ${shownOf(target)}: ${reasonOf(error)}\n`)
    return 1
  }
  io.stdout(`wrote: ${shownOf(target)}\n`)
  return 0
}

/**
定義書の全項目を、TOOLS から作った項目と比べる。絞り込みはしない
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function check(file: Readonly<GeneratedFile>, target: string, io: CommandIo): number {
  let lines: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    const current = readFileSync(target, 'utf8')
    if (current === serialize(file)) return 0
    lines = diffGenerated(generatedFileSchema.parse(JSON.parse(current)), file)
  }
  catch (error) {
    io.stderr(`error: cannot read ${shownOf(target)}: ${reasonOf(error)}\n  run: ${WRITE_COMMAND}\n`)
    return 1
  }
  const stale = formatStale(shownOf(target), lines, WRITE_COMMAND)
  for (const line of stale) io.stderr(`${line}\n`)
  return 1
}

/**
`--check` か `--write` を受ける
*/
export function main(argv: readonly string[], io: CommandIo, tools: readonly ToolDefinition[] = TOOLS, options: Readonly<MainOptions> = {}): number {
  const output = createOutput(false, io)
  if (!(argv.length === 1 && (argv[0] === '--check' || argv[0] === '--write'))) {
    output.error('usage: export-interface.ts --check | --write')
    return 2
  }
  const entries = exportEntries(tools)
  const duplicated = duplicatesOf(entries.map(entry => entry.id))
  if (duplicated.length > 0) {
    output.error(`duplicate ids: ${duplicated.join(', ')}`)
    return 1
  }
  let file: GeneratedFile
  try {
    file = build(entries)
  }
  catch (error) {
    output.error(`invalid entries: ${reasonOf(error)}`)
    return 1
  }
  const target = options.target ?? DEFAULT_TARGET
  return argv[0] === '--write' ? write(file, target, io) : check(file, target, io)
}

// Node の import.meta.main は engines の範囲で実験的な扱いなので、起動したファイルかどうかを realpath で比べて判定する
const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text) },
    stderr: (text) => { process.stderr.write(text) },
  })
}
