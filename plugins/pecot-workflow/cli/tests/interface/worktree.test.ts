/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// worktree_add・worktree_remove・worktree_init・worktree_link の振る舞い（PW-WORKTREE-*）を、ツールをプロセス内で呼んで確かめる。
// 実 git と一時ディレクトリを使う。モックするのは、/.dockerenv の有無だけ。
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import path from 'node:path'

import { expect, it, describe, beforeEach, vi } from 'vitest'

import { TOOLS } from '../../src/commands/registry.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { runInProcess } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import type { ToolRunResult } from '../_helpers/run-tool.js'
import { verifies } from '../_helpers/verifies.js'
import { step, stepSync } from '../_helpers/step.js'
import { explains } from '../_helpers/explains.js'

// 本物の /.dockerenv は実行する環境で違うので、無い環境に固定する。devcontainer は環境変数で示す
const dockerEnvironment = vi.hoisted(() => ({ exists: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return { ...actual, existsSync: (target: string) => target === '/.dockerenv' ? dockerEnvironment.exists : actual.existsSync(target) }
})

useIsolatedEnvironment()

beforeEach(() => {
  dockerEnvironment.exists = false
  created.length = 0
  setEnvironment({ DEVCONTAINER: '1', REMOTE_CONTAINERS: undefined, CODESPACES: undefined })
})

interface Project {
  /**
  <root>/base/demo（main worktree）
  */
  readonly repository: string
  readonly root: string
}

interface ProjectOptions {
  /**
  worktree-config.json の中身。null なら置かない
  */
  readonly worktreeConfig?: string | false
  /**
  .worktreeignore の中身。null なら置かない
  */
  readonly ignore?: string | false
  readonly repositories?: readonly Readonly<Record<string, string>>[]
  /**
  アクティブなプロジェクト設定の中身。null なら置かない。文字列ならそのまま書く
  */
  readonly activeConfig?: string | false
  readonly aggregationRepository?: string
  /**
  main にコミットするファイル
  */
  readonly files?: Readonly<Record<string, string>>
  readonly originUrl?: string
}

const CLAUDE_LOCAL_LINK = '{"version": 3, "links": [{"path": "CLAUDE.local.md", "target_repo": "demo", "target_path": "CLAUDE.local.md"}]}\n'
const DEFAULT_REPOSITORIES: readonly Readonly<Record<string, string>>[] = [{ owner: 'acme', name: 'demo', develop_branch: 'develop' }]

const created: Project[] = []

function currentProject(): Project {
  const project = created.at(-1)
  if (project === undefined) throw new Error('createProject を先に呼ぶ')
  return project
}

function projectConfigJson(options: Readonly<ProjectOptions>): string {
  return JSON.stringify({
    host: 'github.com',
    owner: 'acme',
    project: { number: 1, id: 'PVT_test', fields: { workflow: { id: 'F', options: {} } } },
    repositories: options.repositories ?? DEFAULT_REPOSITORIES,
    ...options.aggregationRepository !== undefined && { aggregation_repo: options.aggregationRepository },
  })
}

// <root>/base/demo を実 git で作る。bare の origin に main・develop・release を push してから、origin の URL を GitHub 形式に付け替える
function createProject(options: Readonly<ProjectOptions> = {}): Project {
  const root = path.join(makeTemporaryDirectory(), 'workspaces')
  const repository = path.join(root, 'base', 'demo')
  createGitRepository({ 'README.md': 'x', '.gitignore': '.pecot/\n.env.local\n', ...options.files }, repository)
  gitForTest(repository, ['branch', 'develop'])
  gitForTest(repository, ['branch', 'release'])
  const bare = path.join(root, 'remotes', 'demo.git')
  mkdirSync(bare, { recursive: true })
  gitForTest(bare, ['init', '--bare', '-q'])
  gitForTest(repository, ['remote', 'add', 'origin', bare])
  gitForTest(repository, ['push', '-q', 'origin', 'main', 'develop', 'release'])
  gitForTest(repository, ['remote', 'set-url', 'origin', options.originUrl ?? 'https://github.com/acme/demo.git'])
  if (options.worktreeConfig !== false) writeTree(repository, { '.pecot/config/worktree-config.json': options.worktreeConfig ?? '{"version": 3, "links": []}\n' })
  if (options.ignore !== false) writeTree(repository, { '.pecot/config/.worktreeignore': options.ignore ?? '.git/\n.pecot/\n' })
  const configRoot = makeTemporaryDirectory()
  if (options.activeConfig !== false) {
    writeTree(configRoot, {
      '.pecot/config/projects/github.com_acme_1.json': options.activeConfig ?? projectConfigJson(options),
      '.pecot/config/projects/.active': 'github.com_acme_1.json\n',
    })
  }
  setEnvironment({ CLAUDE_PROJECT_DIR: configRoot })
  const project: Project = { repository, root }
  created.push(project)
  return project
}

async function run(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<ToolRunResult> {
  return await runInProcess(name, arguments_, TOOLS, { cwd: currentProject().repository })
}

// MCP のツールを、同じプロセスの中のクライアントから 1 回呼ぶ。作業ディレクトリの既定は main worktree
async function tool(name: string, toolArguments: Readonly<Record<string, unknown>>, cwd = currentProject().repository): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    return await callToolOnce(TOOLS, name, toolArguments)
  }
  finally {
    process.chdir(previous)
  }
}

const sharedLink = (worktree: string, destination: string): Record<string, unknown> => ({ path: path.join(worktree, 'CLAUDE.local.md'), destination })

function outsideGit(): string {
  const directory = makeTemporaryDirectory('pecot-nogit-')
  setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
  return directory
}

const UNREADABLE_REMOTE = 'could not read the repository from the URL of the Git remote origin'
const AMBIGUOUS_LINES = 'error: the repository is ambiguous\n  could not read the repository from the URL of the Git remote origin\n  give repo: <owner/repo>\n'

// origin を手元の bare リポのパスに付け替えて、URL から owner/repo を読めなくする
function useBareOrigin(project: Readonly<Project>): void {
  gitForTest(project.repository, ['remote', 'set-url', 'origin', path.join(project.root, 'remotes', 'demo.git')])
}

function leaveDevcontainer(): void {
  setEnvironment({ DEVCONTAINER: undefined })
}

// worktree_add を呼んで、作られた worktree のパスを返す
async function addWorktree(extra: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const result = await tool('worktree_add', { directory: currentProject().repository, ...extra })
  stepSync('worktree_add が成功したことを確かめる', () => {
    expect(result.structured['detail']).toBeUndefined()
    expect(result.isError).toBe(false)
  })
  return String(result.structured['path'])
}

function detailOf(result: Readonly<ToolOutcome>): string {
  return String(result.structured['detail'])
}

function branches(repository: string): readonly string[] {
  return gitForTest(repository, ['branch', '--format=%(refname:short)']).split('\n').filter(name => name !== '')
}

function worktreePaths(repository: string): readonly string[] {
  return gitForTest(repository, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  }
  catch {
    return false
  }
}

function upstreamOf(worktree: string): string {
  return gitForTest(worktree, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim()
}

const SECOND_LINK = '{"version": 3, "links": [{"path": "CLAUDE.local.md", "target_repo": "demo", "target_path": "CLAUDE.local.md"}, {"path": "second.md", "target_repo": "demo", "target_path": "second.md"}]}\n'

function initialProject(options: Readonly<ProjectOptions> = {}): Project {
  return createProject({ worktreeConfig: false, ignore: false, ...options })
}

function configPaths(repository: string): { readonly config: string, readonly ignore: string } {
  return { config: path.join(repository, '.pecot', 'config', 'worktree-config.json'), ignore: path.join(repository, '.pecot', 'config', '.worktreeignore') }
}

function writtenLinks(file: string): readonly { readonly path: string, readonly target_repo: string }[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('links' in parsed) || !Array.isArray(parsed.links)) throw new TypeError('links が無い')
  return parsed.links.map((link: unknown) => {
    if (typeof link !== 'object' || link === null || !('path' in link) || !('target_repo' in link) || typeof link.path !== 'string' || typeof link.target_repo !== 'string') throw new TypeError('link の形が違う')
    return { path: link.path, target_repo: link.target_repo }
  })
}

interface Obstacle {
  readonly kind: string
  readonly make: (file: string) => void
}

const OBSTACLES: readonly Obstacle[] = [
  { kind: '実ファイル', make: (file) => { writeFileSync(file, 'mine') } },
  { kind: 'ディレクトリ', make: (file) => { writeTree(file, { 'inner.txt': 'x' }) } },
]

interface ExistingRow {
  readonly name: string
  readonly options: Readonly<ProjectOptions>
  readonly kept: 'config' | 'ignore'
}

function targetsOf(file: string): ReadonlySet<string> {
  return new Set(writtenLinks(file).map(link => link.target_repo))
}

// CLAUDE.local.md を持つ project に、link を張っていない worktree（wt1 …）を作る
async function linkedProject(names: readonly string[] = ['wt1'], options: Readonly<ProjectOptions> = {}): Promise<{ readonly project: Project, readonly worktrees: readonly string[], readonly worktree: string }> {
  const project = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK, ...options })
  writeFileSync(path.join(project.repository, 'CLAUDE.local.md'), 'shared')
  writeFileSync(path.join(project.repository, 'second.md'), 'second')
  const worktrees: string[] = []
  for (const name of names) {
    const added = await addWorktree({ no_link: true })
    worktrees.push(added)
    stepSync('作った worktree の番号を確かめる', () => {
      expect(path.basename(path.dirname(added))).toBe(name)
    })
  }
  return { project, worktrees, worktree: worktrees[0] ?? '' }
}

// develop を進めて、既存の wt1（main の位置）と作り直した wt1 の位置が別になるようにする
function prepareExistingBranch(repository: string): void {
  gitForTest(repository, ['checkout', '-q', 'develop'])
  gitForTest(repository, ['commit', '-q', '--allow-empty', '-m', 'develop only'])
  gitForTest(repository, ['update-ref', 'refs/remotes/origin/develop', 'develop'])
  gitForTest(repository, ['checkout', '-q', 'main'])
  gitForTest(repository, ['branch', 'wt1', 'main'])
}

// 別の worktree が wt1 を checkout しているので、git branch -D が失敗する
async function removeWithBlockedBranch(): Promise<{ readonly repository: string, readonly result: ToolOutcome }> {
  const { repository, root } = createProject()
  const worktree = await addWorktree()
  gitForTest(worktree, ['checkout', '-q', '-b', 'feature'])
  gitForTest(repository, ['worktree', 'add', '-q', path.join(root, 'holder'), 'wt1'])
  const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
  return { repository, result }
}

