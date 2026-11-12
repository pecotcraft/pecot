/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */

// bin/pecot wrapper の動作のテスト。データ置き場の venv 方式を、uv のモックで確かめる。
// wrapper は実体ではなく、一時ディレクトリに複製した隔離ツリーから起動する。
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { pluginRoot as realPluginRoot } from '../_helpers/paths.js'
import { run, runAsync } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

// CLAUDE_PLUGIN_DATA は消さない。ケースの一時ディレクトリを指しており、実ホームの置き場への書き込みを防ぐ。
// 「変数なし」を試すケースだけが、値に undefined を渡して外す。XDG_DATA_HOME は付け替えない。
const ENV_KEYS_CLEARED: EnvironmentOverrides = {
  PLUGIN_DATA: undefined,
  CLAUDE_PLUGIN_ROOT: undefined,
  PECOT_BOOTSTRAP_SKIP: undefined,
  VIRTUAL_ENV: undefined,
  UV_NO_SYNC: undefined,
  UV_PROJECT_ENVIRONMENT: undefined,
}

const MSG_NO_HOME = 'pecot-workflow: cannot decide the data directory because HOME is unset'
const BUILDING = 'pecot: building'
const INSTALLING = 'pecot: installing dependencies'
const NO_CLIENT_DATA: EnvironmentOverrides = { CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined }

interface Wrapper {
  readonly pluginRoot: string
  readonly wrapper: string
  readonly uvLog: string
}

// 実 wrapper・実 _lib.sh・実 plugin.json と、cli/ の stub を持つ隔離プラグインルートを作る。
function makePluginRoot(hookCase: HookCase): string {
  const root = path.join(hookCase.temporaryPath, 'iso', 'plugins', 'pecot-workflow')
  mkdirSync(path.join(root, 'bin'), { recursive: true })
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  for (const name of ['pecot', '_lib.sh']) {
    writeFileSync(path.join(root, 'bin', name), readFileSync(path.join(realPluginRoot, 'bin', name)))
  }
  chmodSync(path.join(root, 'bin', 'pecot'), 0o755)
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{ "name": "pecot-w", "version": "1.0.0" }\n')
  const cli = path.join(root, 'cli')
  mkdirSync(path.join(cli, 'commands'), { recursive: true })
  writeFileSync(path.join(cli, 'pyproject.toml'), '[project]\nname = "pecot"\n')
  writeFileSync(path.join(cli, 'uv.lock'), 'lock-v1\n')
  writeFileSync(path.join(cli, '__init__.py'), '')
  writeFileSync(path.join(cli, 'commands', 'main.py'), 'print(\'v1\')\n')
  // 本体直下に残り得る生成物。ステージには複製されず、src-hash にも入らない
  mkdirSync(path.join(cli, '__pycache__'))
  writeFileSync(path.join(cli, '__pycache__', 'x.pyc'), Buffer.from([0]))
  mkdirSync(path.join(cli, 'pecot.egg-info'))
  writeFileSync(path.join(cli, 'pecot.egg-info', 'PKG-INFO'), 'x')
  return root
}

// uv をモックして PATH の先頭に置く。呼び出しは uv.log に 1 呼び出し 1 行と env で残す。
// UV_FAIL=1 なら sync が失敗し、UV_DELAY（秒）で sync に時間をかける。
function uvMockBody(log: string): string {
  return [
    '#!/usr/bin/env bash',
    '{',
    '  echo "ARGS:$*"',
    '  echo "ENV:UV_PROJECT_ENVIRONMENT=${UV_PROJECT_ENVIRONMENT:-}"',
    '  echo "ENV:VIRTUAL_ENV=${VIRTUAL_ENV-<unset>}"',
    '  echo "ENV:UV_NO_SYNC=${UV_NO_SYNC-<unset>}"',
    `} >> "${log}"`,
    '[ "$1" = sync ] || exit 0',
    'stage=""',
    'while [ $# -gt 0 ]; do',
    '  [ "$1" = --project ] && stage="$2"',
    '  shift',
    'done',
    `ls -A "$stage" | sed 's/^/STAGE:/' >> "${log}"`,
    'sleep "${UV_DELAY:-0}"',
    '[ "${UV_FAIL:-}" = 1 ] && exit 1',
    'mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"',
    'printf \'#!/bin/sh\\nexit 0\\n\' > "$UV_PROJECT_ENVIRONMENT/bin/python"',
    'cat > "$UV_PROJECT_ENVIRONMENT/bin/pecot" <<\'STUB\'',
    '#!/usr/bin/env bash',
    'echo "argv:$*"',
    'echo "root:${CLAUDE_PLUGIN_ROOT:-}"',
    'echo "data:${CLAUDE_PLUGIN_DATA:-}"',
    'echo "skip:${PECOT_BOOTSTRAP_SKIP-<unset>}"',
    'echo "self:$0"',
    'STUB',
    'chmod +x "$UV_PROJECT_ENVIRONMENT/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/pecot"',
    '',
  ].join('\n')
}

