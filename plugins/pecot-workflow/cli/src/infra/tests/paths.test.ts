/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProjectRootNotFoundError } from '../../domain/errors.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { pluginRoot } from '../../version.js'
import {
  ACTIVE_PROJECT_FILENAME,
  PECOT_DIR,
  PECOT_GITIGNORE_FILENAME,
  CONFIG_DIR,
  dataDirectory,
  HOOKS_CONFIG_FILENAME,
  OUTPUT_DIR,
  projectRoot,
  resolveRealPath,
  STATE_DIR,
  WORK_DIR,
  WORKTREE_CONFIG_FILENAME,
  WORKTREE_IGNORE_FILENAME,
} from '../paths.js'

useIsolatedEnvironment()

describe('パス定数', () => {
  it('.pecot 配下の各定数は、決まった相対パスの値になる', () => {
    expect(PECOT_DIR).toBe('.pecot')
    expect(STATE_DIR).toBe('.pecot/state')
    expect(WORK_DIR).toBe('.pecot/work')
    expect(CONFIG_DIR).toBe('.pecot/config')
    expect(OUTPUT_DIR).toBe('.pecot/tmp/output')
    expect(WORKTREE_CONFIG_FILENAME).toBe('.pecot/config/worktree-config.json')
    expect(WORKTREE_IGNORE_FILENAME).toBe('.pecot/config/.worktreeignore')
    expect(HOOKS_CONFIG_FILENAME).toBe('.pecot/config/hooks-config.json')
    expect(ACTIVE_PROJECT_FILENAME).toBe('.pecot/config/projects/.active')
    expect(PECOT_GITIGNORE_FILENAME).toBe('.pecot/.gitignore')
  })
})

describe('projectRoot', () => {
  it('CLAUDE_PROJECT_DIR があればそれ（テスト上書き用）', () => {
    const directory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot()).toBe(directory)
  })

  it('CLAUDE_PROJECT_DIR は git のルートより優先される', () => {
    const directory = makeTemporaryDirectory()
    const repository = createGitRepository()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot({ cwd: repository })).toBe(directory)
  })

  it('環境変数が無ければ git のルート', () => {
    const repository = createGitRepository()
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })

  it('既定の cwd は呼び出し元の作業ディレクトリ', () => {
    const repository = createGitRepository()
    const previous = process.cwd()
    process.chdir(repository)
    try {
      expect(projectRoot()).toBe(repository)
    }
    finally {
      process.chdir(previous)
    }
  })

  it('git の外で環境変数も無ければ ProjectRootNotFoundError', () => {
    const directory = makeTemporaryDirectory()
    expect(() => projectRoot({ cwd: directory })).toThrow(ProjectRootNotFoundError)
    expect(() => projectRoot({ cwd: directory })).toThrow('project root not found: run inside a git repository or set the CLAUDE_PROJECT_DIR environment variable')
  })

  it('作業ディレクトリが消えていたら git のルートは得られず ProjectRootNotFoundError', () => {
    const removed = path.join(makeTemporaryDirectory(), 'removed')
    mkdirSync(removed)
    const previous = process.cwd()
    process.chdir(removed)
    try {
      rmdirSync(removed)
      expect(() => projectRoot()).toThrow(ProjectRootNotFoundError)
    }
    finally {
      process.chdir(previous)
    }
  })

  it('CLAUDE_PROJECT_DIR は Path と同じ形に正規化する（末尾のスラッシュ・重複スラッシュ・.）', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: '/a//b/./c/' })
    expect(projectRoot()).toBe('/a/b/c')
  })

  it('GIT_* が別の場所を指していても cwd 基準で解決する', () => {
    const repository = createGitRepository()
    setEnvironment({ GIT_DIR: path.join(repository, 'nonexistent.git') })
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })
})

describe('projectRoot（cwd が無くなっているとき）', () => {
  it('cwd が無くなっていたら git にフォールバックし、そこも失敗すれば ProjectRootNotFoundError', () => {
    expect(() => projectRoot({ cwd: path.join(makeTemporaryDirectory(), 'removed') })).toThrow(ProjectRootNotFoundError)
  })
})

