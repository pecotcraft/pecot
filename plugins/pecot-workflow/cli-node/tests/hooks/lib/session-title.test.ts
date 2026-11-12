/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-title.sh（Claude Code のセッション名）のテスト。
// セッション名は .pecot-active と .pecot-session-title から組み、session-title-sent の `<session_id>:<題名>` と違うときだけ出す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { coreDirectory } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { parseJson } from '../_helpers/text.js'

const SCRIPT = path.join(coreDirectory, 'session-title.sh')

// .pecot/state を持つプロジェクトを CLAUDE_PROJECT_DIR に向け、state のパスを返す。
function setUpState(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  writeFileSync(path.join(project, '.pecot', '.gitignore'), '*\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return state
}

interface RunOptions {
  readonly event?: string
  readonly sessionId?: string
  readonly source?: string
  readonly currentTitle?: string
}

function runSessionTitle(hookCase: HookCase, options: RunOptions = {}): RunResult {
  return runScript(hookCase, SCRIPT, [], {
    stdin: '{}',
    env: {
      PECOT_HOOK_EVENT: options.event ?? 'UserPromptSubmit',
      PECOT_HOOK_SESSION_ID: options.sessionId ?? 's1',
      PECOT_HOOK_SOURCE: options.source ?? '',
      PECOT_HOOK_SESSION_TITLE: options.currentTitle ?? '',
      PECOT_HOOK_TRANSCRIPT_PATH: '/t/s.jsonl',
    },
  })
}

// 出力の hookSpecificOutput.sessionTitle を取り出す。
function titleOf(result: RunResult): unknown {
  const output = parseJson(result.stdout)
  if (typeof output !== 'object' || output === null) return undefined
  const specific: unknown = Reflect.get(output, 'hookSpecificOutput')
  return typeof specific !== 'object' || specific === null ? undefined : Reflect.get(specific, 'sessionTitle')
}

function activate(state: string, active = 'owner/repo/1', title = '#1 a'): void {
  writeFileSync(path.join(state, '.pecot-active'), `${active}\n`)
  writeFileSync(path.join(state, '.pecot-session-title'), `${title}\n`)
}

function readSent(state: string): string {
  return readFileSync(path.join(state, 'session-title-sent'), 'utf8')
}

describe('session-title.sh', () => {
  it('active のフラグが無いとき、何も出力せず、記録を残さない', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(state, 'session-title-sent'))).toBe(false)
  })

  it('state から組んだセッション名を出し、送った名前を記録する', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    writeFileSync(path.join(state, '.pecot-active'), 'acme-labs/aist-plugin/1253\n')
    writeFileSync(path.join(state, '.pecot-session-title'), '#1253 題名\n')
    const result = runSessionTitle(hookCase, { event: 'SessionStart', source: 'startup' })
    expect(parseJson(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: '#1253 題名' },
    })
    expect(readSent(state)).toBe('s1:#1253 題名\n')
  })

  it('題名のファイルが無いとき、番号だけにする', () => {
    // 旧版の CLI が書いた .pecot-active だけがある場合
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    writeFileSync(path.join(state, '.pecot-active'), 'acme-labs/aist-plugin/1253\n')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1253')
  })

  it('同じセッションでは、同じ題名を再送しない', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/1\n')
    writeFileSync(path.join(state, '.pecot-session-title'), '#1 a\n')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1 a')
    const second = runSessionTitle(hookCase)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe('')
  })

  it('題名が変わったとき、またはセッションが違うとき、再送する', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/1\n')
    writeFileSync(path.join(state, '.pecot-session-title'), '#1 a\n')
    runSessionTitle(hookCase)
    // 別セッション（/clear 後や新規起動）には同じ題名でも出す
    expect(titleOf(runSessionTitle(hookCase, { sessionId: 's2' }))).toBe('#1 a')
    // Issue が切り替わったら同じセッションでも出す
    writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/2\n')
    writeFileSync(path.join(state, '.pecot-session-title'), '#2 b\n')
    expect(titleOf(runSessionTitle(hookCase, { sessionId: 's2' }))).toBe('#2 b')
  })

  it('hooks-config で無効にしたとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    hooksConfig(hookCase).write({ 'session-title': false })
    writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/1\n')
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('.pecot の無いリポでは、何も書かず、出力もしない', () => {
    // pecot 未使用のリポ
    const hookCase = createHookCase()
    const project = path.join(hookCase.temporaryPath, 'plain')
    mkdirSync(project)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
  })

  it.for([
    { label: 'startup', source: 'startup' },
    { label: 'resume', source: 'resume' },
    { label: 'fork', source: 'fork' },
  ])('SessionStart の source が $label のとき、セッション名を出す', (row) => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    const result = runSessionTitle(hookCase, { event: 'SessionStart', source: row.source })
    expect(titleOf(result)).toBe('#1 a')
  })

  it.for([
    { label: 'clear', source: 'clear' },
    { label: 'compact', source: 'compact' },
    { label: 'new', source: 'new' },
    { label: '空文字', source: '' },
  ])('SessionStart の source が $label のとき、出力せず、記録を残さない', (row) => {
    // sessionTitle が適用されない source では出さず、sent にも残さない（次の機会に出せる）
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    const result = runSessionTitle(hookCase, { event: 'SessionStart', source: row.source })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(state, 'session-title-sent'))).toBe(false)
  })

  it('transcript_path が無いとき（Copilot CLI）、出力せず、記録を残さない', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    const result = runScript(hookCase, SCRIPT, [], {
      stdin: '{}',
      env: { PECOT_HOOK_EVENT: 'SessionStart', PECOT_HOOK_SOURCE: 'new' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(state, 'session-title-sent'))).toBe(false)
  })

  it('入力の session_title が同じ名前のとき、出力せず、記録を残さない', () => {
    // 既に同じ名前が付いているセッション
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    const result = runSessionTitle(hookCase, { currentTitle: '#1 a' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(state, 'session-title-sent'))).toBe(false)
  })

  it('session_id が空でも、記録して再送しない', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    expect(titleOf(runSessionTitle(hookCase, { sessionId: '' }))).toBe('#1 a')
    expect(readSent(state)).toBe(':#1 a\n')
    expect(runSessionTitle(hookCase, { sessionId: '' }).stdout).toBe('')
  })

  it('送った後に利用者が /rename した名前は、上書きしない', () => {
    // 入力の session_title が違う場合
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state)
    runSessionTitle(hookCase)
    expect(runSessionTitle(hookCase, { currentTitle: 'my own name' }).stdout).toBe('')
  })

  it.for([
    { label: 'owner/repo/abc', active: 'owner/repo/abc' },
    { label: 'owner/repo/', active: 'owner/repo/' },
    { label: 'owner/repo/12x', active: 'owner/repo/12x' },
    { label: '12/../x', active: '12/../x' },
  ])('active の番号が数字でない（$label）とき、無視して、出力せず記録を残さない', (row) => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state, row.active, '#1 a')
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(state, 'session-title-sent'))).toBe(false)
  })

  it('題名が別の Issue のものだったとき、番号だけにする', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state, 'owner/repo/5', '#99 x')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#5')
  })

  it('番号が前方一致するだけの題名は、採用しない', () => {
    // #12 の題名は #1 の題名として採用しない
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state, 'owner/repo/1', '#12 x')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1')
  })

  it('題名が番号と等しいとき、採用する', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state, 'owner/repo/7', '#7')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#7')
  })

  it('題名のファイルが空のとき、番号だけにする', () => {
    const hookCase = createHookCase()
    const state = setUpState(hookCase)
    activate(state, 'owner/repo/5', '')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#5')
  })
})
