/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pecot-dir-init.sh のテスト。
// 対象は、新規作成、CLAUDE_PROJECT_DIR ガード、mtime ガード、冪等性、hosts.json/.env 保護。
// あわせて、gitignore-ensure の先行化（コピーより前に .gitignore を更新する契約）も対象とする。
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { coreDirectory, hooksDirectory, pluginRoot } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const INIT_SCRIPT = path.join(coreDirectory, 'pecot-dir-init.sh')

// CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / PLUGIN_HOOKS を設定し、作った project ディレクトリを返す。
function setUpDirectoryInit(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(project, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
  hookCase.setEnv('PLUGIN_HOOKS', hooksDirectory)
  return project
}

function runInit(hookCase: HookCase): RunResult {
  return run(hookCase, 'bash', [INIT_SCRIPT])
}

// test git repo に対する素の git 呼び出し。
function git(hookCase: HookCase, repository: string, ...argv: readonly string[]): RunResult {
  return run(hookCase, 'git', ['-C', repository, ...argv])
}

function touchAt(hookCase: HookCase, timestamp: string, target: string): void {
  const result = run(hookCase, 'touch', ['-t', timestamp, target])
  if (result.exitCode !== 0) throw new Error(`touch が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
}

function modifiedSeconds(target: string): number {
  return Math.floor(statSync(target).mtimeMs / 1000)
}

// PLUGIN_HOOKS をテスト用コピーに切り替え、plugin.json の mtime を固定する。
// plugin.json の mtime は 2020 年に固定する。
// スクリプトは ${_HOOKS_ROOT}/../.claude-plugin/plugin.json を読む。
// それに合わせ、plugin-root の下に hooks と .claude-plugin を並べる。
function setUpIsolatedPluginHooks(hookCase: HookCase): void {
  const isolated = path.join(hookCase.temporaryPath, 'plugin-isolated')
  mkdirSync(isolated, { recursive: true })
  cpSync(hooksDirectory, path.join(isolated, 'hooks'), { recursive: true, dereference: true })
  cpSync(path.join(pluginRoot, '.claude-plugin'), path.join(isolated, '.claude-plugin'), { recursive: true, dereference: true })
  touchAt(hookCase, '202001010000', path.join(isolated, '.claude-plugin', 'plugin.json'))
  hookCase.setEnv('PLUGIN_HOOKS', path.join(isolated, 'hooks'))
}

describe('pecot-dir-init.sh', () => {
  it('.pecot が無いとき、必要なディレクトリとファイルを作る', () => {
    const hookCase = createHookCase()
    const project = setUpDirectoryInit(hookCase)
    const result = runInit(hookCase)
    expect(result.exitCode).toBe(0)

    const pecot = path.join(project, '.pecot')
    expect(statSync(pecot).isDirectory()).toBe(true)
    expect(statSync(path.join(pecot, 'state')).isDirectory()).toBe(true)
    expect(statSync(path.join(pecot, 'tmp')).isDirectory()).toBe(true)
    expect(statSync(path.join(pecot, 'work')).isDirectory()).toBe(true)
    expect(statSync(path.join(pecot, 'config')).isDirectory()).toBe(true)
    expect(statSync(path.join(pecot, '.gitignore')).isFile()).toBe(true)
    // .gitkeep は作らない（dir-init と CLI の mkdir -p で十分。git 追跡は共有物の commit が担う）。
    expect(existsSync(path.join(pecot, 'config', '.gitkeep'))).toBe(false)
    expect(existsSync(path.join(pecot, 'config', 'projects', '.gitkeep'))).toBe(false)
    expect(statSync(path.join(pecot, 'config', 'hosts.json')).isFile()).toBe(true)
    expect(statSync(path.join(pecot, 'config', '.env')).isFile()).toBe(true)
    expect(statSync(path.join(pecot, 'state', '.plugin-sync-version')).isFile()).toBe(true)

    const gitignoreLines = splitLines(readFileSync(path.join(pecot, '.gitignore'), 'utf8'))
    expect(gitignoreLines).toContain('*')
    expect(gitignoreLines).toContain('/config/*')
  })

  it('CLAUDE_PROJECT_DIR が未設定のとき、何もせず、.pecot を作らない', () => {
    const hookCase = createHookCase()
    const project = setUpDirectoryInit(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', undefined)
    const result = runInit(hookCase)
    expect(result.exitCode).toBe(0)
    // プロジェクトディレクトリは元のままで .pecot は存在しない。
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
  })

  it('マーカーが plugin.json より新しいとき、同期をスキップする', () => {
    const hookCase = createHookCase()
    const project = setUpDirectoryInit(hookCase)
    setUpIsolatedPluginHooks(hookCase)

    // 初回実行で初期化。
    expect(runInit(hookCase).exitCode).toBe(0)

    // README.md の mtime を過去に戻す。
    const readme = path.join(project, '.pecot', 'README.md')
    expect(statSync(readme).isFile()).toBe(true)
    touchAt(hookCase, '200001010000', readme)
    const before = modifiedSeconds(readme)

    // マーカーを plugin.json (2020) より新しくする。
    touchAt(hookCase, '202501010000', path.join(project, '.pecot', 'state', '.plugin-sync-version'))

    expect(runInit(hookCase).exitCode).toBe(0)

    // README.md は更新されていない（mtime 据え置き）。
    expect(modifiedSeconds(readme)).toBe(before)
  })

  it('マーカーが plugin.json より古いとき、同期して更新する', () => {
    const hookCase = createHookCase()
    const project = setUpDirectoryInit(hookCase)
    setUpIsolatedPluginHooks(hookCase)

    expect(runInit(hookCase).exitCode).toBe(0)

    const readme = path.join(project, '.pecot', 'README.md')
    expect(statSync(readme).isFile()).toBe(true)
    touchAt(hookCase, '200001010000', readme)
    const before = modifiedSeconds(readme)

    // マーカーを plugin.json (2020) より古くする。
    touchAt(hookCase, '201001010000', path.join(project, '.pecot', 'state', '.plugin-sync-version'))

    expect(runInit(hookCase).exitCode).toBe(0)

    // README.md は更新されている（mtime が新しくなる）。
    expect(modifiedSeconds(readme)).toBeGreaterThan(before)
  })

  it('既存の hosts.json と .env は、上書きしない', () => {
    const hookCase = createHookCase()
    const project = setUpDirectoryInit(hookCase)
    const config = path.join(project, '.pecot', 'config')
    mkdirSync(config, { recursive: true })
    writeFileSync(path.join(config, 'hosts.json'), '{"custom": true}')
    writeFileSync(path.join(config, '.env'), 'MY_CUSTOM_TOKEN=secret')

    const result = runInit(hookCase)
    expect(result.exitCode).toBe(0)

    // カスタム内容が保持されている。
    expect(readFileSync(path.join(config, 'hosts.json'), 'utf8')).toBe('{"custom": true}')
    expect(readFileSync(path.join(config, '.env'), 'utf8')).toBe('MY_CUSTOM_TOKEN=secret')
  })

  it('旧内容の .gitignore を実 git リポに置いても、untracked が残らない', () => {
    // 旧内容は tmp/ だけの .pecot/.gitignore
    const hookCase = createHookCase()
    setUpDirectoryInit(hookCase)
    const repository = gitRepository(hookCase, 'repo')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    mkdirSync(path.join(repository, '.pecot'))
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'tmp/\n')

    const result = runInit(hookCase)
    expect(result.exitCode).toBe(0)

    const status = git(hookCase, repository, 'status', '--porcelain', '-uall', '--', '.pecot/')
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toBe('')
  })

  it('最初のコピー対象が dangling symlink で失敗しても、untracked が残らない', () => {
    // 最初のコピー対象は hooks-config.json
    const hookCase = createHookCase()
    setUpDirectoryInit(hookCase)
    const repository = gitRepository(hookCase, 'repo')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    mkdirSync(path.join(repository, '.pecot', 'config'), { recursive: true })
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'tmp/\n')
    symlinkSync(path.join(path.dirname(repository), 'nonexistent', 'target'), path.join(repository, '.pecot', 'config', 'hooks-config.json'))

    const result = runInit(hookCase)
    // 最初のコピーが dangling symlink で失敗し set -e で非 0 終了する。
    expect(result.exitCode).not.toBe(0)

    const status = git(hookCase, repository, 'status', '--porcelain', '-uall', '--', '.pecot/')
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toBe('')
  })

  it('README の cp が dangling symlink で失敗しても、untracked が残らない', () => {
    const hookCase = createHookCase()
    setUpDirectoryInit(hookCase)
    const repository = gitRepository(hookCase, 'repo')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    mkdirSync(path.join(repository, '.pecot'))
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'tmp/\n')
    symlinkSync(path.join(path.dirname(repository), 'nonexistent', 'target'), path.join(repository, '.pecot', 'README.md'))

    const result = runInit(hookCase)
    // cp 失敗で set -e により非 0 終了する。
    expect(result.exitCode).not.toBe(0)

    const status = git(hookCase, repository, 'status', '--porcelain', '-uall', '--', '.pecot/')
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toBe('')
  })
})
