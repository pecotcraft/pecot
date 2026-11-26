/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// 一時の git リポの補助。実 git を使い、git はモックしない。
//
// 使い方は次のとおり。
// - createGitRepository(files) は、一時ディレクトリで init し、コミットまで済ませて、そのパスを返す。
// - gitForTest(directory, arguments) は、そのディレクトリで git を実行して標準出力を返す。
//
// 呼ぶ git は GIT_* を外す。global と system の設定は読まない。作者は固定する。
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

import { makeTemporaryDirectory, writeTree } from './temporary.js'

/**
テストで呼ぶ git の env。GIT_* を外し、global・system の設定を読まず、作者を固定する
*/
export function gitEnvironment(): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
  return {
    ...base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
}

export function gitForTest(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { cwd, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
directory を git init し、files をコミットする。directory 省略時は一時ディレクトリを作る
*/
const DEFAULT_FILES: Readonly<Record<string, string>> = { 'README.md': 'x' }

export function createGitRepository(files: Readonly<Record<string, string>> = DEFAULT_FILES, directory?: string): string {
  const target = directory ?? makeTemporaryDirectory('pecot-repo-')
  mkdirSync(target, { recursive: true })
  gitForTest(target, ['init', '-q', '-b', 'main'])
  gitForTest(target, ['config', 'commit.gpgsign', 'false'])
  writeTree(target, files)
  gitForTest(target, ['add', '-A'])
  gitForTest(target, ['commit', '-q', '-m', 'init'])
  return target
}
