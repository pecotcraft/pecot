// git コマンド実行の唯一の窓口。git の subprocess 呼び出しはすべて runGit か runGitAsync を経由する。
// 値を返す helper（gitToplevel 等）は、失敗時に undefined を返す。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { activeIssueFromBranch } from '../domain/branch-name.js'
import type { GitResult, GitRunner } from '../domain/git-runner.js'
import { parseRemoteUrl } from '../domain/git-url.js'
import type { RemoteLocation } from '../domain/git-url.js'
import { BaseError, InvalidValueError } from '../domain/errors.js'
import { normalizeNewlines, pythonRepr, pythonStrip } from '../domain/python-format.js'
import type { IssueReference } from '../domain/reference-parser.js'
import type { RemoteTagLookup } from '../domain/release.js'
import { childStdin } from './child-stdin.js'
import { isFileNotFound, toOsError } from './os-error.js'
import { MAX_OUTPUT_BYTES, runProcess } from './process-run.js'

export interface GitOptions {
  /**
  作業ディレクトリ。省略すると呼び出し元の作業ディレクトリ
  */
  readonly cwd?: string | undefined
  /**
  true なら GIT_* の env を除いて実行する。git のフック内では GIT_DIR 等が設定され、作業ディレクトリの代わりに参照される。
  作業ディレクトリ基準で解決したいときに使う
  */
  readonly stripGitEnvironment?: boolean | undefined
  /**
  true なら非 0 終了で GitCommandError を投げる
  */
  readonly check?: boolean | undefined
  /**
  足す環境変数。今の環境変数（stripGitEnvironment なら GIT_* を除いたもの）に重ねる
  */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
  時間切れ。過ぎたら止めて、exitCode が GIT_TIMED_OUT の結果を返す
  */
  readonly timeoutMilliseconds?: number | undefined
}

/**
時間切れで止めたときの exitCode
*/
export const GIT_TIMED_OUT = -2

function isTimedOut(error: Readonly<Error> | undefined): boolean {
  return error !== undefined && 'code' in error && error.code === 'ETIMEDOUT'
}

