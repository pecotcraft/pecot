import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { defaultRoot, run } from '../src/cli.js'
import { BORROWED_MAP, POSIX_MAP } from '../src/domain/field-map.js'
import process from 'node:process'
import { materialize } from './helpers/repository.js'

const exec = promisify(execFile)
const PROJECT = path.join(import.meta.dirname, '..')
// nx が入れる FORCE_COLOR が子プロセスの stderr に色や警告を混ぜないようにする。
const CHILD_ENV = { ...process.env, FORCE_COLOR: undefined }

async function call(...argv: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, {
    stdout: (text) => {
      stdout.push(text)
    },
    stderr: (text) => {
      stderr.push(text)
    },
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('validate', () => {
  it('正しいリポジトリのとき、何も出さず 0 で終わる', async () => {
    expect(await call('validate', '--root', await materialize('valid'))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('失敗があると、1 件ごとに 1 行を標準エラーに出して 1 で終わる', async () => {
    expect(await call('validate', '--root', await materialize('language'))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)\n'
        + 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)\n',
    })
  })

  it('--root を省くと、リポジトリの root を指す', () => {
    const targets = path.join(defaultRoot(), 'libs/interface-spec/targets.json')
    expect(existsSync(targets)).toBe(true)
  })

  it('root が git リポジトリでないと、エラーを 1 行出して 2 で終わる', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    const fixture = path.join(PROJECT, 'tests', 'fixtures', 'valid')
    try {
      await cp(fixture, root, { recursive: true })
      expect(await call('validate', '--root', root)).toEqual({
        code: 2,
        stdout: '',
        stderr: `error: ${root}: git ls-files failed (is it a git repository?)\n`,
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('想定外の読み取りエラーのとき、エラーを 1 行出して 2 で終わる', async () => {
    const root = await materialize('valid')
    const authored = path.join(root, 'plugins/pecot-workflow/interface/authored.yaml')
    await rm(authored)
    await mkdir(authored)
    expect(await call('validate', '--root', root)).toEqual({ code: 2, stdout: '', stderr: `error: ${authored}: EISDIR\n` })
  })

  it.each([
    [[]],
    [['other']],
    [['validate', '--root']],
    [['validate', '--bogus', 'x']],
    [['validate', '--root', 'a', 'b']],
    [['field-map', 'x']],
  ])('%j を渡すと、使い方を出して 2 で終わる', async (argv) => {
    expect(await call(...argv)).toEqual({ code: 2, stdout: '', stderr: 'usage: interface-spec validate [--root <dir>]\n       interface-spec links [--root <dir>]\n       interface-spec commands-md (--check | --write) [--root <dir>]\n       interface-spec field-map\n' })
  })
})

describe('field-map', () => {
  it('欄の対応の 2 つの表を JSON で標準出力に出し、0 で終わる', async () => {
    const result = await call('field-map')
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ posix: POSIX_MAP, borrowed: BORROWED_MAP })
  })
})

describe('the command line', () => {
  it('lint-defs と同じく tsx から呼ぶと、欠けた欄を 1 行出して終了コード 1 で終わる', async () => {
    const root = await materialize('field-missing')
    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'validate', '--root', root], { cwd: PROJECT, env: CHILD_ENV })).rejects.toMatchObject({
      code: 1,
      stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)\n',
    })
  })
})
