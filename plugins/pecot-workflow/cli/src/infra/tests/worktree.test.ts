/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { compileGitIgnoreSpec, GitIgnorePatternError } from '../gitignore-spec.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
import { DEFAULT_WORKTREEIGNORE_CONTENT } from '../worktree-links.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { installFakeExecutable, prependToPath } from '../../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { createGitRepository, gitForTest } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import {
  claimedSetNames,
  createWorktree,
  detectProjectRoot,
  ensureDevcontainerEnvironment,
  filterCopyableFiles,
  findWorktreeConfigFile,
  findMainWorktree,
  getCurrentWorktreeName,
  getNextSetName,
  getUntrackedFiles,
  getWorktreeDirectories,
  getWorktreeList,
  isWorktreeEnvironment,
  removeWorktree,
  WorktreeRuntimeError,
} from '../worktree.js'
import { ignoredDiagnostics, recordDiagnostics } from '../../../../../../libs/workflow-core/tests/_helpers/recording-diagnostics.js'
// 案内の文を描くには、コマンドの形の登録が要る
import '../../commands/registry.js'

useIsolatedEnvironment()

interface Project {
  /**
  <root>/base/myrepo（main WT）
  */
  readonly repository: string
  readonly root: string
  /**
  アクティブなプロジェクト設定を置いた CLAUDE_PROJECT_DIR
  */
  readonly configRoot: string
}

interface ProjectOptions {
  /**
  worktree-config.json の中身。省略時は links 無しの v3
  */
  readonly worktreeConfig?: string
  readonly ignoreContent?: string
  /**
  プロジェクト設定の repositories。省略時は myowner/myrepo（develop_branch = develop）だけ
  */
  readonly repositories?: readonly Readonly<Record<string, string>>[]
  /**
  origin の URL。省略時は https://github.com/myowner/myrepo.git
  */
  readonly originUrl?: string
  /**
  main WT にコミットするファイル
  */
  readonly files?: Readonly<Record<string, string>>
}

const DEFAULT_REPOSITORIES: readonly Readonly<Record<string, string>>[] = [{ owner: 'myowner', name: 'myrepo', develop_branch: 'develop' }]

function projectConfigJson(repositories: readonly Readonly<Record<string, string>>[]): string {
  return JSON.stringify({
    host: 'github.com',
    owner: 'myowner',
    workflow_suffix: 'test',
    project: { number: 1, id: 'PVT_test', fields: { workflow: { id: 'F', options: {} } } },
    repositories,
  })
}

// <root>/base/myrepo を実 git で作る。bare の origin に main と develop を push してから、origin の URL を GitHub 形式に付け替える
function createProject(options: Readonly<ProjectOptions> = {}): Project {
  const root = path.join(makeTemporaryDirectory(), 'workspaces')
  const repository = path.join(root, 'base', 'myrepo')
  createGitRepository(options.files ?? { 'README.md': 'x' }, repository)
  gitForTest(repository, ['branch', 'develop'])
  const bare = path.join(root, 'remotes', 'myrepo.git')
  mkdirSync(bare, { recursive: true })
  gitForTest(bare, ['init', '--bare', '-q'])
  gitForTest(repository, ['remote', 'add', 'origin', bare])
  gitForTest(repository, ['push', '-q', 'origin', 'main', 'develop'])
  gitForTest(repository, ['remote', 'set-url', 'origin', options.originUrl ?? 'https://github.com/myowner/myrepo.git'])
  writeTree(repository, {
    '.pecot/config/worktree-config.json': options.worktreeConfig ?? '{"version": 3, "links": []}\n',
    '.pecot/config/.worktreeignore': options.ignoreContent ?? '.git/\n__pycache__/\n',
  })
  const configRoot = makeTemporaryDirectory()
  writeTree(configRoot, {
    '.pecot/config/projects/github.com_myowner_1.json': projectConfigJson(options.repositories ?? DEFAULT_REPOSITORIES),
    '.pecot/config/projects/.active': 'github.com_myowner_1.json\n',
  })
  setEnvironment({ CLAUDE_PROJECT_DIR: configRoot })
  return { repository, root, configRoot }
}

function branchCommit(repository: string, branch: string): string {
  return gitForTest(repository, ['rev-parse', branch]).trim()
}

function thrownError(action: () => void): unknown {
  try {
    action()
  }
  catch (error: unknown) {
    return error
  }
  return new Error('例外が投げられなかった')
}

function runtimeError(action: () => void): WorktreeRuntimeError {
  const error = thrownError(action)
  if (error instanceof WorktreeRuntimeError) return error
  throw new Error(`WorktreeRuntimeError でない: ${String(error)}`)
}

function runtimeMessage(action: () => void): string {
  return runtimeError(action).message
}

async function asyncRuntimeError(action: () => Promise<unknown>): Promise<WorktreeRuntimeError> {
  try {
    await action()
  }
  catch (error: unknown) {
    if (error instanceof WorktreeRuntimeError) return error
    throw new Error(`WorktreeRuntimeError でない: ${String(error)}`, { cause: error })
  }
  throw new Error('例外が投げられなかった')
}

async function asyncRuntimeMessage(action: () => Promise<unknown>): Promise<string> {
  const { message } = await asyncRuntimeError(action)
  return message
}

/**
指定した引数の git の出力を偽物にする。それ以外の引数は終了コード 1
*/
function installFakeGit(responses: Readonly<Record<string, string>>): void {
  const bin = makeTemporaryDirectory()
  const cases = Object.entries(responses).map(([gitArguments, output]) => `  '${gitArguments}') printf '%s' '${output}';;`).join('\n')
  installFakeExecutable(bin, 'git', `case "$*" in\n${cases}\n  *) exit 1;;\nesac\n`)
  prependToPath(bin)
}

describe('getWorktreeList', () => {
  it('メインと追加した WT を、パス・コミット・ブランチに分ける（実 git）', async () => {
    await explains('git の worktree の一覧を取得する `getWorktreeList` のテストです。メインと追加した worktree がある場合に、それぞれのパス・コミット・ブランチに分けて返すことを確認します。')
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(root, 'wt1', 'myrepo')])
    const list = getWorktreeList(repository)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ path: repository, commit: branchCommit(repository, 'main'), branch: 'main' })
    expect(list[1]?.branch).toBe('wt1')
    expect(list[1]?.path).toBe(path.join(root, 'wt1', 'myrepo'))
  })

  it('detached HEAD の worktree は、ブランチを undefined として返す（実 git）', async () => {
    await explains('git の worktree の一覧を取得する `getWorktreeList` のテストです。HEAD を切り離した worktree がある場合に、その worktree のブランチが `undefined` になることを確認します。')
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '--detach', path.join(root, 'wt1', 'myrepo')])
    expect(getWorktreeList(repository).map(entry => entry.branch)).toEqual(['main', undefined])
  })

  it('porcelain の出力を、空白を含むパス・detached・bare も含めて分ける（偽の git）', async () => {
    await explains('git の worktree の一覧を取得する `getWorktreeList` のテストです。偽の git が返す `--porcelain` の出力に、空白を含むパス・detached・bare が含まれる場合に、エントリごとに正しく分けることを確認します。')
    installFakeGit({ 'worktree list --porcelain': 'worktree /home/user/my repo\nHEAD abc1234\nbranch refs/heads/main\n\nworktree /home/user/wt1/repo\nHEAD def5678\nbranch refs/heads/feature/x\nlocked\n\nworktree /home/user/d\nHEAD 0123456\ndetached\n\nworktree /home/user/b\nbare\n' })
    expect(getWorktreeList()).toEqual([
      { path: '/home/user/my repo', commit: 'abc1234', branch: 'main' },
      { path: '/home/user/wt1/repo', commit: 'def5678', branch: 'feature/x' },
      { path: '/home/user/d', commit: '0123456', branch: undefined },
      { path: '/home/user/b', commit: '', branch: undefined },
    ])
  })

  it('空白を含むパスの worktree を、一覧・メインの特定・削除で扱える（実 git）', async () => {
    await explains('空白を含むパスの worktree を扱うテストです。一覧の取得・メインの特定・削除のいずれも、空白を含むパスで正しく動作することを確認します。')
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'with space', 'my repo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(getWorktreeList(repository).map(entry => entry.path)).toEqual([repository, worktree])
    expect(findMainWorktree(worktree)).toBe(repository)
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
  })

  it('git の出力が空の場合は、空の一覧を返す', async () => {
    await explains('git の worktree の一覧を取得する `getWorktreeList` のテストです。偽の git の出力が空の場合に、空の一覧を返すことを確認します。')
    installFakeGit({ 'worktree list --porcelain': '' })
    expect(getWorktreeList()).toEqual([])
  })

  it('git が失敗すれば空（git リポジトリの外）', async () => {
    await explains('git の worktree の一覧を取得する `getWorktreeList` のテストです。git リポジトリの外で実行して git が失敗した場合に、空の一覧を返すことを確認します。')
    expect(getWorktreeList(makeTemporaryDirectory())).toEqual([])
  })
})

