import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { compareStrings } from '../../../tests/parity/baseline.js'
import { COMMAND_PATHS } from '../../../tests/parity/commands.js'
import { COMMANDS, defineCommand, findCommand, toolNameOf } from '../registry.js'
import { capture, exitWith } from './support.js'

/**
Node へ未移植のコマンドの path。各 Phase が移植するたびに、ここから消す。Phase 7 で空になる
*/
const PENDING_PATHS: readonly (readonly string[])[] = [
  ['add-to-project'],
  ['update-issue-status'],
  ['create-branch'],
  ['delete-branch'],
  ['project', 'list'],
  ['project', 'search'],
  ['project', 'init'],
  ['project', 'create'],
  ['project', 'info'],
  ['project', 'activate'],
  ['project', 'set-repo'],
  ['project', 'set-aggregation-repo'],
  ['project', 'unset-aggregation-repo'],
  ['project', 'show-aggregation-repo'],
  ['issue', 'create'],
  ['issue', 'quick'],
  ['issue', 'read'],
  ['issue', 'comment'],
  ['issue', 'reopen'],
  ['pr', 'create'],
  ['pr', 'read'],
  ['pr', 'cleanup'],
  ['pr', 'preflight'],
  ['session', 'status'],
  ['session', 'restore'],
  ['release', 'preflight'],
  ['release', 'create'],
  ['release', 'merge'],
  ['security', 'sync'],
  ['dependabot', 'sync'],
  ['worktree', 'init'],
  ['worktree', 'add'],
  ['worktree', 'link'],
  ['worktree', 'remove'],
]

function keyOf(path: readonly string[]): string {
  return path.join(' ')
}

describe('コマンドの一覧', () => {
  it('未移植と移植済みを合わせて、前後比較の 34 個と一致する', () => {
    const registered = COMMANDS.map(command => keyOf(command.path))
    const pending = PENDING_PATHS.map(path => keyOf(path))
    expect([...registered, ...pending].toSorted(compareStrings)).toEqual(COMMAND_PATHS.map(path => keyOf(path)).toSorted(compareStrings))
    expect(registered.filter(key => pending.includes(key))).toEqual([])
    expect(registered.length + pending.length).toBe(34)
    expect(new Set([...registered, ...pending]).size).toBe(34)
  })

  it('toolName は重複せず、path から作られている', () => {
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
    for (const command of COMMANDS) expect(command.toolName).toBe(toolNameOf(command.path))
  })

  it('未移植の path は toolName が重複しない', () => {
    const names = PENDING_PATHS.map(path => toolNameOf(path))
    expect(new Set(names).size).toBe(34)
  })
})

describe('toolNameOf', () => {
  it('path を _ でつなぎ、- を _ にする', () => {
    expect(toolNameOf(['issue', 'create'])).toBe('issue_create')
    expect(toolNameOf(['add-to-project'])).toBe('add_to_project')
    expect(toolNameOf(['project', 'set-aggregation-repo'])).toBe('project_set_aggregation_repo')
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

  it('repo は予約名なので、input に持てない', () => {
    expect(() => defineCommand({
      path: ['x'],
      description: '',
      input: z.object({ repo: z.string() }),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow('予約名')
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
  it('path で引く', () => {
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
    expect(findCommand(['pr', 'read'])).toBeUndefined()
  })
})
