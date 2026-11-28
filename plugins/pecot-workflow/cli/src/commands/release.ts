// release_check。github-ops の release-create に渡す前の引数が、CHANGELOG・タグ・alert の決まりに合うかを返す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
import path from 'node:path'

import { z } from 'zod'

import { changelogFileName, changelogNotFoundMessage, extractVersionReleaseNotes, InvalidVersionError, validateSemver, VersionNotFoundError } from '@pecot/workflow-core/domain/changelog.js'
import { effectiveReleaseType, findPackage, findRepository, getReleaseBranch } from '@pecot/workflow-core/domain/config.js'
import type { Repository } from '@pecot/workflow-core/domain/config.js'
import { dependabotStatusOf } from '@pecot/workflow-core/domain/dependabot.js'
import type { DependabotAlertStatus } from '@pecot/workflow-core/domain/dependabot.js'
import { pythonStrip } from '@pecot/workflow-core/domain/python-format.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import { scanStatusOf } from '@pecot/workflow-core/domain/security-alerts.js'
import type { ScanKind } from '@pecot/workflow-core/domain/security-alerts-source.js'
import { readChangelogIfExists, resolveChangelogPath } from '@pecot/workflow-core/infra/changelog-file.js'
import { gitToplevel, primaryRemoteName, remoteBranchHead, remoteTagExists } from '@pecot/workflow-core/infra/git.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { RELEASE_CREATE_PARAMS } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { requireBranchSetting, requireReleaseTargetRepository } from '@pecot/workflow-core/commands-shared/release-target.js'
import { requireRepositoryMatch } from '@pecot/workflow-core/commands-shared/repository-match.js'
import { commitsBetween, hasCommit, hasLocalTag, previousReleaseTag } from '../infra/release-git.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { unreadProblem } from './check-reads.js'
import { parseOfficial } from './official-reads.js'
import { ALERT_PAGE, ALERT_READ, alertPageOf, RELEASE, RELEASE_READ } from './official-reads-release.js'
import type { AlertRead } from './official-reads-release.js'

const CHECK_PATH = ['release', 'check']

