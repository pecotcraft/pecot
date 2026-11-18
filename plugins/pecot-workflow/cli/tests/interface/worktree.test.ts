/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// worktree add / remove / init / link の振る舞い（PW-WORKTREE-*）を、runCli をプロセス内で呼んで確かめる。
// 実 git と一時ディレクトリを使う。モックするのは、/.dockerenv の有無だけ。
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import path from 'node:path'

import { expect, it, describe, beforeEach, vi } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { runCli } from '../../src/cli.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'

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
    workflow_suffix: 'test',
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

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /**
  readLine が呼ばれた回数
  */
  readonly reads: number
}

interface RunOptions {
  /**
  作業ディレクトリ。既定は main worktree
  */
  readonly cwd?: string
  /**
  確認の答え。尽きると入力の終端になる
  */
  readonly answers?: readonly string[]
}

async function pecot(argv: readonly string[], options: Readonly<RunOptions> = {}): Promise<Run> {
  const out: string[] = []
  const error: string[] = []
  const answers = [...options.answers ?? []]
  let reads = 0
  const cwd = options.cwd ?? currentProject().repository
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    const code = await runCli(argv, {
      commands: COMMANDS,
      io: {
        stdout: (text) => {
          out.push(text)
        },
        stderr: (text) => {
          error.push(text)
        },
        readLine: () => {
          reads += 1
          return answers.shift()
        },
      },
      cwd,
      environment: {},
      terminalColumns: undefined,
    })
    return { code, stdout: out.join(''), stderr: error.join(''), reads }
  }
  finally {
    process.chdir(previous)
  }
}

// MCP のツールを、同じプロセスの中のクライアントから 1 回呼ぶ。作業ディレクトリの既定は main worktree
async function tool(name: string, toolArguments: Readonly<Record<string, unknown>>, cwd = currentProject().repository): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    return await callToolOnce(COMMANDS, name, toolArguments)
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
const AMBIGUOUS_LINES = 'error: the repository is ambiguous\n  could not read the repository from the URL of the Git remote origin\n  give --repo <owner/repo>\n'

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
  expect(result.structured['detail']).toBeUndefined()
  expect(result.isError).toBe(false)
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
    expect(path.basename(path.dirname(added))).toBe(name)
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

