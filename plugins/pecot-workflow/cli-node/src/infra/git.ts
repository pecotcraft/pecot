// git コマンド実行の唯一の窓口。git の subprocess 呼び出しはすべて runGit を経由する。
// 値を返す helper（gitToplevel 等）は、失敗時に undefined を返す。

import { spawnSync } from 'node:child_process'

import type { GitResult, GitRunner } from '../domain/git-runner.js'
import { parseRemoteUrl } from '../domain/git-url.js'
import type { RemoteLocation } from '../domain/git-url.js'
import { BaseError, InvalidValueError } from '../domain/errors.js'
import { normalizeNewlines, pythonRepr, pythonStrip } from '../domain/python-format.js'
import { isFileNotFound, toOsError } from './os-error.js'

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

// 出力が大きい git（log・diff 等）でも切れないようにする
export const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024

function withoutGitVariables(): Record<string, string> {
  // interface-env: none
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
}

/**
git を実行する。標準出力・標準エラーは改行を \n に揃えた文字列で返す。
git や作業ディレクトリが見つからなければ OsError（code ENOENT）を投げる
*/
export function runGit(arguments_: readonly string[], options: Readonly<GitOptions> = {}): GitResult {
  const result = spawnSync('git', [...arguments_], {
    cwd: options.cwd,
    env: options.stripGitEnvironment === true ? withoutGitVariables() : undefined,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    // spawnSync の ENOENT は path が `git` で入る。cwd が無いときも同じ ENOENT になる
    throw toOsError(result.error)
  }
  const gitResult: GitResult = { exitCode: result.status ?? -1, stdout: normalizeNewlines(result.stdout), stderr: normalizeNewlines(result.stderr) }
  if (options.check === true && gitResult.exitCode !== 0) throw new GitCommandError(arguments_, gitResult)
  return gitResult
}

/**
cwd を束ねた GitRunner。domain の関数に渡す。非 0 終了は例外にせず結果で返す
*/
export function gitRunnerFor(cwd?: string, options: Readonly<Pick<GitOptions, 'stripGitEnvironment'>> = {}): GitRunner {
  return arguments_ => runGit(arguments_, { cwd, stripGitEnvironment: options.stripGitEnvironment })
}

function runForValue(arguments_: readonly string[], options: Readonly<GitOptions>): string | undefined {
  try {
    return pythonStrip(runGit(arguments_, { ...options, check: true }).stdout)
  }
  catch (error: unknown) {
    if (error instanceof GitCommandError || isFileNotFound(error)) return undefined
    throw error
  }
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
現在のブランチ名（detached HEAD では `HEAD`）。git の外なら undefined
*/
export function gitCurrentBranch(cwd?: string): string | undefined {
  return runForValue(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}

/**
origin の URL から host・owner・repository を返す。origin 不在・git の外・URL 形式の不一致は undefined。
Python の `origin_repo` と同じ契約で、URL が不正でも例外にしない。
不正な URL を例外として見せる domain の detectCurrentGitRepository とは契約が違う
*/
export function originRepository(cwd?: string): RemoteLocation | undefined {
  const url = gitRemoteUrl(cwd)
  if (url === undefined) return undefined
  try {
    return parseRemoteUrl(url)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return undefined
    throw error
  }
}