describe('findMainWorktree', () => {
  it('どの WT からでも、最初のエントリ（メイン WT）を返す', async () => {
    await explains('メインの worktree を特定する `findMainWorktree` のテストです。メインとサブのどちらの worktree から呼んでも、一覧の最初のエントリであるメインの worktree のパスを返すことを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(findMainWorktree(worktree)).toBe(repository)
    expect(findMainWorktree(repository)).toBe(repository)
  })

  it('一覧を取得できなければ WorktreeRuntimeError。git の stderr を含む', async () => {
    await explains('メインの worktree を特定する `findMainWorktree` のテストです。git リポジトリの外で一覧を取得できない場合に、git の標準エラー出力を含む `WorktreeRuntimeError` が発生することを確認します。')
    const message = runtimeMessage(() => findMainWorktree(makeTemporaryDirectory()))
    expect(message).toMatch(/^cannot get the worktree list: fatal: not a git repository/u)
  })

  it('一覧が空でも WorktreeRuntimeError', async () => {
    await explains('メインの worktree を特定する `findMainWorktree` のテストです。git の出力が空白だけで一覧が空の場合に、`WorktreeRuntimeError` が発生することを確認します。')
    installFakeGit({ 'worktree list --porcelain': '  \n' })
    expect(runtimeMessage(() => findMainWorktree('.'))).toBe('cannot get the worktree list: ')
  })

  it('作業ディレクトリが存在しなければ OsError を投げる（Python の FileNotFoundError に当たる）', async () => {
    await explains('メインの worktree を特定する `findMainWorktree` のテストです。作業ディレクトリが存在しない場合に、`OsError` が発生することを確認します。')
    expect(thrownError(() => findMainWorktree(path.join(makeTemporaryDirectory(), 'missing')))).toBeInstanceOf(OsError)
  })
})

describe('findWorktreeConfigFile', () => {
  it('メイン WT の worktree-config.json を、サブ WT からでも見つける', async () => {
    await explains('worktree の設定ファイルを探す `findWorktreeConfigFile` のテストです。サブの worktree から呼んだ場合でも、メインの worktree にある `worktree-config.json` のパスを返すことを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(findWorktreeConfigFile(worktree)).toBe(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
  })

  it('設定ファイルが存在しない場合と git の外の場合は、undefined を返す', async () => {
    await explains('worktree の設定ファイルを探す `findWorktreeConfigFile` のテストです。設定ファイルが存在しない場合と、git リポジトリの外で実行した場合に、`undefined` を返すことを確認します。')
    const repository = createGitRepository()
    expect(findWorktreeConfigFile(repository)).toBeUndefined()
    expect(findWorktreeConfigFile(makeTemporaryDirectory())).toBeUndefined()
  })

  it('cwd を省略するとプロセスの作業ディレクトリ', async () => {
    await explains('worktree の設定ファイルを探す `findWorktreeConfigFile` のテストです。`cwd` を省略した場合に、プロセスの作業ディレクトリを起点にして設定ファイルのパスを返すことを確認します。')
    const { repository } = createProject()
    vi.spyOn(process, 'cwd').mockReturnValue(repository)
    expect(findWorktreeConfigFile()).toBe(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
  })

  it('git が存在しなければ OsError を投げる', async () => {
    await explains('worktree の設定ファイルを探す `findWorktreeConfigFile` のテストです。`PATH` に git が存在しない場合は、`OsError` が発生することを確認します。')
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(thrownError(() => findWorktreeConfigFile(process.cwd()))).toBeInstanceOf(OsError)
  })
})

describe('detectProjectRoot', () => {
  it('メインの worktree が base 直下にある場合は、プロジェクトのルートを返す', async () => {
    await explains('プロジェクトのルートを検出する `detectProjectRoot` のテストです。メインの worktree が `base/<repo>` にある場合は、その親のルートのパスを返すことを確認します。')
    const { repository, root } = createProject()
    expect(detectProjectRoot(repository)).toBe(root)
  })

  it('wt1 から呼んでも、main_wt が base/<repo> なら同じ root を返す', async () => {
    await explains('プロジェクトのルートを検出する `detectProjectRoot` のテストです。サブの worktree から呼んだ場合でも、メインの worktree が `base/<repo>` にあれば、同じルートのパスを返すことを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(detectProjectRoot(worktree)).toBe(root)
  })

  it('base 以外なら、現在・期待・理由・移行手順の 4 ブロックの文で WorktreeRuntimeError', async () => {
    await explains('プロジェクトのルートを検出する `detectProjectRoot` のテストです。メインの worktree が `base/` の下にない場合は、現在の場所・期待する場所・理由・移行手順を含む `WorktreeRuntimeError` が発生することを確認します。')
    const repository = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo'))
    const parent = path.dirname(repository)
    const expected = [
      'this repository is not placed in the layout pecot expects for a project',
      '',
      `  current: ${repository}`,
      `  expected: ${path.join(parent, 'base', 'myrepo')}`,
      '',
      'why base/ is needed:',
      '  the devcontainer mounts the parallel sets (wt1, wt2...) selectively, so base/ separates the resident set from the parallel sets',
      '',
      'migration steps (the cwd goes away, so close this CLI session first):',
      '  1. close this CLI session',
      '  2. in another terminal, run:',
      `       mkdir -p ${parent}/base`,
      `       mv ${repository} ${parent}/base/`,
      `  3. restart the CLI in ${parent}/base/myrepo/`,
    ].join('\n')
    expect(runtimeMessage(() => detectProjectRoot(repository))).toBe(expected)
  })

  it('メインの worktree のパスがシンボリックリンクでも、リンクを解決してから配置を判定する（偽の git）', async () => {
    await explains('プロジェクトのルートを検出する `detectProjectRoot` のテストです。偽の git が返すメインの worktree のパスがシンボリックリンクの場合に、リンクを解決した先の `base/<repo>` からルートを返すことを確認します。')
    const root = path.join(makeTemporaryDirectory(), 'workspaces')
    const real = path.join(root, 'base', 'myrepo')
    mkdirSync(real, { recursive: true })
    const alias = path.join(makeTemporaryDirectory(), 'alias')
    symlinkSync(real, alias)
    installFakeGit({ 'worktree list --porcelain': `worktree ${alias}\nHEAD abc1234\nbranch refs/heads/main\n` })
    expect(detectProjectRoot('.')).toBe(root)
  })
})

function projectOf(directories: readonly string[]): string {
  const root = makeTemporaryDirectory()
  for (const directory of directories) mkdirSync(path.join(root, directory), { recursive: true })
  return root
}

describe('getNextSetName', () => {
  it('wtN のセットが存在しなければ wt1 を返す', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wtN` のセットが 1 つも存在しない場合に、`wt1` を返すことを確認します。')
    expect(getNextSetName(projectOf([]), 'myrepo')).toBe('wt1')
  })

  it('プロジェクトのルートが存在しなくても wt1 を返す', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。プロジェクトのルートのディレクトリが存在しない場合でも、`wt1` を返すことを確認します。')
    const missing = path.join(makeTemporaryDirectory(), 'nonexistent')
    expect(getNextSetName(missing, 'myrepo')).toBe('wt1')
  })

  it('wt1/ があって wt1/myrepo が無ければ、wt1 に参加する', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1/` があって `wt1/myrepo` が存在しない場合に、既存の `wt1` に参加することを確認します。')
    expect(getNextSetName(projectOf(['wt1']), 'myrepo')).toBe('wt1')
  })

  it('wt1/myrepo が既にあって wt2/ が空なら、wt2 に参加する', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1/myrepo` が存在して `wt2/` が空の場合に、`wt2` に参加することを確認します。')
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2']), 'myrepo')).toBe('wt2')
  })

  it('全セットに対象のリポジトリが参加済みなら、最大の番号に 1 を足した新しいセットにする', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。すべてのセットに対象のリポジトリが参加済みの場合に、最大の番号に 1 を加算した `wt3` を返すことを確認します。')
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2/myrepo']), 'myrepo')).toBe('wt3')
  })

  it('参加できるセットが複数あれば、最小の番号のセットにする', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。参加できるセットが `wt1` と `wt3` の 2 つある場合に、小さい番号の `wt1` を返すことを確認します。')
    expect(getNextSetName(projectOf(['wt1', 'wt3']), 'myrepo')).toBe('wt1')
  })

  it('欠番は埋めない。wt1・wt3 が埋まっていれば wt4', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1` と `wt3` が埋まっていて `wt2` が欠番の場合に、欠番を埋めずに `wt4` を返すことを確認します。')
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt3/myrepo']), 'myrepo')).toBe('wt4')
  })

  it('番号に上限は存在せず、wt1 から wt9 に参加済みなら wt10 を返す', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1` から `wt9` まで参加済みの場合に、2 桁の `wt10` を返すことを確認します。')
    const directories = Array.from({ length: 9 }, (_unused, index) => `wt${String(index + 1)}/myrepo`)
    expect(getNextSetName(projectOf(directories), 'myrepo')).toBe('wt10')
  })

  it('base ディレクトリと wt でないディレクトリは無視する', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`base` や `foo`、`wt`、`wtx` のように `wtN` の形でないディレクトリがある場合に、数えずに `wt1` を返すことを確認します。')
    expect(getNextSetName(projectOf(['base', 'foo', 'wt', 'wtx']), 'myrepo')).toBe('wt1')
    expect(getNextSetName(projectOf(['foo', 'wt1']), 'myrepo')).toBe('wt1')
  })

  it('wt1 という名前のファイルは、セットとして数えない', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1` という名前がディレクトリでなくファイルの場合に、セットとして数えず `wt1` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeFileSync(path.join(root, 'wt1'), 'file')
    expect(getNextSetName(root, 'myrepo')).toBe('wt1')
  })

  it('リンク先が存在しない wt1 のシンボリックリンクは、セットとして数えない', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`wt1` がリンク先の存在しないシンボリックリンクの場合に、セットとして数えず `wt1` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    symlinkSync('/nonexistent/target', path.join(root, 'wt1'))
    expect(getNextSetName(root, 'myrepo')).toBe('wt1')
  })

  it('使用中として渡した番号には参加せず、次の番号にする', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`claimed` に `wt1` を渡した場合に、`wt1` のディレクトリがあっても避けて `wt2` を返すことを確認します。')
    expect(getNextSetName(projectOf(['wt1', 'wt2']), 'myrepo', { claimed: ['wt1'] })).toBe('wt2')
  })

  it('使用中として渡した番号だけでも、最大の番号が上がる', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`claimed` だけに番号がある場合でも、最大の番号として数えて次の番号を決めることを確認します。')
    expect(getNextSetName(projectOf([]), 'myrepo', { claimed: ['wt1'] })).toBe('wt2')
    expect(getNextSetName(projectOf(['wt1']), 'myrepo', { claimed: ['wt3'] })).toBe('wt1')
    expect(getNextSetName(projectOf(['wt1/myrepo']), 'myrepo', { claimed: ['wt3'] })).toBe('wt4')
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2/myrepo']), 'myrepo', { claimed: ['wt3'] })).toBe('wt4')
  })

  it('セット名の接頭辞を指定すると、その接頭辞で番号を付ける', async () => {
    await explains('次の worktree のセット名を決める `getNextSetName` のテストです。`prefix` に `ws` を指定した場合に、`ws1/myrepo` が存在すれば `ws2` を返すことを確認します。')
    expect(getNextSetName(projectOf(['ws1/myrepo']), 'myrepo', { prefix: 'ws' })).toBe('ws2')
  })
})

