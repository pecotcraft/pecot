/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が渡すリポジトリ・プロジェクトルート配下 */
// ワークツリー管理のコアロジック。ワークツリーの作成・削除を提供する。
//
// 全ての関数は cwd 引数で対象リポジトリを指定する。
// pecot CLI は pecot リポジトリ内で実行されるが、worktree コマンドは別のリポジトリを対象にするため、cwd 引数が必須。
// 失敗は WorktreeRuntimeError（Python の RuntimeError に当たる）で伝える。
//
// 設定ファイル（worktree-config.json・.worktreeignore）の読み書きと symlink 作成は worktree-links.ts にある。
// ファイルのコピーは worktree-copy.ts、setup_command の実行は worktree-setup.ts にある。
// このファイルがそれらを読む。逆向きの import は作らない（findWorktreeConfigFile と findMainWorktree をここに置くのはそのため）。

import { BaseError } from '../domain/errors.js'
import { existsSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { findRepository, getDevelopBranch } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { pythonStrip, ValidationFailure } from '../domain/python-format.js'
import { createRepositoryReference } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { loadActiveConfig } from './config-store.js'
import type { Diagnostics } from './diagnostics.js'
import { isDirectory } from './file-kind.js'
import { GitCommandError, gitToplevel, remoteRepository, runGit } from './git.js'
import type { GitIgnoreSpec } from './gitignore-spec.js'
import { isFileNotFound, toOsError } from './os-error.js'
import { normalizePath, resolveRealPath, WORKTREE_CONFIG_FILENAME } from './paths.js'
import {
  createSymlinks,
  loadConfig,
  loadCopyExcludeSpec,
  WorktreeConfigError,
} from './worktree-links.js'
import type { SymlinkResult, WorktreeConfig } from './worktree-links.js'
import { copyFiles } from './worktree-copy.js'
import type { CopyResult } from './worktree-copy.js'
import { runSetupCommand } from './worktree-setup.js'
import type { SetupResult } from './worktree-setup.js'

/**
ワークツリー操作に失敗した（Python の RuntimeError に当たる）。メッセージは利用者に見せる文
*/
export class WorktreeRuntimeError extends BaseError {}

// 環境ガード

function isSet(value = ''): boolean {
  return value !== ''
}

/**
pecot worktree 系コマンドが devcontainer 内で実行されていることを確認する。

devcontainer 外（host 直接）での実行はサポート外。プロジェクトの devcontainer が整えるマウント構造
（/workspaces/<project>/base/<repo>）に依存するため、外で動かしても動作は保証しない。

検出方法（いずれかでヒットすれば通過）は次のとおり。
- `/.dockerenv` ファイルの存在。パスは dockerEnvironmentFile で差し替えられる。
- 環境変数 REMOTE_CONTAINERS・CODESPACES・DEVCONTAINER のいずれかが設定されている。

いずれも満たさなければ WorktreeRuntimeError
*/
export function ensureDevcontainerEnvironment(dockerEnvironmentFile = '/.dockerenv'): void {
  if (existsSync(dockerEnvironmentFile) || isSet(process.env['REMOTE_CONTAINERS']) || isSet(process.env['CODESPACES']) || isSet(process.env['DEVCONTAINER'])) return
  throw new WorktreeRuntimeError(
    'this command must run inside a devcontainer\n'
    + 'the current environment does not have the mount layout pecot expects '
    + '(/workspaces/<project>/base/<repo>)\n'
    + 'prepare .devcontainer/ in the project, run Reopen in Container in VS Code, and run it again',
  )
}

// 結果の型

export interface WorktreeCreateResult {
  /**
  WT 名
  */
  readonly name: string
  /**
  WT パス
  */
  readonly path: string
  readonly branch: string
  readonly baseBranch: string
  readonly copiedFiles: readonly CopyResult[]
  readonly linkedFiles: readonly SymlinkResult[]
  /**
  setup_command の実行結果。実行しなかったときは undefined
  */
  readonly setupResult: SetupResult | undefined
}

export interface WorktreeInfo {
  readonly path: string
  readonly commit: string
  /**
  ブランチ名。detached HEAD なら undefined
  */
  readonly branch: string | undefined
}

// Git 操作関数

function outputLines(stdout: string): readonly string[] {
  return pythonStrip(stdout).split('\n').filter(line => line !== '')
}

// `git worktree list --porcelain` を worktree ごとに分ける。パスの空白はそのまま残る
function parsePorcelain(stdout: string): readonly WorktreeInfo[] {
  const entries: { path: string, commit: string, branch: string | undefined }[] = []
  for (const line of outputLines(stdout)) {
    if (line.startsWith('worktree ')) entries.push({ path: line.slice('worktree '.length), commit: '', branch: undefined })
    const entry = entries.at(-1)
    if (entry === undefined) continue
    if (line.startsWith('HEAD ')) entry.commit = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
  }
  return entries
}

/**
git worktree list --porcelain の結果を分ける。実行に失敗したら空
*/
export function getWorktreeList(cwd?: string): readonly WorktreeInfo[] {
  const result = runGit(['worktree', 'list', '--porcelain'], { cwd })
  return result.exitCode === 0 ? parsePorcelain(result.stdout) : []
}

/**
メインワークツリーのパスを取得する。git worktree list の最初のエントリがメイン WT。
任意の WT 内から呼べる。一覧を取得できなければ WorktreeRuntimeError
*/
export function findMainWorktree(cwd: string): string {
  const result = runGit(['worktree', 'list', '--porcelain'], { cwd })
  const main = result.exitCode === 0 ? parsePorcelain(result.stdout)[0] : undefined
  if (main === undefined) throw new WorktreeRuntimeError(`cannot get the worktree list: ${result.stderr}`)
  return normalizePath(main.path)
}

/**
メインワークツリーの設定ファイルを探す。無ければ undefined
*/
export function findWorktreeConfigFile(cwd: string = process.cwd()): string | undefined {
  let mainWorktree: string
  try {
    mainWorktree = findMainWorktree(cwd)
  }
  catch (error: unknown) {
    if (error instanceof WorktreeRuntimeError) return undefined
    throw error
  }
  const configPath = path.join(mainWorktree, WORKTREE_CONFIG_FILENAME)
  return existsSync(configPath) ? configPath : undefined
}

/**
サブワークツリー環境かどうかを判定する。git rev-parse --git-dir と --git-common-dir を比較し、
サブ WT では git-dir がメインの .git を指すため、両者が異なる。
Git リポジトリ外、または git コマンドの失敗なら WorktreeRuntimeError
*/
export function isWorktreeEnvironment(cwd: string): boolean {
  let gitDirectory: string
  let commonDirectory: string
  try {
    gitDirectory = runGit(['rev-parse', '--git-dir'], { cwd, check: true }).stdout
    commonDirectory = runGit(['rev-parse', '--git-common-dir'], { cwd, check: true }).stdout
  }
  catch (error: unknown) {
    if (error instanceof GitCommandError) throw new WorktreeRuntimeError(`not a git repository: ${error.stderr.trim()}`, { cause: error })
    throw error
  }
  // 相対パスは、cwd ではなくこのプロセスの作業ディレクトリ基準で解決する（Python の Path.resolve() と同じ）
  return resolveRealPath(pythonStrip(gitDirectory)) !== resolveRealPath(pythonStrip(commonDirectory))
}

/**
サブワークツリーのパス一覧を取得する。get_worktree_list の最初のエントリ（メイン WT）を除く。
一覧を取得できなければ WorktreeRuntimeError
*/
export function getWorktreeDirectories(cwd: string): readonly string[] {
  const entries = getWorktreeList(cwd)
  if (entries.length === 0) throw new WorktreeRuntimeError('cannot get the worktree list')
  return entries.slice(1).map(entry => normalizePath(entry.path))
}

// worktree add が wtN を書く記録。管理ディレクトリ（.git/worktrees/<id>/）の中に置く
const WORKTREE_NAME_RECORD = 'pecot-worktree-name'

// 記録のパス。git が解決した絶対パス（このプロセスの cwd に依らない）。取れなければ undefined
function worktreeNameRecordPath(cwd: string): string | undefined {
  const result = runGit(['rev-parse', '--path-format=absolute', '--git-path', WORKTREE_NAME_RECORD], { cwd })
  const recordPath = pythonStrip(result.stdout)
  return recordPath !== '' && result.exitCode === 0 ? recordPath : undefined
}

function readRecord(file: string): string {
  try {
    return pythonStrip(readFileSync(file, 'utf8'))
  }
  catch {
    return ''
  }
}

// 作った worktree に名前を記録する。失敗は warning にとどめる
function recordWorktreeName(worktreePath: string, name: string, diagnostics: Diagnostics): void {
  const recordPath = worktreeNameRecordPath(worktreePath)
  if (recordPath === undefined) {
    diagnostics.warning(`failed to record the worktree name ${name}: cannot resolve the git path: ${worktreePath}`)
    return
  }
  try {
    writeFileSync(recordPath, `${name}\n`)
  }
  catch (error: unknown) {
    const converted = toOsError(error)
    diagnostics.warning(`failed to record the worktree name ${name}: ${recordPath}: ${converted instanceof Error ? converted.message : String(converted)}`)
  }
}

/**
使用中の wtN の名前を返す。全 worktree の記録と、wtN のブランチを checkout している worktree の和
*/
export function claimedSetNames(mainWorktree: string): ReadonlySet<string> {
  const names = new Set<string>()
  const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: mainWorktree })
  const commonDirectory = pythonStrip(common.stdout)
  if (commonDirectory !== '' && common.exitCode === 0) {
    const administrative = path.join(commonDirectory, 'worktrees')
    const entries = existsSync(administrative) ? readdirSync(administrative) : []
    for (const entry of entries) {
      const recorded = readRecord(path.join(administrative, entry, WORKTREE_NAME_RECORD))
      if (recorded !== '') names.add(recorded)
    }
  }
  const references = runGit(['for-each-ref', '--format=%(refname:short)%00%(worktreepath)', 'refs/heads/'], { cwd: mainWorktree })
  if (references.exitCode === 0) {
    for (const line of references.stdout.split('\n')) {
      const [branch, worktreePath] = line.split('\0', 2)
      if (branch !== undefined && worktreePath !== undefined && worktreePath !== '' && /^wt\d+$/u.test(branch)) names.add(branch)
    }
  }
  return names
}

