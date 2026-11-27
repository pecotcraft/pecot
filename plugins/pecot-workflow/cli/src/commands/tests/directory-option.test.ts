/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの中だけを触る */
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { DIRECTORY_DESCRIPTION, directorySchema } from '../directory-option.js'
import { defineTool } from '../registry.js'
import { capture, exitWith } from './support.js'

const seen: unknown[] = []

const preflight = defineTool({
  name: 'pr_preflight',
  title: 'Test tool',
  description: '見本',
  input: z.object({ directory: directorySchema }),
  output: z.strictObject({}),
  run: async (input) => {
    seen.push(input.directory)
    return await exitWith(0)
  },
})

async function run(directory: string): Promise<number> {
  return await preflight.run({ directory }, capture())
}

// 検証の誤りの文。誤りが無ければ例外
function messageOf(input: Readonly<Record<string, unknown>>): string {
  const parsed = z.object({ directory: directorySchema }).safeParse(input)
  if (parsed.success) throw new Error('検証の誤りがありませんでした')
  return parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')
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
    await explains('ディレクトリを受け取る `directorySchema` のテストです。存在するディレクトリを渡した場合に、絶対パスにして `run` に渡すことを確認します。')
    const { real } = fixture()
    seen.length = 0
    expect(await run(real)).toBe(0)
    expect(seen).toEqual([realpathSync(real)])
  })

  it('相対パスは、カレントディレクトリからの絶対パスにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`.` のように相対パスを渡した場合に、カレントディレクトリの絶対パスにして `run` に渡すことを確認します。')
    seen.length = 0
    await run('.')
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('シンボリックリンクは、リンク先の実体のパスにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。シンボリックリンクを渡した場合に、リンク先の実体のパスにして `run` に渡すことを確認します。')
    const { root, real } = fixture()
    seen.length = 0
    await run(path.join(root, 'link'))
    expect(seen).toEqual([realpathSync(real)])
  })

  it('空文字は、カレントディレクトリにする', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`directory` に空文字を渡した場合に、カレントディレクトリの絶対パスにして `run` に渡すことを確認します。')
    seen.length = 0
    await run('')
    expect(seen).toEqual([realpathSync(process.cwd())])
  })

  it('/dev/null のように、ファイルとディレクトリのどちらでもないパスは、検証を通過する', async () => {
    await explains('ディレクトリを受け取る `directorySchema` のテストです。`/dev/null` のように、ファイルとディレクトリのどちらでもないパスを渡した場合に、検証を通過し、そのままのパスを `run` に渡すことを確認します。')
    seen.length = 0
    expect(await run('/dev/null')).toBe(0)
    expect(seen).toEqual(['/dev/null'])
  })

  it('存在しないパスは does not exist の検証の誤りにし、渡した値をそのまま表示する', async () => {
    await explains('存在しないパスを渡した場合のテストです。`Directory \'…\' does not exist.` の検証の誤りになり、渡した値が Python の `repr` と同じ引用符の形でそのまま表示されることを確認します。')
    const { root } = fixture()
    const missing = path.join(root, 'it\'s-missing')
    expect(messageOf({ directory: missing })).toBe(`directory: Directory "${missing}" does not exist.`)
    expect(messageOf({ directory: 'no-such-dir' })).toBe('directory: Directory \'no-such-dir\' does not exist.')
  })

  it('リンク先が存在しないシンボリックリンクも、does not exist の検証の誤りにする', async () => {
    await explains('リンク先が存在しないシンボリックリンクを渡した場合のテストです。`Directory \'…\' does not exist.` の検証の誤りになることを確認します。')
    const { root } = fixture()
    const dangling = path.join(root, 'dangling')
    expect(messageOf({ directory: dangling })).toBe(`directory: Directory '${dangling}' does not exist.`)
  })

  it('ファイルを渡すと、is a file の検証の誤りにする', async () => {
    await explains('ディレクトリでなくファイルを渡した場合のテストです。`Directory \'…\' is a file.` の検証の誤りになることを確認します。')
    const { root } = fixture()
    const file = path.join(root, 'file.txt')
    expect(messageOf({ directory: file })).toBe(`directory: Directory '${file}' is a file.`)
  })

  it.skipIf(process.getuid?.() === 0)('読み取れないディレクトリを渡すと、is not readable の検証の誤りにする', async () => {
    await explains('権限を `000` にしたディレクトリを渡した場合のテストです。`Directory \'…\' is not readable.` の検証の誤りになることを確認します。')
    const { root } = fixture()
    const locked = path.join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(messageOf({ directory: locked })).toBe(`directory: Directory '${locked}' is not readable.`)
    }
    finally {
      chmodSync(locked, 0o700)
    }
  })

  it('ディレクトリを指定しないと、directory の検証の誤りにする', async () => {
    await explains('必須のディレクトリを指定しなかった場合のテストです。`directory` の検証の誤りになることを確認します。')
    expect(messageOf({})).toMatch(/^directory: /u)
  })

  it('JSON Schema では、description を持つ必須の文字列として表す', async () => {
    await explains('`directorySchema` を JSON Schema に変換した結果のテストです。型が `string`、`description` が `DIRECTORY_DESCRIPTION` のままで、必須の項目になっていることを確認します。')
    const schema = z.toJSONSchema(z.object({ directory: directorySchema }), { io: 'input' })
    expect(schema.properties?.['directory']).toEqual({ type: 'string', description: DIRECTORY_DESCRIPTION })
    expect(schema.required).toEqual(['directory'])
    expect(DIRECTORY_DESCRIPTION).toBe('Target Git repository (absolute or relative path)')
  })
})
