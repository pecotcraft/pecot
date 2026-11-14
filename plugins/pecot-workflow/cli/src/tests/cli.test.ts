import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeMcpServe } from '../mcp/serve.js'
import { z } from 'zod'

import { exitQuietlyOnBrokenPipe, main, runCli } from '../cli.js'
import { InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { OsError } from '../infra/os-error.js'
import { isConfirmed } from '../commands/output.js'
import { COMMANDS as REGISTERED_COMMANDS, defineCommand } from '../commands/registry.js'
import type { CommandIo } from '../commands/registry.js'
import { capture as captureIo, exitWith, failWith, throwFailure } from '../commands/tests/support.js'
import { pluginRoot } from '../version.js'
import { setEnvironment, useIsolatedEnvironment } from './_helpers/environment.js'
import { isRecord } from '../../tests/parity/baseline.js'
import { readGolden } from '../../tests/parity/scenario.js'
import { createGitRepository, gitForTest } from './_helpers/git-repository.js'
import { makeTemporaryDirectory } from './_helpers/temporary.js'

useIsolatedEnvironment()

vi.mock('../mcp/serve.js', () => ({ executeMcpServe: vi.fn(() => 0) }))

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
    path: ['abort'],
    description: '中止する',
    input: z.object({}),
    positional: [],
    interactive: true,
    run: async (_input, io) => await abortWith(io),
  }),
  // 古い名前と同じ path。一覧にあれば古い名前の表を引かないことを、「古い名前の案内」が確かめる
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

async function abortWith(io: CommandIo): Promise<never> {
  await Promise.resolve()
  isConfirmed(io, 'go on?')
  throw new Error('unreachable')
}

describe('確認の中止', () => {
  it('入力の終端で中止すると、Aborted. を出して 1', async () => {
    const result = await run(['abort'])
    expect(result).toEqual({ code: 1, stdout: ' ', stderr: 'go on? [y/N]:Aborted.\n' })
  })
})

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

const BRANCH_COMMAND = defineCommand({
  path: ['session', 'start'],
  description: 'Create a branch linked to an Issue',
  input: z.object({ issue_ref: z.string().describe('Issue reference'), branch_name: z.string().describe('Name of the branch'), base: z.string().optional().describe('Base branch') }),
  positional: ['issue_ref', 'branch_name'],
  shortFlags: { base: '-b' },
  interactive: false,
  run: async (input, io) => {
    io.stdout(`ran ${input.branch_name}\n`)
    return await exitWith(0)
  },
})

