// defineCommand が作る定義の形と、run・parse の振る舞いを確かめる。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { capture, exitWith } from '../../../tests/_helpers/captured-io.js'
import { defineCommand, toolNameOf } from '../command-definition.js'

describe('toolNameOf', () => {
  it('コマンドの path を _ でつなぎ、MCP のツール名を作成する', async () => {
    await explains('コマンドの path から MCP のツール名を作成する関数（`toolNameOf`）のテストです。`[\'issue\', \'create\']` を渡すと `issue_create` になるなど、path の要素が `_` でつながることを確認します。')
    expect(toolNameOf(['issue', 'create'])).toBe('issue_create')
    expect(toolNameOf(['board', 'add'])).toBe('board_add')
    expect(toolNameOf(['tracker', 'sync'])).toBe('tracker_sync')
  })
})

describe('defineCommand', () => {
  const definition = defineCommand({
    path: ['issue', 'read'],
    title: 'Test command',
    description: 'Issue を読む',
    input: z.object({ issue_ref: z.string(), comment_limit: z.number().default(5) }),
    output: z.strictObject({}),
    positional: ['issue_ref'],
    shortFlags: { comment_limit: '-c' },
    interactive: false,
    run: async (input, io) => {
      io.stdout(`${input.issue_ref} ${String(input.comment_limit)} ${input.repo ?? '-'}\n`)
      return await exitWith(3)
    },
  })

  it('コマンドを定義すると、path・toolName・説明・位置引数・短いオプションを持つ', async () => {
    await explains('`defineCommand` が作成する定義の、基本的な項目のテストです。指定した path・説明・位置引数・短いオプションが定義に保持され、`toolName` が path から作成されることを確認します。')
    expect(definition.path).toEqual(['issue', 'read'])
    expect(definition.toolName).toBe('issue_read')
    expect(definition.description).toBe('Issue を読む')
    expect(definition.positional).toEqual(['issue_ref'])
    expect(definition.interactive).toBe(false)
    expect(definition.shortFlags).toEqual(new Map([['comment_limit', '-c']]))
  })

  it('グローバルの --repo オプションを、入力の repo として定義に追加する', async () => {
    await explains('全コマンドに共通の `--repo` オプションのテストです。定義の入力に `repo` が追加され、文字列の `repo` は受け付け、文字列でない `repo` は拒否することを確認します。')
    expect(Object.keys(definition.input.shape)).toEqual(['issue_ref', 'comment_limit', 'repo'])
    expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 'a/b' }).success).toBe(true)
    expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 1 }).success).toBe(false)
  })

  it('入力を検証して既定値を補い、コマンドの終了コードを返す', async () => {
    await explains('定義の `run` のテストです。省略した入力の既定値（`comment_limit` の 5）を補ってコマンドの本体を実行し、本体が返した終了コード 3 を返すことを確認します。')
    const io = capture()
    expect(await definition.run({ issue_ref: 'a/b/1', repo: 'x/y' }, io)).toBe(3)
    expect(io.out).toEqual(['a/b/1 5 x/y\n'])
  })

  it('repo を指定しない場合は、undefined のままコマンドの本体へ渡す', async () => {
    await explains('`repo` を指定せずに `run` を呼んだ場合のテストです。`repo` に既定値を補わず、コマンドの本体には `undefined` として渡されることを確認します。')
    const io = capture()
    await definition.run({ issue_ref: 'a/b/1', comment_limit: 2 }, io)
    expect(io.out).toEqual(['a/b/1 2 -\n'])
  })

  it('入力が不正な場合は、コマンドの本体を実行せず、ZodError が発生する', async () => {
    await explains('必須の `issue_ref` を指定しない場合のテストです。`ZodError` が発生し、コマンドの本体が実行されない（出力が空である）ことを確認します。')
    const io = capture()
    await expect(definition.run({ comment_limit: 2 }, io)).rejects.toBeInstanceOf(z.ZodError)
    expect(io.out).toEqual([])
  })

  it('shortFlags を指定しない場合は、空の Map になる', async () => {
    await explains('`shortFlags` を指定しないコマンドのテストです。定義の `shortFlags` が空の `Map` になり、`interactive` が指定どおり `true` になることを確認します。')
    const plain = defineCommand({
      path: ['pr', 'read'],
      title: 'Test command',
      description: 'PR を読む',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: true,
      run: async () => await exitWith(0),
    })
    expect(plain.shortFlags).toEqual(new Map())
    expect(plain.interactive).toBe(true)
  })

  it('hasOwnRepo が true のコマンドは、グローバルの repo を追加せず、コマンド自身の repo を使う', async () => {
    await explains('自分の `repo` 入力を持つコマンド（`hasOwnRepo` が `true`）のテストです。定義の入力にグローバルの `repo` が追加されず、コマンド自身の `repo` が本体へ渡され、不正な `repo` は拒否されることを確認します。')
    const received: unknown[] = []
    const own = defineCommand({
      path: ['own'],
      title: 'Test command',
      description: '',
      hasOwnRepo: true,
      input: z.object({ repo: z.string().optional(), name: z.string() }),
      output: z.strictObject({}),
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

  it('入力全体の refine を保持し、strictObject の入力でも repo を受け付ける', async () => {
    await explains('`z.strictObject` と `refine` で入力を定義したコマンドのテストです。`repo` を追加しても `refine` の検証が維持され、未定義のキーは拒否されることを確認します。')
    const received: unknown[] = []
    const strict = defineCommand({
      path: ['strict'],
      title: 'Test command',
      description: '',
      input: z.strictObject({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a !== undefined || value.b !== undefined, 'a か b が要ります'),
      output: z.strictObject({}),
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

  it('parse は本体を実行せず、検証した入力を持つ実行準備済みのコマンド（PreparedCommand）を返す', async () => {
    await explains('定義の `parse` のテストです。`parse` の時点ではコマンドの本体が実行されず、返された `PreparedCommand` の `run` を呼ぶと終了コード 3 を返すことを確認します。')
    const io = capture()
    const prepared = definition.parse({ issue_ref: 'a/b/1' })
    expect(io.out).toEqual([])
    expect(await prepared.run(io)).toBe(3)
    expect(io.out).toEqual(['a/b/1 5 -\n'])
  })

  it('aliases を指定すると定義に保持し、指定しない場合は空の Map になる', async () => {
    await explains('オプションの別名（`aliases`）のテストです。指定した別名が定義に保持され、指定しないコマンドでは空の `Map` になることを確認します。')
    const aliased = defineCommand({
      path: ['al'],
      title: 'Test command',
      description: '',
      input: z.object({ allow_existing_branch: z.boolean().default(false) }),
      output: z.strictObject({}),
      positional: [],
      aliases: { allow_existing_branch: '--force' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(aliased.aliases).toEqual(new Map([['allow_existing_branch', '--force']]))
    expect(definition.aliases).toEqual(new Map())
  })

  it('同じ入力に短いオプションと別名の両方を指定すると、TypeError が発生する', async () => {
    await explains('同じ入力に `shortFlags` と `aliases` の両方を指定した場合のテストです。コマンドを定義できず、`TypeError` が発生することを確認します。')
    expect(() => defineCommand({
      path: ['both'],
      title: 'Test command',
      description: '',
      input: z.object({ force: z.boolean().default(false) }),
      output: z.strictObject({}),
      positional: [],
      shortFlags: { force: '-f' },
      aliases: { force: '--yes' },
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('negations を指定すると、定義に否定形のオプションを保持する', async () => {
    await explains('否定形のオプション（`negations`）のテストです。`checkout` の否定形として指定した `--no-checkout` が、定義に保持されることを確認します。')
    const negated = defineCommand({
      path: ['neg'],
      title: 'Test command',
      description: '',
      input: z.object({ checkout: z.boolean().default(true) }),
      output: z.strictObject({}),
      positional: [],
      negations: { checkout: '--no-checkout' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(negated.negations).toEqual(new Map([['checkout', '--no-checkout']]))
  })

  it('入力 no_x のオプション --no-x と、入力 x の否定形 --no-x が重複する場合は、TypeError が発生する', async () => {
    await explains('入力 `no_x` の `--no-x` と、入力 `x` の否定形 `--no-x` が重複する場合のテストです。コマンドを定義できず、`オプション --no-x が重複しています` というメッセージの `TypeError` が発生することを確認します。')
    expect(() => defineCommand({
      path: ['dup'],
      title: 'Test command',
      description: '',
      input: z.object({ x: z.boolean().default(true), no_x: z.boolean().default(false) }),
      output: z.strictObject({}),
      positional: [],
      negations: { x: '--no-x' },
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(new TypeError('オプション --no-x が重複しています'))
  })

  it('入力 x の否定形 --no-x だけを指定した場合は、コマンドを定義できる', async () => {
    await explains('入力 `x` の否定形 `--no-x` だけを指定した場合のテストです。コマンドを定義でき、`x` の否定形として `--no-x` を取得できることを確認します。')
    const command = defineCommand({
      path: ['ok'],
      title: 'Test command',
      description: '',
      input: z.object({ x: z.boolean().default(true) }),
      output: z.strictObject({}),
      positional: [],
      negations: { x: '--no-x' },
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(command.negations.get('x')).toBe('--no-x')
  })

  it('path が空の配列の場合は、TypeError が発生する', async () => {
    await explains('`path` に空の配列を指定した場合のテストです。コマンドを定義できず、`TypeError` が発生することを確認します。')
    expect(() => defineCommand({
      path: [],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it.for(['kind', 'detail', 'log', 'warnings'])('output が MCP の結果の共通の項目名 %s を持つ場合は、TypeError が発生する', async (key) => {
    await explains(`\`output\` が予約名 \`${key}\` を持つ場合のテストです。コマンドを定義できず、予約名であることを示すメッセージの \`TypeError\` が発生することを確認します。`)
    expect(() => defineCommand({
      path: ['x'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({ name: z.string(), [key]: z.string() }),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(new TypeError(`output の ${key} は MCP の結果の共通の項目の予約名です`))
  })

  it('output が共通の項目名に含まれない名前 reason を持つ場合は、コマンドを定義できる', async () => {
    await explains('`output` の項目名が予約名（`kind`・`detail`・`log`・`warnings`）と重ならない場合のテストです。`reason` を持つコマンドを定義でき、`output` のキーが `reason` だけであることを確認します。')
    const command = defineCommand({
      path: ['x'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({ reason: z.string() }),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(Object.keys(command.output.shape)).toEqual(['reason'])
  })
})
