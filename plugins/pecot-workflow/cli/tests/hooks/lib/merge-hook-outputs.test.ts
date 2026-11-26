/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// merge-hook-outputs.sh のテスト。SDK 全出力フィールドの安全マージを検証する。
// サブスクリプトを生成して merge スクリプトに渡し、出力 JSON を比べる。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { toRecord } from '../_helpers/json.js'
import { coreDirectory } from '../_helpers/paths.js'
import { runShell } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps, parseJson } from '../_helpers/text.js'
import { explains } from '../../_helpers/explains.js'

const MERGE_SCRIPT = path.join(coreDirectory, 'merge-hook-outputs.sh')

// hookEventName の既定値は PECOT_HOOK_EVENT（エントリの project-root.sh が hook-input.sh で export）。
// 本番と同じく hook-input.sh を source してから merge を起動する（stdin はサブスクリプトへ転送される）。
const LOAD_THEN_MERGE = 'source "$1" && pecot_hook_input_load "$2" && shift 2 && exec "$@"'

// 出力の JSON をオブジェクトとして読む。
function parseRecord(text: string): Readonly<Record<string, unknown>> {
  return toRecord(parseJson(text), 'マージの出力')
}

function hookSpecificOutput(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return toRecord(record['hookSpecificOutput'], 'hookSpecificOutput')
}

// scripts ディレクトリを作る。
function setUpScripts(hookCase: HookCase): string {
  const scriptsDirectory = path.join(hookCase.temporaryPath, 'scripts')
  mkdirSync(scriptsDirectory, { recursive: true })
  return scriptsDirectory
}

// `cat > /dev/null` で stdin を捨て echoLine を出力するサブスクリプトを生成する。
function makeScript(scriptsDirectory: string, name: string, echoLine: string): string {
  const target = path.join(scriptsDirectory, name)
  writeFileSync(target, `#!/bin/bash\ncat > /dev/null\n${echoLine}\n`)
  chmodSync(target, 0o755)
  return target
}

function makeRawScript(scriptsDirectory: string, name: string, body: string): string {
  const target = path.join(scriptsDirectory, name)
  writeFileSync(target, body)
  chmodSync(target, 0o755)
  return target
}

function runMerge(hookCase: HookCase, scripts: readonly string[], stdin = '{}'): RunResult {
  return runShell(hookCase, LOAD_THEN_MERGE, [path.join(coreDirectory, 'hook-input.sh'), stdin, MERGE_SCRIPT, ...scripts], { stdin })
}

function contextScript(scriptsDirectory: string, text = 'hello'): string {
  return makeScript(scriptsDirectory, 'ctx.sh', `echo '{"hookSpecificOutput":{"additionalContext":"${text}"}}'`)
}