// 隔離プラグインルートと mock uv を用意する。
function setUp(hookCase: HookCase): Wrapper {
  const pluginRoot = makePluginRoot(hookCase)
  const uvLog = path.join(hookCase.temporaryPath, 'uv.log')
  mockBin(hookCase).install('uv', uvMockBody(uvLog))
  return { pluginRoot, wrapper: path.join(pluginRoot, 'bin', 'pecot'), uvLog }
}

function makeDataDirectory(hookCase: HookCase): string {
  const directory = path.join(hookCase.temporaryPath, 'plugin-data')
  mkdirSync(directory)
  return directory
}

function runWrapper(hookCase: HookCase, wrapper: string, argv: readonly string[], environment: EnvironmentOverrides): RunResult {
  return run(hookCase, wrapper, argv, { env: { ...ENV_KEYS_CLEARED, ...environment } })
}

function runWrapperAsync(hookCase: HookCase, wrapper: string, argv: readonly string[], environment: EnvironmentOverrides): Promise<RunResult> {
  return runAsync(hookCase, wrapper, argv, { env: { ...ENV_KEYS_CLEARED, ...environment } })
}

function stderrLines(result: RunResult): string[] {
  return splitLines(result.stderr).filter(line => line !== '')
}

// [install 行数, build 行数]
function counts(result: RunResult): [number, number] {
  const lines = stderrLines(result)
  return [lines.filter(line => line === INSTALLING).length, lines.filter(line => line === BUILDING).length]
}

// コードポイント順（Python の sorted と同じ）
function compareText(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function venvDirectories(dataDirectory: string): string[] {
  const venv = path.join(dataDirectory, 'venv')
  return existsSync(venv) && statSync(venv).isDirectory()
    ? readdirSync(venv, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .toSorted(compareText)
    : []
}

function currentOf(dataDirectory: string): string {
  return readlinkSync(path.join(dataDirectory, 'venv', 'current'))
}

// ルート配下の全エントリの mtime（ns）。
function snapshot(root: string): [string, string][] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map(entry => path.join(root, entry))
    .toSorted(compareText)
    .map(entry => [entry, String(lstatSync(entry, { bigint: true }).mtimeNs)])
}

// 実体が出す "key:value" の行を key ごとにまとめる。
function stdoutMap(result: RunResult): Map<string, string> {
  const output = new Map<string, string>()
  for (const line of splitLines(result.stdout)) {
    const separator = line.indexOf(':')
    if (separator === -1) output.set(line, '')
    else output.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return output
}

function go(hookCase: HookCase, wrapper: string, dataDirectory: string, extra: EnvironmentOverrides = {}): RunResult {
  return runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory, ...extra })
}

function goAsync(hookCase: HookCase, wrapper: string, dataDirectory: string, extra: EnvironmentOverrides = {}): Promise<RunResult> {
  return runWrapperAsync(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory, ...extra })
}

function writeSource(pluginRoot: string, content: string): void {
  writeFileSync(path.join(pluginRoot, 'cli', 'commands', 'main.py'), content)
}

function writePluginJson(pluginRoot: string, version: string): void {
  writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), `{ "name": "pecot-w", "version": "${version}" }\n`)
}

function writeDevelopmentPecot(pluginRoot: string, body: string): void {
  const venvBin = path.join(pluginRoot, 'cli', '.venv', 'bin')
  mkdirSync(venvBin, { recursive: true })
  const developmentPecot = path.join(venvBin, 'pecot')
  writeFileSync(developmentPecot, body)
  chmodSync(developmentPecot, 0o755)
}