function projectWithSetup(setupCommand: string | undefined, timeout?: number): Project {
  const config: Record<string, unknown> = { version: 3, links: [] }
  if (setupCommand !== undefined) config['setup_command'] = setupCommand
  if (timeout !== undefined) config['setup_command_timeout'] = timeout
  return createProject({ worktreeConfig: JSON.stringify(config) })
}

async function addElsewhere(): Promise<{ readonly repository: string, readonly root: string, readonly elsewhere: string }> {
  const { repository, root } = createProject()
  const elsewhere = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
  const first = await createWorktree(repository, ignoredDiagnostics, { path: elsewhere, shouldCopy: false, shouldLink: false })
  expect(first.name).toBe('wt1')
  return { repository, root, elsewhere }
}

describe('createWorktree と番号の記録（実 git）', () => {
  it('作成した worktree の番号を、worktree の git のディレクトリに記録する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。作成する前は使用中の番号が存在せず、作成した後は worktree の番号 `wt1` を記録することを確認します。')
    const { repository, root } = createProject()
    expect(claimedSetNames(repository)).toEqual(new Set())
    const result = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
    const recordPath = gitForTest(result.path, ['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name']).trim()
    expect(readFileSync(recordPath, 'utf8')).toBe('wt1\n')
  })

  it('path を指定して作成した worktree があっても、次の作成では wt2 を選ぶ', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`path` を指定して作成した `wt1` がある場合に、次の作成で `wt2` が選ばれることを確認します。')
    const { repository, root } = await addElsewhere()
    const second = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(second.name).toBe('wt2')
    expect(second.path).toBe(path.join(root, 'wt2', 'myrepo'))
  })

  it('path を指定して作成した worktree が機能ブランチに移った後も、wt1 を再び選ばない', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`path` を指定して作成した `wt1` が別のブランチに切り替わった後でも、`wt1` が使用中として扱われ `wt2` が選ばれることを確認します。')
    const { repository, elsewhere } = await addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    const { name } = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(name).toBe('wt2')
  })

  it('番号の記録が存在しなくても、wtN のブランチを使っている worktree はその番号を使用中にする', async () => {
    await explains('worktree の番号を求める `claimedSetNames` のテストです。記録がなくても `wt1` のブランチを使っている worktree がある場合に、`wt1` を使用中として扱い、次は `wt2` を作成することを確認します。')
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(makeTemporaryDirectory(), 'x', 'myrepo')])
    expect(claimedSetNames(repository)).toEqual(new Set(['wt1']))
    const created = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(created.path).toBe(path.join(root, 'wt2', 'myrepo'))
  })

  it('claimedSetNames は、プロセスの作業ディレクトリが変わっても結果が変わらない', async () => {
    await explains('使用中の番号を求める `claimedSetNames` のテストです。プロセスの作業ディレクトリを別の場所に変えた場合でも、引数のリポジトリを基準に同じ結果を返すことを確認します。')
    vi.restoreAllMocks()
    const { repository } = await addElsewhere()
    const original = process.cwd()
    process.chdir(makeTemporaryDirectory())
    try {
      expect(claimedSetNames(repository)).toEqual(new Set(['wt1']))
    }
    finally {
      process.chdir(original)
    }
  })
})

