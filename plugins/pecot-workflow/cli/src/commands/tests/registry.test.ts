import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { compareStrings } from '../../../tests/parity/baseline.js'
import { commandNameViolations } from '../names.js'
import { COMMANDS, defineCommand, findCommand, toolNameOf } from '../registry.js'
import { capture, exitWith } from './support.js'

const COMMAND_COUNT = 37
const GENERATED = path.resolve(import.meta.dirname, '../../../../interface/generated.json')
const EntrySchema = z.object({ id: z.string() })
const GeneratedSchema = z.object({ prefix: z.string(), entries: z.array(EntrySchema) })

describe('コマンドの一覧', () => {
  it('37 個が登録され、path は重複しない', () => {
    expect(COMMANDS).toHaveLength(COMMAND_COUNT)
    expect(new Set(COMMANDS.map(command => command.path.join(' '))).size).toBe(COMMAND_COUNT)
  })

  it('ID の集合が、定義書の項目の ID と同じになる', () => {
    const generated = GeneratedSchema.parse(JSON.parse(readFileSync(GENERATED, 'utf8')))
    const ids = COMMANDS.map(command => `${generated.prefix}-${command.path.join('-').toUpperCase().replaceAll('_', '-')}`)
    expect(ids.toSorted(compareStrings)).toEqual(generated.entries.map(entry => entry.id).toSorted(compareStrings))
  })

  it('全部の path が、コマンド名の決まりに合う', () => {
    expect(commandNameViolations(COMMANDS.map(command => command.path))).toEqual([])
  })

  it('1 語目のグループごとにまとまり、グループは決めた順に並ぶ', () => {
    const groups = COMMANDS.map(command => command.path.at(0)).filter((group, index, all) => group !== all.at(index - 1) || index === 0)
    expect(groups).toEqual(['project', 'repo', 'aggregation', 'issue', 'board', 'branch', 'pr', 'session', 'release', 'security', 'dependabot', 'worktree'])
  })

  it('toolName は重複せず、path から作られている', () => {
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
    for (const command of COMMANDS) expect(command.toolName).toBe(toolNameOf(command.path))
  })
})

describe('toolNameOf', () => {
  it('path を _ でつなぐ', () => {
    expect(toolNameOf(['issue', 'create'])).toBe('issue_create')
    expect(toolNameOf(['board', 'add'])).toBe('board_add')
    expect(toolNameOf(['aggregation', 'show'])).toBe('aggregation_show')
  })
})

