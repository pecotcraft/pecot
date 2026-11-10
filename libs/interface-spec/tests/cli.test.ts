import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { materialize } from './helpers/repository.js'

const exec = promisify(execFile)
const PROJECT = path.join(import.meta.dirname, '..')

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

  it('uses the repository root of this file when --root is not given', async () => {
    expect(await call('validate')).toEqual({ code: 0, stdout: '', stderr: '' })
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
    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'validate', '--root', root], { cwd: PROJECT })).rejects.toMatchObject({
      code: 1,
      stderr: 'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)\n',
    })
  })

  it('exits 0 without --root on the real repository', async () => {
    const { stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'validate'], { cwd: PROJECT })
    expect(stderr).toBe('')
  })
})
