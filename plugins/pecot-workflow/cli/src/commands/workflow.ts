// workflow install・workflow doctor。導入先のリポに雛形を置き、版と要る設定を確かめる。
import { z } from 'zod'

import { evaluateRequirements, findWorkflowTemplate, isOutdated, npxWorkflowMcpLines, pecotActionReferences, pinPecotActions, readTemplateVersion, userLines, hasPecotActionStep, WORKFLOW_TEMPLATES } from '@pecot/workflow-core/domain/workflow-template.js'
import type { SettingList, SettingNames, WorkflowTemplate } from '@pecot/workflow-core/domain/workflow-template.js'
import { gitToplevel, primaryRemoteRepository } from '@pecot/workflow-core/infra/git.js'
import { TransportFailure } from '@pecot/workflow-core/infra/github/client.js'
import { GitHubAPIError, GitHubNotFoundError } from '@pecot/workflow-core/infra/github/errors.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import type { ActionsScope } from '@pecot/workflow-core/infra/github/repos.js'
import { readBundledWorkflow, readInstalledWorkflow, writeWorkflow } from '../infra/workflow-file.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, inputNameHint } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { directorySchema } from './directory-option.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import { apiFailureMessage, createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const NAME_INPUT = z.string().describe(`Name of the workflow template (${WORKFLOW_TEMPLATES.map(template => template.name).join(', ')})`)
const DIRECTORY_INPUT = directorySchema.optional().describe('Root of the target Git repository (absolute or relative path; default: the current directory)')

function requireTemplate(out: Readonly<Output>, name: string): WorkflowTemplate {
  return findWorkflowTemplate(name) ?? stopWith(out, `unknown workflow template: ${name}\navailable: ${WORKFLOW_TEMPLATES.map(item => item.name).join(', ')}`, 'invalid-input', USAGE_EXIT_CODE)
}

// 置き先はリポのルートから決めるので、サブディレクトリで打ってもルートに置く
function repositoryRoot(out: Readonly<Output>, directory: string | undefined): string {
  const start = directory ?? process.cwd()
  return gitToplevel({ cwd: start }) ?? stopWith(out, `${start} is not in a Git repository`, 'git-unresolved')
}

function versionOf(text: string | undefined): number | undefined {
  return text === undefined ? undefined : readTemplateVersion(text)?.version
}

// pecot の action を置くリポ。雛形の uses の `pecotcraft/pecot/actions/<処理>` と同じ
const ACTIONS_OWNER = 'pecotcraft'
const ACTIONS_REPOSITORY = 'pecot'

/**
雛形がタグで指す pecot の action を、タグの commit の SHA に直す。タグが無ければ止まる
*/
async function pinnedTemplate(out: Readonly<Output>, bundled: string): Promise<string> {
  const tags = [...new Set(pecotActionReferences(bundled).map(reference => reference.tag))]
  if (tags.length === 0) return bundled
  const client = createGitHubClient(out, undefined)
  const shas = new Map<string, string>()
  for (const tag of tags) {
    try {
      shas.set(tag, await client.getTagCommitSha(ACTIONS_OWNER, ACTIONS_REPOSITORY, tag))
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) return stopWith(out, `tag ${tag} is not found in ${ACTIONS_OWNER}/${ACTIONS_REPOSITORY}`, 'github-not-found')
      if (!(error instanceof GitHubAPIError || error instanceof TransportFailure)) throw error
      return stopWith(out, `could not read tag ${tag} of ${ACTIONS_OWNER}/${ACTIONS_REPOSITORY}: ${apiFailureMessage(error)}`, kindOfFailure(error) === 'other' ? 'github-api' : kindOfFailure(error))
    }
  }
  return pinPecotActions(bundled, tag => shas.get(tag) ?? tag)
}

const INSTALL_OUTPUT = z.strictObject({
  path: z.string().describe('Path of the workflow file from the repository root'),
  version: z.number().describe('Version of the bundled template'),
  installedVersion: z.number().optional().describe('Version of the file already in the repository; omitted when there is no file or no version marker'),
  written: z.boolean().describe('Whether the file was written (false on check)'),
  upToDate: z.boolean().optional().describe('With check: whether the file in the repository has the version of the bundled template'),
  removedLines: z.array(z.string()).optional().describe('With force: lines you added between the begin and end markers, which the bundled template replaces'),
})