describe('worktree_add', () => {
  it('リポジトリを directory に渡して呼ぶと、プロジェクトのルートの下の wtN にそのリポジトリの worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-01')
    await explains('`worktree_add` にリポジトリを `directory` で指定した場合のテストです。プロジェクトのルートの下の `wt1` に、そのリポジトリの worktree を作成することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(worktreePaths(repository)).toContain(path.join(root, 'wt1', 'demo'))
      expect(existsSync(path.join(root, 'wt1', 'demo', 'README.md'))).toBe(true)
    })
  })

  it('worktree を作ると、wtN と同じ名前のブランチを、使う remote の <remote>/<ベース> を upstream にして作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-02')
    await explains('worktree を作成した場合のテストです。`wt1` と同じ名前のブランチを、使う remote のベースブランチを upstream にして作成することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('worktree とブランチ・ブランチの位置を確かめる', () => {
      expect(branches(repository)).toContain('wt1')
      expect(gitForTest(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
      expect(upstreamOf(worktree)).toBe('origin/develop')
    })
  })

  it('このリポジトリの worktree がまだ使っていない wtN があると、その中で番号が最小のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-03')
    await explains('このリポジトリの worktree がまだ使っていない `wtN` が存在する場合のテストです。その中で番号が最も小さいセットに worktree を作成することを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('使用中の wtN の置き場を作る', () => {
      mkdirSync(path.join(root, 'wt1', 'other'), { recursive: true })
      mkdirSync(path.join(root, 'wt2', 'demo'), { recursive: true })
    })
    const addedPath = await step('worktree を足す', () => addWorktree())
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt1', 'demo'))
    })
  })

  it('path の worktree が wt1 を使っていても、それを数えて次の番号のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-03')
    await verifies(context, 'PW-WORKTREE-ADD-04')
    await explains('`path` で指定した worktree が `wt1` を使っている場合のテストです。それも数えて、次の番号のセットに worktree を作成することを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('wt1 を使う worktree を別の場所に足す', () => addWorktree({ path: path.join(root, 'elsewhere', 'demo') }))
    const addedPath = await step('次の番号の worktree を足す', () => addWorktree())
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt2', 'demo'))
    })
  })

  it('すべての wtN をこのリポジトリの worktree が既に使っていると、最大の番号の次のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-04')
    await explains('すべての `wtN` を、このリポジトリの worktree が既に使っている場合のテストです。最大の番号の次のセットに worktree を作成することを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('wt1 と wt2 に worktree を足す', async () => {
      await addWorktree()
      await addWorktree()
    })
    const addedPath = await step('最大の番号の次に worktree を足す', () => addWorktree())
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt3', 'demo'))
    })
  })

  it('base を付けて呼ぶと、そのブランチをベースにする', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-05')
    await explains('`base` を指定して実行した場合のテストです。指定したブランチをベースにして、その remote ブランチを upstream にすることを確認します。')
    stepSync('リポジトリと設定を持つプロジェクトを用意する', () => {
      createProject()
    })
    const worktree = await step('base を指定して worktree を足す', () => addWorktree({ base: 'release' }))
    stepSync('ブランチの位置を確かめる', () => {
      expect(upstreamOf(worktree)).toBe('origin/release')
    })
  })

  it('base を省いて呼ぶと、アクティブなプロジェクトの設定の develop_branch をベースにする', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-06')
    await explains('`base` を省略して実行した場合のテストです。アクティブなプロジェクトの設定にある `develop_branch` をベースにすることを確認します。')
    stepSync('リポジトリと設定を持つプロジェクトを用意する', () => {
      createProject()
    })
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('ブランチの位置を確かめる', () => {
      expect(upstreamOf(worktree)).toBe('origin/develop')
    })
  })

  it('path を付けて呼ぶと、その場所に worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-07')
    await explains('`path` を指定して実行した場合のテストです。指定した場所に worktree を作成し、既定の `wt1` は作成しないことを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const target = stepSync('作る場所を決める', () => path.join(root, 'custom', 'place'))
    const addedPath = await step('場所を指定して worktree を足す', () => addWorktree({ path: target }))
    stepSync('worktree とブランチを確かめる', () => {
      expect(addedPath).toBe(target)
      expect(worktreePaths(repository)).toContain(target)
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('no_link を付けて呼ぶと、シンボリックリンクを作らない', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-08')
    await explains('`no_link` を指定して実行した場合のテストです。指定しない場合はシンボリックリンクを作成し、指定した場合は作成しないことを確認します。')
    const { repository } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK }))
    stepSync('リンク元の CLAUDE.local.md を書く', () => {
      writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'local')
    })
    const withLink = await step('worktree を足す', () => addWorktree())
    stepSync('リンクを確かめる', () => {
      expect(isSymlink(path.join(withLink, 'CLAUDE.local.md'))).toBe(true)
    })
    const withoutLink = await step('リンクを張らずに worktree を足す', () => addWorktree({ no_link: true }))
    stepSync('リンクを張っていないことを確かめる', () => {
      expect(existsSync(path.join(withoutLink, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  it('no_copy を付けて呼ぶと、未追跡のファイルをコピーしない', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-09')
    await explains('`no_copy` を指定して実行した場合のテストです。指定しない場合は未追跡のファイルをコピーし、指定した場合はコピーしないことを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('未追跡のファイルを置く', () => {
      writeFileSync(path.join(repository, '.env.local'), 'TOKEN=1')
    })
    const copied = await step('worktree を足す', () => addWorktree())
    stepSync('ファイルの中身を確かめる', () => {
      expect(readFileSync(path.join(copied, '.env.local'), 'utf8')).toBe('TOKEN=1')
    })
    const notCopied = await step('コピーせずに worktree を足す', () => addWorktree({ no_copy: true }))
    stepSync('ファイルの中身を確かめる', () => {
      expect(existsSync(path.join(notCopied, '.env.local'))).toBe(false)
    })
  })

  it('setup を付けて呼ぶと、worktree の中でそのコマンドを実行する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-10')
    await explains('`setup` を指定して実行した場合のテストです。作成した worktree の中で、そのコマンドを実行することを確認します。')
    stepSync('リポジトリと設定を持つプロジェクトを用意する', () => {
      createProject()
    })
    const worktree = await step('setup を付けて worktree を足す', () => addWorktree({ setup: 'echo ran > setup-ran.txt' }))
    stepSync('ファイルの中身を確かめる', () => {
      expect(readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8')).toBe('ran\n')
    })
  })

  it('setup を省いて worktree-config.json に setup_command があると、worktree の中でそのコマンドを実行する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-11')
    await explains('`setup` を省略し、`worktree-config.json` に `setup_command` が存在する場合のテストです。worktree の中で、そのコマンドを実行することを確認します。')
    stepSync('setup_command を持つプロジェクトを用意する', () => {
      createProject({ worktreeConfig: '{"version": 3, "links": [], "setup_command": "echo configured > setup-ran.txt"}\n' })
    })
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('ファイルの中身を確かめる', () => {
      expect(readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8')).toBe('configured\n')
    })
  })

  it('allow_existing_branch を付けて呼ぶと、upstream の違う既存のブランチを再利用する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-12')
    await explains('`allow_existing_branch` を指定して実行した場合のテストです。upstream が異なる既存のブランチを再利用して、worktree を作成することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('upstream の違う既存のブランチを用意する', () => {
      prepareExistingBranch(repository)
    })
    const worktree = await step('既存のブランチを再利用して worktree を足す', () => addWorktree({ allow_existing_branch: true }))
    stepSync('ブランチの位置を確かめる', () => {
      expect(gitForTest(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
      expect(gitForTest(worktree, ['rev-parse', 'HEAD']).trim()).toBe(gitForTest(repository, ['rev-parse', 'main']).trim())
    })
  })

  it('force を付けて呼ぶと、allow_existing_branch と同じく既存のブランチを再利用する', async () => {
    await explains(' `force` を指定して実行した場合のテストです。`allow_existing_branch` と同様に、既存のブランチを再利用することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('upstream の違う既存のブランチを用意する', () => {
      prepareExistingBranch(repository)
    })
    const result = await step('既存のブランチを再利用して worktree を足す', () => run('worktree_add', { directory: repository, allow_existing_branch: true }))
    stepSync('標準出力・終了コードを確かめる', () => {
      expect(result.code).toBe(0)
      expect(gitForTest(result.stdout.trim(), ['rev-parse', 'HEAD']).trim()).toBe(gitForTest(repository, ['rev-parse', 'main']).trim())
    })
  })

  it('worktree を作ると、created の行を標準エラーに、worktree のパスを標準出力に出す', async () => {
    await explains(' worktree を作成した場合のテストです。`created` の行を標準エラーに、worktree のパスを標準出力に出力することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('worktree を足す', () => run('worktree_add', { directory: repository }))
    stepSync('標準エラー・標準出力を確かめる', () => {
      expect(result.code).toBe(0)
      expect(result.stderr).toContain(`created: worktree wt1 at ${path.join(root, 'wt1', 'demo')} (branch wt1 from develop)\n`)
      expect(result.stdout).toBe(`${path.join(root, 'wt1', 'demo')}\n`)
    })
  })

  it('シンボリックリンクを作ると、作った数を symlinks created の count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-18')
    await explains('シンボリックリンクを作成した場合のテストです。作成した数を `count: symlinks created` の行で、標準エラーに出力することを確認します。')
    const { repository } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK }))
    stepSync('リンク元の CLAUDE.local.md を書く', () => {
      writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'local')
    })
    const result = await step('worktree を足す', () => run('worktree_add', { directory: repository }))
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(result.stderr).toContain('count: symlinks created: 1\n')
    })
  })

  it('作らなかったリンクか作れなかったリンクがあると、その数を count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-19')
    await explains('作成しなかったリンクまたは作成に失敗したリンクが存在する場合のテストです。その数を `count` の行で、標準エラーに出力することを確認します。')
    const { repository } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK }))
    const result = await step('1 回目の worktree を足す', () => run('worktree_add', { directory: repository }))
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(result.stderr).toContain('count: symlinks created: 0\n')
      expect(result.stderr).toContain('count: symlinks skipped: 1\n')
    })
    const { repository: tracked } = stepSync('git が追跡するリンク元を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK, files: { 'CLAUDE.local.md': 'tracked' } }))
    const failed = await step('2 回目の worktree を足す', () => run('worktree_add', { directory: tracked }))
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(failed.stderr).toContain('count: symlink errors: 1\n')
    })
  })

  it('未追跡のファイルをコピーすると、コピーした数を files copied の count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-20')
    await explains('未追跡のファイルをコピーした場合のテストです。コピーした数を `count: files copied` の行で、標準エラーに出力することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('未追跡のファイルを置く', () => {
      writeFileSync(path.join(repository, '.env.local'), 'TOKEN=1')
    })
    const result = await step('worktree を足す', () => run('worktree_add', { directory: repository }))
    stepSync('標準エラーを確かめる', () => {
      expect(result.stderr).toContain('count: files copied: 1\n')
    })
  })

  it.skipIf(process.getuid?.() === 0)('コピーできなかったファイルがあると、そのファイルごとの文を warnings に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-21')
    await explains('未追跡のファイルを読み取れずコピーに失敗する場合のテストです。ファイルごとの文を `warnings` に含めて、成功が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const secret = stepSync('読めない権限にする', () => {
      const secret = path.join(repository, '.env.local')
      writeFileSync(secret, 'TOKEN=1')
      chmodSync(secret, 0o000)
      return secret
    })
    const result = await step('worktree を足す', async () => {
      try {
        return await tool('worktree_add', { directory: repository })
      }
      finally {
        chmodSync(secret, 0o644)
      }
    })
    stepSync('warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^copy .*\.env\.local: /u)])
    })
  })

  it('リンク先が無いと、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    await explains('リンク先が存在しない場合のテストです。そのリンクを作成せず、`warnings` に警告が 1 つ含まれることを確認します。')
    const { repository, root } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK }))
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(path.join(root, 'wt1', 'demo', 'CLAUDE.local.md'))).toBe(false)
      expect(result.structured['warnings']).toEqual([`target does not exist: ${path.join(repository, 'CLAUDE.local.md')}`])
    })
  })

  it('リンクのパスを git が追跡していると、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    await explains('リンクのパスを git が追跡している場合のテストです。そのリンクを作成せず、`warnings` に警告が 1 つ含まれることを確認します。')
    const { repository, root } = stepSync('git が追跡するリンク元を持つプロジェクトを用意する', () => createProject({ worktreeConfig: CLAUDE_LOCAL_LINK, files: { 'CLAUDE.local.md': 'tracked' } }))
    stepSync('リンク元の CLAUDE.local.md を書く', () => {
      writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'tracked')
    })
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('リンク・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(isSymlink(path.join(root, 'wt1', 'demo', 'CLAUDE.local.md'))).toBe(false)
      expect(result.structured['warnings']).toEqual([`symlink creation skipped because the path is tracked by git: ${path.join(root, 'wt1', 'demo', 'CLAUDE.local.md')}`])
    })
  })

  it('リンクを作れないと、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    await explains('リンクを作成できない場合のテストです。そのリンクを作成せず、`warnings` に警告が 1 つ含まれることを確認します。')
    const link = stepSync('worktree-config.json の中身を決める', () => '{"version": 3, "links": [{"path": "blocked/inner", "target_repo": "demo", "target_path": "README.md"}]}\n')
    const { repository, root } = stepSync('リンクを作れない設定のプロジェクトを用意する', () => createProject({ worktreeConfig: link, files: { blocked: 'a file' } }))
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('リンク・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(isSymlink(path.join(root, 'wt1', 'demo', 'blocked', 'inner'))).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^failed to create the symlink: /u)])
    })
  })

  it.for([
    { name: '失敗した', config: '{"version": 3, "links": []}\n', setup: 'echo oops >&2; exit 3', expected: 'setup command failed (exit 3)' },
    { name: '時間切れになった', config: '{"version": 3, "links": [], "setup_command_timeout": 1}\n', setup: 'sleep 20', expected: 'setup command timed out' },
  ])('setup のコマンドが$name と、warnings に 1 つ入れ、setupFailed を true にして成功を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-24')
    await verifies(context, 'PW-WORKTREE-ADD-25')
    await explains(`\`setup\` のコマンドが${row.name}場合のテストです。\`warnings\` に警告が 1 つ含まれ、\`setupFailed\` が \`true\` になり、成功が返ることを確認します。`)
    const { repository } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: row.config }))
    const result = await step('setup を付けて worktree を足す', () => tool('worktree_add', { directory: repository, setup: row.setup }))
    stepSync('warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured).toMatchObject({ setupFailed: true, warnings: [expect.stringContaining(row.expected)] })
    })
  })

  it('引数 repo が今の git の remote と食い違うと、何も作らず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-26')
    await verifies(context, 'PW-WORKTREE-ADD-27')
    await explains('`repo` の引数が現在の git の remote と一致しない場合のテストです。何も作成せず、`repo-mismatch` の失敗が返ることを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('repo を食い違わせて worktree を足す', () => tool('worktree_add', { directory: repository, repo: 'other/thing' }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
      expect(branches(repository)).not.toContain('wt1')
    })
  })

  it('repo を省いて git の外で呼ぶと、the repository is ambiguous の文を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-28')
    await verifies(context, 'PW-WORKTREE-ADD-29')
    await explains('`repo` を省略し、git の外で実行した場合のテストです。`the repository is ambiguous` の文を `detail` に含めた、`git-unresolved` の失敗が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('git の外から worktree を足す', () => tool('worktree_add', { directory: repository }, outsideGit()))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
    })
  })

  it('devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-30')
    await verifies(context, 'PW-WORKTREE-ADD-31')
    await explains('devcontainer の外で実行した場合のテストです。理由を `detail` に含めた失敗が返り、worktree を作成しないことを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('devcontainer の外にする', () => {
      leaveDevcontainer()
    })
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^this tool must run inside a devcontainer\n/u)
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('directory が git のリポジトリでなく、メインの worktree を見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-32')
    await explains('`directory` が git のリポジトリではなく、メインの worktree を取得できない場合のテストです。失敗が返ることを確認します。')
    stepSync('リポジトリと設定を持つプロジェクトを用意する', () => {
      createProject()
    })
    const result = await step('git の外から worktree を足す', () => tool('worktree_add', { directory: outsideGit() }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^cannot get the worktree list/u)
    })
  })

  it('リポジトリが <ルート>/base/<リポジトリ> の配置に無いと、何も作らず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-33')
    await verifies(context, 'PW-WORKTREE-ADD-34')
    await explains('リポジトリが `<ルート>/base/<リポジトリ>` の配置になっていない場合のテストです。何も作成せず、配置の誤りを示す失敗が返ることを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const misplaced = stepSync('配置の誤ったパスを決める', () => path.join(root, 'misplaced', 'demo'))
    stepSync('配置の誤ったリポジトリを用意する', () => {
      createGitRepository({ 'README.md': 'x' }, misplaced)
    })
    const result = await step('配置の誤ったリポジトリで worktree を足す', () => tool('worktree_add', { directory: misplaced }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toContain('is not placed in the layout pecot expects')
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it.for([{ name: 'worktree-config.json', file: 'worktree-config.json' }, { name: '.worktreeignore', file: '.worktreeignore' }])('$name が無いと、worktree_init を促す文を detail に入れて、kind が not-initialized の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-35')
    await verifies(context, 'PW-WORKTREE-ADD-36')
    await explains(`\`${row.name}\` が存在しない場合のテストです。\`worktree_init\` を案内する文を \`detail\` に含めた、\`not-initialized\` の失敗が返ることを確認します。`)
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('設定ファイルを消す', () => {
      rmSync(path.join(repository, '.pecot', 'config', row.file))
    })
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
      expect(detailOf(result)).toContain('worktree_init')
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('worktree-config.json が無いと、worktree_init を促す error の行を標準エラーに出す', async () => {
    await explains(' `worktree-config.json` が存在しない場合のテストです。`worktree_init` を案内する `error` の行を標準エラーに出力し、終了コード 1 で終了することを確認します。')
    const { repository } = stepSync('worktree-config.json が無いプロジェクトを用意する', () => createProject({ worktreeConfig: false }))
    const result = await step('worktree を足す', () => run('worktree_add', { directory: repository }))
    stepSync('標準エラー・終了コードを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('call worktree_init to generate the template')
    })
  })

  it.for<{ readonly name: string, readonly options: Readonly<ProjectOptions>, readonly message: string }>([
    { name: 'プロジェクトの設定が無い', options: { activeConfig: false }, message: 'is not in any project config' },
    { name: 'リポジトリがどの設定にも無い', options: { repositories: [{ owner: 'acme', name: 'other', develop_branch: 'main' }] }, message: 'is not in any project config' },
  ])('$name と、何も作らず、失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-37')
    await verifies(context, 'PW-WORKTREE-ADD-38')
    await explains(`${row.name}場合のテストです。何も作成せず、\`is not in any project config\` を含む失敗が返ることを確認します。`)
    const { repository, root } = stepSync('行ごとの設定のプロジェクトを用意する', () => createProject(row.options))
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toContain(row.message)
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
      expect(branches(repository)).not.toContain('wt1')
    })
  })

  it('.active が無くても、remote のリポを含む設定が 1 つなら、その設定で作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-55')
    await explains('`.active` が存在しなくても、remote のリポジトリを含む設定が 1 つだけ存在する場合のテストです。その設定を使って worktree を作成することを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('.active を消して設定を 2 つにする', () => {
      rmSync(path.join(process.env['CLAUDE_PROJECT_DIR'] ?? '', '.pecot', 'config', 'projects', '.active'))
    })
    const addedPath = await step('worktree を足す', () => addWorktree())
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt1', 'demo'))
    })
  })

  it('remote のリポを含む設定が 2 つで選べなければ止まり、project を付けるとその設定で作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-37')
    await verifies(context, 'PW-WORKTREE-ADD-38')
    await verifies(context, 'PW-WORKTREE-ADD-56')
    await explains('remote のリポジトリを含む設定が 2 つ存在し、どちらを使うか選べない場合のテストです。失敗が返り、`project` を指定するとその設定で worktree を作成することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('.active を消して設定を 2 つにする', () => {
      const configRoot = process.env['CLAUDE_PROJECT_DIR'] ?? ''
      rmSync(path.join(configRoot, '.pecot', 'config', 'projects', '.active'))
      writeTree(configRoot, { '.pecot/config/projects/github.com_acme_2.json': projectConfigJson({}) })
    })
    const ambiguous = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(ambiguous.isError).toBe(true)
      expect(detailOf(ambiguous)).toContain('acme/demo is in 2 project configs')
      expect(detailOf(ambiguous)).toContain('project: <NAME>')
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
    const addedPath = await step('project を指定して worktree を足す', () => addWorktree({ project: 'github.com_acme_2' }))
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt1', 'demo'))
    })
  })

  it('使う remote の URL を GitHub の owner/repo として読めないと、何も作らず、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-39')
    await verifies(context, 'PW-WORKTREE-ADD-40')
    await explains('使う remote の URL から GitHub の owner と repo を取得できない場合のテストです。何も作成せず、`git-unresolved` の失敗が返ることを確認します。')
    const { root, matching } = stepSync('origin の URL を読めないプロジェクトと別のリポジトリを用意する', () => {
      const { root } = createProject({ originUrl: 'not a url' })
      const matching = createGitRepository()
      return { root, matching }
    })
    stepSync('remote を付け替える', () => {
      gitForTest(matching, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    })
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: path.join(root, 'base', 'demo') }, matching))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('cannot get the repository information: check that a git remote is set')
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('base を省いて develop_branch が設定に無いと、何も作らず、kind が repo-setting-missing の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-41')
    await verifies(context, 'PW-WORKTREE-ADD-42')
    await explains('`base` を省略し、設定に `develop_branch` が存在しない場合のテストです。何も作成せず、`repo-setting-missing` の失敗が返ることを確認します。')
    const { repository, root } = stepSync('develop_branch が無い設定のプロジェクトを用意する', () => createProject({ repositories: [{ owner: 'acme', name: 'demo' }] }))
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-setting-missing' } })
      expect(detailOf(result)).toContain('develop_branch is not set for repository acme/demo')
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
    await step('base を指定して worktree を足す', async () => {
      await addWorktree({ base: 'develop' })
    })
  })

  it('wt1 から wt9 までのセットがすべて使われていても、最大の番号の次の wt10 のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-04')
    await explains('`wt1` から `wt9` までのセットがすべて使われている場合のテストです。最大の番号の次の `wt10` のセットに、worktree を作成することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('wt1 から wt9 までを使用中にする', () => {
      for (let number = 1; number <= 9; number += 1) gitForTest(repository, ['worktree', 'add', '-q', '-b', `wt${String(number)}`, path.join(root, 'used', String(number))])
    })
    const addedPath = await step('worktree を足す', () => addWorktree())
    stepSync('作った worktree の場所を確かめる', () => {
      expect(addedPath).toBe(path.join(root, 'wt10', 'demo'))
      expect(worktreePaths(repository)).toContain(path.join(root, 'wt10', 'demo'))
    })
  })

  it('同じ名前のブランチが別の upstream で既にあり allow_existing_branch が無いと、何も作らず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-45')
    await verifies(context, 'PW-WORKTREE-ADD-46')
    await explains('同じ名前のブランチが別の upstream で既に存在し、`allow_existing_branch` を指定していない場合のテストです。何も作成せず、失敗が返ることを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('wt1 ブランチを先に作る', () => {
      gitForTest(repository, ['branch', 'wt1', 'main'])
    })
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toContain(`branch 'wt1' already exists and its upstream differs`)
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('git worktree_add に失敗すると、git の理由の行を detail に、git の出力の全文を log に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-47')
    await verifies(context, 'PW-WORKTREE-ADD-48')
    await explains('`git worktree_add` が失敗する場合のテストです。git が出力した理由の行を `detail` に、出力の全文を `log` に含めた失敗が返ることを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const occupied = stepSync('使用済みのディレクトリを用意する', () => {
      const occupied = path.join(root, 'occupied')
      writeTree(occupied, { 'file.txt': 'x' })
      return occupied
    })
    const result = await step('場所を指定して worktree を足す', () => tool('worktree_add', { directory: repository, path: occupied }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^failed to create the worktree: fatal: '.+occupied' already exists$/u)
      expect(result.structured['log']).toMatch(/^Preparing worktree .*\nfatal: '.+occupied' already exists\n$/u)
    })
  })

  it('worktree を作った後に worktree-config.json を読めないと、worktree とブランチを残し、kind が config-invalid の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-49')
    await verifies(context, 'PW-WORKTREE-ADD-50')
    await explains('worktree の作成後に `worktree-config.json` を読み込めない場合のテストです。worktree とブランチを残したまま、`config-invalid` の失敗が返ることを確認します。')
    const { repository, root } = stepSync('形の誤った worktree-config.json のプロジェクトを用意する', () => createProject({ worktreeConfig: '{"version": 3, "links": "x"}\n' }))
    const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
    stepSync('worktree とブランチ・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      expect(detailOf(result)).toContain('failed to load the worktree config: ')
      expect(worktreePaths(repository)).toContain(path.join(root, 'wt1', 'demo'))
      expect(branches(repository)).toContain('wt1')
    })
  })

  it('path を付けて呼ぶと、リンクと .pecot/.gitignore もその場所に作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-51')
    await explains('`path` を指定して実行した場合のテストです。リンクと `.pecot/.gitignore` も、指定した場所に作成することを確認します。')
    const link = stepSync('リンクの設定と元ファイルを用意する', () => '{"version": 3, "links": [{"path": ".pecot/config/hooks-config.json", "target_repo": "demo", "target_path": ".pecot/config/hooks-config.json"}]}\n')
    const { repository, root } = stepSync('リンクの設定を持つプロジェクトを用意する', () => createProject({ worktreeConfig: link }))
    const target = stepSync('リンクの設定と元ファイルを用意する', () => {
      writeTree(repository, { '.pecot/config/hooks-config.json': '{}' })
      const target = path.join(root, 'custom', 'place')
      return target
    })
    const addedPath = await step('場所を指定して worktree を足す', () => addWorktree({ path: target }))
    stepSync('リンクを確かめる', () => {
      expect(addedPath).toBe(target)
      expect(isSymlink(path.join(target, '.pecot', 'config', 'hooks-config.json'))).toBe(true)
      expect(existsSync(path.join(target, '.pecot', '.gitignore'))).toBe(true)
      expect(isSymlink(path.join(target, '.pecot', '.gitignore'))).toBe(false)
    })
  })

  it('origin が無く、登録済みのリポを指す remote があると、その中で最初の remote を使う', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-52')
    await explains('`origin` が存在せず、登録済みのリポジトリを指す remote が存在する場合のテストです。その中で最初の remote を使うことを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('remote を付け替える', () => {
      gitForTest(repository, ['remote', 'add', 'aaa', 'https://github.com/elsewhere/unregistered.git'])
      gitForTest(repository, ['remote', 'rename', 'origin', 'upstream'])
    })
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('ブランチの位置を確かめる', () => {
      expect(upstreamOf(worktree)).toBe('upstream/develop')
    })
  })

  it('origin のリポが設定に無く、別の remote のリポが設定にあると、その remote を使う', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-57')
    await explains('`origin` のリポジトリが設定に存在せず、別の remote のリポジトリが設定に存在する場合のテストです。その別の remote を使うことを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    stepSync('remote を付け替える', () => {
      gitForTest(repository, ['remote', 'rename', 'origin', 'upstream'])
      gitForTest(repository, ['remote', 'add', 'origin', 'https://github.com/elsewhere/unregistered.git'])
    })
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('ブランチの位置を確かめる', () => {
      expect(upstreamOf(worktree)).toBe('upstream/develop')
    })
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れ、使う remote の URL を読めないので終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-ADD-53')
      await explains('remote の URL から owner と repo を取得できず、`repo` を指定した場合のテストです。`warning` の行を標準エラーに出力し、同じ文を `warnings` に含め、失敗することを確認します。')
      const project = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の repo を渡して worktree を足す', () => run('worktree_add', { directory: project.repository, repo: 'acme/demo' }))
      stepSync('標準エラー・終了コードを確かめる', () => {
        expect(cli.code).toBe(1)
        expect(cli.stderr).toBe(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\nerror: cannot get the repository information: check that a git remote is set to a GitHub repository URL\n`)
      })
      const result = await step('2 回目の repo を渡して worktree を足す', () => tool('worktree_add', { directory: project.repository, repo: 'acme/demo' }))
      stepSync('warnings・失敗の kind と detail を確かめる', () => {
        expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(detailOf(result)).toContain('cannot get the repository information: check that a git remote is set')
      })
    })

    it('repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-ADD-54')
      await explains('remote の URL から owner と repo を取得できず、`repo` を省略した場合のテストです。`the repository is ambiguous` と理由の行を出力し、終了コード 1 で終了することを確認します。')
      const project = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の worktree を足す', () => run('worktree_add', { directory: project.repository }))
      stepSync('worktree とブランチ・標準エラーを確かめる', () => {
        expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
        expect(worktreePaths(project.repository)).toEqual([project.repository])
      })
      const result = await step('2 回目の worktree を足す', () => tool('worktree_add', { directory: project.repository }))
      stepSync('失敗の kind と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(detailOf(result)).toContain('the repository is ambiguous')
        expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
      })
    })
  })

  describe('MCP の data', () => {
    it('worktree を作ると、名前・パス・ブランチ・base・setupFailed を返す', async (context) => {
      await verifies(context, 'PW-COMMON-20')
      await verifies(context, 'PW-WORKTREE-ADD-14')
      await verifies(context, 'PW-WORKTREE-ADD-15')
      await explains('MCP で worktree を作成した場合のテストです。名前・パス・ブランチ・ベース・`setupFailed` を返すことを確認します。')
      const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      const result = await step('worktree を足す', () => tool('worktree_add', { directory: repository }))
      const worktree = stepSync('期待する worktree のパスを決める', () => path.join(root, 'wt1', 'demo'))
      stepSync('structuredContent を比べる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured).toEqual({ name: 'wt1', path: worktree, branch: 'wt1', base: 'develop', setupFailed: false })
      })
    })

    it('setup のコマンドが失敗すると、setupFailed を true にして、warning を返す', async (context) => {
      await verifies(context, 'PW-COMMON-19')
      await explains('MCP で `setup` のコマンドが失敗した場合のテストです。`setupFailed` を `true` にして、警告を返すことを確認します。')
      const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      const result = await step('setup を付けて worktree を足す', () => tool('worktree_add', { directory: repository, setup: 'exit 3' }))
      stepSync('warnings を確かめる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured).toMatchObject({ name: 'wt1', setupFailed: true })
        expect(result.structured['warnings']).toEqual([expect.stringContaining('setup command failed (exit 3)')])
      })
    })
  })
})

describe('worktree_init', () => {
  it('設定ファイルの無いリポジトリを directory に渡して呼ぶと、メインの worktree に worktree-config.json と .worktreeignore を書く', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-01')
    await verifies(context, 'PW-WORKTREE-INIT-02')
    await explains('設定ファイルが存在しないリポジトリを `directory` に指定して `worktree_init` を実行した場合のテストです。メインの worktree に `worktree-config.json` と `.worktreeignore` を書き込むことを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: repository }))
    stepSync('成功を確かめる', () => {
      expect(result.isError).toBe(false)
    })
    const files = stepSync('設定ファイルのパスを決める', () => configPaths(repository))
    stepSync('ファイルの中身・書いた設定を確かめる', () => {
      expect(writtenLinks(files.config).map(link => link.path)).toEqual(['CLAUDE.local.md', '.env', '.claude/settings.local.json', '.pecot/config/hooks-config.json', '.pecot/config/projects/.active', '.pecot/work'])
      expect(readFileSync(files.ignore, 'utf8')).toContain('node_modules/\n')
    })
  })

  it('サブのディレクトリを directory に渡しても、メインの worktree に書く', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-01')
    await explains('サブディレクトリを `directory` に指定して `worktree_init` を実行した場合のテストです。メインの worktree に、設定ファイルを書き込むことを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    stepSync('サブディレクトリを作る', () => {
      mkdirSync(path.join(repository, 'sub'))
    })
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: path.join(repository, 'sub') }))
    stepSync('書いた設定を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(configPaths(repository).config)).toBe(true)
    })
  })

  it('アクティブなプロジェクトに aggregation_repo があると、共有する 3 つのリンクをそのリポジトリに向ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-03')
    await explains('アクティブなプロジェクトに `aggregation_repo` が存在する場合のテストです。共有する 3 つのリンクを、そのリポジトリに向けることを確認します。')
    const { repository } = stepSync('集約リポジトリを持つプロジェクトを用意する', () => initialProject({ aggregationRepository: 'acme/hub' }))
    await step('設定のひな形を作る', async () => {
      await tool('worktree_init', { directory: repository })
    })
    stepSync('書いた設定を確かめる', () => {
      expect(writtenLinks(configPaths(repository).config).map(link => link.target_repo)).toEqual(['hub', 'hub', 'hub', 'demo', 'demo', 'demo'])
    })
  })

  it('アクティブなプロジェクトが無いか aggregation_repo が無いと、共有する 3 つのリンクをこのリポジトリに向ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-04')
    await explains('アクティブなプロジェクトまたは `aggregation_repo` が存在しない場合のテストです。共有する 3 つのリンクを、このリポジトリに向けることを確認します。')
    const withoutAggregation = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    await step('1 回目の設定のひな形を作る', async () => {
      await tool('worktree_init', { directory: withoutAggregation.repository })
    })
    stepSync('書いた設定を確かめる', () => {
      expect(targetsOf(configPaths(withoutAggregation.repository).config)).toEqual(new Set(['demo']))
    })
    const withoutProject = stepSync('有効な設定を変えたプロジェクトを用意する', () => initialProject({ activeConfig: false }))
    const result = await step('2 回目の設定のひな形を作る', () => tool('worktree_init', { directory: withoutProject.repository }))
    stepSync('書いた設定を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(targetsOf(configPaths(withoutProject.repository).config)).toEqual(new Set(['demo']))
    })
  })

  it('ファイルを書くと、ファイルごとに created の行を標準エラーに出す', async () => {
    await explains(' `worktree_init` を実行した場合のテストです。ファイルごとに `created` の行を、標準エラーに出力することを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    const result = await step('設定のひな形を作る', () => run('worktree_init', { directory: repository }))
    const files = stepSync('設定ファイルのパスを決める', () => configPaths(repository))
    stepSync('標準エラーを確かめる', () => {
      expect(result.stderr).toBe(`created: worktree config ${files.config}\ncreated: worktree ignore file ${files.ignore}\n`)
    })
  })

  it.for<ExistingRow>([
    { name: 'worktree-config.json', options: { ignore: false }, kept: 'config' },
    { name: '.worktreeignore', options: { worktreeConfig: false }, kept: 'ignore' },
  ])('$name が既にあると、何も書かず、既存のファイルのパスを detail に入れて、kind が already-exists の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-INIT-06')
    await verifies(context, 'PW-WORKTREE-INIT-07')
    await verifies(context, 'PW-WORKTREE-INIT-08')
    await explains(`\`${row.name}\` が既に存在する場合のテストです。何も書き込まず、既存のファイルのパスを \`detail\` に含めた、\`already-exists\` の失敗が返ることを確認します。`)
    const { repository } = stepSync('行ごとの設定のプロジェクトを用意する', () => createProject(row.options))
    const { existing, other, before } = stepSync('設定ファイルのパスを決める', () => {
      const files = configPaths(repository)
      const existing = files[row.kept]
      const other = row.kept === 'config' ? files.ignore : files.config
      const before = readFileSync(existing, 'utf8')
      return { existing, other, before }
    })
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: repository }))
    stepSync('ファイルの中身・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'already-exists' } })
      expect(detailOf(result)).toBe(`worktree config already exists\n  ${existing}`)
      expect(existsSync(other)).toBe(false)
      expect(readFileSync(existing, 'utf8')).toBe(before)
    })
  })

  it('設定ファイルが既にあると、既存のファイルのパスを error の行に出し、終了コード 1 で終わる', async () => {
    await explains(' `worktree_init` を実行し、設定ファイルが既に存在する場合のテストです。既存のファイルのパスを `error` の行に出力し、終了コード 1 で終了することを確認します。')
    const { repository } = stepSync('.worktreeignore が無いプロジェクトを用意する', () => createProject({ ignore: false }))
    const result = await step('設定のひな形を作る', () => run('worktree_init', { directory: repository }))
    stepSync('標準エラー・終了コードを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`error: worktree config already exists\n  ${configPaths(repository).config}\n`)
    })
  })

  it('メインの worktree を見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-09')
    await explains('メインの worktree を取得できない場合のテストです。`worktree_init` が失敗を返すことを確認します。')
    stepSync('worktree の設定が無いプロジェクトを用意する', () => {
      initialProject()
    })
    const result = await step('git の外から設定のひな形を作る', () => tool('worktree_init', { directory: outsideGit() }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^cannot get the worktree list/u)
    })
  })

  it('引数 repo が今の git の remote と食い違うと、何も書かず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-10')
    await verifies(context, 'PW-WORKTREE-INIT-11')
    await explains('`worktree_init` に、現在の git の remote と一致しない `repo` を指定した場合のテストです。何も書き込まず、`repo-mismatch` の失敗が返ることを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    const result = await step('repo を食い違わせて設定のひな形を作る', () => tool('worktree_init', { directory: repository, repo: 'other/thing' }))
    stepSync('失敗の kind と detail・書いた設定を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(existsSync(configPaths(repository).config)).toBe(false)
    })
  })

  it('worktree_init で、repo を省き git の外で呼ぶと、the repository is ambiguous を detail に入れ、git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-12')
    await verifies(context, 'PW-WORKTREE-INIT-13')
    await explains('`repo` を省略し、git の外で `worktree_init` を実行した場合のテストです。`the repository is ambiguous` の文を `detail` に含めた、`git-unresolved` の失敗が返ることを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    const result = await step('git の外から設定のひな形を作る', () => tool('worktree_init', { directory: repository }, outsideGit()))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
    })
  })

  it('worktree_init で、devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-14')
    await verifies(context, 'PW-WORKTREE-INIT-15')
    await explains('devcontainer の外で `worktree_init` を実行した場合のテストです。理由を `detail` に含めた失敗が返り、設定ファイルを書き込まないことを確認します。')
    const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
    stepSync('devcontainer の外にする', () => {
      leaveDevcontainer()
    })
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: repository }))
    stepSync('失敗の kind と detail・書いた設定を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^this tool must run inside a devcontainer\n/u)
      expect(existsSync(configPaths(repository).config)).toBe(false)
    })
  })

  it.for([
    { name: '形式が不正な JSON', content: '{"host": 1}' },
    { name: '不完全な JSON', content: '{' },
  ])('アクティブな設定ファイルが $name のとき、何も書かず、理由を detail に入れて、kind が config-invalid の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-INIT-16')
    await verifies(context, 'PW-WORKTREE-INIT-17')
    await verifies(context, 'PW-WORKTREE-INIT-18')
    await explains(`アクティブな設定ファイルが${row.name}場合のテストです。何も書き込まず、理由を \`detail\` に含めた、\`config-invalid\` の失敗が返ることを確認します。`)
    const { repository } = stepSync('有効な設定を変えたプロジェクトを用意する', () => initialProject({ activeConfig: row.content }))
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: repository }))
    stepSync('失敗の kind と detail・書いた設定を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      expect(detailOf(result)).toMatch(/^could not read the active config: /u)
      expect(existsSync(configPaths(repository).config)).toBe(false)
      expect(existsSync(configPaths(repository).ignore)).toBe(false)
    })
  })

  // 文と枠は Python の typer（click）の Directory オプションと同じ
  const DIRECTORY_ROWS: readonly { readonly name: string, readonly argument: () => string, readonly reason: string }[] = [
    { name: '存在しない', argument: () => path.join(makeTemporaryDirectory(), 'missing'), reason: 'does not exist.' },
    { name: 'ファイルの下を指す', argument: () => {
      const file = path.join(makeTemporaryDirectory(), 'file.txt')
      writeFileSync(file, 'x')
      return path.join(file, 'sub')
    }, reason: 'does not exist.' },
    { name: 'ファイルを指す', argument: () => {
      const file = path.join(makeTemporaryDirectory(), 'file.txt')
      writeFileSync(file, 'x')
      return file
    }, reason: 'is a file.' },
  ]

  it.for(DIRECTORY_ROWS)('directory が $name だと、理由を detail に入れて、kind が invalid-input の失敗を返す', async (row) => {
    await explains(`\`directory\` に${row.name}パスを指定した場合のテストです。理由を \`detail\` に含めた、\`invalid-input\` の失敗が返ることを確認します。`)
    const directory = stepSync('渡す引数を決める', () => row.argument())
    const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory }, makeTemporaryDirectory()))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.structured['detail']).toContain(`Directory '${directory}' ${row.reason}`)
    })
  })

  it.skipIf(process.getuid?.() === 0)('directory が読めないディレクトリだと、is not readable の理由を detail に入れて、kind が invalid-input の失敗を返す', async () => {
    await explains('`directory` に読み取れないディレクトリを指定した場合のテストです。`is not readable` の理由を `detail` に含めた、`invalid-input` の失敗が返ることを確認します。')
    const directory = stepSync('読めない権限にする', () => {
      const directory = path.join(makeTemporaryDirectory(), 'locked')
      mkdirSync(directory)
      chmodSync(directory, 0o000)
      return directory
    })
    const result = await step('設定のひな形を作る', async () => {
      try {
        return await tool('worktree_init', { directory }, makeTemporaryDirectory())
      }
      finally {
        chmodSync(directory, 0o755)
      }
    })
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.structured['detail']).toContain('is not readable.')
    })
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('worktree_init で、repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-INIT-20')
      await explains('remote の URL から owner と repo を取得できず、`repo` を指定して `worktree_init` を実行した場合のテストです。`warning` の行を標準エラーに出力し、同じ文を `warnings` に含めて、処理を続けることを確認します。')
      const project = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の repo を渡して設定のひな形を作る', () => run('worktree_init', { directory: project.repository, repo: 'acme/demo' }))
      stepSync('標準エラー・終了コードを確かめる', () => {
        expect(cli.code).toBe(0)
        expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      })
      stepSync('worktree-config.json を消す', () => {
        rmSync(configPaths(project.repository).config)
        rmSync(configPaths(project.repository).ignore)
      })
      const result = await step('2 回目の repo を渡して設定のひな形を作る', () => tool('worktree_init', { directory: project.repository, repo: 'acme/demo' }))
      stepSync('warnings を確かめる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
      })
    })

    it('worktree_init で、repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-INIT-21')
      await explains('remote の URL から owner と repo を取得できず、`repo` を省略して `worktree_init` を実行した場合のテストです。`the repository is ambiguous` と理由の行を出力し、終了コード 1 で終了することを確認します。')
      const project = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の設定のひな形を作る', () => run('worktree_init', { directory: project.repository }))
      stepSync('標準エラー・標準出力を確かめる', () => {
        expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
        expect(existsSync(configPaths(project.repository).config)).toBe(false)
      })
      const result = await step('2 回目の設定のひな形を作る', () => tool('worktree_init', { directory: project.repository }))
      stepSync('失敗の kind と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(detailOf(result)).toContain('the repository is ambiguous')
        expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
      })
    })
  })

  describe('MCP の data', () => {
    it('2 つの設定ファイルを作ると、その絶対パスを configFile と ignoreFile に返す', async (context) => {
      await verifies(context, 'PW-COMMON-20')
      await verifies(context, 'PW-WORKTREE-INIT-05')
      await explains('MCP で 2 つの設定ファイルを作成した場合のテストです。それぞれの絶対パスを `configFile` と `ignoreFile` に返すことを確認します。')
      const { repository } = stepSync('worktree の設定が無いプロジェクトを用意する', () => initialProject())
      const files = stepSync('設定ファイルのパスを決める', () => configPaths(repository))
      const result = await step('設定のひな形を作る', () => tool('worktree_init', { directory: repository }))
      stepSync('structuredContent を比べる', () => {
        expect(result.structured).toEqual({ configFile: files.config, ignoreFile: files.ignore })
      })
    })
  })
})

