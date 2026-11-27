// リリース前の確認（release_check）の判定。MCP のツールと actions/ の release-check が共有する。
// release create・merge が使う文脈の読み込みも、ここに置く。
import path from 'node:path'

import { z } from 'zod'

import { InvalidVersionError, validateSemver } from '../domain/changelog.js'
import { effectiveReleaseType, findPackage, findRepository, getDevelopBranch, getReleaseBranch } from '../domain/config.js'
import type { ProjectConfig, Repository } from '../domain/config.js'
import { DependabotAlertError, fetchDependabotAlertStatus } from '../domain/dependabot.js'
import type { DependabotAlertStatus } from '../domain/dependabot.js'
import { PecotError } from '../domain/errors.js'
import { pythonStringRepr } from '../domain/python-format.js'
import { ReleaseError, runPreflight } from '../domain/release.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { fetchCodeScanningStatus, fetchSecretScanningStatus, SecurityAlertError } from '../domain/security-alerts.js'
import type { ScanAlertStatus } from '../domain/security-alerts.js'
import { readChangelogIfExists, resolveChangelogPath } from '../infra/changelog-file.js'
import { gitRunnerFor, gitToplevel, primaryRemoteName, primaryRemoteRepository, remoteTagExists } from '../infra/git.js'
import { TransportFailure } from '../infra/github/client.js'
import { createDependabotSource } from '../infra/github/dependabot-source.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { createScanAlertSource } from '../infra/github/security-alerts-source.js'
import { CommandExit } from './command-definition.js'
import type { CommandIo } from './command-definition.js'
import { commandHint, hinted, inputNameHint, placeholder } from './command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createAuthenticatedGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { requireRepositoryMatch } from './repository-match.js'

export const CHECK_PATH = ['release', 'check']

