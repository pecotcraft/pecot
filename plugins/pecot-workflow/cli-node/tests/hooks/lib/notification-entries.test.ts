/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// 通知音のエントリ（stop.sh / notification.sh / stop-copilot.sh）のテスト。
// Copilot CLI の hook 出力には terminalSequence が無いため、stop-copilot.sh が PTY へ直接書く。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeProjectDirectory, createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase, HooksConfig } from '../_helpers/environment.js'
import { runHookEntry } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'

const BEL = '\u{7}'
const AUTO_PUSH_URLS = 'note: auto-push complete: wip/x\n  compare: https://example.test/compare\n\n'

interface Project {
  readonly project: string
  readonly config: HooksConfig
}

function setUpProject(hookCase: HookCase): Project {
  const project = claudeProjectDirectory(hookCase)
  const config = hooksConfig(hookCase)
  config.write({})
  return { project, config }
}

function writeAutoPushUrls(project: string): void {
  const flag = path.join(project, '.pecot', 'state', '.auto-push-urls')
  mkdirSync(path.dirname(flag), { recursive: true })
  writeFileSync(flag, AUTO_PUSH_URLS)
}

describe('通知音のエントリ', () => {
  it('notification.sh は、terminalSequence で BEL を出す', () => {
    const hookCase = createHookCase()
    setUpProject(hookCase)
    const result = runHookEntry(hookCase, 'notification.sh', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toEqual({ terminalSequence: BEL })
  })

  it('stop.sh は、terminalSequence で BEL を出す', () => {
    const hookCase = createHookCase()
    setUpProject(hookCase)
    const result = runHookEntry(hookCase, 'stop.sh', { hook_event_name: 'Stop' })
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toEqual({ terminalSequence: BEL })
  })

  it('stop.sh は、auto-push の systemMessage に BEL を合わせて出す', () => {
    const hookCase = createHookCase()
    const { project } = setUpProject(hookCase)
    writeAutoPushUrls(project)
    const result = runHookEntry(hookCase, 'stop.sh', { hook_event_name: 'Stop' })
    expect(parseJson(result.stdout)).toMatchObject({ terminalSequence: BEL, systemMessage: containing('wip/x') })
  })

  it('設定で terminal-bell を false にすると、何も出力しない', () => {
    const hookCase = createHookCase()
    const { config } = setUpProject(hookCase)
    config.write({ 'terminal-bell': false })
    const result = runHookEntry(hookCase, 'stop.sh', { hook_event_name: 'Stop' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('旧キー pty-bell-sender を false にしている利用者には、更新後も terminalSequence を出さない', () => {
    const hookCase = createHookCase()
    const { config } = setUpProject(hookCase)
    config.write({ 'pty-bell-sender': false })
    const result = runHookEntry(hookCase, 'stop.sh', { hook_event_name: 'Stop' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('Copilot の Stop は PTY ベルを使うので、hook 出力に terminalSequence を出さない', () => {
    const hookCase = createHookCase()
    setUpProject(hookCase)
    const result = runHookEntry(hookCase, 'stop-copilot.sh', { hook_event_name: 'Stop' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('terminalSequence')
  })

  it('Copilot の Stop は、auto-push の URL を出し、terminalSequence は出さない', () => {
    const hookCase = createHookCase()
    const { project } = setUpProject(hookCase)
    writeAutoPushUrls(project)
    const result = runHookEntry(hookCase, 'stop-copilot.sh', { hook_event_name: 'Stop' })
    const data = parseJson(result.stdout)
    expect(data).toMatchObject({ systemMessage: containing('wip/x') })
    expect(data).not.toHaveProperty('terminalSequence')
  })
})