/**
現在のサブワークツリー名を取得する。
サブ WT でなければ undefined。記録（`pecot-worktree-name`）があればそれを返す。
無ければ toplevel の親ディレクトリ名を、`wt\d+` か `base` のときだけ返し、それ以外は undefined。
Git リポジトリ外なら WorktreeRuntimeError
*/
export function getCurrentWorktreeName(cwd: string): string | undefined {
  if (!isWorktreeEnvironment(cwd)) return undefined
  const recordPath = worktreeNameRecordPath(cwd)
  const recorded = recordPath === undefined ? '' : readRecord(recordPath)
  if (recorded !== '') return recorded
  const toplevel = gitToplevel({ cwd })
  const parent = toplevel === undefined ? undefined : path.basename(path.dirname(toplevel))
  return parent !== undefined && /^(?:wt\d+|base)$/u.test(parent) ? parent : undefined
}

/**
プロジェクトルートを検出する。呼び出し側リポジトリの main WT を正規化し、`<root>/base/<repo>` の形になっているか確認する。
`<root>` の絶対パスを返す。その形でなければ WorktreeRuntimeError
*/
export function detectProjectRoot(cwd: string): string {
  const resolved = resolveRealPath(findMainWorktree(cwd))
  const parent = path.dirname(resolved)
  if (path.basename(parent) !== 'base') {
    const expected = path.join(parent, 'base', path.basename(resolved))
    throw new WorktreeRuntimeError(
      'this repository is not placed in the layout pecot expects for a project\n'
      + '\n'
      + `  current: ${resolved}\n`
      + `  expected: ${expected}\n`
      + '\n'
      + 'why base/ is needed:\n'
      + '  the devcontainer mounts the parallel sets (wt1, wt2...) selectively, so base/ '
      + 'separates the resident set from the parallel sets\n'
      + '\n'
      + 'migration steps (the cwd goes away, so close this CLI session first):\n'
      + '  1. close this CLI session\n'
      + '  2. in another terminal, run:\n'
      + `       mkdir -p ${parent}/base\n`
      + `       mv ${resolved} ${parent}/base/\n`
      + `  3. restart the CLI in ${parent}/base/${path.basename(resolved)}/`,
    )
  }
  return path.dirname(parent)
}

