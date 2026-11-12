// remote は -D ではなく process.cwd() から読む。
import { applyRepositoryPolicy } from '../domain/repository-policy.js'
import type { PolicyMode } from '../domain/repository-policy.js'
import { AmbiguousRepositoryError, resolveRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference, ResolvedRepository } from '../domain/repository-resolver.js'
import { gitRunnerFor } from '../infra/git.js'
import type { CommandIo } from './registry.js'

/**
続けるときの adopted は、--repo から採用したリポジトリ（--repo が無ければ undefined）
*/
export type RepositoryMatch
  = | { readonly kind: 'proceed', readonly adopted: RepositoryReference | undefined }
    | { readonly kind: 'exit', readonly exitCode: 1 }

function detectCurrent(): ResolvedRepository | undefined {
  try {
    return resolveRepository(undefined, gitRunnerFor(process.cwd()))
  }
  catch (error: unknown) {
    if (error instanceof AmbiguousRepositoryError) return undefined
    throw error
  }
}

/**
確かめて、error か warning の行を io に出す。exit なら、呼び出し側は本体を動かさず exitCode で終わる
*/
export function requireRepositoryMatch(mode: PolicyMode, explicit: string | undefined, io: CommandIo): RepositoryMatch {
  const outcome = applyRepositoryPolicy({ explicit, resolved: detectCurrent(), mode })
  // 行は前置きと字下げが付いているので、createOutput を通さずにそのまま出す
  for (const line of outcome.stderr) io.stderr(`${line}\n`)
  return outcome.kind === 'exit' ? { kind: 'exit', exitCode: outcome.exitCode } : { kind: 'proceed', adopted: outcome.adopted }
}
