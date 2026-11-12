/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pre-tool-use/tmp-path-warner.sh のテスト。Bash コマンド中の /tmp/ の利用を検知し、.pecot/work/ へ誘導する。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { runHookScript } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'pre-tool-use', 'tmp-path-warner.sh')

function setUpConfig(hookCase: HookCase): HooksConfig {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(project, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'tmp-path-warner': true })
  return config
}

function runWarner(hookCase: HookCase, json: string): RunResult {
  return runHookScript(hookCase, SCRIPT, json)
}

describe('tmp-path-warner.sh', () => {
  it('Bash コマンドに /tmp/ があるとき、.pecot/work/ へ誘導する警告を返す', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"mkdir -p /tmp/release-smoke"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: the Bash command contains')
    expect(result.stdout).toContain('.pecot/work/')
    expect(result.stdout).toContain('PreToolUse')
  })

  it('Bash コマンドが .pecot/work/ を使うとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"mkdir -p .pecot/work/655/release-smoke"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('find で /tmp を調べるとき、許可リストにより何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"find /tmp/foo -name *.log"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('ls で /tmp を調べるとき、許可リストにより何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"ls /tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('/tmpfs/ のように /tmp の後が単語の途中なら、単語境界により何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"cat /tmpfs/data"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // command の値は `echo "target=/tmp/foo"`。実 payload ではエスケープされた二重引用符で届く。
  it('二重引用符の中の /tmp/ も、= を境界として検知する', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, String.raw`{"tool_name":"Bash","tool_input":{"command":"echo \"target=/tmp/foo\""}}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('.pecot/work/')
  })

  it('sudo の後ろが find のとき、前置きを飛ばして許可リストを当てるので何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"sudo find /tmp/foo -name *.log"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('env の後ろが ls のとき、前置きを飛ばして許可リストを当てるので何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"env ls /tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('sudo の後ろが rm のとき、前置きを飛ばしても許可リスト外なので警告する', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('.pecot/work/')
  })

  it('/tmp/ が複数あるとき、警告は 1 回にまとめる', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"mv /tmp/a /tmp/b"}}')
    expect(result.exitCode).toBe(0)
    // grep -q で短絡するため additionalContext は 1 回だけ出る
    expect(result.stdout.split('additionalContext')).toHaveLength(2)
  })

  // command の値: awk -v p='/tmp/foo' "BEGIN{print p}"
  it('単一引用符の中の /tmp/ も、検知して警告する', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, String.raw`{"tool_name":"Bash","tool_input":{"command":"awk -v p='/tmp/foo' \"BEGIN{print p}\""}}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('.pecot/work/')
  })

  it('--out=/tmp/foo のように = の直後に /tmp/ があるとき、警告する', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"some-cmd --out=/tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('.pecot/work/')
  })

  it('tool_name が無いとき、早期に終了して何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_input":{"command":"mkdir -p /tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('command キーが無いとき、早期に終了して何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('command が空のとき、早期に終了して何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":""}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('Bash 以外のツールのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('/tmp の後ろにスラッシュが無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpConfig(hookCase)
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"echo /tmp"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定で tmp-path-warner が無効なとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const config = setUpConfig(hookCase)
    config.write({ 'tmp-path-warner': false })
    const result = runWarner(hookCase, '{"tool_name":"Bash","tool_input":{"command":"mkdir -p /tmp/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