/**
check 付きの実行が非 0 で終わった（Python の CalledProcessError に当たる）
*/
export class GitCommandError extends BaseError {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(arguments_: readonly string[], result: GitResult) {
    super(`Command ${pythonRepr(['git', ...arguments_])} returned non-zero exit status ${String(result.exitCode)}.`)
    this.exitCode = result.exitCode
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

function withoutGitVariables(): Record<string, string> {
  // interface-env: none
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
}

/**
git を実行する。標準出力・標準エラーは改行を \n に揃えた文字列で返す。
git や作業ディレクトリが見つからなければ OsError（code ENOENT）を投げる
*/
export function runGit(arguments_: readonly string[], options: Readonly<GitOptions> = {}): GitResult {
  // interface-env: none
  const base = options.stripGitEnvironment === true ? withoutGitVariables() : (options.env === undefined ? undefined : process.env)
  const result = spawnSync('git', [...arguments_], {
    cwd: options.cwd,
    env: base === undefined ? undefined : { ...base, ...options.env },
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: [childStdin(), 'pipe', 'pipe'],
    ...(options.timeoutMilliseconds !== undefined && { timeout: options.timeoutMilliseconds, killSignal: 'SIGKILL' }),
  })
  if (isTimedOut(result.error)) return { exitCode: GIT_TIMED_OUT, stdout: normalizeNewlines(result.stdout), stderr: normalizeNewlines(result.stderr) }
  if (result.error !== undefined) {
    // spawnSync の ENOENT は path が `git` で入る。cwd が無いときも同じ ENOENT になる
    throw toOsError(result.error)
  }
  const gitResult: GitResult = { exitCode: result.status ?? -1, stdout: normalizeNewlines(result.stdout), stderr: normalizeNewlines(result.stderr) }
  if (options.check === true && gitResult.exitCode !== 0) throw new GitCommandError(arguments_, gitResult)
  return gitResult
}

export interface AsyncGitOptions extends GitOptions {
  /**
  MCP の要求の取り消し。取り消されたら git をプロセスグループごと止めて CancelledError を投げる
  */
  readonly signal?: Readonly<AbortSignal> | undefined
}

/**
runGit の非同期版。リモートを待つ git に使い、待つ間もイベントループを止めない
*/
export async function runGitAsync(arguments_: readonly string[], options: Readonly<AsyncGitOptions> = {}): Promise<GitResult> {
  // interface-env: none
  const base = options.stripGitEnvironment === true ? withoutGitVariables() : (options.env === undefined ? undefined : process.env)
  const result = await runProcess('git', arguments_, {
    cwd: options.cwd,
    env: base === undefined ? undefined : { ...base, ...options.env },
    timeoutMilliseconds: options.timeoutMilliseconds,
    signal: options.signal,
  })
  if (result.isTimedOut) return { exitCode: GIT_TIMED_OUT, stdout: result.stdout, stderr: result.stderr }
  const gitResult: GitResult = { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr }
  if (options.check === true && gitResult.exitCode !== 0) throw new GitCommandError(arguments_, gitResult)
  return gitResult
}

/**
cwd を束ねた GitRunner。domain の関数に渡す。非 0 終了は例外にせず結果で返す
*/
export function gitRunnerFor(cwd?: string, options: Readonly<Pick<GitOptions, 'stripGitEnvironment'>> = {}): GitRunner {
  return arguments_ => runGit(arguments_, { cwd, stripGitEnvironment: options.stripGitEnvironment })
}

/**
標準出力を削らずに返す。非 0 終了・git が無いときは undefined
*/
export function gitStdout(arguments_: readonly string[], options: Readonly<Omit<GitOptions, 'check'>> = {}): string | undefined {
  try {
    return runGit(arguments_, { ...options, check: true }).stdout
  }
  catch (error: unknown) {
    if (error instanceof GitCommandError || isFileNotFound(error)) return undefined
    throw error
  }
}

function runForValue(arguments_: readonly string[], options: Readonly<GitOptions>): string | undefined {
  const stdout = gitStdout(arguments_, options)
  return stdout === undefined ? undefined : pythonStrip(stdout)
}

/**
git リポジトリ（ワークツリー）のルート。git の外・git が無いときは undefined
*/
export function gitToplevel(options: Readonly<Pick<GitOptions, 'cwd' | 'stripGitEnvironment'>> = {}): string | undefined {
  return runForValue(['rev-parse', '--show-toplevel'], options)
}

/**
remote の URL。remote が無い・git の外なら undefined
*/
export function gitRemoteUrl(cwd?: string, remote = 'origin'): string | undefined {
  return runForValue(['remote', 'get-url', remote], { cwd })
}

/**
remote 名の一覧。git の外・git が無いときは undefined
*/
export function listRemotes(cwd?: string): readonly string[] | undefined {
  const output = runForValue(['remote'], { cwd })
  return output === undefined ? undefined : output.split('\n').map(line => pythonStrip(line)).filter(line => line !== '')
}

/**
優先順の remote 候補。origin があれば origin だけ、無ければ一覧の順にすべて
*/
export function preferredRemotes(remotes: readonly string[]): readonly string[] {
  return remotes.includes('origin') ? ['origin'] : remotes
}

/**
主の remote 名。origin、無ければ最初の remote。remote が無い・git の外なら undefined
*/
export function primaryRemoteName(cwd?: string): string | undefined {
  return preferredRemotes(listRemotes(cwd) ?? [])[0]
}

/**
主の remote の URL から host・owner・repository を返す。remote 不在・git の外・URL 形式の不一致は undefined
*/
export function primaryRemoteRepository(cwd?: string): RemoteLocation | undefined {
  const name = primaryRemoteName(cwd)
  return name === undefined ? undefined : remoteRepository(cwd, name)
}

/**
現在のブランチ名（detached HEAD では `HEAD`）。git の外なら undefined
*/
export function gitCurrentBranch(cwd?: string): string | undefined {
  return runForValue(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}

/**
作業中の Issue。主の remote のリポと現在のブランチ名の末尾の番号から決める。どちらかが読めなければ undefined
*/
export function activeIssueOf(directory?: string): IssueReference | undefined {
  return activeIssueFromBranch(primaryRemoteRepository(directory), gitCurrentBranch(directory))
}

/**
指定した remote の URL から host・owner・repository を返す。remote 不在・git の外・URL 形式の不一致は undefined
*/
export function remoteRepository(cwd: string | undefined, remote: string): RemoteLocation | undefined {
  const url = gitRemoteUrl(cwd, remote)
  if (url === undefined) return undefined
  try {
    return parseRemoteUrl(url)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return undefined
    throw error
  }
}

// 端末で尋ねさせない。ssh は GIT_SSH_COMMAND で BatchMode にすると利用者の GIT_SSH と core.sshCommand を上書きするので、askpass を失敗させる
export const NON_INTERACTIVE_GIT: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: 'false', SSH_ASKPASS_REQUIRE: 'force' }

// fetch は、認証の入力を待たずに、この時間で諦める
export const REMOTE_TIMEOUT_MILLISECONDS = 60_000

/**
push の時間切れ。pre-push のフックの時間を含める
*/
export const PUSH_TIMEOUT_MILLISECONDS = 600_000

export interface FetchResult {
  readonly succeeded: boolean
  readonly stderr: string
}

export type PushResult = { readonly pushed: true } | { readonly pushed: false, readonly reason: 'rejected' | 'timed-out', readonly stderr: string }

export type RebaseOutcome = 'done' | 'conflict'

const PEEL_TO_COMMIT = '^{commit}'

/**
`git fetch <remote>`。失敗・時間切れは succeeded が false
*/
export async function fetchRemote(cwd: string, remote: string, signal?: Readonly<AbortSignal>): Promise<FetchResult> {
  const result = await runGitAsync(['fetch', remote], { cwd, env: NON_INTERACTIVE_GIT, timeoutMilliseconds: REMOTE_TIMEOUT_MILLISECONDS, signal })
  return { succeeded: result.exitCode === 0, stderr: result.stderr }
}

/**
ref の指すコミットの SHA。無ければ undefined
*/
export function resolveCommit(cwd: string, reference: string): string | undefined {
  return runForValue(['rev-parse', '--verify', '--quiet', `${reference}${PEEL_TO_COMMIT}`], { cwd })
}

/**
2 つの ref の merge-base の SHA。共通の祖先が無ければ undefined
*/
export function mergeBase(cwd: string, a: string, b: string): string | undefined {
  return runForValue(['merge-base', a, b], { cwd })
}

/**
ancestor が descendant の祖先（同じコミットを含む）か。どちらかのコミットを手元が知らなければ false
*/
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd }).exitCode === 0
}

