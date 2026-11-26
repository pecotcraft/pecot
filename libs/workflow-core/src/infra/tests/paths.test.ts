/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, rmdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProjectRootNotFoundError } from '../../domain/errors.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { createGitRepository } from '../../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import {
  ACTIVE_PROJECT_FILENAME,
  PECOT_DIR,
  PECOT_GITIGNORE_FILENAME,
  CONFIG_DIR,
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
