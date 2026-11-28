// defineTool が作る定義の形と、run・parse の振る舞いを確かめる。
import { describe, expect, it } from 'vitest'
import { step, stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { capture, exitWith } from '../../../tests/_helpers/captured-io.js'
import { defineTool, interfaceIdOf } from '../command-definition.js'

describe('interfaceIdOf', () => {
  it('ツール名を大文字にし、_ を - にした定義書の ID を返す', async () => {
    await explains('ツール名から定義書の ID を作成する `interfaceIdOf` のテストです。`session_start` は `PW-SESSION-START` のように、大文字にして `_` を `-` にした ID を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(interfaceIdOf('session_start')).toBe('PW-SESSION-START')
      expect(interfaceIdOf('issue_comment_check')).toBe('PW-ISSUE-COMMENT-CHECK')
    })
  })
})

describe('defineTool', () => {
  const definition = defineTool({
    name: 'pr_show',
    title: 'Test tool',
    description: 'Issue を読む',
    input: z.object({ issue_ref: z.string(), comment_limit: z.number().default(5) }),
    output: z.strictObject({}),
    run: async (input, io) => {
      io.stdout(`${input.issue_ref} ${String(input.comment_limit)} ${input.repo ?? '-'}\n`)
      return await exitWith(3)
    },
  })

  it('ツールを定義すると、名前・表示名・説明を持ち、動詞から読むだけかを決める', async () => {
    await explains('`defineTool` が作成する定義の、基本的な項目のテストです。指定した名前・表示名・説明が定義に保持され、動詞が `show` のツールは読むだけ（`readOnly`）になることを確認します。')
    stepSync('結果を確認する', () => {
      expect(definition).toMatchObject({ name: 'pr_show', title: 'Test tool', description: 'Issue を読む', readOnly: true, hasOwnRepo: false, ignoresGlobalRepo: false })
    })
  })

  it('全ツールに共通の repo を、入力に追加する', async () => {
    await explains('全ツールに共通の `repo` 入力のテストです。定義の入力に `repo` が追加され、文字列の `repo` は受け付け、文字列でない `repo` は拒否することを確認します。')
    stepSync('結果を確認する', () => {
      expect(Object.keys(definition.input.shape)).toEqual(['issue_ref', 'comment_limit', 'repo'])
      expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 'a/b' }).success).toBe(true)
      expect(definition.input.safeParse({ issue_ref: 'a/b/1', repo: 1 }).success).toBe(false)
    })
  })

  it('入力を検証して既定値を補い、ツールの本体の終了コードを返す', async () => {
    await explains('定義の `run` のテストです。省略した入力の既定値（`comment_limit` の 5）を補ってツールの本体を実行し、本体が返した終了コード 3 を返すことを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    await step('結果を確認する', async () => {
      expect(await definition.run({ issue_ref: 'a/b/1', repo: 'x/y' }, io)).toBe(3)
      expect(io.out).toEqual(['a/b/1 5 x/y\n'])
    })
  })

  it('repo を指定しない場合は、undefined のままツールの本体へ渡す', async () => {
    await explains('`repo` を指定せずに `run` を呼んだ場合のテストです。`repo` に既定値を補わず、ツールの本体には `undefined` として渡されることを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    await step('コマンドの定義を動かす', async () => {
      await definition.run({ issue_ref: 'a/b/1', comment_limit: 2 }, io)
    })
    stepSync('結果を確認する', () => {
      expect(io.out).toEqual(['a/b/1 2 -\n'])
    })
  })

  it('入力が不正な場合は、ツールの本体を実行せず、ZodError が発生する', async () => {
    await explains('必須の `issue_ref` を指定しない場合のテストです。`ZodError` が発生し、ツールの本体が実行されない（出力が空である）ことを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    await step('結果を確認する', async () => {
      await expect(definition.run({ comment_limit: 2 }, io)).rejects.toBeInstanceOf(z.ZodError)
      expect(io.out).toEqual([])
    })
  })

  it('書き込む動詞のツールは、読むだけにならない', async () => {
    await explains('動詞が `create` のツールのテストです。定義の `readOnly` が `false` になることを確認します。')
    const writing = stepSync('ツールを用意する', () => defineTool({ name: 'pr_create', title: 'Test tool', description: '', input: z.object({}), output: z.strictObject({}), run: async () => await exitWith(0) }))
    stepSync('結果を確認する', () => {
      expect(writing.readOnly).toBe(false)
    })
  })

  it('グループが 2 語のツールは、最後の語の動詞から読むだけかを決める', async () => {
    await explains('グループが `issue_comment` のように 2 語のツールのテストです。最後の語が `check` の `issue_comment_check` の場合に、定義の `readOnly` が `true` になることを確認します。')
    const checking = stepSync('ツールを用意する', () => defineTool({ name: 'issue_comment_check', title: 'Test tool', description: '', input: z.object({}), output: z.strictObject({}), run: async () => await exitWith(0) }))
    stepSync('結果を確認する', () => {
      expect(checking.readOnly).toBe(true)
    })
  })

  it('hasOwnRepo が true のツールは、共通の repo を追加せず、ツール自身の repo を使う', async () => {
    await explains('自分の `repo` 入力を持つツール（`hasOwnRepo` が `true`）のテストです。定義の入力に共通の `repo` が追加されず、ツール自身の `repo` が本体へ渡され、不正な `repo` は拒否されることを確認します。')
    const received: unknown[] = []
    const own = stepSync('ツールを用意する', () => defineTool({
      name: 'branch_delete',
      title: 'Test tool',
      description: '',
      hasOwnRepo: true,
      input: z.object({ repo: z.string().optional(), name: z.string() }),
      output: z.strictObject({}),
      run: async (input) => {
        received.push(input)
        return await exitWith(0)
      },
    }))
    stepSync('結果を確認する', () => {
      expect(own.hasOwnRepo).toBe(true)
      expect(Object.keys(own.input.shape)).toEqual(['repo', 'name'])
    })
    await step('ツールを実行する', async () => {
      await own.run({ repo: 'a/b', name: 'x' }, capture())
    })
    stepSync('結果を確認する', () => {
      expect(received).toEqual([{ repo: 'a/b', name: 'x' }])
      expect(() => own.parse({ name: 'x', repo: 1 })).toThrow(z.ZodError)
    })
  })

  it('入力全体の refine を保持し、strictObject の入力でも repo を受け付ける', async () => {
    await explains('`z.strictObject` と `refine` で入力を定義したツールのテストです。`repo` を追加しても `refine` の検証が維持され、未定義のキーは拒否されることを確認します。')
    const received: unknown[] = []
    const strict = stepSync('ツールを用意する', () => defineTool({
      name: 'pr_create',
      title: 'Test tool',
      description: '',
      input: z.strictObject({ a: z.string().optional(), b: z.string().optional() }).refine(value => value.a !== undefined || value.b !== undefined, 'a か b が要ります'),
      output: z.strictObject({}),
      run: async (input) => {
        received.push(input)
        return await exitWith(0)
      },
    }))
    stepSync('結果を確認する', () => {
      expect(strict.input.safeParse({ a: 'x', repo: 'o/r' }).success).toBe(true)
      expect(strict.input.safeParse({ repo: 'o/r' }).success).toBe(false)
    })
    await step('ツールを実行する', async () => {
      await strict.run({ a: 'x', repo: 'o/r' }, capture())
    })
    await step('結果を確認する', async () => {
      expect(received).toEqual([{ a: 'x', repo: 'o/r' }])
      expect(() => strict.parse({})).toThrow(z.ZodError)
      await expect(strict.run({ a: 'x', extra: 1 }, capture())).rejects.toBeInstanceOf(z.ZodError)
    })
  })

  it('parse は本体を実行せず、検証した入力を持つ実行準備済みのツール（PreparedCommand）を返す', async () => {
    await explains('定義の `parse` のテストです。`parse` の時点ではツールの本体が実行されず、返された `PreparedCommand` の `run` を呼ぶと終了コード 3 を返すことを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const prepared = stepSync('入力を解析する', () => definition.parse({ issue_ref: 'a/b/1' }))
    await step('結果を確認する', async () => {
      expect(io.out).toEqual([])
      expect(await prepared.run(io)).toBe(3)
      expect(io.out).toEqual(['a/b/1 5 -\n'])
    })
  })

  it('name が空の場合は、TypeError が発生する', async () => {
    await explains('`name` に空文字を指定した場合のテストです。ツールを定義できず、`TypeError` が発生することを確認します。')
    stepSync('結果を確認する', () => {
      expect(() => defineTool({ name: '', title: 'Test tool', description: '', input: z.object({}), output: z.strictObject({}), run: async () => await exitWith(0) })).toThrow(TypeError)
    })
  })

  it.for(['kind', 'detail', 'log', 'warnings'])('output が MCP の結果の共通の項目名 %s を持つ場合は、TypeError が発生する', async (key) => {
    await explains(`\`output\` が予約名 \`${key}\` を持つ場合のテストです。ツールを定義できず、予約名であることを示すメッセージの \`TypeError\` が発生することを確認します。`)
    stepSync('結果を確認する', () => {
      expect(() => defineTool({
        name: 'pr_show',
        title: 'Test tool',
        description: '',
        input: z.object({}),
        output: z.strictObject({ name: z.string(), [key]: z.string() }),
        run: async () => await exitWith(0),
      })).toThrow(new TypeError(`output の ${key} は MCP の結果の共通の項目の予約名です`))
    })
  })

  it('output が共通の項目名に含まれない名前 reason を持つ場合は、ツールを定義できる', async () => {
    await explains('`output` の項目名が予約名（`kind`・`detail`・`log`・`warnings`）と重ならない場合のテストです。`reason` を持つツールを定義でき、`output` のキーが `reason` だけであることを確認します。')
    const tool = stepSync('ツールを用意する', () => defineTool({ name: 'pr_show', title: 'Test tool', description: '', input: z.object({}), output: z.strictObject({ reason: z.string() }), run: async () => await exitWith(0) }))
    stepSync('結果を確認する', () => {
      expect(Object.keys(tool.output.shape)).toEqual(['reason'])
    })
  })
})
