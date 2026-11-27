// release check・create・merge。移す元は cli/commands/release.py。

import { z } from 'zod'

import { describeApiError } from '@pecot/workflow-core/domain/api-error-detail.js'
import { ChangelogFileNotFoundError } from '@pecot/workflow-core/domain/changelog.js'
import { getReleaseBranch } from '@pecot/workflow-core/domain/config.js'
import { PecotError } from '@pecot/workflow-core/domain/errors.js'
import { parsePullRequestReference, ReferenceParseError } from '@pecot/workflow-core/domain/reference-parser.js'
import { extractReleaseNotesFromFile } from '@pecot/workflow-core/infra/changelog-file.js'
import { GitHubAPIError, GitHubNotFoundError } from '@pecot/workflow-core/infra/github/errors.js'
import { hinted, inputHint } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { createGitHubClient, makeClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { issuePath } from '@pecot/workflow-core/commands-shared/issue-shared.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { requireRepositoryMatch } from '@pecot/workflow-core/commands-shared/repository-match.js'
import { loadReleaseContext, RELEASE_CHECK_INPUT, RELEASE_CHECK_OUTPUT, requireBranchSetting, requireSemver, runReleaseCheck } from '@pecot/workflow-core/commands-shared/release-check.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const releaseCheckCommand = defineTool({
  name: 'release_check',
  title: 'Check release readiness',
  description: 'Run the pre-release checks; for an nx repository only the alerts are checked',
  input: RELEASE_CHECK_INPUT,
  output: RELEASE_CHECK_OUTPUT,
  run: runReleaseCheck,
})

const RELEASE_CREATE_OUTPUT = z.strictObject({
  tag: z.string().describe('Tag of the release'),
  url: z.string().optional().describe('URL of the created release (omitted when the response has none)'),
  releaseNotes: z.string().describe('Release notes from the CHANGELOG'),
})

const releaseCreateCommand = defineTool({
  name: 'release_create',
  title: 'Create release',
  description: 'Create a GitHub release and its tag (the release notes come from the CHANGELOG)',
  input: z.object({
    version: z.string().describe('Release version (for example 0.6.1)'),
    package: z.string().optional().describe('Package name in a monorepo (required for repositories with packages configured)'),
    project: PROJECT_INPUT,
  }),
  output: RELEASE_CREATE_OUTPUT,
  run: async (input, io) => {
    const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
    const out = createOutput<z.input<typeof RELEASE_CREATE_OUTPUT>>(false, io)

    requireSemver(out, input.version)

    const context = loadReleaseContext(out, adopted, input.repo, input.package, input.project, ['release', 'create'])
    const { config, owner, repository, tagPrefix } = context

    let releaseNotes: string
    try {
      releaseNotes = extractReleaseNotesFromFile(context.changelogPath, input.version)
    }
    catch (error: unknown) {
      if (!(error instanceof PecotError) && !(error instanceof ChangelogFileNotFoundError)) throw error
      return stopWith(out, error.message, 'preflight-failed')
    }

    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)

    const tagName = tagPrefix === undefined ? `v${input.version}` : `${tagPrefix}-v${input.version}`
    const releaseName = tagPrefix === undefined ? tagName : `${tagPrefix} v${input.version}`
    const operation: Operation = { verb: 'create', target: `release ${tagName} on ${releaseBranch}` }

    const client = await makeClient(out, config)
    try {
      const result = await client.createRelease(owner, repository, tagName, releaseName, releaseNotes, { targetCommitish: releaseBranch })
      out.done(operation)
      const url = result['html_url']
      out.result({ tag: tagName, releaseNotes, ...typeof url === 'string' && { url } })
      out.data(typeof url === 'string' ? url : '')
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not create release ${tagName} in ${owner}/${repository}: ${describeApiError(error)}`, kindOfFailure(error))
    }
  },
})

const RELEASE_MERGE_OUTPUT = z.strictObject({
  pullRequest: z.string().describe('Release PR (owner/repo/N)'),
  head: z.string().describe('Head branch of the PR'),
  base: z.string().describe('Base branch of the PR (the release branch)'),
  deletedBranch: z.boolean().describe('Whether the remote head branch was deleted (false without delete_branch or when the deletion failed)'),
})

const releaseMergeCommand = defineTool({
  name: 'release_merge',
  title: 'Merge release PR',
  description: 'Merge a release PR with a regular merge',
  input: z.object({
    pr_ref: z.string().describe('PR reference (owner/repo/123)'),
    delete_branch: z.boolean().default(false).describe('Delete the branch after merging'),
    admin: z.boolean().default(false).describe('Merge with admin rights (skip the mergeability check)'),
    project: PROJECT_INPUT,
  }),
  output: RELEASE_MERGE_OUTPUT,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput<z.input<typeof RELEASE_MERGE_OUTPUT>>(false, io)
    let reference
    try {
      reference = parsePullRequestReference(input.pr_ref)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      return stopWith(out, error.message, 'invalid-input', USAGE_EXIT_CODE)
    }
    const { owner, repository } = reference.repository
    const number = reference.number
    const pullRequestName = issuePath(owner, repository, number)
    const config = requireConfigFor(out, reference.repository, input.project, ['release', 'merge']).config

    let client
    let pullRequest
    try {
      client = createGitHubClient(out, config.host)
      pullRequest = await client.getPullRequestSlim(owner, repository, number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) return stopWith(out, `PR ${pullRequestName} not found`, 'github-not-found')
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not read PR ${pullRequestName}: ${describeApiError(error)}`, kindOfFailure(error))
    }

    if (pullRequest.state === 'MERGED') stopWith(out, `PR #${String(number)} is already merged`, 'pr-state')
    else if (pullRequest.state === 'CLOSED') stopWith(out, `PR #${String(number)} is closed`, 'pr-state')
    if (pullRequest.mergeable === 'CONFLICTING' && !input.admin) {
      stopWith(out, hinted`PR #${String(number)} has conflicts that must be resolved\nto try a forced merge, add ${inputHint(['release', 'merge'], 'admin')}`, 'pr-state')
    }
    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)
    if (pullRequest.base_ref !== releaseBranch) {
      stopWith(out, `the base branch of PR #${String(number)} does not match release_branch\nbase: ${pullRequest.base_ref}\nrelease_branch: ${releaseBranch}`, 'pr-state')
    }

    const headBranch = pullRequest.head_ref
    const operation: Operation = { verb: 'merge', target: `PR ${pullRequestName} (${headBranch} -> ${pullRequest.base_ref}, merge commit)` }
    const merged = { pullRequest: pullRequestName, head: headBranch, base: pullRequest.base_ref, deletedBranch: false }

    try {
      await client.mergePullRequest(owner, repository, number, 'merge')
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not merge PR ${pullRequestName}: ${describeApiError(error)}`, kindOfFailure(error))
    }
    out.done(operation)
    out.result(merged)

    if (input.delete_branch) {
      try {
        await client.deleteBranch(owner, repository, headBranch)
        out.done({ verb: 'delete', target: `remote branch ${headBranch} in ${owner}/${repository}` })
        out.result({ deletedBranch: true })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        out.warning(`deleting remote branch ${headBranch} failed: ${describeApiError(error)}`)
      }
    }
    return 0
  },
})

export const RELEASE_TOOLS: readonly ToolDefinition[] = [releaseCheckCommand, releaseCreateCommand, releaseMergeCommand]
