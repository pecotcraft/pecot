/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// workflow-compliance-injector.sh のテスト（UserPromptSubmit のロジックスクリプト）。
// JSON stdin を流す。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const INJECTOR = path.join(hooksDirectory, 'lib', 'user-prompt-submit', 'workflow-compliance-injector.sh')

// CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / PLUGIN_HOOKS を設定し、state ディレクトリを用意する。
function setUpEnvironment(hookCase: HookCase): void {
  const project = path.join(hookCase.temporaryPath, 'project')
  const plugin = path.join(hookCase.temporaryPath, 'plugin')
  mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', plugin)
  hookCase.setEnv('PLUGIN_HOOKS', path.join(plugin, 'hooks'))
}

// JSON stdin をスクリプトに流す。
function runPiped(hookCase: HookCase, stdin: string): RunResult {
  return runScript(hookCase, INJECTOR, [], { stdin })
}

describe('workflow-compliance-injector.sh', () => {
  // UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡るため、短縮形で起動されたときは名前空間が付かない。
  // フル修飾だけを見ていると注入が不発になる。
  it.for([
    { label: '名前空間付き', prompt: '/pecot-w:w-active' },
    // 名前空間なしの短縮形（#939）
    { label: '名前空間なしの短縮形', prompt: '/w-active' },
    { label: '引数つきの短縮形', prompt: '/w-pr レビュー用に作成' },
  ])('pecot のコマンドが先頭にあるとき（$label）、指示テキストを出す', (row) => {
    const hookCase = createHookCase()
    setUpEnvironment(hookCase)
    const result = runPiped(hookCase, `{"prompt": "${row.prompt}"}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: notes for the pecot-workflow skills')
  })

  // 短縮形の捕捉は w- プレフィックス（pecot の命名規約）に限る。/ 全般へ広げると、あらゆるスラッシュコマンドに指示テキストが入り込む。
  it.for([
    { label: '/pecotfoo', prompt: '/pecotfoo' },
    { label: '/help', prompt: '/help' },
    { label: '/v-slidev', prompt: '/v-slidev' },
    // ハイフン形は Claude Code が正規形へ変換するため .prompt に現れない（#939 確認）。捕捉対象から外した判断をここで固定する。
    { label: 'ハイフン形の /pecot-a-active', prompt: '/pecot-a-active' },
  ])('pecot のコマンドとして現れない入力（$label）のとき、何も出力しない', (row) => {
    const hookCase = createHookCase()
    setUpEnvironment(hookCase)
    const result = runPiped(hookCase, `{"prompt": "${row.prompt}"}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // 地の文でコマンド名に言及しただけの入力に指示テキストを混ぜないため、先頭行のみを判定対象にする（create-slash-flag.sh と同じ判定スコープ）。
  // 改行を含むため stdin は jsonDumps で組み立てる。
  it.for([
    { label: '短縮形', prompt: '手順:\n/w-pr を使う' },
    { label: '名前空間付き', prompt: '手順:\n/pecot-w:w-pr を使う' },
  ])('コマンドが 2 行目にあるとき（$label）、何も出力しない', (row) => {
    const hookCase = createHookCase()
    setUpEnvironment(hookCase)
    const result = runPiped(hookCase, jsonDumps({ prompt: row.prompt }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('通常の文のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpEnvironment(hookCase)
    const result = runPiped(hookCase, '{"prompt": "hello world"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('prompt が空のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpEnvironment(hookCase)
    const result = runPiped(hookCase, '{"prompt": ""}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
