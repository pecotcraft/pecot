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
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps, parseJson } from '../_helpers/text.js'

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
  return run(hookCase, 'bash', ['-c', LOAD_THEN_MERGE, '_', path.join(coreDirectory, 'hook-input.sh'), stdin, MERGE_SCRIPT, ...scripts], { stdin })
}

function contextScript(scriptsDirectory: string, text = 'hello'): string {
  return makeScript(scriptsDirectory, 'ctx.sh', `echo '{"hookSpecificOutput":{"additionalContext":"${text}"}}'`)
}

describe('merge-hook-outputs.sh', () => {
  it('サブスクリプトが 1 つのとき、additionalContext をそのまま出す', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'script.sh', `echo '{"hookSpecificOutput":{"additionalContext":"test message"}}'`)
    const result = runMerge(hookCase, [script])
    expect(result.exitCode).toBe(0)
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('test message')
  })

  it('サブスクリプトが複数のとき、additionalContext を改行でつなぐ', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'script1.sh', `echo '{"hookSpecificOutput":{"additionalContext":"msg1"}}'`)
    const second = makeScript(scripts, 'script2.sh', `echo '{"hookSpecificOutput":{"additionalContext":"msg2"}}'`)
    const result = runMerge(hookCase, [first, second])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('msg1\nmsg2')
  })

  it('permissionDecision が混在するとき、deny を優先する', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const allow = makeScript(scripts, 'allow.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"allow reason"}}'`)
    const deny = makeScript(scripts, 'deny.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"deny reason"}}'`)
    const ask = makeScript(scripts, 'ask.sh', `echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"ask reason"}}'`)
    const result = runMerge(hookCase, [allow, ask, deny])
    const specific = hookSpecificOutput(parseRecord(result.stdout))
    expect(specific['permissionDecision']).toBe('deny')
    expect(specific['permissionDecisionReason']).toBe('deny reason')
    expect(specific).not.toHaveProperty('reason')
  })

  it('素のテキストの出力は、additionalContext に入れる', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const plain = makeScript(scripts, 'plain.sh', 'echo "plain text output"')
    const result = runMerge(hookCase, [plain])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('plain text output')
  })

  it('出力が空のサブスクリプトは、読み飛ばす', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const empty = makeRawScript(scripts, 'empty.sh', '#!/bin/bash\ncat > /dev/null\n')
    const valid = makeScript(scripts, 'valid.sh', `echo '{"hookSpecificOutput":{"additionalContext":"valid"}}'`)
    const result = runMerge(hookCase, [empty, valid])
    expect(hookSpecificOutput(parseRecord(result.stdout))['additionalContext']).toBe('valid')
  })

  it('サブスクリプトの stderr を隠さない', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const stderrScript = makeRawScript(scripts, 'stderr.sh', '#!/bin/bash\ncat > /dev/null\necho "stdout msg"\necho "stderr msg" >&2\n')
    const result = runMerge(hookCase, [stderrScript])
    expect(result.stderr.trim()).toBe('stderr msg')
  })

  it('continue が false のものがあるとき、false を優先する', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const continueTrue = makeScript(scripts, 'continue-true.sh', `echo '{"continue":true,"hookSpecificOutput":{"additionalContext":"a"}}'`)
    const continueFalse = makeScript(scripts, 'continue-false.sh', `echo '{"continue":false}'`)
    const result = runMerge(hookCase, [continueTrue, continueFalse])
    expect(parseRecord(result.stdout)['continue']).toBe(false)
  })

  it('systemMessage が複数のとき、改行でつなぐ', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'sys1.sh', `echo '{"systemMessage":"system msg 1"}'`)
    const second = makeScript(scripts, 'sys2.sh', `echo '{"systemMessage":"system msg 2"}'`)
    const result = runMerge(hookCase, [first, second])
    expect(parseRecord(result.stdout)['systemMessage']).toBe('system msg 1\nsystem msg 2')
  })

  it('suppressOutput が true のものがあるとき、true を優先する', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const suppressFalse = makeScript(scripts, 'suppress-false.sh', `echo '{"suppressOutput":false,"hookSpecificOutput":{"additionalContext":"a"}}'`)
    const suppressTrue = makeScript(scripts, 'suppress-true.sh', `echo '{"suppressOutput":true}'`)
    const result = runMerge(hookCase, [suppressFalse, suppressTrue])
    expect(parseRecord(result.stdout)['suppressOutput']).toBe(true)
  })

  it('updatedInput が複数のとき、最後のものを使う', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'ui1.sh', `echo '{"hookSpecificOutput":{"updatedInput":"first input"}}'`)
    const last = makeScript(scripts, 'ui2.sh', `echo '{"hookSpecificOutput":{"updatedInput":"last input"}}'`)
    const result = runMerge(hookCase, [first, last])
    expect(hookSpecificOutput(parseRecord(result.stdout))['updatedInput']).toBe('last input')
  })

  it('hookEventName を保つ', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const first = makeScript(scripts, 'script1.sh', `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context1"}}'`)
    const second = makeScript(scripts, 'script2.sh', `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context2"}}'`)
    const result = runMerge(hookCase, [first, second])
    expect(hookSpecificOutput(parseRecord(result.stdout))['hookEventName']).toBe('PostToolUse')
  })

  // hookEventName 以外の hookSpecificOutput のフィールドが無いときは、空の hookSpecificOutput を作らない。
  it('systemMessage だけのとき、hookSpecificOutput を出さない', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'sys.sh', `echo '{"systemMessage":"sys only"}'`)
    const result = runMerge(hookCase, [script], '{"hook_event_name":"Stop"}')
    const data = parseRecord(result.stdout)
    expect(data['systemMessage']).toBe('sys only')
    expect(data).not.toHaveProperty('hookSpecificOutput')
  })

  // pre-tool-use.sh / post-tool-use-bash.sh 等は、HSO 実フィールドを出す。
  // そのため、入力 JSON の hook_event_name が hookEventName として付与され続けること（F-06 回帰）。
  it('additionalContext があるとき、入力由来の hookEventName を添える', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'ac.sh', `echo '{"hookSpecificOutput":{"additionalContext":"ctx"}}'`)
    const result = runMerge(hookCase, [script], '{"hook_event_name":"PreToolUse"}')
    const specific = hookSpecificOutput(parseRecord(result.stdout))
    expect(specific['additionalContext']).toBe('ctx')
    expect(specific['hookEventName']).toBe('PreToolUse')
  })

  it('全サブスクリプトの出力が空なら、入力に hook_event_name があっても何も出さない', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const empty = makeRawScript(scripts, 'empty.sh', '#!/bin/bash\ncat > /dev/null\n')
    const result = runMerge(hookCase, [empty], '{"hook_event_name":"Stop"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('Claude Code の Stop / Notification の terminalSequence を、トップレベルに引き継ぐ', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = makeScript(scripts, 'bell.sh', String.raw`echo '{"terminalSequence":"\u0007"}'`)
    const result = runMerge(hookCase, [script], '{"hook_event_name":"Stop"}')
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toEqual({ terminalSequence: '\u{7}' })
  })

  it('terminalSequence は、systemMessage と合わせて出す', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const bell = makeScript(scripts, 'bell.sh', String.raw`echo '{"terminalSequence":"\u0007"}'`)
    const message = makeScript(scripts, 'msg.sh', `echo '{"systemMessage":"pushed"}'`)
    const result = runMerge(hookCase, [bell, message], '{"hook_event_name":"Stop"}')
    const data = parseRecord(result.stdout)
    expect(data['terminalSequence']).toBe('\u{7}')
    expect(data['systemMessage']).toBe('pushed')
  })

  // トップレベルの additionalContext（Copilot CLI 1.0.103 は SessionStart / PostToolUse でこれだけを読む）。
  it.for([
    { label: 'SessionStart', event: 'SessionStart' },
    { label: 'PostToolUse', event: 'PostToolUse' },
  ])('$label のとき、additionalContext をトップレベルにも出す', (row) => {
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
    { label: 'UserPromptSubmit', event: 'UserPromptSubmit' },
    { label: 'Stop', event: 'Stop' },
  ])('$label のとき、additionalContext をトップレベルには出さない', (row) => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const script = contextScript(scripts)
    const result = runMerge(hookCase, [script], jsonDumps({ hook_event_name: row.event }))
    const data = parseRecord(result.stdout)
    expect(data).not.toHaveProperty('additionalContext')
    expect(hookSpecificOutput(data)['additionalContext']).toBe('hello')
  })

  it('素のテキストと JSON が両方あるとき、JSON に畳み、トップレベルにも同じ連結結果を出す', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const text = makeScript(scripts, 'text.sh', 'echo \'# Git Sync\'')
    const json = contextScript(scripts, 'second')
    const result = runMerge(hookCase, [text, json], '{"hook_event_name":"SessionStart"}')
    const data = parseRecord(result.stdout)
    expect(data['additionalContext']).toBe('# Git Sync\nsecond')
    expect(hookSpecificOutput(data)['additionalContext']).toBe(data['additionalContext'])
  })

  it('additionalContext が無いとき、トップレベルにも出さない', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const message = makeScript(scripts, 'msg.sh', `echo '{"systemMessage":"m"}'`)
    const result = runMerge(hookCase, [message], '{"hook_event_name":"PostToolUse"}')
    expect(parseRecord(result.stdout)).not.toHaveProperty('additionalContext')
  })

  // sessionTitle（SessionStart / UserPromptSubmit のセッション名）。
  it('sessionTitle だけの出力は、空扱いにせず hookSpecificOutput へ載せる', () => {
    const hookCase = createHookCase()
    const scripts = setUpScripts(hookCase)
    const title = makeScript(scripts, 'title.sh', `echo '{"hookSpecificOutput":{"sessionTitle":"#12 題名"}}'`)
    const result = runMerge(hookCase, [title], '{"hook_event_name":"UserPromptSubmit"}')
    expect(hookSpecificOutput(parseRecord(result.stdout))).toEqual({
      hookEventName: 'UserPromptSubmit',
      sessionTitle: '#12 題名',
    })
  })

  it('sessionTitle が複数のとき、最後のものを使い、additionalContext も残す', () => {
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
