// release preflight・create・merge。移す元は cli/commands/release.py。
import path from 'node:path'

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { ChangelogFileNotFoundError, InvalidVersionError, validateSemver } from '../domain/changelog.js'
import { effectiveReleaseType, findPackage, findRepository, getDevelopBranch, getReleaseBranch } from '../domain/config.js'
import type { ProjectConfig, Repository } from '../domain/config.js'
import { DependabotAlertError, fetchDependabotAlertStatus } from '../domain/dependabot.js'
import { PecotError } from '../domain/errors.js'
import { pythonStringRepr } from '../domain/python-format.js'
import { parsePullRequestReference, ReferenceParseError } from '../domain/reference-parser.js'
import { ReleaseError, runPreflight } from '../domain/release.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { fetchCodeScanningStatus, fetchSecretScanningStatus, SecurityAlertError } from '../domain/security-alerts.js'
import type { ScanAlertStatus } from '../domain/security-alerts.js'
import { extractReleaseNotesFromFile, readChangelogIfExists, resolveChangelogPath } from '../infra/changelog-file.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitRunnerFor, gitToplevel, primaryRemoteName, primaryRemoteRepository } from '../infra/git.js'
import { TransportFailure } from '../infra/github/client.js'
import { createDependabotSource } from '../infra/github/dependabot-source.js'
import { GitHubAPIError, GitHubNotFoundError } from '../infra/github/errors.js'
import { createScanAlertSource } from '../infra/github/security-alerts-source.js'
import { NO_ACTIVE_PROJECT } from './command-stop.js'
import { createGitHubClient, makeClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { requireRepositoryMatch } from './repository-match.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const FAILURE = 1

/**
順は採用済みの --repo、グローバルの --repo、主の remote。決められないと error の行を出して undefined を返す。
remote は process.cwd() から読む
*/
export function resolveReleaseTargetRepository(adopted: RepositoryReference | undefined, explicit: string | undefined, out: Readonly<Output>): RepositoryReference | undefined {
  if (adopted !== undefined) return adopted
  if (explicit !== undefined) {
    const parts = splitOwnerRepository(explicit)
    if (parts === undefined) {
      out.error(`invalid --repo format: ${pythonStringRepr(explicit)}\nspecify it as owner/repo`)
      return undefined
    }
    return parts
  }
  const remote = primaryRemoteRepository(process.cwd())
  if (remote === undefined) {
    out.error('could not read the repository from the git remote')
    return undefined
  }
  return { owner: remote.owner, repository: remote.repository }
}

interface ReleaseContext {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
  readonly repositoryConfig: Repository | undefined
  readonly changelogPath: string
  /**
  monorepo のときのパッケージ名。タグの接頭辞になる
  */
  readonly tagPrefix: string | undefined
}

interface ContextOptions {
  readonly version?: string | undefined
  readonly nxAlertsOnly?: boolean
}

// 4 つの場合（packages の有無と --package の有無）を分ける。矛盾があれば error の行を出して undefined を返す
function resolvePackageContext(out: Readonly<Output>, repositoryConfig: Repository | undefined, packageName: string | undefined, gitRoot: string, owner: string, repository: string): { readonly changelogPath: string, readonly tagPrefix: string | undefined } | undefined {
  const packages = repositoryConfig?.packages ?? []
  if (repositoryConfig !== undefined && packages.length > 0) {
    const names = packages.map(item => item.name).join(', ')
    if (packageName === undefined) {
      out.error(`${owner}/${repository} is a monorepo\nspecify --package (available: ${names})`)
      return undefined
    }
    const found = findPackage(repositoryConfig, packageName)
    if (found === undefined) {
      out.error(`package '${packageName}' is not registered in ${owner}/${repository}\navailable: ${names}`)
      return undefined
    }
    return { changelogPath: path.isAbsolute(found.changelog) ? found.changelog : path.join(gitRoot, found.changelog), tagPrefix: found.name }
  }
  if (packageName !== undefined) {
    out.error(`${owner}/${repository} has no packages configured\n--package can only be used in a monorepo`)
    return undefined
  }
  return { changelogPath: resolveChangelogPath(gitRoot, repositoryConfig?.changelog_file), tagPrefix: undefined }
}

function requireBranchSetting(out: Readonly<Output>, branch: string | undefined, kind: 'develop' | 'release', owner: string, repository: string): string | undefined {
  if (branch === undefined || branch === '') {
    out.error(`${kind}_branch is not set for ${owner}/${repository}\nset it with: pecot repo set ${owner}/${repository} --${kind}-branch <branch>`)
    return undefined
  }
  return branch
}

function loadReleaseContext(out: Readonly<Output>, adopted: RepositoryReference | undefined, explicit: string | undefined, packageName: string | undefined, options: Readonly<ContextOptions> = {}): ReleaseContext | undefined {
  const cwd = process.cwd()
  const gitRoot = gitToplevel({ cwd })
  if (gitRoot === undefined) {
    out.error('could not find the root directory of the git repository')
    return undefined
  }
  const target = resolveReleaseTargetRepository(adopted, explicit, out)
  if (target === undefined) return undefined
  const { owner, repository } = target

  const config = loadActiveConfig()
  if (config === undefined) {
    out.error(NO_ACTIVE_PROJECT)
    return undefined
  }

  const repositoryConfig = findRepository(config, owner, repository)
  if (repositoryConfig !== undefined && options.nxAlertsOnly === true && effectiveReleaseType(repositoryConfig) === 'nx') {
    if (packageName !== undefined || options.version !== undefined) {
      out.error('the version argument and --package cannot be used when release_type is nx\nrun it without arguments (Nx Release decides the version)')
      return undefined
    }
    return { config, owner, repository, repositoryConfig, changelogPath: resolveChangelogPath(gitRoot, repositoryConfig.changelog_file), tagPrefix: undefined }
  }
  const resolved = resolvePackageContext(out, repositoryConfig, packageName, gitRoot, owner, repository)
  return resolved === undefined ? undefined : { config, owner, repository, repositoryConfig, ...resolved }
}

function alertLabel(number: number, packageName: string | undefined, severity: string | undefined): string {
  const detail = [packageName, severity].filter(value => value !== undefined && value !== '').join(', ')
  return detail === '' ? `#${String(number)}` : `#${String(number)} (${detail})`
}

// 理由は 1 行目だけを使い、末尾の句点を落とす
function warnAlertsUnavailable(out: Readonly<Output>, reason: string): void {
  const [first = ''] = reason.trim().split(/\r\n|[\n\r]/u, 1)
  out.warning(`could not check Dependabot alerts. The release is not blocked.\nreason: ${first.trim().replace(/\.+$/u, '').trimEnd()}`)
}

// open の Dependabot alert は警告だけで、リリースを止めない
async function checkDependabotAlerts(out: Readonly<Output>, config: ProjectConfig, owner: string, repository: string): Promise<void> {
  let status
  try {
    const client = createGitHubClient(out, config.host)
    status = await fetchDependabotAlertStatus(createDependabotSource(client), config.host, owner, repository)
  }
  catch (error: unknown) {
    if (error instanceof DependabotAlertError) {
      warnAlertsUnavailable(out, error.message)
      return
    }
    if (error instanceof GitHubAPIError) {
      warnAlertsUnavailable(out, error.message)
      return
    }
    throw error
  }

  if (!status.enabled) {
    out.done({ verb: 'skip', target: 'Dependabot alerts (feature disabled)' })
    return
  }
  if (status.openCount === 0) {
    out.count('open Dependabot alerts', 0)
    return
  }
  const severity = status.maxSeverity === undefined ? '' : ` (highest severity: ${status.maxSeverity})`
  const listing = status.openAlerts.map(alert => `\n${alertLabel(alert.number, alert.package, alert.severity)}`).join('')
  const noun = status.openCount === 1 ? 'alert' : 'alerts'
  out.warning(`${String(status.openCount)} open Dependabot ${noun}${severity}. The release is not blocked.${listing}\n→ ${status.alertsUrl}`)
}

/**
code scanning・secret scanning の open の alert があれば、false を返す。機能が無効のリポジトリは通る
*/
async function isScanningPassed(out: Readonly<Output>, name: string, fetchStatus: () => Promise<ScanAlertStatus>): Promise<boolean> {
  let status: ScanAlertStatus
  try {
    status = await fetchStatus()
  }
  catch (error: unknown) {
    if (!(error instanceof SecurityAlertError)) throw error
    out.error(`could not check ${name}: ${error.message}`)
    return false
  }
  if (!status.enabled) {
    out.done({ verb: 'skip', target: `${name} (feature disabled)` })
    return true
  }
  if (status.openCount === 0) {
    out.count(`open ${name} alerts`, 0)
    return true
  }
  const listing = status.openNumbers.map(number => `\n#${String(number)}`).join('')
  out.error(`${name} has ${String(status.openCount)} open ${status.openCount === 1 ? 'alert' : 'alerts'}${listing}\n→ ${status.alertsUrl}\nclose them (fixed, or dismissed with a reason) and run again`)
  return false
}

/**
3 種を確かめる。1 つが失敗しても残りを続け、最後に成否を返す
*/
async function areAlertsPassed(out: Readonly<Output>, config: ProjectConfig, owner: string, repository: string): Promise<boolean> {
  const checks: readonly (() => Promise<boolean>)[] = [
    async () => {
      await checkDependabotAlerts(out, config, owner, repository)
      return true
    },
    async () => await isScanningPassed(out, 'code scanning', async () => await fetchCodeScanningStatus(createScanAlertSource(createGitHubClient(out, config.host)), config.host, owner, repository)),
    async () => await isScanningPassed(out, 'secret scanning', async () => await fetchSecretScanningStatus(createScanAlertSource(createGitHubClient(out, config.host)), config.host, owner, repository)),
  ]
  let isPassed = true
  for (const check of checks) {
    try {
      if (!await check()) isPassed = false
    }
    catch (error: unknown) {
      if (!(error instanceof PecotError) && !(error instanceof TransportFailure)) throw error
      out.error(`could not check alerts: ${error.message}`)
      isPassed = false
    }
  }
  return isPassed
}

const preflight = defineCommand({
  path: ['release', 'preflight'],
  description: 'Run the pre-release checks (preflight); for an nx repository only the alerts are checked',
  input: z.object({
    version: z.string().optional().describe('Release version (detected from the CHANGELOG when omitted)'),
    package: z.string().optional().describe('Package name in a monorepo (required for repositories with packages configured)'),
  }),
  positional: ['version'],
  interactive: false,
  run: async (input, io) => {
    const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
    const out = createOutput(false, io)
    const cwd = process.cwd()
    const context = loadReleaseContext(out, adopted, input.repo, input.package, { version: input.version, nxAlertsOnly: true })
    if (context === undefined) return FAILURE
    const { config, owner, repository } = context

    const isAlertsPassed = await areAlertsPassed(out, config, owner, repository)
    if (!isAlertsPassed) return FAILURE
    if (context.repositoryConfig !== undefined && effectiveReleaseType(context.repositoryConfig) === 'nx') return 0

    const developBranch = requireBranchSetting(out, getDevelopBranch(config, owner, repository), 'develop', owner, repository)
    if (developBranch === undefined) return FAILURE
    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)
    if (releaseBranch === undefined) return FAILURE

    const remote = primaryRemoteName(cwd) ?? 'origin'
    try {
      const result = runPreflight({
        changelogPath: context.changelogPath,
        changelogContent: readChangelogIfExists(context.changelogPath),
        developBranch,
        releaseBranch,
        version: input.version,
        tagPrefix: context.tagPrefix,
        remote,
      }, gitRunnerFor(cwd))
      out.count(`commits to release (${remote}/${result.developBranch} -> ${remote}/${result.releaseBranch})`, result.diffCount)
      out.data(`version: ${result.version}\ntag: ${result.tagName}\n\n${result.releaseNotes}`)
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof ReleaseError)) throw error
      out.error(error.message)
      return FAILURE
    }
  },
})

