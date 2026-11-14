/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { compileGitIgnoreSpec, GitIgnorePatternError } from '../gitignore-spec.js'
import { OsError } from '../os-error.js'
import { DEFAULT_WORKTREEIGNORE_CONTENT } from '../worktree-links.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { installFakeExecutable, prependToPath } from '../../tests/_helpers/fake-executables.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../tests/_helpers/temporary.js'
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
import { ignoredDiagnostics, recordDiagnostics } from './recording-diagnostics.js'

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

function runtimeMessage(action: () => void): string {
  const error = thrownError(action)
  expect(error).toBeInstanceOf(WorktreeRuntimeError)
  return error instanceof Error ? error.message : ''
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
  it('メインと追加した WT を、パス・コミット・ブランチに分ける（実 git）', () => {
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(root, 'wt1', 'myrepo')])
    const list = getWorktreeList(repository)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ path: repository, commit: branchCommit(repository, 'main'), branch: 'main' })
    expect(list[1]?.branch).toBe('wt1')
    expect(list[1]?.path).toBe(path.join(root, 'wt1', 'myrepo'))
  })

  it('detached HEAD は branch が undefined（実 git）', () => {
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '--detach', path.join(root, 'wt1', 'myrepo')])
    expect(getWorktreeList(repository).map(entry => entry.branch)).toEqual(['main', undefined])
  })

  it('porcelain の出力を、空白を含むパス・detached・bare も含めて分ける（偽の git）', () => {
    installFakeGit({ 'worktree list --porcelain': 'worktree /home/user/my repo\nHEAD abc1234\nbranch refs/heads/main\n\nworktree /home/user/wt1/repo\nHEAD def5678\nbranch refs/heads/feature/x\nlocked\n\nworktree /home/user/d\nHEAD 0123456\ndetached\n\nworktree /home/user/b\nbare\n' })
    expect(getWorktreeList()).toEqual([
      { path: '/home/user/my repo', commit: 'abc1234', branch: 'main' },
      { path: '/home/user/wt1/repo', commit: 'def5678', branch: 'feature/x' },
      { path: '/home/user/d', commit: '0123456', branch: undefined },
      { path: '/home/user/b', commit: '', branch: undefined },
    ])
  })

  it('空白を含むパスの worktree を、一覧・メインの特定・削除で扱える（実 git）', () => {
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'with space', 'my repo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(getWorktreeList(repository).map(entry => entry.path)).toEqual([repository, worktree])
    expect(findMainWorktree(worktree)).toBe(repository)
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
  })

  it('出力が空なら空', () => {
    installFakeGit({ 'worktree list --porcelain': '' })
    expect(getWorktreeList()).toEqual([])
  })

  it('git が失敗すれば空（git リポジトリの外）', () => {
    expect(getWorktreeList(makeTemporaryDirectory())).toEqual([])
  })
})

describe('findMainWorktree', () => {
  it('どの WT からでも、最初のエントリ（メイン WT）を返す', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(findMainWorktree(worktree)).toBe(repository)
    expect(findMainWorktree(repository)).toBe(repository)
  })

  it('一覧を取得できなければ WorktreeRuntimeError。git の stderr を含む', () => {
    const message = runtimeMessage(() => findMainWorktree(makeTemporaryDirectory()))
    expect(message).toMatch(/^cannot get the worktree list: fatal: not a git repository/u)
  })

  it('一覧が空でも WorktreeRuntimeError', () => {
    installFakeGit({ 'worktree list --porcelain': '  \n' })
    expect(runtimeMessage(() => findMainWorktree('.'))).toBe('cannot get the worktree list: ')
  })

  it('作業ディレクトリが無ければ OsError（Python の FileNotFoundError に当たる）', () => {
    expect(thrownError(() => findMainWorktree(path.join(makeTemporaryDirectory(), 'missing')))).toBeInstanceOf(OsError)
  })
})

