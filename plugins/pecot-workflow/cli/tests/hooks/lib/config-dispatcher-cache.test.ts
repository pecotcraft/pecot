/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// config-dispatcher.sh の hooks-config.json キャッシュのテスト。
// 最初の pecot_hook_enabled で jq を 1 回だけ起動し、同一プロセス内の以降の判定では起動しない。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeProjectDirectory, createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { coreDirectory } from '../_helpers/paths.js'
import { runShell } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'
import { readOutput } from '../../../../../../libs/interface-spec/src/vitest/attach.js'
import { explains } from '../../_helpers/explains.js'

const DISPATCHER = path.join(coreDirectory, 'config-dispatcher.sh')

const SCRIPT = `
SCRIPT_DIR="$(dirname "$1")"
source "$1"
shift
for key in "$@"; do
    if pecot_hook_enabled "$key" true; then printf '%s=1 ' "$key"; else printf '%s=0 ' "$key"; fi
done
`

// jq を呼び出しの記録つきのシムに差し替え、記録のパスを返す。
function installJqCalls(hookCase: HookCase): string {
  const log = path.join(hookCase.temporaryPath, 'jq-calls.log')
  const realJq = runShell(hookCase, 'command -v jq').stdout.trim()
  mockBin(hookCase).install('jq', `echo x >> "${log}"\nexec "${realJq}" "$@"\n`)
  return log
}

function runDispatcher(hookCase: HookCase, ...keys: readonly string[]): RunResult {
  return runShell(hookCase, SCRIPT, [DISPATCHER, ...keys])
}

function countCalls(log: string): number {
  return existsSync(log) ? splitLines(readOutput(log)).length : 0
}

describe('config-dispatcher.sh のキャッシュ', () => {
  it('キーを何度引いても、jq は 1 回しか呼ばない', async () => {
    await explains('`config-dispatcher.sh` の設定ファイルのキャッシュのテストです。同じキーを含む複数のキーを続けて判定した場合に、`jq` を 1 回だけ起動し、設定の値どおりに判定することを確認します。')
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase)
    const jqCalls = installJqCalls(hookCase)
    claudeProjectDirectory(hookCase)
    config.write({ a: true, b: false, c: 'true' })
    const result = runDispatcher(hookCase, 'a', 'b', 'c', 'missing', 'a')
    expect(result.stdout.trim()).toBe('a=1 b=0 c=1 missing=1 a=1')
    expect(countCalls(jqCalls)).toBe(1)
  })

  it('設定ファイルが無いとき、jq を呼ばない', async () => {
    await explains('`config-dispatcher.sh` の設定ファイルのキャッシュのテストです。設定ファイルが存在しない場合に、`jq` を起動せず、すべてのキーを既定の値（`true`）で有効と判定することを確認します。')
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const jqCalls = installJqCalls(hookCase)
    claudeProjectDirectory(hookCase)
    const result = runDispatcher(hookCase, 'a', 'b')
    expect(result.stdout.trim()).toBe('a=1 b=1')
    expect(countCalls(jqCalls)).toBe(0)
  })

  it('false と bool 以外の値のとき、無効とし、空文字はキーなし扱いで既定の true にする', async () => {
    await explains('`config-dispatcher.sh` の設定値の判定のテストです。`false` や配列、`null` が指定されたキーは無効と判定し、空文字が指定されたキーは指定なしとして既定の値（`true`）で有効と判定することを確認します。')
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase)
    claudeProjectDirectory(hookCase)
    // eslint-disable-next-line unicorn/no-null -- 設定ファイルの null の値を確かめる
    config.write({ off: false, list: ['x'], null: null, empty: '' })
    const result = runDispatcher(hookCase, 'off', 'list', 'null', 'empty')
    expect(result.stdout.trim()).toBe('off=0 list=0 null=0 empty=1')
  })

  it('JSON のパースに失敗したとき、警告を出して既定値を使う', async () => {
    await explains('`config-dispatcher.sh` の設定ファイルの読み込みのテストです。JSON として解析できない場合に、標準エラー出力に `failed to parse` を含む警告を表示し、既定の値で有効と判定することを確認します。')
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase)
    claudeProjectDirectory(hookCase)
    writeFileSync(config.path, '{ not json')
    const result = runDispatcher(hookCase, 'a')
    expect(result.stdout.trim()).toBe('a=1')
    expect(result.stderr).toContain('failed to parse')
  })

  it('JSON がオブジェクトでないとき、パース失敗として扱う', async () => {
    await explains('`config-dispatcher.sh` の設定ファイルの読み込みのテストです。JSON がオブジェクトでなく配列の場合に、解析の失敗として警告を表示し、既定の値で有効と判定することを確認します。')
    const hookCase = createHookCase()
    const config = hooksConfig(hookCase)
    claudeProjectDirectory(hookCase)
    config.write(['a'])
    const result = runDispatcher(hookCase, 'a')
    expect(result.stdout.trim()).toBe('a=1')
    expect(result.stderr).toContain('failed to parse')
  })

  it('macOS の bash 3.2 に無い連想配列を使わない', async () => {
    await explains('`config-dispatcher.sh` の互換性のテストです。macOS の bash 3.2 が対応していない連想配列（`declare -A`・`local -A`・`typeset -A`）が、スクリプトに含まれていないことを確認します。')
    const source = readFileSync(DISPATCHER, 'utf8')
    expect(source).not.toContain('declare -A')
    expect(source).not.toContain('local -A')
    expect(source).not.toContain('typeset -A')
  })
})