const create = defineCommand({
  path: ['release', 'create'],
  description: 'Create a GitHub release and its tag (the release notes come from the CHANGELOG)',
  input: z.object({
    version: z.string().describe('Release version (for example 0.6.1)'),
    dry_run: z.boolean().default(false).describe('Show what would happen without changing anything'),
    package: z.string().optional().describe('Package name in a monorepo (required for repositories with packages configured)'),
  }),
  positional: ['version'],
  interactive: false,
  run: async (input, io) => {
    const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
    const out = createOutput(input.dry_run, io)

    try {
      validateSemver(input.version)
    }
    catch (error: unknown) {
      if (!(error instanceof InvalidVersionError)) throw error
      out.error(error.message)
      return FAILURE
    }

    const context = loadReleaseContext(out, adopted, input.repo, input.package)
    if (context === undefined) return FAILURE
    const { config, owner, repository, tagPrefix } = context

    let releaseNotes: string
    try {
      releaseNotes = extractReleaseNotesFromFile(context.changelogPath, input.version)
    }
    catch (error: unknown) {
      if (!(error instanceof PecotError) && !(error instanceof ChangelogFileNotFoundError)) throw error
      out.error(error.message)
      return FAILURE
    }

    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)
    if (releaseBranch === undefined) return FAILURE

    const tagName = tagPrefix === undefined ? `v${input.version}` : `${tagPrefix}-v${input.version}`
    const releaseName = tagPrefix === undefined ? tagName : `${tagPrefix} v${input.version}`
    const operation: Operation = { verb: 'create', target: `release ${tagName} on ${releaseBranch}` }

    if (input.dry_run) {
      out.planned(operation)
      out.data(releaseNotes)
      return 0
    }

    const client = makeClient(out, config)
    if (client === undefined) return FAILURE
    try {
      const result = await client.createRelease(owner, repository, tagName, releaseName, releaseNotes, { targetCommitish: releaseBranch })
      out.done(operation)
      const url = result['html_url']
      out.data(typeof url === 'string' ? url : '')
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not create release ${tagName} in ${owner}/${repository}: ${describeApiError(error)}`)
      return FAILURE
    }
  },
})

const merge = defineCommand({
  path: ['release', 'merge'],
  description: 'Merge a release PR with a regular merge',
  input: z.object({
    pr_ref: z.string().describe('PR reference (owner/repo/123)'),
    dry_run: z.boolean().default(false).describe('Show what would happen without merging'),
    delete_branch: z.boolean().default(false).describe('Delete the branch after merging'),
    admin: z.boolean().default(false).describe('Merge with admin rights (skip the mergeability check)'),
  }),
  positional: ['pr_ref'],
  shortFlags: { dry_run: '-n', delete_branch: '-d' },
  interactive: false,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput(input.dry_run, io)
    const config = loadActiveConfig()
    if (config === undefined) {
      out.error(NO_ACTIVE_PROJECT)
      return FAILURE
    }

    let reference
    try {
      reference = parsePullRequestReference(input.pr_ref)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      out.error(error.message)
      return USAGE_EXIT_CODE
    }
    const { owner, repository } = reference.repository
    const number = reference.number
    const pullRequestName = `${owner}/${repository}/${String(number)}`

    let client
    let pullRequest
    try {
      client = createGitHubClient(out, config.host)
      pullRequest = await client.getPullRequestSlim(owner, repository, number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) {
        out.error(`PR ${pullRequestName} not found`)
        return FAILURE
      }
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not read PR ${pullRequestName}: ${describeApiError(error)}`)
      return FAILURE
    }

    if (pullRequest.state === 'MERGED') {
      out.error(`PR #${String(number)} is already merged`)
      return FAILURE
    }
    if (pullRequest.state === 'CLOSED') {
      out.error(`PR #${String(number)} is closed`)
      return FAILURE
    }
    if (pullRequest.mergeable === 'CONFLICTING' && !input.admin) {
      out.error(`PR #${String(number)} has conflicts that must be resolved\nto try a forced merge, add --admin`)
      return FAILURE
    }
    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)
    if (releaseBranch === undefined) return FAILURE
    if (pullRequest.base_ref !== releaseBranch) {
      out.error(`the base branch of PR #${String(number)} does not match release_branch\nbase: ${pullRequest.base_ref}\nrelease_branch: ${releaseBranch}`)
      return FAILURE
    }

    const headBranch = pullRequest.head_ref
    const operation: Operation = { verb: 'merge', target: `PR ${pullRequestName} (${headBranch} -> ${pullRequest.base_ref}, merge commit)` }
    if (input.dry_run) {
      out.planned(operation)
      return 0
    }

    try {
      await client.mergePullRequest(owner, repository, number, 'merge')
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not merge PR ${pullRequestName}: ${describeApiError(error)}`)
      return FAILURE
    }
    out.done(operation)

    if (input.delete_branch) {
      try {
        await client.deleteBranch(owner, repository, headBranch)
        out.done({ verb: 'delete', target: `remote branch ${headBranch} in ${owner}/${repository}` })
      }
      catch (error: unknown) {
        if (!(error instanceof GitHubAPIError)) throw error
        out.warning(`deleting remote branch ${headBranch} failed: ${describeApiError(error)}`)
      }
    }
    return 0
  },
})

export const RELEASE_COMMANDS: readonly CommandDefinition[] = [preflight, create, merge]
