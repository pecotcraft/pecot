// グローバルの `--repo` と、今の git remote のリポジトリの食い違いを扱う（Python の `require_repo_match`）。
// 判定は domain/repository-policy.ts の applyRepositoryPolicy に任せ、ここは git の解決と行の出力、止めるときの終了コードだけを行う。
import { applyRepositoryPolicy } from '../domain/repository-policy.js'
import type { PolicyMode } from '../domain/repository-policy.js'
import { AmbiguousRepositoryError, resolveRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference, ResolvedRepository } from '../domain/repository-resolver.js'
import { gitRunnerFor } from '../infra/git.js'
import { CommandExit } from './command-definition.js'
import type { CommandIo } from './command-definition.js'

/**
今の git remote からリポジトリを解決する。git の外・remote 無しは undefined
*/
export function resolveCurrentRepository(cwd: string): ResolvedRepository | undefined {
  try {
    return resolveRepository(undefined, gitRunnerFor(cwd))
  }
  catch (error: unknown) {
    if (error instanceof AmbiguousRepositoryError) return undefined
    throw error
  }
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
  const outcome = applyRepositoryPolicy({ explicit, resolved: resolveCurrentRepository(cwd), mode })
  for (const line of outcome.stderr) io.stderr(`${line}\n`)
  if (outcome.kind === 'exit') throw new CommandExit(outcome.exitCode)
  return outcome.adopted
}