describe('createWorktree（実 git・実ファイル）', () => {
  it('name を省略すると、プロジェクトのルートを基準に番号を決め、起点を develop_branch にする', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`name` を省略した場合に、プロジェクトのルートを基準にした番号の `wt2` を選び、起点のブランチに `develop` を使うことを確認します。')
    const { repository, root } = createProject()
    mkdirSync(path.join(root, 'wt1', 'myrepo'), { recursive: true })
    const result = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(result.name).toBe('wt2')
    expect(result.path).toBe(path.join(root, 'wt2', 'myrepo'))
    expect(result.baseBranch).toBe('develop')
  })

  it('別のリポジトリが作った wt1 に対象のリポジトリが未参加なら、wt1 に参加する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`wt1/` に別のリポジトリだけがある場合に、`wt1` に参加することを確認します。')
    const { repository, root } = createProject()
    mkdirSync(path.join(root, 'wt1', 'myrepo-B'), { recursive: true })
    const { name } = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(name).toBe('wt1')
  })

  it('path を指定すると、その場所に worktree を作成する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`path` を指定した場合に、指定した場所に worktree を作成し、ブランチ名が `wt1` になることを確認します。')
    const { repository } = createProject()
    const target = path.join(makeTemporaryDirectory(), 'custom', 'dir')
    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', path: `${target}/`, shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(target)
    expect(gitForTest(target, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
  })

  it('新しいブランチは、起点のブランチの origin を追跡する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。新しいブランチを作成した場合に、起点のブランチの `origin/develop` を追跡することを確認します。')
    const { repository, root } = createProject()
    const result = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim()).toBe('origin/develop')
    expect(result.setupResult).toBeUndefined()
  })

  it('--base を指定すれば develop_branch が未設定でも作成でき、未設定のまま省略するとエラーになる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。リポジトリに `develop_branch` が未設定の場合に、`baseBranch` を省略するとエラーを返し、指定すれば作成できることを確認します。')
    const { repository } = createProject({ repositories: [{ owner: 'myowner', name: 'myrepo' }] })
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false }))
    expect(error.message).toBe([
      'develop_branch is not set for repository myowner/myrepo',
      '  add develop_branch to repositories in the project config file',
      '  or pass base explicitly',
    ].join('\n'))
    expect(error.failure).toBe('repo-setting-missing')
    const { baseBranch } = await createWorktree(repository, ignoredDiagnostics, { baseBranch: 'main', shouldCopy: false, shouldLink: false })
    expect(baseBranch).toBe('main')
  })

  it('base_branch が空の場合は、origin を追跡せず現在のコミットから作成する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`baseBranch` に空文字を指定した場合に、現在のコミットから作成し、上流のブランチを設定しないことを確認します。')
    const { repository } = createProject()
    const result = await createWorktree(repository, ignoredDiagnostics, { baseBranch: '', shouldCopy: false, shouldLink: false })
    expect(gitForTest(result.path, ['rev-parse', 'HEAD']).trim()).toBe(branchCommit(repository, 'main'))
    expect(thrownError(() => gitForTest(result.path, ['rev-parse', '@{upstream}']))).toBeInstanceOf(Error)
  })

  it('既存ブランチの上流が develop_branch と異なる場合は、WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。既存のブランチの上流が `origin/develop` と異なる場合に、`allow_existing_branch` を案内する例外が発生することを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    const message = await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false }))
    expect(message).toBe('branch \'wt1\' already exists and its upstream differs from the expected one (current: origin/main, expected: origin/develop): pass allow_existing_branch: true to reuse it')
  })

  it('上流が存在しない既存ブランチは、（unset）と表示する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。上流が設定されていない既存のブランチを指定した場合に、エラーの文が現在の上流を `(unset)` と表示することを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', 'wt1', 'main'])
    expect(await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' }))).toContain('(current: (unset), expected: origin/develop)')
  })

  it('base が空で上流のあるブランチは、期待する上流が None の不一致として扱う', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`baseBranch` が空で、既存のブランチに上流がある場合に、期待する上流を `None` としたエラーになることを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    expect(await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: '' }))).toContain('(current: origin/main, expected: None)')
  })

  it('上流が存在しない既存ブランチは、base が空の場合にそのまま再利用する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。上流のない既存のブランチを `baseBranch` が空で指定した場合に、そのブランチで worktree を作成することを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', 'wt1', 'main'])
    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: '', shouldLink: false, shouldCopy: false })
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
  })

  it('--allow-existing-branch を指定すれば、上流が異なる既存ブランチでも worktree を作成する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`isExistingBranchAllowed` を指定した場合に、上流が異なる既存のブランチでも、そのブランチと上流のままで作成することを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false, isExistingBranchAllowed: true })
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim()).toBe('origin/main')
  })

  it('どの worktree にも使われていない孤児ブランチは、削除して作り直す', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。上流が一致し、どの worktree にも使われていない既存のブランチの場合に、ブランチを削除して起点から作り直し、古いコミットが残らないことを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/develop'])
    gitForTest(repository, ['checkout', '-q', 'wt1'])
    writeFileSync(path.join(repository, 'stale.txt'), 'stale')
    gitForTest(repository, ['add', 'stale.txt'])
    gitForTest(repository, ['commit', '-q', '-m', 'stale'])
    gitForTest(repository, ['checkout', '-q', 'main'])

    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false })
    expect(branchCommit(result.path, 'HEAD')).toBe(branchCommit(repository, 'origin/develop'))
    expect(existsSync(path.join(result.path, 'stale.txt'))).toBe(false)
  })

  it('--allow-existing-branch を指定すれば、孤児ブランチを削除せず再利用する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`isExistingBranchAllowed` を指定した場合に、孤児ブランチを削除せず、そのブランチのコミットを残したまま worktree を作成することを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/develop'])
    gitForTest(repository, ['checkout', '-q', 'wt1'])
    writeFileSync(path.join(repository, 'kept.txt'), 'kept')
    gitForTest(repository, ['add', 'kept.txt'])
    gitForTest(repository, ['commit', '-q', '-m', 'kept'])
    gitForTest(repository, ['checkout', '-q', 'main'])

    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false, isExistingBranchAllowed: true })
    expect(existsSync(path.join(result.path, 'kept.txt'))).toBe(true)
  })

  it('他の worktree で使用中のブランチは削除せず、git が拒否した WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。ブランチが他の worktree で使用中の場合に、ブランチを削除せずに `WorktreeRuntimeError` が発生することを確認します。')
    const { repository, root } = createProject()
    const other = path.join(root, 'other', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '--track', '-b', 'wt1', other, 'origin/develop'])
    const message = await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false }))
    expect(message).toMatch(/^failed to create the worktree: [\s\S]*fatal: 'wt1' is already (checked out|used by worktree)/u)
    expect(branchCommit(repository, 'wt1')).toBe(branchCommit(repository, 'origin/develop'))
    expect(existsSync(other)).toBe(true)
  })

  it('孤児ブランチでも上流が異なる場合は、不一致のエラーを先に返し、ブランチを削除しない', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。孤児ブランチの上流が期待と異なる場合に、上流の不一致のエラーが発生し、ブランチは削除されないことを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    expect(await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' }))).toContain('upstream differs from the expected one')
    expect(branchCommit(repository, 'wt1')).toBe(branchCommit(repository, 'main'))
  })

  it('コンテナーの再構築後に残った古い worktree のメタデータは、prune してから再作成する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。ディレクトリだけが削除されて古いメタデータが残っている場合に、`git worktree prune` で整理してから同じ場所に再作成することを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '--track', '-b', 'wt1', worktree, 'origin/develop'])
    const metadata = path.join(repository, '.git', 'worktrees', 'myrepo')
    expect(existsSync(metadata)).toBe(true)
    // 実体だけ消して stale にする
    rmSync(worktree, { recursive: true })
    expect(existsSync(metadata)).toBe(true)

    const result = await createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false, isExistingBranchAllowed: true })
    expect(result.name).toBe('wt1')
    expect(result.path).toBe(worktree)
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(metadata)).toBe(true)
  })

  it('メインの worktree が base/ の下に存在しなければ、WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。メインの worktree が `base/` の下にない場合は、配置が期待と異なることを示す `WorktreeRuntimeError` が発生することを確認します。')
    const repository = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo'))
    expect(await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics))).toContain('this repository is not placed in the layout pecot expects for a project')
  })

  it('worktree-config.json が存在しなければ、init を案内するエラーを返す', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`worktree-config.json` が存在しない場合に、`worktree_init` を案内し、失敗の種別 `not-initialized` を返すことを確認します。')
    const { repository } = createProject()
    rmSync(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics))
    expect(error.message).toBe('worktree config not found: .pecot/config/worktree-config.json\n  call worktree_init to generate the template')
    expect(error.failure).toBe('not-initialized')
  })

  it('.worktreeignore が存在しなければ、init を案内するエラーを返す', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`.worktreeignore` が存在しない場合に、`worktree_init` を案内し、失敗の種別 `not-initialized` を返すことを確認します。')
    const { repository } = createProject()
    rmSync(path.join(repository, '.pecot', 'config', '.worktreeignore'))
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics))
    expect(error.message).toBe('copy exclude config not found: .pecot/config/.worktreeignore\n  call worktree_init to generate the template')
    expect(error.failure).toBe('not-initialized')
  })

  it('origin が存在しなければ、WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。git の remote に `origin` が存在しない場合は、リポジトリ情報を取得できないエラーを返し、失敗の種別が `git-unresolved` になることを確認します。')
    const { repository } = createProject()
    gitForTest(repository, ['remote', 'remove', 'origin'])
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics))
    expect(error.message).toBe('cannot get the repository information: check that a git remote is set to a GitHub repository URL')
    expect(error.failure).toBe('git-unresolved')
  })

  it('origin の owner が不正な名前でも、WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`origin` の URL の owner が不正な名前の場合に、リポジトリ情報を取得できないという `WorktreeRuntimeError` が発生することを確認します。')
    const { repository } = createProject({ originUrl: 'https://github.com/bad%20owner/myrepo.git' })
    expect(await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics))).toBe('cannot get the repository information: check that a git remote is set to a GitHub repository URL')
  })

  it('.active が存在しなくても、remote のリポジトリを含む設定で作成する', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`.active` が存在しない場合でも、remote のリポジトリを含むプロジェクト設定が 1 つなら、その設定で作成できることを確認します。')
    const { repository, configRoot } = createProject()
    rmSync(path.join(configRoot, '.pecot', 'config', 'projects', '.active'))
    const { branch } = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
    expect(branch).toBe('wt1')
  })

  it('remote のリポジトリを含む設定が 2 つあって選べなければ、候補と project の案内を出して止まる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。remote のリポジトリを含む設定が 2 つあり `.active` もない場合に、候補を並べて `project` を案内するエラーを返し、`project` を指定すれば作成できることを確認します。')
    const { repository, configRoot } = createProject()
    const projects = path.join(configRoot, '.pecot', 'config', 'projects')
    rmSync(path.join(projects, '.active'))
    writeTree(configRoot, { '.pecot/config/projects/github.com_myowner_2.json': projectConfigJson(DEFAULT_REPOSITORIES) })
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', shouldCopy: false, shouldLink: false }))
    expect(error.message).toBe('myowner/myrepo is in 2 project configs\nchoose one with project: <NAME>\navailable: github.com_myowner_1, github.com_myowner_2')
    expect(error.failure).toBe('no-active-project')
    const { branch } = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false, project: 'github.com_myowner_2' })
    expect(branch).toBe('wt1')
  })

  it('remote のリポジトリを含む設定が存在しなければ、どの設定にもないことと、あるものの名前を示す', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。remote のリポジトリがどのプロジェクト設定にも含まれない場合に、そのことと既存の設定名を示すエラーを返し、失敗の種別が `repo-not-in-project` になることを確認します。')
    const { repository } = createProject({ repositories: [{ owner: 'foo', name: 'bar' }, { owner: 'foo', name: 'baz' }] })
    const expected = 'myowner/myrepo is not in any project config\navailable: github.com_myowner_1'
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }))
    expect(error.message).toBe(expected)
    expect(error.failure).toBe('repo-not-in-project')
  })

  it('シンボリックリンクとして登録済みのファイルは、未追跡ファイルのコピーから除く', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`links` に登録したファイルがある場合に、そのファイルはコピーせずリンクにし、ほかの未追跡ファイルだけをコピーすることを確認します。')
    const files = { 'README.md': 'x', '.gitignore': '.env\n.claude/\n' }
    const worktreeConfig = JSON.stringify({ version: 3, links: [{ path: '.claude/settings.local.json', target_repo: 'shared-repo', target_path: '.claude/settings.local.json' }] })
    const { repository, root } = createProject({ files, worktreeConfig })
    writeTree(path.join(root, 'base', 'shared-repo'), { '.claude/settings.local.json': '{}' })
    writeTree(repository, { '.claude/settings.local.json': 'main-content', '.env': 'FOO=bar\n' })

    const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' })

    const copied = result.copiedFiles.filter(item => item.action === 'copied').map(item => path.basename(item.source))
    expect(copied).toContain('.env')
    expect(copied).not.toContain('settings.local.json')
    expect(readFileSync(path.join(result.path, '.env'), 'utf8')).toBe('FOO=bar\n')
    const symlink = path.join(result.path, '.claude', 'settings.local.json')
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true)
    expect(readFileSync(symlink, 'utf8')).toBe('{}')
    expect(result.linkedFiles.map(item => item.action)).toEqual(['created'])
  })

  it('.worktreeignore に該当する未追跡ファイルは、コピーしない', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`.worktreeignore` に該当する未追跡ファイルだけがある場合に、コピーせず、コピー結果が空になることを確認します。')
    const { repository } = createProject({ files: { 'README.md': 'x', '.gitignore': '__pycache__/\n' }, ignoreContent: '__pycache__/\n' })
    writeTree(repository, { '__pycache__/a.pyc': 'x' })
    const result = await createWorktree(repository, ignoredDiagnostics, { shouldLink: false })
    expect(result.copiedFiles).toEqual([])
    expect(existsSync(path.join(result.path, '__pycache__'))).toBe(false)
  })

  it('.worktreeignore に不正なパターンがあれば、GitIgnorePatternError をそのまま伝える', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`.worktreeignore` に感嘆符だけの不正なパターンがある場合に、`GitIgnorePatternError` をそのまま伝えることを確認します。')
    const { repository } = createProject({ ignoreContent: '!\n' })
    await expect(createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })).rejects.toBeInstanceOf(GitIgnorePatternError)
  })

  it('worktree-config.json を読み込めなければ、OsError をそのまま伝える', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`worktree-config.json` がディレクトリで読み込めない場合に、`OsError` をそのまま伝えることを確認します。')
    const { repository } = createProject()
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    rmSync(configPath)
    mkdirSync(configPath)
    await expect(createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })).rejects.toBeInstanceOf(OsError)
  })

  it('不正な JSON の worktree-config.json は、worktree を作成した後に WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`worktree-config.json` が不正な JSON の場合に、worktree の作成後に設定の読み込みに失敗した `WorktreeRuntimeError` が発生することを確認します。')
    const { repository, root } = createProject({ worktreeConfig: '{ this is not valid json' })
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    const error = await asyncRuntimeError(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }))
    const { message } = error
    expect(error.failure).toBe('config-invalid')
    expect(message.startsWith(`failed to load the worktree config: ${configPath}: JSON parse error: ${configPath}: `)).toBe(true)
    expect(message.endsWith('\n  fix the config file and call it again')).toBe(true)
    expect(existsSync(path.join(root, 'wt1', 'myrepo'))).toBe(true)
  })

  it('スキーマに違反する worktree-config.json は、pydantic と同じ形式の検証エラーの文を含む', async () => {
    await explains('worktree を作成する `createWorktree` のテストです。`worktree-config.json` の `version` がスキーマに違反する場合は、pydantic と同じ形式の検証エラーの文を含むエラーが発生することを確認します。')
    const { repository } = createProject({ worktreeConfig: '{"version": 2}' })
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    const message = await asyncRuntimeMessage(async () => await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }))
    const head = `failed to load the worktree config: ${configPath}: config file validation failed: ${configPath}`
    expect(message).toContain(`${head}: 1 validation error for WorktreeConfig\nversion\n  Input should be 3`)
  })

  describe('setup_command', () => {
    it('引数の setup は config の setup_command より優先し、worktree のルートで実行する', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。引数で指定したコマンドと設定ファイルのコマンドがある場合に、引数のコマンドを worktree のルートで実行することを確認します。')
      const { repository } = projectWithSetup('echo from-config')
      const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo from-cli; pwd', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toEqual({ command: 'echo from-cli; pwd', exitCode: 0, stdout: `from-cli\n${result.path}\n`, stderr: '' })
    })

    it('引数で指定しなければ、config の setup_command を使う', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。引数でコマンドを指定しない場合に、設定ファイルの `setup_command` を実行することを確認します。')
      const { repository } = projectWithSetup('echo from-config')
      const result = await createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toEqual({ command: 'echo from-config', exitCode: 0, stdout: 'from-config\n', stderr: '' })
    })

    it('引数と config の両方にコマンドが存在しない場合や、空文字の setup_command は、実行しない', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。コマンドが指定されていない場合と空文字の場合に、どちらも実行せず結果が `undefined` になることを確認します。')
      const none = projectWithSetup(undefined)
      const { setupResult: noneResult } = await createWorktree(none.repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(noneResult).toBeUndefined()
      const empty = projectWithSetup('')
      const { setupResult: emptyResult } = await createWorktree(empty.repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(emptyResult).toBeUndefined()
    })

    it('config の setup_command_timeout を超えると exitCode -1 の結果になる', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。コマンドが `setup_command_timeout` を超えた場合に、終了コードが `-1` の結果を返し、タイムアウトの警告を出力することを確認します。')
      const { repository } = projectWithSetup('sleep 5', 1)
      const recorded = recordDiagnostics()
      const result = await createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toMatchObject({ command: 'sleep 5', exitCode: -1, stderr: 'timeout after 1 seconds' })
      expect(recorded.lines).toEqual(['warning: setup command timed out: sleep 5\nerr: timeout after 1 seconds'])
    })

    it('setup_command が 0 以外で終了しても例外を投げず、結果と警告を残す', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。コマンドが 0 以外の終了コードで終了した場合に、例外にせず、終了コードと標準エラー出力を含む結果と警告を返すことを確認します。')
      const { repository } = projectWithSetup(undefined)
      const recorded = recordDiagnostics()
      const result = await createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo boom >&2; exit 42', shouldCopy: false, shouldLink: false })
      const root = path.dirname(path.dirname(repository))
      expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
      expect(result.setupResult).toMatchObject({ exitCode: 42, stderr: 'boom\n' })
      expect(recorded.lines).toEqual(['warning: setup command failed (exit 42): echo boom >&2; exit 42\nerr: boom'])
    })

    it('標準出力と標準エラー出力が両方あれば、警告に out と err の行を続ける', async () => {
      await explains('worktree の作成後に実行するセットアップコマンドのテストです。コマンドが標準出力と標準エラー出力の両方を出力して失敗した場合に、警告に `out:` と `err:` の行が続くことを確認します。')
      const { repository } = projectWithSetup(undefined)
      const recorded = recordDiagnostics()
      await createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo hi; echo oops >&2; exit 42', shouldCopy: false, shouldLink: false })
      expect(recorded.lines).toEqual(['warning: setup command failed (exit 42): echo hi; echo oops >&2; exit 42\nout: hi\nerr: oops'])
    })
  })
})