const RELEASE_CHECK_INPUT = z.object({
  params: RELEASE_CREATE_PARAMS.optional().describe('The params of the release-create operation of github-ops: tag (v<version>, or <package>-v<version> in a monorepo), sha (the head of the release branch), body (the CHANGELOG section of the version) and name. Omit it when release_type is nx'),
  project: PROJECT_INPUT,
  reads: z.object({
    dependabot_alerts: ALERT_READ.optional().describe('list_dependabot_alerts with state open'),
    code_scanning_alerts: ALERT_READ.optional().describe('list_code_scanning_alerts with state open'),
    secret_scanning_alerts: ALERT_READ.optional().describe('list_secret_scanning_alerts with state open'),
    release: RELEASE_READ.optional().describe('get_release_by_tag with the tag of params (not needed when release_type is nx)'),
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type ReleaseCheckInput = z.output<typeof RELEASE_CHECK_INPUT>
type Reads = ReleaseCheckInput['reads']

const RELEASE_CHECK_OUTPUT = z.strictObject({
  ...CHECK_RESULT_SHAPE,
  skipped: z.array(z.string()).describe('Checks skipped because the feature is disabled (e.g. "Dependabot alerts (feature disabled)")'),
  dependabotAlerts: z.strictObject({
    enabled: z.boolean().describe('Whether Dependabot alerts are enabled'),
    openCount: z.int().describe('Number of open alerts (0 when disabled)'),
    maxSeverity: z.string().optional().describe('Highest severity of the open alerts (omitted when there is none)'),
    alertsUrl: z.string().describe('URL of the alert list'),
  }).optional().describe('Dependabot alert status; open alerts only warn and do not block the release (omitted when it could not be read)'),
  version: z.string().optional().describe('Version of the tag in params (omitted when the tag cannot be read, or release_type is nx)'),
  releaseNotes: z.string().optional().describe('The CHANGELOG section of the version, the body the release must have (omitted when it cannot be read)'),
  commitCount: z.int().optional().describe('Number of commits from the previous release tag to sha (omitted when there is no previous tag)'),
})

// --- alert ---

interface AlertKind {
  readonly key: 'dependabot_alerts' | 'code_scanning_alerts' | 'secret_scanning_alerts'
  readonly tool: string
  readonly label: string
  // 公式のツールが返す誤りのうち、機能が無効を示すもの。ほかの誤りは読めなかったとみなす
  readonly isDisabled: (error: string) => boolean
  // 誤りでも alert が 0 件と言えるもの（解析がまだ無い code scanning）
  readonly isEmpty: (error: string) => boolean
}

const isNever = (): boolean => false

const DEPENDABOT: AlertKind = { key: 'dependabot_alerts', tool: 'list_dependabot_alerts', label: 'Dependabot alerts', isDisabled: error => error.toLowerCase().includes('disabled'), isEmpty: isNever }

const SCANS: readonly (AlertKind & { readonly kind: ScanKind })[] = [
  {
    key: 'code_scanning_alerts',
    kind: 'code-scanning',
    tool: 'list_code_scanning_alerts',
    label: 'code scanning',
    isDisabled: error => error.toLowerCase().includes('advanced security') || error.toLowerCase().includes('not enabled'),
    isEmpty: error => error.toLowerCase().includes('no analysis found'),
  },
  { key: 'secret_scanning_alerts', kind: 'secret-scanning', tool: 'list_secret_scanning_alerts', label: 'secret scanning', isDisabled: error => error.toLowerCase().includes('disabled'), isEmpty: isNever },
]

function firstLine(text: string): string {
  return (text.trim().split(/\r\n|[\n\r]/u, 1)[0] ?? '').trim()
}

type AlertList = { readonly alerts: readonly JsonValue[] | undefined } | { readonly problem: CheckProblem }

// 読んだ一覧を alert の配列にする。機能が無効なら alerts は undefined
function alertsOf(output: Readonly<Output>, kind: AlertKind, read: AlertRead | undefined): AlertList {
  const field = `reads.${kind.key}`
  if (read?.error !== undefined) {
    if (kind.isDisabled(read.error)) return { alerts: undefined }
    return kind.isEmpty(read.error) ? { alerts: [] } : { problem: { field, code: 'alerts-unread', message: `${kind.tool} failed: ${firstLine(read.error)}; read it again once it can be read (a token with access to the alerts)` } }
  }
  if (read?.pages === undefined) return { problem: { field, code: 'alerts-unread', message: `read the open alerts with ${kind.tool} (state open, every page) and pass the results as ${field}.pages, or its error text as ${field}.error` } }
  const pages = read.pages.map((page, index) => alertPageOf(parseOfficial(output, kind.tool, ALERT_PAGE, page, `${field}.pages[${String(index)}]`)))
  return pages.at(-1)?.hasNextPage === true
    ? { problem: { field, code: 'alerts-unread', message: `the last page of ${kind.tool} has a next page; read it with after and add it to ${field}.pages` } }
    : { alerts: pages.flatMap(page => page.alerts) }
}

interface AlertChecks {
  readonly problems: readonly CheckProblem[]
  readonly skipped: readonly string[]
  readonly dependabot: DependabotAlertStatus | undefined
}

function alertLabel(number: number, packageName: string | undefined, severity: string | undefined): string {
  const detail = [packageName, severity].filter(value => value !== undefined && value !== '').join(', ')
  return detail === '' ? `#${String(number)}` : `#${String(number)} (${detail})`
}

// open の Dependabot alert は警告だけで、リリースを止めない。一覧の誤りも警告にする
function dependabotCheck(output: Readonly<Output>, host: string, owner: string, repository: string, read: AlertRead | undefined, skip: (target: string) => void): { readonly problem?: CheckProblem, readonly status?: DependabotAlertStatus } {
  if (read?.error !== undefined && !DEPENDABOT.isDisabled(read.error)) {
    output.warning(`could not check Dependabot alerts. The release is not blocked.\nreason: ${firstLine(read.error).replace(/\.+$/u, '')}`)
    return {}
  }
  const listed = alertsOf(output, DEPENDABOT, read)
  if ('problem' in listed) return { problem: listed.problem }
  const status = dependabotStatusOf(listed.alerts, host, owner, repository)
  if (!status.enabled) skip('Dependabot alerts (feature disabled)')
  else if (status.openCount > 0) {
    const severity = status.maxSeverity === undefined ? '' : ` (highest severity: ${status.maxSeverity})`
    const listing = status.openAlerts.map(alert => `\n${alertLabel(alert.number, alert.package, alert.severity)}`).join('')
    output.warning(`${String(status.openCount)} open Dependabot ${status.openCount === 1 ? 'alert' : 'alerts'}${severity}. The release is not blocked.${listing}\n→ ${status.alertsUrl}`)
  }
  return { status }
}

function alertChecks(output: Readonly<Output>, host: string, owner: string, repository: string, reads: Reads): AlertChecks {
  const problems: CheckProblem[] = []
  const skipped: string[] = []
  const skip = (target: string): void => {
    output.done({ verb: 'skip', target, aside: true })
    skipped.push(target)
  }
  const dependabot = dependabotCheck(output, host, owner, repository, reads?.dependabot_alerts, skip)
  if (dependabot.problem !== undefined) problems.push(dependabot.problem)
  for (const scan of SCANS) {
    const listed = alertsOf(output, scan, reads?.[scan.key])
    if ('problem' in listed) {
      problems.push(listed.problem)
      continue
    }
    const status = scanStatusOf(scan.kind, listed.alerts, host, owner, repository)
    if (!status.enabled) skip(`${scan.label} (feature disabled)`)
    else if (status.openCount > 0) {
      problems.push({
        field: `reads.${scan.key}`,
        code: 'blocking-alert',
        message: `${scan.label} has ${String(status.openCount)} open ${status.openCount === 1 ? 'alert' : 'alerts'} (${status.openNumbers.map(number => `#${String(number)}`).join(', ')}) → ${status.alertsUrl}; close them (fixed, or dismissed with a reason) and check again`,
      })
    }
  }
  return { problems, skipped, dependabot: dependabot.status }
}

// --- タグ・CHANGELOG・commit ---

interface TagParts {
  readonly prefix: string | undefined
  readonly version: string
}

function semverParts(prefix: string | undefined, version: string): TagParts | undefined {
  try {
    validateSemver(version)
  }
  catch (error: unknown) {
    if (error instanceof InvalidVersionError) return undefined
    throw error
  }
  return { prefix, version }
}

// <prefix>-v<version> は最後の -v<数字> で分ける。無ければ v<version>
function tagPartsOf(tag: string): TagParts | undefined {
  const prefixed = /^(?<prefix>.+)-v(?<version>\d.*)$/u.exec(tag)?.groups
  if (prefixed?.['prefix'] !== undefined && prefixed['version'] !== undefined) return semverParts(prefixed['prefix'], prefixed['version'])
  return /^v\d/u.test(tag) ? semverParts(undefined, tag.slice(1)) : undefined
}

// 期待するタグの形。monorepo は登録したパッケージの名前を接頭辞にする
function tagProblem(tag: string, parts: TagParts | undefined, repositoryConfig: Repository | undefined): CheckProblem | undefined {
  const packages = repositoryConfig?.packages ?? []
  const version = parts?.version ?? '<version>'
  if (packages.length > 0) {
    const isRegistered = repositoryConfig !== undefined && parts?.prefix !== undefined && findPackage(repositoryConfig, parts.prefix) !== undefined
    return isRegistered ? undefined : { field: 'params.tag', code: 'tag-name', message: `this repository is a monorepo; the tag must be <package>-v<version> with a registered package (got ${tag})`, candidates: packages.map(item => `${item.name}-v${version}`) }
  }
  return parts !== undefined && parts.prefix === undefined ? undefined : { field: 'params.tag', code: 'tag-name', message: `the tag must be v<version> with a semantic version (got ${tag})`, candidates: [`v${version}`] }
}

function changelogPathOf(gitRoot: string, repositoryConfig: Repository | undefined, prefix: string | undefined): string {
  const found = prefix === undefined || repositoryConfig === undefined ? undefined : findPackage(repositoryConfig, prefix)
  if (found === undefined) return resolveChangelogPath(gitRoot, repositoryConfig?.changelog_file)
  return path.isAbsolute(found.changelog) ? found.changelog : path.join(gitRoot, found.changelog)
}

type Notes = { readonly notes: string } | { readonly problem: CheckProblem }

function releaseNotesOf(changelogPath: string, version: string): Notes {
  const content = readChangelogIfExists(changelogPath)
  if (content === undefined) return { problem: { field: 'params.body', code: 'changelog-missing', message: changelogNotFoundMessage(changelogPath) } }
  try {
    return { notes: extractVersionReleaseNotes(content, version, changelogFileName(changelogPath)) }
  }
  catch (error: unknown) {
    if (!(error instanceof VersionNotFoundError)) throw error
    return { problem: { field: 'params.body', code: 'changelog-missing', message: `${error.message}; merge the CHANGELOG section of ${version} before the release` } }
  }
}

function releaseReadProblems(output: Readonly<Output>, tag: string, read: Readonly<z.output<typeof RELEASE_READ>> | undefined): readonly CheckProblem[] {
  if (read?.error !== undefined) {
    return /\b404\b/u.test(read.error) ? [] : [unreadProblem('reads.release', `get_release_by_tag failed: ${firstLine(read.error)}; read it again`)]
  }
  if (read?.result === undefined) return [unreadProblem('reads.release', `read the release of ${tag} with get_release_by_tag and pass its result as reads.release.result, or its error text (404 when there is none) as reads.release.error`)]
  const release = parseOfficial(output, 'get_release_by_tag', RELEASE, read.result, 'reads.release.result')
  return [{ field: 'params.tag', code: 'tag-exists', message: `the release of ${tag} already exists${release.html_url === undefined ? '' : ` (${release.html_url})`}; release a new version` }]
}

interface ReleaseFacts {
  readonly problems: readonly CheckProblem[]
  readonly version?: string
  readonly releaseNotes?: string
  readonly commitCount?: number
}

interface ReleaseTarget {
  readonly cwd: string
  readonly gitRoot: string
  readonly owner: string
  readonly repository: string
  readonly repositoryConfig: Repository | undefined
  readonly releaseBranch: string
}

async function tagProblems(output: Readonly<Output>, target: Readonly<ReleaseTarget>, remote: string, tag: string): Promise<readonly CheckProblem[]> {
  if (hasLocalTag(target.cwd, tag)) return [{ field: 'params.tag', code: 'tag-exists', message: `tag ${tag} already exists locally; release a new version` }]
  const remoteTag = await remoteTagExists(target.cwd, remote, tag, output.signal)
  if ('failure' in remoteTag) return stopWith(output, `could not read the tags of remote ${remote}: ${firstLine(remoteTag.failure)}`, 'git-unresolved')
  return remoteTag.isFound ? [{ field: 'params.tag', code: 'tag-exists', message: `tag ${tag} already exists on ${remote}; release a new version` }] : []
}

async function shaProblems(output: Readonly<Output>, target: Readonly<ReleaseTarget>, remote: string, sha: string): Promise<readonly CheckProblem[]> {
  const head = await remoteBranchHead(target.cwd, remote, target.releaseBranch, output.signal)
  if (!head.isReachable) return stopWith(output, `could not read branch ${target.releaseBranch} of remote ${remote}`, 'git-unresolved')
  if (head.sha === undefined) return [{ field: 'params.sha', code: 'sha-mismatch', message: `release branch ${target.releaseBranch} is not on ${remote}` }]
  if (head.sha !== sha) return [{ field: 'params.sha', code: 'sha-mismatch', message: `sha must be the head of release branch ${target.releaseBranch} on ${remote}`, candidates: [head.sha] }]
  return []
}

async function releaseChecks(output: Readonly<Output>, target: Readonly<ReleaseTarget>, parameters: Readonly<z.output<typeof RELEASE_CREATE_PARAMS>>, reads: Reads): Promise<ReleaseFacts> {
  const parts = tagPartsOf(parameters.tag)
  const tagName = tagProblem(parameters.tag, parts, target.repositoryConfig)
  if (tagName !== undefined || parts === undefined) return { problems: tagName === undefined ? [] : [tagName] }
  const { prefix, version } = parts
  const problems: CheckProblem[] = []

  const notes = releaseNotesOf(changelogPathOf(target.gitRoot, target.repositoryConfig, prefix), version)
  if ('problem' in notes) problems.push(notes.problem)
  else if (pythonStrip(parameters.body) !== pythonStrip(notes.notes)) {
    problems.push({ field: 'params.body', code: 'body-mismatch', message: `body must be the CHANGELOG section of ${version}`, candidates: [notes.notes] })
  }
  const name = prefix === undefined ? parameters.tag : `${prefix} v${version}`
  if ((parameters.name ?? parameters.tag) !== name) problems.push({ field: 'params.name', code: 'release-name', message: `the release name must be ${name}`, candidates: [name] })

  const remote = primaryRemoteName(target.cwd) ?? 'origin'
  problems.push(...await tagProblems(output, target, remote, parameters.tag), ...releaseReadProblems(output, parameters.tag, reads?.release), ...await shaProblems(output, target, remote, parameters.sha))

  let commitCount: number | undefined
  if (hasCommit(target.cwd, parameters.sha)) {
    const previous = previousReleaseTag(target.cwd, parameters.sha, prefix)
    commitCount = previous === undefined ? undefined : commitsBetween(target.cwd, previous, parameters.sha)
    if (commitCount === 0) problems.push({ field: 'params.sha', code: 'no-commits', message: `there are no commits from ${String(previous)} to sha; there is nothing to release` })
  }
  else {
    problems.push({ field: 'params.sha', code: 'not-found', message: `commit ${parameters.sha} is not in the local repository; fetch ${remote} and check again` })
  }
  return { problems, version, ...'notes' in notes && { releaseNotes: notes.notes }, ...commitCount !== undefined && { commitCount } }
}

const releaseCheckCommand = defineTool({
  name: 'release_check',
  title: 'Check release',
  description: 'Check the params for the release-create operation of github-ops before the release: no open code scanning or secret scanning alert (open Dependabot alerts only warn), the tag is new on the local repository, the remote and GitHub, the body is the CHANGELOG section of the version, and sha is the head of the release branch with commits since the previous release tag. For an nx repository only the alerts are checked. Reads the local git and the git remote, not the GitHub API; pass the results of the official reads in reads.',
  input: RELEASE_CHECK_INPUT,
  output: RELEASE_CHECK_OUTPUT,
  run: async (input, io) => {
    const adopted = requireRepositoryMatch('warn', input.repo, io, process.cwd())
    const output = createOutput<z.input<typeof RELEASE_CHECK_OUTPUT>>(false, io)
    const cwd = process.cwd()
    const gitRoot = gitToplevel({ cwd }) ?? stopWith(output, 'could not find the root directory of the git repository', 'git-unresolved')
    const location = requireReleaseTargetRepository(adopted, input.repo, output)
    const { owner, repository } = location
    const { config } = requireConfigFor(output, location, input.project, CHECK_PATH)
    const repositoryConfig = findRepository(config, owner, repository)
    const isNx = repositoryConfig !== undefined && effectiveReleaseType(repositoryConfig) === 'nx'

    const alerts = alertChecks(output, config.host, owner, repository, input.reads)
    const problems: CheckProblem[] = [...alerts.problems]
    let facts: ReleaseFacts = { problems: [] }
    if (isNx) {
      if (input.params !== undefined) problems.push({ field: 'params', code: 'unexpected', message: 'release_type is nx: Nx Release creates the tag and the release; call release_check without params' })
    }
    else if (input.params === undefined) {
      problems.push({ field: 'params', code: 'required', message: 'pass the params of the release-create operation of github-ops (tag, sha, body, name)' })
    }
    else {
      const releaseBranch = requireBranchSetting(output, getReleaseBranch(config, owner, repository), 'release', owner, repository)
      facts = await releaseChecks(output, { cwd, gitRoot, owner, repository, repositoryConfig, releaseBranch }, input.params, input.reads)
      problems.push(...facts.problems)
    }

    const { dependabot } = alerts
    output.result({
      problems,
      skipped: [...alerts.skipped],
      ...dependabot !== undefined && { dependabotAlerts: { enabled: dependabot.enabled, openCount: dependabot.openCount, ...dependabot.maxSeverity !== undefined && { maxSeverity: dependabot.maxSeverity }, alertsUrl: dependabot.alertsUrl } },
      ...facts.version !== undefined && { version: facts.version },
      ...facts.releaseNotes !== undefined && { releaseNotes: facts.releaseNotes },
      ...facts.commitCount !== undefined && { commitCount: facts.commitCount },
    })
    output.data(problems.length === 0 ? 'ok' : problems.map(problem => `${problem.field}: ${problem.message}`).join('\n'))
    return 0
  },
})

/**
release のグループのツール
*/
export const RELEASE_TOOLS: readonly ToolDefinition[] = [releaseCheckCommand]
