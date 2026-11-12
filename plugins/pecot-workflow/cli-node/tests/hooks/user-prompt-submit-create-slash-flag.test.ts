/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// user-prompt-submit/create-slash-flag.sh のテスト。w-pr・w-merge・起票系 4 コマンドの検知で、スラッシュコマンドのフラグを立てる。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'user-prompt-submit', 'create-slash-flag.sh')

interface Context {
  readonly prFlag: string
  readonly issueFlag: string
  readonly mergeFlag: string
  readonly config: HooksConfig
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'pr-create-slash-flag': true, 'issue-create-slash-flag': true })
  return {
    prFlag: path.join(stateDirectory, 'pr-create-slash-pending'),
    issueFlag: path.join(stateDirectory, 'issue-create-slash-pending'),
    mergeFlag: path.join(stateDirectory, 'merge-slash-pending'),
    config,
  }
}

// プロンプトを UserPromptSubmit の JSON に包んで起動する。
function runScript(hookCase: HookCase, prompt: string): RunResult {
  return run(hookCase, 'bash', [SCRIPT], { stdin: jsonDumps({ prompt }) })
}

const ISSUE_COMMANDS = ['w-quick', 'w-ready', 'w-backlog', 'w-issueize']

describe('create-slash-flag.sh', () => {
  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-pr' },
    { label: '短縮形', prompt: '/w-pr' },
  ])('w-pr が呼ばれると（$label）、pr フラグだけを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(true)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-pr レビュー用に作成' },
    { label: '短縮形', prompt: '/w-pr レビュー用に作成' },
  ])('w-pr が引数つきで呼ばれると（$label）、pr フラグを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(true)
  })

  it.for([
    { label: 'フル修飾', prompt: '/pecot-w:w-merge' },
    { label: '短縮形', prompt: '/w-merge' },
    { label: '引数つきの短縮形', prompt: '/w-merge 123' },
    { label: '引数つきのフル修飾', prompt: '/pecot-w:w-merge 123' },
  ])('w-merge が呼ばれると（$label）、merge フラグだけを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.mergeFlag)).toBe(true)
    expect(existsSync(context.prFlag)).toBe(false)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('設定で merge-slash-flag が無効なとき、merge フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'merge-slash-flag': false })
    const result = runScript(hookCase, '/pecot-w:w-merge')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.mergeFlag)).toBe(false)
  })

  it.for([
    { label: 'フル修飾の別名 w-mergefoo', prompt: '/pecot-w:w-mergefoo' },
    { label: '短縮形の別名 w-mergefoo', prompt: '/w-mergefoo' },
    { label: '2 行目のスラッシュコマンド', prompt: '手順:\n/w-merge' },
    { label: '自然文のプロンプト', prompt: 'PRをマージして' },
  ])('merge の対象外のプロンプト（$label）では、merge フラグを立てない', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.mergeFlag)).toBe(false)
  })

  it.for(
    ISSUE_COMMANDS.flatMap(origin => [
      { label: `${origin} のフル修飾`, origin, prefix: '/pecot-w:' },
      { label: `${origin} の短縮形`, origin, prefix: '/' },
    ]),
  )('起票系コマンド（$label）が呼ばれると、起点コマンド名を入れた issue フラグを立てる', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, `${row.prefix}${row.origin} 何かする`)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issueFlag)).toBe(true)
    expect(readFileSync(context.issueFlag, 'utf8').trim()).toBe(row.origin)
    expect(existsSync(context.prFlag)).toBe(false)
  })

  it.for([
    { label: 'フル修飾の w-prfoo', prompt: '/pecot-w:w-prfoo' },
    { label: '短縮形の w-prfoo', prompt: '/w-prfoo' },
    { label: 'フル修飾の w-quickfoo', prompt: '/pecot-w:w-quickfoo' },
    { label: '短縮形の w-quickfoo', prompt: '/w-quickfoo' },
    // 起票しないコマンドは対象外
    { label: 'フル修飾の w-active', prompt: '/pecot-w:w-active' },
    { label: '短縮形の w-active', prompt: '/w-active' },
    { label: 'PR 作成の自然文', prompt: 'PRを作って' },
    { label: '起票の自然文', prompt: 'issueを起票して' },
  ])('対象外のプロンプト（$label）では、どのフラグも立てない', (row) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(false)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('設定で pr-create-slash-flag が無効なとき、pr フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'pr-create-slash-flag': false, 'issue-create-slash-flag': true })
    const result = runScript(hookCase, '/pecot-w:w-pr')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(false)
  })

  it('設定で issue-create-slash-flag が無効なとき、issue フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'pr-create-slash-flag': true, 'issue-create-slash-flag': false })
    const result = runScript(hookCase, '/pecot-w:w-quick 何か直す')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('スラッシュコマンドが 2 行目にあるとき、先頭行だけを判定するので issue フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, '手順:\n/pecot-w:w-quick を使う')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('短縮形のスラッシュコマンドが 2 行目にあっても、先頭行だけを判定するので issue フラグを立てない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runScript(hookCase, '手順:\n/w-quick を使う')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('対象外の通常のプロンプトでは、既存のフラグを消さない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.prFlag, '')
    writeFileSync(context.issueFlag, 'w-quick\n')
    const result = runScript(hookCase, '補足: リポは aist-plugin で')
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(true)
    expect(existsSync(context.issueFlag)).toBe(true)
  })

  it('起票系コマンドが再実行されると、issue フラグの内容を新しい起点コマンド名に更新する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.issueFlag, 'w-quick\n')
    const result = runScript(hookCase, '/pecot-w:w-issueize specs/1/tasks.md')
    expect(result.exitCode).toBe(0)
    expect(readFileSync(context.issueFlag, 'utf8').trim()).toBe('w-issueize')
  })

  it('.pecot が無いプロジェクトでは、フラグを立てず、ディレクトリも作らない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({ 'pr-create-slash-flag': true, 'issue-create-slash-flag': true })
    const project = path.join(hookCase.temporaryPath, 'missing-project')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
    const result = runScript(hookCase, '/w-pr')
    expect(result.exitCode).toBe(0)
    expect(existsSync(project)).toBe(false)
  })
})