describe('worktree add', () => {
  it('リポジトリを directory に渡して呼ぶと、プロジェクトのルートの下の wtN にそのリポジトリの worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-01')
    const { repository, root } = createProject()
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(false)
    expect(worktreePaths(repository)).toContain(path.join(root, 'wt1', 'demo'))
    expect(existsSync(path.join(root, 'wt1', 'demo', 'README.md'))).toBe(true)
  })

  it('worktree を作ると、wtN と同じ名前のブランチを、使う remote の <remote>/<ベース> を upstream にして作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-02')
    const { repository } = createProject()
    const worktree = await addWorktree()
    expect(branches(repository)).toContain('wt1')
    expect(gitForTest(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
    expect(upstreamOf(worktree)).toBe('origin/develop')
  })

  it('このリポジトリの worktree がまだ使っていない wtN があると、その中で番号が最小のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-03')
    const { root } = createProject()
    mkdirSync(path.join(root, 'wt1', 'other'), { recursive: true })
    mkdirSync(path.join(root, 'wt2', 'demo'), { recursive: true })
    expect(await addWorktree()).toBe(path.join(root, 'wt1', 'demo'))
  })

  it('path の worktree が wt1 を使っていても、それを数えて次の番号のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-03')
    await verifies(context, 'PW-WORKTREE-ADD-04')
    const { root } = createProject()
    await addWorktree({ path: path.join(root, 'elsewhere', 'demo') })
    expect(await addWorktree()).toBe(path.join(root, 'wt2', 'demo'))
  })

  it('すべての wtN をこのリポジトリの worktree が既に使っていると、最大の番号の次のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-04')
    const { root } = createProject()
    await addWorktree()
    await addWorktree()
    expect(await addWorktree()).toBe(path.join(root, 'wt3', 'demo'))
  })

  it('base を付けて呼ぶと、そのブランチをベースにする', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-05')
    createProject()
    const worktree = await addWorktree({ base: 'release' })
    expect(upstreamOf(worktree)).toBe('origin/release')
  })

  it('base を省いて呼ぶと、アクティブなプロジェクトの設定の develop_branch をベースにする', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-06')
    createProject()
    const worktree = await addWorktree()
    expect(upstreamOf(worktree)).toBe('origin/develop')
  })

  it('path を付けて呼ぶと、その場所に worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-07')
    const { repository, root } = createProject()
    const target = path.join(root, 'custom', 'place')
    expect(await addWorktree({ path: target })).toBe(target)
    expect(worktreePaths(repository)).toContain(target)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('no_link を付けて呼ぶと、シンボリックリンクを作らない', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-08')
    const { repository } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK })
    writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'local')
    const withLink = await addWorktree()
    expect(isSymlink(path.join(withLink, 'CLAUDE.local.md'))).toBe(true)
    const withoutLink = await addWorktree({ no_link: true })
    expect(existsSync(path.join(withoutLink, 'CLAUDE.local.md'))).toBe(false)
  })

  it('no_copy を付けて呼ぶと、未追跡のファイルをコピーしない', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-09')
    const { repository } = createProject()
    writeFileSync(path.join(repository, '.env.local'), 'TOKEN=1')
    const copied = await addWorktree()
    expect(readFileSync(path.join(copied, '.env.local'), 'utf8')).toBe('TOKEN=1')
    const notCopied = await addWorktree({ no_copy: true })
    expect(existsSync(path.join(notCopied, '.env.local'))).toBe(false)
  })

  it('setup を付けて呼ぶと、worktree の中でそのコマンドを実行する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-10')
    createProject()
    const worktree = await addWorktree({ setup: 'echo ran > setup-ran.txt' })
    expect(readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8')).toBe('ran\n')
  })

  it('setup を省いて worktree-config.json に setup_command があると、worktree の中でそのコマンドを実行する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-11')
    createProject({ worktreeConfig: '{"version": 3, "links": [], "setup_command": "echo configured > setup-ran.txt"}\n' })
    const worktree = await addWorktree()
    expect(readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8')).toBe('configured\n')
  })

  it('allow_existing_branch を付けて呼ぶと、upstream の違う既存のブランチを再利用する', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-12')
    const { repository } = createProject()
    prepareExistingBranch(repository)
    const worktree = await addWorktree({ allow_existing_branch: true })
    expect(gitForTest(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wt1')
    expect(gitForTest(worktree, ['rev-parse', 'HEAD']).trim()).toBe(gitForTest(repository, ['rev-parse', 'main']).trim())
  })

  it('CLI で --force を付けて打つと、--allow-existing-branch と同じく既存のブランチを再利用する', async () => {
    const { repository } = createProject()
    prepareExistingBranch(repository)
    const result = await pecot(['worktree', 'add', '-D', repository, '--force'])
    expect(result.code).toBe(0)
    expect(gitForTest(result.stdout.trim(), ['rev-parse', 'HEAD']).trim()).toBe(gitForTest(repository, ['rev-parse', 'main']).trim())
  })

  it('dry_run を付けて呼ぶと、何も作らず、予定のパスと dryRun を結果に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-13')
    await verifies(context, 'PW-WORKTREE-ADD-16')
    await verifies(context, 'PW-WORKTREE-ADD-17')
    const { repository, root } = createProject()
    const result = await tool('worktree_add', { directory: repository, dry_run: true })
    expect(result.structured).toEqual({ name: 'wt1', path: path.join(root, 'wt1', 'demo'), branch: 'wt1', base: 'develop', dryRun: true })
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(branches(repository)).not.toContain('wt1')
    expect(worktreePaths(repository)).toEqual([repository])
  })

  it('CLI で worktree を作ると、created の行を標準エラーに、worktree のパスを標準出力に出す', async () => {
    const { repository, root } = createProject()
    const result = await pecot(['worktree', 'add', '-D', repository])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`created: worktree wt1 at ${path.join(root, 'wt1', 'demo')} (branch wt1 from develop)\n`)
    expect(result.stdout).toBe(`${path.join(root, 'wt1', 'demo')}\n`)
  })

  it('CLI で --dry-run を付けて打つと、予定の行を標準エラーに、予定のパスを標準出力に出す', async () => {
    const { repository, root } = createProject()
    const result = await pecot(['worktree', 'add', '-D', repository, '--dry-run'])
    expect(result.stderr).toBe(`dry-run: would create worktree wt1 at ${path.join(root, 'wt1', 'demo')} (branch wt1 from develop)\n`)
    expect(result.stdout).toBe(`${path.join(root, 'wt1', 'demo')}\n`)
  })

  it('シンボリックリンクを作ると、作った数を symlinks created の count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-18')
    const { repository } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK })
    writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'local')
    const result = await pecot(['worktree', 'add', '-D', repository])
    expect(result.stderr).toContain('count: symlinks created: 1\n')
  })

  it('作らなかったリンクか作れなかったリンクがあると、その数を count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-19')
    const { repository } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK })
    const result = await pecot(['worktree', 'add', '-D', repository])
    expect(result.stderr).toContain('count: symlinks created: 0\n')
    expect(result.stderr).toContain('count: symlinks skipped: 1\n')
    const { repository: tracked } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK, files: { 'CLAUDE.local.md': 'tracked' } })
    const failed = await pecot(['worktree', 'add', '-D', tracked])
    expect(failed.stderr).toContain('count: symlink errors: 1\n')
  })

  it('未追跡のファイルをコピーすると、コピーした数を files copied の count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-20')
    const { repository } = createProject()
    writeFileSync(path.join(repository, '.env.local'), 'TOKEN=1')
    const result = await pecot(['worktree', 'add', '-D', repository])
    expect(result.stderr).toContain('count: files copied: 1\n')
  })

  it.skipIf(process.getuid?.() === 0)('コピーできなかったファイルがあると、そのファイルごとの文を warnings に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-21')
    const { repository } = createProject()
    const secret = path.join(repository, '.env.local')
    writeFileSync(secret, 'TOKEN=1')
    chmodSync(secret, 0o000)
    try {
      const result = await tool('worktree_add', { directory: repository })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^copy .*\.env\.local: /u)])
    }
    finally {
      chmodSync(secret, 0o644)
    }
  })

  it('リンク先が無いと、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    const { repository, root } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK })
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(false)
    expect(existsSync(path.join(root, 'wt1', 'demo', 'CLAUDE.local.md'))).toBe(false)
    expect(result.structured['warnings']).toEqual([`target does not exist: ${path.join(repository, 'CLAUDE.local.md')}`])
  })

  it('CLI で --dry-run を付けて打つと、既存のリンク・実ファイル・追跡済み・dangling のそれぞれに、予定の行を標準エラーに出す', async () => {
    const links = ['CLAUDE.local.md', 'second.md', 'dangling.md', 'tracked.md'].map(name => ({ path: name, target_repo: 'demo', target_path: name }))
    const { project, worktree } = await linkedProject(['wt1'], { worktreeConfig: JSON.stringify({ version: 3, links }), files: { 'tracked.md': 'tracked' } })
    symlinkSync('/nonexistent', path.join(project.repository, 'dangling.md'))
    const real = path.join(worktree, 'CLAUDE.local.md')
    rmSync(real, { force: true })
    writeFileSync(real, 'mine')
    symlinkSync('/nonexistent', path.join(worktree, 'second.md'))
    const from = (name: string): string => path.join(worktree, name)
    const to = (name: string): string => path.join(project.repository, name)
    const asking = await pecot(['worktree', 'link', '-D', worktree, '--dry-run'])
    expect(asking.stderr).toBe([
      `dry-run: would update symlink ${from('CLAUDE.local.md')} -> ${to('CLAUDE.local.md')} (real file, asks first)`,
      `dry-run: would update symlink ${from('second.md')} -> ${to('second.md')}`,
      `dry-run: would skip symlink ${from('dangling.md')} (target is a dangling symlink)`,
      `dry-run: would skip symlink ${from('tracked.md')} (tracked by git)`,
      '',
    ].join('\n'))
    const skipping = await pecot(['worktree', 'link', '-D', project.repository, '--all', '--dry-run'])
    expect(skipping.stderr).toContain(`dry-run: would skip symlink ${from('CLAUDE.local.md')} (a real file exists)\n`)
    expect(skipping.reads).toBe(0)
  })

  it('リンクのパスを git が追跡していると、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    const { repository, root } = createProject({ worktreeConfig: CLAUDE_LOCAL_LINK, files: { 'CLAUDE.local.md': 'tracked' } })
    writeFileSync(path.join(repository, 'CLAUDE.local.md'), 'tracked')
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(false)
    expect(isSymlink(path.join(root, 'wt1', 'demo', 'CLAUDE.local.md'))).toBe(false)
    expect(result.structured['warnings']).toEqual([`symlink creation skipped because the path is tracked by git: ${path.join(root, 'wt1', 'demo', 'CLAUDE.local.md')}`])
  })

  it('リンクを作れないと、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-22')
    await verifies(context, 'PW-WORKTREE-ADD-23')
    const link = '{"version": 3, "links": [{"path": "blocked/inner", "target_repo": "demo", "target_path": "README.md"}]}\n'
    const { repository, root } = createProject({ worktreeConfig: link, files: { blocked: 'a file' } })
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(false)
    expect(isSymlink(path.join(root, 'wt1', 'demo', 'blocked', 'inner'))).toBe(false)
    expect(result.structured['warnings']).toEqual([expect.stringMatching(/^failed to create the symlink: /u)])
  })

  it.for([
    { name: '失敗した', config: '{"version": 3, "links": []}\n', setup: 'echo oops >&2; exit 3', expected: 'setup command failed (exit 3)' },
    { name: '時間切れになった', config: '{"version": 3, "links": [], "setup_command_timeout": 1}\n', setup: 'sleep 20', expected: 'setup command timed out' },
  ])('setup のコマンドが$name と、warnings に 1 つ入れ、setupFailed を true にして成功を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-24')
    await verifies(context, 'PW-WORKTREE-ADD-25')
    const { repository } = createProject({ worktreeConfig: row.config })
    const result = await tool('worktree_add', { directory: repository, setup: row.setup })
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ setupFailed: true, warnings: [expect.stringContaining(row.expected)] })
  })

  it('引数 repo が今の git の remote と食い違うと、何も作らず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-26')
    await verifies(context, 'PW-WORKTREE-ADD-27')
    const { repository, root } = createProject()
    const result = await tool('worktree_add', { directory: repository, repo: 'other/thing' })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(branches(repository)).not.toContain('wt1')
  })

  it('repo を省いて git の外で呼ぶと、the repository is ambiguous の文を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-28')
    await verifies(context, 'PW-WORKTREE-ADD-29')
    const { repository } = createProject()
    const result = await tool('worktree_add', { directory: repository }, outsideGit())
    expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    expect(detailOf(result)).toContain('the repository is ambiguous')
  })

  it('devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-30')
    await verifies(context, 'PW-WORKTREE-ADD-31')
    const { repository, root } = createProject()
    leaveDevcontainer()
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^this command must run inside a devcontainer\n/u)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('directory が git のリポジトリでなく、メインの worktree を見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-32')
    createProject()
    const result = await tool('worktree_add', { directory: outsideGit() })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^cannot get the worktree list/u)
  })

  it('リポジトリが <ルート>/base/<リポジトリ> の配置に無いと、何も作らず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-33')
    await verifies(context, 'PW-WORKTREE-ADD-34')
    const { root } = createProject()
    const misplaced = path.join(root, 'misplaced', 'demo')
    createGitRepository({ 'README.md': 'x' }, misplaced)
    const result = await tool('worktree_add', { directory: misplaced })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toContain('is not placed in the layout pecot expects')
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it.for([{ name: 'worktree-config.json', file: 'worktree-config.json' }, { name: '.worktreeignore', file: '.worktreeignore' }])('$name が無いと、worktree_init を促す文を detail に入れて、kind が not-initialized の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-35')
    await verifies(context, 'PW-WORKTREE-ADD-36')
    const { repository, root } = createProject()
    rmSync(path.join(repository, '.pecot', 'config', row.file))
    const result = await tool('worktree_add', { directory: repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
    expect(detailOf(result)).toContain('worktree_init')
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('CLI で worktree-config.json が無いと、pecot worktree init を促す error の行を標準エラーに出す', async () => {
    const { repository } = createProject({ worktreeConfig: false })
    const result = await pecot(['worktree', 'add', '-D', repository])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('run pecot worktree init')
  })

  it.for<{ readonly name: string, readonly options: Readonly<ProjectOptions>, readonly message: string }>([
    { name: 'プロジェクトの設定が無い', options: { activeConfig: false }, message: 'is not in any project config' },
    { name: 'リポジトリがどの設定にも無い', options: { repositories: [{ owner: 'acme', name: 'other', develop_branch: 'main' }] }, message: 'is not in any project config' },
  ])('$name と、何も作らず、失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-ADD-37')
    await verifies(context, 'PW-WORKTREE-ADD-38')
    const { repository, root } = createProject(row.options)
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toContain(row.message)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(branches(repository)).not.toContain('wt1')
  })

  it('.active が無くても、remote のリポを含む設定が 1 つなら、その設定で作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-55')
    const { root } = createProject()
    rmSync(path.join(process.env['CLAUDE_PROJECT_DIR'] ?? '', '.pecot', 'config', 'projects', '.active'))
    expect(await addWorktree()).toBe(path.join(root, 'wt1', 'demo'))
  })

  it('remote のリポを含む設定が 2 つで選べなければ止まり、project を付けるとその設定で作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-37')
    await verifies(context, 'PW-WORKTREE-ADD-38')
    await verifies(context, 'PW-WORKTREE-ADD-56')
    const { repository, root } = createProject()
    const configRoot = process.env['CLAUDE_PROJECT_DIR'] ?? ''
    rmSync(path.join(configRoot, '.pecot', 'config', 'projects', '.active'))
    writeTree(configRoot, { '.pecot/config/projects/github.com_acme_2.json': projectConfigJson({}) })
    const ambiguous = await tool('worktree_add', { directory: repository })
    expect(ambiguous.isError).toBe(true)
    expect(detailOf(ambiguous)).toContain('acme/demo is in 2 project configs')
    expect(detailOf(ambiguous)).toContain('project: <NAME>')
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    expect(await addWorktree({ project: 'github.com_acme_2' })).toBe(path.join(root, 'wt1', 'demo'))
  })

  it('使う remote の URL を GitHub の owner/repo として読めないと、何も作らず、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-39')
    await verifies(context, 'PW-WORKTREE-ADD-40')
    const { root } = createProject({ originUrl: 'not a url' })
    const matching = createGitRepository()
    gitForTest(matching, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    const result = await tool('worktree_add', { directory: path.join(root, 'base', 'demo') }, matching)
    expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    expect(detailOf(result)).toContain('cannot get the repository information: check that a git remote is set')
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('base を省いて develop_branch が設定に無いと、何も作らず、kind が repo-setting-missing の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-41')
    await verifies(context, 'PW-WORKTREE-ADD-42')
    const { repository, root } = createProject({ repositories: [{ owner: 'acme', name: 'demo' }] })
    const result = await tool('worktree_add', { directory: repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-setting-missing' } })
    expect(detailOf(result)).toContain('develop_branch is not set for repository acme/demo')
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
    await addWorktree({ base: 'develop' })
  })

  it('wt1 から wt9 までのセットがすべて使われていても、最大の番号の次の wt10 のセットに worktree を作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-04')
    const { repository, root } = createProject()
    for (let number = 1; number <= 9; number += 1) gitForTest(repository, ['worktree', 'add', '-q', '-b', `wt${String(number)}`, path.join(root, 'used', String(number))])
    expect(await addWorktree()).toBe(path.join(root, 'wt10', 'demo'))
    expect(worktreePaths(repository)).toContain(path.join(root, 'wt10', 'demo'))
  })

  it('同じ名前のブランチが別の upstream で既にあり allow_existing_branch が無いと、何も作らず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-45')
    await verifies(context, 'PW-WORKTREE-ADD-46')
    const { repository, root } = createProject()
    gitForTest(repository, ['branch', 'wt1', 'main'])
    const result = await tool('worktree_add', { directory: repository })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toContain(`branch 'wt1' already exists and its upstream differs`)
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('git worktree add に失敗すると、git の文を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-47')
    await verifies(context, 'PW-WORKTREE-ADD-48')
    const { repository, root } = createProject()
    const occupied = path.join(root, 'occupied')
    writeTree(occupied, { 'file.txt': 'x' })
    const result = await tool('worktree_add', { directory: repository, path: occupied })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^failed to create the worktree: .*\n.*fatal: '.+occupied' already exists/u)
  })

  it('worktree を作った後に worktree-config.json を読めないと、worktree とブランチを残し、kind が config-invalid の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-49')
    await verifies(context, 'PW-WORKTREE-ADD-50')
    const { repository, root } = createProject({ worktreeConfig: '{"version": 3, "links": "x"}\n' })
    const result = await tool('worktree_add', { directory: repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
    expect(detailOf(result)).toContain('failed to load the worktree config: ')
    expect(worktreePaths(repository)).toContain(path.join(root, 'wt1', 'demo'))
    expect(branches(repository)).toContain('wt1')
  })

  it('path を付けて呼ぶと、リンクと .pecot/.gitignore もその場所に作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-51')
    const link = '{"version": 3, "links": [{"path": ".pecot/config/hooks-config.json", "target_repo": "demo", "target_path": ".pecot/config/hooks-config.json"}]}\n'
    const { repository, root } = createProject({ worktreeConfig: link })
    writeTree(repository, { '.pecot/config/hooks-config.json': '{}' })
    const target = path.join(root, 'custom', 'place')
    expect(await addWorktree({ path: target })).toBe(target)
    expect(isSymlink(path.join(target, '.pecot', 'config', 'hooks-config.json'))).toBe(true)
    expect(existsSync(path.join(target, '.pecot', '.gitignore'))).toBe(true)
    expect(isSymlink(path.join(target, '.pecot', '.gitignore'))).toBe(false)
  })

  it('origin が無く、登録済みのリポを指す remote があると、その中で最初の remote を使う', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-52')
    const { repository } = createProject()
    gitForTest(repository, ['remote', 'add', 'aaa', 'https://github.com/elsewhere/unregistered.git'])
    gitForTest(repository, ['remote', 'rename', 'origin', 'upstream'])
    const worktree = await addWorktree()
    expect(upstreamOf(worktree)).toBe('upstream/develop')
  })

  it('origin のリポが設定に無く、別の remote のリポが設定にあると、その remote を使う', async (context) => {
    await verifies(context, 'PW-WORKTREE-ADD-57')
    const { repository } = createProject()
    gitForTest(repository, ['remote', 'rename', 'origin', 'upstream'])
    gitForTest(repository, ['remote', 'add', 'origin', 'https://github.com/elsewhere/unregistered.git'])
    const worktree = await addWorktree()
    expect(upstreamOf(worktree)).toBe('upstream/develop')
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('--repo を渡すと、CLI は warning の行を標準エラーに出し、MCP は結果の warnings に同じ文を入れ、使う remote の URL を読めないので終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-ADD-53')
      const project = createProject()
      useBareOrigin(project)
      const cli = await pecot(['--repo', 'acme/demo', 'worktree', 'add', '-D', project.repository])
      expect(cli.code).toBe(1)
      expect(cli.stderr).toBe(`warning: using --repo acme/demo (${UNREADABLE_REMOTE})\nerror: cannot get the repository information: check that a git remote is set to a GitHub repository URL\n`)
      const result = await tool('worktree_add', { directory: project.repository, repo: 'acme/demo' })
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('cannot get the repository information: check that a git remote is set')
    })

    it('--repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-ADD-54')
      const project = createProject()
      useBareOrigin(project)
      const cli = await pecot(['worktree', 'add', '-D', project.repository])
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      expect(worktreePaths(project.repository)).toEqual([project.repository])
      const result = await tool('worktree_add', { directory: project.repository })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
      expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
    })
  })

  it('--path がファイルの下を指しても、検証で落とさず、その先の処理に進む', async () => {
    const { repository } = createProject()
    const file = path.join(makeTemporaryDirectory(), 'file.txt')
    writeFileSync(file, 'x')
    const result = await pecot(['worktree', 'add', '-D', repository, '--path', path.join(file, 'sub'), '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`dry-run: would create worktree wt1 at ${path.join(file, 'sub')} `)
  })

  describe('MCP の data', () => {
    it('worktree を作ると、名前・パス・ブランチ・base・setupFailed を返す', async (context) => {
      await verifies(context, 'PW-COMMON-20')
      await verifies(context, 'PW-WORKTREE-ADD-14')
      await verifies(context, 'PW-WORKTREE-ADD-15')
      const { repository, root } = createProject()
      const result = await tool('worktree_add', { directory: repository })
      const worktree = path.join(root, 'wt1', 'demo')
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ name: 'wt1', path: worktree, branch: 'wt1', base: 'develop', setupFailed: false })
    })

    it('setup のコマンドが失敗すると、setupFailed を true にして、warning を返す', async (context) => {
      await verifies(context, 'PW-COMMON-19')
      const { repository } = createProject()
      const result = await tool('worktree_add', { directory: repository, setup: 'exit 3' })
      expect(result.isError).toBe(false)
      expect(result.structured).toMatchObject({ name: 'wt1', setupFailed: true })
      expect(result.structured['warnings']).toEqual([expect.stringContaining('setup command failed (exit 3)')])
    })
  })
})

