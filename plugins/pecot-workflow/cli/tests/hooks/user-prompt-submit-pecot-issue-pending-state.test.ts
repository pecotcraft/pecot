/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// user-prompt-submit/pecot-issue-pending-state.sh のテスト。w-quick・w-ready の検知で、issue-pending フラグを作る。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'user-prompt-submit', 'pecot-issue-pending-state.sh')

interface Context {
  readonly flag: string
  readonly config: HooksConfig
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'pecot-issue-pending-state': true })
  return { flag: path.join(stateDirectory, 'issue-pending'), config }
}

// プロンプトを UserPromptSubmit の JSON に包んで起動する。
function runScript(hookCase: HookCase, prompt: string): RunResult {
  return run(hookCase, 'bash', [SCRIPT], { stdin: jsonDumps({ prompt }) })
}

const PREFIXES = [
  { label: 'フル修飾', prefix: '/pecot-w:' },
  { label: '短縮形', prefix: '/' },
]

describe('pecot-issue-pending-state.sh', () => {
  it.for(PREFIXES)('w-quick が呼ばれると（$label）、内容が w-quick のフラグを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, `${row.prefix}w-quick READMEのtypo修正`)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(true)
    expect(readFileSync(context.flag, 'utf8').trim()).toBe('w-quick')
  })

  it.for(PREFIXES)('w-ready が呼ばれると（$label）、内容が w-ready のフラグを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, `${row.prefix}w-ready Epic配下にサブタスク`)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(true)
    expect(readFileSync(context.flag, 'utf8').trim()).toBe('w-ready')
  })

  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-quick' },
    { label: '短縮形', prompt: '/w-quick' },
  ])('w-quick が引数なしで呼ばれても（$label）、フラグを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(true)
  })

  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-active' },
    { label: '短縮形', prompt: '/w-active' },
  ])('起票しない w-active が呼ばれても（$label）、フラグを立てない', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(false)
  })

  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-quickfoo' },
    { label: '短縮形', prompt: '/w-quickfoo' },
  ])('w-quickfoo のように名前が部分一致するだけなら（$label）、フラグを立てない', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(false)
  })

  // 先頭行だけを判定する。地の文でコマンド名に触れただけの入力で、起票リマインダーを起動しないため。
  it.for([
    { label: 'フル修飾', prompt: '手順:\n/pecot-w:w-quick を使う' },
    { label: '短縮形', prompt: '手順:\n/w-quick を使う' },
  ])('スラッシュコマンドが 2 行目にあるとき（$label）、フラグを立てない', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(false)
  })

  it('通常のプロンプトのとき、フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, '普通のメッセージ')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(false)
  })

  it('設定で pecot-issue-pending-state が無効なとき、フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'pecot-issue-pending-state': false })
    const result = runScript(hookCase, '/pecot-w:w-quick')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.flag)).toBe(false)
  })
})