describe('worktree_link', () => {
  it('サブの worktree を directory に渡して呼ぶと、worktree-config.json のリンクをその worktree に作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-01')
    await explains('サブの worktree を `directory` に指定して `worktree_link` を実行した場合のテストです。`worktree-config.json` のリンクを、その worktree に作成することを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('リンクを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(readlinkSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(path.relative(worktree, path.join(project.repository, 'CLAUDE.local.md')))
    })
  })

  it('all を付けて呼ぶと、すべてのサブの worktree にリンクを作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-02')
    await explains('`all` を指定して `worktree_link` を実行した場合のテストです。すべてのサブの worktree に、リンクを作成することを確認します。')
    const { project, worktrees } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject(['wt1', 'wt2']))
    const result = await step('すべてを対象にして worktree にリンクを張る', () => tool('worktree_link', { directory: project.repository, all: true }))
    stepSync('リンクを確かめる', () => {
      expect(result.isError).toBe(false)
      for (const worktree of worktrees) expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
    })
  })

  it('すでにリンクがあると、張り替える', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-03')
    await explains('既にリンクが存在する場合のテストです。そのリンクを張り替えて、正しい参照先を指すことを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('リンク先の無いリンクを置く', () => {
      symlinkSync('/nonexistent', path.join(worktree, 'CLAUDE.local.md'))
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('成功を確かめる', () => {
      expect(result.isError).toBe(false)
    })
    const linked = stepSync('張ったリンクの参照先を読む', () => readlinkSync(path.join(worktree, 'CLAUDE.local.md')))
    stepSync('リンク先を確かめる', () => {
      expect(path.resolve(worktree, linked)).toBe(path.join(project.repository, 'CLAUDE.local.md'))
    })
  })

  it('リンク先が無いと、そのリンクを飛ばす', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-04')
    await explains('リンク先が存在しない場合のテストです。そのリンクを作成せずにスキップすることを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('リンク元のファイルを消す', () => {
      rmSync(path.join(project.repository, 'CLAUDE.local.md'))
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('リンクを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  it('リンクのパスに実ファイルがあるサブの worktree を force と all のどちらも付けずに渡すと、答えが無いので、何も変えずに kind が aborted の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-05')
    await verifies(context, 'PW-WORKTREE-LINK-20')
    await explains('リンクのパスに実ファイルが存在するサブの worktree を、`force` と `all` を指定せずに `worktree_link` で実行した場合のテストです。回答を得られないため、何も変更せず、`aborted` の失敗が返ることを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree に自前の CLAUDE.local.md を置く', () => {
      writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('ファイルの中身・失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'aborted' } })
      expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
    })
  })

  it.for(OBSTACLES)('force を付けて$kind があると、尋ねずにそれを消してリンクを作る', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-LINK-08')
    await verifies(context, 'PW-WORKTREE-LINK-09')
    await explains(`\`force\` を指定し、リンクのパスに${row.kind}が存在する場合のテストです。確認せずにそれを削除して、リンクを作成することを確認します。`)
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('リンクの場所に邪魔なものを置く', () => {
      row.make(path.join(worktree, 'CLAUDE.local.md'))
    })
    const result = await step('force を付けて worktree にリンクを張る', () => tool('worktree_link', { directory: worktree, force: true }))
    stepSync('リンク・ファイルの中身を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('shared')
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
    })
  })

  it('force を付けずに all を付けてリンクのパスに実ファイルがあると、尋ねずにそのリンクを飛ばす', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-10')
    await explains('`force` を指定せず `all` を指定し、リンクのパスに実ファイルが存在する場合のテストです。確認せずにそのリンクをスキップし、実ファイルを変更しないことを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree に自前の CLAUDE.local.md を置く', () => {
      writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    })
    const result = await step('すべてを対象にして worktree にリンクを張る', () => tool('worktree_link', { directory: project.repository, all: true }))
    stepSync('リンク・ファイルの中身を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  it('force を付けずに all を付けてリンクのパスに実ファイルがあると、尋ねない', async () => {
    await explains(' `force` を指定せず `all` を指定し、リンクのパスに実ファイルが存在する場合のテストです。確認を求めないことを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree に自前の CLAUDE.local.md を置く', () => {
      writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    })
    const result = await step('すべてを対象にして worktree にリンクを張る', () => run('worktree_link', { directory: project.repository, all: true }))
    stepSync('終了コードを確かめる', () => {
      expect(result.code).toBe(0)
    })
  })

  it('all を付けてサブの worktree が無いと、sub-worktrees の count を 0 にして標準エラーに出す', async () => {
    await explains(' `all` を指定し、サブの worktree が存在しない場合のテストです。`count: sub-worktrees: 0` の行を、標準エラーに出力することを確認します。')
    const { project } = await step('worktree の無いリンク元のプロジェクトを用意する', () => linkedProject([]))
    const result = await step('すべてを対象にして worktree にリンクを張る', () => run('worktree_link', { directory: project.repository, all: true }))
    stepSync('標準エラー・標準出力を確かめる', () => {
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: 'count: sub-worktrees: 0\n' })
    })
  })

  it('worktree にリンクを作ると、作った数を worktree ごとの count の行で標準エラーに出す', async () => {
    await explains(' worktree にリンクを作成した場合のテストです。作成した数を worktree ごとの `count` の行で、標準エラーに出力することを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('worktree にリンクを張る', () => run('worktree_link', { directory: worktree }))
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(result.stderr).toBe(`count: symlinks created in ${worktree}: 1\n`)
    })
  })

  it('複数の worktree に作ると、すべての worktree のリンクの結果を 1 つの links に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-14')
    await explains('複数の worktree にリンクを作成した場合のテストです。すべての worktree のリンクの結果を、1 つの `links` に含めることを確認します。')
    const { project, worktrees } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject(['wt1', 'wt2'], { worktreeConfig: SECOND_LINK }))
    stepSync('リンク元のファイルを消す', () => {
      rmSync(path.join(project.repository, 'second.md'))
    })
    const result = await step('すべてを対象にして worktree にリンクを張る', () => tool('worktree_link', { directory: project.repository, all: true }))
    const rows = worktrees.flatMap(worktree => [
      { ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'create' },
      { path: path.join(worktree, 'second.md'), destination: path.join(project.repository, 'second.md'), change: 'skip', reason: `target does not exist: ${path.join(project.repository, 'second.md')}` },
    ])
    stepSync('structuredContent を比べる', () => {
      expect(result.structured['links']).toEqual(rows)
    })
  })

  it('複数の worktree に作ると、作った数と飛ばした数と失敗した数の合計を count の行で標準エラーに出す', async () => {
    await explains('複数の worktree にリンクを作成した場合のテストです。作成した数・スキップした数・失敗した数の合計を、`count` の行で標準エラーに出力することを確認します。')
    const { project } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject(['wt1', 'wt2'], { worktreeConfig: SECOND_LINK }))
    stepSync('リンク元のファイルを消す', () => {
      rmSync(path.join(project.repository, 'second.md'))
    })
    const result = await step('すべてを対象にして worktree にリンクを張る', () => run('worktree_link', { directory: project.repository, all: true }))
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(result.stderr).toContain('count: symlinks created: 2\ncount: symlinks skipped: 2\ncount: symlink errors: 0\n')
    })
  })

  it('リンクを飛ばすと、skipped の行を標準エラーに出す', async () => {
    await explains('リンクをスキップした場合のテストです。`skipped` の行を標準エラーに出力することを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('リンク元のファイルを消す', () => {
      rmSync(path.join(project.repository, 'CLAUDE.local.md'))
    })
    const result = await step('worktree にリンクを張る', () => run('worktree_link', { directory: worktree }))
    const missing = `target does not exist: ${path.join(project.repository, 'CLAUDE.local.md')}`
    stepSync('リンク・標準エラーを確かめる', () => {
      expect(result.stderr).toContain(`skipped: symlink ${path.join(worktree, 'CLAUDE.local.md')} (${missing})\n`)
    })
  })

  it('worktree_link で、リンクのパスを git が追跡していると、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-17')
    await verifies(context, 'PW-WORKTREE-LINK-18')
    await explains('リンクのパスを git が追跡している場合のテストです。そのリンクを作成せず、`warnings` に警告が 1 つ含まれることを確認します。')
    const { worktree } = await step('git が追跡するリンク元を持つプロジェクトを用意する', () => linkedProject(['wt1'], { files: { 'CLAUDE.local.md': 'tracked' } }))
    const result = await step('force を付けて worktree にリンクを張る', () => tool('worktree_link', { directory: worktree, force: true }))
    stepSync('リンク・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
      expect(result.structured['warnings']).toEqual([`symlink creation skipped because the path is tracked by git: ${path.join(worktree, 'CLAUDE.local.md')}`])
    })
  })

  it('リンクを作れないと、そのリンクを作らず、warnings に 1 つ入れて、残りのリンクの処理を続ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-17')
    await verifies(context, 'PW-WORKTREE-LINK-18')
    await verifies(context, 'PW-WORKTREE-LINK-19')
    await explains('リンクを作成できない場合のテストです。そのリンクを作成せず、`warnings` に警告が 1 つ含まれ、残りのリンクの処理を続けることを確認します。')
    const config = '{"version": 3, "links": [{"path": "blocked/inner", "target_repo": "demo", "target_path": "second.md"}, {"path": "CLAUDE.local.md", "target_repo": "demo", "target_path": "CLAUDE.local.md"}]}\n'
    const { worktree } = await step('リンクを作れない設定のプロジェクトを用意する', () => linkedProject(['wt1'], { worktreeConfig: config, files: { blocked: 'a file' } }))
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('リンク・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^failed to create the symlink: /u)])
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
    })
  })

  it('上書きの確認の入力が尽きると、Aborted. の行を出し、終了コード 1 で終わる', async () => {
    await explains('上書きの確認に対する入力が尽きた場合のテストです。`Aborted.` の行を出力し、終了コード 1 で終了することを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('リンク元の CLAUDE.local.md を書く', () => {
      writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    })
    const result = await step('worktree にリンクを張る', () => run('worktree_link', { directory: worktree }))
    stepSync('ファイルの中身・標準エラーを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/Aborted\.\n$/u)
      expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
    })
  })

  it('設定ファイルが無いと、worktree_init を促す文を detail に入れて、kind が not-initialized の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-21')
    await verifies(context, 'PW-WORKTREE-LINK-22')
    await explains('設定ファイルが存在しない場合のテストです。`worktree_init` を案内する文を `detail` に含めた、`not-initialized` の失敗が返ることを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree-config.json を消す', () => {
      rmSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'))
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
      expect(detailOf(result)).toContain('worktree_init')
    })
  })

  it('設定ファイルが無いと、init を促す error の行を標準エラーに出す', async () => {
    await explains('設定ファイルが存在しない場合のテストです。`init` を案内する `error` の行を、標準エラーに出力することを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree-config.json を消す', () => {
      rmSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'))
    })
    const result = await step('worktree にリンクを張る', () => run('worktree_link', { directory: worktree }))
    stepSync('標準エラー・終了コードを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('error: worktree config not found\n  call worktree_init with directory: <directory>\n')
    })
  })

  it('設定ファイルの形式が不正だと、理由を detail に入れて、kind が config-invalid の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-23')
    await verifies(context, 'PW-WORKTREE-LINK-24')
    await explains('設定ファイルの形式が不正な場合のテストです。理由を `detail` に含めた、`config-invalid` の失敗が返ることを確認します。')
    const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('worktree-config.json を壊す', () => {
      writeFileSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'), '{"version": 3, "links": "x"}')
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      expect(detailOf(result)).toMatch(/^config file validation failed: /u)
    })
  })

  it('メインの worktree を all なしで directory に渡すと、all を案内する文を detail に入れて、kind が invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-25')
    await verifies(context, 'PW-WORKTREE-LINK-26')
    await explains('メインの worktree を、`all` を指定せずに `directory` へ指定した場合のテストです。`all` を案内する文を `detail` に含めた、`invalid-input` の失敗が返ることを確認します。')
    const { project } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: project.repository }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(detailOf(result)).toContain('all: true')
    })
  })

  it('メインの worktree を all なしで directory に渡すと、use all の error の行を標準エラーに出す', async () => {
    await explains('メインの worktree を、`all` を指定せずに `directory` へ指定した場合のテストです。`use all` の `error` の行を、標準エラーに出力することを確認します。')
    const { project } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('worktree にリンクを張る', () => run('worktree_link', { directory: project.repository }))
    stepSync('標準エラーを確かめる', () => {
      expect(result).toMatchObject({ code: 1, stderr: 'error: use all: true in the main worktree\n' })
    })
  })

  it('プロジェクトのルートを見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-27')
    await explains('プロジェクトのルートを取得できない場合のテストです。配置の誤りを示す失敗が返ることを確認します。')
    const { root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const misplaced = stepSync('配置の誤ったパスを決める', () => path.join(root, 'misplaced', 'demo'))
    stepSync('配置の誤ったリポジトリを用意する', () => {
      createGitRepository({ 'README.md': 'x' }, misplaced)
    })
    stepSync('配置の誤ったリポジトリに設定を置く', () => {
      writeTree(misplaced, { '.pecot/config/worktree-config.json': '{"version": 3, "links": []}\n' })
    })
    const result = await step('すべてを対象にして配置の誤ったリポジトリで worktree にリンクを張る', () => tool('worktree_link', { directory: misplaced, all: true }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toContain('is not placed in the layout pecot expects')
    })
  })

  it('directory が git の外だと、メインの worktree を見つけられず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-27')
    await explains('`directory` が git の外にある場合のテストです。メインの worktree を取得できず、`not-initialized` の失敗が返ることを確認します。')
    stepSync('リポジトリと設定を持つプロジェクトを用意する', () => {
      createProject()
    })
    const result = await step('git の外からすべてを対象にして worktree にリンクを張る', () => tool('worktree_link', { directory: outsideGit(), all: true }))
    stepSync('失敗の kind と detail を確かめる', () => {
      // メインの worktree が無いと設定ファイルも見つからないので、設定ファイルが無いときと同じ失敗になる
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
    })
  })

  it('引数 repo が今の git の remote と食い違うと、何も変えず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-28')
    await verifies(context, 'PW-WORKTREE-LINK-29')
    await explains('現在の git の remote と一致しない `repo` を指定した場合のテストです。何も変更せず、`repo-mismatch` の失敗が返ることを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('repo を食い違わせて worktree にリンクを張る', () => tool('worktree_link', { directory: worktree, repo: 'other/thing' }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(existsSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  it('worktree_link で、repo を省き git の外で呼ぶと、the repository is ambiguous を detail に入れ、git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-30')
    await verifies(context, 'PW-WORKTREE-LINK-31')
    await explains('`repo` を省略し、git の外で `worktree_link` を実行した場合のテストです。`the repository is ambiguous` の文を `detail` に含めた、`git-unresolved` の失敗が返ることを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const result = await step('git の外から worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }, outsideGit()))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
    })
  })

  it('worktree_link で、devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-32')
    await verifies(context, 'PW-WORKTREE-LINK-33')
    await explains('devcontainer の外で `worktree_link` を実行した場合のテストです。理由を `detail` に含めた失敗が返り、リンクを作成しないことを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    stepSync('devcontainer の外にする', () => {
      leaveDevcontainer()
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^this tool must run inside a devcontainer\n/u)
      expect(existsSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  it('directory にサブディレクトリを渡して呼ぶと、その worktree のルートにリンクを作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-34')
    await explains('`directory` にサブディレクトリを指定した場合のテストです。その worktree のルートに、リンクを作成することを確認します。')
    const { worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
    const subdirectory = stepSync('worktree にサブディレクトリを作る', () => {
      const subdirectory = path.join(worktree, 'src')
      mkdirSync(subdirectory)
      return subdirectory
    })
    const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: subdirectory }))
    stepSync('リンクを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
      expect(existsSync(path.join(subdirectory, 'CLAUDE.local.md'))).toBe(false)
    })
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('worktree_link で、repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-35')
      await explains('remote の URL から owner と repo を取得できず、`repo` を指定して `worktree_link` を実行した場合のテストです。`warning` の行を標準エラーに出力し、同じ文を `warnings` に含めて、処理を続けることを確認します。')
      const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の repo を渡して worktree にリンクを張る', () => run('worktree_link', { directory: worktree, repo: 'acme/demo' }))
      stepSync('標準エラー・終了コードを確かめる', () => {
        expect(cli.code).toBe(0)
        expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      })
      const result = await step('2 回目の repo を渡して worktree にリンクを張る', () => tool('worktree_link', { directory: worktree, repo: 'acme/demo' }))
      stepSync('warnings を確かめる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
      })
    })

    it('worktree_link で、repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-36')
      await explains('remote の URL から owner と repo を取得できず、`repo` を省略して `worktree_link` を実行した場合のテストです。`the repository is ambiguous` と理由の行を出力し、終了コード 1 で終了することを確認します。')
      const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の worktree にリンクを張る', () => run('worktree_link', { directory: worktree }))
      stepSync('リンク・標準エラーを確かめる', () => {
        expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
        expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
      })
      const result = await step('2 回目の worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
      stepSync('失敗の kind と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(detailOf(result)).toContain('the repository is ambiguous')
        expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
      })
    })
  })

  describe('MCP の data', () => {
    it('リンクを作ると、change を create にして、作った symlink のパスを links[].path に返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-13')
      await explains('MCP でリンクを作成した場合のテストです。`change` を `create` にして、作成したシンボリックリンクのパスを `links[].path` に返すことを確認します。')
      const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
      const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
      stepSync('structuredContent を比べる', () => {
        expect(result.structured).toEqual({ links: [{ ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'create' }] })
      })
    })

    it('既にあるリンクを張り替えると、change を update にする', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-13')
      await explains('MCP で既存のリンクを張り替えた場合のテストです。`change` を `update` にして返すことを確認します。')
      const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
      stepSync('リンク先の無いリンクを置く', () => {
        symlinkSync('/nonexistent', path.join(worktree, 'CLAUDE.local.md'))
      })
      const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
      stepSync('structuredContent を比べる', () => {
        expect(result.structured).toEqual({ links: [{ ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'update' }] })
      })
    })

    it('リンク先が無いと、change を skip にして、飛ばした理由を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-15')
      await explains('MCP でリンク先が存在しない場合のテストです。`change` を `skip` にして、スキップした理由を返すことを確認します。')
      const { project, worktree } = await step('リンク元と worktree を持つプロジェクトを用意する', () => linkedProject())
      stepSync('リンク元のファイルを消す', () => {
        rmSync(path.join(project.repository, 'CLAUDE.local.md'))
      })
      const result = await step('worktree にリンクを張る', () => tool('worktree_link', { directory: worktree }))
      stepSync('structuredContent を比べる', () => {
        expect(result.structured).toMatchObject({ links: [{ change: 'skip', reason: `target does not exist: ${path.join(project.repository, 'CLAUDE.local.md')}` }] })
      })
    })

    it('all を付けてサブの worktree が無いと、links を空の配列にして成功を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-12')
      await explains('MCP で `all` を指定し、サブの worktree が存在しない場合のテストです。`links` を空の配列にして、成功が返ることを確認します。')
      const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      const result = await step('すべてを対象にして worktree にリンクを張る', () => tool('worktree_link', { directory: repository, all: true }))
      stepSync('structuredContent を比べる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured).toEqual({ links: [] })
      })
    })
  })
})

