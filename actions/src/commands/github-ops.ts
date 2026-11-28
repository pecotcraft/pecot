// github-ops。公式の MCP に手の無い GitHub の操作を 1 つ行い、結果を PECOT_RESULT の 1 行で返す。
// 何を書くかは呼ぶ側（pecot-workflow の計算）が決める。この処理は渡された中身を書くか、読んだ値を返すだけにする。
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは雛形と RUNNER_TEMP の下だけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { z } from 'zod'

import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { readSettingNames } from '@pecot/workflow-core/commands-shared/actions-setting-names.js'
import { kindOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import type { FailureKind } from '@pecot/workflow-core/commands-shared/failure-kind.js'
import { createGitHubClient } from '@pecot/workflow-core/commands-shared/github-client.js'
import { linkIssueBranch } from '@pecot/workflow-core/commands-shared/link-branch.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { LINK_BRANCH_PARAMS, NO_PARAMS, PROJECT_FIELDS_PARAMS, PROJECT_LINK_PARAMS, PROJECT_VIEW_PARAMS, PR_ATTACH_PARAMS, RELEASE_CREATE_PARAMS, STACK_REGISTER_PARAMS } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import type { FieldChange, FieldOption } from '@pecot/workflow-core/commands-shared/github-ops-parameters.js'
import { fieldNodesOf } from '@pecot/workflow-core/commands-shared/project-sync.js'
import { planStackRegistration } from '@pecot/workflow-core/commands-shared/stack-registration.js'
import { describeApiError } from '@pecot/workflow-core/domain/api-error-detail.js'
import type { FieldOptionInput } from '@pecot/workflow-core/domain/field-options.js'
import type { SettingList } from '@pecot/workflow-core/domain/workflow-template.js'
import { hasPecotActionStep, npxWorkflowMcpLines, pecotActionReferences, readTemplateVersion, WORKFLOW_TEMPLATES } from '@pecot/workflow-core/domain/workflow-template.js'
import { TransportFailure } from '@pecot/workflow-core/infra/github/client.js'
import { GitHubAPIError, GitHubNotFoundError } from '@pecot/workflow-core/infra/github/errors.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import type { BranchHead, TreeEntry } from '@pecot/workflow-core/infra/github/repos.js'
import { asArray, requireNumber, requireString } from '@pecot/workflow-core/infra/github/payload.js'
import { jsonField } from '@pecot/workflow-core/domain/json.js'
import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import { runProcess } from '@pecot/workflow-core/infra/process-run.js'

export const GITHUB_OPS_INPUT = z.strictObject({
  operation: z.string(),
  request_id: z.string(),
  params: z.string(),
  attach_token: z.string().default(''),
})

/**
結果の行の先頭。スキルは job のログからこの行を探す
*/
export const RESULT_PREFIX = 'PECOT_RESULT'

/**
GitHub が断ったのではなく、渡された中身では書けないと action が決めたときの失敗
*/
class OperationRefused extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message)
  }
}

interface OperationContext {
  readonly client: GitHubClient
  readonly owner: string
  readonly repository: string
  readonly workspace: string
  /**
  pr-attach が gh にだけ渡す fine-grained PAT。無ければ空
  */
  readonly attachToken: string
}

interface Operation<Schema extends z.ZodType> {
  readonly params: Schema
  readonly run: (parameters: z.output<Schema>, context: OperationContext) => Promise<JsonValue>
}

function operation<Schema extends z.ZodType>(parameters: Schema, run: Operation<Schema>['run']): Operation<Schema> {
  return { params: parameters, run }
}

const DEFAULT_COLOR = 'GRAY'

// link-branch

async function linkBranch(parameters: Readonly<{ issue: number, branch: string, base?: string | undefined }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  const { issue, branch, base, sha } = await linkIssueBranch(client, { owner, repository, ...parameters })
  return { issue, branch, base, sha }
}

// stack-register

