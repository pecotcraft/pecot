import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { defaultRoot, run } from '../src/cli.js'
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
  it('exits 0 and prints nothing for a valid repository', async () => {
    expect(await call('validate', '--root', await materialize('valid'))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('prints one line per failure to stderr and exits 1', async () => {
    expect(await call('validate', '--root', await materialize('language'))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)\n'
        + 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)\n',
    })
  })

  it('points --root at the repository root by default', () => {
    const targets = path.join(defaultRoot(), 'libs/interface-spec/targets.json')
    expect(existsSync(targets)).toBe(true)
  })

  it('exits 2 with one error line when the root is not a git repository', async () => {
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

  it('exits 2 with one error line for an unexpected read error', async () => {
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
  ])('prints the usage and exits 2 for %j', async (argv) => {
    expect(await call(...argv)).toEqual({ code: 2, stdout: '', stderr: 'usage: interface-spec validate [--root <dir>]\n' })
  })
})

describe('the command line', () => {
  it('runs through tsx the way lint-defs does', async () => {
    const root = await materialize('field-missing')
    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'validate', '--root', root], { cwd: PROJECT, env: CHILD_ENV })).rejects.toMatchObject({
      code: 1,
      stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)\n',
    })
  })
})