describe('worktree_remove', () => {
  it('worktree_add が記録した名前を渡して呼ぶと、checkout しているブランチによらず、その worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-01')
    await explains('`worktree_add` が記録した名前を指定して `worktree_remove` を実行した場合のテストです。checkout しているブランチにかかわらず、その worktree を削除することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('feature ブランチを checkout する', () => {
      gitForTest(worktree, ['checkout', '-q', '-b', 'feature'])
    })
    const result = await step('worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(worktree)).toBe(false)
      expect(worktreePaths(repository)).toEqual([repository])
    })
  })

  it('keep_branch を省いて worktree を削除すると、同じ名前のローカルブランチを削除し、名前と deletedBranch の true を結果に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-02')
    await verifies(context, 'PW-WORKTREE-REMOVE-06')
    await verifies(context, 'PW-WORKTREE-REMOVE-07')
    await explains('`keep_branch` を省略して worktree を削除した場合のテストです。同じ名前のローカルブランチを削除し、名前と `deletedBranch` の `true` を結果に含めることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    const result = await step('worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1' }))
    stepSync('worktree とブランチを確かめる', () => {
      expect(result.structured).toEqual({ name: 'wt1', deletedBranch: true })
      expect(branches(repository)).not.toContain('wt1')
    })
  })

  it('keep_branch を付けて呼ぶと、ブランチを残す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-03')
    await explains('`keep_branch` を指定して worktree を削除した場合のテストです。ローカルブランチを削除せずに残し、`deletedBranch` を `false` にして返すことを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    const result = await step('ブランチを残して worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1', keep_branch: true }))
    stepSync('worktree とブランチを確かめる', () => {
      expect(result.structured).toEqual({ name: 'wt1', deletedBranch: false })
      expect(branches(repository)).toContain('wt1')
    })
  })

  it('force を付けて呼ぶと、変更のある worktree も削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-04')
    await explains('`force` を指定して worktree を削除した場合のテストです。変更のある worktree も削除することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('変更と未追跡のファイルを worktree に書く', () => {
      writeFileSync(path.join(worktree, 'README.md'), 'changed')
      writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    })
    const result = await step('force を付けて worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1', force: true }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(worktree)).toBe(false)
    })
  })

  it('削除した後にプロジェクトのルートの下の同名のディレクトリが空だと、そのディレクトリを削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-05')
    await explains('worktree の削除後に、プロジェクトのルートの下の同名のディレクトリが空になった場合のテストです。そのディレクトリも削除することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    stepSync('worktree とブランチを確かめる', () => {
      expect(existsSync(path.join(root, 'wt1'))).toBe(true)
    })
    await step('worktree を消す', async () => {
      await tool('worktree_remove', { directory: repository, name: 'wt1' })
    })
    stepSync('worktree とブランチを確かめる', () => {
      expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    })
  })

  it('worktree とローカルブランチを削除すると、removed と deleted の行を標準エラーに出す', async () => {
    await explains(' worktree とローカルブランチを削除した場合のテストです。`removed` と `deleted` の行を、標準エラーに出力することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    const result = await step('worktree を消す', () => run('worktree_remove', { name: 'wt1', directory: repository }))
    stepSync('標準エラーを確かめる', () => {
      expect(result.stderr).toBe('removed: worktree wt1\ndeleted: local branch wt1\n')
    })
  })

  it('keep_branch を付けて呼ぶと、removed の行だけを標準エラーに出す', async () => {
    await explains(' `keep_branch` を指定して worktree を削除した場合のテストです。`removed` の行だけを、標準エラーに出力することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    const result = await step('ブランチを残して worktree を消す', () => run('worktree_remove', { name: 'wt1', directory: repository, keep_branch: true }))
    stepSync('標準エラーを確かめる', () => {
      expect(result.stderr).toBe('removed: worktree wt1\n')
    })
  })

  it.skipIf(process.getuid?.() === 0)('空のセットのディレクトリを削除できないと、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-08')
    await explains('空になったセットのディレクトリを削除できない場合のテストです。`warnings` に警告が 1 つ含まれ、成功が返ることを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    await step('worktree を足す', async () => {
      await addWorktree()
    })
    stepSync('ルートを書き込めなくする', () => {
      chmodSync(root, 0o555)
    })
    const result = await step('worktree を消す', async () => {
      try {
        return await tool('worktree_remove', { directory: repository, name: 'wt1' })
      }
      finally {
        chmodSync(root, 0o755)
      }
    })
    stepSync('warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringContaining(`failed to remove the set directory: ${path.join(root, 'wt1')}: `)])
    })
  })

  it('git branch directory に失敗すると、ブランチを残し、理由を warnings に入れ、deletedBranch を false にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-09')
    await verifies(context, 'PW-WORKTREE-REMOVE-10')
    await verifies(context, 'PW-WORKTREE-REMOVE-23')
    await explains('`git branch directory` が失敗する場合のテストです。ブランチを残し、理由を `warnings` に含め、`deletedBranch` を `false` にして、成功が返ることを確認します。')
    const { repository, result } = await step('ブランチが塞がれた状態で worktree を消す', () => removeWithBlockedBranch())
    stepSync('worktree とブランチ・warnings を確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ name: 'wt1', deletedBranch: false, warnings: [expect.stringMatching(/^could not delete local branch wt1: .+/u)] })
      expect(branches(repository)).toContain('wt1')
    })
  })

  it('渡した名前の worktree が無いと、worktree not found の文を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-11')
    await verifies(context, 'PW-WORKTREE-REMOVE-12')
    await explains('指定した名前の worktree が存在しない場合のテストです。`worktree not found` の文を `detail` に含めた失敗が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('wt9 を指定して worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt9' }))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toBe('worktree not found: wt9')
    })
  })

  it('force なしで変更のある worktree を消そうとすると、worktree とブランチを残し、git の文と force: true の案内を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-13')
    await verifies(context, 'PW-WORKTREE-REMOVE-14')
    await verifies(context, 'PW-WORKTREE-REMOVE-15')
    await verifies(context, 'PW-WORKTREE-REMOVE-16')
    await verifies(context, 'PW-WORKTREE-REMOVE-27')
    await explains('`force` を指定せず、変更のある worktree を削除しようとした場合のテストです。worktree とブランチを残し、git の文と `force: true` の案内を `detail` に含めた失敗が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('変更と未追跡のファイルを worktree に書く', () => {
      writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    })
    const result = await step('worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^failed to remove the worktree: fatal: '.+' contains modified or untracked files, use --force to delete it\n {2}hint: .*force: true/u)
      expect(existsSync(worktree)).toBe(true)
      expect(branches(repository)).toContain('wt1')
    })
  })

  it('force を付けずに変更のある worktree を削除しようとすると、git の文に続けて force の案内の hint の行を出す', async () => {
    await explains(' `force` を指定せず、変更のある worktree を削除しようとした場合のテストです。git の文に続けて、`force` を案内する `hint` の行を出力することを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('変更と未追跡のファイルを worktree に書く', () => {
      writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    })
    const result = await step('worktree を消す', () => run('worktree_remove', { name: 'wt1', directory: repository }))
    stepSync('標準エラー・終了コードを確かめる', () => {
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: failed to remove the worktree: fatal: '.+' contains modified or untracked files, use --force to delete it\n {2}hint: to remove it with its changes, pass force: true\n$/u)
    })
  })

  it('引数 repo が今の git の remote と食い違うと、何も削除せず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-17')
    await verifies(context, 'PW-WORKTREE-REMOVE-18')
    await explains('現在の git の remote と一致しない `repo` を指定した場合のテストです。何も削除せず、`repo-mismatch` の失敗が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    const result = await step('repo を食い違わせて worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1', repo: 'other/thing' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
      expect(existsSync(worktree)).toBe(true)
      expect(branches(repository)).toContain('wt1')
    })
  })

  it('worktree_remove で、repo を省き git の外で呼ぶと、the repository is ambiguous を detail に入れ、git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-19')
    await verifies(context, 'PW-WORKTREE-REMOVE-20')
    await explains('`repo` を省略し、git の外で `worktree_remove` を実行した場合のテストです。`the repository is ambiguous` の文を `detail` に含めた、`git-unresolved` の失敗が返ることを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const result = await step('git の外から worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1' }, outsideGit()))
    stepSync('失敗の kind と detail を確かめる', () => {
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
    })
  })

  it('worktree_remove で、devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-21')
    await verifies(context, 'PW-WORKTREE-REMOVE-22')
    await explains('devcontainer の外で `worktree_remove` を実行した場合のテストです。理由を `detail` に含めた失敗が返り、worktree を削除しないことを確認します。')
    const { repository } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const worktree = await step('worktree を足す', () => addWorktree())
    stepSync('devcontainer の外にする', () => {
      leaveDevcontainer()
    })
    const result = await step('worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt1' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(true)
      expect(detailOf(result)).toMatch(/^this tool must run inside a devcontainer\n/u)
      expect(existsSync(worktree)).toBe(true)
    })
  })

  it('記録の無い worktree の、プロジェクトのルートから見た置き場所 <名前>/<repo> の名前を渡して呼ぶと、checkout しているブランチによらず、その worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-24')
    await explains('記録のない worktree を、プロジェクトのルートから見た置き場所 `<名前>/<repo>` の名前で指定した場合のテストです。checkout しているブランチにかかわらず、その worktree を削除することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const placed = stepSync('別のブランチの worktree を足す', () => {
      const placed = path.join(root, 'wt2', 'demo')
      gitForTest(repository, ['worktree', 'add', '-q', '-b', 'topic', placed])
      return placed
    })
    const result = await step('wt2 を指定して worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'wt2' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(placed)).toBe(false)
    })
  })

  it('記録と置き場所のどちらでも見つからない名前を渡して呼ぶと、その名前のブランチを checkout している worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-25')
    await explains('記録と置き場所のどちらでも見つからない名前を指定した場合のテストです。その名前のブランチを checkout している worktree を削除することを確認します。')
    const { repository, root } = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
    const elsewhere = stepSync('別のブランチの worktree を足す', () => {
      const elsewhere = path.join(root, 'elsewhere', 'demo')
      gitForTest(repository, ['worktree', 'add', '-q', '-b', 'topic', elsewhere])
      return elsewhere
    })
    const result = await step('topic を指定して worktree を消す', () => tool('worktree_remove', { directory: repository, name: 'topic' }))
    stepSync('worktree が消えたことを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(existsSync(elsewhere)).toBe(false)
    })
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('worktree_remove で、repo を渡すと、warning の行を標準エラーに出し、結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-REMOVE-28')
      await explains('remote の URL から owner と repo を取得できず、`repo` を指定して `worktree_remove` を実行した場合のテストです。`warning` の行を標準エラーに出力し、同じ文を `warnings` に含めて、処理を続けることを確認します。')
      const project = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      await step('wt1 と wt2 に worktree を足す', async () => {
        await addWorktree()
        await addWorktree()
      })
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('repo を渡して worktree を消す', () => run('worktree_remove', { name: 'wt1', directory: project.repository, repo: 'acme/demo' }))
      stepSync('標準エラー・終了コードを確かめる', () => {
        expect(cli.code).toBe(0)
        expect(cli.stderr).toContain(`warning: using repo acme/demo (${UNREADABLE_REMOTE})\n`)
      })
      const result = await step('repo を渡して wt2 を指定して worktree を消す', () => tool('worktree_remove', { directory: project.repository, name: 'wt2', repo: 'acme/demo' }))
      stepSync('warnings を確かめる', () => {
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
      })
    })

    it('worktree_remove で、repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-REMOVE-29')
      await explains('remote の URL から owner と repo を取得できず、`repo` を省略して `worktree_remove` を実行した場合のテストです。`the repository is ambiguous` と理由の行を出力し、終了コード 1 で終了することを確認します。')
      const project = stepSync('リポジトリと設定を持つプロジェクトを用意する', () => createProject())
      const worktree = await step('worktree を足す', () => addWorktree())
      stepSync('origin の URL から owner/repo を読めなくする', () => {
        useBareOrigin(project)
      })
      const cli = await step('1 回目の worktree を消す', () => run('worktree_remove', { name: 'wt1', directory: project.repository }))
      stepSync('worktree が消えたことを確かめる', () => {
        expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
        expect(existsSync(worktree)).toBe(true)
      })
      const result = await step('2 回目の worktree を消す', () => tool('worktree_remove', { directory: project.repository, name: 'wt1' }))
      stepSync('失敗の kind と detail を確かめる', () => {
        expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
        expect(detailOf(result)).toContain('the repository is ambiguous')
        expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
      })
    })
  })
})
