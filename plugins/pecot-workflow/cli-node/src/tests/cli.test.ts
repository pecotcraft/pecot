import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { exitQuietlyOnBrokenPipe, main, runCli } from '../cli.js'
import { InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { OsError } from '../infra/os-error.js'
import { defineCommand } from '../commands/registry.js'
import { capture as captureIo, exitWith, failWith, throwFailure } from '../commands/tests/support.js'
import { pluginRoot } from '../version.js'
import { setEnvironment, useIsolatedEnvironment } from './_helpers/environment.js'
import { isRecord } from '../../tests/parity/baseline.js'
import { readGolden } from '../../tests/parity/scenario.js'
import { createGitRepository, gitForTest } from './_helpers/git-repository.js'
import { makeTemporaryDirectory } from './_helpers/temporary.js'

useIsolatedEnvironment()

// 実装と同じ readVersion() は使わず、plugin.json を直接読む

function manifestVersion(): string {
  const manifestPath = path.join(pluginRoot(), '.claude-plugin', 'plugin.json')
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の plugin.json を読む
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version: unknown = isRecord(manifest) ? manifest['version'] : undefined
  if (typeof version !== 'string') throw new TypeError('plugin.json に version がありません')
  return version
}

const calls: unknown[] = []

const COMMANDS = [
  defineCommand({
    path: ['issue', 'read'],
    description: 'Issue を読む',
    input: z.object({ issue_ref: z.string() }),
    positional: ['issue_ref'],
    interactive: false,
    run: async (input, io) => {
      calls.push(input)
      io.stdout(`read ${input.issue_ref}\n`)
      return await exitWith(4)
    },
  }),
  defineCommand({
    path: ['boom'],
    description: '落ちる',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await failWith('boom'),
  }),
  defineCommand({
    path: ['add-to-project'],
    description: 'Project へ追加する',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await exitWith(0),
  }),
]

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(argv: readonly string[], cwd = process.cwd(), environment: Readonly<Record<string, string>> = {}): Promise<Run> {
  const io = captureIo()
  const code = await runCli(argv, { commands: COMMANDS, cwd, io, environment, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

function outsideGit(): string {
  const directory = makeTemporaryDirectory('pecot-nogit-')
  setEnvironment({ GIT_CEILING_DIRECTORIES: directory.slice(0, directory.lastIndexOf('/')) })
  return directory
}

describe('--version', () => {
  it.each([['-v'], ['--version'], ['--repo', 'bad', '-v'], ['-v', '--repo', 'bad'], ['--show-repo', '-v']])('%s は pecot version を出して 0', async (...argv) => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    expect(await run(argv)).toEqual({ code: 0, stdout: `pecot version ${manifestVersion()}\n`, stderr: '' })
  })

  it('解析の誤りは version より先に出る', async () => {
    const result = await run(['-v', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No such option: --bogus')
  })
})

describe('引数なしと --help', () => {
  it('引数なしは help を stdout に出して 2', async () => {
    const result = await run([])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: pecot [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('issue')
    expect(result.stdout).toContain('add-to-project  Project へ追加する')
    expect(result.stdout).toContain('boom')
  })

  it('--help は 0', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--show-repo')
  })

  it('説明を持たないグループも並べる', async () => {
    const customCommands = [defineCommand({ path: ['custom', 'run'], description: '実行する', input: z.object({}), positional: [], interactive: false, run: async () => await exitWith(0) })]
    const io = captureIo()
    const context = { commands: customCommands, cwd: process.cwd(), environment: {}, terminalColumns: undefined }
    expect(await runCli([], { ...context, io })).toBe(2)
    expect(io.out.join('')).toContain('custom')
    const groupIo = captureIo()
    expect(await runCli(['custom', '--help'], { ...context, io: groupIo })).toBe(0)
    expect(groupIo.out.join('')).toContain('run  実行する')
  })

  it('グループの --help は直下のコマンドを並べる', async () => {
    const result = await run(['issue', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('Work with Issues')
    expect(result.stdout).toContain('read  Issue を読む')
  })
})

describe('--repo', () => {
  it('不正な値は枠付きの使い方の誤りで 2。stdout は空', async () => {
    expect(await run(['--repo', 'bad', '--show-repo'])).toEqual({ code: 2, stdout: '', stderr: readGolden('global-usage-bad-repo').stderr })
  })

  it('--repo だけなら何も出さずに 0', async () => {
    expect(await run(['--repo', 'a/b'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('値が無ければ Usage 行の無い枠', async () => {
    const result = await run(['--repo'])
    expect(result.code).toBe(2)
    expect(result.stderr.startsWith('╭─ Error')).toBe(true)
    expect(result.stderr).toContain('Option \'--repo\' requires an argument.')
  })
})

describe('PECOT_GITHUB_API_URL', () => {
  it('不正なら文言を stderr に出して 1', async () => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    expect(await run(['--show-repo'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: https://x.com\n',
    })
  })

  it('コマンドを実行する前にも検証する', async () => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    calls.length = 0
    const result = await run(['issue', 'read', '1'])
    expect(result.code).toBe(1)
    expect(calls).toEqual([])
  })

  it('ループバックなら通る', async () => {
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.0.0.1:1234' })
    expect(await run(['--repo', 'a/b', '--show-repo'])).toEqual({ code: 0, stdout: 'resolved: a/b\nsource:   explicit\n', stderr: '' })
  })
})

describe('--show-repo', () => {
  it('--repo があれば explicit', async () => {
    expect(await run(['--repo', 'acme/demo', '--show-repo'])).toEqual({ code: 0, stdout: 'resolved: acme/demo\nsource:   explicit\n', stderr: '' })
  })

  it('Git 内なら origin から取る', async () => {
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'])
    expect(await run(['--show-repo'], repository)).toEqual({ code: 0, stdout: 'resolved: acme/demo\nsource:   current-git (origin)\n', stderr: '' })
  })

  it('Git 外なら error: を出して 2', async () => {
    expect(await run(['--show-repo'], outsideGit())).toEqual({
      code: 2,
      stdout: '',
      stderr: 'error: repository is ambiguous: pass --repo <owner/repo>\n',
    })
  })

  it('remote の URL を読めなければ error: --repo: を出して 2', async () => {
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'not-a-url'])
    const result = await run(['--show-repo'], repository)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: --repo: /u)
  })

  it('作業ディレクトリが無く git を起動できなければ、OS のエラーとして 1', async () => {
    const result = await run(['--show-repo'], '/nonexistent-directory-for-test')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^エラー: \[Errno 2\] No such file or directory/u)
  })

  it('コマンドより先に処理して、コマンドは実行しない', async () => {
    calls.length = 0
    const result = await run(['--repo', 'a/b', '--show-repo', 'issue', 'read', '1'])
    expect(result.code).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('コマンドの解決', () => {
  it('コマンドを実行して終了コードを返す', async () => {
    calls.length = 0
    expect(await run(['--repo', 'a/b', 'issue', 'read', 'x/y/1'])).toEqual({ code: 4, stdout: 'read x/y/1\n', stderr: '' })
    expect(calls).toEqual([{ issue_ref: 'x/y/1', repo: 'a/b' }])
  })

  it('コマンドが投げた例外は握りつぶさない', async () => {
    await expect(run(['boom'])).rejects.toThrow('boom')
  })

  it('グループを持たないコマンドも実行できる', async () => {
    const result = await run(['add-to-project'])
    expect(result.code).toBe(0)
  })

  it('-- の後ろもコマンド名として扱う', async () => {
    const result = await run(['--', 'add-to-project'])
    expect(result.code).toBe(0)
  })

  it('未知のコマンドは No such command。--show-repo の前に出る', async () => {
    const result = await run(['nosuch', '--show-repo'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(`Usage: pecot [OPTIONS] COMMAND [ARGS]...
Try 'pecot --help' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ No such command 'nosuch'.                                                    │
╰──────────────────────────────────────────────────────────────────────────────╯
`)
  })

  it('グループの中の未知のコマンドは、グループの Usage 行を付ける', async () => {
    const result = await run(['issue', 'nosuch'])
    expect(result.stderr.split('\n').slice(0, 2)).toEqual(['Usage: pecot issue [OPTIONS] COMMAND [ARGS]...', 'Try \'pecot issue --help\' for help.'])
    expect(result.stderr).toContain('No such command \'nosuch\'.')
  })

  it('グループだけなら Missing command', async () => {
    const result = await run(['issue'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing command.')
  })

  it('グループの未知のオプションは No such option', async () => {
    const result = await run(['issue', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })

  it('コマンドの使い方の誤りは枠付きで 2', async () => {
    const result = await run(['issue', 'read'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: pecot issue read [OPTIONS] ISSUE_REF')
    expect(result.stderr).toContain('Missing argument \'ISSUE_REF\'.')
  })
})

describe('候補の案内', () => {
  it('未知のコマンドには近いコマンドを案内する', async () => {
    const result = await run(['add-to-projec'])
    expect(result.stderr).toContain('No such command \'add-to-projec\'. Did you mean \'add-to-project\'?')
  })

  it('グループの中でも案内する', async () => {
    const result = await run(['issue', 'rea'])
    expect(result.stderr).toContain('No such command \'rea\'. Did you mean \'read\'?')
  })

  it('ルートの未知のオプションには、辞書順の候補を案内する', async () => {
    const result = await run(['--show-rep'])
    expect(result.stderr).toContain('No such option: --show-rep (Possible options: --help, --repo, --show-repo)')
  })

  it('グループの未知の短いオプションには案内しない', async () => {
    const result = await run(['issue', '-x'])
    expect(result.stderr).toContain('No such option: -x')
    expect(result.stderr).not.toContain('Possible')
  })

  it('グループの未知のオプションには --help を案内する', async () => {
    const result = await run(['issue', '--hlp'])
    expect(result.stderr).toContain('No such option: --hlp (Possible options: --help)')
  })
})

describe('-- の後ろ', () => {
  it('先頭がオプションの形なら、オプションとして解析し直す', async () => {
    expect(await run(['--', '--version'])).toEqual({ code: 0, stdout: `pecot version ${manifestVersion()}\n`, stderr: '' })
    const result = await run(['--', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })
})

describe('枠の幅', () => {
  const longValue = 'x'.repeat(70)

  it('COLUMNS に従う', async () => {
    const result = await run(['--repo', longValue, '--show-repo'], process.cwd(), { COLUMNS: '50' })
    const widths = new Set(result.stderr.split('\n').filter(line => line.startsWith('╭') || line.startsWith('╰')).map(line => line.length))
    expect(widths).toEqual(new Set([50]))
  })

  it('TERMINAL_WIDTH は COLUMNS より先', async () => {
    const result = await run(['--repo', longValue, '--show-repo'], process.cwd(), { COLUMNS: '50', TERMINAL_WIDTH: '60' })
    expect(result.stderr).toContain(`╭─ Error ${'─'.repeat(50)}╮`)
  })

  it('どちらも無ければ端末の幅、それも無ければ 80', async () => {
    const io = captureIo()
    const context = { commands: COMMANDS, cwd: process.cwd(), io, environment: {}, terminalColumns: 40 }
    await runCli(['--repo', longValue, '--show-repo'], context)
    expect(io.err.join('')).toContain(`╭─ Error ${'─'.repeat(30)}╮`)
    const plain = await run(['--repo', longValue, '--show-repo'])
    expect(plain.stderr).toContain(`╭─ Error ${'─'.repeat(70)}╮`)
  })
})

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error は変えられない
async function runFailing(failure: Error): Promise<Run> {
  const failing = defineCommand({
    path: ['fail'],
    description: '落ちる',
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await throwFailure(failure),
  })
  const io = captureIo()
  const code = await runCli(['fail'], { commands: [failing], cwd: process.cwd(), io, environment: {}, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

describe('例外の扱い', () => {
  it('独自の例外は エラー: の文で 1', async () => {
    expect(await runFailing(new ProjectRootNotFoundError('ルートがありません'))).toEqual({ code: 1, stdout: '', stderr: 'エラー: ルートがありません\n' })
  })

  it('GitHub の失敗は GitHub APIエラー: の文で 1', async () => {
    expect(await runFailing(new GitHubAPIError('boom', { statusCode: 500 }))).toEqual({ code: 1, stdout: '', stderr: 'GitHub APIエラー: boom\n' })
  })

  it('値の誤りと OS のエラーも エラー: の文で 1', async () => {
    const invalid = await runFailing(new InvalidValueError('不正です'))
    expect(invalid.stderr).toBe('エラー: 不正です\n')
    const osError = await runFailing(new OsError('[Errno 2] No such file or directory: \'x\'', 'ENOENT', 'x'))
    expect(osError.stderr).toBe('エラー: [Errno 2] No such file or directory: \'x\'\n')
  })

  it('検証の誤りではない ZodError は、使い方の誤りにしない', async () => {
    await expect(runFailing(new z.ZodError([]))).rejects.toBeInstanceOf(z.ZodError)
  })

  it('プログラムの誤りは握りつぶさない', async () => {
    await expect(runFailing(new TypeError('bug'))).rejects.toThrow('bug')
  })
})

describe('exitQuietlyOnBrokenPipe', () => {
  it('EPIPE は静かに終える', () => {
    const stream = new PassThrough()
    const finish = vi.fn()
    exitQuietlyOnBrokenPipe(stream, finish)
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(finish).toHaveBeenCalledOnce()
  })

  it('EPIPE 以外の error は伝える', () => {
    const stream = new PassThrough()
    const finish = vi.fn()
    exitQuietlyOnBrokenPipe(stream, finish)
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow('boom')
    expect(finish).not.toHaveBeenCalled()
  })
})

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('process の stdout に書き、exitCode を設定する', async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const previousArgv = process.argv
    process.argv = ['node', 'cli', '--version']
    // 非 0 を仕込む。main() が exitCode へ書かないと 9 のまま残り、このケースが落ちる
    process.exitCode = 9
    try {
      await main()
      expect(process.exitCode).toBe(0)
      expect(written).toEqual([`pecot version ${manifestVersion()}\n`])
    }
    finally {
      process.argv = previousArgv
    }
  })

  it('stderr の出力も process に流す', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const previousArgv = process.argv
    process.argv = ['node', 'cli', '--bogus']
    try {
      await main()
      expect(process.exitCode).toBe(2)
      expect(written).toHaveLength(1)
      expect(written.join('')).toContain('No such option: --bogus')
    }
    finally {
      process.argv = previousArgv
    }
  })
})
