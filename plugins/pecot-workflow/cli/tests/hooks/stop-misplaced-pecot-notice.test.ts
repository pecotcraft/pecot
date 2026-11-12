/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// stop/misplaced-pecot-notice.sh のテスト。リポジトリルート以外にできた .pecot/ を検知し、systemMessage で案内する。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { gitRepository } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { containing, jsonDumps, parseJson } from './_helpers/text.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'stop', 'misplaced-pecot-notice.sh')
const STOP_ENTRY = path.join(hooksDirectory, 'stop.sh')

interface Project {
  readonly directory: string
  readonly config: HooksConfig
}

// CLAUDE_PROJECT_DIR を tmp/project に向け、project/.pecot を作り、設定を有効にする。
function setUpProject(hookCase: HookCase): Project {
  const directory = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(path.join(directory, '.pecot'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', directory)
  const config = hooksConfig(hookCase)
  config.write({ 'misplaced-pecot-notice': true })
  return { directory, config }
}

function runNotice(hookCase: HookCase): RunResult {
  return run(hookCase, 'bash', [SCRIPT], { stdin: '{}' })
}

describe('misplaced-pecot-notice.sh', () => {
  it('ネストした場所に .pecot があるとき、systemMessage で案内する', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot', 'work', '999'), { recursive: true })

    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    const message = parseJson(result.stdout)
    expect(message).toMatchObject({ systemMessage: containing('misplaced .pecot/') })
    expect(message).toMatchObject({ systemMessage: containing(path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot')) })
    expect(message).toMatchObject({ systemMessage: containing('.pecot/work/<Issue number>/') })
  })

  it('ルートの .pecot だけがあるとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpProject(hookCase)
    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('node_modules の下の .pecot は、検知しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project.directory, 'node_modules', 'pkg', '.pecot'), { recursive: true })
    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('.pnpm-store の下の .pecot は、検知しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project.directory, '.pnpm-store', 'v3', '.pecot'), { recursive: true })
    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // ルートの .pecot/ 配下の work に残った fixture の残骸を想定する。prune で走査の対象外になる。
  it('ルートの .pecot 配下にある入れ子の .pecot は、検知しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project.directory, '.pecot', 'work', '730', 'fixture', '.pecot'), { recursive: true })
    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定で misplaced-pecot-notice が無効なとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    project.config.write({ 'misplaced-pecot-notice': false })
    mkdirSync(path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot', 'work', '999'), { recursive: true })
    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('誤配置の .pecot が複数あるとき、全件を systemMessage に列挙する', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const first = path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot')
    const second = path.join(project.directory, 'tools', 'cli', '.pecot')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })

    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    const message = parseJson(result.stdout)
    expect(message).toMatchObject({ systemMessage: containing(first) })
    expect(message).toMatchObject({ systemMessage: containing(second) })
  })

  it('誤配置の .pecot の下にさらに .pecot があるとき、いちばん上の 1 件だけを報告する', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const top = path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot')
    const nested = path.join(top, 'work', '999', '.pecot')
    mkdirSync(nested, { recursive: true })

    const result = runNotice(hookCase)
    expect(result.exitCode).toBe(0)
    const message = parseJson(result.stdout)
    expect(message).toMatchObject({ systemMessage: containing(top) })
    // 入れ子の .pecot は prune されて、トップに集約される
    expect(message).not.toMatchObject({ systemMessage: containing(nested) })
  })

  it('stop.sh 経由では、hook 入力の cwd の git ルートを基準に検知する', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    mkdirSync(path.join(repository, '.pecot'))
    const misplaced = path.join(repository, 'plugins', 'pecot-workflow', '.pecot')
    mkdirSync(misplaced, { recursive: true })
    const subdirectory = path.join(repository, 'plugins', 'pecot-workflow')

    hookCase.setEnv('CLAUDE_PROJECT_DIR', undefined)
    hooksConfig(hookCase).write({ 'misplaced-pecot-notice': true })
    const result = run(hookCase, 'bash', [STOP_ENTRY], { stdin: jsonDumps({ cwd: subdirectory }) })
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({ systemMessage: containing(misplaced) })
  })

  it('git リポジトリの外で CLAUDE_PROJECT_DIR が未設定のとき、安全側に倒して何も出力しない', () => {
    const hookCase = createHookCase()
    const nonRepository = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(path.join(nonRepository, 'sub', '.pecot'), { recursive: true })

    hookCase.setEnv('CLAUDE_PROJECT_DIR', undefined)
    hooksConfig(hookCase).write({ 'misplaced-pecot-notice': true })
    const result = run(hookCase, 'bash', [SCRIPT], { stdin: '{}', cwd: nonRepository })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('stop.sh 経由では、auto-push と誤配置の .pecot の systemMessage を連結する', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    // auto-push.sh が .auto-push-urls を読んで systemMessage にする
    const stateDirectory = path.join(project.directory, '.pecot', 'state')
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(path.join(stateDirectory, '.auto-push-urls'), 'pushed: https://example/pr/1')
    mkdirSync(path.join(project.directory, 'plugins', 'pecot-workflow', '.pecot'), { recursive: true })

    const result = run(hookCase, 'bash', [STOP_ENTRY], { stdin: '{}' })
    expect(result.exitCode).toBe(0)
    const payload = parseJson(result.stdout)
    expect(payload).toMatchObject({ systemMessage: containing('pushed: https://example/pr/1') })
    expect(payload).toMatchObject({ systemMessage: containing('misplaced .pecot/') })
    // systemMessage だけを返すので hookSpecificOutput は出ない
    expect(payload).not.toHaveProperty('hookSpecificOutput')
  })
})
