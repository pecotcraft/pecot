// branch delete。Python の cli/commands/repo.py の delete_branch の移植。
import { z } from 'zod'

import { findRepository } from '../domain/config.js'
import { compareStrings } from '../domain/python-format.js'
import { ReferenceParseError, parseRepositoryReference } from '../domain/reference-parser.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Operation } from './output.js'
import { requireRepositoryMatch } from './repository-match.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const BRANCH_DELETE_OUTPUT = z.strictObject({
  branch: z.string().describe('Name of the remote branch'),
  repository: z.string().describe('Repository of the branch (owner/repo)'),
  deleted: z.boolean().describe('Whether the remote branch was deleted (false on dry_run)'),
  dryRun: DRY_RUN_FIELD,
})

const branchDeleteCommand = defineCommand({
  path: ['branch', 'delete'],
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Delete a remote branch (a protected branch is never deleted)',
  input: z.strictObject({
    repo: z.string().describe('Repository reference (owner/repo)'),
    branch: z.string().describe('Name of the branch to delete'),
    dry_run: z.boolean().default(false).describe('Show what would be deleted without deleting anything'),
  }),
  output: BRANCH_DELETE_OUTPUT,
  positional: ['repo', 'branch'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    // 位置引数の repo は対象のリポで、cwd と比べる明示値ではない
    requireRepositoryMatch('reject', undefined, io, process.cwd())
    const out = createOutput<z.input<typeof BRANCH_DELETE_OUTPUT>>(input.dry_run, io)
    // 1. repo をパース
    let target
    try {
      target = parseRepositoryReference(input.repo)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      return stopWith(out, error.message, 'invalid-input', USAGE_EXIT_CODE)
    }
    const { owner, repository } = target

    // 2. 設定取得
    const config = requireActiveConfig(out)

    // 3. 保護ブランチ収集（設定の develop_branch・release_branch と、API の既定ブランチ）
    const protectedBranches = new Set<string>()
    const repositoryConfig = findRepository(config, owner, repository)
    for (const branch of [repositoryConfig?.develop_branch, repositoryConfig?.release_branch]) {
      if (branch !== undefined && branch !== '') protectedBranches.add(branch)
    }

    let client
    try {
      client = createGitHubClient(out, config.host)
      protectedBranches.add(await client.getRepositoryDefaultBranch(owner, repository))
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not read the default branch of ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
    }

    // 4. 保護ブランチチェック
    if (protectedBranches.has(input.branch)) {
      return stopWith(out, `${input.branch} is a protected branch\nprotected: ${[...protectedBranches].toSorted(compareStrings).join(', ')}`, 'guard-blocked')
    }

    // 5. dry-run
    const operation: Operation = { verb: 'delete', target: `remote branch ${input.branch} in ${owner}/${repository}` }
    if (input.dry_run) {
      out.planned(operation)
      out.result({ branch: input.branch, repository: `${owner}/${repository}`, deleted: false })
      return 0
    }

    // 6. 削除実行
    try {
      await client.deleteBranch(owner, repository, input.branch)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not delete remote branch ${input.branch} in ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
    }
    out.done(operation)
    out.result({ branch: input.branch, repository: `${owner}/${repository}`, deleted: true })
    return 0
  },
})

export const BRANCH_COMMANDS: readonly CommandDefinition[] = [branchDeleteCommand]