describe('findWorktreeConfigFile', () => {
  it('メイン WT の worktree-config.json を、サブ WT からでも見つける', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(findWorktreeConfigFile(worktree)).toBe(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
  })

  it('設定ファイルが無い・git の外なら undefined', () => {
    const repository = createGitRepository()
    expect(findWorktreeConfigFile(repository)).toBeUndefined()
    expect(findWorktreeConfigFile(makeTemporaryDirectory())).toBeUndefined()
  })

  it('cwd を省略するとプロセスの作業ディレクトリ', () => {
    const { repository } = createProject()
    vi.spyOn(process, 'cwd').mockReturnValue(repository)
    expect(findWorktreeConfigFile()).toBe(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
  })

  it('git が無ければ OsError', () => {
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(thrownError(() => findWorktreeConfigFile(process.cwd()))).toBeInstanceOf(OsError)
  })
})

describe('detectProjectRoot', () => {
  it('base 直下: <root> を返す', () => {
    const { repository, root } = createProject()
    expect(detectProjectRoot(repository)).toBe(root)
  })

  it('wt1 から呼んでも、main_wt が base/<repo> なら同じ root を返す', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(detectProjectRoot(worktree)).toBe(root)
  })

  it('base 以外なら、現在・期待・理由・移行手順の 4 ブロックの文で WorktreeRuntimeError', () => {
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

  it('main_wt がシンボリックリンク経由でも、解決してから確認する（偽の git）', () => {
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
  it('既存の wtN セットが無ければ wt1', () => {
    expect(getNextSetName(projectOf([]), 'myrepo')).toBe('wt1')
  })

  it('プロジェクトルートが無くても wt1', () => {
    const missing = path.join(makeTemporaryDirectory(), 'nonexistent')
    expect(getNextSetName(missing, 'myrepo')).toBe('wt1')
  })

  it('wt1/ があって wt1/myrepo が無ければ、wt1 に参加する', () => {
    expect(getNextSetName(projectOf(['wt1']), 'myrepo')).toBe('wt1')
  })

  it('wt1/myrepo が既にあって wt2/ が空なら、wt2 に参加する', () => {
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2']), 'myrepo')).toBe('wt2')
  })

  it('全セットに該当リポが参加済みなら、max+1 の新セット', () => {
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2/myrepo']), 'myrepo')).toBe('wt3')
  })

  it('参加できるセットが複数あれば最小番号', () => {
    expect(getNextSetName(projectOf(['wt1', 'wt3']), 'myrepo')).toBe('wt1')
  })

  it('欠番は埋めない。wt1・wt3 が埋まっていれば wt4', () => {
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt3/myrepo']), 'myrepo')).toBe('wt4')
  })

  it('全セットに参加済みで max を超えるなら WorktreeRuntimeError', () => {
    const directories = Array.from({ length: 9 }, (_unused, index) => `wt${String(index + 1)}/myrepo`)
    expect(runtimeMessage(() => getNextSetName(projectOf(directories), 'myrepo'))).toBe('all of wt1 to wt9 are in use: no free set')
  })

  it('base ディレクトリと wt でないディレクトリは無視する', () => {
    expect(getNextSetName(projectOf(['base', 'foo', 'wt', 'wtx']), 'myrepo')).toBe('wt1')
    expect(getNextSetName(projectOf(['foo', 'wt1']), 'myrepo')).toBe('wt1')
  })

  it('ファイルの wt1 は数えない', () => {
    const root = makeTemporaryDirectory()
    writeFileSync(path.join(root, 'wt1'), 'file')
    expect(getNextSetName(root, 'myrepo')).toBe('wt1')
  })

  it('リンク先の無い symlink の wt1 は数えない', () => {
    const root = makeTemporaryDirectory()
    symlinkSync('/nonexistent/target', path.join(root, 'wt1'))
    expect(getNextSetName(root, 'myrepo')).toBe('wt1')
  })

  it('claimed の番号には参加せず、避けて次の番号にする', () => {
    expect(getNextSetName(projectOf(['wt1', 'wt2']), 'myrepo', { claimed: ['wt1'] })).toBe('wt2')
  })

  it('claimed だけでも max が上がる。wt1 ディレクトリが無くても claimed に wt1 があれば wt2', () => {
    expect(getNextSetName(projectOf([]), 'myrepo', { claimed: ['wt1'] })).toBe('wt2')
    expect(getNextSetName(projectOf(['wt1']), 'myrepo', { claimed: ['wt3'] })).toBe('wt1')
    expect(getNextSetName(projectOf(['wt1/myrepo']), 'myrepo', { claimed: ['wt3'] })).toBe('wt4')
    expect(getNextSetName(projectOf(['wt1/myrepo', 'wt2/myrepo']), 'myrepo', { claimed: ['wt3'] })).toBe('wt4')
  })

  it('prefix と max を変えられる', () => {
    const root = projectOf(['ws1/myrepo'])
    expect(getNextSetName(root, 'myrepo', { prefix: 'ws' })).toBe('ws2')
    expect(runtimeMessage(() => getNextSetName(root, 'myrepo', { prefix: 'ws', maxNumber: 1 }))).toBe('all of ws1 to ws1 are in use: no free set')
  })
})

function projectWithSetup(setupCommand: string | undefined, timeout?: number): Project {
  const config: Record<string, unknown> = { version: 3, links: [] }
  if (setupCommand !== undefined) config['setup_command'] = setupCommand
  if (timeout !== undefined) config['setup_command_timeout'] = timeout
  return createProject({ worktreeConfig: JSON.stringify(config) })
}

function addElsewhere(): { readonly repository: string, readonly root: string, readonly elsewhere: string } {
  const { repository, root } = createProject()
  const elsewhere = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
  const first = createWorktree(repository, ignoredDiagnostics, { path: elsewhere, shouldCopy: false, shouldLink: false })
  expect(first.name).toBe('wt1')
  return { repository, root, elsewhere }
}

describe('createWorktree と番号の記録（実 git）', () => {
  it('作った worktree に番号を記録し、dry-run では書かない', () => {
    const { repository, root } = createProject()
    createWorktree(repository, ignoredDiagnostics, { isDryRun: true })
    expect(claimedSetNames(repository)).toEqual(new Set())
    const result = createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
    const recordPath = gitForTest(result.path, ['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name']).trim()
    expect(readFileSync(recordPath, 'utf8')).toBe('wt1\n')
  })

  it('path 指定の worktree があっても、次の作成は wt2 を選ぶ', () => {
    const { repository, root } = addElsewhere()
    const second = createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(second.name).toBe('wt2')
    expect(second.path).toBe(path.join(root, 'wt2', 'myrepo'))
  })

  it('path 指定の worktree が機能ブランチに移った後も、wt1 を選ばない', () => {
    const { repository, elsewhere } = addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    expect(createWorktree(repository, ignoredDiagnostics, { isDryRun: true }).name).toBe('wt2')
  })

  it('記録の無い worktree でも、wtN のブランチを使っていればその番号を使用中にする', () => {
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(makeTemporaryDirectory(), 'x', 'myrepo')])
    expect(claimedSetNames(repository)).toEqual(new Set(['wt1']))
    expect(createWorktree(repository, ignoredDiagnostics, { isDryRun: true }).path).toBe(path.join(root, 'wt2', 'myrepo'))
  })

  it('claimedSetNames はプロセスの作業ディレクトリに依らない', () => {
    vi.restoreAllMocks()
    const { repository } = addElsewhere()
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
  it('dry-run は path を <root>/<name>/<repo> にし、WT を作らない', () => {
    const { repository, root } = createProject()
    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', isDryRun: true })
    expect(result).toEqual({ name: 'wt1', path: path.join(root, 'wt1', 'myrepo'), branch: 'wt1', baseBranch: 'develop', copiedFiles: [], linkedFiles: [], setupResult: undefined })
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('name を省略すると、プロジェクトルート基準で番号を決める。base は develop_branch', () => {
    const { repository, root } = createProject()
    mkdirSync(path.join(root, 'wt1', 'myrepo'), { recursive: true })
    const result = createWorktree(repository, ignoredDiagnostics, { isDryRun: true })
    expect(result.name).toBe('wt2')
    expect(result.path).toBe(path.join(root, 'wt2', 'myrepo'))
    expect(result.baseBranch).toBe('develop')
  })

  it('別リポが作った wt1/ に該当リポが未参加なら、wt1 に参加する', () => {
    const { repository, root } = createProject()
    mkdirSync(path.join(root, 'wt1', 'myrepo-B'), { recursive: true })
    expect(createWorktree(repository, ignoredDiagnostics, { isDryRun: true }).name).toBe('wt1')
  })

  it('path を明示するとそこに作る', () => {
    const { repository } = createProject()
    const target = path.join(makeTemporaryDirectory(), 'custom', 'dir')
    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', path: `${target}/`, shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(target)
    expect(gitForTest(target, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
  })

  it('新しいブランチは base_branch の origin を追跡する', () => {
    const { repository, root } = createProject()
    const result = createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false })
    expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim()).toBe('origin/develop')
    expect(result.setupResult).toBeUndefined()
  })

  it('--base を明示すれば develop_branch が未設定でも作れる。未設定で省略するとエラー', () => {
    const { repository } = createProject({ repositories: [{ owner: 'myowner', name: 'myrepo' }] })
    const message = runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { isDryRun: true }))
    expect(message).toBe([
      'develop_branch is not set for repository myowner/myrepo',
      '  add develop_branch to repositories in the project config file',
      '  or pass --base explicitly',
    ].join('\n'))
    expect(createWorktree(repository, ignoredDiagnostics, { baseBranch: 'main', isDryRun: true }).baseBranch).toBe('main')
  })

  it('空の base_branch は origin を追跡せず、現在のコミットから作る', () => {
    const { repository } = createProject()
    const result = createWorktree(repository, ignoredDiagnostics, { baseBranch: '', shouldCopy: false, shouldLink: false })
    expect(gitForTest(result.path, ['rev-parse', 'HEAD']).trim()).toBe(branchCommit(repository, 'main'))
    expect(thrownError(() => gitForTest(result.path, ['rev-parse', '@{upstream}']))).toBeInstanceOf(Error)
  })

  it('既存ブランチの upstream が develop_branch と違えば WorktreeRuntimeError', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    const message = runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false }))
    expect(message).toBe('branch \'wt1\' already exists and its upstream differs from the expected one (current: origin/main, expected: origin/develop): pass --allow-existing-branch to reuse it')
  })

  it('upstream の無い既存ブランチは「(未設定)」と表示する', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', 'wt1', 'main'])
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' }))).toContain('(current: (unset), expected: origin/develop)')
  })

  it('base が空で upstream のあるブランチは、期待が None の不一致になる', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: '' }))).toContain('(current: origin/main, expected: None)')
  })

  it('upstream が空の既存ブランチを base が空で作ると、そのまま再利用する', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', 'wt1', 'main'])
    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: '', shouldLink: false, shouldCopy: false })
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
  })

  it('--allow-existing-branch なら upstream が違っても、そのブランチで WT を作る', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false, isExistingBranchAllowed: true })
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
    expect(gitForTest(result.path, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim()).toBe('origin/main')
  })

  it('孤児ブランチ（upstream 一致・どの WT にも bind されていない）は、削除して -b --track で作り直す', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/develop'])
    gitForTest(repository, ['checkout', '-q', 'wt1'])
    writeFileSync(path.join(repository, 'stale.txt'), 'stale')
    gitForTest(repository, ['add', 'stale.txt'])
    gitForTest(repository, ['commit', '-q', '-m', 'stale'])
    gitForTest(repository, ['checkout', '-q', 'main'])

    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false })
    expect(branchCommit(result.path, 'HEAD')).toBe(branchCommit(repository, 'origin/develop'))
    expect(existsSync(path.join(result.path, 'stale.txt'))).toBe(false)
  })

  it('--allow-existing-branch なら孤児ブランチでも削除せず、そのまま再利用する', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/develop'])
    gitForTest(repository, ['checkout', '-q', 'wt1'])
    writeFileSync(path.join(repository, 'kept.txt'), 'kept')
    gitForTest(repository, ['add', 'kept.txt'])
    gitForTest(repository, ['commit', '-q', '-m', 'kept'])
    gitForTest(repository, ['checkout', '-q', 'main'])

    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false, isExistingBranchAllowed: true })
    expect(existsSync(path.join(result.path, 'kept.txt'))).toBe(true)
  })

  it('他の WT に bind 済みのブランチは削除されず、git が拒否して WorktreeRuntimeError', () => {
    const { repository, root } = createProject()
    const other = path.join(root, 'other', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '--track', '-b', 'wt1', other, 'origin/develop'])
    const message = runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldLink: false, shouldCopy: false }))
    expect(message).toMatch(/^failed to create the worktree: [\s\S]*fatal: 'wt1' is already (checked out|used by worktree)/u)
    expect(branchCommit(repository, 'wt1')).toBe(branchCommit(repository, 'origin/develop'))
    expect(existsSync(other)).toBe(true)
  })

  it('孤児ブランチでも upstream が不一致なら、不一致のエラーが先に出て、ブランチは消さない', () => {
    const { repository } = createProject()
    gitForTest(repository, ['branch', '--track', 'wt1', 'origin/main'])
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' }))).toContain('upstream differs from the expected one')
    expect(branchCommit(repository, 'wt1')).toBe(branchCommit(repository, 'main'))
  })

  it('container rebuild 後の stale な WT メタデータは、add の前に prune して再作成できる', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '--track', '-b', 'wt1', worktree, 'origin/develop'])
    const metadata = path.join(repository, '.git', 'worktrees', 'myrepo')
    expect(existsSync(metadata)).toBe(true)
    // 実体だけ消して stale にする
    rmSync(worktree, { recursive: true })
    expect(existsSync(metadata)).toBe(true)

    const result = createWorktree(repository, ignoredDiagnostics, { shouldCopy: false, shouldLink: false, isExistingBranchAllowed: true })
    expect(result.name).toBe('wt1')
    expect(result.path).toBe(worktree)
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(metadata)).toBe(true)
  })

  it('メイン WT が base/ に無ければ WorktreeRuntimeError', () => {
    const repository = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo'))
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toContain('this repository is not placed in the layout pecot expects for a project')
  })

  it('worktree-config.json が無ければ init を促すエラー', () => {
    const { repository } = createProject()
    rmSync(path.join(repository, '.pecot', 'config', 'worktree-config.json'))
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toBe('worktree config not found: .pecot/config/worktree-config.json\n  run pecot worktree init to generate the template')
  })

  it('.worktreeignore が無ければ init を促すエラー', () => {
    const { repository } = createProject()
    rmSync(path.join(repository, '.pecot', 'config', '.worktreeignore'))
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toBe('copy exclude config not found: .pecot/config/.worktreeignore\n  run pecot worktree init to generate the template')
  })

  it('origin が無ければ WorktreeRuntimeError', () => {
    const { repository } = createProject()
    gitForTest(repository, ['remote', 'remove', 'origin'])
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toBe('cannot get the repository information: check that a git remote is set to a GitHub repository URL')
  })

  it('origin の owner が不正な名前でも WorktreeRuntimeError', () => {
    const { repository } = createProject({ originUrl: 'https://github.com/bad%20owner/myrepo.git' })
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toBe('cannot get the repository information: check that a git remote is set to a GitHub repository URL')
  })

  it('アクティブなプロジェクト設定が無ければ WorktreeRuntimeError', () => {
    const { repository, configRoot } = createProject()
    rmSync(path.join(configRoot, '.pecot', 'config', 'projects', '.active'))
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics))).toBe('project config not found\n  hint: run pecot project activate <PROJECT> to set the project')
  })

  it('アクティブなプロジェクトに登録されていないリポジトリはエラー。登録済みの一覧と追加手順を示す', () => {
    const { repository } = createProject({ repositories: [{ owner: 'foo', name: 'bar' }, { owner: 'foo', name: 'baz' }] })
    const expected = [
      'repository myowner/myrepo is not registered in the active pecot project',
      '',
      'registered repositories:',
      '  - foo/bar',
      '  - foo/baz',
      '',
      'to add this repository to the pecot project:',
      '  pecot repo set myowner/myrepo',
      '',
      'to switch to another project:',
      '  pecot project activate <PROJECT>',
    ].join('\n')
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', isDryRun: true }))).toBe(expected)
  })

  it('登録が 1 件も無ければ「(登録なし)」', () => {
    const { repository } = createProject({ repositories: [] })
    expect(runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { isDryRun: true }))).toContain('registered repositories:\n  (none registered)\n')
  })

  it('symlink 登録済みのファイルは、未追跡ファイルのコピーから除く', () => {
    const files = { 'README.md': 'x', '.gitignore': '.env\n.claude/\n' }
    const worktreeConfig = JSON.stringify({ version: 3, links: [{ path: '.claude/settings.local.json', target_repo: 'shared-repo', target_path: '.claude/settings.local.json' }] })
    const { repository, root } = createProject({ files, worktreeConfig })
    writeTree(path.join(root, 'base', 'shared-repo'), { '.claude/settings.local.json': '{}' })
    writeTree(repository, { '.claude/settings.local.json': 'main-content', '.env': 'FOO=bar\n' })

    const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop' })

    const copied = result.copiedFiles.filter(item => item.action === 'copied').map(item => path.basename(item.source))
    expect(copied).toContain('.env')
    expect(copied).not.toContain('settings.local.json')
    expect(readFileSync(path.join(result.path, '.env'), 'utf8')).toBe('FOO=bar\n')
    const symlink = path.join(result.path, '.claude', 'settings.local.json')
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true)
    expect(readFileSync(symlink, 'utf8')).toBe('{}')
    expect(result.linkedFiles.map(item => item.action)).toEqual(['created'])
  })

  it('.worktreeignore に当たる未追跡ファイルはコピーしない。コピー対象が無ければ空', () => {
    const { repository } = createProject({ files: { 'README.md': 'x', '.gitignore': '__pycache__/\n' }, ignoreContent: '__pycache__/\n' })
    writeTree(repository, { '__pycache__/a.pyc': 'x' })
    const result = createWorktree(repository, ignoredDiagnostics, { shouldLink: false })
    expect(result.copiedFiles).toEqual([])
    expect(existsSync(path.join(result.path, '__pycache__'))).toBe(false)
  })

  it('.worktreeignore に不正なパターン（感嘆符だけの行）があれば、GitIgnorePatternError をそのまま伝える', () => {
    const { repository } = createProject({ ignoreContent: '!\n' })
    expect(thrownError(() => {
      createWorktree(repository, ignoredDiagnostics, { isDryRun: true })
    })).toBeInstanceOf(GitIgnorePatternError)
  })

  it('worktree-config.json を読めなければ（ディレクトリ）、OsError をそのまま伝える', () => {
    const { repository } = createProject()
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    rmSync(configPath)
    mkdirSync(configPath)
    expect(thrownError(() => {
      createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
    })).toBeInstanceOf(OsError)
  })

  it('不正な JSON の worktree-config.json は、WT を作った後に WorktreeRuntimeError', () => {
    const { repository, root } = createProject({ worktreeConfig: '{ this is not valid json' })
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    const message = runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }))
    expect(message.startsWith(`failed to load the worktree config: ${configPath}: JSON parse error: ${configPath}: `)).toBe(true)
    expect(message.endsWith('\n  fix the config file and run it again')).toBe(true)
    expect(existsSync(path.join(root, 'wt1', 'myrepo'))).toBe(true)
  })

  it('スキーマ違反の worktree-config.json は、pydantic と同じ検証エラーの文を含む', () => {
    const { repository } = createProject({ worktreeConfig: '{"version": 2}' })
    const configPath = path.join(repository, '.pecot', 'config', 'worktree-config.json')
    const message = runtimeMessage(() => createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }))
    const head = `failed to load the worktree config: ${configPath}: config file validation failed: ${configPath}`
    expect(message).toContain(`${head}: 1 validation error for WorktreeConfig\nversion\n  Input should be 3`)
  })

  describe('setup_command', () => {
    it('CLI の --setup が config の setup_command より優先される。WT のルートで実行する', () => {
      const { repository } = projectWithSetup('echo from-config')
      const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo from-cli; pwd', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toEqual({ command: 'echo from-cli; pwd', exitCode: 0, stdout: `from-cli\n${result.path}\n`, stderr: '' })
    })

    it('CLI が未指定なら config の setup_command を使う', () => {
      const { repository } = projectWithSetup('echo from-config')
      const result = createWorktree(repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toEqual({ command: 'echo from-config', exitCode: 0, stdout: 'from-config\n', stderr: '' })
    })

    it('CLI と config のどちらにも無ければ実行しない。空文字の setup_command では実行しない', () => {
      const none = projectWithSetup(undefined)
      expect(createWorktree(none.repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }).setupResult).toBeUndefined()
      const empty = projectWithSetup('')
      expect(createWorktree(empty.repository, ignoredDiagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false }).setupResult).toBeUndefined()
    })

    it('config の setup_command_timeout を超えると exitCode -1 の結果になる', () => {
      const { repository } = projectWithSetup('sleep 5', 1)
      const recorded = recordDiagnostics()
      const result = createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', shouldCopy: false, shouldLink: false })
      expect(result.setupResult).toMatchObject({ command: 'sleep 5', exitCode: -1, stderr: 'timeout after 1 seconds' })
      expect(recorded.lines).toEqual(['warning: setup command timed out: sleep 5\nerr: timeout after 1 seconds'])
    })

    it('setup_command が非ゼロ終了でも例外は投げず、結果と警告を残す', () => {
      const { repository } = projectWithSetup(undefined)
      const recorded = recordDiagnostics()
      const result = createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo boom >&2; exit 42', shouldCopy: false, shouldLink: false })
      const root = path.dirname(path.dirname(repository))
      expect(result.path).toBe(path.join(root, 'wt1', 'myrepo'))
      expect(result.setupResult).toMatchObject({ exitCode: 42, stderr: 'boom\n' })
      expect(recorded.lines).toEqual(['warning: setup command failed (exit 42): echo boom >&2; exit 42\nerr: boom'])
    })

    it('stdout と stderr が両方あれば out: と err: の行で続ける', () => {
      const { repository } = projectWithSetup(undefined)
      const recorded = recordDiagnostics()
      createWorktree(repository, recorded.diagnostics, { name: 'wt1', baseBranch: 'develop', setupCommand: 'echo hi; echo oops >&2; exit 42', shouldCopy: false, shouldLink: false })
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
  it('WT とブランチを消し、空になった <root>/<name>/ も消す', () => {
    const { repository, root, worktree } = projectWithWorktree()
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
  })

  it('ブランチ wt1 が無い worktree を名前で消すと、ブランチを消せなかった理由を返す', () => {
    const { repository, elsewhere } = addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    gitForTest(repository, ['branch', '-D', 'wt1'])
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toMatch(/wt1/u)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('他リポの WT が残っていれば <root>/<name>/ は消さない', () => {
    const { repository, root } = projectWithWorktree()
    mkdirSync(path.join(root, 'wt1', 'other-repo'))
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(path.join(root, 'wt1', 'other-repo'))).toBe(true)
  })

  it('keep_branch ならブランチを残し、undefined を返す', () => {
    const { repository } = projectWithWorktree()
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics, { shouldKeepBranch: true })).toBeUndefined()
    expect(gitForTest(repository, ['branch', '--list', 'wt1']).trim()).toBe('wt1')
  })

  it('未コミットの変更があれば拒否される。force なら消せる', () => {
    const { repository, worktree } = projectWithWorktree()
    writeFileSync(path.join(worktree, 'README.md'), 'dirty')
    expect(runtimeMessage(() => {
      removeWorktree(repository, 'wt1', ignoredDiagnostics)
    })).toMatch(/^failed to remove the worktree: fatal: '.*' contains modified or untracked files, use --force to delete it/u)
    expect(existsSync(worktree)).toBe(true)
    removeWorktree(repository, 'wt1', ignoredDiagnostics, { isForced: true })
    expect(existsSync(worktree)).toBe(false)
  })

  it('見つからない WT 名は WorktreeRuntimeError', () => {
    const { repository } = projectWithWorktree()
    expect(runtimeMessage(() => {
      removeWorktree(repository, 'nope', ignoredDiagnostics)
    })).toBe('worktree not found: nope')
  })

  it('記録した名前を渡すと、機能ブランチに移した --path の worktree と wt1 ブランチを消す', () => {
    const { repository, elsewhere } = addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '-c', 'feature/x'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
    expect(gitForTest(repository, ['branch', '--list', 'feature/x']).trim()).toBe('feature/x')
  })

  it('記録の無い <root>/<name>/<repo> の worktree は、機能ブランチに移していても置き場所で見つけて消す', () => {
    const { repository, root, worktree } = projectWithWorktree()
    gitForTest(worktree, ['switch', '-q', '-c', 'feature/x'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'wt1'])).toBe('')
    expect(gitForTest(repository, ['branch', '--list', 'feature/x']).trim()).toBe('feature/x')
  })

  // 一覧の並びは git の管理ディレクトリの読み順で決まるので、どちらを先に作っても記録の方を消すことを確かめる
  it.for([{ order: '記録の worktree を先に作る', isHolderFirst: false }, { order: 'ブランチ wt1 の worktree を先に作る', isHolderFirst: true }])('$order と、記録が wt1 の worktree を消し、ブランチ wt1 の別の worktree を残す', ({ isHolderFirst }) => {
    const { repository, root } = createProject()
    const holder = path.join(makeTemporaryDirectory(), 'holder', 'myrepo')
    if (isHolderFirst) gitForTest(repository, ['worktree', 'add', '-q', '-b', 'tmp', holder])
    const recorded = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    expect(createWorktree(repository, ignoredDiagnostics, { path: recorded, shouldCopy: false, shouldLink: false }).name).toBe('wt1')
    if (!isHolderFirst) gitForTest(repository, ['worktree', 'add', '-q', '-b', 'tmp', holder])
    gitForTest(recorded, ['switch', '-q', '-c', 'feature/x'])
    gitForTest(holder, ['switch', '-q', 'wt1'])
    expect(removeWorktree(repository, 'wt1', ignoredDiagnostics)).toMatch(/used by worktree/u)
    expect(existsSync(recorded)).toBe(false)
    expect(existsSync(holder)).toBe(true)
    expect(existsSync(root)).toBe(true)
  })

  it('detached HEAD の worktree も記録した名前で消す', () => {
    const { repository, elsewhere } = addElsewhere()
    gitForTest(elsewhere, ['switch', '-q', '--detach'])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('別の worktree のディレクトリが消えていても、wt1 を消せる', () => {
    const { repository, elsewhere } = addElsewhere()
    const other = path.join(makeTemporaryDirectory(), 'other', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'other', other])
    rmSync(other, { recursive: true })
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('base とメインのブランチ名は worktree not found になり、メインの worktree が残る', () => {
    const { repository } = projectWithWorktree()
    for (const name of ['base', 'main']) {
      expect(runtimeMessage(() => {
        removeWorktree(repository, name, ignoredDiagnostics)
      })).toBe(`worktree not found: ${name}`)
    }
    expect(existsSync(repository)).toBe(true)
  })

  it('wtN でない名前のブランチを渡すと、その worktree とブランチを消す', () => {
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'z', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'feature/z', worktree])
    removeWorktree(repository, 'feature/z', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
    expect(gitForTest(repository, ['branch', '--list', 'feature/z'])).toBe('')
  })

  it('消した WT の中から呼ぶと、掃除の git が作業ディレクトリを失って OsError になる（Python の FileNotFoundError と同じ）', () => {
    const { worktree } = projectWithWorktree()
    expect(thrownError(() => {
      removeWorktree(worktree, 'wt1', ignoredDiagnostics)
    })).toBeInstanceOf(OsError)
    expect(existsSync(worktree)).toBe(false)
  })

  it('ブランチを残す場合も、消した WT の中から呼ぶと、プロジェクトルートの検出で OsError になる', () => {
    const { worktree } = projectWithWorktree()
    expect(thrownError(() => {
      removeWorktree(worktree, 'wt1', ignoredDiagnostics, { shouldKeepBranch: true })
    })).toBeInstanceOf(OsError)
  })

  it('base/ 配置でないときは、ディレクトリの掃除を飛ばして正常終了する', () => {
    const repository = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo'))
    const worktree = path.join(path.dirname(path.dirname(repository)), 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    removeWorktree(repository, 'wt1', ignoredDiagnostics)
    expect(existsSync(worktree)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('空ディレクトリを消せなければ警告だけ出して正常終了する', () => {
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
  it('git 管理外（gitignored）のファイルを相対パスで返す', () => {
    const repository = createGitRepository({ 'README.md': 'x', '.gitignore': '.env\nconfig/local.json\n' })
    writeTree(repository, { '.env': 'a', 'config/local.json': 'b', 'tracked-not.txt': 'c' })
    expect(getUntrackedFiles(repository)).toEqual(['.env', 'config/local.json'])
  })

  it('無ければ空。git の外でも空', () => {
    expect(getUntrackedFiles(createGitRepository())).toEqual([])
    expect(getUntrackedFiles(makeTemporaryDirectory())).toEqual([])
  })
})

describe('filterCopyableFiles', () => {
  it('除外パターンに当たるファイルを除く', () => {
    const spec = compileGitIgnoreSpec(['.git/', '__pycache__/', '*.pyc', 'node_modules/'])
    const files = ['.env', '.git/config', '__pycache__/foo.pyc', 'src/app.py', 'node_modules/pkg/index.js']
    expect(filterCopyableFiles(files, spec)).toEqual(['.env', 'src/app.py'])
  })

  it('既定の .worktreeignore は、除外対象の 18 項目を全て除く', () => {
    const spec = compileGitIgnoreSpec(DEFAULT_WORKTREEIGNORE_CONTENT.split('\n'))
    const excluded = [
      '.git/config', '__pycache__/foo.pyc', 'foo.pyc', 'foo.pyo', '.venv/bin/python', 'venv/lib/x.so', 'myproj.egg-info/PKG-INFO',
      '.pytest_cache/CACHEDIR.TAG', '.mypy_cache/3.13/foo', '.ruff_cache/0.9.0', '.tox/py312/bin', 'htmlcov/index.html', '.coverage',
      'dist/foo.whl', 'build/lib/x.py', 'node_modules/pkg/index.js', '.pecot/config/worktree-config.json', 'tmp/scratch.txt',
    ]
    expect(filterCopyableFiles(excluded, spec)).toEqual([])
  })

  it('否定パターンで特定のサブパスを除外から外せる', () => {
    const spec = compileGitIgnoreSpec(['.nx/', '!.nx/version-plans/'])
    expect(filterCopyableFiles(['.nx/workspace-data/cache.db', '.nx/version-plans/my-plan.md'], spec)).toEqual(['.nx/version-plans/my-plan.md'])
  })

  it('空の spec は全てを通す', () => {
    const files = ['.git/HEAD', '__pycache__/x.pyc', '.venv/bin/python', 'node_modules/pkg/index.js', 'src/main.py']
    expect(filterCopyableFiles(files, compileGitIgnoreSpec([]))).toEqual(files)
  })
})

describe('isWorktreeEnvironment', () => {
  it('メイン WT は false。サブ WT は true（実 git）', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    expect(isWorktreeEnvironment(repository)).toBe(false)
    expect(isWorktreeEnvironment(worktree)).toBe(true)
  })

  it('サブディレクトリでは、相対パスを cwd でなくプロセスの作業ディレクトリ基準で解決する（Python と同じ挙動）', () => {
    const { repository, root } = createProject({ files: { 'sub/a.txt': 'x' } })
    const worktree = path.join(root, 'wt1', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', worktree])
    // git-dir は絶対パス、git-common-dir は ../.git になり、解決先が食い違うのでメイン WT のサブディレクトリでも true になる
    expect(isWorktreeEnvironment(path.join(repository, 'sub'))).toBe(true)
    expect(isWorktreeEnvironment(path.join(worktree, 'sub'))).toBe(true)
  })

  it('Git リポジトリの外は WorktreeRuntimeError。git の stderr を含む', () => {
    expect(runtimeMessage(() => isWorktreeEnvironment(makeTemporaryDirectory()))).toMatch(/^not a git repository: fatal: not a git repository/u)
  })

  it('git が無ければ OsError（WorktreeRuntimeError にはしない）', () => {
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(thrownError(() => isWorktreeEnvironment('.'))).toBeInstanceOf(OsError)
  })
})

describe('getWorktreeDirectories', () => {
  it('メイン WT を除いたサブ WT のパスを返す', () => {
    const { repository, root } = createProject()
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt1', path.join(root, 'wt1', 'myrepo')])
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt2', path.join(root, 'wt2', 'myrepo')])
    expect(getWorktreeDirectories(repository)).toEqual([path.join(root, 'wt1', 'myrepo'), path.join(root, 'wt2', 'myrepo')])
  })

  it('メインだけなら空', () => {
    expect(getWorktreeDirectories(createProject().repository)).toEqual([])
  })

  it('一覧を取得できなければ WorktreeRuntimeError', () => {
    expect(runtimeMessage(() => getWorktreeDirectories(makeTemporaryDirectory()))).toBe('cannot get the worktree list')
  })
})

describe('getCurrentWorktreeName', () => {
  it('サブ WT では、リポジトリディレクトリの親の名前（wtN）を返す', () => {
    const { repository, root } = createProject()
    const worktree = path.join(root, 'wt2', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'wt2', worktree])
    expect(getCurrentWorktreeName(worktree)).toBe('wt2')
  })

  it('記録があればそれを返す。置き場所の親の名前には依らない', () => {
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    createWorktree(repository, ignoredDiagnostics, { path: worktree, shouldCopy: false, shouldLink: false })
    gitForTest(worktree, ['switch', '-q', '-c', 'feature/x'])
    expect(getCurrentWorktreeName(worktree)).toBe('wt1')
  })

  it('記録が無く、親の名前が wtN と base のどちらでもないと、undefined を返す', () => {
    const { repository } = createProject()
    const worktree = path.join(makeTemporaryDirectory(), 'elsewhere', 'myrepo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'other', worktree])
    expect(getCurrentWorktreeName(worktree)).toBeUndefined()
  })

  it('メイン WT では undefined', () => {
    expect(getCurrentWorktreeName(createProject().repository)).toBeUndefined()
  })

  it('base/ 配置のリポジトリ自体がサブ WT のとき（親が base）は base を返す', () => {
    const main = createGitRepository({ 'README.md': 'x' }, path.join(makeTemporaryDirectory(), 'main', 'aist-roadmap'))
    const base = path.join(path.dirname(path.dirname(main)), 'base', 'aist-roadmap')
    gitForTest(main, ['worktree', 'add', '-q', '-b', 'base-branch', base])
    expect(getCurrentWorktreeName(base)).toBe('base')
  })

  it('サブ WT と判定した後に toplevel を取れなければ undefined', () => {
    installFakeGit({ 'rev-parse --git-dir': '/repo/.git/worktrees/wt2\n', 'rev-parse --git-common-dir': '/repo/.git\n' })
    expect(getCurrentWorktreeName(makeTemporaryDirectory())).toBeUndefined()
  })

  it('git リポジトリの外は WorktreeRuntimeError', () => {
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

  it('/.dockerenv があれば、env が空でも通過する', () => {
    const file = path.join(makeTemporaryDirectory(), '.dockerenv')
    writeFileSync(file, '')
    expect(() => {
      ensureDevcontainerEnvironment(file)
    }).not.toThrow()
  })

  it.each(['REMOTE_CONTAINERS', 'CODESPACES', 'DEVCONTAINER'])('%s が設定されていれば通過する', (name) => {
    setEnvironment({ [name]: '1' })
    expect(() => {
      ensureDevcontainerEnvironment(absent())
    }).not.toThrow()
  })

  it('どれも無ければ WorktreeRuntimeError。空文字の env は設定とみなさない', () => {
    setEnvironment({ DEVCONTAINER: '' })
    const message = runtimeMessage(() => {
      ensureDevcontainerEnvironment(absent())
    })
    expect(message).toContain('this command must run inside a devcontainer')
    expect(message).toContain('prepare .devcontainer/ in the project, run Reopen in Container in VS Code, and run it again')
    expect(message).not.toContain('a-dcgen')
  })

  it('既定の /.dockerenv を見る', () => {
    setEnvironment({ DEVCONTAINER: '1' })
    expect(() => {
      ensureDevcontainerEnvironment()
    }).not.toThrow()
  })
})