describe('resolveRealPath', () => {
  it('存在しない部分は、存在する最も深い親を解決して字句どおりにつなぐ', () => {
    const root = makeTemporaryDirectory()
    const link = path.join(root, 'link')
    mkdirSync(path.join(root, 'real'))
    symlinkSync(path.join(root, 'real'), link)
    expect(resolveRealPath(path.join(link, 'not', 'yet'))).toBe(path.join(root, 'real', 'not', 'yet'))
  })

  it('ENOENT 以外のエラー（循環）は投げる', () => {
    const root = makeTemporaryDirectory()
    symlinkSync(path.join(root, 'b'), path.join(root, 'a'))
    symlinkSync(path.join(root, 'a'), path.join(root, 'b'))
    expect(() => resolveRealPath(path.join(root, 'a'))).toThrow(/ELOOP/u)
  })
})

describe('dataDirectory は bin/_lib.sh の plugin_data_dir_resolve と同じ結果になる', () => {
  const libraryPath = path.join(pluginRoot(), 'bin', '_lib.sh')
  const callFunction = path.join(import.meta.dirname, '../../tests/_helpers/call-bash-function.sh')
  const PROJECT_NAME = 'pecot-workflow'

  /**
  bash で plugin_data_dir_resolve を呼ぶ。データ置き場の 3 変数・XDG_DATA_HOME・HOME を消してから values を設定する
  */
  function bashResolve(values: Readonly<Record<string, string>>): { readonly stdout: string, readonly status: number | null } {
    const environment: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...values }
    const result = spawnSync('bash', [callFunction, libraryPath, 'plugin_data_dir_resolve', PROJECT_NAME], { env: environment, encoding: 'utf8' })
    return { stdout: result.stdout, status: result.status }
  }

  const CASES: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['CLAUDE_PLUGIN_DATA が絶対パス', { CLAUDE_PLUGIN_DATA: '/data/claude', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の改行は落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\n\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の CR も落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\r\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が相対パスなら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: 'relative/dir', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が変数展開の書式なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: '/data/plugin' }],
    ['CLAUDE_PLUGIN_DATA が空なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '/data/plugin' }],
    ['PLUGIN_DATA だけ', { PLUGIN_DATA: '/data/plugin', XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が絶対パス', { XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が相対パスなら HOME', { XDG_DATA_HOME: 'xdg', HOME: '/home/u' }],
    ['HOME だけ', { HOME: '/home/u' }],
    ['HOME の末尾の改行は落とす', { HOME: '/home/u\n' }],
    ['HOME が相対パスなら解決できない', { HOME: 'relative' }],
    ['HOME が変数展開の書式なら解決できない', { HOME: '${HOME}' }],
    ['何も無ければ解決できない', {}],
    ['空白を含むパスは trim しない', { CLAUDE_PLUGIN_DATA: '/data/with space ' }],
  ]

  it.each(CASES)('%s のとき、bash と同じ場所を返す', (_name, values) => {
    const expected = bashResolve(values)
    // 未設定にした上で設定する（テストの env を bash に渡した env と一致させる）
    setEnvironment({ CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined, XDG_DATA_HOME: undefined, HOME: undefined })
    setEnvironment(values)
    const expectedDirectory = expected.status === 0 ? expected.stdout.replace(/\n$/u, '') : undefined
    expect(dataDirectory()).toBe(expectedDirectory)
  })

  it('bash の解決結果が実際に得られている（テストの前提）', () => {
    expect(execFileSync('bash', [callFunction, libraryPath, 'plugin_data_dir_resolve', PROJECT_NAME], { env: { PATH: process.env['PATH'] ?? '', HOME: '/home/u' }, encoding: 'utf8' }))
      .toBe(`/home/u/.local/share/pecot/${PROJECT_NAME}\n`)
  })
})
