/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// gitignore-track-notice.sh のテスト。
// .pecot/.gitignore の追跡の案内（未追跡 → 追跡を始める手順、定義の行の欠け → 直す手順）を検証する。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository } from '../_helpers/git.js'
import { coreDirectory, hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const NOTICE_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'gitignore-track-notice.sh')
const ENSURE_SCRIPT = path.join(coreDirectory, 'pecot-gitignore-ensure.sh')

// pecot-gitignore-ensure.sh --print の出力（定義）。失敗したら例外にする。
function readDefinition(hookCase: HookCase): string {
  const result = run(hookCase, 'bash', [ENSURE_SCRIPT, '--print'])
  if (result.exitCode !== 0) throw new Error(`--print が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
  return result.stdout
}

// hooks-config.json 不在（既定値 true で有効）に固定する。
function setUpNoConfig(hookCase: HookCase): void {
  hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'no-such-hooks-config.json'))
}

function runNotice(hookCase: HookCase, projectDirectory: string): RunResult {
  return run(hookCase, NOTICE_SCRIPT, [], { env: { CLAUDE_PROJECT_DIR: projectDirectory } })
}

function repositoryWithGitignore(hookCase: HookCase, content: string, isTracked: boolean): string {
  const repository = gitRepository(hookCase, 'repo')
  mkdirSync(path.join(repository, '.pecot'))
  writeFileSync(path.join(repository, '.pecot', '.gitignore'), Buffer.from(content, 'utf8'))
  if (isTracked) {
    gitOrThrow(hookCase, repository, ['add', '-f', '.pecot/.gitignore'])
    gitOrThrow(hookCase, repository, ['commit', '--quiet', '-m', 'track gitignore'])
  }
  return repository
}

describe('gitignore-track-notice.sh', () => {
  it('追跡していないとき、追跡を始める案内を 1 行で出す', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    setUpNoConfig(hookCase)
    const repository = repositoryWithGitignore(hookCase, definition, false)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('git add -f .pecot/.gitignore')
    expect(splitLines(result.stdout)).toHaveLength(1)
  })

  it('追跡していて定義の行が欠けているとき、直す手順を案内する', () => {
    const hookCase = createHookCase()
    setUpNoConfig(hookCase)
    const repository = repositoryWithGitignore(hookCase, '*\n', true)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`${ENSURE_SCRIPT} --print > .pecot/.gitignore`)
  })

  it('追跡していて定義に行を足しただけのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    setUpNoConfig(hookCase)
    const repository = repositoryWithGitignore(hookCase, `${definition}/my-extra/\n`, true)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('追跡していて改行が CRLF のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    setUpNoConfig(hookCase)
    const repository = repositoryWithGitignore(hookCase, definition.replaceAll('\n', '\r\n'), true)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('追跡していて定義と一致するとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    setUpNoConfig(hookCase)
    const repository = repositoryWithGitignore(hookCase, definition, true)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('ファイルが無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpNoConfig(hookCase)
    const repository = gitRepository(hookCase, 'repo')
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定で無効にしているとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    const repository = repositoryWithGitignore(hookCase, definition, false)
    const config = path.join(hookCase.temporaryPath, 'hooks-config.json')
    writeFileSync(config, '{"gitignore-track-notice": false}')
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', config)
    const result = runNotice(hookCase, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('git リポでないとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const definition = readDefinition(hookCase)
    setUpNoConfig(hookCase)
    const projectDirectory = path.join(hookCase.temporaryPath, 'plain')
    mkdirSync(path.join(projectDirectory, '.pecot'), { recursive: true })
    writeFileSync(path.join(projectDirectory, '.pecot', '.gitignore'), definition)
    const result = runNotice(hookCase, projectDirectory)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
