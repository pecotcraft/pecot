/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// git-sync.sh と、session-start.sh の出力の形のテスト。
// git・code を stub にして PATH の先頭に置く。git の stub は、-C の値が FAKE_REPO_ROOT と違えば exit 99 で落とす。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { checkoutWorkBranch, gitRepository, installGitCallLog } from '../_helpers/git.js'
import type { GitCallLog } from '../_helpers/git.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, jsonDumps, parseJson } from '../_helpers/text.js'
import { readOutput } from '../../../../../../libs/interface-spec/src/vitest/attach.js'

const SESSION_START_DIRECTORY = path.join(hooksDirectory, 'lib', 'session-start')
const GIT_SYNC_SCRIPT = path.join(SESSION_START_DIRECTORY, 'git-sync.sh')
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

// 撤廃の前は、VS Code のワークスペースの情報が出た `code --status` の出力。
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

function makeGitStub(stubDirectory: string, body: string): void {
  const file = path.join(stubDirectory, 'git')
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

function makeStubDirectory(hookCase: HookCase): string {
  const stubDirectory = path.join(hookCase.temporaryPath, 'stubs')
  mkdirSync(stubDirectory)
  return stubDirectory
}

// stub を PATH の先頭に置いて git-sync.sh を動かす。CLAUDE_PROJECT_DIR は extra で明示したときだけ渡す。
function runWithPath(hookCase: HookCase, stubDirectory: string, extraEnvironment: EnvironmentOverrides): RunResult {
  return run(hookCase, GIT_SYNC_SCRIPT, [], {
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
  hooksConfig(hookCase).write({ 'git-sync': true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  gitCallLog.reset()
  return { repository, unreachable, gitCallLog }
}

// 同じリポを origin にした上流を設定し、pull が成功するようにする。
function setUpReachableRepository(hookCase: HookCase, name: string): string {
  const repository = gitRepository(hookCase, name)
  hooksConfig(hookCase).write({ 'git-sync': true })
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

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, jsonDumps(value))
}

// Claude Code の導入の形（<plugins>/cache/<mp>/<name>/<ver>）で、clone の最新版より古い版を置き、そのルートを返す。
// 撤廃の前は、このルートで更新の通知が出た。
function outdatedPluginRoot(hookCase: HookCase): string {
  const plugins = path.join(hookCase.temporaryPath, 'home', '.claude', 'plugins')
  const root = path.join(plugins, 'cache', 'pecot', 'pecot-w', '0.0.1')
  const clone = path.join(plugins, 'marketplaces', 'pecot')
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { version: '0.0.1' })
  writeJson(path.join(plugins, 'known_marketplaces.json'), { pecot: { installLocation: clone } })
  writeJson(path.join(clone, '.claude-plugin', 'marketplace.json'), { name: 'pecot', plugins: [{ name: 'pecot-w', source: './plugins/pecot-workflow' }] })
  writeJson(path.join(clone, 'plugins', 'pecot-workflow', '.claude-plugin', 'plugin.json'), { version: '9.9.9' })
  return root
}

describe('session-start のロジックスクリプト', () => {
  describe('git-sync.sh', () => {
    it('作業ツリーが clean で pull に成功したとき、同期した旨とブランチ名を出す', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeGitStub(stubDirectory, GIT_SYNC_STUB)
      hooksConfig(hookCase).write({ 'git-sync': true })
      const environment = gitSyncEnvironment(hookCase, { FAKE_BRANCH: 'feature/test' })
      const result = runWithPath(hookCase, stubDirectory, environment)
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
      makeGitStub(stubDirectory, GIT_SYNC_ENV_STUB)
      hooksConfig(hookCase).write({ 'git-sync': true })
      const log = path.join(hookCase.temporaryPath, 'pull-env.log')
      const environment = gitSyncEnvironment(hookCase, { FAKE_PULL_ENV_LOG: log })
      hookCase.setEnv('GIT_SSH_COMMAND', row.preset)
      const result = runWithPath(hookCase, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(readOutput(log).trim()).toBe(row.expected)
    })

    it('未コミットの変更があるとき、何も出力しない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeGitStub(stubDirectory, GIT_SYNC_STUB)
      hooksConfig(hookCase).write({ 'git-sync': true })
      const environment = gitSyncEnvironment(hookCase, { FAKE_GIT_DIFF_EXIT: '1' })
      const result = runWithPath(hookCase, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('pull に失敗しても exit 0 で、同期した旨は出さない', () => {
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeGitStub(stubDirectory, GIT_SYNC_STUB)
      hooksConfig(hookCase).write({ 'git-sync': true })
      const environment = gitSyncEnvironment(hookCase, { FAKE_GIT_PULL_EXIT: '1' })
      const result = runWithPath(hookCase, stubDirectory, environment)
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

    it('uvx が PATH に無くても、pull して同期した旨を出す', () => {
      // bashrc で PATH が復元されないよう、env -i 相当の環境で動かす。PATH は stub と /usr/bin・/bin だけにし、uvx を置かない
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeGitStub(stubDirectory, GIT_SYNC_STUB)
      const config = hooksConfig(hookCase)
      config.write({ 'git-sync': true })
      const environment = gitSyncEnvironment(hookCase)
      const home = hookCase.getEnv('HOME') ?? '/root'
      const assignments = [
        `PATH=${stubDirectory}:/usr/bin:/bin`,
        `HOME=${home}`,
        `PECOT_HOOKS_CONFIG_PATH=${config.path}`,
        ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
      ]
      const result = run(hookCase, 'env', ['-i', ...assignments, 'bash', '--norc', '--noprofile', GIT_SYNC_SCRIPT])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('synced the branch with the remote (branch: main)')
    })

    it('設定が無いとき、pull せず何も出力しない', () => {
      const hookCase = createHookCase()
      const { gitCallLog } = setUpUnreachableRepository(hookCase, 'sync-default')
      hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'no-such-config.json'))
      const result = run(hookCase, GIT_SYNC_SCRIPT)
      expect(result.exitCode).toBe(0)
      expect(gitCallLog.count('pull')).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    })

    it('有効にしていても、source が compact のときは pull しない', () => {
      const hookCase = createHookCase()
      const { gitCallLog } = setUpUnreachableRepository(hookCase, 'sync-compact')
      hookCase.setEnv('PECOT_HOOK_SOURCE', 'compact')
      const result = run(hookCase, GIT_SYNC_SCRIPT)
      expect(result.exitCode).toBe(0)
      expect(gitCallLog.count('pull')).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    })

    it('CLAUDE_PROJECT_DIR が未設定のとき、何もせず、空パスの警告も出さない', () => {
      // git の外で起動した場合
      const hookCase = createHookCase()
      const stubDirectory = makeStubDirectory(hookCase)
      makeGitStub(stubDirectory, GIT_SYNC_STUB)
      hooksConfig(hookCase).write({ 'git-sync': true })
      const environment = gitSyncEnvironment(hookCase)
      Reflect.deleteProperty(environment, 'CLAUDE_PROJECT_DIR')
      const result = runWithPath(hookCase, stubDirectory, environment)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
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
      // 作業中の Issue は origin とブランチ名から求める。git pull は改名した remote の追跡ブランチから取る
      const upstream = gitIn(hookCase, repository, ['branch', '--show-current']).trim()
      gitIn(hookCase, repository, ['checkout', '-q', '-b', 'feat/x/1253', '--track', `origin/${upstream}`])
      gitIn(hookCase, repository, ['remote', 'rename', 'origin', 'sync'])
      gitIn(hookCase, repository, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      const state = path.join(repository, '.pecot', 'state')
      mkdirSync(state, { recursive: true })
      writeFileSync(path.join(repository, '.pecot', '.gitignore'), '*\n')
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

    it('compact では、git-sync を有効にしても pull せず、.gitignore を補完し、sessionTitle を出さない', () => {
      const hookCase = createHookCase()
      const config = hooksConfig(hookCase)
      config.write({ 'git-sync': true })
      const repository = gitRepository(hookCase, 'compact')
      // セッション名が出る条件（末尾が Issue 番号のブランチと、URL の形に合う origin）をそろえる
      checkoutWorkBranch(hookCase, repository, 'feat/x/1253')
      mkdirSync(path.join(repository, '.pecot'))
      const gitCallLog = installGitCallLog(hookCase)
      const result = runSessionStartEntry(hookCase, repository, { source: 'compact', transcript_path: '/t/c.jsonl' })
      expect(result.exitCode).toBe(0)
      expect(gitCallLog.count('pull')).toBe(0)
      expect(readOutput(path.join(repository, '.pecot', '.gitignore'))).toContain('!/config/')
      expect(result.stdout).not.toContain('sessionTitle')

      // 同じ条件の startup では sessionTitle が出る
      config.write({ 'git-sync': false })
      const startup = runSessionStartEntry(hookCase, repository, { source: 'startup', transcript_path: '/t/c.jsonl' })
      expect(startup.exitCode).toBe(0)
      expect(valueAt(parseJson(startup.stdout), 'hookSpecificOutput', 'sessionTitle')).toBe('#1253')
    })

    // 撤廃の前は、VS Code の情報・.gitignore の案内・更新の通知が出た条件をそろえる（spec 025 FR-012）。
    it('VS Code・未追跡の .gitignore・古い版の導入がそろっても、案内を出さない', () => {
      const hookCase = createHookCase()
      hooksConfig(hookCase).write({ 'git-sync': false })
      const repository = gitRepository(hookCase, 'notices')
      mkdirSync(path.join(repository, '.pecot'))
      mockBin(hookCase).install('code', CODE_WORKSPACE_STUB)
      hookCase.setEnv('CLAUDE_PLUGIN_ROOT', outdatedPluginRoot(hookCase))
      const result = runSessionStartEntry(hookCase, repository, { source: 'startup' })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const data = result.stdout === '' ? {} : parseJson(result.stdout)
      expect(valueAt(data, 'hookSpecificOutput', 'additionalContext')).toBeUndefined()
      expect(valueAt(data, 'additionalContext')).toBeUndefined()
      expect(result.stdout).not.toContain('VSCode')
      expect(result.stdout).not.toContain('.gitignore')
      expect(result.stdout).not.toContain('plugin update available')
    })
  })
})
