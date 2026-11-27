// actions/<処理>/action.yml の inputs・outputs から、interface/generated.json の項目を作る。
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { z } from 'zod'

import { diffGenerated, formatStale } from '../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../libs/interface-spec/src/domain/schema.js'
import type { GeneratedFile, Names } from '../../libs/interface-spec/src/domain/schema.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_TARGET = path.join(ROOT, 'interface', 'generated.json')
const WRITE_COMMAND = 'pnpm --dir actions exec tsx scripts/export-interface.ts --write'

const actionInputSchema = z.object({
  description: z.string(),
  required: z.boolean().optional(),
  default: z.string().optional(),
})
const actionOutputSchema = z.object({ description: z.string() })
const runsSchema = z.object({ using: z.literal('node24'), main: z.literal('dist/index.js') })

const actionFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), actionInputSchema).optional(),
  outputs: z.record(z.string(), actionOutputSchema).optional(),
  runs: runsSchema,
})

// 名前の語彙。1 語目が処理の対象、2 語目が動詞。意味は pecot-workflow の定義書の同じ語にそろえる
export const NAMES: Names = {
  separator: ' ',
  positions: [
    [
      { word: 'board', meaning: 'ボードの上の Issue の置き場所。設定ファイルは書かない' },
      { word: 'session', meaning: '1 つの Issue の作業の始まりから終わりまで' },
      { word: 'review', meaning: 'PR の自動レビューの実行' },
      { word: 'auto', meaning: 'Issue のラベルを契機にした自動処理の実行' },
      { word: 'tracker', meaning: 'Tracker の Issue の書き直し' },
      { word: 'release', meaning: 'リリース' },
    ],
    [
      { word: 'sync', meaning: 'GitHub の状態に合わせて書き直す' },
      { word: 'finish', meaning: '終わった後の片付けをする' },
      { word: 'gate', meaning: '動かすかどうかを決める' },
      { word: 'start', meaning: '始める' },
      { word: 'check', meaning: '確かめる' },
    ],
  ],
  rest: false,
}

interface CommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

type Entry = GeneratedFile['entries'][number]

/**
action のディレクトリ名（board-sync）から、項目の ID と名前を作る
*/
function sortedEntries<T>(record: Readonly<Record<string, T>> | undefined): [string, T][] {
  return Object.entries(record ?? {}).toSorted(([left], [right]) => left.localeCompare(right))
}

interface ActionInput {
  readonly description: string
  readonly required?: boolean | undefined
  readonly default?: string | undefined
}

function propertyOf(input: Readonly<ActionInput>): Record<string, string> {
  return input.default === undefined
    ? { type: 'string', description: input.description }
    : { type: 'string', default: input.default, description: input.description }
}

function entryOf(directory: string, text: string): Entry {
  const action = actionFileSchema.parse(parse(text))
  const inputs = sortedEntries(action.inputs)
  const properties = Object.fromEntries(inputs.map(([name, input]) => [name, propertyOf(input)]))
  const required = inputs.filter(([, input]) => input.required === true).map(([name]) => name)
  const outputs = sortedEntries(action.outputs)
  return {
    id: `PA-${directory.toUpperCase()}`,
    name: directory.replaceAll('-', ' '),
    description: action.description,
    surfaces: { action: { path: `actions/${directory}` } },
    hidden: false,
    deprecated: false,
    input: { type: 'object', properties, ...(required.length > 0 && { required }), additionalProperties: false },
    ...(outputs.length > 0 && { action: { outputs: Object.fromEntries(outputs.map(([name, output]) => [name, output.description])) } }),
  }
}

/**
root の直下で action.yml を持つディレクトリを、名前の順に読む
*/
export function exportEntries(root: string = ROOT): Entry[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのは actions/ の直下だけ
  const directories = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => readAction(root, name) !== undefined)
    .toSorted((left, right) => left.localeCompare(right))
  return directories.map(name => entryOf(name, readAction(root, name) ?? ''))
}

function readAction(root: string, name: string): string | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのは actions/<処理>/action.yml だけ
    return readFileSync(path.join(root, name, 'action.yml'), 'utf8')
  }
  catch {
    return undefined
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function serialize(file: Readonly<GeneratedFile>): string {
  return `${JSON.stringify(file, undefined, 2)}\n`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n', 1)[0] ?? 'unknown') : 'unknown'
}

/**
`--check` か `--write` を受ける。--check は作り直したものと target が違えば 1 を返す
*/
export function main(argv: readonly string[], io: CommandIo, options: { readonly root?: string, readonly target?: string } = {}): number {
  if (!(argv.length === 1 && (argv[0] === '--check' || argv[0] === '--write'))) {
    io.stderr('error: usage: export-interface.ts --check | --write\n')
    return 2
  }
  const target = options.target ?? DEFAULT_TARGET
  const shown = path.relative(path.resolve(ROOT, '..'), target)
  let file: GeneratedFile
  try {
    file = generatedFileSchema.parse({ format: 1, plugin: 'actions', prefix: 'PA', names: NAMES, entries: exportEntries(options.root) })
  }
  catch (error) {
    io.stderr(`error: invalid action.yml: ${reasonOf(error)}\n`)
    return 1
  }
  if (argv[0] === '--write') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    writeFileSync(target, serialize(file))
    io.stdout(`wrote: ${shown}\n`)
    return 0
  }
  let current: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    current = readFileSync(target, 'utf8')
  }
  catch (error) {
    io.stderr(`error: cannot read ${shown}: ${reasonOf(error)}\n  run: ${WRITE_COMMAND}\n`)
    return 1
  }
  if (current === serialize(file)) return 0
  const lines = diffGenerated(generatedFileSchema.parse(JSON.parse(current)), file)
  for (const line of formatStale(shown, lines, WRITE_COMMAND)) io.stderr(`${line}\n`)
  return 1
}

const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text) },
    stderr: (text) => { process.stderr.write(text) },
  })
}
