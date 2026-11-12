/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// config-dispatcher.sh のテスト。pecot_hook_enabled の判定、hooks-config.json による無効化、PLUGIN_HOOKS 解決を検証する。
// pecot_hook_enabled は source が要る関数なので、bash -c で source してから呼ぶ。
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { adapterDirectory, coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

const DISPATCHER = path.join(coreDirectory, 'config-dispatcher.sh')

// source dispatcher && pecot_hook_enabled test-hook <default> を実行する。
function hookEnabled(hookCase: HookCase, defaultValue: string): RunResult {
  return run(hookCase, 'bash', ['-c', 'source "$1"; pecot_hook_enabled "$2" "$3"', '_', DISPATCHER, 'test-hook', defaultValue])
}

describe('pecot_hook_enabled', () => {
  it('設定が false のとき、無効を返す', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '{"test-hook": false}')
    expect(hookEnabled(hookCase, 'true').exitCode).not.toBe(0)
  })

  it('設定が true のとき、既定値が false でも有効を返す', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '{"test-hook": true}')
    expect(hookEnabled(hookCase, 'false').exitCode).toBe(0)
  })

  it('キーが無いとき、既定値の true に従って有効を返す', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '{"other-hook": false}')
    expect(hookEnabled(hookCase, 'true').exitCode).toBe(0)
  })

  it('キーが無いとき、既定値の false に従って無効を返す', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '{"other-hook": true}')
    expect(hookEnabled(hookCase, 'false').exitCode).not.toBe(0)
  })

  it('ファイルが無いとき、既定値の true に従って有効を返す', () => {
    const hookCase = createHookCase()
    rmSync(hooksConfig(hookCase).path, { force: true })
    expect(hookEnabled(hookCase, 'true').exitCode).toBe(0)
  })

  it('ファイルが無いとき、既定値の false に従って無効を返す', () => {
    const hookCase = createHookCase()
    rmSync(hooksConfig(hookCase).path, { force: true })
    expect(hookEnabled(hookCase, 'false').exitCode).not.toBe(0)
  })

  it('構文エラーのとき、警告を出して既定値を使う', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '{invalid json}')
    const result = hookEnabled(hookCase, 'true')
    // return 0（既定値 true = 有効）
    expect(result.exitCode).toBe(0)
    // stderr に warning: で始まる行が含まれる
    expect(result.stderr).toContain('warning: failed to parse hooks-config.json')
  })

  it('空ファイルのとき、既定値を使う', () => {
    const hookCase = createHookCase()
    writeFileSync(hooksConfig(hookCase).path, '')
    expect(hookEnabled(hookCase, 'true').exitCode).toBe(0)
  })
})

// 統合テスト: hooks-config.json によるスクリプト無効化
function runGhCheck(hookCase: HookCase, command: string, configPath: string): RunResult {
  return run(hookCase, path.join(coreDirectory, 'gh-command-check.sh'), [], { env: { HOOK_COMMAND: command, PECOT_HOOKS_CONFIG_PATH: configPath } })
}

