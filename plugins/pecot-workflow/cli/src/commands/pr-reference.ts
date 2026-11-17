// PR の参照（pr_ref）の読み方。pr show・pr merge・session finish が共有する。
import { ReferenceParseError, parsePullRequestReference } from '../domain/reference-parser.js'
import { resolveShortReferenceBase, withUnreadableReason } from '../domain/repository-resolver.js'
import { gitRunnerFor } from '../infra/git.js'
import { stopWith } from './command-stop.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

export const PR_REFERENCE_DESCRIPTION = 'PR reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)'

export function parseReference(reference: string, globalRepository: string | undefined, out: Readonly<Output>): { readonly owner: string, readonly repository: string, readonly number: number } {
  const { base, unreadable } = resolveShortReferenceBase(globalRepository, gitRunnerFor(process.cwd()))
  try {
    const parsed = parsePullRequestReference(reference, base, { repositoryFlag: true })
    return { owner: parsed.repository.owner, repository: parsed.repository.repository, number: parsed.number }
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return stopWith(out, withUnreadableReason(error.hintedText ?? error.message, unreadable), 'invalid-input', USAGE_EXIT_CODE)
    throw error
  }
}