function projectWithWorktree(): { readonly repository: string, readonly root: string, readonly worktree: string } {
  const { repository, root } = createProject()
  const worktree = path.join(root, 'wt1', 'myrepo')
  gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
  return { repository, root, worktree }
}

describe('removeWorktree', () => {
  it('worktree とブランチを削除し、空になった <root>/<name>/ も削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。worktree を名前で削除した場合に、worktree とブランチが削除され、空になった `<root>/<name>/` も削除されることを確認します。')
    const { repository, root, worktree } = projectWithWorktree()
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
  })

  it('ブランチ wt1 が存在しない worktree を名前で削除すると、ブランチを削除できなかった理由を返す', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。名前が `wt1` の worktree が別のブランチに移り、ブランチ `wt1` が存在しない場合に、worktree は削除し、ブランチを削除できなかった理由を返すことを確認します。')
    const { repository, elsewhere } = await addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    gitForTest(repository, ['branch', '-D', 'wt1'])
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toMatch(/wt1/u)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('他のリポジトリの worktree が残っていれば、<root>/<name>/ は削除しない', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。同じセットに別のリポジトリの worktree が残っている場合に、`<root>/<name>/` のディレクトリを削除せずに残すことを確認します。')
    const { repository, root } = projectWithWorktree()
    mkdirSync(path.join(root, 'wt1', 'other-repo'))
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(path.join(root, 'wt1', 'other-repo'))).toBe(true)
  })

  it('shouldKeepBranch を指定すれば、ブランチを残して undefined を返す', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。`shouldKeepBranch` を指定した場合に、ブランチを削除せずに残し、戻り値が `undefined` になることを確認します。')
    const { repository } = projectWithWorktree()
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics, { shouldKeepBranch: true })).toBeUndefined()
    expect(gitForTest(repository, ['branch', '--list', 'wt1']).trim()).toBe('wt1')
  })

  it('未コミットの変更があれば削除を拒否し、isForced を指定すれば削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。変更が未コミットの worktree を削除しようとした場合に、`WorktreeRuntimeError` で拒否され、`isForced` を指定すると削除できることを確認します。')
    const { repository, worktree } = projectWithWorktree()
    writeFileSync(path.join(worktree, 'README.md'), 'dirty')
    expect(runtimeMessage(() => {
      removeWorktree(repository, 'wt1', ignoredDiagnostics)
    })).toMatch(/^failed to remove the worktree: fatal: '.*' contains modified or untracked files, use --force to delete it/u)
    expect(existsSync(worktree)).toBe(true)
    removeWorktree(repository, 'wt1', ignoredDiagnostics, { isForced: true })
    expect(existsSync(worktree)).toBe(false)
  })

  it('存在しない worktree の名前を渡すと、WorktreeRuntimeError を投げる', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。存在しない worktree の名前を渡した場合に、`worktree not found` を示す `WorktreeRuntimeError` が発生することを確認します。')
    const { repository } = projectWithWorktree()
    expect(runtimeMessage(() => {
      removeWorktree(repository, 'nope', ignoredDiagnostics)
    })).toBe('worktree not found: nope')
  })

  it('記録した名前を渡すと、機能ブランチに移した path 指定の worktree と wt1 ブランチを削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。`path` を指定して作成し機能ブランチに移した worktree を、記録された名前の `wt1` で削除した場合に、worktree とブランチ `wt1` が削除され、機能ブランチは残ることを確認します。')
    const { repository, elsewhere } = await addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
    expect(gitForTest(repository, ['branch', '--list', 'feature/x']).trim()).toBe('feature/x')
  })

  it('記録が存在しない worktree は、機能ブランチに移っていても置き場所で見つけて削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。番号の記録がなく機能ブランチに移った worktree を見つけ、worktree とブランチ `wt1` を削除し、機能ブランチは残すことを確認します。')
    const { repository, root, worktree } = projectWithWorktree()
    gitForTest(worktree, ['switch', '-q', '-c', 'feature/x'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
    expect(gitForTest(repository, ['branch', '--list', 'feature/x']).trim()).toBe('feature/x')
  })

  // 一覧の並びは git の管理ディレクトリの読み順で決まるので、どちらを先に作っても記録の方を消すことを確かめる
  it.for([{ order: '記録の worktree を先に作る', isHolderFirst: false }, { order: 'ブランチ wt1 の worktree を先に作る', isHolderFirst: true }])('$order と、記録が wt1 の worktree を削除し、ブランチ wt1 の別の worktree を残す', async ({ order, isHolderFirst }) => {
    await explains(`worktree を削除する \`removeWorktree\` のテストです。${order}場合に、記録の名前が \`wt1\` の worktree を削除し、ブランチ \`wt1\` に切り替えた別の worktree を削除せず残すことを確認します。`)
    const { repository, root } = createProject()
    const holder = path.join(makeTemporaryDirectory(), 'holder', 'myrepo')
    if (isHolderFirst) gitForTest(repository, ['worktree', 'add', '-q', '-b', 'tmp', holder])
    const recorded = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    const { name } = await createWorktree(repository, ignoredDiagnostics, { path: recorded, shouldCopy: false, shouldLink: false })
    expect(name).toBe('wt1')
    if (!isHolderFirst) gitForTest(repository, ['worktree', 'add', '-q', '-b', 'tmp', holder])
    gitForTest(recorded, ['switch', '-q', '-c', 'feature/x'])
    gitForTest(holder, ['switch', '-q', 'wt1'])
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toMatch(/used by worktree/u)
    expect(existsSync(recorded)).toBe(false)
    expect(existsSync(holder)).toBe(true)
    expect(existsSync(root)).toBe(true)
  })

  it('detached HEAD の worktree も、記録した名前で削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。HEAD を切り離した worktree を、記録された名前の `wt1` で削除した場合に、その worktree が削除されることを確認します。')
    const { repository, elsewhere } = await addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '--detach'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('別の worktree のディレクトリが消えていても、wt1 を削除できる', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。別の worktree のディレクトリが先に削除されている場合でも、`wt1` を削除できることを確認します。')
    const { repository, elsewhere } = await addElsewhere()
    const other = path.join(makeTemporaryDirectory(), 'other', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'other', other])
    rmSync(other, { recursive: true })
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('base とメインのブランチ名を渡すと、メインの worktree を残して worktree not found になる', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。名前に `base` や `main` を渡した場合は、`WorktreeRuntimeError` が発生し、メインの worktree が残ることを確認します。')
    const { repository } = projectWithWorktree()
    for (const name of ['base', 'main']) {
      expect(runtimeMessage(() => {
        removeWorktree(repository, name, ignoredDiagnostics)
      })).toBe(`worktree not found: ${name}`)
    }
    expect(existsSync(repository)).toBe(true)
  })

  it('wtN の形でない名前のブランチを渡すと、その worktree とブランチを削除する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。`feature/z` のように `wtN` の形でないブランチ名を渡した場合に、その worktree とブランチが削除されることを確認します。')
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'z', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'feature/z', worktree])
    removeWorktree(repository, 'feature/z', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'feature/z'])).toBe('')
  })

  it('削除した worktree の中から呼ぶと、掃除の git が作業ディレクトリを失って OsError になる', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。削除する worktree の中のパスを渡した場合に、削除後の後処理で作業ディレクトリが失われ、`OsError` が発生することを確認します。')
    const { worktree } = projectWithWorktree()
    expect(thrownError(() => {
      removeWorktree(worktree, 'wt1', ignoredDiagnostics)
    })).toBeInstanceOf(OsError)
    expect(existsSync(worktree)).toBe(false)
  })

  it('ブランチを残す場合も、削除した worktree の中から呼ぶと、ルートの検出で OsError になる', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。`shouldKeepBranch` を指定して削除する worktree の中のパスを渡した場合に、プロジェクトのルートの検出で `OsError` が発生することを確認します。')
    const { worktree } = projectWithWorktree()
    expect(thrownError(() => {
      removeWorktree(worktree, 'wt1', ignoredDiagnostics, { shouldKeepBranch: true })
    })).toBeInstanceOf(OsError)
  })

  it('base/ の配置でない場合は、ディレクトリの掃除を省いて正常終了する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。メインの worktree が `base/` の下にない場合は、セットのディレクトリの掃除を省いて worktree を削除し、正常に終了することを確認します。')
    const repository = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo'))
    const worktree = path.join(path.dirname(path.dirname(repository)), 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('空のディレクトリを削除できなければ、警告を出力して正常終了する', async () => {
    await explains('worktree を削除する `removeWorktree` のテストです。ルートが書き込み不可で空のセットのディレクトリを削除できない場合に、例外にせず、権限エラーを含む警告を出力することを確認します。')
    const { repository, root } = projectWithWorktree()
    const recorded = recordDiagnostics()
    // root は書き込み不可にしても、WT の削除（root/wt1 の中）は通る。root/wt1 自体の rmdir だけ失敗する
    chmodSync(root, 0o555)
    try {
      removeWorktree(repository, 'wt1', recorded.diagnostics)
    }
    finally {
      chmodSync(root, 0o755)
    }
    expect(recorded.lines[0]?.startsWith(`warning: failed to remove the set directory: ${path.join(root, 'wt1')}: [Errno 13] Permission denied`)).toBe(true)
  })
})

