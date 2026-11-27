// branch delete。Python の cli/commands/repo.py の delete_branch の移植。
import { z } from 'zod'

import { findRepository } from '@pecot/workflow-core/domain/config.js'
import { compareStrings } from '@pecot/workflow-core/domain/python-format.js'
import { ReferenceParseError, parseRepositoryReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation } from '@pecot/workflow-core/commands-shared/output.js'
import { requireGitRemote } from '@pecot/workflow-core/commands-shared/repository-match.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const BRANCH_DELETE_OUTPUT = z.strictObject({
  branch: z.string().describe('Name of the remote branch'),
  repository: z.string().describe('Repository of the branch (owner/repo)'),
  deleted: z.boolean().describe('Whether the remote branch was deleted'),
})

const branchDeleteCommand = defineTool({
  name: 'branch_delete',
  title: 'Delete remote branch',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Delete a remote branch (a protected branch is never deleted)',
  input: z.strictObject({
    repo: z.string().describe('Repository reference (owner/repo)'),
    branch: z.string().describe('Name of the branch to delete'),
    project: PROJECT_INPUT,
  }),
  output: BRANCH_DELETE_OUTPUT,
  run: async (input, io) => {
    // 位置引数の repo は対象のリポで、cwd と比べる明示値ではない
    requireGitRemote(io, process.cwd())
    const out = createOutput<z.input<typeof BRANCH_DELETE_OUTPUT>>(false, io)
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
    const config = requireConfigFor(out, target, input.project, ['branch', 'delete']).config

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

    // 5. 削除する操作
    const operation: Operation = { verb: 'delete', target: `remote branch ${input.branch} in ${owner}/${repository}` }

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

export const BRANCH_TOOLS: readonly ToolDefinition[] = [branchDeleteCommand]