async function registerStack(parameters: Readonly<{ pr: number, parent_pr: number }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  const parentStack = await client.getStackOfPullRequest(owner, repository, parameters.parent_pr)
  const childStack = await client.getStackOfPullRequest(owner, repository, parameters.pr)
  const plan = planStackRegistration(parameters.parent_pr, parameters.pr, parentStack, childStack)
  switch (plan.kind) {
    case 'conflict': {
      throw new OperationRefused('order-conflict', plan.reason)
    }
    case 'already': {
      return { change: 'unchanged', number: plan.stack.number, pull_requests: [...plan.stack.pullRequests] }
    }
    case 'create': {
      const created = await client.createStack(owner, repository, plan.pullRequests)
      return { change: 'created', number: created.number, pull_requests: [...created.pullRequests] }
    }
    case 'add': {
      const added = await client.addToStack(owner, repository, plan.stackNumber, plan.pullRequests)
      return { change: 'added', number: added.number, pull_requests: [...added.pullRequests] }
    }
  }
}

// project-fields

interface BoardFields {
  readonly projectId: string
  readonly fields: readonly JsonObject[]
}

async function readBoardFields(client: GitHubClient, owner: string, project: number): Promise<BoardFields> {
  const info = await client.getProjectFields(owner, project)
  if (info === undefined) throw new GitHubNotFoundError(`project not found: ${owner} #${String(project)}`)
  const fields = fieldNodesOf(info).filter((field): field is JsonObject => typeof jsonField(field, 'name') === 'string')
  return { projectId: requireString(info['id'], 'projectV2.id'), fields }
}

function fieldNamed(fields: readonly JsonObject[], name: string): JsonObject {
  const found = fields.find(field => field['name'] === name)
  if (found === undefined) throw new GitHubNotFoundError(`field not found on the board: ${name}`)
  return found
}

/**
渡した選択肢に、名前の合う既存の選択肢の ID・色・説明を引き継ぐ。ID を外すと選択肢が作り直され、カードの値が消える
*/
export function mergeOptions(existing: readonly JsonValue[], given: readonly FieldOption[]): readonly FieldOptionInput[] {
  return given.map((option) => {
    const current = existing.find(item => jsonField(item, 'name') === option.name)
    const id = jsonField(current, 'id')
    const color = option.color ?? jsonField(current, 'color')
    const description = option.description ?? jsonField(current, 'description')
    return {
      ...typeof id === 'string' && { id },
      name: option.name,
      color: typeof color === 'string' ? color : DEFAULT_COLOR,
      description: typeof description === 'string' ? description : '',
    }
  })
}

async function applyFieldChange(client: GitHubClient, board: BoardFields, change: FieldChange): Promise<void> {
  switch (change.action) {
    case 'create': {
      if (board.fields.some(field => field['name'] === change.name)) throw new OperationRefused('already-exists', `field already exists on the board: ${change.name}`)
      await client.createProjectField(board.projectId, change.name, mergeOptions([], change.options))
      return
    }
    case 'rename': {
      await client.renameProjectField(requireString(fieldNamed(board.fields, change.name)['id'], 'field.id'), change.to)
      return
    }
    case 'delete': {
      await client.deleteProjectField(requireString(fieldNamed(board.fields, change.name)['id'], 'field.id'))
      return
    }
    case 'set-options': {
      const field = fieldNamed(board.fields, change.name)
      if (!Array.isArray(field['options'])) throw new OperationRefused('invalid-input', `field is not a single select field: ${change.name}`)
      await client.updateProjectFieldOptions(requireString(field['id'], 'field.id'), mergeOptions(asArray(field['options']), change.options))
    }
  }
}

function fieldSummary(field: JsonObject): JsonValue {
  const options = field['options']
  return {
    name: requireString(field['name'], 'field.name'),
    id: requireString(field['id'], 'field.id'),
    ...Array.isArray(options) && { options: asArray(options).map(option => ({ name: requireString(jsonField(option, 'name'), 'option.name'), id: requireString(jsonField(option, 'id'), 'option.id') })) },
  }
}

async function changeProjectFields(parameters: Readonly<{ project: number, changes: readonly FieldChange[] }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner } = context
  // 1 つ書くたびに読み直し、次の変更が前の変更の後の欄を名前で引けるようにする
  for (const change of parameters.changes) await applyFieldChange(client, await readBoardFields(client, owner, parameters.project), change)
  const after = await readBoardFields(client, owner, parameters.project)
  return { project: parameters.project, applied: parameters.changes.length, fields: after.fields.map(field => fieldSummary(field)) }
}

// project-view