describe('getUntrackedFiles', () => {
  it('git の管理外（gitignored）のファイルを、相対パスで返す', async () => {
    await explains('git の管理外のファイルを取得する `getUntrackedFiles` のテストです。`.gitignore` に該当するファイルがある場合に、リポジトリからの相対パスで返し、通常の未追跡ファイルを含めないことを確認します。')
    const repository = createGitRepository({ 'README.md': 'x', '.gitignore': '.env\nconfig/local.json\n' })
    writeTree(repository, { '.env': 'a', 'config/local.json': 'b', 'tracked-not.txt': 'c' })
    expect(getUntrackedFiles(repository)).toEqual(['.env', 'config/local.json'])
  })

  it('該当するファイルが存在しない場合と git の外の場合は、空の一覧を返す', async () => {
    await explains('git の管理外のファイルを取得する `getUntrackedFiles` のテストです。管理外のファイルが存在しない場合と git リポジトリの外の場合に、どちらも空の一覧を返すことを確認します。')
    expect(getUntrackedFiles(createGitRepository())).toEqual([])
    expect(getUntrackedFiles(makeTemporaryDirectory())).toEqual([])
  })
})

describe('filterCopyableFiles', () => {
  it('除外パターンに該当するファイルを除く', async () => {
    await explains('コピーできるファイルを絞り込む `filterCopyableFiles` のテストです。除外パターンに該当するファイルがある場合に、`.git/` や `node_modules/` の下のファイルを除き、`.env` などだけを残すことを確認します。')
    const spec = compileGitIgnoreSpec(['.git/', '__pycache__/', '*.pyc', 'node_modules/'])
    const files = ['.env', '.git/config', '__pycache__/foo.pyc', 'src/app.py', 'node_modules/pkg/index.js']
    expect(filterCopyableFiles(files, spec)).toEqual(['.env', 'src/app.py'])
  })

  it('既定の .worktreeignore は、除外対象の 18 項目をすべて除く', async () => {
    await explains('コピーできるファイルを絞り込む `filterCopyableFiles` のテストです。既定の `.worktreeignore` で除外する 18 項目のファイルを渡した場合に、すべて除かれて空になることを確認します。')
    const spec = compileGitIgnoreSpec(DEFAULT_WORKTREEIGNORE_CONTENT.split('\n'))
    const excluded = [
      '.git/config', '__pycache__/foo.pyc', 'foo.pyc', 'foo.pyo', '.venv/bin/python', 'venv/lib/x.so', 'myproj.egg-info/PKG-INFO',
      '.pytest_cache/CACHEDIR.TAG', '.mypy_cache/3.13/foo', '.ruff_cache/0.9.0', '.tox/py312/bin', 'htmlcov/index.html', '.coverage',
      'dist/foo.whl', 'build/lib/x.py', 'node_modules/pkg/index.js', '.pecot/config/worktree-config.json', 'tmp/scratch.txt',
    ]
    expect(filterCopyableFiles(excluded, spec)).toEqual([])
  })

  it('否定パターンを指定すると、特定のサブパスを除外から外す', async () => {
    await explains('コピーできるファイルを絞り込む `filterCopyableFiles` のテストです。`.nx/` を除外し `!.nx/version-plans/` で除外から外した場合に、`.nx/version-plans/` の下のファイルだけを残すことを確認します。')
    const spec = compileGitIgnoreSpec(['.nx/', '!.nx/version-plans/'])
    expect(filterCopyableFiles(['.nx/workspace-data/cache.db', '.nx/version-plans/my-plan.md'], spec)).toEqual(['.nx/version-plans/my-plan.md'])
  })

  it('空の除外パターンでは、すべてのファイルを残す', async () => {
    await explains('コピーできるファイルを絞り込む `filterCopyableFiles` のテストです。除外パターンが空の場合に、渡したファイルをすべて残すことを確認します。')
    const files = ['.git/HEAD', '__pycache__/x.pyc', '.venv/bin/python', 'node_modules/pkg/index.js', 'src/main.py']
    expect(filterCopyableFiles(files, compileGitIgnoreSpec([]))).toEqual(files)
  })
})