const INSTALL_PATH = ['workflow', 'install']

const workflowInstallCommand = defineTool({
  name: 'workflow_install',
  title: 'Install workflow template',
  description: 'Write a GitHub Actions workflow template of pecot into the repository',
  input: z.strictObject({
    name: NAME_INPUT,
    check: z.boolean().default(false).describe('Write nothing; check that the file in the repository has the version of the bundled template'),
    force: z.boolean().default(false).describe('Overwrite the file when it already exists'),
    directory: DIRECTORY_INPUT,
  }),
  output: INSTALL_OUTPUT,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof INSTALL_OUTPUT>>(false, io)
    if (input.check && input.force) {
      const message = hinted`${inputNameHint(INSTALL_PATH, 'check')} cannot be used with ${inputNameHint(INSTALL_PATH, 'force')}`
      return stopWith(out, message, 'invalid-input', USAGE_EXIT_CODE)
    }
    const template = requireTemplate(out, input.name)
    const root = repositoryRoot(out, input.directory)
    const bundled = readBundledWorkflow(template)
    const version = versionOf(bundled) ?? 0
    const installed = readInstalledWorkflow(root, template)
    const installedVersion = versionOf(installed)
    const base = { path: template.destination, version, ...installedVersion !== undefined && { installedVersion } }

    if (input.check) {
      const isUpToDate = installed !== undefined && !isOutdated(installed, bundled)
      out.result({ ...base, written: false, upToDate: isUpToDate })
      if (isUpToDate) {
        out.done({ verb: 'unchanged', target: `${template.destination} (workflow template ${template.name} ${String(version)})` })
        return 0
      }
      const state = installed === undefined ? `${template.destination} is missing` : `workflow template ${template.name} is outdated (installed ${installedVersion === undefined ? 'unknown' : String(installedVersion)}, bundled ${String(version)})`
      const run = commandHint(INSTALL_PATH, { name: template.name, ...installed !== undefined && { force: true } })
      return stopWith(out, hinted`${state}\nupdate it with: ${run}`, 'not-ready')
    }

    if (installed !== undefined && !input.force) {
      return stopWith(out, hinted`${template.destination} already exists\noverwrite it with: ${commandHint(INSTALL_PATH, { name: template.name, force: true })}`, 'already-exists', USAGE_EXIT_CODE)
    }
    const removed = installed === undefined ? [] : userLines(installed, bundled)
    if (removed.length > 0) out.warning(`these lines between the markers will be removed:\n${removed.join('\n')}`)
    const operation: Operation = { verb: installed === undefined ? 'create' : 'update', target: template.destination }
    const result = { ...base, ...installed !== undefined && { removedLines: [...removed] } }
    const content = await pinnedTemplate(out, bundled)
    writeWorkflow(root, template, content)
    out.done(operation)
    out.result({ ...result, written: true })
    return 0
  },
})

const DOCTOR_ITEM = z.strictObject({
  name: z.string().describe('What was checked: the workflow file, the template version, a secret or variable, or the Claude GitHub App (only for a template that uses it)'),
  state: z.enum(['ok', 'missing', 'outdated', 'skipped']).describe('ok, missing, outdated, or skipped (not readable with the token; not counted as missing)'),
})

const DOCTOR_OUTPUT = z.strictObject({
  repository: z.string().describe('Repository of the git remote (owner/repo)'),
  items: z.array(DOCTOR_ITEM).describe('Checked items in the order of the output lines'),
  ready: z.boolean().describe('Whether nothing is missing or outdated'),
})

// Claude の App が入っているかは、リポのトークンでは読めない。App を使う雛形だけ入れる
const CLAUDE_APP_ITEM: z.input<typeof DOCTOR_ITEM> = { name: 'Claude GitHub App', state: 'skipped' }