async function createProjectView(parameters: Readonly<{ project: number, name: string, column: string, row: string }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner } = context
  const target = await client.getProjectViewTarget(owner, parameters.project)
  const existing = target.views.find(view => view.name === parameters.name)
  if (existing !== undefined) return { created: false, number: existing.number, url: `${target.url}/views/${String(existing.number)}` }
  const databaseId = (name: string): number => {
    const id = target.fieldDatabaseIds.get(name)
    if (id === undefined) throw new GitHubNotFoundError(`single select field not found on the board: ${name}`)
    return id
  }
  const view = await client.createProjectView(target, { name: parameters.name, layout: 'board', vertical_group_by: [databaseId(parameters.column)], group_by: [databaseId(parameters.row)] })
  const number = requireNumber(view['number'], 'view.number')
  const url = view['html_url']
  return { created: true, number, url: typeof url === 'string' ? url : `${target.url}/views/${String(number)}` }
}

// project-link

async function linkProject(parameters: Readonly<{ project: number, repo?: string | undefined }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  const [repositoryOwner = owner, repositoryName = repository] = parameters.repo?.split('/') ?? []
  const result = await client.linkRepositoryToProject(owner, parameters.project, repositoryOwner, repositoryName)
  // linkRepositoryToProject は断られても例外にしないので、ここで失敗にする
  if (result.status === 'failed') throw new OperationRefused('github-api', result.detail)
  return { project: parameters.project, repo: `${repositoryOwner}/${repositoryName}`, status: result.status }
}

// repo-settings

async function readRepositorySettings(_parameters: Readonly<Record<string, never>>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  const settings = await client.getRepositorySettings(owner, repository)
  // merge の設定は contents: write の無い token では返らない。値の無い成功にせず、token の不足として返す
  if (settings.deleteBranchOnMerge === undefined) throw new OperationRefused('github-auth', 'delete_branch_on_merge was not returned; the token needs contents: write')
  return {
    delete_branch_on_merge: settings.deleteBranchOnMerge,
    default_branch: settings.defaultBranch,
    ...settings.ownerType !== undefined && { owner_type: settings.ownerType },
  }
}

// workflow-doctor

function settingListOf(list: Readonly<SettingList>): JsonValue {
  return { names: [...list.names].toSorted((left, right) => left.localeCompare(right)), complete: list.complete }
}

function installedWorkflow(workspace: string, destination: string): JsonValue {
  const file = path.join(workspace, destination)
  if (!existsSync(file)) return { path: destination, present: false }
  const text = readFileSync(file, 'utf8')
  const version = readTemplateVersion(text)
  return {
    path: destination,
    present: true,
    ...version !== undefined && { template: version.name, version: version.version },
    has_pecot_action_step: hasPecotActionStep(text),
    pecot_actions: pecotActionReferences(text).map(reference => ({ action: reference.action, tag: reference.tag })),
    npx_lines: [...npxWorkflowMcpLines(text)],
  }
}

async function readWorkflowSetup(_parameters: Readonly<Record<string, never>>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository, workspace } = context
  const names = await readSettingNames(client, owner, repository)
  return {
    secrets: settingListOf(names.secrets),
    variables: settingListOf(names.variables),
    workflows: WORKFLOW_TEMPLATES.map(template => installedWorkflow(workspace, template.destination)),
  }
}

// release-create

async function createRelease(parameters: Readonly<{ tag: string, sha: string, body: string, name?: string | undefined, prerelease: boolean }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  const release = await client.createRelease(owner, repository, parameters.tag, parameters.name ?? parameters.tag, parameters.body, { targetCommitish: parameters.sha, prerelease: parameters.prerelease })
  const url = release['html_url']
  return { id: requireNumber(release['id'], 'release.id'), tag: requireString(release['tag_name'], 'release.tag_name'), ...typeof url === 'string' && { url } }
}

// pr-attach

const ATTACH_PREFIX = 'pecot-attach/'
const STALE_MILLISECONDS = 24 * 60 * 60 * 1000
// gh pr edit --attach が受ける拡張子と、1 回に受ける数の上限
const ATTACH_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.mov', '.webm'])
const ATTACH_LIMIT = 50
const ATTACH_NAME = /^[\w.-]+$/u
const SYMLINK_MODE = '120000'
const UNPROCESSABLE = 422

function attachEntryProblem(entry: Readonly<TreeEntry>): string | undefined {
  if (entry.type !== 'blob' || entry.mode === SYMLINK_MODE) return `${entry.path} is not a file`
  if (!ATTACH_NAME.test(entry.path)) return `${entry.path} has a name other than letters, digits, _, . and -`
  if (!ATTACH_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) return `${entry.path} is not one of ${[...ATTACH_EXTENSIONS].join(', ')}`
  return undefined
}