function setMtime(file: string, seconds: number): void {
  utimesSync(file, seconds, seconds)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

// 新しいルート（2.0.0）のコピーを、古い版（1.0.0・別ソース）のルートにする。
function makeOldRoot(hookCase: HookCase, pluginRoot: string): string {
  const old = path.join(hookCase.temporaryPath, 'old-root')
  cpSync(pluginRoot, old, { recursive: true })
  writePluginJson(old, '1.0.0')
  writeSource(old, 'print(\'old\')\n')
  return old
}

interface ConcurrentStart {
  readonly results: RunResult[]
  readonly installs: number
  readonly builds: number
}

// 2 つの wrapper を同時に起動する。sync に 1 秒かけて、重なりを作る。
async function startConcurrently(hookCase: HookCase, wrapper: string, dataDirectory: string): Promise<ConcurrentStart> {
  const results = await Promise.all([
    goAsync(hookCase, wrapper, dataDirectory, { UV_DELAY: '1' }),
    goAsync(hookCase, wrapper, dataDirectory, { UV_DELAY: '1' }),
  ])
  return {
    results,
    installs: results.reduce((total, result) => total + counts(result)[0], 0),
    builds: results.reduce((total, result) => total + counts(result)[1], 0),
  }
}

interface SharedLock {
  release(): Promise<void>
}

// flock(1) を子プロセスで動かし、file に共有ロックを持たせる。release() で手放し、終了を待つ。
async function holdSharedLock(hookCase: HookCase, file: string): Promise<SharedLock> {
  const ready = `${file}.ready`
  const releaseFlag = `${file}.release`
  const script = `touch "${ready}"; i=0; while [ ! -e "${releaseFlag}" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done`
  const holder = runAsync(hookCase, 'flock', ['-s', file, 'sh', '-c', script])
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await sleep(50)
  return {
    async release() {
      writeFileSync(releaseFlag, '')
      await holder
    },
  }
}

// flock を除いた PATH（macOS 相当）にする。mock uv の PATH 先頭は維持する。
function removeFlockFromPath(hookCase: HookCase): void {
  const shim = path.join(hookCase.temporaryPath, 'noflock-bin')
  mkdirSync(shim)
  for (const directory of ['/usr/bin', '/bin']) {
    for (const name of readdirSync(directory)) {
      const target = path.join(shim, name)
      if (name !== 'flock' && lstatSync(target, { throwIfNoEntry: false }) === undefined) symlinkSync(path.join(directory, name), target)
    }
  }
  const kept = (hookCase.getEnv('PATH') ?? '').split(':')
    .filter(directory => directory !== '/usr/bin' && directory !== '/bin' && !existsSync(path.join(directory, 'flock')))
  hookCase.setEnv('PATH', [...kept, shim].join(':'))
}

function commandPath(hookCase: HookCase, name: string): string {
  return run(hookCase, 'sh', ['-c', `command -v ${name}`]).stdout.trim()
}

describe('bin/pecot wrapper', () => {
  describe('解決順と停止', () => {
    it('CLAUDE_PLUGIN_DATA と PLUGIN_DATA が両方あるとき、CLAUDE_PLUGIN_DATA を使う', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const other = path.join(hookCase.temporaryPath, 'other-data')
      mkdirSync(other)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory, PLUGIN_DATA: other })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(dataDirectory)).not.toEqual([])
      expect(venvDirectories(other)).toEqual([])
    })

    it('CLAUDE_PLUGIN_DATA が無いとき、PLUGIN_DATA を使う', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(dataDirectory)).toHaveLength(1)
    })

    it.for([
      { label: '空文字', invalid: '' },
      { label: '相対パス', invalid: 'relative/dir' },
      { label: '未展開の変数', invalid: '${CLAUDE_PLUGIN_DATA}' },
      { label: '未展開の変数で始まるパス', invalid: '${PLUGIN_DATA}/x' },
    ])('CLAUDE_PLUGIN_DATA が $label のとき、次の候補に進む', (row) => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: row.invalid, PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(dataDirectory)).toHaveLength(1)
    })

    it('実在しない絶対パスのとき、作って使う', () => {
      // クライアントの値は実在しなくても作って使う。既定の場所へ落とすと置き場が 2 か所に割れる
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const data = path.join(hookCase.temporaryPath, 'not-yet', 'created', 'data')
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: data })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(data)).toHaveLength(1)
    })

    it.for([
      { label: 'LF', suffix: '\n' },
      { label: 'CRLF', suffix: '\r\n' },
      { label: 'CR', suffix: '\r' },
    ])('値の末尾に $label が付いていても、許容して使う', (row) => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: `${dataDirectory}${row.suffix}` })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(dataDirectory)).toHaveLength(1)
    })
  })

  describe('既定の場所（クライアントが置き場を渡さない起動）', () => {
    it('XDG_DATA_HOME が有効なとき、その配下を使い HOME 側には作らない', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const xdg = path.join(hookCase.temporaryPath, 'xdg-share')
      const home = path.join(hookCase.temporaryPath, 'home')
      mkdirSync(home)
      const result = runWrapper(hookCase, wrapper, ['--version'], { ...NO_CLIENT_DATA, XDG_DATA_HOME: xdg, HOME: home })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(path.join(xdg, 'pecot', 'pecot-workflow'))).toHaveLength(1)
      // 有効な XDG_DATA_HOME があれば HOME 側には作らない
      expect(existsSync(path.join(home, '.local'))).toBe(false)
    })

    it.for([
      { label: '空文字', xdg: '' },
      { label: '相対パス', xdg: 'relative/share' },
      { label: '未展開の変数', xdg: '${XDG_DATA_HOME}' },
    ])('XDG_DATA_HOME が $label のとき、HOME 配下を使う', (row) => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const home = path.join(hookCase.temporaryPath, 'home')
      mkdirSync(home)
      const result = runWrapper(hookCase, wrapper, ['--version'], { ...NO_CLIENT_DATA, XDG_DATA_HOME: row.xdg, HOME: home })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(path.join(home, '.local', 'share', 'pecot', 'pecot-workflow'))).toHaveLength(1)
    })

    it('XDG_DATA_HOME が有効なとき、HOME が空でも動く', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const xdg = path.join(hookCase.temporaryPath, 'xdg-share')
      const result = runWrapper(hookCase, wrapper, ['--version'], { ...NO_CLIENT_DATA, XDG_DATA_HOME: xdg, HOME: '' })
      expect(result.exitCode).toBe(0)
      expect(venvDirectories(path.join(xdg, 'pecot', 'pecot-workflow'))).toHaveLength(1)
    })

    it.for([
      { label: '何も渡さない', environment: { ...NO_CLIENT_DATA, XDG_DATA_HOME: '', HOME: '' } },
      { label: 'XDG_DATA_HOME が相対パス', environment: { ...NO_CLIENT_DATA, XDG_DATA_HOME: 'relative/share', HOME: '' } },
      {
        label: '候補がすべて無効',
        environment: { CLAUDE_PLUGIN_DATA: 'relative', PLUGIN_DATA: '${PLUGIN_DATA}', XDG_DATA_HOME: '', HOME: '' },
      },
    ])('HOME が無く有効な XDG_DATA_HOME も無いとき（$label）、1 行だけ出して止まる', (row) => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper, uvLog } = setUp(hookCase)
      const before = snapshot(pluginRoot)
      const result = runWrapper(hookCase, wrapper, ['project', 'info'], row.environment)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      const lines = stderrLines(result)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.startsWith(MSG_NO_HOME)).toBe(true)
      // 本体配下に何も作らない
      expect(snapshot(pluginRoot)).toEqual(before)
      // uv を呼ばない
      expect(existsSync(uvLog)).toBe(false)
    })
  })

  describe('PECOT_BOOTSTRAP_SKIP', () => {
    it('SKIP=1 のとき、ソースツリーの venv を動かし、データ置き場には触れない', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper, uvLog } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      writeDevelopmentPecot(
        pluginRoot,
        '#!/usr/bin/env bash\necho "argv:$*"\necho "root:${CLAUDE_PLUGIN_ROOT:-}"\n'
        + 'echo "skip:${PECOT_BOOTSTRAP_SKIP-<unset>}"\n',
      )
      const result = runWrapper(hookCase, wrapper, ['--version'], { PECOT_BOOTSTRAP_SKIP: '1', CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      const output = stdoutMap(result)
      expect(output.get('argv')).toBe('--version')
      expect(output.get('root')).toBe(pluginRoot)
      // SKIP=1 ではデータ置き場に何も作らない
      expect(readdirSync(dataDirectory)).toEqual([])
      expect(existsSync(uvLog)).toBe(false)
    })

    it('SKIP=1 のとき、データ置き場を決められない環境でも動く', () => {
      // SKIP はデータ置き場に触れない
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      writeDevelopmentPecot(pluginRoot, '#!/usr/bin/env bash\necho "argv:$*"\n')
      const result = runWrapper(hookCase, wrapper, ['a'], { ...NO_CLIENT_DATA, XDG_DATA_HOME: '', HOME: '', PECOT_BOOTSTRAP_SKIP: '1' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('argv:a')
    })

    it('SKIP=1 でソースツリーの venv が無いとき、1 行だけ出して失敗する', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['a'], { PECOT_BOOTSTRAP_SKIP: '1', CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(stderrLines(result)).toHaveLength(1)
      expect(readdirSync(dataDirectory)).toEqual([])
    })
  })

  describe('呼び出しの形（uv sync と exec）', () => {
    it('uv sync を決まった引数と env で呼ぶ', () => {
      const hookCase = createHookCase()
      const { wrapper, uvLog } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['issue', 'read', 'owner/repo#1', '--json'], {
        CLAUDE_PLUGIN_DATA: dataDirectory,
        VIRTUAL_ENV: '/user/project/.venv',
        UV_NO_SYNC: '1',
        UV_PROJECT_ENVIRONMENT: '/somewhere/else/.venv',
      })
      expect(result.exitCode).toBe(0)
      const venvNames = venvDirectories(dataDirectory)
      expect(venvNames).toHaveLength(1)
      const venvName = venvNames[0] ?? ''
      const log = splitLines(readFileSync(uvLog, 'utf8'))
      const argumentsLine = log.find(line => line.startsWith('ARGS:'))
      const stage = path.join(dataDirectory, 'venv', `.stage-${venvName}`)
      expect(argumentsLine).toBe(`ARGS:sync --frozen --no-dev --no-editable --quiet --project ${stage}`)
      expect(log).toContain(`ENV:UV_PROJECT_ENVIRONMENT=${dataDirectory}/venv/${venvName}`)
      expect(log).toContain('ENV:VIRTUAL_ENV=<unset>')
      expect(log).toContain('ENV:UV_NO_SYNC=<unset>')
    })

    it('実体を exec し、CLAUDE_PLUGIN_ROOT を export する', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const argv = ['issue', 'read', 'owner/repo#1', '--json']
      const result = runWrapper(hookCase, wrapper, argv, { CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      const venvNames = venvDirectories(dataDirectory)
      expect(venvNames).toHaveLength(1)
      const output = stdoutMap(result)
      expect(output.get('argv')).toBe(argv.join(' '))
      expect(output.get('root')).toBe(pluginRoot)
      // 受け継いだ CLAUDE_PLUGIN_DATA はそのまま実体に届く
      expect(output.get('data')).toBe(dataDirectory)
      // wrapper は SKIP を export しない
      expect(output.get('skip')).toBe('<unset>')
      expect(output.get('self')).toBe(`${dataDirectory}/venv/${venvNames[0] ?? ''}/bin/pecot`)
    })

    it('ステージに生成物を含めず、プラグインルートを変えない', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper, uvLog } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const before = snapshot(pluginRoot)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      const staged = splitLines(readFileSync(uvLog, 'utf8'))
        .filter(line => line.startsWith('STAGE:'))
        .map(line => line.slice('STAGE:'.length))
      expect(staged).toEqual(expect.arrayContaining(['pyproject.toml', 'uv.lock', '__init__.py', 'commands']))
      expect(staged.filter(name => ['.venv', '__pycache__', 'pecot.egg-info', 'build'].includes(name))).toEqual([])
      expect(snapshot(pluginRoot)).toEqual(before)
      // ステージは残さない
      expect(readdirSync(path.join(dataDirectory, 'venv')).filter(name => name.startsWith('.stage-'))).toEqual([])
    })

    it('current は作ったディレクトリを指す', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      const venvNames = venvDirectories(dataDirectory)
      expect(venvNames).toHaveLength(1)
      expect(currentOf(dataDirectory)).toBe(venvNames[0])
      expect(statSync(path.join(dataDirectory, 'venv', 'current', 'bin', 'python')).isFile()).toBe(true)
    })
  })

  describe('プラグインルートの解決', () => {
    it('CLAUDE_PLUGIN_ROOT があるとき、それを優先する', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const other = path.join(hookCase.temporaryPath, 'other-root')
      cpSync(pluginRoot, other, { recursive: true })
      writeSource(other, 'print(\'other\')\n')
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_ROOT: other, CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(stdoutMap(result).get('root')).toBe(other)
    })

    it('CLAUDE_PLUGIN_ROOT に plugin.json が無いとき、wrapper の位置から解決する', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const noManifest = path.join(hookCase.temporaryPath, 'no-manifest')
      mkdirSync(noManifest)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_ROOT: noManifest, CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(stdoutMap(result).get('root')).toBe(pluginRoot)
    })

    it('CLAUDE_PLUGIN_ROOT が無いとき、wrapper の位置から解決する', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = runWrapper(hookCase, wrapper, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(stdoutMap(result).get('root')).toBe(pluginRoot)
    })

    it('symlink 経由で起動しても、実体の位置からプラグインルートを解決する', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const linkDirectory = path.join(hookCase.temporaryPath, 'path-bin')
      mkdirSync(linkDirectory)
      const link = path.join(linkDirectory, 'pecot')
      symlinkSync(wrapper, link)
      const result = runWrapper(hookCase, link, ['--version'], { CLAUDE_PLUGIN_DATA: dataDirectory })
      expect(result.exitCode).toBe(0)
      expect(stdoutMap(result).get('root')).toBe(pluginRoot)
    })
  })

  describe('install と build の回数', () => {
    it('初回は 1 回ずつ行い、変更が無ければ 2 回目は何もしない', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const first = go(hookCase, wrapper, dataDirectory)
      expect(first.exitCode).toBe(0)
      expect(counts(first)).toEqual([1, 1])
      const second = go(hookCase, wrapper, dataDirectory)
      expect(second.exitCode).toBe(0)
      expect(counts(second)).toEqual([0, 0])
      expect(stderrLines(second)).toEqual([])
    })

    it('版の更新だけのとき、build をしない', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const before = venvDirectories(dataDirectory)
      writePluginJson(pluginRoot, '2.0.0')
      writeFileSync(path.join(pluginRoot, 'CHANGELOG.md'), '# 2.0.0\n')
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([0, 0])
      expect(venvDirectories(dataDirectory)).toEqual(before)
      expect(currentOf(dataDirectory)).toBe(before[0])
    })

    it('ソースだけの更新のとき、install せずに build を 1 回行う', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const firstDirectory = currentOf(dataDirectory)
      writeSource(pluginRoot, 'print(\'v2\')\n')
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([0, 1])
      expect(currentOf(dataDirectory)).not.toBe(firstDirectory)
      expect(venvDirectories(dataDirectory)).toHaveLength(2)
      expect(counts(go(hookCase, wrapper, dataDirectory))).toEqual([0, 0])
    })

    it('pyproject.toml の変更は、ソースの変更として数える', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      writeFileSync(path.join(pluginRoot, 'cli', 'pyproject.toml'), '[project]\nname = "pecot"\n# x\n')
      expect(counts(go(hookCase, wrapper, dataDirectory))).toEqual([0, 1])
    })

    it('lock の変更のとき、install と build を行う', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      writeFileSync(path.join(pluginRoot, 'cli', 'uv.lock'), 'lock-v2\n')
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([1, 1])
      expect(counts(go(hookCase, wrapper, dataDirectory))).toEqual([0, 0])
    })

    it('生成物が増えても、ソースのハッシュは変わらない', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      writeFileSync(path.join(pluginRoot, 'cli', '__pycache__', 'y.pyc'), Buffer.from([1]))
      writeFileSync(path.join(pluginRoot, 'cli', 'pecot.egg-info', 'SOURCES.txt'), 'y')
      mkdirSync(path.join(pluginRoot, 'cli', '.venv'))
      writeFileSync(path.join(pluginRoot, 'cli', '.venv', 'junk'), 'y')
      expect(counts(go(hookCase, wrapper, dataDirectory))).toEqual([0, 0])
    })

    it('ディレクトリ名は lock のハッシュとソースのハッシュからなる', () => {
      // どちらもディレクトリ名 <lock>-<src> の 2 要素で、sha256 の 16 進
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const names = venvDirectories(dataDirectory)
      expect(names).toHaveLength(1)
      const name = names[0] ?? ''
      const separator = name.indexOf('-')
      const lockHash = name.slice(0, separator)
      const sourceHash = name.slice(separator + 1)
      expect(lockHash.length).toBeGreaterThanOrEqual(12)
      expect(sourceHash.length).toBeGreaterThanOrEqual(12)
      expect(`${lockHash}${sourceHash}`).toMatch(/^[\da-f]+$/u)
    })
  })

  describe('途中で止まったとき・同時起動・世代削除', () => {
    it('sync が失敗したとき、完成印を残さず current を保ち、直せば作り直す', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const good = currentOf(dataDirectory)
      writeSource(pluginRoot, 'print(\'broken\')\n')
      const result = go(hookCase, wrapper, dataDirectory, { UV_FAIL: '1' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(currentOf(dataDirectory)).toBe(good)
      const broken = venvDirectories(dataDirectory).filter(name => name !== good)
      expect(broken.filter(name => existsSync(path.join(dataDirectory, 'venv', name, '.pecot-complete')))).toEqual([])
      expect(readdirSync(path.join(dataDirectory, 'venv')).filter(name => name.startsWith('.stage-'))).toEqual([])
      // 直せば作り直される
      writeSource(pluginRoot, 'print(\'fixed\')\n')
      const again = go(hookCase, wrapper, dataDirectory)
      expect(again.exitCode).toBe(0)
      expect(counts(again)).toEqual([0, 1])
      expect(currentOf(dataDirectory)).not.toBe(good)
    })

    it('完成印が無いディレクトリは、作り直す', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const name = venvDirectories(dataDirectory)[0] ?? ''
      const mark = path.join(dataDirectory, 'venv', name, '.pecot-complete')
      rmSync(mark)
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      // 完成済みの同 lock の venv が無いので、依存の導入も伴う
      expect(counts(result)).toEqual([1, 1])
      expect(statSync(mark).isFile()).toBe(true)
    })

    it('完成印があっても python が無いディレクトリは、作り直す', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const name = venvDirectories(dataDirectory)[0] ?? ''
      const python = path.join(dataDirectory, 'venv', name, 'bin', 'python')
      rmSync(python)
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([1, 1])
      expect(statSync(python).isFile()).toBe(true)
    })

    it('同時に起動しても、install と build は 1 回ずつで、sync も 1 回だけ呼ぶ', async () => {
      const hookCase = createHookCase()
      const { wrapper, uvLog } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const started = await startConcurrently(hookCase, wrapper, dataDirectory)
      expect(started.results.map(result => result.exitCode)).toEqual([0, 0])
      expect([started.installs, started.builds]).toEqual([1, 1])
      const syncCalls = splitLines(readFileSync(uvLog, 'utf8')).filter(line => line.startsWith('ARGS:sync'))
      expect(syncCalls).toHaveLength(1)
    })

    it('世代が増えたとき、current と新しい 2 世代だけを残す', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const names: string[] = []
      for (const n of [2, 3, 4, 5]) {
        writeSource(pluginRoot, `print(${String(n)})\n`)
        expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
        names.push(currentOf(dataDirectory))
        setMtime(path.join(dataDirectory, 'venv', currentOf(dataDirectory), '.pecot-complete'), n * 1000)
      }
      expect(new Set(names).size).toBe(4)
      expect(venvDirectories(dataDirectory)).toEqual(names.slice(-2).toSorted(compareText))
      expect(currentOf(dataDirectory)).toBe(names.at(-1))
    })

    it('使用中の世代は、消さない', async () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      writeSource(pluginRoot, 'print(2)\n')
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const oldest = currentOf(dataDirectory)
      setMtime(path.join(dataDirectory, 'venv', oldest, '.pecot-complete'), 1000)
      const held = await holdSharedLock(hookCase, path.join(dataDirectory, 'venv', oldest, '.inuse'))
      const exitCodes: number[] = []
      try {
        for (const n of [3, 4, 5]) {
          writeSource(pluginRoot, `print(${String(n)})\n`)
          exitCodes.push(go(hookCase, wrapper, dataDirectory).exitCode)
          setMtime(path.join(dataDirectory, 'venv', currentOf(dataDirectory), '.pecot-complete'), n * 1000)
        }
      }
      finally {
        await held.release()
      }
      expect(exitCodes).toEqual([0, 0, 0])
      const remaining = venvDirectories(dataDirectory)
      // 使用中（.inuse に共有ロックあり）の世代は消さない
      expect(remaining).toContain(oldest)
      expect(remaining).toContain(currentOf(dataDirectory))
      expect(remaining).toHaveLength(3)
    })

    it('exec した実体が動いている間、.inuse の共有ロックを持ち続ける', async () => {
      // 実体が生きている間は、排他ロックが取れない
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const name = venvDirectories(dataDirectory)[0] ?? ''
      writeFileSync(path.join(dataDirectory, 'venv', name, 'bin', 'pecot'), '#!/bin/sh\nsleep 3\n')
      const running = runWrapperAsync(hookCase, wrapper, ['x'], { CLAUDE_PLUGIN_DATA: dataDirectory })
      const inuse = path.join(dataDirectory, 'venv', name, '.inuse')
      let isBlocked = false
      for (let attempt = 0; !isBlocked && attempt < 50; attempt += 1) {
        isBlocked = run(hookCase, 'flock', ['-n', '-x', inuse, 'true']).exitCode === 1
        if (!isBlocked) await sleep(100)
      }
      await running
      // 実体が生きている間は共有ロックが残る
      expect(isBlocked).toBe(true)
      expect(run(hookCase, 'flock', ['-n', '-x', inuse, 'true']).exitCode).toBe(0)
    })

    it('プラグインルートが読み取り専用でも、初回の準備ができる', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      expect(run(hookCase, 'chmod', ['-R', 'a-w', pluginRoot]).exitCode).toBe(0)
      let result: RunResult
      try {
        result = go(hookCase, wrapper, dataDirectory)
      }
      finally {
        run(hookCase, 'chmod', ['-R', 'u+w', pluginRoot])
      }
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([1, 1])
    })

    it('準備の進捗は stderr だけに出し、stdout は実体の出力だけにする', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(splitLines(result.stdout).some(line => line.startsWith('pecot:'))).toBe(false)
    })
  })

  describe('新旧 2 つのプラグインルートが同じデータ置き場を共有するとき', () => {
    it('旧版のセッションは、current を戻さない', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      writePluginJson(pluginRoot, '2.0.0')
      const old = makeOldRoot(hookCase, pluginRoot)
      const oldWrapper = path.join(old, 'bin', 'pecot')

      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      const newDirectory = currentOf(dataDirectory)
      const oldResult = go(hookCase, oldWrapper, dataDirectory, { CLAUDE_PLUGIN_ROOT: old })
      expect(oldResult.exitCode).toBe(0)
      expect(stdoutMap(oldResult).get('root')).toBe(old)
      // 旧版の準備で current を戻さない
      expect(currentOf(dataDirectory)).toBe(newDirectory)
      expect(venvDirectories(dataDirectory)).toHaveLength(2)
      const again = go(hookCase, wrapper, dataDirectory)
      expect(counts(again)).toEqual([0, 0])
      expect(currentOf(dataDirectory)).toBe(newDirectory)
      // 旧版は、2 回目以降の準備がなく、current も動かない
      expect(counts(go(hookCase, oldWrapper, dataDirectory, { CLAUDE_PLUGIN_ROOT: old }))).toEqual([0, 0])
      expect(currentOf(dataDirectory)).toBe(newDirectory)
    })

    it('新しい版は、旧版から current を引き継ぐ', () => {
      const hookCase = createHookCase()
      const { pluginRoot, wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      writePluginJson(pluginRoot, '2.0.0')
      const old = makeOldRoot(hookCase, pluginRoot)
      expect(go(hookCase, path.join(old, 'bin', 'pecot'), dataDirectory, { CLAUDE_PLUGIN_ROOT: old }).exitCode).toBe(0)
      const oldDirectory = currentOf(dataDirectory)
      expect(go(hookCase, wrapper, dataDirectory).exitCode).toBe(0)
      expect(currentOf(dataDirectory)).not.toBe(oldDirectory)
    })
  })

  describe('flock が無い環境のロックファイル', () => {
    it('同時に起動しても、install と build は 1 回ずつで、ロックファイルを残さない', async () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      removeFlockFromPath(hookCase)
      expect(commandPath(hookCase, 'flock')).toBe('')
      const started = await startConcurrently(hookCase, wrapper, dataDirectory)
      expect(started.results.map(result => result.exitCode)).toEqual([0, 0])
      expect([started.installs, started.builds]).toEqual([1, 1])
      expect(existsSync(path.join(dataDirectory, 'venv', '.lock.pid'))).toBe(false)
    })

    it('mkdir が非アトミックでも、ロックは保たれる', async () => {
      // 既にあっても成功を返す mkdir（同時に呼ぶと 2 人とも成功する uutils coreutils を再現する）
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      removeFlockFromPath(hookCase)
      expect(commandPath(hookCase, 'flock')).toBe('')
      const lax = path.join(hookCase.temporaryPath, 'lax-mkdir-bin')
      mkdirSync(lax)
      const real = commandPath(hookCase, 'mkdir')
      writeFileSync(path.join(lax, 'mkdir'), `#!/bin/sh\n"${real}" -p "$@" 2>/dev/null\nexit 0\n`)
      chmodSync(path.join(lax, 'mkdir'), 0o755)
      hookCase.setEnv('PATH', `${lax}:${hookCase.getEnv('PATH') ?? ''}`)
      const started = await startConcurrently(hookCase, wrapper, dataDirectory)
      expect(started.results.map(result => result.exitCode)).toEqual([0, 0])
      expect([started.installs, started.builds]).toEqual([1, 1])
      expect(existsSync(path.join(dataDirectory, 'venv', '.lock.pid'))).toBe(false)
    })

    it('持ち主が死んだロックは、rename で回収する', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const dataDirectory = makeDataDirectory(hookCase)
      removeFlockFromPath(hookCase)
      expect(commandPath(hookCase, 'flock')).toBe('')
      const stale = path.join(dataDirectory, 'venv', '.lock.pid')
      mkdirSync(path.dirname(stale), { recursive: true })
      // 終わったシェルの PID を、死んだ持ち主として書く
      const deadPid = run(hookCase, 'sh', ['-c', 'echo $$']).stdout.trim()
      writeFileSync(stale, `${deadPid}\n`)
      const result = go(hookCase, wrapper, dataDirectory)
      expect(result.exitCode).toBe(0)
      expect(counts(result)).toEqual([1, 1])
      expect(existsSync(stale)).toBe(false)
      expect(readdirSync(path.join(dataDirectory, 'venv')).filter(name => name.startsWith('.lock.pid.stale.'))).toEqual([])
    })
  })

  describe('失敗の理由', () => {
    it('ロックに失敗したとき、理由の 1 行を stderr に出す', () => {
      const hookCase = createHookCase()
      const { wrapper } = setUp(hookCase)
      const data = path.join(hookCase.temporaryPath, 'ro-data')
      mkdirSync(data)
      writeFileSync(path.join(data, 'venv'), 'a file, not a directory')
      const result = go(hookCase, wrapper, data)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(stderrLines(result).some(line => line.startsWith('pecot: '))).toBe(true)
    })
  })
})