describe('worktree init', () => {
  it('設定ファイルの無いリポジトリを directory に渡して呼ぶと、メインの worktree に worktree-config.json と .worktreeignore を書く', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-01')
    await verifies(context, 'PW-WORKTREE-INIT-02')
    const { repository } = initialProject()
    const result = await tool('worktree_init', { directory: repository })
    expect(result.isError).toBe(false)
    const files = configPaths(repository)
    expect(writtenLinks(files.config).map(link => link.path)).toEqual(['CLAUDE.local.md', '.env', '.claude/settings.local.json', '.pecot/config/hooks-config.json', '.pecot/config/projects/.active', '.pecot/work'])
    expect(readFileSync(files.ignore, 'utf8')).toContain('node_modules/\n')
  })

  it('サブのディレクトリを directory に渡しても、メインの worktree に書く', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-01')
    const { repository } = initialProject()
    mkdirSync(path.join(repository, 'sub'))
    const result = await tool('worktree_init', { directory: path.join(repository, 'sub') })
    expect(result.isError).toBe(false)
    expect(existsSync(configPaths(repository).config)).toBe(true)
  })

  it('アクティブなプロジェクトに aggregation_repo があると、共有する 3 つのリンクをそのリポジトリに向ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-03')
    const { repository } = initialProject({ aggregationRepository: 'acme/hub' })
    await tool('worktree_init', { directory: repository })
    expect(writtenLinks(configPaths(repository).config).map(link => link.target_repo)).toEqual(['hub', 'hub', 'hub', 'demo', 'demo', 'demo'])
  })

  it('アクティブなプロジェクトが無いか aggregation_repo が無いと、共有する 3 つのリンクをこのリポジトリに向ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-04')
    const withoutAggregation = initialProject()
    await tool('worktree_init', { directory: withoutAggregation.repository })
    expect(targetsOf(configPaths(withoutAggregation.repository).config)).toEqual(new Set(['demo']))
    const withoutProject = initialProject({ activeConfig: false })
    const result = await tool('worktree_init', { directory: withoutProject.repository })
    expect(result.isError).toBe(false)
    expect(targetsOf(configPaths(withoutProject.repository).config)).toEqual(new Set(['demo']))
  })

  it('CLI でファイルを書くと、ファイルごとに created の行を標準エラーに出す', async () => {
    const { repository } = initialProject()
    const result = await pecot(['worktree', 'init', '-D', repository])
    const files = configPaths(repository)
    expect(result.stderr).toBe(`created: worktree config ${files.config}\ncreated: worktree ignore file ${files.ignore}\n`)
  })

  it.for<ExistingRow>([
    { name: 'worktree-config.json', options: { ignore: false }, kept: 'config' },
    { name: '.worktreeignore', options: { worktreeConfig: false }, kept: 'ignore' },
  ])('$name が既にあると、何も書かず、既存のファイルのパスを detail に入れて、kind が already-exists の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-INIT-06')
    await verifies(context, 'PW-WORKTREE-INIT-07')
    await verifies(context, 'PW-WORKTREE-INIT-08')
    const { repository } = createProject(row.options)
    const files = configPaths(repository)
    const existing = files[row.kept]
    const other = row.kept === 'config' ? files.ignore : files.config
    const before = readFileSync(existing, 'utf8')
    const result = await tool('worktree_init', { directory: repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'already-exists' } })
    expect(detailOf(result)).toBe(`worktree config already exists\n  ${existing}`)
    expect(existsSync(other)).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe(before)
  })

  it('CLI で設定ファイルが既にあると、既存のファイルのパスを error の行に出し、終了コード 1 で終わる', async () => {
    const { repository } = createProject({ ignore: false })
    const result = await pecot(['worktree', 'init', '-D', repository])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: worktree config already exists\n  ${configPaths(repository).config}\n`)
  })

  it('メインの worktree を見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-09')
    initialProject()
    const result = await tool('worktree_init', { directory: outsideGit() })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^cannot get the worktree list/u)
  })

  it('引数 repo が今の git の remote と食い違うと、何も書かず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-10')
    await verifies(context, 'PW-WORKTREE-INIT-11')
    const { repository } = initialProject()
    const result = await tool('worktree_init', { directory: repository, repo: 'other/thing' })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
    expect(existsSync(configPaths(repository).config)).toBe(false)
  })

  it('repo を省いて git の外で呼ぶと、the repository is ambiguous の文を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-12')
    await verifies(context, 'PW-WORKTREE-INIT-13')
    const { repository } = initialProject()
    const result = await tool('worktree_init', { directory: repository }, outsideGit())
    expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    expect(detailOf(result)).toContain('the repository is ambiguous')
  })

  it('devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-INIT-14')
    await verifies(context, 'PW-WORKTREE-INIT-15')
    const { repository } = initialProject()
    leaveDevcontainer()
    const result = await tool('worktree_init', { directory: repository })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^this command must run inside a devcontainer\n/u)
    expect(existsSync(configPaths(repository).config)).toBe(false)
  })

  it.for([
    { name: '形式が不正な JSON', content: '{"host": 1}' },
    { name: '不完全な JSON', content: '{' },
  ])('アクティブな設定ファイルが $name のとき、何も書かず、理由を detail に入れて、kind が config-invalid の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-INIT-16')
    await verifies(context, 'PW-WORKTREE-INIT-17')
    await verifies(context, 'PW-WORKTREE-INIT-18')
    const { repository } = initialProject({ activeConfig: row.content })
    const result = await tool('worktree_init', { directory: repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
    expect(detailOf(result)).toMatch(/^could not read the active config: /u)
    expect(existsSync(configPaths(repository).config)).toBe(false)
    expect(existsSync(configPaths(repository).ignore)).toBe(false)
  })

  // 文と枠は Python の typer（click）の Directory オプションと同じ
  const DIRECTORY_ROWS: readonly { readonly name: string, readonly argument: () => string, readonly reason: string }[] = [
    { name: '無い', argument: () => path.join(makeTemporaryDirectory(), 'missing'), reason: 'does not exist.' },
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

  it.for(DIRECTORY_ROWS)('-D が $name だと、使い方の枠で理由を出し、終了コード 2 で終わる', async (row) => {
    const directory = row.argument()
    const result = await pecot(['worktree', 'init', '-D', directory], { cwd: makeTemporaryDirectory() })
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr.replaceAll(/[│\s]+/gu, ' ')).toContain(`Invalid value for '--directory' / '-D': Directory '${directory}' ${row.reason}`)
  })

  it.skipIf(process.getuid?.() === 0)('-D が読めないディレクトリだと、is not readable の理由を出し、終了コード 2 で終わる', async () => {
    const directory = path.join(makeTemporaryDirectory(), 'locked')
    mkdirSync(directory)
    chmodSync(directory, 0o000)
    try {
      const result = await pecot(['worktree', 'init', '-D', directory], { cwd: makeTemporaryDirectory() })
      expect(result.code).toBe(2)
      expect(result.stderr.replaceAll(/[│\s]+/gu, ' ')).toContain('is not readable.')
    }
    finally {
      chmodSync(directory, 0o755)
    }
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('--repo を渡すと、CLI は warning の行を標準エラーに出し、MCP は結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-INIT-20')
      const project = initialProject()
      useBareOrigin(project)
      const cli = await pecot(['--repo', 'acme/demo', 'worktree', 'init', '-D', project.repository])
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using --repo acme/demo (${UNREADABLE_REMOTE})\n`)
      rmSync(configPaths(project.repository).config)
      rmSync(configPaths(project.repository).ignore)
      const result = await tool('worktree_init', { directory: project.repository, repo: 'acme/demo' })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('--repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-INIT-21')
      const project = initialProject()
      useBareOrigin(project)
      const cli = await pecot(['worktree', 'init', '-D', project.repository])
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      expect(existsSync(configPaths(project.repository).config)).toBe(false)
      const result = await tool('worktree_init', { directory: project.repository })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
      expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
    })
  })

  describe('MCP の data', () => {
    it('2 つの設定ファイルを作ると、その絶対パスを configFile と ignoreFile に返す', async (context) => {
      await verifies(context, 'PW-COMMON-20')
      await verifies(context, 'PW-WORKTREE-INIT-05')
      const { repository } = initialProject()
      const files = configPaths(repository)
      const result = await tool('worktree_init', { directory: repository })
      expect(result.structured).toEqual({ configFile: files.config, ignoreFile: files.ignore })
    })

    it('dry_run で呼ぶと、設定ファイルと ignore ファイルを書かず、書く予定のパスと dryRun を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-INIT-19')
      const { repository } = initialProject()
      const files = configPaths(repository)
      const result = await tool('worktree_init', { directory: repository, dry_run: true })
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ configFile: files.config, ignoreFile: files.ignore, dryRun: true })
      expect(existsSync(files.config)).toBe(false)
      expect(existsSync(files.ignore)).toBe(false)
    })
  })
})

