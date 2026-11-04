/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリとパッケージルート配下で、利用者入力ではない。 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { globSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts/source-hash.mjs')
const scriptUrl = pathToFileURL(script).href

// .mjs を TypeScript から直接 import すると型解決と lint が落ちるので、子プロセスで呼ぶ。
async function evaluate(target: string, expression: string): Promise<string> {
  const code = `import { sourceFiles, sourceHash } from ${JSON.stringify(scriptUrl)}\nconst root = ${JSON.stringify(target)}\nconsole.log(${expression})`
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code])
  return stdout.trim()
}

const hashOf = (target: string): Promise<string> => evaluate(target, 'sourceHash(root)')
function toStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new TypeError('文字列の配列ではありません')
  return value
}

const filesOf = async (target: string): Promise<string[]> => toStrings(JSON.parse(await evaluate(target, 'JSON.stringify(sourceFiles(root))')))

async function put(base: string, relative: string, content: string): Promise<void> {
  const file = path.join(base, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('source-hash', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'source-hash-'))
    await put(directory, 'package.json', '{}')
    await put(directory, 'index.ts', 'export {}')
    await put(directory, 'lib/a.ts', 'a')
    await put(directory, 'bin/b.ts', 'b')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('同じ入力なら同じ値になる', async () => {
    expect(await hashOf(directory)).toBe(await hashOf(directory))
  })

  it('lib の内容が変わると値が変わる', async () => {
    const before = await hashOf(directory)
    await put(directory, 'lib/a.ts', 'changed')
    expect(await hashOf(directory)).not.toBe(before)
  })

  it('ファイルが増えると値が変わる', async () => {
    const before = await hashOf(directory)
    await put(directory, 'scripts/c.mjs', 'c')
    expect(await hashOf(directory)).not.toBe(before)
  })

  it('ファイル名だけが変わっても値が変わる', async () => {
    const before = await hashOf(directory)
    await rename(path.join(directory, 'lib/a.ts'), path.join(directory, 'lib/renamed.ts'))
    expect(await hashOf(directory)).not.toBe(before)
  })

  it('隣り合うファイル間でバイトを移すと値が変わる', async () => {
    await put(directory, 'lib/a.ts', 'ab')
    await put(directory, 'lib/b.ts', 'c')
    const before = await hashOf(directory)
    await put(directory, 'lib/a.ts', 'a')
    await put(directory, 'lib/b.ts', 'bc')
    expect(await hashOf(directory)).not.toBe(before)
  })

  it('ファイルへの symlink は入力に含める', async () => {
    await put(directory, 'real.txt', 'real')
    await symlink(path.join(directory, 'real.txt'), path.join(directory, 'lib/link.ts'))
    expect(await filesOf(directory)).toContain('lib/link.ts')
  })

  it('tests・dist・node_modules・coverage の変更では変わらない', async () => {
    const before = await hashOf(directory)
    await put(directory, 'tests/x.test.ts', 'x')
    await put(directory, 'dist/y.js', 'y')
    await put(directory, 'node_modules/z/index.js', 'z')
    await put(directory, 'coverage/w.json', 'w')
    expect(await hashOf(directory)).toBe(before)
    expect(await filesOf(directory)).toEqual(['bin/b.ts', 'index.ts', 'lib/a.ts', 'package.json'])
  })

  it('存在しないファイルとディレクトリは飛ばす', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'source-hash-empty-'))
    try {
      expect(await filesOf(empty)).toEqual([])
    }
    finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('実パッケージの対象に tsconfig.build.json の include の実在ファイルがすべて入る', async () => {
    const files = await filesOf(root)
    // git は使わない。pre-push の hook は GIT_DIR を子プロセスへ渡し、cwd を変えた git ls-files が空になる。
    const expected = globSync(['index.ts', 'lib/**/*', 'bin/**/*'], { cwd: root })
      .filter(name => statSync(path.join(root, name)).isFile())
    expect(expected.length).toBeGreaterThan(0)
    for (const name of expected) expect(files).toContain(name)
  })

  it('直接実行は 64 桁の hex を 1 行で出し、実パッケージの値と一致する', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script])
    expect(stdout).toMatch(/^[0-9a-f]{64}\n$/)
    expect(stdout.trim()).toBe(await hashOf(root))
  })
})
