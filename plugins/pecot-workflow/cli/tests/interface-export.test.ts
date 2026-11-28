/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時ファイルと定義書 */
// 定義書の書き出しの形と、--check / --write の動きを確かめる。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { authoredFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { TOOLS } from '../src/commands/registry.js'
import { defineTool, type CommandIo, type ToolDefinition } from '../src/commands/registry.js'
import { compareText } from '../../../../libs/interface-spec/src/domain/utility.js'
import { collectVerifiedIds, missingIds } from './_helpers/behavior-ids.js'
import { makeTemporaryDirectory, writeTree } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'
import vitestConfig from '../vitest.config.js'
import { exportEntries, exportNames, exportResources, main } from '../scripts/export-interface.js'
import { COMMAND_GROUPS, COMMAND_VERBS } from '@pecot/workflow-core/commands-shared/names.js'
import { explains } from './_helpers/explains.js'

const alpha = defineTool({
  name: 'alpha',
  title: 'Greet someone',
  description: 'Greet someone',
  input: z.strictObject({
    name: z.string().describe('Name to greet.'),
    count: z.int().default(3).describe('How many times.'),
    json: z.boolean().default(false).describe('Print JSON.'),
    mode: z.enum(['fast', 'slow']).default('fast').describe('Mode.'),
    verbose: z.boolean().default(true).describe('Be loud.'),
  }),
  output: z.strictObject({}),
  run: () => Promise.resolve(0),
})

const strings = z.array(z.string())

const beta = defineTool({
  name: 'beta',
  title: 'Read files',
  description: 'Read files.',
  input: z.strictObject({
    source: z.string().optional().describe('Optional source.'),
    files: strings.optional().describe('Files to read.'),
    label: strings.optional().describe('Labels.'),
    limit: z.int().min(1).max(10).default(5).describe('Upper limit.'),
  }),
  output: z.strictObject({}),
  run: () => Promise.resolve(0),
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
  it('区切りは _ で、語の位置はグループと動詞の 2 つ。後ろに自由な語を許さない', async () => {
    await explains('`exportNames` のテストです。語彙を書き出した場合に、区切りが `_` で、語の位置がグループと動詞の 2 つになり、後ろに自由な語を許さないことを確認します。')
    const names = exportNames()
    expect(names.separator).toBe('_')
    expect(names.rest).toBe(false)
    expect(names.positions.map(words => words.map(item => item.word))).toStrictEqual([COMMAND_GROUPS.map(group => group.name), COMMAND_VERBS.map(verb => verb.name)])
  })

  it('読むだけの動詞（list・show・get・check・doctor）にだけ read_only を付ける', async () => {
    await explains('`exportNames` のテストです。語彙を書き出した場合に、読むだけの動詞（`list`・`show`・`get`・`check`・`doctor`）にだけ `read_only` を付けることを確認します。')
    const marked = exportNames().positions.flat().filter(item => item.read_only === true).map(item => item.word)
    expect(marked).toStrictEqual(['list', 'show', 'get', 'check', 'doctor'])
  })

  it('語と意味だけを書き、グループの help は書かない', async () => {
    await explains('`exportNames` のテストです。見本のグループと動詞を渡した場合に、語と意味だけを書き、グループの `help` は書かないことを確認します。')
    expect(SAMPLE_NAMES.positions).toStrictEqual([
      [{ word: 'alpha', meaning: '見本のグループ' }],
      [{ word: 'show', meaning: '見本の読む動詞', read_only: true }, { word: 'add', meaning: '見本の書く動詞' }],
    ])
  })
})

describe('exportResources', () => {
  it('テンプレートの resource を、URI・名前・題・説明・MIME 型の形で、登録の順に返す', async () => {
    await explains('`exportResources` のテストです。テンプレートの resource を書き出した場合に、URI・名前・題・説明・MIME 型の形で、登録の順に 12 件を返すことを確認します。')
    const resources = exportResources()
    expect(resources).toHaveLength(12)
    expect(resources[0]).toStrictEqual({
      uri: 'pecot-template://comment/plan',
      name: 'comment/plan',
      title: 'Plan comment',
      description: 'Template of the plan comment posted on an Issue before implementation (issue_comment_check, then add_issue_comment or update_issue_comment)',
      mimeType: 'text/markdown',
    })
    expect(resources.map(resource => resource.uri).at(-1)).toBe('pecot-template://pr/release')
  })
})