describe('merge-hook-outputs.sh', () => {
  it('サブスクリプトが 1 つのとき、additionalContext をそのまま出す', async () => {
    await explains('`merge-hook-outputs.sh`（複数のフックの出力を 1 つにまとめるスクリプト）のテストです。呼び出すスクリプトが 1 つの場合に、`additionalContext` をそのまま出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'script.sh', `echo '{"hookSpecificOutput":{"additionalContext":"test message"}}'`)
    const result = runMerge(hookCase, [script])
    expect(result.exitCode).toBe(0)
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('test message')
  })

  it('サブスクリプトが複数のとき、additionalContext を改行でつなぐ', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。呼び出すスクリプトが複数の場合に、それぞれの `additionalContext` を改行でつないで出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'script1.sh', `echo '{"hookSpecificOutput":{"additionalContext":"msg1"}}'`)
    const second = makeScript(scripts, 'script2.sh', `echo '{"hookSpecificOutput":{"additionalContext":"msg2"}}'`)
    const result = runMerge(hookCase, [first, second])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('msg1\nmsg2')
  })

  it('permissionDecision が混在するとき、deny を優先する', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。`allow` と `deny` の判定が混在する場合に、`deny` の判定と理由を優先して出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const allow = makeScript(scripts, 'allow.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"allow reason"}}'`)
    const deny = makeScript(scripts, 'deny.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"deny reason"}}'`)
    const result = runMerge(hookCase, [allow, deny])
    const specific = hookSpecificOutput(parseRecord(result.stdout))
    expect(specific['permissionDecision']).toBe('deny')
    expect(specific['permissionDecisionReason']).toBe('deny reason')
    expect(specific).not.toHaveProperty('reason')
  })

  it('素のテキストの出力は、additionalContext に入れる', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。JSON でない素のテキストを出力するスクリプトの場合に、その内容が `additionalContext` として出力されることを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const plain = makeScript(scripts, 'plain.sh', 'echo "plain text output"')
    const result = runMerge(hookCase, [plain])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('plain text output')
  })

  it('出力が空のサブスクリプトは、読み飛ばす', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。出力が空のスクリプトと有効なスクリプトを呼び出す場合に、空の出力を読み飛ばし、有効な出力だけを返すことを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const empty = makeRawScript(scripts, 'empty.sh', '#!/bin/bash\ncat > /dev/null\n')
    const valid = makeScript(scripts, 'valid.sh', `echo '{"hookSpecificOutput":{"additionalContext":"valid"}}'`)
    const result = runMerge(hookCase, [empty, valid])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('valid')
  })

  it('サブスクリプトの stderr を隠さない', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。呼び出すスクリプトが標準エラー出力へメッセージを書く場合に、そのメッセージを隠さず標準エラー出力に残すことを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const stderrScript = makeRawScript(scripts, 'stderr.sh', '#!/bin/bash\ncat > /dev/null\necho "stdout msg"\necho "stderr msg" >&2\n')
    const result = runMerge(hookCase, [stderrScript])
    expect(result.stderr.trim()).toBe('stderr msg')
  })

  it('hookEventName を保つ', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。複数のスクリプトが同じ `hookEventName`（`PostToolUse`）を出力する場合に、その値を保ったまま出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'script1.sh', `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context1"}}'`)
    const second = makeScript(scripts, 'script2.sh', `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context2"}}'`)
    const result = runMerge(hookCase, [first, second])
    expect(hookSpecificOutput(parseRecord(result.stdout))['hookEventName']).toBe('PostToolUse')
  })

  // 出すフックが無くなった項目は結合しない。
  it.for([
    { name: 'continue', output: '{"continue":false}' },
    { name: 'suppressOutput', output: '{"suppressOutput":true}' },
    { name: 'updatedInput', output: '{"hookSpecificOutput":{"updatedInput":"x"}}' },
  ])('$name だけの出力のとき、何も出さない', async (row) => {
    await explains(`\`merge-hook-outputs.sh\` のテストです。出力が \`${row.name}\` だけの場合に、何も出力しないことを確認します。`)
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'only.sh', `echo '${row.output}'`)
    const result = runMerge(hookCase, [script], '{"hook_event_name":"PreToolUse"}')
    expect(result.stdout).toBe('')
  })

  // pre-tool-use-bash.sh / post-tool-use-exit-plan-mode.sh 等は、HSO 実フィールドを出す。
  // そのため、入力 JSON の hook_event_name が hookEventName として付与され続けること（F-06 回帰）。
  it('additionalContext があるとき、入力由来の hookEventName を添える', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。`additionalContext` を出力する場合に、入力 JSON の `hook_event_name` を `hookEventName` として添えることを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'ac.sh', `echo '{"hookSpecificOutput":{"additionalContext":"ctx"}}'`)
    const result = runMerge(hookCase, [script], '{"hook_event_name":"PreToolUse"}')
    const specific = hookSpecificOutput(parseRecord(result.stdout))
    expect(specific['additionalContext']).toBe('ctx')
    expect(specific['hookEventName']).toBe('PreToolUse')
  })

  it('全サブスクリプトの出力が空なら、入力に hook_event_name があっても何も出さない', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。すべてのスクリプトの出力が空の場合に、入力に `hook_event_name` があっても何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const empty = makeRawScript(scripts, 'empty.sh', '#!/bin/bash\ncat > /dev/null\n')
    const result = runMerge(hookCase, [empty], '{"hook_event_name":"PreToolUse"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // トップレベルの additionalContext（Copilot CLI 1.0.103 は SessionStart でこれだけを読む）。
  it.for([{ label: 'SessionStart', event: 'SessionStart' }])('$label のとき、additionalContext をトップレベルにも出す', async (row) => {
    await explains(`\`merge-hook-outputs.sh\` のテストです。イベントが ${row.label} の場合に、\`additionalContext\` を \`hookSpecificOutput\` の中だけでなく、トップレベルにも出力することを確認します。`)
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = contextScript(scripts)
    const result = runMerge(hookCase, [script], jsonDumps({ hook_event_name: row.event }))
    const data = parseRecord(result.stdout)
    const specific = hookSpecificOutput(data)
    expect(data['additionalContext']).toBe('hello')
    expect(specific['additionalContext']).toBe('hello')
    expect(specific['hookEventName']).toBe(row.event)
  })

  it.for([
    { label: 'PreToolUse', event: 'PreToolUse' },
    { label: 'PostToolUse', event: 'PostToolUse' },
    { label: 'UserPromptSubmit', event: 'UserPromptSubmit' },
  ])('$label のとき、additionalContext をトップレベルには出さない', async (row) => {
    await explains(`\`merge-hook-outputs.sh\` のテストです。イベントが ${row.label} の場合に、\`additionalContext\` を \`hookSpecificOutput\` の中だけに出力し、トップレベルには出力しないことを確認します。`)
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = contextScript(scripts)
    const result = runMerge(hookCase, [script], jsonDumps({ hook_event_name: row.event }))
    const data = parseRecord(result.stdout)
    expect(data).not.toHaveProperty('additionalContext')
    expect(hookSpecificOutput(data)['additionalContext']).toBe('hello')
  })

  it('素のテキストと JSON が両方あるとき、JSON に畳み、トップレベルにも同じ連結結果を出す', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。素のテキストと JSON の両方がある場合に、JSON へまとめた `additionalContext` を出力し、トップレベルにも同じ連結結果を出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const text = makeScript(scripts, 'text.sh', 'echo \'# Git Sync\'')
    const json = contextScript(scripts, 'second')
    const result = runMerge(hookCase, [text, json], '{"hook_event_name":"SessionStart"}')
    const data = parseRecord(result.stdout)
    expect(data['additionalContext']).toBe('# Git Sync\nsecond')
    expect(hookSpecificOutput(data)['additionalContext']).toBe(data['additionalContext'])
  })

  it('additionalContext が無いとき、トップレベルにも出さない', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。出力に `additionalContext` が含まれない場合は、トップレベルにも `additionalContext` を出力しないことを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const message = makeScript(scripts, 'title.sh', `echo '{"hookSpecificOutput":{"sessionTitle":"#1"}}'`)
    const result = runMerge(hookCase, [message], '{"hook_event_name":"SessionStart"}')
    expect(parseRecord(result.stdout)).not.toHaveProperty('additionalContext')
  })

  // sessionTitle（SessionStart / UserPromptSubmit のセッション名）。
  it('sessionTitle だけの出力は、空扱いにせず hookSpecificOutput へ載せる', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。出力が `sessionTitle` だけの場合に、空として扱わず、`hookSpecificOutput` に載せて出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const title = makeScript(scripts, 'title.sh', `echo '{"hookSpecificOutput":{"sessionTitle":"#12 題名"}}'`)
    const result = runMerge(hookCase, [title], '{"hook_event_name":"UserPromptSubmit"}')
    expect(hookSpecificOutput(parseRecord(result.stdout))).toEqual({
      hookEventName: 'UserPromptSubmit',
      sessionTitle: '#12 題名',
    })
  })

  it('sessionTitle が複数のとき、最後のものを使い、additionalContext も残す', async () => {
    await explains('`merge-hook-outputs.sh` のテストです。`sessionTitle` を出力するスクリプトが複数ある場合に、最後の値を使い、`additionalContext` も残して出力することを確認します。')
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 't1.sh', `echo '{"hookSpecificOutput":{"sessionTitle":"first"}}'`)
    const context = makeScript(scripts, 'ac.sh', 'echo plain context')
    const last = makeScript(scripts, 't2.sh', `echo '{"hookSpecificOutput":{"sessionTitle":"last"}}'`)
    const result = runMerge(hookCase, [first, context, last], '{"hook_event_name":"SessionStart"}')
    const specific = hookSpecificOutput(parseRecord(result.stdout))
    expect(specific['sessionTitle']).toBe('last')
    expect(specific['additionalContext']).toBe('plain context')
  })
})