describe('defineCommand', () => {
  const definition = defineCommand({
    path: ['issue', 'read'],
    description: 'Issue を読む',
    input: z.object({ issue_ref: z.string(), comment_limit: z.number().default(5) }),
    positional: ['issue_ref'],
    shortFlags: { comment_limit: '-c' },
    interactive: false,
    run: async (input, io) => {
      io.stdout(`${input.issue_ref} ${String(input.comment_limit)} ${input.repo ?? '-'}\n`)
      return await exitWith(3)
    },
  })

  it('path・toolName・説明・位置引数を持つ', () => {
    expect(definition.path).toEqual(['issue', 'read'])
    expect(definition.toolName).toBe('issue_read')
    expect(definition.description).toBe('Issue を読む')
    expect(definition.positional).toEqual(['issue_ref'])
    expect(definition.interactive).toBe(false)
    expect(definition.shortFlags).toEqual(new Map([['comment_limit', '-c']]))
  })

  it('グローバルの --repo を入力 repo として合成する', () => {
    expect(Object.keys(definition.input.shape)).toEqual(['issue_ref', 'comment_limit', 'repo'])
    expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 'a/b' }).success).toBe(true)
    expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 1 }).success).toBe(false)
  })

  it('入力を検証して既定値を足し、終了コードを返す', async () => {
    const io = capture()
    expect(await definition.run({ issue_ref: 'a/b/1', repo: 'x/y' }, io)).toBe(3)
    expect(io.out).toEqual(['a/b/1 5 x/y\n'])
  })

  it('repo が無ければ undefined のまま渡す', async () => {
    const io = capture()
    await definition.run({ issue_ref: 'a/b/1', comment_limit: 2 }, io)
    expect(io.out).toEqual(['a/b/1 2 -\n'])
  })

  it('入力が不正なら実行せずに ZodError を投げる', async () => {
    const io = capture()
    await expect(definition.run({ comment_limit: 2 }, io)).rejects.toBeInstanceOf(z.ZodError)
    expect(io.out).toEqual([])
  })

  it('shortFlags が無ければ空', () => {
    const plain = defineCommand({
      path: ['pr', 'read'],
      description: 'PR を読む',
      input: z.object({}),
      positional: [],
      interactive: true,
      run: async () => await exitWith(0),
    })
    expect(plain.shortFlags).toEqual(new Map())
    expect(plain.interactive).toBe(true)
  })

  it('hasOwnRepo のコマンドは、グローバルの repo を合成せず、自分の repo を使う', async () => {
    const received: unknown[] = []
    const own = defineCommand({
      path: ['own'],
      description: '',
      hasOwnRepo: true,
      input: z.object({ repo: z.string().optional(), name: z.string() }),
      positional: [],
      interactive: false,
      run: async (input) => {
        received.push(input)
        return await exitWith(0)
      },
    })
    expect(own.hasOwnRepo).toBe(true)
    expect(definition.hasOwnRepo).toBe(false)
    expect(Object.keys(own.input.shape)).toEqual(['repo', 'name'])
    await own.run({ repo: 'a/b', name: 'x' }, capture())
    expect(received).toEqual([{ repo: 'a/b', name: 'x' }])
    expect(() => own.parse({ name: 'x', repo: 1 })).toThrow(z.ZodError)
  })

  it('全体の refine を保ち、strictObject でも repo を受ける', async () => {
    const received: unknown[] = []
    const strict = defineCommand({
      path: ['strict'],
      description: '',
      input: z.strictObject({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a !== undefined || value.b !== undefined, 'a か b が要ります'),
      positional: [],
      interactive: false,
      run: async (input) => {
        received.push(input)
        return await exitWith(0)
      },
    })
    expect(strict.input.safeParse({ a: 'x', repo: 'o/r' }).success).toBe(true)
    expect(strict.input.safeParse({ repo: 'o/r' }).success).toBe(false)
    await strict.run({ a: 'x', repo: 'o/r' }, capture())
    expect(received).toEqual([{ a: 'x', repo: 'o/r' }])
    expect(() => strict.parse({})).toThrow(z.ZodError)
    await expect(strict.run({ a: 'x', extra: 1 }, capture())).rejects.toBeInstanceOf(z.ZodError)
  })

  it('parse は本体を呼ばず、検証した入力を持つ PreparedCommand を返す', async () => {
    const io = capture()
    const prepared = definition.parse({ issue_ref: 'a/b/1' })
    expect(io.out).toEqual([])
    expect(await prepared.run(io)).toBe(3)
    expect(io.out).toEqual(['a/b/1 5 -\n'])
  })

  it('aliases を持てる。無ければ空', () => {
    const aliased = defineCommand({
      path: ['al'],
      description: '',
      input: z.object({ allow_existing_branch: z.boolean().default(false) }),
      positional: [],
      aliases: { allow_existing_branch: '--force' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(aliased.aliases).toEqual(new Map([['allow_existing_branch', '--force']]))
    expect(definition.aliases).toEqual(new Map())
  })

  it('短いオプションと別名を同じ入力に持つと作れない', () => {
    expect(() => defineCommand({
      path: ['both'],
      description: '',
      input: z.object({ force: z.boolean().default(false) }),
      positional: [],
      shortFlags: { force: '-f' },
      aliases: { force: '--yes' },
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('negations を持てる', () => {
    const negated = defineCommand({
      path: ['neg'],
      description: '',
      input: z.object({ checkout: z.boolean().default(true) }),
      positional: [],
      negations: { checkout: '--no-checkout' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(negated.negations).toEqual(new Map([['checkout', '--no-checkout']]))
  })

  it('入力 no_x の `--no-x` と入力 x の否定形 `--no-x` が並んだら作れない', () => {
    expect(() => defineCommand({
      path: ['dup'],
      description: '',
      input: z.object({ x: z.boolean().default(true), no_x: z.boolean().default(false) }),
      positional: [],
      negations: { x: '--no-x' },
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(new TypeError('オプション --no-x が重複しています'))
  })

  it('入力 x の否定形 `--no-x` だけなら作れる', () => {
    const command = defineCommand({
      path: ['ok'],
      description: '',
      input: z.object({ x: z.boolean().default(true) }),
      positional: [],
      negations: { x: '--no-x' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(command.negations.get('x')).toBe('--no-x')
  })

  it('path が空なら作れない', () => {
    expect(() => defineCommand({
      path: [],
      description: '',
      input: z.object({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })
})

describe('findCommand', () => {
  it('path が一致するコマンドを返し、一致しなければ undefined を返す', () => {
    const command = defineCommand({
      path: ['pr', 'read'],
      description: '',
      input: z.object({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(findCommand(['pr', 'read'], [command])).toBe(command)
    expect(findCommand(['pr', 'merge'], [command])).toBeUndefined()
    expect(findCommand(['pr', 'merge'])).toBeUndefined()
  })
})
