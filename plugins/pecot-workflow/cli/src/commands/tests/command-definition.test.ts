import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runDefinition } from '../command-binding.js'
import { CommandExit, defineCommand, interfaceIdOf } from '../command-definition.js'
import { BaseError } from '../../domain/errors.js'
import { UsageError } from '../usage-error.js'
import { capture, exitWith } from './support.js'

describe('CommandExit', () => {
  it('run が投げると、defineCommand の run が終了コードにして返す', async () => {
    const command = defineCommand({
      path: ['sample', 'exit'],
      description: '',
      input: z.object({}),
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

  it('既存のエラーの型（PecotError・UsageError など）を継承しない', () => {
    const exit = new CommandExit(1, 'other')
    expect(exit).toBeInstanceOf(BaseError)
    expect(exit).not.toBeInstanceOf(UsageError)
    expect(exit.exitCode).toBe(1)
    expect(exit.kind).toBe('other')
  })

  it('CommandExit 以外の例外は握りつぶさずに伝える', async () => {
    const command = defineCommand({
      path: ['sample', 'boom'],
      description: '',
      input: z.object({}),
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
    description: '',
    input: z.object({ repo: z.string().optional(), name: z.string() }).refine(value => value.repo === undefined || /^[^/]+\/[^/]+$/u.test(value.repo), { path: ['repo'], message: 'bad' }),
    positional: ['name'],
    interactive: false,
    hasOwnRepo: true,
    run: async (input) => {
      seen.push(input)
      return await exitWith(0)
    },
  })

  it('印の無いコマンドが repo を input に持つと作れない', () => {
    expect(() => defineCommand({
      path: ['sample', 'clash'],
      description: '',
      input: z.object({ repo: z.string().optional() }),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('印があるのに repo が input に無いと作れない', () => {
    expect(() => defineCommand({
      path: ['sample', 'missing'],
      description: '',
      input: z.object({}),
      positional: [],
      interactive: false,
      hasOwnRepo: true,
      run: async () => await exitWith(0),
    })).toThrow(TypeError)
  })

  it('印があるコマンドは --repo をオプションとして受ける', async () => {
    seen.length = 0
    expect(own.hasOwnRepo).toBe(true)
    expect(await runDefinition(own, ['n', '--repo', 'a/b'], capture())).toBe(0)
    expect(seen).toEqual([{ repo: 'a/b', name: 'n' }])
  })

  it('印の無いコマンドは --repo をオプションとして受けない', async () => {
    const plain = defineCommand({
      path: ['sample', 'plain'],
      description: '',
      input: z.object({ name: z.string() }),
      positional: ['name'],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(plain.hasOwnRepo).toBe(false)
    await expect(runDefinition(plain, ['n', '--repo', 'a/b'], capture())).rejects.toMatchObject({ message: 'No such option: --repo (Possible options: --help)' })
  })

  it('サブコマンドの --repo を、グローバルの --repo より優先する', async () => {
    seen.length = 0
    await runDefinition(own, ['n', '--repo', 'sub/one'], capture(), 'global/two')
    expect(seen).toEqual([{ repo: 'sub/one', name: 'n' }])
  })

  it('サブコマンドの --repo が無ければ、グローバルの値を使う', async () => {
    seen.length = 0
    await runDefinition(own, ['n'], capture(), 'global/two')
    expect(seen).toEqual([{ repo: 'global/two', name: 'n' }])
  })

  it('--repo の形が refine に通らないと、Invalid value for \'--repo\' の使い方の誤りにする', async () => {
    await expect(runDefinition(own, ['n', '--repo', 'bad'], capture())).rejects.toMatchObject({ message: 'Invalid value for \'--repo\': bad' })
  })
})

describe('interfaceIdOf', () => {
  it('path を大文字にして、空白と _ を - にし、PW- を付ける', () => {
    expect(interfaceIdOf(['session', 'start'])).toBe('PW-SESSION-START')
    expect(interfaceIdOf(['issue', 'create'])).toBe('PW-ISSUE-CREATE')
    expect(interfaceIdOf(['session', 'set_title'])).toBe('PW-SESSION-SET-TITLE')
  })
})