async function runBranch(argv: readonly string[], width?: string, environment: Readonly<Record<string, string>> = {}): Promise<Run> {
  const io = captureIo()
  const code = await runCli(argv, { commands: [BRANCH_COMMAND, ...COMMANDS], cwd: process.cwd(), io, environment: { ...width !== undefined && { TERMINAL_WIDTH: width }, ...environment }, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

describe('コマンドごとの --help', () => {
  it('引数と定義書の details・examples を出して 0。幅 80 の枠なしの書式', async () => {
    const result = await runBranch(['session', 'start', '--help'], '80')
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.startsWith('Usage: pecot session start [OPTIONS] <issue_ref> <branch_name>\n\nCreate a branch linked to an Issue\n\nArguments:\n')).toBe(true)
    expect(result.stdout).toContain('  <issue_ref>    Issue reference [required]\n  <branch_name>  Name of the branch [required]\n')
    expect(result.stdout).toContain('  -b, --base <str>  Base branch The branch of the PR the Issue stacks on when\n')
    // 定義書の PW-CREATE-BRANCH から読む
    expect(result.stdout).toContain('\nDetails:\n  - Creates a branch linked to an Issue through the GitHub GraphQL API')
    expect(result.stdout).toContain('\nExamples:\n  pecot session start example-org/my-repo/123 feat/my-change\n')
    expect(result.stdout).not.toMatch(/[╭│╰]/u)
    expect(result.stdout).not.toContain('Constraints:')
  })

  it('幅 40 では説明を次の行に下げる', async () => {
    const result = await runBranch(['session', 'start', '--help'], '40')
    expect(result.stdout).toContain('Arguments:\n  <issue_ref>\n      Issue reference [required]\n')
  })

  it('COLUMNS からも幅を決める', async () => {
    const result = await runBranch(['session', 'start', '--help'], undefined, { COLUMNS: '40' })
    expect(result.stdout).toContain('  <issue_ref>\n      Issue reference [required]\n')
  })

  it.each([
    ['必須の引数が欠けていても', ['session', 'start', '--help']],
    ['未知のオプションがあっても', ['session', 'start', '--bogus', '--help']],
    ['負数に見える語が後ろにあっても', ['session', 'start', '--help', '-1']],
    ['値を取るオプションの値の位置にあっても', ['session', 'start', '--base', '--help']],
    ['位置引数の後ろにあっても', ['session', 'start', 'a/b/1', 'x', '--help']],
    ['-- の前なら -- の後ろに語が続いても', ['session', 'start', '--help', '--', 'x']],
  ])('%s help を出して 0', async (_name, argv) => {
    const result = await runBranch(argv)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot session start [OPTIONS] <issue_ref> <branch_name>')
    expect(result.stderr).toBe('')
  })

  it('--base=--help は値として渡す（help にしない）', async () => {
    const result = await runBranch(['session', 'start', '--base=--help', 'a/b/1', 'x'])
    expect(result).toEqual({ code: 0, stdout: 'ran x\n', stderr: '' })
  })

  it('-- の後ろの --help は位置引数', async () => {
    const result = await runBranch(['session', 'start', '--', '--help'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Missing argument \'branch_name\'.')
  })

  it('グループ名の後の未知のオプションは、先頭の語だけを見るので --help があっても誤り', async () => {
    const result = await runBranch(['issue', '--bogus', '--help'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })

  it('--repo の形の誤りと PECOT_GITHUB_API_URL の誤りは、コマンドの help より先に出る', async () => {
    const repository = await runBranch(['--repo', 'bad', 'session', 'start', '--help'])
    expect(repository.code).toBe(2)
    expect(repository.stdout).toBe('')
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    const url = await runBranch(['session', 'start', '--help'])
    expect(url.code).toBe(1)
    expect(url.stdout).toBe('')
    expect(url.stderr).toContain('error: ')
  })

  it('定義書に項目が無いコマンドは、定義書の節を出さずに help を出して 0。stderr に場所と理由の warning を 1 行出す', async () => {
    const result = await runBranch(['boom', '--help'], '80')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('Usage: pecot boom [OPTIONS]\n\n落ちる\n\nOptions:\n  --help  Show this message and exit.\n')
    expect(result.stderr).toBe(`warning: could not read the details of 'boom' from ${path.join(pluginRoot(), 'interface', 'authored.yaml')}: it has no entry PW-BOOM; they are left out of this help\n`)
  })

  it('--help を 2 回打っても help を出して 0', async () => {
    const result = await runBranch(['session', 'start', '--help', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot session start [OPTIONS] <issue_ref> <branch_name>')
    expect(result.stderr).toBe('')
  })

  it('-h は help ではなく、未知のオプションとして 2', async () => {
    const result = await runBranch(['session', 'start', '-h'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No such option: -h')
  })

  it('--help=x は値を取らない旨の誤りで 2', async () => {
    const result = await runBranch(['session', 'start', '--help=x'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Option \'--help\' does not take a value.')
    expect(result.stderr).not.toContain('Possible options')
  })

  it('グループ名の後ろの --help は、後ろにサブコマンドがあってもグループの help', async () => {
    const result = await run(['issue', '--help', 'create'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('Commands:\n')
    expect(result.stderr).toBe('')
  })

  it('グループの中のコマンドも打てる', async () => {
    const result = await run(['issue', 'read', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue read [OPTIONS] <issue_ref>')
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
    expect(result.stderr).toMatch(/^error: \[Errno 2\] No such file or directory/u)
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

  it('グループを持たないコマンドを渡すと、終了コード 0 で終わる', async () => {
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
    expect(result.stderr).toContain('Usage: pecot issue read [OPTIONS] {issue_ref}')
    expect(result.stderr).toContain('Missing argument \'issue_ref\'.')
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

async function runRegistered(argv: readonly string[]): Promise<Run> {
  const io = captureIo()
  const code = await runCli(argv, { commands: REGISTERED_COMMANDS, cwd: process.cwd(), io, environment: {}, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

function errorPanel(text: string): string {
  return `╭─ Error ${'─'.repeat(70)}╮\n│ ${text.padEnd(76)} │\n╰${'─'.repeat(78)}╯\n`
}

// 枠の中の文。長い文は枠の幅で折り返されるので、行をつなぎ直す
function panelText(stderr: string): string {
  return stderr.split('\n').filter(line => line.startsWith('│ ')).map(line => line.slice(2, -2).trim()).join(' ')
}

describe('古い名前の案内', () => {
  it('最上位の古い名前は、実行せずに新しい名前を枠の中に出して 2', async () => {
    const result = await runRegistered(['create-branch', 'pecotcraft/nonexistent/1', 'feat/x'])
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: `Usage: pecot [OPTIONS] COMMAND [ARGS]...\nTry 'pecot --help' for help.\n${errorPanel('\'create-branch\' was renamed to \'session start\'.')}`,
    })
  })

  it('グループの下の古い名前は、そのグループの Usage 行と、新しい名前を出して 2', async () => {
    const result = await runRegistered(['pr', 'cleanup', 'o/r/1'])
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: `Usage: pecot pr [OPTIONS] COMMAND [ARGS]...\nTry 'pecot pr --help' for help.\n${errorPanel('\'pr cleanup\' was renamed to \'session finish\'.')}`,
    })
  })

  it.for([
    { argv: ['add-to-project'], oldName: 'add-to-project', newName: 'board add' },
    { argv: ['update-issue-status'], oldName: 'update-issue-status', newName: 'board move' },
    { argv: ['delete-branch'], oldName: 'delete-branch', newName: 'branch delete' },
    { argv: ['dependabot', 'sync'], oldName: 'dependabot sync', newName: 'tracker sync dependabot' },
    { argv: ['dependabot', '--help'], oldName: 'dependabot sync', newName: 'tracker sync dependabot' },
    { argv: ['dependabot'], oldName: 'dependabot sync', newName: 'tracker sync dependabot' },
    { argv: ['security', 'sync', '--dry-run'], oldName: 'security sync', newName: 'tracker sync security' },
    { argv: ['project', 'info'], oldName: 'project info', newName: 'board show' },
    { argv: ['project', 'set-repo', 'a/b'], oldName: 'project set-repo', newName: 'project link' },
    { argv: ['project', 'set-aggregation-repo', 'a/b'], oldName: 'project set-aggregation-repo', newName: 'project set aggregation_repo' },
    { argv: ['project', 'unset-aggregation-repo'], oldName: 'project unset-aggregation-repo', newName: 'project unset aggregation_repo' },
    { argv: ['project', 'show-aggregation-repo'], oldName: 'project show-aggregation-repo', newName: 'project get aggregation_repo' },
    { argv: ['issue', 'read', '1'], oldName: 'issue read', newName: 'issue show' },
    { argv: ['pr', 'read'], oldName: 'pr read', newName: 'pr show' },
    { argv: ['pr', 'preflight'], oldName: 'pr preflight', newName: 'pr check' },
    { argv: ['release', 'preflight'], oldName: 'release preflight', newName: 'release check' },
    { argv: ['session', 'status'], oldName: 'session status', newName: 'session show' },
  ])('$argv は、$oldName から $newName へ案内して 2', async ({ argv, oldName, newName }) => {
    const result = await runRegistered(argv)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(panelText(result.stderr)).toBe(`'${oldName}' was renamed to '${newName}'.`)
  })

  it.for([
    { argv: ['branch', 'create'], message: 'No such command \'create\'.' },
    { argv: ['repo', 'set'], message: 'No such command \'repo\'.' },
    { argv: ['aggregation', 'show'], message: 'No such command \'aggregation\'.' },
  ])('この PR の途中の名前 $argv は案内せず、No such command にする', async ({ argv, message }) => {
    const result = await runRegistered(argv)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stderr).not.toContain('was renamed')
  })

  it('渡された一覧に同じ名前があれば、案内せずにそのコマンドを実行する', async () => {
    expect(await run(['add-to-project'])).toEqual({ code: 0, stdout: '', stderr: '' })
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
  it('独自の例外は error: の行で 1', async () => {
    expect(await runFailing(new ProjectRootNotFoundError('ルートがありません'))).toEqual({ code: 1, stdout: '', stderr: 'error: ルートがありません\n' })
  })

  it('GitHub の失敗も error: の行で 1', async () => {
    expect(await runFailing(new GitHubAPIError('boom', { statusCode: 500 }))).toEqual({ code: 1, stdout: '', stderr: 'error: boom\n' })
  })

  it('値の誤りと OS のエラーも error: の行で 1', async () => {
    const invalid = await runFailing(new InvalidValueError('不正です'))
    expect(invalid.stderr).toBe('error: 不正です\n')
    const osError = await runFailing(new OsError('[Errno 2] No such file or directory: \'x\'', 'ENOENT', 'x'))
    expect(osError.stderr).toBe('error: [Errno 2] No such file or directory: \'x\'\n')
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

describe('mcp', () => {
  it('mcp は MCP サーバを起動して 0 を返し、何も出さない', async () => {
    vi.mocked(executeMcpServe).mockClear()
    expect(await run(['mcp'])).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(executeMcpServe).toHaveBeenCalledTimes(1)
  })

  it('mcp の起動が 1 を返したら、その終了コードで終わる', async () => {
    vi.mocked(executeMcpServe).mockReturnValueOnce(1)
    const result = await run(['mcp'])
    expect(result.code).toBe(1)
  })

  it('mcp に余分な引数があると、サーバを起動せず使い方の誤りで 2', async () => {
    vi.mocked(executeMcpServe).mockClear()
    const result = await run(['mcp', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Got unexpected extra argument(s) (extra)')
    expect(executeMcpServe).not.toHaveBeenCalled()
  })

  it('mcp は help の一覧に出ない', async () => {
    const help = await run(['--help'])
    expect(help.stdout).not.toContain('mcp')
  })
})