describe('isWorktreeEnvironment', () => {
  it('メインの worktree では false、サブの worktree では true を返す（実 git）', async () => {
    await explains('サブの worktree かどうかを判定する `isWorktreeEnvironment` のテストです。メインの worktree のパスでは `false`、サブの worktree のパスでは `true` を返すことを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(isWorktreeEnvironment(repository)).toBe(false)
    expect(isWorktreeEnvironment(worktree)).toBe(true)
  })

  it('サブディレクトリでは、相対パスをプロセスの作業ディレクトリ基準で解決する（Python と同じ挙動）', async () => {
    await explains('サブの worktree かどうかを判定する `isWorktreeEnvironment` のテストです。サブディレクトリを渡した場合に、git が返す相対パスをプロセスの作業ディレクトリで解決するため、メインの worktree でも `true` になることを確認します。')
    const { repository, root } = createProject({ files: { 'sub/a.txt': 'x' } })
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    // git-dir は絶対パス、git-common-dir は ../.git になり、解決先が食い違うのでメイン WT のサブディレクトリでも true になる
    expect(isWorktreeEnvironment(path.join(repository, 'sub'))).toBe(true)
    expect(isWorktreeEnvironment(path.join(worktree, 'sub'))).toBe(true)
  })

  it('git リポジトリの外では、WorktreeRuntimeError を投げる', async () => {
    await explains('サブの worktree かどうかを判定する `isWorktreeEnvironment` のテストです。git リポジトリの外で実行した場合に、git の標準エラー出力を含む `WorktreeRuntimeError` が発生することを確認します。')
    expect(runtimeMessage(() => isWorktreeEnvironment(makeTemporaryDirectory()))).toMatch(/^not a git repository: fatal: not a git repository/u)
  })

  it('git が存在しなければ、WorktreeRuntimeError でなく OsError を投げる', async () => {
    await explains('サブの worktree かどうかを判定する `isWorktreeEnvironment` のテストです。`PATH` に git が存在しない場合は、`WorktreeRuntimeError` ではなく `OsError` が発生することを確認します。')
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(thrownError(() => isWorktreeEnvironment('.'))).toBeInstanceOf(OsError)
  })
})

describe('getWorktreeDirectories', () => {
  it('メインを除いた、サブの worktree のパスを返す', async () => {
    await explains('サブの worktree のパスを取得する `getWorktreeDirectories` のテストです。サブの worktree が 2 つある場合に、メインの worktree を含めず、2 つのパスだけを返すことを確認します。')
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(root, 'wt1', 'myrepo')])
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt2', path.join(root, 'wt2', 'myrepo')])
    expect(getWorktreeDirectories(repository)).toEqual([path.join(root, 'wt1', 'myrepo'), path.join(root, 'wt2', 'myrepo')])
  })

  it('メインの worktree だけなら、空の一覧を返す', async () => {
    await explains('サブの worktree のパスを取得する `getWorktreeDirectories` のテストです。メインの worktree だけがある場合に、空の一覧を返すことを確認します。')
    expect(getWorktreeDirectories(createProject().repository)).toEqual([])
  })

  it('一覧を取得できなければ WorktreeRuntimeError', async () => {
    await explains('サブの worktree のパスを取得する `getWorktreeDirectories` のテストです。git リポジトリの外で一覧を取得できない場合に、`WorktreeRuntimeError` が発生することを確認します。')
    expect(runtimeMessage(() => getWorktreeDirectories(makeTemporaryDirectory()))).toBe('cannot get the worktree list')
  })
})

