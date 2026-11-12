/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pecot-gitignore-ensure.sh のテスト。
// 中身は許可の一覧で、実 git リポで、除外されるパスと戻るパスを確かめる。
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const ENSURE_SCRIPT = path.join(coreDirectory, 'pecot-gitignore-ensure.sh')

function runEnsure(hookCase: HookCase, projectDirectory: string): RunResult {
  hookCase.setEnv('CLAUDE_PROJECT_DIR', projectDirectory)
  return run(hookCase, 'bash', [ENSURE_SCRIPT])
}

function git(hookCase: HookCase, repository: string, ...argv: readonly string[]): RunResult {
  return run(hookCase, 'git', ['-C', repository, ...argv])
}

function touch(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, 'x\n')
}

function isTracked(hookCase: HookCase, repository: string): boolean {
  return git(hookCase, repository, 'ls-files', '--error-unmatch', '--', '.pecot/.gitignore').exitCode === 0
}

describe('pecot-gitignore-ensure.sh', () => {
  it('--print は、書き込まずに定義を出力する', () => {
    const hookCase = createHookCase()
    hookCase.setEnv('CLAUDE_PROJECT_DIR', undefined)
    const result = run(hookCase, 'bash', [ENSURE_SCRIPT, '--print'])
    expect(result.exitCode).toBe(0)
    const lines = splitLines(result.stdout).filter(line => line !== '' && !line.startsWith('#'))
    expect(lines).toEqual([
      '*',
      '!/config/',
      '/config/*',
      '!/config/worktree-config.json',
      '!/config/.worktreeignore',
      '!/config/projects/',
      '/config/projects/*',
      '!/config/projects/*.json',
    ])
    expect(existsSync(path.join(hookCase.temporaryPath, '.pecot'))).toBe(false)
  })

  it('.pecot が無くても .gitignore を書き、--print の出力と一致する', () => {
    const hookCase = createHookCase()
    const project = path.join(hookCase.temporaryPath, 'proj')
    mkdirSync(project)

    expect(runEnsure(hookCase, project).exitCode).toBe(0)
    const printed = run(hookCase, 'bash', [ENSURE_SCRIPT, '--print']).stdout
    expect(readFileSync(path.join(project, '.pecot', '.gitignore'), 'utf8')).toBe(printed)
  })

  it('許可の一覧は、生成物を除外し、config の一部を除外しない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'repo')
    expect(runEnsure(hookCase, repository).exitCode).toBe(0)
    const pecot = path.join(repository, '.pecot')

    const ignored = [
      'tmp/debug/plan-post-flow.log',
      'tmp/.session-start-common.lock',
      'state/x.json',
      'README.md',
      'CHANGELOG.md',
      'config/hooks-config.json',
      'config/hooks-config.json.sample',
      'config/hosts.json',
      'config/.env',
      'config/projects/.active',
      '.gitignore',
    ]
    const kept = ['config/worktree-config.json', 'config/.worktreeignore', 'config/projects/x.json']
    for (const relative of [...ignored, ...kept]) {
      if (relative !== '.gitignore') touch(path.join(pecot, relative))
    }
    // WT 側を再現: work が共有先を指す symlink
    const shared = path.join(hookCase.temporaryPath, 'shared-work')
    mkdirSync(shared)
    symlinkSync(shared, path.join(pecot, 'work'))
    ignored.push('work')

    const ignoredExitCodes = ignored.map(relative => git(hookCase, repository, 'check-ignore', `.pecot/${relative}`).exitCode)
    const keptExitCodes = kept.map(relative => git(hookCase, repository, 'check-ignore', `.pecot/${relative}`).exitCode)
    // ignore されるものは 0、ignore されないものは 1 を返す
    expect(ignoredExitCodes, `${ignored.join(', ')} は ignore されるはず`).toEqual(ignored.map(() => 0))
    expect(keptExitCodes, `${kept.join(', ')} は ignore されないはず`).toEqual(kept.map(() => 1))
  })

  it('追跡している .gitignore を書き換えると、差分が変更として現れる', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'repo')
    expect(runEnsure(hookCase, repository).exitCode).toBe(0)
    expect(git(hookCase, repository, 'add', '-f', '.pecot/.gitignore').exitCode).toBe(0)
    expect(git(hookCase, repository, 'commit', '--quiet', '-m', 'track').exitCode).toBe(0)

    writeFileSync(path.join(repository, '.pecot', '.gitignore'), '*\n# 変更\n')
    const status = git(hookCase, repository, 'status', '--porcelain', '--', '.pecot/.gitignore')
    expect(status.stdout.startsWith(' M ')).toBe(true)
  })

  it('追跡していない既存の古い内容は、上書きする', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'repo')
    mkdirSync(path.join(repository, '.pecot'))
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'state/\n/.gitignore\n')

    expect(runEnsure(hookCase, repository).exitCode).toBe(0)
    const lines = splitLines(readFileSync(path.join(repository, '.pecot', '.gitignore'), 'utf8'))
    expect(lines).not.toContain('state/')
    expect(lines).not.toContain('/.gitignore')
    expect(lines).toContain('!/config/')
  })

  it('git リポでないディレクトリの既存の内容も、上書きする', () => {
    const hookCase = createHookCase()
    const project = path.join(hookCase.temporaryPath, 'plain')
    mkdirSync(path.join(project, '.pecot'), { recursive: true })
    writeFileSync(path.join(project, '.pecot', '.gitignore'), 'stale\n')

    expect(runEnsure(hookCase, project).exitCode).toBe(0)
    const lines = splitLines(readFileSync(path.join(project, '.pecot', '.gitignore'), 'utf8'))
    expect(lines).not.toContain('stale')
  })

  it('追跡している .gitignore には触らない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'repo')
    mkdirSync(path.join(repository, '.pecot'))
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'stale\n')
    expect(git(hookCase, repository, 'add', '-f', '.pecot/.gitignore').exitCode).toBe(0)
    expect(git(hookCase, repository, 'commit', '--quiet', '-m', 'track old').exitCode).toBe(0)
    expect(isTracked(hookCase, repository)).toBe(true)

    expect(runEnsure(hookCase, repository).exitCode).toBe(0)
    expect(readFileSync(path.join(repository, '.pecot', '.gitignore'), 'utf8')).toBe('stale\n')
    expect(git(hookCase, repository, 'status', '--porcelain').stdout).toBe('')
  })
})
