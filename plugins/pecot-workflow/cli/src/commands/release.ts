// release check・create・merge。移す元は cli/commands/release.py。
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
import { commandHint, hinted, inputHint, inputNameHint, placeholder } from './command-hint.js'
import { NO_ACTIVE_PROJECT, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient, makeClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { requireRepositoryMatch } from './repository-match.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const CHECK_PATH = ['release', 'check']

/**
順は採用済みの --repo、グローバルの --repo、主の remote。決められないと error の行を出して終了コード 1 で止める。
remote は process.cwd() から読む
*/
export function requireReleaseTargetRepository(adopted: RepositoryReference | undefined, explicit: string | undefined, out: Readonly<Output>): RepositoryReference {
  if (adopted !== undefined) return adopted
  if (explicit !== undefined) {
    return splitOwnerRepository(explicit) ?? stopWith(out, hinted`invalid ${inputNameHint(CHECK_PATH, 'repo')} format: ${pythonStringRepr(explicit)}\nspecify it as owner/repo`, 'invalid-input')
  }
  const remote = primaryRemoteRepository(process.cwd()) ?? stopWith(out, 'could not read the repository from the git remote', 'git-unresolved')
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

// 4 つの場合（packages の有無と --package の有無）を分ける。矛盾があれば error の行を出して止める
function resolvePackageContext(out: Readonly<Output>, repositoryConfig: Repository | undefined, packageName: string | undefined, gitRoot: string, owner: string, repository: string): { readonly changelogPath: string, readonly tagPrefix: string | undefined } {
  const packages = repositoryConfig?.packages ?? []
  if (repositoryConfig !== undefined && packages.length > 0) {
    const names = packages.map(item => item.name).join(', ')
    if (packageName === undefined) stopWith(out, hinted`${owner}/${repository} is a monorepo\nspecify ${inputNameHint(['release', 'check'], 'package')} (available: ${names})`, 'invalid-input')
    const found = findPackage(repositoryConfig, packageName) ?? stopWith(out, `package '${packageName}' is not registered in ${owner}/${repository}\navailable: ${names}`, 'invalid-input')
    return { changelogPath: path.isAbsolute(found.changelog) ? found.changelog : path.join(gitRoot, found.changelog), tagPrefix: found.name }
  }
  if (packageName !== undefined) stopWith(out, `${owner}/${repository} has no packages configured\n--package can only be used in a monorepo`, 'invalid-input')
  return { changelogPath: resolveChangelogPath(gitRoot, repositoryConfig?.changelog_file), tagPrefix: undefined }
}

function requireBranchSetting(out: Readonly<Output>, branch: string | undefined, kind: 'develop' | 'release', owner: string, repository: string): string {
  return branch === undefined || branch === '' ? stopWith(out, hinted`${kind}_branch is not set for ${owner}/${repository}\nset it with: ${commandHint(['project', 'link'], { repo: `${owner}/${repository}`, [`${kind}_branch`]: placeholder('branch') })}`, 'repo-setting-missing') : branch
}

function loadReleaseContext(out: Readonly<Output>, adopted: RepositoryReference | undefined, explicit: string | undefined, packageName: string | undefined, options: Readonly<ContextOptions> = {}): ReleaseContext {
  const cwd = process.cwd()
  const gitRoot = gitToplevel({ cwd }) ?? stopWith(out, 'could not find the root directory of the git repository', 'git-unresolved')
  const { owner, repository } = requireReleaseTargetRepository(adopted, explicit, out)
  const config = loadActiveConfig() ?? stopWith(out, NO_ACTIVE_PROJECT, 'no-active-project')

  const repositoryConfig = findRepository(config, owner, repository)
  if (repositoryConfig !== undefined && options.nxAlertsOnly === true && effectiveReleaseType(repositoryConfig) === 'nx') {
    if (packageName !== undefined || options.version !== undefined) {
      stopWith(out, hinted`the version argument and ${inputNameHint(CHECK_PATH, 'package')} cannot be used when release_type is nx\nrun it without arguments (Nx Release decides the version)`, 'invalid-input')
    }
    return { config, owner, repository, repositoryConfig, changelogPath: resolveChangelogPath(gitRoot, repositoryConfig.changelog_file), tagPrefix: undefined }
  }
  return { config, owner, repository, repositoryConfig, ...resolvePackageContext(out, repositoryConfig, packageName, gitRoot, owner, repository) }
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
    out.done({ verb: 'skip', target: 'Dependabot alerts (feature disabled)', aside: true })
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
    out.done({ verb: 'skip', target: `${name} (feature disabled)`, aside: true })
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

const releaseCheckCommand = defineCommand({
  path: CHECK_PATH,
  description: 'Run the pre-release checks; for an nx repository only the alerts are checked',
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
    const { config, owner, repository } = context

    const isAlertsPassed = await areAlertsPassed(out, config, owner, repository)
    if (!isAlertsPassed) throw new CommandExit(1, 'preflight-failed')
    if (context.repositoryConfig !== undefined && effectiveReleaseType(context.repositoryConfig) === 'nx') return 0

    const developBranch = requireBranchSetting(out, getDevelopBranch(config, owner, repository), 'develop', owner, repository)
    const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)

    const remote = primaryRemoteName(cwd) ?? 'origin'
    try {
      const client = createGitHubClient(out, config.host)
      const result = await runPreflight({
        changelogPath: context.changelogPath,
        changelogContent: readChangelogIfExists(context.changelogPath),
        developBranch,
        releaseBranch,
        version: input.version,
        tagPrefix: context.tagPrefix,
        remote,
      }, gitRunnerFor(cwd), async (base, head) => await client.countCommitsAhead(owner, repository, base, head))
      out.count(`commits to release (${remote}/${result.developBranch} -> ${remote}/${result.releaseBranch})`, result.diffCount)
      out.data(`version: ${result.version}\ntag: ${result.tagName}\n\n${result.releaseNotes}`)
      return 0
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError || error instanceof TransportFailure) {
        return stopWith(out, `could not count the commits from ${releaseBranch} to ${developBranch}: ${error.message}`, kindOfFailure(error))
      }
      if (!(error instanceof ReleaseError)) throw error
      return stopWith(out, error.message, 'preflight-failed')
    }
  },
})

const releaseCreateCommand = defineCommand({
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
      return stopWith(out, error.message, 'invalid-input')
    }

    const context = loadReleaseContext(out, adopted, input.repo, input.package)
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

    if (input.dry_run) {
      out.planned(operation)
      out.data(releaseNotes)
      return 0
    }

    const client = makeClient(out, config)
    try {
      const result = await client.createRelease(owner, repository, tagName, releaseName, releaseNotes, { targetCommitish: releaseBranch })
      out.done(operation)
      const url = result['html_url']
      out.data(typeof url === 'string' ? url : '')
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not create release ${tagName} in ${owner}/${repository}: ${describeApiError(error)}`, kindOfFailure(error))
    }
  },
})

const releaseMergeCommand = defineCommand({
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
    const config = loadActiveConfig() ?? stopWith(out, NO_ACTIVE_PROJECT, 'no-active-project')

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
    const pullRequestName = `${owner}/${repository}/${String(number)}`

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
    if (input.dry_run) {
      out.planned(operation)
      return 0
    }

    try {
      await client.mergePullRequest(owner, repository, number, 'merge')
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not merge PR ${pullRequestName}: ${describeApiError(error)}`, kindOfFailure(error))
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

export const RELEASE_COMMANDS: readonly CommandDefinition[] = [releaseCheckCommand, releaseCreateCommand, releaseMergeCommand]