function stateOf(isOk: boolean): 'ok' | 'outdated' {
  return isOk ? 'ok' : 'outdated'
}

/**
置いたファイルの版の項目と、npx の `@pecot/workflow-mcp` から pecot の action に移ったかの項目。
後者は、同梱の雛形が action を使うか、置いたファイルが npx で呼ぶときだけ出す
*/
function templateItems(template: Readonly<WorkflowTemplate>, installed: string, bundled: string): readonly z.input<typeof DOCTOR_ITEM>[] {
  const hasNpxCall = npxWorkflowMcpLines(installed).length > 0
  const isActionTemplate = hasPecotActionStep(bundled)
  return [
    { name: template.destination, state: 'ok' },
    { name: `workflow template ${template.name}`, state: stateOf(!isOutdated(installed, bundled)) },
    ...hasNpxCall || isActionTemplate
      ? [{ name: `${template.destination} calls the pecot actions, not npx @pecot/workflow-mcp`, state: stateOf(!hasNpxCall && (!isActionTemplate || hasPecotActionStep(installed))) }]
      : [],
  ]
}

// 読めた一覧の名前を合わせる。読めなかった一覧があれば complete を false にする
function mergeNames(lists: readonly (readonly string[] | undefined)[]): SettingList {
  return { names: new Set(lists.flatMap(list => list ?? [])), complete: !lists.includes(undefined) }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない
async function readSettingNames(client: GitHubClient, owner: string, repository: string): Promise<SettingNames> {
  const ownerType = await client.getRepositoryOwnerType(owner, repository)
  const scopes: readonly ActionsScope[] = ownerType === 'Organization' ? ['repository', 'organization'] : ['repository']
  const [secrets, variables] = await Promise.all([
    Promise.all(scopes.map(async scope => await client.listActionsSecretNames(owner, repository, scope))),
    Promise.all(scopes.map(async scope => await client.listActionsVariableNames(owner, repository, scope))),
  ])
  return { secrets: mergeNames(secrets), variables: mergeNames(variables) }
}

const workflowDoctorCommand = defineTool({
  name: 'workflow_doctor',
  title: 'Check workflow setup',
  description: 'Check that the repository has the workflow file and the settings it needs',
  input: z.strictObject({
    name: NAME_INPUT,
    directory: DIRECTORY_INPUT,
  }),
  output: DOCTOR_OUTPUT,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof DOCTOR_OUTPUT>>(false, io)
    const template = requireTemplate(out, input.name)
    const root = repositoryRoot(out, input.directory)
    const location = primaryRemoteRepository(root)
    if (location === undefined) return stopWith(out, 'cannot read the repository from the git remote\ncheck it with: git remote -v', 'git-unresolved')
    const { owner, repository } = location

    const installed = readInstalledWorkflow(root, template)
    const fileItems: readonly z.input<typeof DOCTOR_ITEM>[] = installed === undefined
      ? [{ name: template.destination, state: 'missing' }]
      : templateItems(template, installed, readBundledWorkflow(template))

    let names: SettingNames
    try {
      names = await readSettingNames(createGitHubClient(out, location.host), owner, repository)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError || error instanceof TransportFailure)) throw error
      return stopWith(out, `could not read the settings of ${owner}/${repository}: ${apiFailureMessage(error)}`, kindOfFailure(error) === 'other' ? 'github-api' : kindOfFailure(error))
    }
    const items = [...fileItems, ...evaluateRequirements(template.requirements, names), ...template.claudeApp ? [CLAUDE_APP_ITEM] : []]

    out.data(items.map(item => `${item.state}: ${item.name}`).join('\n'))
    const failing = items.filter(item => item.state === 'missing' || item.state === 'outdated')
    out.result({ repository: `${owner}/${repository}`, items, ready: failing.length === 0 })
    return failing.length > 0 ? stopWith(out, `${String(failing.length)} item(s) of workflow ${template.name} are missing or outdated`, 'repo-setting-missing') : 0
  },
})

export const WORKFLOW_TOOLS: readonly ToolDefinition[] = [workflowInstallCommand, workflowDoctorCommand]
