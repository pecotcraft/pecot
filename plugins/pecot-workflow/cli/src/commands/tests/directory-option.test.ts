/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの中だけを触る */
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { runDefinition } from '../command-binding.js'
import { DIRECTORY_DESCRIPTION, directorySchema } from '../directory-option.js'
import { defineCommand } from '../registry.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { capture, exitWith } from './support.js'

const seen: unknown[] = []

const preflight = defineCommand({
  path: ['pr', 'preflight'],
  title: 'Test command',
  description: '見本',
  input: z.object({ directory: directorySchema }),
  output: z.strictObject({}),
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input) => {
    seen.push(input.directory)
    return await exitWith(0)
  },
})

async function messageOf(argv: readonly string[]): Promise<string> {
  try {
    await runDefinition(preflight, argv, capture())
  }
  catch (error: unknown) {
    if (error instanceof UsageError) return error.message
    throw error
  }
  throw new Error('UsageError が投げられませんでした')
}

// 後始末は temporary.js の afterEach が行うので、ケースごとに作る
function fixture(): { root: string, real: string } {
  const root = makeTemporaryDirectory('directory-option')
  const real = path.join(root, 'real')
  mkdirSync(real)
  writeFileSync(path.join(root, 'file.txt'), '')
  symlinkSync(real, path.join(root, 'link'))
  symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
  return { root, real }
}

describe('directorySchema', () => {
  it('存在するディレクトリは、絶対パスにして run に渡す', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。存在するディレクトリを `-D` と `--directory` で渡した場合に、どちらも絶対パスにして `run` に渡すことを確認します。')
    const { real } = fixture()
    seen.length = 0
    expect(await runDefinition(preflight, ['-D', real], capture())).toBe(0)
    expect(await runDefinition(preflight, ['--directory', real], capture())).toBe(0)
    expect(seen).toEqual([realpathSync(real), realpathSync(real)])
  })

  it('相対パスは、カレントディレクトリからの絶対パスにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`-D .` のように相対パスを渡した場合に、カレントディレクトリの絶対パスにして `run` に渡すことを確認します。')
    seen.length = 0
    await runDefinition(preflight, ['-D', '.'], capture())
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('シンボリックリンクは、リンク先の実体のパスにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。シンボリックリンクを渡した場合に、リンク先の実体のパスにして `run` に渡すことを確認します。')
    const { root, real } = fixture()
    seen.length = 0
    await runDefinition(preflight, ['-D', path.join(root, 'link')], capture())
    expect(seen).toEqual([realpathSync(real)])
  })

  it('空文字は、カレントディレクトリにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`-D` に空文字を渡した場合に、カレントディレクトリの絶対パスにして `run` に渡すことを確認します。')
    seen.length = 0
    await runDefinition(preflight, ['-D', ''], capture())
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('/dev/null のように、ファイルとディレクトリのどちらでもないパスは、検証を通過する', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`/dev/null` のように、ファイルとディレクトリのどちらでもないパスを渡した場合に、検証を通過し、そのままのパスを `run` に渡すことを確認します。')
    seen.length = 0
    expect(await runDefinition(preflight, ['-D', '/dev/null'], capture())).toBe(0)
    expect(seen).toEqual(['/dev/null'])
  })

  it('存在しないパスは does not exist の使い方の誤りにし、渡した値をそのまま表示する', async () => {
    await explains('存在しないパスを渡した場合のテストです。`Directory \'…\' does not exist.` の使い方の誤りになり、渡した値が Python の `repr` と同じ引用符の形でそのまま表示されることを確認します。')
    const { root } = fixture()
    const missing = path.join(root, 'it\'s-missing')
    expect(await messageOf(['-D', missing])).toBe(`Invalid value for '--directory' / '-D': Directory "${missing}" does not exist.`)
    expect(await messageOf(['-D', 'no-such-dir'])).toBe('Invalid value for \'--directory\' / \'-D\': Directory \'no-such-dir\' does not exist.')
  })

  it('リンク先が存在しないシンボリックリンクも、does not exist の使い方の誤りにする', async () => {
    await explains('リンク先が存在しないシンボリックリンクを渡した場合のテストです。`Directory \'…\' does not exist.` の使い方の誤りになることを確認します。')
    const { root } = fixture()
    const dangling = path.join(root, 'dangling')
    expect(await messageOf(['-D', dangling])).toBe(`Invalid value for '--directory' / '-D': Directory '${dangling}' does not exist.`)
  })

  it('ファイルを渡すと、is a file の使い方の誤りにする', async () => {
    await explains('ディレクトリでなくファイルを渡した場合のテストです。`Directory \'…\' is a file.` の使い方の誤りになることを確認します。')
    const { root } = fixture()
    const file = path.join(root, 'file.txt')
    expect(await messageOf(['-D', file])).toBe(`Invalid value for '--directory' / '-D': Directory '${file}' is a file.`)
  })

  it.skipIf(process.getuid?.() === 0)('読み取れないディレクトリを渡すと、is not readable の使い方の誤りにする', async () => {
    await explains('権限を `000` にしたディレクトリを渡した場合のテストです。`Directory \'…\' is not readable.` の使い方の誤りになることを確認します。')
    const { root } = fixture()
    const locked = path.join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(await messageOf(['-D', locked])).toBe(`Invalid value for '--directory' / '-D': Directory '${locked}' is not readable.`)
    }
    finally {
      chmodSync(locked, 0o700)
    }
  })

  it('ディレクトリを指定しないと、Missing option の使い方の誤りにする', async () => {
    await explains('必須のディレクトリを指定しなかった場合のテストです。`Missing option \'--directory\' / \'-D\'.` の使い方の誤りになることを確認します。')
    expect(await messageOf([])).toBe('Missing option \'--directory\' / \'-D\'.')
  })

  it('JSON Schema では、description を持つ必須の文字列として表す', async () => {
    await explains('`directorySchema` を JSON Schema に変換した結果のテストです。型が `string`、`description` が `DIRECTORY_DESCRIPTION` のままで、必須の項目になっていることを確認します。')
    const schema = z.toJSONSchema(z.object({ directory: directorySchema }), { io: 'input' })
    expect(schema.properties?.['directory']).toEqual({ type: 'string', description: DIRECTORY_DESCRIPTION })
    expect(schema.required).toEqual(['directory'])
    expect(DIRECTORY_DESCRIPTION).toBe('Target Git repository (absolute or relative path)')
  })
})