/**
順は採用済みの repo、明示の repo、主の remote。決められないと error の行を出して終了コード 1 で止める。
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

export interface ReleaseContext {
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

export interface ContextOptions {
  readonly version?: string | undefined
  readonly nxAlertsOnly?: boolean
}

// 4 つの場合（packages の有無と package の有無）を分ける。矛盾があれば error の行を出して止める
function resolvePackageContext(out: Readonly<Output>, repositoryConfig: Repository | undefined, packageName: string | undefined, gitRoot: string, owner: string, repository: string): { readonly changelogPath: string, readonly tagPrefix: string | undefined } {
  const packages = repositoryConfig?.packages ?? []
  if (repositoryConfig !== undefined && packages.length > 0) {
    const names = packages.map(item => item.name).join(', ')
    if (packageName === undefined) stopWith(out, hinted`${owner}/${repository} is a monorepo\nspecify ${inputNameHint(CHECK_PATH, 'package')} (available: ${names})`, 'invalid-input')
    const found = findPackage(repositoryConfig, packageName) ?? stopWith(out, `package '${packageName}' is not registered in ${owner}/${repository}\navailable: ${names}`, 'invalid-input')
    return { changelogPath: path.isAbsolute(found.changelog) ? found.changelog : path.join(gitRoot, found.changelog), tagPrefix: found.name }
  }
  if (packageName !== undefined) stopWith(out, hinted`${owner}/${repository} has no packages configured\n${inputNameHint(CHECK_PATH, 'package')} can only be used in a monorepo`, 'invalid-input')
  return { changelogPath: resolveChangelogPath(gitRoot, repositoryConfig?.changelog_file), tagPrefix: undefined }
}

export function requireSemver(out: Readonly<Output>, version: string): void {
  try {
    validateSemver(version)
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidVersionError)) throw error
    stopWith(out, error.message, 'invalid-input')
  }
}

export function requireBranchSetting(out: Readonly<Output>, branch: string | undefined, kind: 'develop' | 'release', owner: string, repository: string): string {
  return branch === undefined || branch === '' ? stopWith(out, hinted`${kind}_branch is not set for ${owner}/${repository}\nset it with: ${commandHint(['project', 'link'], { repo: `${owner}/${repository}`, [`${kind}_branch`]: placeholder('branch') })}`, 'repo-setting-missing') : branch
}

export function loadReleaseContext(out: Readonly<Output>, adopted: RepositoryReference | undefined, explicit: string | undefined, packageName: string | undefined, project: string | undefined, commandPath: readonly string[], options: Readonly<ContextOptions> = {}): ReleaseContext {
  const cwd = process.cwd()
  const gitRoot = gitToplevel({ cwd }) ?? stopWith(out, 'could not find the root directory of the git repository', 'git-unresolved')
  const target = requireReleaseTargetRepository(adopted, explicit, out)
  const { owner, repository } = target
  const config = requireConfigFor(out, target, project, commandPath).config

  const repositoryConfig = findRepository(config, owner, repository)
  if (repositoryConfig !== undefined && options.nxAlertsOnly === true && effectiveReleaseType(repositoryConfig) === 'nx') {
    if (packageName !== undefined || options.version !== undefined) {
      stopWith(out, hinted`${inputNameHint(CHECK_PATH, 'version')} and ${inputNameHint(CHECK_PATH, 'package')} cannot be used when release_type is nx\ncall the tool without them (Nx Release decides the version)`, 'invalid-input')
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

// open の Dependabot alert は警告だけで、リリースを止めない。読めた状態を返し、読めなければ undefined
async function checkDependabotAlerts(out: Readonly<Output>, config: ProjectConfig, owner: string, repository: string, skip: (target: string) => void): Promise<DependabotAlertStatus | undefined> {
  let status
  try {
    const client = await createAuthenticatedGitHubClient(out, config.host)
    status = await fetchDependabotAlertStatus(createDependabotSource(client), config.host, owner, repository)
  }
  catch (error: unknown) {
    if (error instanceof DependabotAlertError) {
      warnAlertsUnavailable(out, error.message)
      return undefined
    }
    if (error instanceof GitHubAPIError) {
      warnAlertsUnavailable(out, error.message)
      return undefined
    }
    throw error
  }

  if (!status.enabled) {
    skip('Dependabot alerts (feature disabled)')
    return status
  }
  if (status.openCount === 0) {
    out.count('open Dependabot alerts', 0)
    return status
  }
  const severity = status.maxSeverity === undefined ? '' : ` (highest severity: ${status.maxSeverity})`
  const listing = status.openAlerts.map(alert => `\n${alertLabel(alert.number, alert.package, alert.severity)}`).join('')
  const noun = status.openCount === 1 ? 'alert' : 'alerts'
  out.warning(`${String(status.openCount)} open Dependabot ${noun}${severity}. The release is not blocked.${listing}\n→ ${status.alertsUrl}`)
  return status
}

/**
code scanning・secret scanning の open の alert があれば、false を返す。機能が無効のリポジトリは通る
*/
async function isScanningPassed(out: Readonly<Output>, name: string, fetchStatus: () => Promise<ScanAlertStatus>, skip: (target: string) => void): Promise<boolean> {
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
    skip(`${name} (feature disabled)`)
    return true
  }
  if (status.openCount === 0) {
    out.count(`open ${name} alerts`, 0)
    return true
  }
  const listing = status.openNumbers.map(number => `\n#${String(number)}`).join('')
  out.error(hinted`${name} has ${String(status.openCount)} open ${status.openCount === 1 ? 'alert' : 'alerts'}${listing}\n→ ${status.alertsUrl}\nclose them (fixed, or dismissed with a reason) and run the check again`)
  return false
}

interface AlertChecks {
  readonly isPassed: boolean
  /**
  skipped: の行に出した確認
  */
  readonly skipped: readonly string[]
  /**
  Dependabot alert の状態。読めなければ undefined
  */
  readonly dependabot: DependabotAlertStatus | undefined
}