async function readAttachEntries(client: GitHubClient, owner: string, repository: string, head: Readonly<BranchHead>): Promise<readonly TreeEntry[]> {
  const entries = await client.getTreeEntries(owner, repository, head.sha)
  if (entries.length === 0) throw new OperationRefused('invalid-input', `${head.name} has no file`)
  if (entries.length > ATTACH_LIMIT) throw new OperationRefused('invalid-input', `${head.name} has ${String(entries.length)} entries; gh attaches at most ${String(ATTACH_LIMIT)}`)
  const problems = entries.map(entry => attachEntryProblem(entry)).filter(problem => problem !== undefined)
  if (problems.length > 0) throw new OperationRefused('invalid-input', `${head.name} has entries that cannot be attached: ${problems.join('; ')}`)
  return entries
}

// 起動に失敗して残った一時ブランチを消す。ほかの実行が先に消していた（422）ものは数えない
async function deleteStaleAttachBranches(client: GitHubClient, owner: string, repository: string, heads: readonly BranchHead[]): Promise<readonly string[]> {
  const deleted: string[] = []
  for (const head of heads) {
    if (Date.now() - Date.parse(await client.getCommitDate(owner, repository, head.sha)) <= STALE_MILLISECONDS) continue
    try {
      await client.deleteBranch(owner, repository, head.name)
      deleted.push(head.name)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError && error.statusCode === UNPROCESSABLE)) throw error
    }
  }
  return deleted
}

function runnerTemporary(): string {
  const directory = process.env['RUNNER_TEMP']?.trim() ?? ''
  if (directory === '') throw new OperationRefused('invalid-input', 'RUNNER_TEMP is not set; run this action in a GitHub Actions job')
  return directory
}

async function uploadAttachments(parameters: Readonly<{ pr: number, branch: string }>, context: OperationContext, head: Readonly<BranchHead>): Promise<readonly string[]> {
  const { client, owner, repository } = context
  if (context.attachToken === '') throw new OperationRefused('github-auth', 'attach-token is empty; set a fine-grained personal access token as the secret PECOT_ATTACH_TOKEN')
  const temporary = runnerTemporary()
  const entries = await readAttachEntries(client, owner, repository, head)
  const directory = mkdtempSync(path.join(temporary, 'pecot-attach-'))
  try {
    for (const entry of entries) writeFileSync(path.join(directory, entry.path), await client.getBlobBytes(owner, repository, entry.sha))
    const host = hostOf()
    // gh は本文の ./<名前> を cwd から解くので、画像のディレクトリで起こす。cwd は git のリポでないので、リポは GH_REPO で渡す
    const result = await runProcess('gh', ['pr', 'edit', String(parameters.pr), ...entries.flatMap(entry => ['--attach', `./${entry.path}`])], {
      cwd: directory,
      // interface-env: none
      env: { ...process.env, GH_TOKEN: context.attachToken, GH_HOST: host, GH_REPO: `${host}/${owner}/${repository}`, GH_PROMPT_DISABLED: '1' },
    })
    if (result.exitCode !== 0) throw new OperationRefused('github-api', `gh pr edit failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`)
    return entries.map(entry => entry.path)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function attachToPullRequest(parameters: Readonly<{ pr: number, branch: string }>, context: OperationContext): Promise<JsonValue> {
  const { client, owner, repository } = context
  let failure: { readonly error: unknown } | undefined
  let files: readonly string[] = []
  let stale: readonly string[] = []
  try {
    const heads = await client.listBranchesWithPrefix(owner, repository, ATTACH_PREFIX)
    stale = await deleteStaleAttachBranches(client, owner, repository, heads.filter(head => head.name !== parameters.branch))
    const head = heads.find(item => item.name === parameters.branch)
    if (head === undefined) throw new GitHubNotFoundError(`branch not found: ${parameters.branch}`)
    files = await uploadAttachments(parameters, context, head)
  }
  catch (error: unknown) {
    failure = { error }
  }
  // 成否にかかわらず渡されたブランチを消す。先の失敗があれば、そちらを返す
  try {
    await client.deleteBranch(owner, repository, parameters.branch)
  }
  catch (error: unknown) {
    failure ??= { error }
  }
  if (failure !== undefined) throw failure.error
  return { pr: parameters.pr, files: [...files], deleted_branches: [...stale, parameters.branch] }
}

/**
operation の一覧。鍵は雛形の choice と同じ順にする
*/
export const OPERATIONS = {
  'link-branch': operation(LINK_BRANCH_PARAMS, linkBranch),
  'stack-register': operation(STACK_REGISTER_PARAMS, registerStack),
  'project-fields': operation(PROJECT_FIELDS_PARAMS, changeProjectFields),
  'project-view': operation(PROJECT_VIEW_PARAMS, createProjectView),
  'project-link': operation(PROJECT_LINK_PARAMS, linkProject),
  'repo-settings': operation(NO_PARAMS, readRepositorySettings),
  'workflow-doctor': operation(NO_PARAMS, readWorkflowSetup),
  'release-create': operation(RELEASE_CREATE_PARAMS, createRelease),
  'pr-attach': operation(PR_ATTACH_PARAMS, attachToPullRequest),
} satisfies Record<string, Operation<z.ZodType>>

type OperationName = keyof typeof OPERATIONS

function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(OPERATIONS, name)
}

interface Failure {
  readonly kind: FailureKind
  readonly message: string
}

function invalidInput(message: string): Failure {
  return { kind: 'invalid-input', message }
}

function failureOf(error: unknown): Failure {
  if (error instanceof OperationRefused) return { kind: error.kind, message: error.message }
  if (error instanceof TransportFailure) return { kind: 'github-api', message: error.message }
  if (error instanceof GitHubAPIError) return { kind: kindOfFailure(error), message: describeApiError(error) }
  return { kind: kindOfFailure(error), message: error instanceof Error ? error.message : String(error) }
}

function parseJson(text: string): { readonly ok: true, readonly value: unknown } | { readonly ok: false } {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  }
  catch {
    return { ok: false }
  }
}

