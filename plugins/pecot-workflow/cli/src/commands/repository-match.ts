// グローバルの `--repo` と、今の git remote のリポジトリの食い違いを扱う（Python の `require_repo_match`）。
// 判定は domain/repository-policy.ts の applyRepositoryPolicy に任せ、ここは git の解決と行の出力、止めるときの終了コードだけを行う。
import { formatHinted } from '../domain/command-hint.js'
import type { HintedText } from '../domain/command-hint.js'
import { AMBIGUOUS_REPOSITORY_LINE, applyRepositoryPolicy } from '../domain/repository-policy.js'
import type { PolicyMode } from '../domain/repository-policy.js'
import { readCurrentGitRemote } from '../domain/repository-resolver.js'
import type { RepositoryReference, ResolvedRepository, UnreadableRemote } from '../domain/repository-resolver.js'
import { gitRunnerFor, listRemotes } from '../infra/git.js'
import { CommandExit } from './command-definition.js'
import type { CommandIo } from './command-definition.js'
import { ERROR_PREFIX, WARNING_PREFIX } from './output.js'

/**
今の git remote を読む。git の外・remote 無しは undefined、URL から owner/repo を読めなければ UnreadableRemote
*/
export function readCurrentRepository(cwd: string): ResolvedRepository | UnreadableRemote | undefined {
  return readCurrentGitRemote(gitRunnerFor(cwd))
}

/**
今の git remote からリポジトリを解決する。git の外・remote 無し・URL から owner/repo を読めないときは undefined
*/
export function resolveCurrentRepository(cwd: string): ResolvedRepository | undefined {
  const current = readCurrentRepository(cwd)
  return current?.source === 'unreadable-remote' ? undefined : current
}

/**
`--repo` と今の git remote を方針（reject か warn）に従って比べる。
続けてよいなら、明示値から採ったリポジトリ（`--repo` が無ければ undefined）を返す。
止めるときは、stderr に行を書いて CommandExit(1) を投げる。warn の警告は stderr に書いて続ける
*/
export function requireRepositoryMatch(
  mode: PolicyMode,
  explicit: string | undefined,
  io: Readonly<CommandIo>,
  cwd: string,
): RepositoryReference | undefined {
  const outcome = applyRepositoryPolicy({ explicit, resolved: readCurrentRepository(cwd), mode })
  writeLines(io, outcome.stderr, outcome.kind === 'exit')
  if (outcome.kind === 'exit') throw new CommandExit(outcome.exitCode, outcome.failure)
  return outcome.adopted
}

/**
作業ディレクトリが remote を持つ git のリポジトリの中かだけを確かめる。remote の URL は読まない。
削除の先を引数で決めるコマンド（branch delete）が、`--repo` を使わずに使う。
git の外・remote 無しなら、stderr に行を書いて CommandExit(1) を投げる
*/
export function requireGitRemote(io: Readonly<CommandIo>, cwd: string): void {
  if ((listRemotes(cwd) ?? []).length > 0) return
  writeLines(io, [AMBIGUOUS_REPOSITORY_LINE, '  run inside a git repository that has a remote'], true)
  throw new CommandExit(1, 'git-unresolved')
}

// 止まるときは、error の行とその続きの行を、前置きを除いた 1 つの文にして io.error に渡す
function writeLines(io: Readonly<CommandIo>, lines: readonly (string | HintedText)[], isExit: boolean): void {
  const failure: string[] = []
  let isInWarning = false
  for (const line of lines) {
    const text = formatHinted(line, io.surface ?? 'cli')
    io.stderr(`${text}\n`)
    if (text.startsWith(WARNING_PREFIX)) {
      isInWarning = true
      io.warning?.(text.slice(WARNING_PREFIX.length))
    }
    else if (text.startsWith(ERROR_PREFIX)) {
      isInWarning = false
      failure.push(text.slice(ERROR_PREFIX.length))
    }
    else if (!isInWarning) {
      failure.push(text)
    }
  }
  if (isExit && failure.length > 0) io.error?.(failure.join('\n'))
}