describe('hooks-config.json によるスクリプトの無効化', () => {
  it('gh pr create のチェックを設定で無効にすると、通す', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"gh-pr-create-check": false}')
    const result = runGhCheck(hookCase, 'gh pr create --title test', config)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('gh issue create のチェックを設定で無効にすると、通す', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"gh-issue-create-check": false}')
    const result = runGhCheck(hookCase, 'gh issue create --title test', config)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('gh pr create だけを無効にしても、gh issue create はブロックする', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"gh-pr-create-check": false}')
    const result = runGhCheck(hookCase, 'gh issue create --title test', config)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('gh issue create')
  })

  it('gh issue create だけを無効にしても、gh pr create はブロックする', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"gh-issue-create-check": false}')
    const result = runGhCheck(hookCase, 'gh pr create --title test', config)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('gh pr create')
  })

  it('両方を無効にすると、どちらも通す', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"gh-pr-create-check": false, "gh-issue-create-check": false}')

    const pr = runGhCheck(hookCase, 'gh pr create --title test', config)
    expect(pr.exitCode).toBe(0)
    expect(pr.stdout).toBe('')

    const issue = runGhCheck(hookCase, 'gh issue create --title test', config)
    expect(issue.exitCode).toBe(0)
    expect(issue.stdout).toBe('')
  })

  // bats 版は claude-adapter.sh を source し run_claude_guard を呼ぶ。同じ手段を bash -c で再現する。
  it('claude-adapter.sh（Pattern B）を設定で false にすると、無効化される', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"claude-adapter": false}')
    const project = path.join(hookCase.temporaryPath, 'adapter-project')
    mkdirSync(project, { recursive: true })
    const result = run(hookCase, 'bash', [
      '-c',
      'source "$1"; echo \'{"tool_input":{"command":"gh pr create"}}\' | run_claude_guard "$2"',
      '_',
      path.join(adapterDirectory, 'claude-adapter.sh'),
      path.join(coreDirectory, 'gh-command-check.sh'),
    ], { env: { PECOT_HOOKS_CONFIG_PATH: config, CLAUDE_PROJECT_DIR: project } })
    expect(result.stdout).toBe('')
  })
})

// 統合テスト: 新規フック追加フロー（US2）
const NEW_HOOK_SCRIPT = `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$CONFIG_DISPATCHER_PATH"
pecot_hook_enabled "new-test-hook" true || exit 0
echo "hook executed"
`

function runNewHook(hookCase: HookCase, configPath: string): RunResult {
  const script = path.join(hookCase.temporaryPath, 'new-hook.sh')
  writeFileSync(script, NEW_HOOK_SCRIPT)
  chmodSync(script, 0o755)
  return run(hookCase, 'bash', [script], { env: { PECOT_HOOKS_CONFIG_PATH: configPath, CONFIG_DISPATCHER_PATH: DISPATCHER } })
}

describe('新規フックの追加フロー', () => {
  it('設定で有効のとき、新しいフックが動く', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"new-test-hook": true}')
    const result = runNewHook(hookCase, config)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hook executed')
  })

  it('設定で無効のとき、新しいフックは早期に戻る', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    writeFileSync(config, '{"new-test-hook": false}')
    const result = runNewHook(hookCase, config)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定ファイルが無いとき、新しいフックは有効として動く', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    rmSync(config, { force: true })
    const result = runNewHook(hookCase, config)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hook executed')
  })
})

// PLUGIN_HOOKS 解決テスト
const PLUGIN_HOOKS_SCRIPT = `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$CONFIG_DISPATCHER_PATH"
echo "$PLUGIN_HOOKS"
`

// pluginRootValue が undefined のとき、CLAUDE_PLUGIN_ROOT を外す。
function runPluginHooks(hookCase: HookCase, configPath: string, pluginRootValue: string | undefined): RunResult {
  const script = path.join(hookCase.temporaryPath, 'check-plugin-hooks.sh')
  writeFileSync(script, PLUGIN_HOOKS_SCRIPT)
  chmodSync(script, 0o755)
  writeFileSync(configPath, '{}')
  return run(hookCase, 'bash', [script], {
    env: { PECOT_HOOKS_CONFIG_PATH: configPath, CONFIG_DISPATCHER_PATH: DISPATCHER, CLAUDE_PLUGIN_ROOT: pluginRootValue },
  })
}

describe('PLUGIN_HOOKS の解決', () => {
  it('CLAUDE_PLUGIN_ROOT から解決する', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    const pluginRootValue = path.join(hookCase.temporaryPath, 'my-plugin')
    const result = runPluginHooks(hookCase, config, pluginRootValue)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(`${pluginRootValue}/hooks`)
  })

  // SCRIPT_DIR は test_script のディレクトリ（tmp）で lib/ を含まないため、cd "${SCRIPT_DIR%/lib/*}" は tmp そのもの。
  it('CLAUDE_PLUGIN_ROOT が未設定のとき、SCRIPT_DIR のフォールバックで解決する', () => {
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase).path
    const result = runPluginHooks(hookCase, config, undefined)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(hookCase.temporaryPath)
  })
})