function repositoryOf(): readonly [string, string] | undefined {
  const [owner, repository, ...rest] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/')
  return owner === undefined || owner === '' || repository === undefined || repository === '' || rest.length > 0 ? undefined : [owner, repository]
}

function hostOf(): string {
  return URL.parse(process.env['GITHUB_SERVER_URL'] ?? '')?.hostname ?? 'github.com'
}

type Outcome = { readonly ok: true, readonly result: JsonValue } | { readonly ok: false, readonly error: Failure }

async function perform(input: Readonly<z.output<typeof GITHUB_OPS_INPUT>>, io: CommandIo): Promise<Outcome> {
  if (!isOperationName(input.operation)) return { ok: false, error: invalidInput(`unknown operation: ${input.operation} (choose one of ${Object.keys(OPERATIONS).join(', ')})`) }
  const parsedJson = parseJson(input.params === '' ? '{}' : input.params)
  if (!parsedJson.ok) return { ok: false, error: invalidInput('params is not JSON') }
  const selected: Operation<z.ZodType> = OPERATIONS[input.operation]
  const parameters = selected.params.safeParse(parsedJson.value)
  if (!parameters.success) return { ok: false, error: invalidInput(`invalid params for ${input.operation}: ${z.prettifyError(parameters.error)}`) }
  const repository = repositoryOf()
  if (repository === undefined) return { ok: false, error: invalidInput('GITHUB_REPOSITORY is not owner/repo') }
  const client = createGitHubClient(createOutput(false, io), hostOf())
  const context: OperationContext = { client, owner: repository[0], repository: repository[1], workspace: process.env['GITHUB_WORKSPACE'] ?? process.cwd(), attachToken: input.attach_token }
  try {
    return { ok: true, result: await selected.run(parameters.data, context) }
  }
  catch (error: unknown) {
    return { ok: false, error: failureOf(error) }
  }
}

/**
operation を 1 つ行い、成否にかかわらず PECOT_RESULT の行を 1 つ出す。失敗なら 1 を返して step を失敗にする
*/
export async function runGithubOps(input: Readonly<z.output<typeof GITHUB_OPS_INPUT>>, io: CommandIo): Promise<number> {
  const outcome = await perform(input, io)
  const line = outcome.ok
    ? { operation: input.operation, request_id: input.request_id, ok: true, result: outcome.result }
    : { operation: input.operation, request_id: input.request_id, ok: false, error: outcome.error }
  io.stdout(`${RESULT_PREFIX} ${JSON.stringify(line)}\n`)
  if (outcome.ok) return 0
  io.stderr(`error: ${outcome.error.message}\n`)
  return 1
}
