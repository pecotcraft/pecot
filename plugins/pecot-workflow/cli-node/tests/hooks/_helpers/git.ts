/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// テスト用の git。conftest.py の git_repo・work_layout・git_call_log に当たる。
//
// 使い方は次のとおり。
// - gitRepository(hookCase, name) は、初期コミット済みのリポを tmp 配下に作る。名前を省くと test-repo-N になる。
// - workLayout(hookCase) は、base と worktree（wt）を作る。wt/.pecot/work は base への相対 symlink になる。
// - installGitCallLog(hookCase) は、PATH の先頭に git のシムを置き、呼び出しを記録する。
// git の起動は run.ts と同じ env（PATH の mock-bin を含む）で行う。
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import type { HookCase } from './environment.js'
import { mockBin } from './mock-bin.js'
import { run } from './run.js'
import { splitLines } from './text.js'

function git(hookCase: HookCase, cwd: string, argv: readonly string[]): void {
  const result = run(hookCase, 'git', argv, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
}

const repositoryCounters = new WeakMap<HookCase, number>()

export function gitRepository(hookCase: HookCase, name?: string): string {
  let repositoryName = name
  if (repositoryName === undefined) {
    const next = (repositoryCounters.get(hookCase) ?? 0) + 1
    repositoryCounters.set(hookCase, next)
    repositoryName = `test-repo-${String(next)}`
  }
  const repositoryDirectory = path.join(hookCase.temporaryPath, repositoryName)
  mkdirSync(repositoryDirectory, { recursive: true })
  git(hookCase, repositoryDirectory, ['init', '--quiet'])
  git(hookCase, repositoryDirectory, ['config', 'user.email', 'test@example.com'])
  git(hookCase, repositoryDirectory, ['config', 'user.name', 'Test User'])
  git(hookCase, repositoryDirectory, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repositoryDirectory, '.gitkeep'), '')
  git(hookCase, repositoryDirectory, ['add', '.gitkeep'])
  git(hookCase, repositoryDirectory, ['commit', '--quiet', '-m', 'initial commit'])
  return repositoryDirectory
}

export interface WorkLayout {
  // base の worktree
  readonly base: string
  // 追加した worktree
  readonly wt: string
  // base 側の .pecot/work の実体
  readonly work: string
  // wt 側の .pecot/work（base への link 経由のパス）
  readonly wtWork: string
}

// base の .pecot/work には 1244/sub を、.pecot には work2 を作る。wt には .pecot/work の link だけを作る。
export function workLayout(hookCase: HookCase): WorkLayout {
  const base = gitRepository(hookCase, 'base')
  const wt = path.join(hookCase.temporaryPath, 'wt')
  git(hookCase, base, ['worktree', 'add', '-q', '-b', 'feat/x', wt])
  const work = path.join(base, '.pecot', 'work')
  mkdirSync(path.join(work, '1244', 'sub'), { recursive: true })
  mkdirSync(path.join(base, '.pecot', 'work2'))
  mkdirSync(path.join(wt, '.pecot'))
  symlinkSync(path.relative(path.join(wt, '.pecot'), work), path.join(wt, '.pecot', 'work'))
  return { base, wt, work, wtWork: path.join(wt, '.pecot', 'work') }
}

// 引数を記録してから本物の git へ exec する。\t・\n はシェルの printf が解釈する。
const GIT_SHIM_BODY = [
  '#!/bin/bash',
  String.raw`printf '%s\t' "$@" >> "$GIT_SHIM_LOG"`,
  String.raw`printf '\n' >> "$GIT_SHIM_LOG"`,
  'exec "$REAL_GIT_FOR_SHIM" "$@"',
  '',
].join('\n')

export interface GitCallLog {
  readonly log: string
  reset(): void
  // 1 呼び出し = 引数リスト 1 件
  calls(): string[][]
  count(subcommand: string): number
  // rev-parse の呼び出しを、直後の引数（--show-toplevel など）ごとに数える
  revParseCounts(): Record<string, number>
}

// `-C <path>` を除いた、サブコマンド以降の引数列
function subcommandArguments(argv: readonly string[]): readonly string[] {
  let rest = argv
  while (rest[0] === '-C') rest = rest.slice(2)
  return rest
}

function realGit(): string {
  const found = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  return found === '' ? 'git' : found
}

export function installGitCallLog(hookCase: HookCase): GitCallLog {
  const log = path.join(hookCase.temporaryPath, 'git-shim.log')
  writeFileSync(log, '')
  hookCase.setEnv('GIT_SHIM_LOG', log)
  hookCase.setEnv('REAL_GIT_FOR_SHIM', realGit())
  mockBin(hookCase).install('git', GIT_SHIM_BODY)
  const calls = (): string[][] => existsSync(log)
    ? splitLines(readFileSync(log, 'utf8')).filter(line => line !== '').map(line => line.replace(/\t+$/u, '').split('\t'))
    : []
  return {
    log,
    reset() {
      writeFileSync(log, '')
    },
    calls,
    count(subcommand) {
      return calls().filter(argv => subcommandArguments(argv)[0] === subcommand).length
    },
    revParseCounts() {
      const counts = new Map<string, number>()
      for (const argv of calls()) {
        const sub = subcommandArguments(argv)
        if (sub[0] !== 'rev-parse') continue
        const key = sub[1] ?? ''
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return Object.fromEntries(counts)
    },
  }
}