describe('getCurrentWorktreeName', () => {
  it('サブの worktree では、リポジトリのディレクトリの親の名前（wtN）を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。サブの worktree では、リポジトリのディレクトリの親の名前である `wt2` を返すことを確認します。')
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt2', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt2', worktree])
    expect(getCurrentWorktreeName(worktree)).toBe('wt2')
  })

  it('番号の記録があれば、置き場所の親の名前に依らずそれを返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。記録した名前がある場合に、置き場所の親の名前に関係なく、記録の `wt1` を返すことを確認します。')
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    await createWorktree(repository, ignoredDiagnostics, { path: worktree, shouldCopy: false, shouldLink: false })
    gitForTest(worktree, ['switch', '-q', '-c', 'feature/x'])
    expect(getCurrentWorktreeName(worktree)).toBe('wt1')
  })

  it('記録が存在せず、親の名前が wtN と base のどちらでもなければ、undefined を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。記録がなく、親のディレクトリの名前が `wtN` でも `base` でもない場合に、`undefined` を返すことを確認します。')
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'other', worktree])
    expect(getCurrentWorktreeName(worktree)).toBeUndefined()
  })

  it('Claude Code が作成した .claude/worktrees/<name> では、worktree-<name> を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。Claude Code が作成した `.claude/worktrees/<name>` の worktree では、ブランチ名を切り替えても `worktree-<name>` を返すことを確認します。')
    const { repository } = createProject()
    const worktree = path.join(repository, '.claude', 'worktrees', 'bold-oak')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'worktree-bold-oak', worktree])
    gitForTest(worktree, ['switch', '-q', '-c', 'feature/x'])
    expect(getCurrentWorktreeName(worktree)).toBe('worktree-bold-oak')
  })

  it('.claude/worktrees のフォルダ名の + を / に戻したブランチがあれば、その名前を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。フォルダ名が `team+task` の場合に、`+` を `/` に戻した `worktree-team/task` のブランチがあれば、その名前を返すことを確認します。')
    const { repository } = createProject()
    const worktree = path.join(repository, '.claude', 'worktrees', 'team+task')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'worktree-team/task', worktree])
    expect(getCurrentWorktreeName(worktree)).toBe('worktree-team/task')
  })

  it('.claude/worktrees/<name> でも、worktree-<name> のブランチが存在しなければ undefined を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。`.claude/worktrees/<name>` の worktree で、`worktree-<name>` のブランチが存在しない場合に、`undefined` を返すことを確認します。')
    const { repository } = createProject()
    const worktree = path.join(repository, '.claude', 'worktrees', 'bold-oak')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'renamed', worktree])
    expect(getCurrentWorktreeName(worktree)).toBeUndefined()
  })

  it('メインの worktree では、undefined を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。メインの worktree のパスを渡した場合に、`undefined` を返すことを確認します。')
    expect(getCurrentWorktreeName(createProject().repository)).toBeUndefined()
  })

  it('base/ の下にあるリポジトリがサブの worktree のときは、base を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。親のディレクトリが `base` で、リポジトリ自体がサブの worktree の場合に、`base` を返すことを確認します。')
    const main = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'main', 'aist-roadmap'))
    const base = path.join(path.dirname(path.dirname(main)), 'base', 'aist-roadmap')
    gitForTest(main, ['worktree', 'add', '-q', '-b', 'base-branch', base])
    expect(getCurrentWorktreeName(base)).toBe('base')
  })

  it('サブの worktree と判定した後に toplevel を取得できなければ、undefined を返す', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。偽の git でサブの worktree と判定されたあとに、リポジトリのルートを取得できない場合に、`undefined` を返すことを確認します。')
    installFakeGit({ 'rev-parse --git-dir': '/repo/.git/worktrees/wt2\n', 'rev-parse --git-common-dir': '/repo/.git\n' })
    expect(getCurrentWorktreeName(makeTemporaryDirectory())).toBeUndefined()
  })

  it('git リポジトリの外では、WorktreeRuntimeError を投げる', async () => {
    await explains('現在の worktree の名前を取得する `getCurrentWorktreeName` のテストです。git リポジトリの外で実行した場合に、`WorktreeRuntimeError` が発生することを確認します。')
    expect(runtimeMessage(() => getCurrentWorktreeName(makeTemporaryDirectory()))).toMatch(/^not a git repository/u)
  })
})

function absent(): string {
  return path.join(makeTemporaryDirectory(), 'no-dockerenv')
}

describe('ensureDevcontainerEnvironment', () => {
  beforeEach(() => {
    setEnvironment({ REMOTE_CONTAINERS: undefined, CODESPACES: undefined, DEVCONTAINER: undefined })
  })

  it('/.dockerenv があれば、env が空でも通過する', async () => {
    await explains('devcontainer の環境かどうかを確認する `ensureDevcontainerEnvironment` のテストです。`/.dockerenv` が存在する場合に、環境変数が空でも例外を発生させずに通過することを確認します。')
    const file = path.join(makeTemporaryDirectory(), '.dockerenv')
    writeFileSync(file, '')
    expect(() => {
      ensureDevcontainerEnvironment(file)
    }).not.toThrow()
  })

  it.each(['REMOTE_CONTAINERS', 'CODESPACES', 'DEVCONTAINER'])('%s が設定されていれば通過する', async (name) => {
    await explains(`devcontainer の環境かどうかを確認する \`ensureDevcontainerEnvironment\` のテストです。\`/.dockerenv\` が存在しなくても、環境変数 \`${name}\` が設定されている場合に、例外を発生させずに通過することを確認します。`)
    setEnvironment({ [name]: '1' })
    expect(() => {
      ensureDevcontainerEnvironment(absent())
    }).not.toThrow()
  })

  it('どれも存在しなければ WorktreeRuntimeError を投げ、空文字の環境変数は設定とみなさない', async () => {
    await explains('devcontainer の環境かどうかを確認する `ensureDevcontainerEnvironment` のテストです。`/.dockerenv` が存在せず環境変数も未設定の場合や、空文字の場合は、devcontainer の外での実行を拒否する `WorktreeRuntimeError` が発生することを確認します。')
    setEnvironment({ DEVCONTAINER: '' })
    const message = runtimeMessage(() => {
      ensureDevcontainerEnvironment(absent())
    })
    expect(message).toContain('this tool must run inside a devcontainer')
    expect(message).toContain('prepare .devcontainer/ in the project, run Reopen in Container in VS Code, and call it again')
    expect(message).not.toContain('a-dcgen')
  })

  it('既定の /.dockerenv を参照する', async () => {
    await explains('devcontainer の環境かどうかを確認する `ensureDevcontainerEnvironment` のテストです。ファイルのパスを省略して環境変数 `DEVCONTAINER` が設定されている場合に、例外を発生させずに通過することを確認します。')
    setEnvironment({ DEVCONTAINER: '1' })
    expect(() => {
      ensureDevcontainerEnvironment()
    }).not.toThrow()
  })
})