/**
`git merge-base --fork-point <upstream> <head>`。upstream の reflog から、head が分かれた点を求める。求まらなければ undefined
*/
export function forkPoint(cwd: string, upstream: string, head: string): string | undefined {
  return runForValue(['merge-base', '--fork-point', upstream, head], { cwd })
}

// 失敗の後に rebase の途中なら衝突、ほかの失敗は GitCommandError
function rebaseOutcome(cwd: string, arguments_: readonly string[], environment?: Readonly<Record<string, string>>): RebaseOutcome {
  const result = runGit(arguments_, { cwd, env: environment })
  if (result.exitCode === 0) return 'done'
  if (isRebaseInProgress(cwd)) return 'conflict'
  throw new GitCommandError(arguments_, result)
}

/**
`git rebase --onto <newBase> <oldBase>`。利用者の rebase.updateRefs に関わらず、ほかのブランチは書き換えない
*/
export function rebaseOnto(cwd: string, newBase: string, oldBase: string): RebaseOutcome {
  const arguments_ = ['rebase', '--no-update-refs', '--onto', newBase, oldBase]
  // 既に途中なら git は始めずに失敗する。その失敗を衝突と読まない
  if (isRebaseInProgress(cwd)) throw new GitCommandError(arguments_, runGit(arguments_, { cwd }))
  return rebaseOutcome(cwd, arguments_)
}

/**
衝突を解いた後の `git rebase --continue`。コミットの文の編集は開かない
*/
export function continueRebase(cwd: string): RebaseOutcome {
  return rebaseOutcome(cwd, ['rebase', '--continue'], { ...NON_INTERACTIVE_GIT, GIT_EDITOR: 'true' })
}

export function abortRebase(cwd: string): void {
  runGit(['rebase', '--abort'], { cwd, check: true })
}