describe('exportEntries', () => {
  const entries = exportEntries([beta, alpha])

  it('見本の書き出し全体が node-sample.json と同じバイト列になる', async () => {
    await explains('`exportEntries` のテストです。見本のツールを書き出した場合に、全体が `node-sample.json` と同じバイト列になることを確認します。')
    const file = { format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: SAMPLE_NAMES, entries: exportEntries(samples) }
    const expected = readFileSync(path.resolve(import.meta.dirname, 'interface-export/node-sample.json'), 'utf8')
    expect(`${JSON.stringify(file, undefined, 2)}\n`).toBe(expected)
  })

  it('項目は id の順に並ぶ', async () => {
    await explains('`exportEntries` のテストです。順番が逆の 2 つのツールを渡した場合に、項目が `id` の順に並ぶことを確認します。')
    expect(entries.map(entry => entry.id)).toStrictEqual(['PW-ALPHA', 'PW-BETA'])
  })

  it('surfaces は mcp.tool だけを持つ', async () => {
    await explains('`exportEntries` のテストです。ツールを書き出した場合に、`surfaces` が `mcp.tool` だけを持つことを確認します。')
    expect(entries.map(entry => entry.surfaces)).toStrictEqual([
      { mcp: { tool: 'alpha' } },
      { mcp: { tool: 'beta' } },
    ])
  })

  it('mcp は、ツールの定義の title を output より先に持ち、annotations を最後に持つ', async () => {
    await explains('`exportEntries` のテストです。ツールを書き出した場合に、`mcp` がツールの定義の `title` を `output` より先に持ち、`annotations` を最後に持つことを確認します。')
    expect(entries.map(entry => entry.mcp.title)).toStrictEqual(['Greet someone', 'Read files'])
    expect(Object.keys(entries[0]?.mcp ?? {})).toStrictEqual(['title', 'output', 'annotations'])
  })

  it('mcp.annotations の readOnlyHint は、動詞が読むだけの印を持つときだけ true になる', async () => {
    await explains('`exportEntries` のテストです。読むだけの動詞を持つツールを書き出した場合に、その項目だけ `mcp.annotations` の `readOnlyHint` が `true` になることを確認します。')
    const show = defineTool({ name: 'alpha_show', title: 'Show alpha', description: 'Show alpha.', input: z.strictObject({}), output: z.strictObject({}), run: () => Promise.resolve(0) })
    expect(exportEntries([show, alpha]).map(entry => entry.mcp.annotations)).toStrictEqual([{ readOnlyHint: false }, { readOnlyHint: true }])
  })

  it('項目のキーは contracts の例の順', async () => {
    await explains('`exportEntries` のテストです。ツールを書き出した場合に、項目のキーが `contracts` の例と同じ順に並ぶことを確認します。')
    expect(Object.keys(entries[0] ?? {})).toStrictEqual(['id', 'name', 'description', 'surfaces', 'hidden', 'deprecated', 'input', 'mcp'])
  })

  it('グローバルの repo は input に出さない', async () => {
    await explains('`exportEntries` のテストです。ツールを書き出した場合に、グローバルの `repo` を `input` に出さないことを確認します。')
    expect(Object.keys(entries[0]?.input.properties ?? {})).not.toContain('repo')
  })

  it('自分の repo を持つツール（hasOwnRepo）は、repo を input に出し、required には入れない', async () => {
    await explains('`exportEntries` のテストです。自分の `repo` を持つツール（`hasOwnRepo`）を書き出した場合に、`repo` を `input` へ出し、`required` には入れないことを確認します。')
    const own = defineTool({
      name: 'own',
      title: 'Test tool',
      description: 'Has its own repo.',
      input: z.strictObject({
        json: z.boolean().default(false).describe('Print JSON.'),
        repo: z.string().optional().describe('Target repository.'),
      }),
      hasOwnRepo: true,
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
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
  })

  it('input.properties のキーは名前の順、引数の中のキーは決めた順', async () => {
    await explains('`exportEntries` のテストです。ツールを書き出した場合に、`input.properties` のキーが名前の順になり、引数の中のキーが決めた順になることを確認します。')
    const alphaEntry = entries[0]
    expect(Object.keys(alphaEntry?.input.properties ?? {})).toStrictEqual(['count', 'json', 'mode', 'name', 'verbose'])
    expect(Object.keys(alphaEntry?.input.properties['mode'] ?? {})).toStrictEqual(['type', 'enum', 'default', 'description'])
    expect(Object.keys(entries[1]?.input.properties['limit'] ?? {})).toStrictEqual(['type', 'minimum', 'maximum', 'default', 'description'])
    expect(Object.keys(entries[1]?.input.properties['files'] ?? {})).toStrictEqual(['type', 'items', 'description'])
  })

  it('required が空でも [] を出し、additionalProperties: false を付け、$schema を外す', async () => {
    await explains('`exportEntries` のテストです。`required` が空のツールを書き出した場合に、`[]` を出し、`additionalProperties: false` を付け、`$schema` を外すことを確認します。')
    const input = entries[1]?.input
    expect(input?.required).toStrictEqual([])
    expect(input?.additionalProperties).toBe(false)
    expect(Object.keys(input ?? {})).toStrictEqual(['type', 'properties', 'required', 'additionalProperties'])
  })

  it('z.int() の安全な整数の端を、items の中も含めて外す', async () => {
    await explains('`exportEntries` のテストです。`z.int()` を持つ入力を書き出した場合に、安全な整数の端を `items` の中も含めて外し、`integer` だけにすることを確認します。')
    const integers = z.array(z.int())
    const gamma = defineTool({
      name: 'gamma',
      title: 'Test tool',
      description: 'Numbers.',
      input: z.strictObject({ one: z.int().optional(), many: integers.optional() }),
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
    })
    const [entry] = exportEntries([gamma])
    expect(entry?.input.properties).toStrictEqual({
      many: { type: 'array', items: { type: 'integer' } },
      one: { type: 'integer' },
    })
  })

  it('空を断る配列は、minItems と、items の中の minLength を決めた順で出す', async () => {
    await explains('`exportEntries` のテストです。空を断る配列を書き出した場合に、`minItems` と `items` の中の `minLength` を決めた順で出すことを確認します。')
    const nonEmpty = z.string().min(1)
    const lanes = z.array(nonEmpty).min(1).optional().describe('Lanes.')
    const delta = defineTool({
      name: 'delta',
      title: 'Test tool',
      description: 'Lanes.',
      input: z.strictObject({ lanes }),
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
    })
    const [entry] = exportEntries([delta])
    expect(entry?.input.properties['lanes']).toStrictEqual({ type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Lanes.' })
    expect(Object.keys(entry?.input.properties['lanes'] ?? {})).toStrictEqual(['type', 'items', 'minItems', 'description'])
  })

  it('id は名前を大文字にし、_ を - にする', async () => {
    await explains('`exportEntries` のテストです。`_` を含む名前のツールを書き出した場合に、`id` は名前を大文字にして、`_` を `-` にすることを確認します。')
    const [entry] = exportEntries([defineTool({
      name: 'sub_add-to_x',
      title: 'Test tool',
      description: 'Sub.',
      input: z.strictObject({}),
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
    })])
    expect(entry?.id).toBe('PW-SUB-ADD-TO-X')
    expect(entry?.name).toBe('sub_add-to_x')
  })
})

describe('exportEntries の失敗と refine', () => {
  function commandOf(shape: Readonly<Record<string, z.ZodType>>): ReturnType<typeof defineTool> {
    return defineTool({ name: 'bad_cmd', title: 'Test tool', description: 'Bad.', input: z.strictObject(shape), output: z.strictObject({}), run: () => Promise.resolve(0) })
  }

  it('全体の refine を持つ input でも書き出せ、repo を出さない', async () => {
    await explains('`exportEntries` のテストです。全体の `refine` を持つ入力のツールを書き出した場合に、書き出しに成功し、`repo` を出さないことを確認します。')
    const refined = defineTool({
      name: 'refined',
      title: 'Test tool',
      description: 'Refined.',
      input: z.strictObject({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a !== undefined || value.b !== undefined),
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
    })
    const [entry] = exportEntries([refined])
    expect(Object.keys(entry?.input.properties ?? {})).toStrictEqual(['a', 'b'])
    expect(entry?.input.required).toStrictEqual([])
  })

  it.each([
    ['exclusiveMinimum', z.number().int().gt(0), 'bad_cmd: n: unsupported JSON Schema key exclusiveMinimum'],
    ['maxLength', z.string().max(5), 'bad_cmd: n: unsupported JSON Schema key maxLength'],
    ['pattern', z.string().regex(/^a$/), 'bad_cmd: n: unsupported JSON Schema key pattern'],
    ['format', z.email(), 'bad_cmd: n: unsupported JSON Schema key format'],
    ['anyOf の枝の中の maxLength', z.union([z.string().max(5), strings]), 'bad_cmd: n: unsupported JSON Schema key maxLength'],
    ['items の中の maxLength', z.array(z.string().max(5)), 'bad_cmd: n: unsupported JSON Schema key maxLength'],
  ])('表に無い %s は、ツールと引数の名前を付けて止める', async (_label, schema, message) => {
    await explains(`\`exportEntries\` のテストです。表に無い \`${_label}\` を持つ入力を書き出した場合に、ツールと引数の名前を付けたエラーで止めることを確認します。`)
    expect(() => exportEntries([commandOf({ n: schema })])).toThrow(message)
  })
})

const IncludeSchema = z.object({ include: z.array(z.string()) })
const ProjectSchema = z.object({ test: IncludeSchema })
const ConfigSchema = z.object({ test: z.object({ projects: z.array(ProjectSchema) }) })

const generated = path.resolve(import.meta.dirname, '../../interface/generated.json')
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/export-interface.ts --write'

function fileOf(commands: Parameters<typeof exportEntries>[0]): Record<string, unknown> {
  return { format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries: exportEntries(commands), resources: exportResources() }
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
  it('挿入順のまま、字下げ 2・末尾に改行 1 つで書き、wrote の行を出して 0 を返す', async () => {
    await explains('`main` の `--write` のテストです。書き込みを実行した場合に、挿入順のまま、字下げ 2 と末尾の改行 1 つで書き、`wrote` の行を出して 0 を返すことを確認します。')
    const target = temporaryTarget()
    const result = run('--write', target)
    expect(result.code).toBe(0)
    expect(result.out).toStrictEqual([`wrote: ${target}\n`])
    expect(result.error).toStrictEqual([])
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify(fileOf(samples), undefined, 2)}\n`)
  })

  it('書いたファイルは --check が 0 を返す', async () => {
    await explains('`main` の `--write` のテストです。書き込んだファイルを `--check` で調べた場合に、終了コード 0 を返し、何も出力しないことを確認します。')
    const target = temporaryTarget()
    run('--write', target)
    expect(run('--check', target)).toStrictEqual({ code: 0, out: [], error: [] })
  })

  it('古い定義書を書き換える', async () => {
    await explains('`main` の `--write` のテストです。中身が古い定義書に書き込みを実行した場合に、書き換えて、`--check` が 0 を返すことを確認します。')
    const target = temporaryTarget('{}')
    expect(run('--write', target).code).toBe(0)
    expect(run('--check', target).code).toBe(0)
  })

  it('書けなければ、cannot write の行を出して 1 を返す', async () => {
    await explains('`main` の `--write` のテストです。書き込めない場所を指定した場合に、`cannot write` の行を出して 1 を返すことを確認します。')
    const target = path.join(makeTemporaryDirectory(), 'missing', 'generated.json')
    const result = run('--write', target)
    expect(result.code).toBe(1)
    expect(result.error).toHaveLength(1)
    expect(result.error[0]).toMatch(/^error: cannot write \S+generated\.json: ENOENT/v)
  })

  it('登録が 0 件でも、空の項目で書く', async () => {
    await explains('`main` の `--write` のテストです。登録されたツールが 0 件の場合に、空の項目でファイルを書くことを確認します。')
    const target = temporaryTarget()
    expect(run('--write', target, []).code).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries: [], resources: exportResources() }, undefined, 2)}\n`)
  })

  it('モードの指定が無い・不正なら 2 を返す', async () => {
    await explains('`main` の `--write` のテストです。モードの指定が無い場合と、`--check` と `--write` を同時に指定した場合に、使い方の誤りとして 2 を返すことを確認します。')
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
  it('実物の generated.json は、登録済みのツールと一致して 0 を返す', async () => {
    await explains('`main` の `--check` のテストです。実物の `generated.json` を調べた場合に、登録済みのツールと一致して 0 を返し、何も出力しないことを確認します。')
    const { io, out, error } = capture()
    expect(main(['--check'], io)).toBe(0)
    expect({ out, error }).toStrictEqual({ out: [], error: [] })
  })

  it('実物の generated.json を書き換えない', async () => {
    await explains('`main` の `--check` のテストです。実物の `generated.json` を調べ、別の場所へ書き込みを実行した場合に、実物の内容が変わらないことを確認します。')
    const before = readFileSync(generated)
    run('--check', generated)
    run('--write', temporaryTarget())
    expect(readFileSync(generated).equals(before)).toBe(true)
  })

  it('書式が違っても中身が同じなら、差の行は出さずに stale の行だけで 1 を返す', async () => {
    await explains('`main` の `--check` のテストです。書式が違っても中身が同じ定義書を調べた場合に、差の行は出さず、`stale` の行だけで 1 を返すことを確認します。')
    const compact = temporaryTarget(JSON.stringify(fileOf(samples)))
    const result = run('--check', compact)
    expect(result.code).toBe(1)
    expect(result.error).toStrictEqual([
      expect.stringMatching(/^error: \S+generated\.json is stale\n$/v),
      `  run: ${WRITE_COMMAND}\n`,
    ])
  })

  it('欄の値の差は 1 を返し、前と後の値と直すコマンドを formatStale の形で出す', async () => {
    await explains('`main` の `--check` のテストです。欄の値が違う定義書を調べた場合に、1 を返し、前と後の値と直すコマンドを `formatStale` の形で出すことを確認します。')
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

  it('surfaces.mcp の差も 1 を返す', async () => {
    await explains('`main` の `--check` のテストです。`surfaces.mcp` の値が違う定義書を調べた場合に、1 を返し、差の行を出すことを確認します。')
    const file = fileOf(samples)
    entryOf(file, 'PW-ALPHA')['surfaces'] = { mcp: { tool: 'renamed' } }
    const result = checkOf(file)
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-ALPHA: surfaces.mcp.tool: "renamed" -> "alpha"\n')
  })

  it('語彙の差も 1 を返し、names の欄のパスを出す', async () => {
    await explains('`main` の `--check` のテストです。語彙が違う定義書を調べた場合に、1 を返し、`names` の欄のパスを差の行へ出すことを確認します。')
    const file = fileOf(samples)
    file['names'] = { ...exportNames(), rest: true }
    const result = checkOf(file)
    expect(result.code).toBe(1)
    expect(result.error).toContain('  file: names.rest: true -> false\n')
  })

  it('Node にあって定義書に無い ID は 1 を返し、entry: added の行を出す', async () => {
    await explains('`main` の `--check` のテストです。Node にあって定義書に無い ID を調べた場合に、1 を返し、`entry: added` の行を出すことを確認します。')
    const result = checkOf(fileOf([alpha]))
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-BETA: entry: added\n')
  })

  it('定義書にあって Node に無い ID も 1 を返し、entry: removed の行を出す', async () => {
    await explains('`main` の `--check` のテストです。定義書にあって Node に無い ID を調べた場合に、1 を返し、`entry: removed` の行を出すことを確認します。')
    const target = temporaryTarget(textOf(fileOf(samples)))
    const result = run('--check', target, [alpha])
    expect(result.code).toBe(1)
    expect(result.error).toContain('  PW-BETA: entry: removed\n')
  })

  it('Node にだけある欄のキーは 1 を返し、added の行を出す', async () => {
    await explains('`main` の `--check` のテストです。Node にだけある欄のキーを調べた場合に、1 を返し、`added` の行を出すことを確認します。')
    const file = fileOf(samples)
    Reflect.deleteProperty(entryOf(file, 'PW-BETA'), 'mcp')
    expect(checkOf(file).error).toContain('  PW-BETA: mcp: added\n')
  })

  it('定義書にだけある欄のキーは 1 を返し、removed の行を出す', async () => {
    await explains('`main` の `--check` のテストです。定義書にだけある欄のキーを調べた場合に、1 を返し、`removed` の行を出すことを確認します。')
    const file = fileOf(samples)
    entryOf(file, 'PW-BETA')['input'] = { ...exportEntries([beta])[0]?.input, only: { dry_run: { type: 'boolean' } } }
    expect(checkOf(file).error).toContain('  PW-BETA: input.only: removed\n')
  })

  describe('定義書を読めないとき', () => {
    it('ファイルが無ければ、cannot read と直すコマンドを出して 1 を返す', async () => {
      await explains('`main` の `--check` のテストです。定義書のファイルが存在しない場合に、`cannot read` と直すコマンドを出して 1 を返すことを確認します。')
      const result = run('--check', temporaryTarget())
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: ENOENT.*\n {2}run: pnpm /v)
    })

    it('JSON でなければ、cannot read の行を出して 1 を返す', async () => {
      await explains('`main` の `--check` のテストです。定義書が JSON でない場合に、`cannot read` の行を出して 1 を返すことを確認します。')
      const result = run('--check', temporaryTarget('{'))
      expect(result.code).toBe(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: .*JSON/v)
    })

    it('スキーマに合わなければ、cannot read の行を出して 1 を返す', async () => {
      await explains('`main` の `--check` のテストです。定義書がスキーマと合わない場合は、`cannot read` の行を出して 1 を返すことを確認します。')
      const result = run('--check', temporaryTarget('{"a":1}'))
      expect(result.code).toBe(1)
      expect(result.error[0]).toMatch(/^error: cannot read \S+generated\.json: /v)
    })
  })

  describe('Node の側の項目が不正なとき', () => {
    const broken = defineTool({
      name: 'broken',
      title: 'Test tool',
      description: 'Has no description',
      input: z.strictObject({}),
      output: z.strictObject({}),
      run: () => Promise.resolve(0),
    })

    it('項目がスキーマに合わなければ、invalid entries の行を出して 1 を返し、ファイルを書かない', async () => {
      await explains('`main` の `--write` のテストです。Node の側の項目がスキーマと合わない場合は、`invalid entries` の行を出して 1 を返し、ファイルを書かないことを確認します。')
      const target = temporaryTarget()
      // eslint-disable-next-line no-restricted-syntax -- スキーマに合わない定義を渡すため、型を外す
      const result = run('--write', target, [{ ...broken, description: undefined } as unknown as ToolDefinition])
      expect(result.code).toBe(1)
      expect(result.error).toHaveLength(1)
      expect(result.error[0]).toMatch(/^error: invalid entries: /v)
      expect(() => readFileSync(target)).toThrow('ENOENT')
    })

    it('同じ ID のツールが 2 つあれば、重複した ID を示す error の行を出して 1 を返す', async () => {
      await explains('`main` の `--check` のテストです。同じ ID のツールが 2 つある場合に、重複した ID を示す `error` の行を出して 1 を返すことを確認します。')
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

    it('verifies の引数の ID を集め、コメントの中の ID を数えない', async () => {
      await explains('`collectVerifiedIds` のテストです。ファイルを走査した場合に、`verifies` の引数の ID を集め、コメントの中の ID を数えないことを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      const ids = collectVerifiedIds(directory, ['tests/interface/**/*.test.ts', 'src/**/tests/**/*.test.ts'])
      expect([...ids].toSorted(compareText)).toStrictEqual([idOf('A'), idOf('D'), idOf('H')])
    })

    it('引数がリテラルでない verifies を持つファイルでは、行の ID を数える', async () => {
      await explains('`collectVerifiedIds` のテストです。引数がリテラルでない `verifies` を持つファイルを走査した場合に、行の ID を数えることを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      expect(collectVerifiedIds(directory, ['tests/interface/rows.test.ts'])).toStrictEqual(new Set([idOf('D')]))
    })

    it('リテラルだけのファイルでは、verifies の外にある ID のリテラルを数えない', async () => {
      await explains('`collectVerifiedIds` のテストです。リテラルだけのファイルを走査した場合に、`verifies` の外にある ID のリテラルを数えないことを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/lit.test.ts': `const x = '${idOf('X')}'\n${callOf('Y')}\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set([idOf('Y')]))
    })

    it('桁が続く ID は、前の桁までの ID として数えない', async () => {
      await explains('`collectVerifiedIds` のテストです。桁が続く ID を含むファイルを走査した場合に、前の桁までの ID として数えないことを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/long.test.ts': `${CALL}context, row.id)\nconst x = '${idOf('L')}1'\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set())
    })

    it('文字列の中の // をコメントとして扱わない', async () => {
      await explains('`collectVerifiedIds` のテストです。文字列の中に `//` や `/*` を含むファイルを走査した場合に、それをコメントとして扱わないことを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, { 'tests/interface/str.test.ts': `const a = 'a // b'; ${callOf('S')}\nconst b = "/* c"; ${callOf('T')} */\n` })
      expect(collectVerifiedIds(directory, ['tests/**/*.test.ts'])).toStrictEqual(new Set([idOf('S'), idOf('T')]))
    })

    it('include に当たらないファイルと tests/parity の ID を数えない', async () => {
      await explains('`collectVerifiedIds` のテストです。`include` に当たらないファイルと `tests/parity` のファイルを走査した場合に、それらの ID を数えないことを確認します。')
      const directory = makeTemporaryDirectory()
      writeTree(directory, files)
      const ids = collectVerifiedIds(directory, ['tests/**/*.test.ts'])
      expect(ids.has(idOf('F'))).toBe(false)
      expect(ids.has(idOf('H'))).toBe(false)
      expect(ids.has(idOf('G'))).toBe(true)
    })

    it('無い ID を、並べて返す', async () => {
      await explains('`missingIds` のテストです。期待する ID の一覧と集めた ID を比較した場合に、存在しない ID を重複なく並べて返すことを確認します。')
      const missing = missingIds([idOf('Z'), idOf('A'), idOf('A')], new Set([idOf('B')]))
      expect(missing).toStrictEqual([idOf('A'), idOf('Z')])
    })
  })

  it('登録済みのツールの項目の ID が、すべて vitest の verifies につながる', async () => {
    await explains('振る舞いの項目のつなぎのテストです。登録済みのツールの項目の ID を調べた場合に、すべてが vitest の `verifies` につながっていることを確認します。')
    const missing = missingIds(expectedIds(TOOLS), collectVerifiedIds(root, include))
    expect(missing).toStrictEqual([])
  })

  it('共通の項目の ID が、すべて vitest の verifies につながる', async () => {
    await explains('振る舞いの項目のつなぎのテストです。共通の項目の ID（21 件）を調べた場合に、すべてが vitest の `verifies` につながっていることを確認します。')
    const common = authored.common_behaviors.map(behavior => behavior.id)
    expect(common).toHaveLength(21)
    expect(missingIds(common, collectVerifiedIds(root, include))).toStrictEqual([])
  })
})
