import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../tests/_helpers/explains.js'
import { executeMcpServe } from '../mcp/serve.js'
import { z } from 'zod'

import { exitQuietlyOnBrokenPipe, main, runCli } from '../cli.js'
import { InvalidValueError, ProjectRootNotFoundError } from '@pecot/workflow-core/domain/errors.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
import { isConfirmed } from '@pecot/workflow-core/commands-shared/output.js'
import { defineCommand } from '../commands/registry.js'
import type { CommandIo } from '../commands/registry.js'
import { capture as captureIo, exitWith, failWith, throwFailure } from '../commands/tests/support.js'
import { pluginRoot } from '../version.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { isRecord } from '../../tests/parity/baseline.js'
import { readGolden } from '../../tests/parity/scenario.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'

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
    title: 'Test command',
    description: 'Issue を読む',
    input: z.object({ issue_ref: z.string() }),
    output: z.strictObject({}),
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
    title: 'Test command',
    description: '落ちる',
    input: z.object({}),
    output: z.strictObject({}),
    positional: [],
    interactive: false,
    run: async () => await failWith('boom'),
  }),
  defineCommand({
    path: ['abort'],
    title: 'Test command',
    description: '中止する',
    input: z.object({}),
    output: z.strictObject({}),
    positional: [],
    interactive: true,
    run: async (_input, io) => await abortWith(io),
  }),
  // 古い名前と同じ path。一覧にあれば古い名前の表を引かないことを、「古い名前の案内」が確かめる
  defineCommand({
    path: ['add-to-project'],
    title: 'Test command',
    description: 'Project へ追加する',
    input: z.object({}),
    output: z.strictObject({}),
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
  it('確認の入力が終端に達して中止すると、Aborted. を出力して終了コード 1 を返す', async () => {
    await explains('CLI の確認の中止のテストです。確認を求めるコマンドで入力が終端に達した場合は、標準エラー出力に `Aborted.` を出力し、終了コード 1 を返すことを確認します。')
    const result = await run(['abort'])
    expect(result).toEqual({ code: 1, stdout: ' ', stderr: 'go on? [y/N]:Aborted.\n' })
  })
})

