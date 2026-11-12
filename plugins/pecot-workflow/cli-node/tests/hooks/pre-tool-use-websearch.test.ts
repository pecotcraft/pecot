// pre-tool-use-websearch.sh のテスト。WebSearch（読み取り専用）を自動で許可し、設定で無効にできる。
// 対象ツールの限定は hooks.json の matcher が担うので、エントリは入力によらず allow を返す。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'pre-tool-use-websearch.sh')
const INPUT = '{"tool_name":"WebSearch","tool_input":{"query":"x"}}'

describe('pre-tool-use-websearch.sh', () => {
  it('WebSearch が呼ばれるとき、許可する', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({})
    const result = run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: INPUT })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "allow"')
    expect(result.stdout).toContain('"hookEventName": "PreToolUse"')
  })

  it('設定で websearch-allow が無効なとき、何も出力しない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({ 'websearch-allow': false })
    const result = run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: INPUT })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