describe('worktree link', () => {
  it('サブの worktree を directory に渡して呼ぶと、worktree-config.json のリンクをその worktree に作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-01')
    const { project, worktree } = await linkedProject()
    const result = await tool('worktree_link', { directory: worktree })
    expect(result.isError).toBe(false)
    expect(readlinkSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(path.relative(worktree, path.join(project.repository, 'CLAUDE.local.md')))
  })

  it('all を付けて呼ぶと、すべてのサブの worktree にリンクを作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-02')
    const { project, worktrees } = await linkedProject(['wt1', 'wt2'])
    const result = await tool('worktree_link', { directory: project.repository, all: true })
    expect(result.isError).toBe(false)
    for (const worktree of worktrees) expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
  })

  it('すでにリンクがあると、張り替える', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-03')
    const { project, worktree } = await linkedProject()
    symlinkSync('/nonexistent', path.join(worktree, 'CLAUDE.local.md'))
    const result = await tool('worktree_link', { directory: worktree })
    expect(result.isError).toBe(false)
    const linked = readlinkSync(path.join(worktree, 'CLAUDE.local.md'))
    expect(path.resolve(worktree, linked)).toBe(path.join(project.repository, 'CLAUDE.local.md'))
  })

  it('リンク先が無いと、そのリンクを飛ばす', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-04')
    const { project, worktree } = await linkedProject()
    rmSync(path.join(project.repository, 'CLAUDE.local.md'))
    const result = await tool('worktree_link', { directory: worktree })
    expect(result.isError).toBe(false)
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
  })

  it('CLI でリンクのパスに実ファイルがあるサブの worktree を --force と --all のどちらも付けずに打つと、上書きしてよいかを標準エラーで尋ねる', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-05')
    const { worktree } = await linkedProject()
    writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    const result = await pecot(['worktree', 'link', '-D', worktree], { answers: ['n'] })
    expect(result.stderr).toContain(`real file exists: ${path.join(worktree, 'CLAUDE.local.md')}\noverwrite it? [y/N]:`)
    expect(result.reads).toBe(1)
  })

  it('リンクのパスに実ファイルがあるサブの worktree を force と all のどちらも付けずに渡すと、答えが無いので、何も変えずに kind が aborted の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-05')
    await verifies(context, 'PW-WORKTREE-LINK-20')
    const { worktree } = await linkedProject()
    writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    const result = await tool('worktree_link', { directory: worktree })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'aborted' } })
    expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
  })

  it.for(OBSTACLES)('CLI で上書きの確認に y と答えると、$kind を消してリンクを作る', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-LINK-06')
    await verifies(context, 'PW-WORKTREE-LINK-07')
    const { worktree } = await linkedProject()
    row.make(path.join(worktree, 'CLAUDE.local.md'))
    const result = await pecot(['worktree', 'link', '-D', worktree], { answers: ['y'] })
    expect(result.code).toBe(0)
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
    expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('shared')
  })

  it.for(OBSTACLES)('force を付けて$kind があると、尋ねずにそれを消してリンクを作る', async (row, context) => {
    await verifies(context, 'PW-WORKTREE-LINK-08')
    await verifies(context, 'PW-WORKTREE-LINK-09')
    const { worktree } = await linkedProject()
    row.make(path.join(worktree, 'CLAUDE.local.md'))
    const result = await tool('worktree_link', { directory: worktree, force: true })
    expect(result.isError).toBe(false)
    expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('shared')
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
  })

  it('force を付けずに all を付けてリンクのパスに実ファイルがあると、尋ねずにそのリンクを飛ばす', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-10')
    const { project, worktree } = await linkedProject()
    writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    const result = await tool('worktree_link', { directory: project.repository, all: true })
    expect(result.isError).toBe(false)
    expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
  })

  it('CLI で --force を付けずに --all を付けてリンクのパスに実ファイルがあると、尋ねない', async () => {
    const { project, worktree } = await linkedProject()
    writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    const result = await pecot(['worktree', 'link', '-D', project.repository, '--all'])
    expect(result.code).toBe(0)
    expect(result.reads).toBe(0)
  })

  it('dry_run を付けて呼ぶと、何も変えない', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-11')
    const { worktree } = await linkedProject()
    const linkPath = path.join(worktree, 'CLAUDE.local.md')
    rmSync(linkPath, { force: true })
    writeFileSync(linkPath, 'mine')
    const result = await tool('worktree_link', { directory: worktree, dry_run: true })
    expect(result.isError).toBe(false)
    expect(isSymlink(linkPath)).toBe(false)
    expect(readFileSync(linkPath, 'utf8')).toBe('mine')
  })

  it('CLI で --all を付けてサブの worktree が無いと、sub-worktrees の count を 0 にして標準エラーに出す', async () => {
    const { project } = await linkedProject([])
    const result = await pecot(['worktree', 'link', '-D', project.repository, '--all'])
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: 'count: sub-worktrees: 0\n' })
  })

  it('CLI で worktree にリンクを作ると、作った数を worktree ごとの count の行で標準エラーに出す', async () => {
    const { worktree } = await linkedProject()
    const result = await pecot(['worktree', 'link', '-D', worktree])
    expect(result.stderr).toBe(`count: symlinks created in ${worktree}: 1\n`)
  })

  it('複数の worktree に作ると、すべての worktree のリンクの結果を 1 つの links に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-14')
    const { project, worktrees } = await linkedProject(['wt1', 'wt2'], { worktreeConfig: SECOND_LINK })
    rmSync(path.join(project.repository, 'second.md'))
    const result = await tool('worktree_link', { directory: project.repository, all: true })
    const rows = worktrees.flatMap(worktree => [
      { ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'create' },
      { path: path.join(worktree, 'second.md'), destination: path.join(project.repository, 'second.md'), change: 'skip', reason: `target does not exist: ${path.join(project.repository, 'second.md')}` },
    ])
    expect(result.structured['links']).toEqual(rows)
  })

  it('CLI で複数の worktree に作ると、作った数と飛ばした数と失敗した数の合計を count の行で標準エラーに出す', async () => {
    const { project } = await linkedProject(['wt1', 'wt2'], { worktreeConfig: SECOND_LINK })
    rmSync(path.join(project.repository, 'second.md'))
    const result = await pecot(['worktree', 'link', '-D', project.repository, '--all'])
    expect(result.stderr).toContain('count: symlinks created: 2\ncount: symlinks skipped: 2\ncount: symlink errors: 0\n')
  })

  it('CLI でリンクを飛ばすと、skipped の行を標準エラーに出す', async () => {
    const { project, worktree } = await linkedProject()
    rmSync(path.join(project.repository, 'CLAUDE.local.md'))
    const result = await pecot(['worktree', 'link', '-D', worktree])
    const missing = `target does not exist: ${path.join(project.repository, 'CLAUDE.local.md')}`
    expect(result.stderr).toContain(`skipped: symlink ${path.join(worktree, 'CLAUDE.local.md')} (${missing})\n`)
  })

  it('CLI で --dry-run を付けて打つと、リンクごとの dry-run の予定の行を標準エラーに出す', async () => {
    const { project, worktree } = await linkedProject(['wt1'], { worktreeConfig: SECOND_LINK })
    rmSync(path.join(project.repository, 'second.md'))
    const result = await pecot(['worktree', 'link', '-D', worktree, '--dry-run'])
    expect(result.stderr).toBe([
      `dry-run: would create symlink ${path.join(worktree, 'CLAUDE.local.md')} -> ${path.join(project.repository, 'CLAUDE.local.md')}`,
      `dry-run: would skip symlink ${path.join(worktree, 'second.md')} (target does not exist)`,
      '',
    ].join('\n'))
  })

  it('リンクのパスを git が追跡していると、そのリンクを作らず、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-17')
    await verifies(context, 'PW-WORKTREE-LINK-18')
    const { worktree } = await linkedProject(['wt1'], { files: { 'CLAUDE.local.md': 'tracked' } })
    const result = await tool('worktree_link', { directory: worktree, force: true })
    expect(result.isError).toBe(false)
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    expect(result.structured['warnings']).toEqual([`symlink creation skipped because the path is tracked by git: ${path.join(worktree, 'CLAUDE.local.md')}`])
  })

  it('リンクを作れないと、そのリンクを作らず、warnings に 1 つ入れて、残りのリンクの処理を続ける', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-17')
    await verifies(context, 'PW-WORKTREE-LINK-18')
    await verifies(context, 'PW-WORKTREE-LINK-19')
    const config = '{"version": 3, "links": [{"path": "blocked/inner", "target_repo": "demo", "target_path": "second.md"}, {"path": "CLAUDE.local.md", "target_repo": "demo", "target_path": "CLAUDE.local.md"}]}\n'
    const { worktree } = await linkedProject(['wt1'], { worktreeConfig: config, files: { blocked: 'a file' } })
    const result = await tool('worktree_link', { directory: worktree })
    expect(result.isError).toBe(false)
    expect(result.structured['warnings']).toEqual([expect.stringMatching(/^failed to create the symlink: /u)])
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
  })

  it('CLI で上書きの確認の入力が尽きると、Aborted. の行を出し、終了コード 1 で終わる', async () => {
    const { worktree } = await linkedProject()
    writeFileSync(path.join(worktree, 'CLAUDE.local.md'), 'mine')
    const result = await pecot(['worktree', 'link', '-D', worktree])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/Aborted\.\n$/u)
    expect(readFileSync(path.join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('mine')
  })

  it('設定ファイルが無いと、worktree_init を促す文を detail に入れて、kind が not-initialized の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-21')
    await verifies(context, 'PW-WORKTREE-LINK-22')
    const { project, worktree } = await linkedProject()
    rmSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'))
    const result = await tool('worktree_link', { directory: worktree })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
    expect(detailOf(result)).toContain('worktree_init')
  })

  it('CLI で設定ファイルが無いと、init を促す error の行を標準エラーに出す', async () => {
    const { project, worktree } = await linkedProject()
    rmSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'))
    const result = await pecot(['worktree', 'link', '-D', worktree])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: worktree config not found\n  run: pecot worktree init --directory <directory>\n')
  })

  it('設定ファイルの形式が不正だと、理由を detail に入れて、kind が config-invalid の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-23')
    await verifies(context, 'PW-WORKTREE-LINK-24')
    const { project, worktree } = await linkedProject()
    writeFileSync(path.join(project.repository, '.pecot', 'config', 'worktree-config.json'), '{"version": 3, "links": "x"}')
    const result = await tool('worktree_link', { directory: worktree })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
    expect(detailOf(result)).toMatch(/^config file validation failed: /u)
  })

  it('メインの worktree を all なしで directory に渡すと、all を案内する文を detail に入れて、kind が invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-25')
    await verifies(context, 'PW-WORKTREE-LINK-26')
    const { project } = await linkedProject()
    const result = await tool('worktree_link', { directory: project.repository })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    expect(detailOf(result)).toContain('all: true')
  })

  it('CLI でメインの worktree を --all なしで -D に渡すと、use --all の error の行を標準エラーに出す', async () => {
    const { project } = await linkedProject()
    const result = await pecot(['worktree', 'link', '-D', project.repository])
    expect(result).toMatchObject({ code: 1, stderr: 'error: use --all in the main worktree\n' })
  })

  it('プロジェクトのルートを見つけられないと、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-27')
    const { root } = createProject()
    const misplaced = path.join(root, 'misplaced', 'demo')
    createGitRepository({ 'README.md': 'x' }, misplaced)
    writeTree(misplaced, { '.pecot/config/worktree-config.json': '{"version": 3, "links": []}\n' })
    const result = await tool('worktree_link', { directory: misplaced, all: true })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toContain('is not placed in the layout pecot expects')
  })

  it('directory が git の外だと、メインの worktree を見つけられず、失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-27')
    createProject()
    const result = await tool('worktree_link', { directory: outsideGit(), all: true })
    // メインの worktree が無いと設定ファイルも見つからないので、設定ファイルが無いときと同じ失敗になる
    expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
  })

  it('引数 repo が今の git の remote と食い違うと、何も変えず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-28')
    await verifies(context, 'PW-WORKTREE-LINK-29')
    const { worktree } = await linkedProject()
    const result = await tool('worktree_link', { directory: worktree, repo: 'other/thing' })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
    expect(existsSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
  })

  it('repo を省いて git の外で呼ぶと、the repository is ambiguous の文を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-30')
    await verifies(context, 'PW-WORKTREE-LINK-31')
    const { worktree } = await linkedProject()
    const result = await tool('worktree_link', { directory: worktree }, outsideGit())
    expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    expect(detailOf(result)).toContain('the repository is ambiguous')
  })

  it('devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-32')
    await verifies(context, 'PW-WORKTREE-LINK-33')
    const { worktree } = await linkedProject()
    leaveDevcontainer()
    const result = await tool('worktree_link', { directory: worktree })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^this command must run inside a devcontainer\n/u)
    expect(existsSync(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
  })

  it('directory にサブディレクトリを渡して呼ぶと、その worktree のルートにリンクを作る', async (context) => {
    await verifies(context, 'PW-WORKTREE-LINK-34')
    const { worktree } = await linkedProject()
    const subdirectory = path.join(worktree, 'src')
    mkdirSync(subdirectory)
    const result = await tool('worktree_link', { directory: subdirectory })
    expect(result.isError).toBe(false)
    expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(true)
    expect(existsSync(path.join(subdirectory, 'CLAUDE.local.md'))).toBe(false)
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('--repo を渡すと、CLI は warning の行を標準エラーに出し、MCP は結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-35')
      const { project, worktree } = await linkedProject()
      useBareOrigin(project)
      const cli = await pecot(['--repo', 'acme/demo', 'worktree', 'link', '-D', worktree])
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using --repo acme/demo (${UNREADABLE_REMOTE})\n`)
      const result = await tool('worktree_link', { directory: worktree, repo: 'acme/demo' })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('--repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-36')
      const { project, worktree } = await linkedProject()
      useBareOrigin(project)
      const cli = await pecot(['worktree', 'link', '-D', worktree])
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
      const result = await tool('worktree_link', { directory: worktree })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
      expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
    })
  })

  describe('MCP の data', () => {
    it('リンクを作ると、change を create にして、作った symlink のパスを links[].path に返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-13')
      const { project, worktree } = await linkedProject()
      const result = await tool('worktree_link', { directory: worktree })
      expect(result.structured).toEqual({ links: [{ ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'create' }] })
    })

    it('既にあるリンクを張り替えると、change を update にする', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-13')
      const { project, worktree } = await linkedProject()
      symlinkSync('/nonexistent', path.join(worktree, 'CLAUDE.local.md'))
      const result = await tool('worktree_link', { directory: worktree })
      expect(result.structured).toEqual({ links: [{ ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'update' }] })
    })

    it('リンク先が無いと、change を skip にして、飛ばした理由を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-15')
      const { project, worktree } = await linkedProject()
      rmSync(path.join(project.repository, 'CLAUDE.local.md'))
      const result = await tool('worktree_link', { directory: worktree })
      expect(result.structured).toMatchObject({ links: [{ change: 'skip', reason: `target does not exist: ${path.join(project.repository, 'CLAUDE.local.md')}` }] })
    })

    it('dry_run で呼ぶと、予定の change と dryRun を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-16')
      const { project, worktree } = await linkedProject()
      const result = await tool('worktree_link', { directory: worktree, dry_run: true })
      expect(result.structured).toEqual({ links: [{ ...sharedLink(worktree, path.join(project.repository, 'CLAUDE.local.md')), change: 'create' }], dryRun: true })
      expect(isSymlink(path.join(worktree, 'CLAUDE.local.md'))).toBe(false)
    })

    it('all を付けてサブの worktree が無いと、links を空の配列にして成功を返す', async (context) => {
      await verifies(context, 'PW-WORKTREE-LINK-12')
      const { repository } = createProject()
      const result = await tool('worktree_link', { directory: repository, all: true })
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ links: [] })
    })
  })
})

describe('worktree remove', () => {
  it('worktree_add が記録した名前を渡して呼ぶと、checkout しているブランチによらず、その worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-01')
    const { repository } = createProject()
    const worktree = await addWorktree()
    gitForTest(worktree, ['checkout', '-q', '-b', 'feature'])
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
    expect(result.isError).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    expect(worktreePaths(repository)).toEqual([repository])
  })

  it('keep_branch を省いて worktree を削除すると、同じ名前のローカルブランチを削除し、名前と deletedBranch の true を結果に入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-02')
    await verifies(context, 'PW-WORKTREE-REMOVE-06')
    await verifies(context, 'PW-WORKTREE-REMOVE-07')
    const { repository } = createProject()
    await addWorktree()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
    expect(result.structured).toEqual({ name: 'wt1', deletedBranch: true })
    expect(branches(repository)).not.toContain('wt1')
  })

  it('keep_branch を付けて呼ぶと、ブランチを残す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-03')
    const { repository } = createProject()
    await addWorktree()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1', keep_branch: true })
    expect(result.structured).toEqual({ name: 'wt1', deletedBranch: false })
    expect(branches(repository)).toContain('wt1')
  })

  it('force を付けて呼ぶと、変更のある worktree も削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-04')
    const { repository } = createProject()
    const worktree = await addWorktree()
    writeFileSync(path.join(worktree, 'README.md'), 'changed')
    writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1', force: true })
    expect(result.isError).toBe(false)
    expect(existsSync(worktree)).toBe(false)
  })

  it('削除した後にプロジェクトのルートの下の同名のディレクトリが空だと、そのディレクトリを削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-05')
    const { repository, root } = createProject()
    await addWorktree()
    expect(existsSync(path.join(root, 'wt1'))).toBe(true)
    await tool('worktree_remove', { directory: repository, name: 'wt1' })
    expect(existsSync(path.join(root, 'wt1'))).toBe(false)
  })

  it('CLI で worktree とローカルブランチを削除すると、removed と deleted の行を標準エラーに出す', async () => {
    const { repository } = createProject()
    await addWorktree()
    const result = await pecot(['worktree', 'remove', 'wt1', '-D', repository])
    expect(result.stderr).toBe('removed: worktree wt1\ndeleted: local branch wt1\n')
  })

  it('CLI で --keep-branch を付けて打つと、removed の行だけを標準エラーに出す', async () => {
    const { repository } = createProject()
    await addWorktree()
    const result = await pecot(['worktree', 'remove', 'wt1', '-D', repository, '--keep-branch'])
    expect(result.stderr).toBe('removed: worktree wt1\n')
  })

  it.skipIf(process.getuid?.() === 0)('空のセットのディレクトリを削除できないと、warnings に 1 つ入れる', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-08')
    const { repository, root } = createProject()
    await addWorktree()
    chmodSync(root, 0o555)
    try {
      const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringContaining(`failed to remove the set directory: ${path.join(root, 'wt1')}: `)])
    }
    finally {
      chmodSync(root, 0o755)
    }
  })

  it('git branch -D に失敗すると、ブランチを残し、理由を warnings に入れ、deletedBranch を false にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-09')
    await verifies(context, 'PW-WORKTREE-REMOVE-10')
    await verifies(context, 'PW-WORKTREE-REMOVE-23')
    const { repository, result } = await removeWithBlockedBranch()
    expect(result.isError).toBe(false)
    expect(result.structured).toEqual({ name: 'wt1', deletedBranch: false, warnings: [expect.stringMatching(/^could not delete local branch wt1: .+/u)] })
    expect(branches(repository)).toContain('wt1')
  })

  it('渡した名前の worktree が無いと、worktree not found の文を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-11')
    await verifies(context, 'PW-WORKTREE-REMOVE-12')
    const { repository } = createProject()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt9' })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toBe('worktree not found: wt9')
  })

  it('force なしで変更のある worktree を消そうとすると、worktree とブランチを残し、git の文と force: true の案内を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-13')
    await verifies(context, 'PW-WORKTREE-REMOVE-14')
    await verifies(context, 'PW-WORKTREE-REMOVE-15')
    await verifies(context, 'PW-WORKTREE-REMOVE-16')
    await verifies(context, 'PW-WORKTREE-REMOVE-27')
    const { repository } = createProject()
    const worktree = await addWorktree()
    writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^failed to remove the worktree: fatal: '.+' contains modified or untracked files, use --force to delete it\n {2}hint: .*force: true/u)
    expect(existsSync(worktree)).toBe(true)
    expect(branches(repository)).toContain('wt1')
  })

  it('CLI で --force を付けずに変更のある worktree を削除しようとすると、git の文に続けて --force の案内の hint の行を出す', async () => {
    const { repository } = createProject()
    const worktree = await addWorktree()
    writeFileSync(path.join(worktree, 'untracked.txt'), 'x')
    const result = await pecot(['worktree', 'remove', 'wt1', '-D', repository])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: failed to remove the worktree: fatal: '.+' contains modified or untracked files, use --force to delete it\n {2}hint: to remove it with its changes, pass --force\n$/u)
  })

  it('引数 repo が今の git の remote と食い違うと、何も削除せず、kind が repo-mismatch の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-17')
    await verifies(context, 'PW-WORKTREE-REMOVE-18')
    const { repository } = createProject()
    const worktree = await addWorktree()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1', repo: 'other/thing' })
    expect(result).toMatchObject({ isError: true, structured: { kind: 'repo-mismatch' } })
    expect(existsSync(worktree)).toBe(true)
    expect(branches(repository)).toContain('wt1')
  })

  it('repo を省いて git の外で呼ぶと、the repository is ambiguous の文を detail に入れて、kind が git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-19')
    await verifies(context, 'PW-WORKTREE-REMOVE-20')
    const { repository } = createProject()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1' }, outsideGit())
    expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
    expect(detailOf(result)).toContain('the repository is ambiguous')
  })

  it('devcontainer の外で呼ぶと、理由を detail に入れて失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-21')
    await verifies(context, 'PW-WORKTREE-REMOVE-22')
    const { repository } = createProject()
    const worktree = await addWorktree()
    leaveDevcontainer()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1' })
    expect(result.isError).toBe(true)
    expect(detailOf(result)).toMatch(/^this command must run inside a devcontainer\n/u)
    expect(existsSync(worktree)).toBe(true)
  })

  it('記録の無い worktree の、プロジェクトのルートから見た置き場所 <名前>/<repo> の名前を渡して呼ぶと、checkout しているブランチによらず、その worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-24')
    const { repository, root } = createProject()
    const placed = path.join(root, 'wt2', 'demo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'topic', placed])
    const result = await tool('worktree_remove', { directory: repository, name: 'wt2' })
    expect(result.isError).toBe(false)
    expect(existsSync(placed)).toBe(false)
  })

  it('記録と置き場所のどちらでも見つからない名前を渡して呼ぶと、その名前のブランチを checkout している worktree を削除する', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-25')
    const { repository, root } = createProject()
    const elsewhere = path.join(root, 'elsewhere', 'demo')
    gitForTest(repository, ['worktree', 'add', '-q', '-b', 'topic', elsewhere])
    const result = await tool('worktree_remove', { directory: repository, name: 'topic' })
    expect(result.isError).toBe(false)
    expect(existsSync(elsewhere)).toBe(false)
  })

  describe('remote の URL から owner/repo を読めない', () => {
    it('--repo を渡すと、CLI は warning の行を標準エラーに出し、MCP は結果の warnings に同じ文を入れて続ける', async (context) => {
      await verifies(context, 'PW-WORKTREE-REMOVE-28')
      const project = createProject()
      await addWorktree()
      await addWorktree()
      useBareOrigin(project)
      const cli = await pecot(['--repo', 'acme/demo', 'worktree', 'remove', 'wt1', '-D', project.repository])
      expect(cli.code).toBe(0)
      expect(cli.stderr).toContain(`warning: using --repo acme/demo (${UNREADABLE_REMOTE})\n`)
      const result = await tool('worktree_remove', { directory: project.repository, name: 'wt2', repo: 'acme/demo' })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`using repo acme/demo (${UNREADABLE_REMOTE})`])
    })

    it('--repo を省くと、the repository is ambiguous と理由の行を出し、終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-WORKTREE-REMOVE-29')
      const project = createProject()
      const worktree = await addWorktree()
      useBareOrigin(project)
      const cli = await pecot(['worktree', 'remove', 'wt1', '-D', project.repository])
      expect(cli).toMatchObject({ code: 1, stdout: '', stderr: AMBIGUOUS_LINES })
      expect(existsSync(worktree)).toBe(true)
      const result = await tool('worktree_remove', { directory: project.repository, name: 'wt1' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'git-unresolved' } })
      expect(detailOf(result)).toContain('the repository is ambiguous')
      expect(detailOf(result)).toContain(UNREADABLE_REMOTE)
    })
  })

  it('dry_run を付けて呼ぶと、worktree とブランチを消さず、削除する予定の名前と dryRun を結果に入れて成功を返す', async (context) => {
    await verifies(context, 'PW-WORKTREE-REMOVE-26')
    const { repository } = createProject()
    const worktree = await addWorktree()
    const result = await tool('worktree_remove', { directory: repository, name: 'wt1', dry_run: true })
    expect(result.isError).toBe(false)
    expect(result.structured).toEqual({ name: 'wt1', deletedBranch: false, dryRun: true })
    expect(existsSync(worktree)).toBe(true)
    expect(branches(repository)).toContain('wt1')
  })
})