/**
rebase の途中か。worktree では .git がファイルなので、git に場所を尋ねる
*/
export function isRebaseInProgress(cwd: string): boolean {
  const output = runGit(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'], { cwd, check: true }).stdout
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- git が返した git ディレクトリの中のパス
  return output.split('\n').filter(line => line !== '').some(line => existsSync(path.resolve(cwd, line)))
}

/**
衝突が残っているファイルの一覧
*/
export function conflictedFiles(cwd: string): readonly string[] {
  return runGit(['diff', '--name-only', '--diff-filter=U'], { cwd, check: true }).stdout.split('\n').filter(line => line !== '')
}

/**
remoteBranch にあり、local に同じ変更（patch-id）の無いコミットの SHA。excluded から届くコミットは除く
*/
export function remoteOnlyChanges(cwd: string, local: string, remoteBranch: string, excluded: readonly string[]): readonly string[] {
  const arguments_ = ['rev-list', '--right-only', '--cherry-pick', '--no-merges', `${local}...${remoteBranch}`, ...excluded.map(reference => `^${reference}`), '--']
  return runGit(arguments_, { cwd, check: true }).stdout.split('\n').filter(line => line !== '')
}

export interface SharedChanges {
  /**
  other にあって base に無いコミットのうち、head が同じコミットか同じ変更（patch-id）を持つものがある。
  other にそのコミットが無ければ、other が head の祖先か
  */
  readonly isShared: boolean
  /**
  head の側で、other と同じ変更を持つ最も新しいコミット。同じコミットを共有するだけなら undefined
  */
  readonly lastEquivalent: string | undefined
}

/**
head が other の変更を持っているか。other を載せ直して force-push した後も、patch-id で見つける
*/
export function changesSharedWith(cwd: string, head: string, other: string, base: string): SharedChanges {
  const lines = (arguments_: readonly string[]): readonly string[] => runGit(arguments_, { cwd, check: true }).stdout.split('\n').filter(line => line !== '')
  const own = lines(['rev-list', '--no-merges', other, `^${base}`, '--'])
  if (own.length === 0) return { isShared: isAncestor(cwd, other, head), lastEquivalent: undefined }
  const unmatched = lines(['rev-list', '--right-only', '--cherry-pick', '--no-merges', `${head}...${other}`, `^${base}`, '--'])
  const equivalent = lines(['rev-list', '--left-only', '--cherry-mark', '--no-merges', `${head}...${other}`, `^${base}`, '--']).find(line => line.startsWith('='))
  return { isShared: unmatched.length < own.length, lastEquivalent: equivalent?.slice(1) }
}

/**
2 つの ref の木が同じか
*/
export function hasSameTree(cwd: string, a: string, b: string): boolean {
  const arguments_ = ['diff', '--quiet', a, b, '--']
  const result = runGit(arguments_, { cwd })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new GitCommandError(arguments_, result)
}

export function resetHardTo(cwd: string, reference: string): void {
  runGit(['reset', '--quiet', '--hard', reference], { cwd, check: true })
}

export interface PushOptions {
  readonly signal?: Readonly<AbortSignal> | undefined
  readonly timeoutMilliseconds?: number | undefined
}

function pushFailure(exitCode: number): 'rejected' | 'timed-out' {
  return exitCode === GIT_TIMED_OUT ? 'timed-out' : 'rejected'
}

/**
remote の branch が expectedSha のときだけ、手元の branch で置き換える。拒まれたか時間切れなら、その理由と stderr を返す。取り消されたら CancelledError を投げる
*/
export async function pushWithLease(cwd: string, remote: string, branch: string, expectedSha: string, options: Readonly<PushOptions> = {}): Promise<PushResult> {
  const result = await runGitAsync(['push', `--force-with-lease=${branch}:${expectedSha}`, remote, branch], { cwd, env: NON_INTERACTIVE_GIT, timeoutMilliseconds: options.timeoutMilliseconds ?? PUSH_TIMEOUT_MILLISECONDS, signal: options.signal })
  return result.exitCode === 0 ? { pushed: true } : { pushed: false, reason: pushFailure(result.exitCode), stderr: result.stderr }
}

// ls-remote は、ref が無いと終了コード 2 を返す
const LS_REMOTE_NOT_FOUND = 2
const LS_REMOTE_TIMEOUT_MILLISECONDS = 10_000

export type RemoteHead = { readonly isReachable: true, readonly sha: string | undefined } | { readonly isReachable: false }

/**
remote の branch の先頭の SHA を、追跡参照を更新せずに尋ねる。無ければ sha が undefined。届かないか時間切れなら isReachable が false
*/
export async function remoteBranchHead(cwd: string, remote: string, branch: string, signal?: Readonly<AbortSignal>): Promise<RemoteHead> {
  const listed = await runGitAsync(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], { cwd, env: NON_INTERACTIVE_GIT, timeoutMilliseconds: LS_REMOTE_TIMEOUT_MILLISECONDS, signal })
  if (listed.exitCode === LS_REMOTE_NOT_FOUND) return { isReachable: true, sha: undefined }
  const [sha] = listed.exitCode === 0 ? listed.stdout.split(/\s/u, 1) : []
  return sha === undefined || sha === '' ? { isReachable: false } : { isReachable: true, sha }
}

/**
remote にタグがあるか。届かないか時間切れなら failure に git の stderr を入れる
*/
export async function remoteTagExists(cwd: string, remote: string, tagName: string, signal?: Readonly<AbortSignal>): Promise<RemoteTagLookup> {
  const listed = await runGitAsync(['ls-remote', '--tags', remote, `refs/tags/${tagName}`], { cwd, env: NON_INTERACTIVE_GIT, timeoutMilliseconds: LS_REMOTE_TIMEOUT_MILLISECONDS, signal })
  if (listed.exitCode === GIT_TIMED_OUT) return { failure: `${listed.stderr}timed out after ${String(LS_REMOTE_TIMEOUT_MILLISECONDS / 1000)} seconds` }
  if (listed.exitCode !== 0) return { failure: listed.stderr }
  return { isFound: pythonStrip(listed.stdout) !== '' }
}
