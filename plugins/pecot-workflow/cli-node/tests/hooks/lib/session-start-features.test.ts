/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// git-sync.sh・vscode-workspace-detector.sh・session-project-dir.sh と、session-start.sh の出力の形のテスト。
// git・uvx・code を stub にして PATH の先頭に置く。git の stub は、-C の値が FAKE_REPO_ROOT と違えば exit 99 で落とす。
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { gitRepository, installGitCallLog } from '../_helpers/git.js'
import type { GitCallLog } from '../_helpers/git.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, jsonDumps, parseJson } from '../_helpers/text.js'

const SESSION_START_DIRECTORY = path.join(hooksDirectory, 'lib', 'session-start')
const GIT_SYNC_SCRIPT = path.join(SESSION_START_DIRECTORY, 'git-sync.sh')
const VSCODE_SCRIPT = path.join(SESSION_START_DIRECTORY, 'vscode-workspace-detector.sh')
const SESSION_PROJECT_DIRECTORY_SCRIPT = path.join(SESSION_START_DIRECTORY, 'session-project-dir.sh')
const SESSION_START_ENTRY = path.join(hooksDirectory, 'session-start.sh')

const GIT_SYNC_STUB = [
  '#!/bin/bash',
  'if [ "$1" = "-C" ]; then',
  '    [ "$2" = "$FAKE_REPO_ROOT" ] || exit 99',
  '    shift 2',
  'fi',
  'case "$*" in',
  '    "diff --quiet") exit "$FAKE_GIT_DIFF_EXIT" ;;',
  '    "diff --staged --quiet") exit "$FAKE_GIT_STAGED_EXIT" ;;',
  '    "branch --show-current") echo "$FAKE_BRANCH" ;;',
  '    pull) exit "$FAKE_GIT_PULL_EXIT" ;;',
  '    *) exit 0 ;;',
  'esac',
  '',
].join('\n')

const GIT_SYNC_ENV_STUB = [
  '#!/bin/bash',
  'if [ "$1" = "-C" ]; then',
  '    shift 2',
  'fi',
  'case "$*" in',
  '    "diff --quiet" | "diff --staged --quiet") exit 0 ;;',
  '    "branch --show-current") echo main ;;',
  '    pull) printf \'%s\\n\' "$GIT_SSH_COMMAND" > "$FAKE_PULL_ENV_LOG"; exit 0 ;;',
  '    *) exit 0 ;;',
  'esac',
  '',
].join('\n')

const UVX_STUB = '#!/bin/bash\nexit 0\n'

// vscode-workspace-detector は git を呼ばない。呼んだら見つかるよう exit 99 にする。
const VSCODE_GIT_STUB = '#!/bin/bash\nexit 99\n'

const CODE_WORKSPACE_STUB = [
  '#!/bin/bash',
  'case "$*" in',
  '    --status)',
  '        echo "window [1] (README.md - MyProject (Workspace) - Visual Studio Code)"',
  '        exit 0',
  '        ;;',
  '    *) exit 0 ;;',
  'esac',
  '',
].join('\n')

