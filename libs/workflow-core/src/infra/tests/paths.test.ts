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
import { explains } from '../../../tests/_helpers/explains.js'

useIsolatedEnvironment()

describe('パス定数', () => {
  it('.pecot 配下の各定数は、決まった相対パスの値になる', async () => {
    await explains('`.pecot` 配下のパス定数のテストです。`PECOT_DIR` や `STATE_DIR` などの各定数が、決められた相対パスの文字列になることを確認します。')
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
  it('CLAUDE_PROJECT_DIR が設定されている場合は、その値をプロジェクトルートにする', async () => {
    await explains('プロジェクトルートを返す `projectRoot` のテストです。環境変数 `CLAUDE_PROJECT_DIR` を設定した場合に、その値を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot()).toBe(directory)
  })

  it('CLAUDE_PROJECT_DIR は、git のルートより優先する', async () => {
    await explains('`projectRoot` のテストです。`CLAUDE_PROJECT_DIR` と git のルートの両方が存在する場合に、`CLAUDE_PROJECT_DIR` の値を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    const repository = createGitRepository()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot({ cwd: repository })).toBe(directory)
  })

  it('環境変数が存在しない場合は、git のルートを返す', async () => {
    await explains('`projectRoot` のテストです。`CLAUDE_PROJECT_DIR` を設定していない場合に、`cwd` を含む git リポジトリのルートを返すことを確認します。')
    const repository = createGitRepository()
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })

  it('cwd を指定しない場合は、呼び出し元の作業ディレクトリを基準にする', async () => {
    await explains('`projectRoot` のテストです。`cwd` を指定せず、git リポジトリの中で実行した場合は、そのリポジトリのルートを返すことを確認します。')
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

  it('git の外で環境変数も存在しない場合は、ProjectRootNotFoundError を発生させる', async () => {
    await explains('`projectRoot` のテストです。git リポジトリの外で `CLAUDE_PROJECT_DIR` も設定していない場合に、対処法を示すメッセージを持つ `ProjectRootNotFoundError` が発生することを確認します。')
    const directory = makeTemporaryDirectory()
    expect(() => projectRoot({ cwd: directory })).toThrow(ProjectRootNotFoundError)
    expect(() => projectRoot({ cwd: directory })).toThrow('project root not found: run inside a git repository or set the CLAUDE_PROJECT_DIR environment variable')
  })

  it('作業ディレクトリが削除されている場合は、git のルートを得られず ProjectRootNotFoundError を発生させる', async () => {
    await explains('`projectRoot` のテストです。作業ディレクトリが削除された状態で呼び出した場合に、`ProjectRootNotFoundError` が発生することを確認します。')
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

  it('CLAUDE_PROJECT_DIR の末尾のスラッシュ・重複したスラッシュ・. を、正規化して返す', async () => {
    await explains('`projectRoot` のテストです。`CLAUDE_PROJECT_DIR` が `/a//b/./c/` の場合に、`/a/b/c` に正規化して返すことを確認します。')
    setEnvironment({ CLAUDE_PROJECT_DIR: '/a//b/./c/' })
    expect(projectRoot()).toBe('/a/b/c')
  })

  it('環境変数 GIT_DIR が別の場所を指していても、cwd を基準に解決する', async () => {
    await explains('`projectRoot` のテストです。`GIT_DIR` が存在しないパスを指していても、`cwd` を基準にした git のルートを返すことを確認します。')
    const repository = createGitRepository()
    setEnvironment({ GIT_DIR: path.join(repository, 'nonexistent.git') })
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })
})

describe('projectRoot（cwd が無くなっているとき）', () => {
  it('指定した cwd が存在しない場合は、ProjectRootNotFoundError を発生させる', async () => {
    await explains('`projectRoot` のテストです。存在しない `cwd` を指定し、git のルートも得られない場合に、`ProjectRootNotFoundError` が発生することを確認します。')
    expect(() => projectRoot({ cwd: path.join(makeTemporaryDirectory(), 'removed') })).toThrow(ProjectRootNotFoundError)
  })
})

describe('resolveRealPath', () => {
  it('存在しないパスは、存在する最も深い親ディレクトリの実パスに、残りをそのままつなぐ', async () => {
    await explains('実パスを解決する `resolveRealPath` のテストです。シンボリックリンクの下に存在しないパスを指定した場合に、リンク先の実パスに残りの部分をつないだパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    const link = path.join(root, 'link')
    mkdirSync(path.join(root, 'real'))
    symlinkSync(path.join(root, 'real'), link)
    expect(resolveRealPath(path.join(link, 'not', 'yet'))).toBe(path.join(root, 'real', 'not', 'yet'))
  })

  it('シンボリックリンクが循環している場合は、ELOOP のエラーを発生させる', async () => {
    await explains('`resolveRealPath` のテストです。シンボリックリンクが循環している場合に、`ELOOP` を含む例外が発生することを確認します。')
    const root = makeTemporaryDirectory()
    symlinkSync(path.join(root, 'b'), path.join(root, 'a'))
    symlinkSync(path.join(root, 'a'), path.join(root, 'b'))
    expect(() => resolveRealPath(path.join(root, 'a'))).toThrow(/ELOOP/u)
  })
})