export interface NextSetNameOptions {
  /**
  プレフィクス。既定は `wt`
  */
  readonly prefix?: string | undefined
  /**
  最大番号。既定は 9
  */
  readonly maxNumber?: number | undefined
  /**
  使用中の名前（claimedSetNames の結果）。ディレクトリが無くても、参加せず max にも数える
  */
  readonly claimed?: Iterable<string> | undefined
}

// プロジェクトルート直下の `<prefix><数字>` ディレクトリの番号を昇順で返す
function existingSetNumbers(projectRoot: string, prefix: string): readonly number[] {
  const entries = existsSync(projectRoot) ? readdirSync(projectRoot) : []
  return entries
    .filter(entry => entry.startsWith(prefix) && /^\d+$/u.test(entry.slice(prefix.length)) && isDirectory(path.join(projectRoot, entry)))
    .map(entry => Number(entry.slice(prefix.length)))
    .toSorted((a, b) => a - b)
}

/**
プロジェクトルート基準で、対象リポの参加先セット名を決める（プロジェクトセット = 同じ wtN 配下の複数リポ WT）。

1. `<projectRoot>/wt\d+/` と `options.claimed` の番号を列挙する。claimed の番号は参加せず、max にも数える。
2. 各 wtN について `wtN/<repositoryDirectoryName>` が存在しないものを先頭から探す。見つかったら既存セットに参加させる形でその名前を返す。
3. 全ての既存 wtN に該当リポが既にあるなら、max(N)+1 で新セット `wt<N+1>` を返す。
4. 既存セットが無ければ `wt1` を返す。

全セットに参加済みで maxNumber を超えるなら WorktreeRuntimeError
*/
export function getNextSetName(projectRoot: string, repositoryDirectoryName: string, options: Readonly<NextSetNameOptions> = {}): string {
  const prefix = options.prefix ?? 'wt'
  const maxNumber = options.maxNumber ?? 9
  const claimed = new Set<number>()
  const claimedNames = [...options.claimed ?? []]
  for (const claimedName of claimedNames) {
    if (claimedName.startsWith(prefix) && /^\d+$/u.test(claimedName.slice(prefix.length))) claimed.add(Number(claimedName.slice(prefix.length)))
  }
  const numbers = [...new Set([...existingSetNumbers(projectRoot, prefix), ...claimed])].toSorted((a, b) => a - b)

  const last = numbers.at(-1)
  if (last === undefined) return `${prefix}1`

  // 既存セットで該当リポが未登場のものがあればそこに参加
  const joinable = numbers.find(number => !claimed.has(number) && !existsSync(path.join(projectRoot, `${prefix}${String(number)}`, repositoryDirectoryName)))
  if (joinable !== undefined) return `${prefix}${String(joinable)}`

  // 全セットに参加済み → 新セット
  if (last + 1 > maxNumber) throw new WorktreeRuntimeError(`all of ${prefix}1 to ${prefix}${String(maxNumber)} are in use: no free set`)
  return `${prefix}${String(last + 1)}`
}