describe('--version', () => {
  it.for([['-v'], ['--version'], ['--repo', 'bad', '-v'], ['-v', '--repo', 'bad'], ['--show-repo', '-v']].map(argv => ({ argv })))('$argv を渡すと、pecot version を出力して終了コード 0 を返す', async ({ argv }) => {
    await explains(`CLI の \`--version\` のテストです。\`${argv.join(' ')}\` を渡した場合は、不正な \`--repo\` が混じっていても、バージョンを出力して終了コード 0 を返すことを確認します。`)
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    expect(await run(argv)).toEqual({ code: 0, stdout: `pecot version ${manifestVersion()}\n`, stderr: '' })
  })

  it('引数の解析の誤りは、version の出力より先に出力する', async () => {
    await explains('CLI の `--version` のテストです。`-v` と未知のオプションを同時に渡した場合に、バージョンを出力せず、未知のオプションのエラーを出力して終了コード 2 を返すことを確認します。')
    const result = await run(['-v', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No such option: --bogus')
  })
})

describe('引数なしと --help', () => {
  it('引数がなければ、help を標準出力に出力して終了コード 2 を返す', async () => {
    await explains('CLI の引数なしと `--help` のテストです。引数を渡さずに実行した場合は、`Usage` とコマンドの一覧を標準出力に出力し、終了コード 2 を返すことを確認します。')
    const result = await run([])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: pecot [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('issue')
    expect(result.stdout).toContain('add-to-project  Project へ追加する')
    expect(result.stdout).toContain('boom')
  })

  it('--help を渡すと、終了コード 0 を返す', async () => {
    await explains('CLI の引数なしと `--help` のテストです。`--help` を渡した場合に、`--show-repo` を含む help を出力し、終了コード 0 を返すことを確認します。')
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--show-repo')
  })

  it('説明を持たないグループも、一覧に並べる', async () => {
    await explains('CLI の引数なしと `--help` のテストです。説明を持たないグループのコマンドを登録した場合に、ルートの help の一覧とグループの `--help` の両方にそのグループを表示することを確認します。')
    const customCommands = [defineCommand({ path: ['custom', 'run'], title: 'Test command', description: '実行する', input: z.object({}), output: z.strictObject({}), positional: [], interactive: false, run: async () => await exitWith(0) })]
    const io = captureIo()
    const context = { commands: customCommands, cwd: process.cwd(), environment: {}, terminalColumns: undefined }
    expect(await runCli([], { ...context, io })).toBe(2)
    expect(io.out.join('')).toContain('custom')
    const groupIo = captureIo()
    expect(await runCli(['custom', '--help'], { ...context, io: groupIo })).toBe(0)
    expect(groupIo.out.join('')).toContain('run  実行する')
  })

  it('グループの --help は、直下のコマンドを並べる', async () => {
    await explains('CLI の引数なしと `--help` のテストです。グループ名に `--help` を付けた場合に、そのグループの `Usage` と、直下のコマンドとその説明を出力することを確認します。')
    const result = await run(['issue', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('Work with Issues')
    expect(result.stdout).toContain('read  Issue を読む')
  })
})

const BRANCH_COMMAND = defineCommand({
  path: ['session', 'start'],
  title: 'Test command',
  description: 'Create a branch linked to an Issue',
  input: z.object({ issue_ref: z.string().describe('Issue reference'), branch_name: z.string().describe('Name of the branch'), base: z.string().optional().describe('Base branch') }),
  output: z.strictObject({}),
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
  it('引数と定義書の details と examples を出力して終了コード 0 を返す。幅 80 の枠なしの書式にする', async () => {
    await explains('コマンドごとの `--help` のテストです。幅 80 で `session start --help` を実行した場合に、引数と定義書の `Details` と `Examples` を枠のない書式で出力し、終了コード 0 を返すことを確認します。')
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

  it('幅 40 では、説明を次の行に移す', async () => {
    await explains('コマンドごとの `--help` のテストです。端末の幅が 40 の場合に、引数の説明を引数名の次の行へ折り返して出力することを確認します。')
    const result = await runBranch(['session', 'start', '--help'], '40')
    expect(result.stdout).toContain('Arguments:\n  <issue_ref>\n      Issue reference [required]\n')
  })

  it('COLUMNS の値からも幅を決める', async () => {
    await explains('コマンドごとの `--help` のテストです。環境変数 `COLUMNS` に 40 を設定した場合に、幅 40 の書式で引数の説明を出力することを確認します。')
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
  ])('%s help を出力して終了コード 0 を返す', async (name, argv) => {
    await explains(`コマンドごとの \`--help\` のテストです。\`--help\` を含む引数を渡した場合に、${name}、\`session start\` の help を標準出力に出力し、終了コード 0 を返すことを確認します。`)
    const result = await runBranch(argv)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot session start [OPTIONS] <issue_ref> <branch_name>')
    expect(result.stderr).toBe('')
  })

  it('--base=--help は値として渡し、help にしない', async () => {
    await explains('コマンドごとの `--help` のテストです。`--base=--help` の形で渡した場合に、`--help` をオプションの値として扱い、help ではなくコマンドを実行することを確認します。')
    const result = await runBranch(['session', 'start', '--base=--help', 'a/b/1', 'x'])
    expect(result).toEqual({ code: 0, stdout: 'ran x\n', stderr: '' })
  })

  it('-- の後ろの --help は、位置引数として扱う', async () => {
    await explains('コマンドごとの `--help` のテストです。`--` の後ろに `--help` を渡した場合に、位置引数として扱い、不足している引数のエラーを出力して終了コード 2 を返すことを確認します。')
    const result = await runBranch(['session', 'start', '--', '--help'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Missing argument \'branch_name\'.')
  })

  it('グループ名の後の未知のオプションは、先頭の語だけを見るので --help があっても誤りにする', async () => {
    await explains('コマンドごとの `--help` のテストです。グループ名の後に未知のオプションと `--help` を渡した場合に、先頭の語だけを見て、`No such option` のエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await runBranch(['issue', '--bogus', '--help'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })

  it('--repo の形の誤りと PECOT_GITHUB_API_URL の誤りは、コマンドの help より先に出力する', async () => {
    await explains('コマンドごとの `--help` のテストです。`--repo` の形が不正な場合と `PECOT_GITHUB_API_URL` が不正な場合に、どちらもコマンドの help を出力せず、先にエラーを出力することを確認します。')
    const repository = await runBranch(['--repo', 'bad', 'session', 'start', '--help'])
    expect(repository.code).toBe(2)
    expect(repository.stdout).toBe('')
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    const url = await runBranch(['session', 'start', '--help'])
    expect(url.code).toBe(1)
    expect(url.stdout).toBe('')
    expect(url.stderr).toContain('error: ')
  })

  it('定義書に項目が存在しないコマンドは、定義書の節を出力せずに help を出力して終了コード 0 を返し、場所と理由の警告を stderr に 1 行出力する', async () => {
    await explains('コマンドごとの `--help` のテストです。定義書に項目がないコマンドの `--help` を実行した場合に、定義書の節を除いた help を出力し、読めなかった場所と理由を示す警告を標準エラー出力に 1 行出力することを確認します。')
    const result = await runBranch(['boom', '--help'], '80')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('Usage: pecot boom [OPTIONS]\n\n落ちる\n\nOptions:\n  --help  Show this message and exit.\n')
    expect(result.stderr).toBe(`warning: could not read the details of 'boom' from ${path.join(pluginRoot(), 'interface', 'authored.yaml')}: it has no entry PW-BOOM; they are left out of this help\n`)
  })

  it('--help を 2 回渡しても、help を出力して終了コード 0 を返す', async () => {
    await explains('コマンドごとの `--help` のテストです。`--help` を 2 回続けて渡した場合に、help を 1 回出力して終了コード 0 を返し、標準エラー出力には何も出力しないことを確認します。')
    const result = await runBranch(['session', 'start', '--help', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot session start [OPTIONS] <issue_ref> <branch_name>')
    expect(result.stderr).toBe('')
  })

  it('-h は help ではなく、未知のオプションとして終了コード 2 を返す', async () => {
    await explains('コマンドごとの `--help` のテストです。短い形の `-h` を渡した場合に、help を出力せず、`No such option: -h` のエラーを出力して終了コード 2 を返すことを確認します。')
    const result = await runBranch(['session', 'start', '-h'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No such option: -h')
  })

  it('--help=x を渡すと、値を取らないというエラーを出力して終了コード 2 を返す', async () => {
    await explains('コマンドごとの `--help` のテストです。`--help=x` のように値を付けた場合に、`--help` は値を取らないことを示すエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await runBranch(['session', 'start', '--help=x'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Option \'--help\' does not take a value.')
    expect(result.stderr).not.toContain('Possible options')
  })

  it('グループ名の後ろの --help は、後ろにサブコマンドがあってもグループの help を出力する', async () => {
    await explains('コマンドごとの `--help` のテストです。グループ名の後に `--help` とサブコマンド名を続けて渡した場合に、グループの help を出力して終了コード 0 を返すことを確認します。')
    const result = await run(['issue', '--help', 'create'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue [OPTIONS] COMMAND [ARGS]...')
    expect(result.stdout).toContain('Commands:\n')
    expect(result.stderr).toBe('')
  })

  it('グループの中のコマンドの --help も出力できる', async () => {
    await explains('コマンドごとの `--help` のテストです。`issue read --help` を実行した場合に、`issue read` の `Usage` を出力して終了コード 0 を返すことを確認します。')
    const result = await run(['issue', 'read', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: pecot issue read [OPTIONS] <issue_ref>')
  })
})

describe('--repo', () => {
  it('--repo に不正な値を渡すと、枠付きの使い方のエラーを出力して終了コード 2 を返す。標準出力は空にする', async () => {
    await explains('CLI のグローバルオプション `--repo` のテストです。`--repo` に `owner/repo` の形でない値を渡した場合に、罫線で囲んだ使い方のエラーを標準エラー出力に出力し、終了コード 2 を返すことを確認します。')
    expect(await run(['--repo', 'bad', '--show-repo'])).toEqual({ code: 2, stdout: '', stderr: readGolden('global-usage-bad-repo').stderr })
  })

  it('--repo だけを渡すと、何も出力せずに終了コード 0 を返す', async () => {
    await explains('CLI のグローバルオプション `--repo` のテストです。`--repo` だけを渡した場合は、標準出力と標準エラー出力の両方に何も出力せず、終了コード 0 を返すことを確認します。')
    expect(await run(['--repo', 'a/b'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('値を渡さなければ、Usage 行のない枠のエラーを出力する', async () => {
    await explains('CLI のグローバルオプション `--repo` のテストです。`--repo` に値を渡さなかった場合に、`Usage` の行がない罫線で囲んだエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await run(['--repo'])
    expect(result.code).toBe(2)
    expect(result.stderr.startsWith('╭─ Error')).toBe(true)
    expect(result.stderr).toContain('Option \'--repo\' requires an argument.')
  })
})

describe('PECOT_GITHUB_API_URL', () => {
  it('不正な値を設定すると、エラーの文を stderr に出力して終了コード 1 を返す', async () => {
    await explains('環境変数 `PECOT_GITHUB_API_URL` のテストです。ループバックの http でない値を設定した場合に、受け付ける URL を示すエラーを標準エラー出力に出力し、終了コード 1 を返すことを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    expect(await run(['--show-repo'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: https://x.com\n',
    })
  })

  it('コマンドを実行する前にも検証する', async () => {
    await explains('環境変数 `PECOT_GITHUB_API_URL` のテストです。不正な値を設定してコマンドを実行した場合に、コマンドの本体を実行せず、終了コード 1 を返すことを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'https://x.com' })
    calls.length = 0
    const result = await run(['issue', 'read', '1'])
    expect(result.code).toBe(1)
    expect(calls).toEqual([])
  })

  it('ループバックの URL なら、検証を通す', async () => {
    await explains('環境変数 `PECOT_GITHUB_API_URL` のテストです。`http://127.0.0.1` のループバックの URL を設定した場合に、検証を通り、`--show-repo` が正常に出力されることを確認します。')
    setEnvironment({ PECOT_GITHUB_API_URL: 'http://127.0.0.1:1234' })
    expect(await run(['--repo', 'a/b', '--show-repo'])).toEqual({ code: 0, stdout: 'resolved: a/b\nsource:   explicit\n', stderr: '' })
  })
})

describe('--show-repo', () => {
  it('--repo を指定すれば、取得元を explicit と出力する', async () => {
    await explains('CLI の `--show-repo` のテストです。`--repo` を指定した場合に、指定したリポジトリと取得元の `explicit` を出力し、終了コード 0 を返すことを確認します。')
    expect(await run(['--repo', 'acme/demo', '--show-repo'])).toEqual({ code: 0, stdout: 'resolved: acme/demo\nsource:   explicit\n', stderr: '' })
  })

  it('git リポジトリの中なら、origin からリポジトリを取得する', async () => {
    await explains('CLI の `--show-repo` のテストです。git リポジトリの中で `origin` の URL が設定されている場合に、その URL から求めたリポジトリと取得元の `current-git (origin)` を出力することを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'])
    expect(await run(['--show-repo'], repository)).toEqual({ code: 0, stdout: 'resolved: acme/demo\nsource:   current-git (origin)\n', stderr: '' })
  })

  it('git リポジトリの外なら、error の行を出力して終了コード 2 を返す', async () => {
    await explains('CLI の `--show-repo` のテストです。git リポジトリの外で `--repo` なしで実行した場合に、リポジトリを特定できないことを示す `error:` の行を出力し、終了コード 2 を返すことを確認します。')
    expect(await run(['--show-repo'], outsideGit())).toEqual({
      code: 2,
      stdout: '',
      stderr: 'error: repository is ambiguous: pass --repo <owner/repo>\n',
    })
  })

  it('remote の URL を解釈できなければ、--repo の誤りでなく解釈できない理由を出力して終了コード 2 を返す', async () => {
    await explains('CLI の `--show-repo` のテストです。`origin` の URL がリポジトリとして解釈できない形の場合に、`--repo` の誤りではなく、`origin` の URL から読み取れない旨を出力し、終了コード 2 を返すことを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'not-a-url'])
    const result = await run(['--show-repo'], repository)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: could not read the repository from the URL of the Git remote origin\n')
  })

  it('作業ディレクトリが存在せず git を起動できなければ、OS のエラーとして終了コード 1 を返す', async () => {
    await explains('CLI の `--show-repo` のテストです。作業ディレクトリが存在しない場合に、git を起動できず、OS のエラーの文を出力して終了コード 1 を返すことを確認します。')
    const result = await run(['--show-repo'], '/nonexistent-directory-for-test')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: \[Errno 2\] No such file or directory/u)
  })

  it('コマンドより先に処理し、コマンドは実行しない', async () => {
    await explains('CLI の `--show-repo` のテストです。`--show-repo` とコマンドを一緒に渡した場合は、リポジトリの表示だけを行い、コマンドの本体を実行しないことを確認します。')
    calls.length = 0
    const result = await run(['--repo', 'a/b', '--show-repo', 'issue', 'read', '1'])
    expect(result.code).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('コマンドの解決', () => {
  it('コマンドを実行して、その終了コードを返す', async () => {
    await explains('CLI のコマンドの解決のテストです。`issue read` を実行した場合に、コマンドの出力と終了コードをそのまま返し、`--repo` の値を入力としてコマンドに渡すことを確認します。')
    calls.length = 0
    expect(await run(['--repo', 'a/b', 'issue', 'read', 'x/y/1'])).toEqual({ code: 4, stdout: 'read x/y/1\n', stderr: '' })
    expect(calls).toEqual([{ issue_ref: 'x/y/1', repo: 'a/b' }])
  })

  it('コマンドが投げた例外は、握りつぶさずに伝える', async () => {
    await explains('CLI のコマンドの解決のテストです。コマンドの本体が想定外の例外を投げた場合に、`runCli` がその例外をそのまま伝えることを確認します。')
    await expect(run(['boom'])).rejects.toThrow('boom')
  })

  it('グループに属さないコマンドを渡すと、終了コード 0 で終わる', async () => {
    await explains('CLI のコマンドの解決のテストです。グループに属さないコマンドを指定した場合に、そのコマンドを実行して終了コード 0 を返すことを確認します。')
    const result = await run(['add-to-project'])
    expect(result.code).toBe(0)
  })

  it('-- の後ろもコマンド名として扱う', async () => {
    await explains('CLI のコマンドの解決のテストです。`--` の後ろにコマンド名を渡した場合に、そのコマンドを実行して終了コード 0 を返すことを確認します。')
    const result = await run(['--', 'add-to-project'])
    expect(result.code).toBe(0)
  })

  it('未知のコマンドは No such command のエラーにし、--show-repo より先に出力する', async () => {
    await explains('CLI のコマンドの解決のテストです。未知のコマンドと `--show-repo` を同時に渡した場合に、`No such command` のエラーを枠付きで出力し、終了コード 2 を返すことを確認します。')
    const result = await run(['nosuch', '--show-repo'])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(`Usage: pecot [OPTIONS] COMMAND [ARGS]...
Try 'pecot --help' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ No such command 'nosuch'.                                                    │
╰──────────────────────────────────────────────────────────────────────────────╯
`)
  })

  it('グループの中の未知のコマンドは、グループの Usage 行を付けて出力する', async () => {
    await explains('CLI のコマンドの解決のテストです。グループの中に存在しないコマンドを渡した場合に、そのグループの `Usage` の行と `No such command` のエラーを出力することを確認します。')
    const result = await run(['issue', 'nosuch'])
    expect(result.stderr.split('\n').slice(0, 2)).toEqual(['Usage: pecot issue [OPTIONS] COMMAND [ARGS]...', 'Try \'pecot issue --help\' for help.'])
    expect(result.stderr).toContain('No such command \'nosuch\'.')
  })

  it('グループ名だけを渡すと、Missing command のエラーにする', async () => {
    await explains('CLI のコマンドの解決のテストです。グループ名だけを渡した場合に、`Missing command.` のエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await run(['issue'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Missing command.')
  })

  it('グループの後の未知のオプションは、No such option のエラーにする', async () => {
    await explains('CLI のコマンドの解決のテストです。グループ名の後に未知のオプションを渡した場合に、`No such option: --bogus` のエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await run(['issue', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })

  it('コマンドの使い方の誤りは、枠付きのエラーで終了コード 2 を返す', async () => {
    await explains('CLI のコマンドの解決のテストです。必須の引数を渡さずにコマンドを実行した場合に、コマンドの `Usage` と不足している引数を示す枠付きのエラーを出力し、終了コード 2 を返すことを確認します。')
    const result = await run(['issue', 'read'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: pecot issue read [OPTIONS] {issue_ref}')
    expect(result.stderr).toContain('Missing argument \'issue_ref\'.')
  })
})

describe('候補の案内', () => {
  it('未知のコマンドには、近いコマンドを案内する', async () => {
    await explains('CLI の候補の案内のテストです。綴りが近い未知のコマンドを渡した場合に、`Did you mean` で近いコマンドの名前を案内することを確認します。')
    const result = await run(['add-to-projec'])
    expect(result.stderr).toContain('No such command \'add-to-projec\'. Did you mean \'add-to-project\'?')
  })

  it('グループの中でも、近いコマンドを案内する', async () => {
    await explains('CLI の候補の案内のテストです。グループの中で綴りが近い未知のコマンドを渡した場合に、`Did you mean` でグループの中のコマンドの名前を案内することを確認します。')
    const result = await run(['issue', 'rea'])
    expect(result.stderr).toContain('No such command \'rea\'. Did you mean \'read\'?')
  })

  it('ルートの未知のオプションには、辞書順の候補を案内する', async () => {
    await explains('CLI の候補の案内のテストです。綴りが近い未知のオプションをルートで渡した場合に、`Possible options` として `--help`・`--repo`・`--show-repo` を辞書順に案内することを確認します。')
    const result = await run(['--show-rep'])
    expect(result.stderr).toContain('No such option: --show-rep (Possible options: --help, --repo, --show-repo)')
  })

  it('グループの未知の短いオプションには、候補を案内しない', async () => {
    await explains('CLI の候補の案内のテストです。グループの後に未知の短いオプションを渡した場合に、`No such option` のエラーだけを出力し、候補を案内しないことを確認します。')
    const result = await run(['issue', '-x'])
    expect(result.stderr).toContain('No such option: -x')
    expect(result.stderr).not.toContain('Possible')
  })

  it('グループの未知のオプションには、--help を案内する', async () => {
    await explains('CLI の候補の案内のテストです。グループの後に綴りが近い未知のオプションを渡した場合に、`Possible options` として `--help` を案内することを確認します。')
    const result = await run(['issue', '--hlp'])
    expect(result.stderr).toContain('No such option: --hlp (Possible options: --help)')
  })
})

describe('-- の後ろ', () => {
  it('-- の後ろの先頭がオプションの形なら、オプションとして解析し直す', async () => {
    await explains('CLI の `--` の後ろのテストです。`--` の後ろの先頭が `--version` の場合はバージョンを出力し、`--bogus` の場合は未知のオプションとして終了コード 2 を返すことを確認します。')
    expect(await run(['--', '--version'])).toEqual({ code: 0, stdout: `pecot version ${manifestVersion()}\n`, stderr: '' })
    const result = await run(['--', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --bogus')
  })
})

describe('枠の幅', () => {
  const longValue = 'x'.repeat(70)

  it('COLUMNS に従って枠の幅を決める', async () => {
    await explains('CLI のエラーの枠の幅のテストです。環境変数 `COLUMNS` に 50 を設定した場合に、エラーを囲む枠の幅がすべて 50 文字になることを確認します。')
    const result = await run(['--repo', longValue, '--show-repo'], process.cwd(), { COLUMNS: '50' })
    const widths = new Set(result.stderr.split('\n').filter(line => line.startsWith('╭') || line.startsWith('╰')).map(line => line.length))
    expect(widths).toEqual(new Set([50]))
  })

  it('TERMINAL_WIDTH は COLUMNS より優先する', async () => {
    await explains('CLI のエラーの枠の幅のテストです。`COLUMNS` と `TERMINAL_WIDTH` の両方を設定した場合に、`TERMINAL_WIDTH` の値で枠の幅を決めることを確認します。')
    const result = await run(['--repo', longValue, '--show-repo'], process.cwd(), { COLUMNS: '50', TERMINAL_WIDTH: '60' })
    expect(result.stderr).toContain(`╭─ Error ${'─'.repeat(50)}╮`)
  })

  it('どちらも存在しなければ端末の幅を使い、それも存在しなければ 80 にする', async () => {
    await explains('CLI のエラーの枠の幅のテストです。環境変数がない場合に、端末の幅が分かればその幅を、分からなければ 80 を枠の幅にすることを確認します。')
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
    title: 'Test command',
    description: '落ちる',
    input: z.object({}),
    output: z.strictObject({}),
    positional: [],
    interactive: false,
    run: async () => await throwFailure(failure),
  })
  const io = captureIo()
  const code = await runCli(['fail'], { commands: [failing], cwd: process.cwd(), io, environment: {}, terminalColumns: undefined })
  return { code, stdout: io.out.join(''), stderr: io.err.join('') }
}

describe('例外の扱い', () => {
  it('独自の例外は、error の行を出力して終了コード 1 を返す', async () => {
    await explains('CLI の例外の扱いのテストです。プロジェクトのルートが見つからない例外を投げた場合に、`error:` の行を標準エラー出力に出力し、終了コード 1 を返すことを確認します。')
    expect(await runFailing(new ProjectRootNotFoundError('ルートがありません'))).toEqual({ code: 1, stdout: '', stderr: 'error: ルートがありません\n' })
  })

  it('GitHub の失敗も、error の行を出力して終了コード 1 を返す', async () => {
    await explains('CLI の例外の扱いのテストです。`GitHubAPIError` を投げた場合に、`error:` の行を標準エラー出力に出力し、終了コード 1 を返すことを確認します。')
    expect(await runFailing(new GitHubAPIError('boom', { statusCode: 500 }))).toEqual({ code: 1, stdout: '', stderr: 'error: boom\n' })
  })

  it('値の誤りと OS のエラーも、error の行を出力して終了コード 1 を返す', async () => {
    await explains('CLI の例外の扱いのテストです。`InvalidValueError` と `OsError` を投げた場合に、どちらも例外の文を `error:` の行として標準エラー出力に出力することを確認します。')
    const invalid = await runFailing(new InvalidValueError('不正です'))
    expect(invalid.stderr).toBe('error: 不正です\n')
    const osError = await runFailing(new OsError('[Errno 2] No such file or directory: \'x\'', 'ENOENT', 'x'))
    expect(osError.stderr).toBe('error: [Errno 2] No such file or directory: \'x\'\n')
  })

  it('入力の検証の誤りではない ZodError は、使い方の誤りにしない', async () => {
    await explains('CLI の例外の扱いのテストです。入力の検証によらない `ZodError` を投げた場合に、使い方のエラーとして処理せず、その例外をそのまま伝えることを確認します。')
    await expect(runFailing(new z.ZodError([]))).rejects.toBeInstanceOf(z.ZodError)
  })

  it('想定外の例外は、握りつぶさずに伝える', async () => {
    await explains('CLI の例外の扱いのテストです。`TypeError` のような想定外の例外を投げた場合に、`runCli` がその例外をそのまま伝えることを確認します。')
    await expect(runFailing(new TypeError('bug'))).rejects.toThrow('bug')
  })
})

describe('exitQuietlyOnBrokenPipe', () => {
  it('EPIPE は、何も出力せずに終了する', async () => {
    await explains('標準出力の切断を扱う `exitQuietlyOnBrokenPipe` のテストです。ストリームで `EPIPE` の `error` が発生した場合に、終了の処理を 1 回だけ呼ぶことを確認します。')
    const stream = new PassThrough()
    const finish = vi.fn()
    exitQuietlyOnBrokenPipe(stream, finish)
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(finish).toHaveBeenCalledOnce()
  })

  it('EPIPE 以外の error は、そのまま伝える', async () => {
    await explains('標準出力の切断を扱う `exitQuietlyOnBrokenPipe` のテストです。ストリームで `EPIPE` 以外の `error` が発生した場合に、その例外を伝え、終了の処理を呼ばないことを確認します。')
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

  it('process の stdout に出力し、exitCode を設定する', async () => {
    await explains('CLI の `main` 関数 のテストです。`--version` を渡して実行した場合に、`process.stdout` へバージョンを出力し、`process.exitCode` を 0 に設定することを確認します。')
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

  it('stderr の出力も、process に流す', async () => {
    await explains('CLI の `main` 関数 のテストです。未知のオプションを渡して実行した場合に、`process.stderr` へエラーを 1 回出力し、`process.exitCode` を 2 に設定することを確認します。')
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
  it('mcp は MCP サーバーを起動し、終了コード 0 を返して何も出力しない', async () => {
    await explains('`mcp` コマンドのテストです。`mcp` を実行した場合に、MCP サーバーの起動を 1 回呼び、終了コード 0 を返して何も出力しないことを確認します。')
    vi.mocked(executeMcpServe).mockClear()
    expect(await run(['mcp'])).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(executeMcpServe).toHaveBeenCalledTimes(1)
  })

  it('mcp の起動が 1 を返したら、その終了コードで終わる', async () => {
    await explains('`mcp` コマンドのテストです。MCP サーバーの起動が 1 を返した場合に、`mcp` コマンドの終了コードも 1 になることを確認します。')
    vi.mocked(executeMcpServe).mockReturnValueOnce(1)
    const result = await run(['mcp'])
    expect(result.code).toBe(1)
  })

  it('mcp に余分な引数があると、サーバーを起動せず使い方のエラーで終了コード 2 を返す', async () => {
    await explains('`mcp` コマンドのテストです。`mcp` に余分な引数を渡した場合に、MCP サーバーを起動せず、使い方のエラーを出力して終了コード 2 を返すことを確認します。')
    vi.mocked(executeMcpServe).mockClear()
    const result = await run(['mcp', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Got unexpected extra argument(s) (extra)')
    expect(executeMcpServe).not.toHaveBeenCalled()
  })

  it('mcp は help の一覧に出力しない', async () => {
    await explains('`mcp` コマンドのテストです。`--help` の出力に、`mcp` コマンドが含まれないことを確認します。')
    const help = await run(['--help'])
    expect(help.stdout).not.toContain('mcp')
  })
})
