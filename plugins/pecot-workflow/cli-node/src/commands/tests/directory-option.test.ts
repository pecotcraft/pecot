/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの中だけを触る */
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { runDefinition } from '../command-binding.js'
import { DIRECTORY_DESCRIPTION, directorySchema } from '../directory-option.js'
import { defineCommand } from '../registry.js'
import { UsageError } from '../usage-error.js'
import { capture, exitWith } from './support.js'

const seen: unknown[] = []

const preflight = defineCommand({
  path: ['pr', 'preflight'],
  description: '見本',
  input: z.object({ directory: directorySchema }),
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
  it('在るディレクトリは絶対パスにして本体へ渡す', async () => {
    const { real } = fixture()
    seen.length = 0
    expect(await runDefinition(preflight, ['-D', real], capture())).toBe(0)
    expect(await runDefinition(preflight, ['--directory', real], capture())).toBe(0)
    expect(seen).toEqual([realpathSync(real), realpathSync(real)])
  })

  it('相対パスは cwd からの絶対パスにする', async () => {
    seen.length = 0
    await runDefinition(preflight, ['-D', '.'], capture())
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('symlink は実体のパスにする', async () => {
    const { root, real } = fixture()
    seen.length = 0
    await runDefinition(preflight, ['-D', path.join(root, 'link')], capture())
    expect(seen).toEqual([realpathSync(real)])
  })

  it('空文字は cwd にする', async () => {
    seen.length = 0
    await runDefinition(preflight, ['-D', ''], capture())
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('ファイルとディレクトリのどちらでもないパス（/dev/null）は検証を通す', async () => {
    seen.length = 0
    expect(await runDefinition(preflight, ['-D', '/dev/null'], capture())).toBe(0)
    expect(seen).toEqual(['/dev/null'])
  })

  it('無いパスは does not exist。値は入力のまま repr で出す', async () => {
    const { root } = fixture()
    const missing = path.join(root, 'it\'s-missing')
    expect(await messageOf(['-D', missing])).toBe(`Invalid value for '--directory' / '-D': Directory "${missing}" does not exist.`)
    expect(await messageOf(['-D', 'no-such-dir'])).toBe('Invalid value for \'--directory\' / \'-D\': Directory \'no-such-dir\' does not exist.')
  })

  it('指す先の無い symlink も does not exist', async () => {
    const { root } = fixture()
    const dangling = path.join(root, 'dangling')
    expect(await messageOf(['-D', dangling])).toBe(`Invalid value for '--directory' / '-D': Directory '${dangling}' does not exist.`)
  })

  it('ファイルは is a file', async () => {
    const { root } = fixture()
    const file = path.join(root, 'file.txt')
    expect(await messageOf(['-D', file])).toBe(`Invalid value for '--directory' / '-D': Directory '${file}' is a file.`)
  })

  it.skipIf(process.getuid?.() === 0)('読めないディレクトリは is not readable', async () => {
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

  it('値が無いと Missing option', async () => {
    expect(await messageOf([])).toBe('Missing option \'--directory\' / \'-D\'.')
  })

  it('JSON Schema は string のまま、description を保ち、必須', () => {
    const schema = z.toJSONSchema(z.object({ directory: directorySchema }), { io: 'input' })
    expect(schema.properties?.['directory']).toEqual({ type: 'string', description: DIRECTORY_DESCRIPTION })
    expect(schema.required).toEqual(['directory'])
    expect(DIRECTORY_DESCRIPTION).toBe('Target Git repository (absolute or relative path)')
  })
})
