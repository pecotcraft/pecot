import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { runDefinition } from '../command-binding.js'
import { CommandExit, defineCommand, interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { BaseError } from '@pecot/workflow-core/domain/errors.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { capture, exitWith } from './support.js'

describe('CommandExit', () => {
  it('コマンドの run が CommandExit を投げると、runDefinition は終了コードを返して失敗の種類を通知する', async () => {
    await explains('コマンド定義の `run` が `CommandExit` を投げた場合の、終了処理のテストです。`runDefinition` が `CommandExit` に指定した終了コード `2` を返し、失敗の種類 `invalid-input` を通知することを確認します。')
    const command = defineCommand({
      path: ['sample', 'exit'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => {
        await exitWith(0)
        throw new CommandExit(2, 'invalid-input')
      },
    })
    const kinds: string[] = []
    expect(await runDefinition(command, [], { ...capture(), failureKind: (kind) => {
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

  it('コマンドの run が CommandExit 以外の例外を投げると、runDefinition はそのまま送出する', async () => {
    await explains('コマンド定義の `run` が `CommandExit` 以外の例外を投げた場合のテストです。`runDefinition` が例外を終了コードに変換せず、元のメッセージ `boom` のまま送出することを確認します。')
    const command = defineCommand({
      path: ['sample', 'boom'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => {
        await exitWith(0)
        throw new TypeError('boom')
      },
    })
    await expect(runDefinition(command, [], capture())).rejects.toThrow('boom')
  })
})

describe('hasOwnRepo', () => {
  const seen: unknown[] = []
  const own = defineCommand({
    path: ['sample', 'own'],
    title: 'Test command',
    description: '',
    input: z.object({ repo: z.string().optional(), name: z.string() }).refine(value => value.repo === undefined || /^[^/]+\/[^/]+$/u.test(value.repo), { path: ['repo'], error: 'bad' }),
    output: z.strictObject({}),
    positional: ['name'],
    interactive: false,
    hasOwnRepo: true,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('hasOwnRepo を指定しないコマンドの input に repo が存在すると、コマンドを定義できない', async () => {
    await explains('コマンドを定義する `defineCommand` が、`input` の `repo` を検証する場合のテストです。`hasOwnRepo` を指定せずに `repo` を含む `input` を渡した場合に、`TypeError` が発生することを確認します。')
    expect(() => defineCommand({
      path: ['sample', 'clash'],
      title: 'Test command',
      description: '',
      input: z.object({ repo: z.string().optional() }),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('hasOwnRepo を指定したコマンドの input に repo が存在しないと、コマンドを定義できない', async () => {
    await explains('コマンドを定義する `defineCommand` が、`input` の `repo` を検証する場合のテストです。`hasOwnRepo` を指定したのに `repo` を含まない `input` を渡した場合に、`TypeError` が発生することを確認します。')
    expect(() => defineCommand({
      path: ['sample', 'missing'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      hasOwnRepo: true,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('hasOwnRepo を指定したコマンドは、--repo をオプションとして受け付ける', async () => {
    await explains('`hasOwnRepo` を指定したコマンドを実行する場合のテストです。引数に `--repo a/b` を渡した場合に、終了コード `0` を返し、`run` の入力に `repo` の値 `a/b` が含まれることを確認します。')
    seen.length = 0
    expect(own.hasOwnRepo).toBe(true)
    expect(await runDefinition(own, ['n', '--repo', 'a/b'], capture())).toBe(0)
    expect(seen).toEqual([{ repo: 'a/b', name: 'n' }])
  })

  it('hasOwnRepo を指定しないコマンドは、--repo をオプションとして受け付けない', async () => {
    await explains('`hasOwnRepo` を指定しないコマンドを実行する場合のテストです。引数に `--repo a/b` を渡した場合に、`No such option: --repo` の使い方の誤りで失敗することを確認します。')
    const plain = defineCommand({
      path: ['sample', 'plain'],
      title: 'Test command',
      description: '',
      input: z.object({ name: z.string() }),
      output: z.strictObject({}),
      positional: ['name'],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(plain.hasOwnRepo).toBe(false)
    await expect(runDefinition(plain, ['n', '--repo', 'a/b'], capture())).rejects.toMatchObject({ message: 'No such option: --repo (Possible options: --help)' })
  })

  it('サブコマンドの --repo を、グローバルの --repo より優先する', async () => {
    await explains('サブコマンドの `--repo` と、グローバルの `--repo` の優先順位のテストです。両方を指定した場合に、`run` の入力にサブコマンドの値 `sub/one` が使われることを確認します。')
    seen.length = 0
    await runDefinition(own, ['n', '--repo', 'sub/one'], capture(), 'global/two')
    expect(seen).toEqual([{ repo: 'sub/one', name: 'n' }])
  })

  it('サブコマンドに --repo を指定しない場合は、グローバルの --repo の値を使う', async () => {
    await explains('サブコマンドの `--repo` と、グローバルの `--repo` の優先順位のテストです。サブコマンドに `--repo` を指定しない場合に、`run` の入力にグローバルの値 `global/two` が使われることを確認します。')
    seen.length = 0
    await runDefinition(own, ['n'], capture(), 'global/two')
    expect(seen).toEqual([{ repo: 'global/two', name: 'n' }])
  })

  it('--repo の値が入力の検証に失敗すると、Invalid value for \'--repo\' の使い方の誤りにする', async () => {
    await explains('`--repo` の値を、コマンドの入力の検証（`refine`）で確認する場合のテストです。`owner/repo` の形でない値 `bad` を渡した場合に、`Invalid value for \'--repo\': bad` の使い方の誤りになることを確認します。')
    await expect(runDefinition(own, ['n', '--repo', 'bad'], capture())).rejects.toMatchObject({ message: 'Invalid value for \'--repo\': bad' })
  })
})

describe('interfaceIdOf', () => {
  it('コマンドの path を大文字にし、_ を - に置き換えて、先頭に PW- を付けたインタフェース ID を作成する', async () => {
    await explains('コマンドの `path` からインタフェース ID を作成する `interfaceIdOf` のテストです。`session set_title` の場合に、`PW-SESSION-SET-TITLE` のように、大文字にして `_` を `-` にした ID を返すことを確認します。')
    expect(interfaceIdOf(['session', 'start'])).toBe('PW-SESSION-START')
    expect(interfaceIdOf(['issue', 'create'])).toBe('PW-ISSUE-CREATE')
    expect(interfaceIdOf(['session', 'set_title'])).toBe('PW-SESSION-SET-TITLE')
  })
})