function makeStub(stubDirectory: string, name: string, body: string): void {
  const file = path.join(stubDirectory, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

function makeStubDirectory(hookCase: HookCase): string {
  const stubDirectory = path.join(hookCase.temporaryPath, 'stubs')
  mkdirSync(stubDirectory)
  return stubDirectory
}

// stub を PATH の先頭に置いて動かす。CLAUDE_PROJECT_DIR は extra で明示したときだけ渡す。
function runWithPath(hookCase: HookCase, script: string, stubDirectory: string, extraEnvironment: EnvironmentOverrides): RunResult {
  return run(hookCase, script, [], {
    env: {
      ...extraEnvironment,
      PATH: `${stubDirectory}:${hookCase.getEnv('PATH') ?? ''}`,
      ...(!('CLAUDE_PROJECT_DIR' in extraEnvironment) && { CLAUDE_PROJECT_DIR: undefined }),
    },
  })
}

function gitSyncEnvironment(hookCase: HookCase, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const repositoryRoot = path.join(hookCase.temporaryPath, 'repo')
  mkdirSync(path.join(repositoryRoot, '.git'), { recursive: true })
  return {
    CLAUDE_PROJECT_DIR: repositoryRoot,
    FAKE_REPO_ROOT: repositoryRoot,
    FAKE_GIT_DIFF_EXIT: '0',
    FAKE_GIT_STAGED_EXIT: '0',
    FAKE_BRANCH: 'main',
    FAKE_GIT_PULL_EXIT: '0',
    ...overrides,
  }
}

function gitIn(hookCase: HookCase, repository: string, argv: readonly string[]): string {
  const result = run(hookCase, 'git', argv, { cwd: repository })
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が失敗しました: ${result.stderr}`)
  return result.stdout
}

// JSON の値から keys をたどった先を返す。無ければ undefined。
function valueAt(value: unknown, ...keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

// 到達できない origin を持つリポを作る。pull は失敗する。
function setUpUnreachableRepository(hookCase: HookCase, name: string): { repository: string, unreachable: string, gitCallLog: GitCallLog } {
  const repository = gitRepository(hookCase, name)
  const unreachable = path.join(path.dirname(repository), 'no-such-remote.git')
  const gitCallLog = installGitCallLog(hookCase)
  const branch = gitIn(hookCase, repository, ['branch', '--show-current']).trim()
  gitIn(hookCase, repository, ['remote', 'add', 'origin', unreachable])
  gitIn(hookCase, repository, ['config', `branch.${branch}.remote`, 'origin'])
  gitIn(hookCase, repository, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
  mockBin(hookCase).install('uvx', 'exit 0\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  gitCallLog.reset()
  return { repository, unreachable, gitCallLog }
}

// 同じリポを origin にした上流を設定し、pull が成功するようにする。
function setUpReachableRepository(hookCase: HookCase, name: string): string {
  const repository = gitRepository(hookCase, name)
  mockBin(hookCase).install('uvx', 'exit 0\n')
  mockBin(hookCase).install('code', 'exit 1\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  const branch = gitIn(hookCase, repository, ['branch', '--show-current']).trim()
  const bare = path.join(path.dirname(repository), `${name}-remote.git`)
  gitIn(hookCase, repository, ['clone', '-q', '--bare', repository, bare])
  gitIn(hookCase, repository, ['remote', 'add', 'origin', bare])
  gitIn(hookCase, repository, ['fetch', '-q', 'origin'])
  gitIn(hookCase, repository, ['branch', '-q', `--set-upstream-to=origin/${branch}`, branch])
  return repository
}

function runSessionStartEntry(hookCase: HookCase, repository: string, payload: Readonly<Record<string, unknown>>): RunResult {
  const stdin = jsonDumps({ hook_event_name: 'SessionStart', cwd: repository, session_id: 'c', ...payload })
  return run(hookCase, 'bash', [SESSION_START_ENTRY], { stdin })
}

// 元のプロジェクトのディレクトリと env ファイルを渡して動かす。
function runSessionProjectDirectory(
  hookCase: HookCase,
  environmentFile: string | undefined,
  projectDirectory: string | undefined,
  extra: EnvironmentOverrides = {},
): RunResult {
  return run(hookCase, SESSION_PROJECT_DIRECTORY_SCRIPT, [], {
    env: {
      CLAUDE_ENV_FILE: environmentFile,
      CLAUDE_PROJECT_DIR: undefined,
      PECOT_ORIGINAL_CLAUDE_PROJECT_DIR: projectDirectory,
      ...extra,
    },
  })
}

function makeEnvironmentFile(hookCase: HookCase): string {
  const file = path.join(hookCase.temporaryPath, 'claude_env')
  writeFileSync(file, '')
  return file
}

describe('session-start のロジックスクリプト', () => {
  describe('git-sync.sh', () => {
    it('作業ツリーが clean で pull に成功したとき、同期した旨とブランチ名を出す', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_STUB)
      makeStub(stubDirectory, 'uvx', UVX_STUB)
      const environment = gitSyncEnvironment(hookCase, { FAKE_BRANCH: 'feature/test' })
      const result = runWithPath(hookCase, GIT_SYNC_SCRIPT, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('note: synced the branch with the remote')
      expect(result.stdout).toContain('synced the branch with the remote')
      expect(result.stdout).toContain('feature/test')
    })

    it.for([
      { label: 'GIT_SSH_COMMAND が未設定', preset: undefined, expected: 'ssh -o BatchMode=yes' },
      { label: 'GIT_SSH_COMMAND が設定済み', preset: 'ssh -i /k/id', expected: 'ssh -i /k/id -o BatchMode=yes' },
    ])('$label のとき、pull は SSH のプロンプトを止め、既存の値を残す', (row) => {
      // GIT_TERMINAL_PROMPT=0 では SSH の認証プロンプトを止められない。BatchMode=yes を足し、既存値は残す
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_ENV_STUB)
      makeStub(stubDirectory, 'uvx', UVX_STUB)
      const log = path.join(hookCase.temporaryPath, 'pull-env.log')
      const environment = gitSyncEnvironment(hookCase, { FAKE_PULL_ENV_LOG: log })
      hookCase.setEnv('GIT_SSH_COMMAND', row.preset)
      const result = runWithPath(hookCase, GIT_SYNC_SCRIPT, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(readFileSync(log, 'utf8').trim()).toBe(row.expected)
    })

    it('未コミットの変更があるとき、何も出力しない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_STUB)
      makeStub(stubDirectory, 'uvx', UVX_STUB)
      const environment = gitSyncEnvironment(hookCase, { FAKE_GIT_DIFF_EXIT: '1' })
      const result = runWithPath(hookCase, GIT_SYNC_SCRIPT, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('pull に失敗しても exit 0 で、同期した旨は出さない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_STUB)
      makeStub(stubDirectory, 'uvx', UVX_STUB)
      const environment = gitSyncEnvironment(hookCase, { FAKE_GIT_PULL_EXIT: '1' })
      const result = runWithPath(hookCase, GIT_SYNC_SCRIPT, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('synced the branch with the remote')
    })

    it('remote に到達できないとき、pull は 1 回だけで、失敗の理由を stderr に出し、exit 0 を返す', () => {
      const hookCase = createHookCase()
      const { unreachable, gitCallLog } = setUpUnreachableRepository(hookCase, 'sync-repo')
      const result = run(hookCase, GIT_SYNC_SCRIPT)
      expect(result.exitCode).toBe(0)
      expect(gitCallLog.count('pull')).toBe(1)
      expect(result.stdout).not.toContain('synced the branch with the remote')
      expect(result.stderr).toContain('fatal:')
      expect(result.stderr).toContain(unreachable)
    })

    it('uv が入っていないとき、何も出力しない', () => {
      // bashrc で PATH が復元されないよう、env -i 相当の環境で動かす
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_STUB)
      // uvx の stub は置かない。command -v uv が失敗する
      const environment = gitSyncEnvironment(hookCase)
      const home = hookCase.getEnv('HOME') ?? '/root'
      const assignments = [
        `PATH=${stubDirectory}:/usr/bin:/bin`,
        `HOME=${home}`,
        ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
      ]
      const result = run(hookCase, 'env', ['-i', ...assignments, 'bash', '--norc', '--noprofile', GIT_SYNC_SCRIPT])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('CLAUDE_PROJECT_DIR が未設定のとき、何もせず、空パスの警告も出さない', () => {
      // git の外で起動した場合
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeStub(stubDirectory, 'git', GIT_SYNC_STUB)
      makeStub(stubDirectory, 'uvx', UVX_STUB)
      const environment = gitSyncEnvironment(hookCase)
      Reflect.deleteProperty(environment, 'CLAUDE_PROJECT_DIR')
      const result = runWithPath(hookCase, GIT_SYNC_SCRIPT, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    })
  })

  describe('vscode-workspace-detector.sh', () => {
    it('ワークスペースを開いているとき、ワークスペース名を出す', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      const repositoryRoot = path.join(hookCase.temporaryPath, 'repo')
      mkdirSync(repositoryRoot)
      makeStub(stubDirectory, 'git', VSCODE_GIT_STUB)
      makeStub(stubDirectory, 'code', CODE_WORKSPACE_STUB)
      const result = runWithPath(hookCase, VSCODE_SCRIPT, stubDirectory, { CLAUDE_PROJECT_DIR: repositoryRoot })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('note: VSCode workspace context')
      expect(result.stdout).toContain('**Workspace:** MyProject')
    })

    it('code --status が失敗したとき、何も出力しない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      const repositoryRoot = path.join(hookCase.temporaryPath, 'repo')
      mkdirSync(repositoryRoot)
      makeStub(stubDirectory, 'git', VSCODE_GIT_STUB)
      makeStub(stubDirectory, 'code', '#!/bin/bash\necho "error" >&2\nexit 1\n')
      const result = runWithPath(hookCase, VSCODE_SCRIPT, stubDirectory, { CLAUDE_PROJECT_DIR: repositoryRoot })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('VSCode Workspace Context')
    })

    it('単一フォルダを開いているとき、何も出力しない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      const repositoryRoot = path.join(hookCase.temporaryPath, 'repo')
      mkdirSync(repositoryRoot)
      makeStub(stubDirectory, 'git', VSCODE_GIT_STUB)
      makeStub(
        stubDirectory,
        'code',
        '#!/bin/bash\ncase "$*" in\n    --status)\n'
        + '        echo "window [1] (README.md - MyFolder - Visual Studio Code)"\n'
        + '        exit 0\n        ;;\n    *) exit 0 ;;\nesac\n',
      )
      const result = runWithPath(hookCase, VSCODE_SCRIPT, stubDirectory, { CLAUDE_PROJECT_DIR: repositoryRoot })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('.code-workspace ファイルがあるとき、フォルダの一覧を出す', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      const repositoryRoot = path.join(hookCase.temporaryPath, 'repo')
      mkdirSync(path.join(repositoryRoot, 'workspaces'), { recursive: true })
      writeFileSync(
        path.join(repositoryRoot, 'workspaces', 'MyProject.code-workspace'),
        '{\n    "folders": [\n'
        + '        {"name": "frontend", "path": "/home/user/frontend"},\n'
        + '        {"name": "backend", "path": "/home/user/backend"}\n'
        + '    ]\n}\n',
      )
      makeStub(stubDirectory, 'git', VSCODE_GIT_STUB)
      makeStub(stubDirectory, 'code', CODE_WORKSPACE_STUB)
      const result = runWithPath(hookCase, VSCODE_SCRIPT, stubDirectory, { CLAUDE_PROJECT_DIR: repositoryRoot })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('note: VSCode workspace context')
      expect(result.stdout).toContain('**Workspace:** MyProject')
      expect(result.stdout).toContain('**Folders:**')
      expect(result.stdout).toContain('frontend')
      expect(result.stdout).toContain('backend')
    })

    it('CLAUDE_PROJECT_DIR が未設定のとき、code --status を呼ばず何も出力しない', () => {
      // git の外で起動した場合
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      const codeMarker = path.join(hookCase.temporaryPath, 'code-called')
      makeStub(stubDirectory, 'git', VSCODE_GIT_STUB)
      makeStub(stubDirectory, 'code', `#!/bin/bash\ntouch "${codeMarker}"\nexit 0\n`)
      const result = runWithPath(hookCase, VSCODE_SCRIPT, stubDirectory, {})
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(codeMarker)).toBe(false)
    })
  })

  describe('session-start.sh（エントリ）', () => {
    it('Copilot の SessionStart(source=new) でも、git pull を 1 回だけ実行する', () => {
      // 旧構成は Copilot が matcher を無視して new / clear / resume の 3 本を起動し、pull が 3 回動いた
      const hookCase = createHookCase()
      const { repository, gitCallLog } = setUpUnreachableRepository(hookCase, 'sync-entry')
      const result = runSessionStartEntry(hookCase, repository, { source: 'new' })
      expect(result.exitCode).toBe(0)
      expect(gitCallLog.count('pull')).toBe(1)
      expect(result.stderr).toContain('fatal:')
    })

    it('git-sync の結果が JSON になり、hookSpecificOutput とトップレベルの両方に additionalContext が入る', () => {
      // Copilot CLI 1.0.103 は SessionStart ではトップレベルの additionalContext だけをモデルに渡す。
      // Claude Code は hookSpecificOutput を読みトップレベルは読まないため、両方に出しても二重に入らない
      const hookCase = createHookCase()
      const repository = setUpReachableRepository(hookCase, 'sync-json')
      const result = runSessionStartEntry(hookCase, repository, { source: 'new' })
      expect(result.exitCode).toBe(0)
      const data = parseJson(result.stdout)
      const context = valueAt(data, 'hookSpecificOutput', 'additionalContext')
      expect(valueAt(data, 'hookSpecificOutput', 'hookEventName')).toBe('SessionStart')
      expect(context).toEqual(containing('note: synced the branch with the remote'))
      expect(context).toEqual(containing('synced the branch with the remote'))
      expect(valueAt(data, 'additionalContext')).toBe(context)
    })

    it('git-sync が素のテキストを出す状態でも、sessionTitle は additionalContext に入り込まない', () => {
      // session-title.sh は session-start-common.sh とは別のスクリプトとして merge に渡す。
      // 同じスクリプトの出力に素のテキストと JSON が入り込むと、JSON が文脈の文字列になってしまう
      const hookCase = createHookCase()
      const repository = setUpReachableRepository(hookCase, 'sync-title')
      const state = path.join(repository, '.pecot', 'state')
      mkdirSync(state, { recursive: true })
      writeFileSync(path.join(repository, '.pecot', '.gitignore'), '*\n')
      writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/1253\n')
      writeFileSync(path.join(state, '.pecot-session-title'), '#1253 題名\n')
      const result = runSessionStartEntry(hookCase, repository, { source: 'startup', transcript_path: '/t/c.jsonl' })
      expect(result.exitCode).toBe(0)
      const data = parseJson(result.stdout)
      const hookContext = valueAt(data, 'hookSpecificOutput', 'additionalContext')
      const topContext = valueAt(data, 'additionalContext')
      expect(valueAt(data, 'hookSpecificOutput', 'sessionTitle')).toBe('#1253 題名')
      expect(hookContext).toEqual(containing('note: synced the branch with the remote'))
      expect(hookContext).not.toEqual(containing('sessionTitle'))
      expect(typeof topContext).toBe('string')
      expect(topContext).not.toEqual(containing('sessionTitle'))
    })
  })

  describe('session-project-dir.sh', () => {
    it('export を env ファイルに追記する', () => {
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const project = gitRepository(hookCase, 'proj')
      const result = runSessionProjectDirectory(hookCase, environmentFile, project)
      expect(result.exitCode).toBe(0)
      expect(readFileSync(environmentFile, 'utf8')).toBe(`export PECOT_SESSION_PROJECT_DIR=${realpathSync(project)}\n`)
    })

    it('元のディレクトリがリポ内のサブディレクトリでも、書く値はその toplevel にする', () => {
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const project = gitRepository(hookCase, 'proj')
      const sub = path.join(project, 'sub')
      mkdirSync(sub)
      runSessionProjectDirectory(hookCase, environmentFile, sub)
      expect(readFileSync(environmentFile, 'utf8')).toBe(`export PECOT_SESSION_PROJECT_DIR=${realpathSync(project)}\n`)
    })

    it('CLAUDE_PROJECT_DIR が上書きされていても、元の値の toplevel を書く', () => {
      // project-root.sh が上書き後の CLAUDE_PROJECT_DIR を使わない
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const origin = gitRepository(hookCase, 'origin')
      const other = gitRepository(hookCase, 'other')
      runSessionProjectDirectory(hookCase, environmentFile, origin, { CLAUDE_PROJECT_DIR: other })
      expect(readFileSync(environmentFile, 'utf8')).toBe(`export PECOT_SESSION_PROJECT_DIR=${realpathSync(origin)}\n`)
    })

    it('パスに空白があっても、source した先で元のパスに戻る', () => {
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const project = gitRepository(hookCase, 'my proj')
      runSessionProjectDirectory(hookCase, environmentFile, project)
      const out = run(hookCase, 'bash', ['-c', 'source "$1"; printf %s "$PECOT_SESSION_PROJECT_DIR"', 'bash', environmentFile])
      expect(out.exitCode).toBe(0)
      expect(out.stdout).toBe(realpathSync(project))
    })

    it.for([
      { label: 'CLAUDE_ENV_FILE', missingEnvironmentFile: true },
      { label: '元のプロジェクトのディレクトリ', missingEnvironmentFile: false },
    ])('$label が未設定のとき、何もしない', (row) => {
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const result = row.missingEnvironmentFile
        ? runSessionProjectDirectory(hookCase, undefined, gitRepository(hookCase, 'proj'))
        : runSessionProjectDirectory(hookCase, environmentFile, undefined)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(readFileSync(environmentFile, 'utf8')).toBe('')
    })

    it('git の外のディレクトリのとき、何もしない', () => {
      const hookCase = createHookCase()
      const environmentFile = makeEnvironmentFile(hookCase)
      const outside = path.join(hookCase.temporaryPath, 'outside')
      mkdirSync(outside)
      const result = runSessionProjectDirectory(hookCase, environmentFile, outside)
      expect(result.exitCode).toBe(0)
      expect(readFileSync(environmentFile, 'utf8')).toBe('')
    })

    it('hooks-config で無効にしたとき、何もしない', () => {
      const hookCase = createHookCase()
      hooksConfig(hookCase).write({ 'session-project-dir': false })
      const environmentFile = makeEnvironmentFile(hookCase)
      const result = runSessionProjectDirectory(hookCase, environmentFile, gitRepository(hookCase, 'proj'))
      expect(result.exitCode).toBe(0)
      expect(readFileSync(environmentFile, 'utf8')).toBe('')
    })
  })
})