/**
3 種を確かめる。1 つが失敗しても残りを続け、最後に成否を返す
*/
async function checkAlerts(out: Readonly<Output>, config: ProjectConfig, owner: string, repository: string): Promise<AlertChecks> {
  const skipped: string[] = []
  const skip = (target: string): void => {
    out.done({ verb: 'skip', target, aside: true })
    skipped.push(target)
  }
  let dependabot: DependabotAlertStatus | undefined
  const checks: readonly (() => Promise<boolean>)[] = [
    async () => {
      dependabot = await checkDependabotAlerts(out, config, owner, repository, skip)
      return true
    },
    async () => await isScanningPassed(out, 'code scanning', async () => await fetchCodeScanningStatus(createScanAlertSource(await createAuthenticatedGitHubClient(out, config.host)), config.host, owner, repository), skip),
    async () => await isScanningPassed(out, 'secret scanning', async () => await fetchSecretScanningStatus(createScanAlertSource(await createAuthenticatedGitHubClient(out, config.host)), config.host, owner, repository), skip),
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
  return { isPassed, skipped, dependabot }
}

export const RELEASE_CHECK_OUTPUT = z.strictObject({
  version: z.string().optional().describe('Version to release (omitted when release_type is nx, where only the alerts are checked)'),
  tag: z.string().optional().describe('Tag to create (omitted when release_type is nx)'),
  releaseNotes: z.string().optional().describe('Release notes from the CHANGELOG (omitted when release_type is nx)'),
  commitCount: z.int().optional().describe('Number of commits from the release branch to the develop branch (omitted when release_type is nx)'),
  skipped: z.array(z.string()).describe('Checks skipped because the feature is disabled, as in the skipped lines (e.g. "Dependabot alerts (feature disabled)")'),
  dependabotAlerts: z.strictObject({
    enabled: z.boolean().describe('Whether Dependabot alerts are enabled'),
    openCount: z.int().describe('Number of open alerts (0 when disabled)'),
    maxSeverity: z.string().optional().describe('Highest severity of the open alerts (omitted when there is none)'),
    alertsUrl: z.string().describe('URL of the alert list'),
  }).optional().describe('Dependabot alert status (omitted when it could not be read; the release is not blocked)'),
})

export const RELEASE_CHECK_INPUT = z.object({
  version: z.string().optional().describe('Release version (detected from the CHANGELOG when omitted)'),
  package: z.string().optional().describe('Package name in a monorepo (required for repositories with packages configured)'),
  project: PROJECT_INPUT,
})

/**
runReleaseCheck の入力。repo は全ツール共通の引数（owner/repo）
*/
export type ReleaseCheckInput = z.output<typeof RELEASE_CHECK_INPUT> & { readonly repo?: string | undefined }

/**
リリース前の確認。nx のリポは alert だけを確かめ、それ以外は CHANGELOG・タグ・差分も確かめる。
通れば 0。止まるときは error の行を出して CommandExit を投げる
*/
export async function runReleaseCheck(input: Readonly<ReleaseCheckInput>, io: CommandIo): Promise<0> {
  const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
  const out = createOutput<z.input<typeof RELEASE_CHECK_OUTPUT>>(false, io)
  const cwd = process.cwd()
  const context = loadReleaseContext(out, adopted, input.repo, input.package, input.project, CHECK_PATH, { version: input.version, nxAlertsOnly: true })
  const { config, owner, repository } = context
  if (input.version !== undefined) requireSemver(out, input.version)

  const alerts = await checkAlerts(out, config, owner, repository)
  const { dependabot } = alerts
  out.result({
    skipped: [...alerts.skipped],
    ...dependabot !== undefined && { dependabotAlerts: { enabled: dependabot.enabled, openCount: dependabot.openCount, ...dependabot.maxSeverity !== undefined && { maxSeverity: dependabot.maxSeverity }, alertsUrl: dependabot.alertsUrl } },
  })
  if (!alerts.isPassed) throw new CommandExit(1, 'preflight-failed')
  if (context.repositoryConfig !== undefined && effectiveReleaseType(context.repositoryConfig) === 'nx') return 0

  const developBranch = requireBranchSetting(out, getDevelopBranch(config, owner, repository), 'develop', owner, repository)
  const releaseBranch = requireBranchSetting(out, getReleaseBranch(config, owner, repository), 'release', owner, repository)

  const remote = primaryRemoteName(cwd) ?? 'origin'
  try {
    const client = await createAuthenticatedGitHubClient(out, config.host)
    const result = await runPreflight({
      changelogPath: context.changelogPath,
      changelogContent: readChangelogIfExists(context.changelogPath),
      developBranch,
      releaseBranch,
      version: input.version,
      tagPrefix: context.tagPrefix,
      remote,
    }, gitRunnerFor(cwd), async (name, tagName) => await remoteTagExists(cwd, name, tagName, out.signal), async (base, head) => await client.countCommitsAhead(owner, repository, base, head))
    out.count(`commits to release (${remote}/${result.developBranch} -> ${remote}/${result.releaseBranch})`, result.diffCount)
    out.result({ version: result.version, tag: result.tagName, releaseNotes: result.releaseNotes, commitCount: result.diffCount })
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
}
