/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pecot-state-guard.sh のテスト。
// .pecot 配下への書き込みガード（gitignore-before-write 規約）の単一実装を検証する。
// pecot_state_dir_ensure を source 経由で呼び、終了コードと副作用（.gitignore 生成・ディレクトリ作成）を観測する。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeProjectDirectory, createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const GUARD_SCRIPT = path.join(coreDirectory, 'pecot-state-guard.sh')

// source guard && pecot_state_dir_ensure <dir> を実行する。shouldUnsetProjectDirectory のとき CLAUDE_PROJECT_DIR を unset してから呼ぶ。
function runEnsure(hookCase: HookCase, targetDirectory: string, shouldUnsetProjectDirectory = false): RunResult {
  const prefix = shouldUnsetProjectDirectory ? 'unset CLAUDE_PROJECT_DIR; ' : ''
  return run(hookCase, 'bash', ['-c', `${prefix}source "$1"; pecot_state_dir_ensure "$2"`, '_', GUARD_SCRIPT, targetDirectory])
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory()
}

function isFile(target: string): boolean {
  return existsSync(target) && statSync(target).isFile()
}

// claudeProjectDirectory は .pecot を作成済みなので、ガード本来の「.pecot 不在」のケースを作れるよう削除して、そのパスを返す。
function setUpAbsentPecot(hookCase: HookCase): string {
  const pecot = path.join(claudeProjectDirectory(hookCase), '.pecot')
  rmSync(pecot, { recursive: true, force: true })
  return pecot
}

describe('pecot-state-guard.sh', () => {
  it('.pecot が無いとき、失敗し、.pecot を新規作成しない', () => {
    const hookCase = createHookCase()
    const pecot = setUpAbsentPecot(hookCase)
    const result = runEnsure(hookCase, path.join(pecot, 'state'))
    expect(result.exitCode).not.toBe(0)
    expect(isDirectory(pecot)).toBe(false)
  })

  it('.pecot があり .gitignore が無いとき、.gitignore を生成してからディレクトリを作る', () => {
    const hookCase = createHookCase()
    const pecot = setUpAbsentPecot(hookCase)
    mkdirSync(pecot, { recursive: true })
    expect(isFile(path.join(pecot, '.gitignore'))).toBe(false)

    const result = runEnsure(hookCase, path.join(pecot, 'state'))
    expect(result.exitCode).toBe(0)

    const gitignore = path.join(pecot, '.gitignore')
    expect(isFile(gitignore)).toBe(true)
    expect(isDirectory(path.join(pecot, 'state'))).toBe(true)
    // pecot-gitignore-ensure.sh の生成内容（許可の一覧）が含まれる
    expect(splitLines(readFileSync(gitignore, 'utf8'))).toContain('*')
  })

  it('.pecot と .gitignore があるとき、既存の .gitignore の内容を変えない', () => {
    const hookCase = createHookCase()
    const pecot = setUpAbsentPecot(hookCase)
    mkdirSync(pecot, { recursive: true })
    writeFileSync(path.join(pecot, '.gitignore'), 'sentinel-existing-content\n')

    const result = runEnsure(hookCase, path.join(pecot, 'state'))
    expect(result.exitCode).toBe(0)

    expect(readFileSync(path.join(pecot, '.gitignore'), 'utf8')).toBe('sentinel-existing-content\n')
    expect(isDirectory(path.join(pecot, 'state'))).toBe(true)
  })

  it('深いディレクトリを渡しても、作成する', () => {
    const hookCase = createHookCase()
    const pecot = setUpAbsentPecot(hookCase)
    mkdirSync(pecot, { recursive: true })
    writeFileSync(path.join(pecot, '.gitignore'), 'x\n')

    const result = runEnsure(hookCase, path.join(pecot, 'tmp', 'debug'))
    expect(result.exitCode).toBe(0)
    expect(isDirectory(path.join(pecot, 'tmp', 'debug'))).toBe(true)
  })

  it('CLAUDE_PROJECT_DIR が未設定のとき、失敗し、何も作らない', () => {
    const hookCase = createHookCase()
    // claude_project_dir で .pecot を隔離するが、このケースは unset を別途指定する
    claudeProjectDirectory(hookCase)
    const target = path.join(hookCase.temporaryPath, 'should-not-be-created', 'state')
    const result = runEnsure(hookCase, target, true)
    expect(result.exitCode).not.toBe(0)
    expect(isDirectory(path.dirname(target))).toBe(false)
  })
})
