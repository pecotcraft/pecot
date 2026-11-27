import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { CommandExit, defineTool, interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { BaseError } from '@pecot/workflow-core/domain/errors.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { capture, exitWith } from './support.js'

describe('CommandExit', () => {
  it('ツールの run が CommandExit を投げると、終了コードを返して失敗の種類を通知する', async () => {
    await explains('ツールの定義の `run` が `CommandExit` を投げた場合の、終了処理のテストです。定義の `run` が `CommandExit` に指定した終了コード `2` を返し、失敗の種類 `invalid-input` を通知することを確認します。')
    const tool = defineTool({
      name: 'sample_exit',
      title: 'Test tool',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      run: async () => {
        await exitWith(0)
        throw new CommandExit(2, 'invalid-input')
      },
    })
    const kinds: string[] = []
    expect(await tool.run({}, { ...capture(), failureKind: (kind) => {
      kinds.push(kind)
    } })).toBe(2)
    expect(kinds).toEqual(['invalid-input'])
  })

  it('CommandExit は BaseError を継承し、UsageError を継承しない', async () => {
    await explains('終了コードを運ぶ `CommandExit` クラスのテストです。`BaseError` のインスタンスであり、`UsageError` のインスタンスではなく、渡した `exitCode` と `kind` を保持していることを確認します。')
    const exit = new CommandExit(1, 'other')
    expect(exit).toBeInstanceOf(BaseError)
    expect(exit).not.toBeInstanceOf(UsageError)
    expect(exit.exitCode).toBe(1)
    expect(exit.kind).toBe('other')
  })

  it('ツールの run が CommandExit 以外の例外を投げると、その例外をそのまま送出する', async () => {
    await explains('ツールの定義の `run` が `CommandExit` 以外の例外を投げた場合のテストです。定義の `run` が例外を終了コードに変換せず、元のメッセージ `boom` のまま送出することを確認します。')
    const tool = defineTool({
      name: 'sample_boom',
      title: 'Test tool',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      run: async () => {
        await exitWith(0)
        throw new TypeError('boom')
      },
    })
    await expect(tool.run({}, capture())).rejects.toThrow('boom')
  })
})

describe('hasOwnRepo', () => {
  const seen: unknown[] = []
  const own = defineTool({
    name: 'sample_own',
    title: 'Test tool',
    description: '',
    input: z.object({ repo: z.string().optional(), name: z.string() }).refine(value => value.repo === undefined || /^[^/]+\/[^/]+$/u.test(value.repo), { path: ['repo'], message: 'bad' }),
    output: z.strictObject({}),
    hasOwnRepo: true,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('hasOwnRepo を指定しないツールの input に repo が存在すると、ツールを定義できない', async () => {
    await explains('ツールを定義する `defineTool` が、`input` の `repo` を検証する場合のテストです。`hasOwnRepo` を指定せずに `repo` を含む `input` を渡した場合に、`TypeError` が発生することを確認します。')
    expect(() => defineTool({
      name: 'sample_clash',
      title: 'Test tool',
      description: '',
      input: z.object({ repo: z.string().optional() }),
      output: z.strictObject({}),
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('hasOwnRepo を指定したツールの input に repo が存在しないと、ツールを定義できない', async () => {
    await explains('ツールを定義する `defineTool` が、`input` の `repo` を検証する場合のテストです。`hasOwnRepo` を指定したのに `repo` を含まない `input` を渡した場合に、`TypeError` が発生することを確認します。')
    expect(() => defineTool({
      name: 'sample_missing',
      title: 'Test tool',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      hasOwnRepo: true,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('hasOwnRepo を指定したツールは、repo をツール自身の入力として受け取る', async () => {
    await explains('`hasOwnRepo` を指定したツールを実行する場合のテストです。入力に `repo` の `a/b` を渡した場合に、終了コード `0` を返し、`run` の入力に `repo` の値 `a/b` が含まれることを確認します。')
    seen.length = 0
    expect(own.hasOwnRepo).toBe(true)
    expect(await own.run({ name: 'n', repo: 'a/b' }, capture())).toBe(0)
    expect(seen).toEqual([{ repo: 'a/b', name: 'n' }])
  })

  it('hasOwnRepo を指定しないツールは、repo を共通の入力として受け取る', async () => {
    await explains('`hasOwnRepo` を指定しないツールを実行する場合のテストです。入力に `repo` の `a/b` を渡した場合に、共通の `repo` として検証し、`run` の入力に含めることを確認します。')
    const received: unknown[] = []
    const plain = defineTool({
      name: 'sample_plain',
      title: 'Test tool',
      description: '',
      input: z.strictObject({ name: z.string() }),
      output: z.strictObject({}),
      run: async (input) => {
        received.push(input)
        return await exitWith(0)
      },
    })
    expect(plain.hasOwnRepo).toBe(false)
    expect(await plain.run({ name: 'n', repo: 'a/b' }, capture())).toBe(0)
    expect(received).toEqual([{ name: 'n', repo: 'a/b' }])
  })

  it('ツール自身の repo が入力の検証に失敗すると、本体を呼ばずに検証の誤りを投げる', async () => {
    await explains('ツール自身の `repo` を、入力の検証（`refine`）で確認する場合のテストです。`owner/repo` の形でない値 `bad` を渡した場合に、`run` を呼ばずに `ZodError` を投げることを確認します。')
    seen.length = 0
    await expect(own.run({ name: 'n', repo: 'bad' }, capture())).rejects.toBeInstanceOf(z.ZodError)
    expect(seen).toEqual([])
  })
})

describe('interfaceIdOf', () => {
  it('ツール名を大文字にし、_ を - に置き換えて、先頭に PW- を付けたインタフェース ID を作成する', async () => {
    await explains('ツール名からインタフェース ID を作成する `interfaceIdOf` のテストです。`session_start` の場合に、`PW-SESSION-START` のように、大文字にして `_` を `-` にした ID を返すことを確認します。')
    expect(interfaceIdOf('session_start')).toBe('PW-SESSION-START')
    expect(interfaceIdOf('issue_create')).toBe('PW-ISSUE-CREATE')
  })
})