// 未追跡ファイル操作

/**
git 管理外（gitignored）ファイルの一覧を取得する。cwd はメイン WT のルート。相対パスを返す
*/
export function getUntrackedFiles(cwd: string): readonly string[] {
  const result = runGit(['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd })
  return result.exitCode === 0 ? outputLines(result.stdout).map(line => normalizePath(line)) : []
}

/**
コピー対象外のファイルを除く。spec は .worktreeignore から読んだ判定
*/
export function filterCopyableFiles(files: readonly string[], spec: Readonly<GitIgnoreSpec>): readonly string[] {
  return files.filter(file => !spec.matchFile(normalizePath(file)))
}

// オーケストレーション

const NO_REMOTE_MESSAGE = 'cannot get the repository information: check that a git remote is set to a GitHub repository URL'

interface RemoteCandidate {
  readonly remote: string
  readonly repository: RepositoryReference | undefined
}

// remote 候補を優先順に返す。origin があれば origin だけ、無ければ git remote の順にすべて。URL を読めない remote の repository は undefined
function readRemoteCandidates(cwd: string): readonly RemoteCandidate[] {
  let output: string
  try {
    output = runGit(['remote'], { cwd, check: true }).stdout
  }
  catch (error: unknown) {
    if (error instanceof GitCommandError || isFileNotFound(error)) return []
    throw error
  }
  const remotes = output.split('\n').map(line => pythonStrip(line)).filter(line => line !== '')
  return (remotes.includes('origin') ? ['origin'] : remotes).map((remote) => {
    const location = remoteRepository(cwd, remote)
    if (location === undefined) return { remote, repository: undefined }
    try {
      return { remote, repository: createRepositoryReference(location.owner, location.repository) }
    }
    catch (error: unknown) {
      if (error instanceof ValidationFailure) return { remote, repository: undefined }
      throw error
    }
  })
}

// 必須設定ファイルの存在チェック（無ければ早期エラー、init を促す）。(ワークツリー設定ファイルのパス, コピー除外 spec) を返す
function loadCopyExcludeSpecOrRaise(mainWorktree: string, diagnostics: Diagnostics): { readonly configPath: string, readonly spec: GitIgnoreSpec } {
  const configPath = path.join(mainWorktree, WORKTREE_CONFIG_FILENAME)
  if (!existsSync(configPath)) {
    throw new WorktreeRuntimeError(`worktree config not found: ${WORKTREE_CONFIG_FILENAME}\n  run pecot worktree init to generate the template`)
  }
  try {
    return { configPath, spec: loadCopyExcludeSpec(mainWorktree, diagnostics) }
  }
  catch (error: unknown) {
    if (error instanceof WorktreeConfigError) throw new WorktreeRuntimeError(error.message, { cause: error })
    throw error
  }
}

// リポジトリ登録チェック。remote は origin、無ければ登録済みのリポを指す最初の remote、どれも未登録なら最初の remote（未登録として止まる）
function requireRegisteredRepository(cwd: string): { readonly repository: RepositoryReference, readonly config: ProjectConfig, readonly remote: string } {
  const candidates = readRemoteCandidates(cwd)
  if (candidates.length === 0) throw new WorktreeRuntimeError(NO_REMOTE_MESSAGE)
  const config = loadActiveConfig()
  if (config === undefined) {
    throw new WorktreeRuntimeError('project config not found\n  hint: run pecot project activate <PROJECT> to set the project')
  }
  for (const candidate of candidates) {
    if (candidate.repository !== undefined && findRepository(config, candidate.repository.owner, candidate.repository.repository) !== undefined) {
      return { repository: candidate.repository, config, remote: candidate.remote }
    }
  }
  const repository = candidates[0]?.repository
  if (repository === undefined) throw new WorktreeRuntimeError(NO_REMOTE_MESSAGE)
  const registered = config.repositories.length > 0
    ? config.repositories.map(item => `  - ${item.owner}/${item.name}`).join('\n')
    : '  (none registered)'
  throw new WorktreeRuntimeError(
    `repository ${repository.owner}/${repository.repository} is not registered in the `
    + 'active pecot project\n'
    + '\n'
    + 'registered repositories:\n'
    + `${registered}\n`
    + '\n'
    + 'to add this repository to the pecot project:\n'
    + `  pecot project set-repo ${repository.owner}/${repository.repository}\n`
    + '\n'
    + 'to switch to another project:\n'
    + '  pecot project activate <PROJECT>',
  )
}

// ベースブランチ決定（プロジェクト設定の develop_branch を使用）
function defaultBaseBranch(config: ProjectConfig, repository: RepositoryReference): string {
  const developBranch = getDevelopBranch(config, repository.owner, repository.repository)
  if (developBranch === undefined || developBranch === '') {
    throw new WorktreeRuntimeError(
      `develop_branch is not set for repository ${repository.owner}/${repository.repository}\n`
      + '  add develop_branch to repositories in the project config file\n'
      + '  or pass --base explicitly',
    )
  }
  return developBranch
}

// ワークツリー設定を読み込む（設定は存在確認済み）。存在するが読み込み・検証に失敗したときは、不在と同様に hard error にして修正を促す
function loadWorktreeConfigOrRaise(configPath: string): WorktreeConfig {
  try {
    return loadConfig(configPath)
  }
  catch (error: unknown) {
    if (error instanceof WorktreeConfigError) {
      throw new WorktreeRuntimeError(`failed to load the worktree config: ${normalizePath(configPath)}: ${error.message}\n  fix the config file and run it again`, { cause: error })
    }
    throw error
  }
}

// シンボリックリンク作成。(結果, 作成成功したリンクの WT 相対パス) を返す。後者はコピー除外に使う
function createWorktreeSymlinks(config: WorktreeConfig, projectRoot: string, worktreePath: string, diagnostics: Diagnostics): { readonly linkedFiles: readonly SymlinkResult[], readonly symlinkedPaths: readonly string[] } {
  const linkedFiles = createSymlinks(config, projectRoot, worktreePath, diagnostics)
  const symlinkedPaths = linkedFiles
    .filter(link => link.action === 'created')
    .map(link => path.relative(worktreePath, link.symlinkPath))
    .filter(relative => relative !== '..' && !relative.startsWith('../'))
  return { linkedFiles, symlinkedPaths }
}

function isRelativeTo(file: string, base: string): boolean {
  const relative = path.relative(base, file)
  return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)
}

// 未追跡ファイルコピー（シンボリックリンク対象を除外）
function copyUntrackedToWorktree(mainWorktree: string, worktreePath: string, spec: GitIgnoreSpec, symlinkedPaths: readonly string[]): readonly CopyResult[] {
  const copyable = filterCopyableFiles(getUntrackedFiles(mainWorktree), spec)
    .filter(file => symlinkedPaths.every(linked => !isRelativeTo(file, linked)))
  return copyable.length > 0 ? copyFiles(mainWorktree, worktreePath, copyable) : []
}

// セットアップコマンド実行。優先順位: CLI --setup 明示 > config.setup_command > skip
function runEffectiveSetup(setupCommand: string | undefined, config: WorktreeConfig, worktreePath: string, diagnostics: Diagnostics): SetupResult | undefined {
  const effective = setupCommand ?? config.setup_command
  if (effective === undefined || effective === '') return undefined
  const result = runSetupCommand(effective, worktreePath, config.setup_command_timeout)
  if (result.exitCode !== 0) {
    // Python の core と同じ 1 メッセージ。字下げは受け口側が付ける
    const head = result.exitCode === -1 ? `setup command timed out: ${effective}` : `setup command failed (exit ${String(result.exitCode)}): ${effective}`
    const lines = [head]
    if (result.stdout.trim() !== '') for (const line of result.stdout.replace(/\n+$/, '').split('\n')) lines.push(`out: ${line}`)
    if (result.stderr.trim() !== '') for (const line of result.stderr.replace(/\n+$/, '').split('\n')) lines.push(`err: ${line}`)
    diagnostics.warning(lines.join('\n'))
  }
  return result
}

export interface CreateWorktreeOptions {
  /**
  WT 名。省略時はプロジェクトルート基準で自動決定する。
  CLI（pecot worktree add）は NAME 位置引数を廃止しているため、常に省略で呼ばれる。
  明示するとセット整合性が呼び出し側の責務になる
  */
  readonly name?: string | undefined
  /**
  ベースブランチ。省略時はプロジェクト設定の develop_branch
  */
  readonly baseBranch?: string | undefined
  /**
  WT 作成先パス。省略時は `<project_root>/<name>/<repo_dir_name>`
  */
  readonly path?: string | undefined
  /**
  未追跡ファイルをコピーするか。既定は true
  */
  readonly shouldCopy?: boolean | undefined
  /**
  シンボリックリンクを作成するか。既定は true
  */
  readonly shouldLink?: boolean | undefined
  /**
  作成後に実行するコマンド。設定の setup_command より優先する
  */
  readonly setupCommand?: string | undefined
  /**
  プレビューのみ。既定は false
  */
  readonly isDryRun?: boolean | undefined
  /**
  既存ブランチの upstream が develop_branch と異なる場合でも再利用を許可するか。既定は false
  */
  readonly isExistingBranchAllowed?: boolean | undefined
}

/**
ワークツリーを作成する。cwd は対象 Git リポジトリのパス。
作成に失敗した場合、プロジェクトルート・既存ブランチ衝突・設定の不備は WorktreeRuntimeError
*/
export function createWorktree(cwd: string, diagnostics: Diagnostics, options: Readonly<CreateWorktreeOptions> = {}): WorktreeCreateResult {
  // 1. メインWT検出 & プロジェクトルート
  const mainWorktree = findMainWorktree(cwd)
  const projectRoot = detectProjectRoot(cwd)

  // 1.1 必須設定ファイルの存在チェック（無ければ早期エラー、init を促す）
  const { configPath, spec } = loadCopyExcludeSpecOrRaise(mainWorktree, diagnostics)

  // 1.2 container rebuild 後の stale worktree メタデータを事前に掃除する。
  //     `.git/worktrees/<name>/` だけ残って実体が消えているケース（rebuild や手動 rm -rf のあと）で、add が衝突エラーになるのを防ぐ
  runGit(['worktree', 'prune'], { cwd: mainWorktree })

  // 1.5 リポジトリ登録チェック（アクティブプロジェクト配下か確認）
  const { repository, config, remote } = requireRegisteredRepository(cwd)

  // 2. 名前決定（プロジェクトセットへの自動参加）
  const repositoryDirectoryName = path.basename(mainWorktree)
  const name = options.name ?? getNextSetName(projectRoot, repositoryDirectoryName, { claimed: claimedSetNames(mainWorktree) })

  // 3. ベースブランチ決定（プロジェクト設定の develop_branch を使用）
  const baseBranch = options.baseBranch ?? defaultBaseBranch(config, repository)

  // 4. パス計算: <project_root>/<name>/<repo_dir_name>
  const worktreePath = options.path === undefined ? path.join(projectRoot, name, repositoryDirectoryName) : normalizePath(options.path)

  // dry-run時はここで結果を返す
  if (options.isDryRun === true) {
    return { name, path: worktreePath, branch: name, baseBranch, copiedFiles: [], linkedFiles: [], setupResult: undefined }
  }

  // 5. git worktree add
  addGitWorktree(cwd, worktreePath, name, { remote, baseBranch }, options.isExistingBranchAllowed === true)
  recordWorktreeName(worktreePath, name, diagnostics)

  // 6〜8. シンボリックリンク作成・未追跡ファイルコピー・セットアップコマンド実行
  const worktreeConfig = loadWorktreeConfigOrRaise(configPath)
  const linking = options.shouldLink === false
    ? { linkedFiles: [], symlinkedPaths: [] }
    : createWorktreeSymlinks(worktreeConfig, projectRoot, worktreePath, diagnostics)
  const copiedFiles = options.shouldCopy === false ? [] : copyUntrackedToWorktree(mainWorktree, worktreePath, spec, linking.symlinkedPaths)
  const setupResult = runEffectiveSetup(options.setupCommand, worktreeConfig, worktreePath, diagnostics)
  return { name, path: worktreePath, branch: name, baseBranch, copiedFiles, linkedFiles: linking.linkedFiles, setupResult }
}

/**
`git worktree add` を実行し、既存ブランチ衝突ガードも含めて処理する。
cwd は対象 Git リポジトリのパス（メイン WT でもサブ WT でも可）。
既存ブランチの upstream 不一致、または git worktree add 失敗時は WorktreeRuntimeError
*/
function addGitWorktree(cwd: string, worktreePath: string, name: string, base: Readonly<{ readonly remote: string, readonly baseBranch: string }>, isExistingBranchAllowed: boolean): void {
  const { remote, baseBranch } = base
  let hasBranch = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd }).exitCode === 0

  if (hasBranch && !isExistingBranchAllowed) {
    const currentUpstream = pythonStrip(runGit(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${name}`], { cwd }).stdout)
    const expectedUpstream = baseBranch === '' ? undefined : `${remote}/${baseBranch}`
    if ((currentUpstream === '' ? undefined : currentUpstream) !== expectedUpstream) {
      throw new WorktreeRuntimeError(
        `branch '${name}' already exists and its upstream differs from the expected one `
        + `(current: ${currentUpstream === '' ? '(unset)' : currentUpstream}, expected: ${expectedUpstream ?? 'None'}): `
        + 'pass --allow-existing-branch to reuse it',
      )
    }

    // upstream 一致かつ bind なし → prune に取り残された孤児ブランチとみなし除去
    const worktreeOfBranch = runGit(['for-each-ref', '--format=%(worktreepath)', `refs/heads/${name}`], { cwd })
    if (worktreeOfBranch.exitCode === 0 && pythonStrip(worktreeOfBranch.stdout) === '') {
      runGit(['branch', '-D', name], { cwd })
      hasBranch = false
    }
  }

  const gitArguments = hasBranch ? ['worktree', 'add', worktreePath, name] : ['worktree', 'add', worktreePath, '-b', name]
  if (!hasBranch && baseBranch !== '') gitArguments.push('--track', `${remote}/${baseBranch}`)

  const result = runGit(gitArguments, { cwd })
  if (result.exitCode !== 0) throw new WorktreeRuntimeError(`failed to create the worktree: ${result.stderr}`)
}

// worktree の記録。ディレクトリが無い、toplevel が別（.git の消えた跡）なら空。GIT_* は外して読む
function recordedNameOf(worktreePath: string): string {
  if (!isDirectory(worktreePath)) return ''
  const toplevel = gitToplevel({ cwd: worktreePath, stripGitEnvironment: true })
  if (toplevel === undefined || resolveRealPath(toplevel) !== resolveRealPath(worktreePath)) return ''
  const result = runGit(['rev-parse', '--path-format=absolute', '--git-path', WORKTREE_NAME_RECORD], { cwd: worktreePath, stripGitEnvironment: true })
  const recordPath = pythonStrip(result.stdout)
  return recordPath !== '' && result.exitCode === 0 ? readRecord(recordPath) : ''
}

/**
名前から削除対象の worktree を探す（メインを除く）。記録の名前、置き場所 `<root>/<name>/<repo>`、ブランチ名の順に、段ごとに全件を見る
*/
function findWorktreePathByName(cwd: string, name: string): string | undefined {
  const candidates = getWorktreeList(cwd).slice(1)
  const recorded = candidates.find(info => recordedNameOf(info.path) === name)
  if (recorded !== undefined) return recorded.path
  let expected: string | undefined
  try {
    const repositoryName = path.basename(resolveRealPath(findMainWorktree(cwd)))
    expected = path.join(detectProjectRoot(cwd), name, repositoryName)
  }
  catch (error: unknown) {
    if (!(error instanceof WorktreeRuntimeError)) throw error
  }
  const placed = expected === undefined ? undefined : candidates.find(info => resolveRealPath(info.path) === resolveRealPath(expected))
  return placed?.path ?? candidates.find(info => info.branch === name)?.path
}

/**
ワークツリーを削除する。name は worktree add が付けた名前（wtN）か、checkout しているブランチ名。
WT が見つからない・削除に失敗した場合は WorktreeRuntimeError。
ローカルブランチを消せなかったときは、その理由を返す。成功時と shouldKeepBranch は undefined
*/
export function removeWorktree(cwd: string, name: string, diagnostics: Diagnostics, options: Readonly<{ readonly isForced?: boolean | undefined, readonly shouldKeepBranch?: boolean | undefined }> = {}): string | undefined {
  // 1. WTパスを特定
  const worktreePath = findWorktreePathByName(cwd, name)
  if (worktreePath === undefined) throw new WorktreeRuntimeError(`worktree not found: ${name}`)

  // 2. git worktree remove
  const gitArguments = ['worktree', 'remove', worktreePath]
  if (options.isForced === true) gitArguments.push('--force')
  const removed = runGit(gitArguments, { cwd })
  if (removed.exitCode !== 0) throw new WorktreeRuntimeError(`failed to remove the worktree: ${removed.stderr}`)

  // 3. ブランチ削除（ローカルブランチ）
  let branchError: string | undefined
  if (options.shouldKeepBranch !== true) {
    const branchResult = runGit(['branch', '-D', name], { cwd })
    if (branchResult.exitCode !== 0) branchError = pythonStrip(branchResult.stderr) || `git branch -D exited with ${String(branchResult.exitCode)}`
  }

  // 4. プロジェクトルート配下の <name> ディレクトリが空なら rmdir
  removeEmptySetDirectory(cwd, name, diagnostics)
  return branchError
}

function removeEmptySetDirectory(cwd: string, name: string, diagnostics: Diagnostics): void {
  let projectRoot: string
  try {
    projectRoot = detectProjectRoot(cwd)
  }
  catch (error: unknown) {
    if (error instanceof WorktreeRuntimeError) return
    throw error
  }
  const groupDirectory = path.join(projectRoot, name)
  if (!isDirectory(groupDirectory) || readdirSync(groupDirectory).length > 0) return
  try {
    rmdirSync(groupDirectory)
  }
  catch (error: unknown) {
    const converted = toOsError(error)
    diagnostics.warning(`failed to remove the set directory: ${groupDirectory}: ${converted instanceof Error ? converted.message : String(converted)}`)
  }
}
