/* eslint-disable security/detect-non-literal-fs-filename -- パスは検証済みの -D と、main worktree 配下の設定ファイル */
// worktree add / remove / init / link。4 個とも、本体の前に --repo と git の remote の食い違いを reject で止める。
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { aggregationRepositoryReference, ConfigError } from '@pecot/workflow-core/domain/config.js'
import { loadActiveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { gitToplevel } from '@pecot/workflow-core/infra/git.js'
import { hasErrorCode, OsError, toOsError } from '@pecot/workflow-core/infra/os-error.js'
import { resolveRealPath, WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME } from '@pecot/workflow-core/infra/paths.js'
import {
  createWorktree,
  detectProjectRoot,
  ensureDevcontainerEnvironment,
  findMainWorktree,
  findWorktreeConfigFile,
  getWorktreeDirectories,
  removeWorktree,
  WorktreeRuntimeError,
} from '../infra/worktree.js'
import type { CopyResult } from '../infra/worktree-copy.js'
import {
  createSymlinksSafe,
  DEFAULT_WORKTREEIGNORE_CONTENT,
  decideOverwrite,
  getDefaultConfig,
  loadConfig,
  planLink,
  saveConfig,
  WorktreeConfigError,
} from '../infra/worktree-links.js'
import type { SymlinkResult, WorktreeConfig } from '../infra/worktree-links.js'
import { abortUnconfirmed, createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, hintedTextOf, inputHint, placeholder, RUN_COLON } from '@pecot/workflow-core/commands-shared/command-hint.js'
import type { ToolDefinition, CommandIo, GlobalInput } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { directorySchema } from './directory-option.js'
import { requireRepositoryMatch } from '@pecot/workflow-core/commands-shared/repository-match.js'

// click の realpath と同じく、解決できない所は字面のまま残して投げない
function lenientRealPath(value: string): string {
  try {
    return resolveRealPath(value)
  }
  catch (error: unknown) {
    if (!hasErrorCode(error)) throw error
    return path.resolve(value)
  }
}

// WorktreeRuntimeError は最上位の網にかからないので、ここで error の行と終了コード 1 にする
function reportRuntimeError(out: Readonly<Output>, error: unknown): never {
  if (!(error instanceof WorktreeRuntimeError)) throw error
  if (error.log !== undefined) out.log(error.log)
  return stopWith(out, hintedTextOf(error) ?? error.message, error.failure)
}

function countLinkResults(results: readonly SymlinkResult[], out: Readonly<Output>): void {
  out.count('symlinks created', results.filter(result => result.action === 'created').length)
  const skipped = results.filter(result => result.action === 'skipped').length
  if (skipped > 0) out.count('symlinks skipped', skipped)
  const failed = results.filter(result => result.action === 'error').length
  if (failed > 0) out.count('symlink errors', failed)
}

function countCopyResults(results: readonly CopyResult[], out: Readonly<Output>): void {
  out.count('files copied', results.filter(result => result.action === 'copied').length)
  const skipped = results.filter(result => result.action === 'skipped').length
  if (skipped > 0) out.count('files skipped', skipped)
  const failed = results.filter(result => result.action === 'error')
  if (failed.length === 0) return
  out.count('copy errors', failed.length)
  for (const result of failed) out.warning(`copy ${result.source}: ${result.message}`)
}

const worktreeAddInput = z.object({
  directory: directorySchema,
  base: z.string().optional().describe('Base branch (default: the develop_branch of the repository in its project config)'),
  path: z.string().transform(lenientRealPath).optional().describe('Where to create the worktree (default: <project_root>/<auto-numbered>/<repository name>)'),
  no_copy: z.boolean().default(false).describe('Skip copying untracked files'),
  no_link: z.boolean().default(false).describe('Skip creating symlinks'),
  setup: z.string().optional().describe('Command to run after creation'),
  allow_existing_branch: z.boolean().default(false).describe('Allow reusing an existing branch even if its upstream differs from develop_branch'),
  project: PROJECT_INPUT,
})

const ADD_OUTPUT = z.strictObject({
  name: z.string().describe('Name of the worktree (the wtN it was numbered as)'),
  path: z.string().describe('Absolute path of the worktree'),
  branch: z.string().describe('Branch checked out in the worktree'),
  base: z.string().describe('Base branch the worktree branch starts from'),
  setupFailed: z.boolean().describe('true when the setup command failed or timed out, false when it succeeded or was not run'),
})

const worktreeAddCommand = defineTool({
  name: 'worktree_add',
  title: 'Add worktree',
  writes: { destructive: true, idempotent: false },
  description: 'Create a new worktree',
  input: worktreeAddInput,
  output: ADD_OUTPUT,
  run: async (input, io) => await runAdd(input, io),
})

async function runAdd(input: Readonly<z.output<typeof worktreeAddInput> & GlobalInput>, io: CommandIo): Promise<0> {
  requireRepositoryMatch('reject', input.repo, io, process.cwd())
  const out = createOutput<z.input<typeof ADD_OUTPUT>>(false, io)
  try {
    ensureDevcontainerEnvironment()
    const result = await createWorktree(input.directory, out, {
      baseBranch: input.base,
      path: input.path,
      shouldCopy: !input.no_copy,
      shouldLink: !input.no_link,
      setupCommand: input.setup,
      isExistingBranchAllowed: input.allow_existing_branch,
      project: input.project,
      signal: out.signal,
    })
    const operation: Operation = { verb: 'create', target: `worktree ${result.name} at ${result.path} (branch ${result.branch} from ${result.baseBranch})` }
    out.planned(operation)
    out.done(operation)
    out.data(result.path)
    const created = { name: result.name, path: result.path, branch: result.branch, base: result.baseBranch }
    out.result({ ...created, setupFailed: result.setupResult !== undefined && result.setupResult.exitCode !== 0 })
    if (result.linkedFiles.length > 0) countLinkResults(result.linkedFiles, out)
    if (result.copiedFiles.length > 0) countCopyResults(result.copiedFiles, out)
    return 0
  }
  catch (error: unknown) {
    return reportRuntimeError(out, error)
  }
}

const worktreeRemoveInput = z.object({
  name: z.string().describe('Name of the worktree to remove (the recorded wtN, the wtN directory, or the branch name)'),
  directory: directorySchema,
  force: z.boolean().default(false).describe('Force removal even if there are changes'),
  keep_branch: z.boolean().default(false).describe('Keep the branch'),
})

const REMOVE_OUTPUT = z.strictObject({
  name: z.string().describe('Name of the worktree that was removed, as given'),
  deletedBranch: z.boolean().describe('Whether the local branch was deleted (false when kept or when the deletion failed)'),
})

const worktreeRemoveCommand = defineTool({
  name: 'worktree_remove',
  title: 'Remove worktree',
  writes: { destructive: true, idempotent: false },
  description: 'Remove a worktree',
  input: worktreeRemoveInput,
  output: REMOVE_OUTPUT,
  run: (input, io) => Promise.resolve(runRemove(input, io)),
})

function runRemove(input: Readonly<z.output<typeof worktreeRemoveInput> & GlobalInput>, io: CommandIo): 0 {
  requireRepositoryMatch('reject', input.repo, io, process.cwd())
  const out = createOutput<z.input<typeof REMOVE_OUTPUT>>(false, io)
  try {
    ensureDevcontainerEnvironment()
    const branchError = removeWorktree(input.directory, input.name, out, { isForced: input.force, shouldKeepBranch: input.keep_branch })
    const removed: Operation = { verb: 'remove', target: `worktree ${input.name}` }
    out.planned(removed)
    out.done(removed)
    const shouldDelete = !input.keep_branch
    if (shouldDelete) {
      if (branchError === undefined) out.done({ verb: 'delete', target: `local branch ${input.name}` })
      else out.warning(`could not delete local branch ${input.name}: ${branchError}`)
    }
    out.result({ name: input.name, deletedBranch: shouldDelete && branchError === undefined })
    return 0
  }
  catch (error: unknown) {
    return reportRuntimeError(out, error)
  }
}

const worktreeInitInput = z.object({ directory: directorySchema })

const INIT_OUTPUT = z.strictObject({
  configFile: z.string().describe('Absolute path of the worktree config file'),
  ignoreFile: z.string().describe('Absolute path of the worktree ignore file'),
})

const worktreeInitCommand = defineTool({
  name: 'worktree_init',
  title: 'Initialize worktree config',
  writes: { destructive: false, idempotent: false },
  description: 'Create the worktree config files in the main worktree',
  input: worktreeInitInput,
  output: INIT_OUTPUT,
  run: (input, io) => Promise.resolve(runInit(input, io)),
})

// 共有する 3 つのリンクの向き先は、アクティブなプロジェクトの aggregation_repo。無ければこのリポジトリ
function sharedLinkTarget(mainWorktree: string): string {
  const config = loadActiveConfig()
  const aggregation = config === undefined ? undefined : aggregationRepositoryReference(config)
  return aggregation === undefined ? path.basename(mainWorktree) : aggregation.repository
}

function writeInitFiles(configFile: string, ignoreFile: string, config: Readonly<WorktreeConfig>, out: Readonly<Output<z.input<typeof INIT_OUTPUT>>>): void {
  try {
    saveConfig(config, configFile)
    out.done({ verb: 'create', target: `worktree config ${configFile}` })
    out.result({ configFile })
    mkdirSync(path.dirname(ignoreFile), { recursive: true })
    writeFileSync(ignoreFile, DEFAULT_WORKTREEIGNORE_CONTENT)
    out.done({ verb: 'create', target: `worktree ignore file ${ignoreFile}` })
    out.result({ ignoreFile })
  }
  catch (error: unknown) {
    throw hasErrorCode(error) ? toOsError(error) : error
  }
}

function runInit(input: Readonly<z.output<typeof worktreeInitInput> & GlobalInput>, io: CommandIo): 0 {
  requireRepositoryMatch('reject', input.repo, io, process.cwd())
  const out = createOutput<z.input<typeof INIT_OUTPUT>>(false, io)
  let mainWorktree: string
  try {
    ensureDevcontainerEnvironment()
    mainWorktree = findMainWorktree(input.directory)
  }
  catch (error: unknown) {
    return reportRuntimeError(out, error)
  }

  const configFile = path.join(mainWorktree, WORKTREE_CONFIG_FILENAME)
  const ignoreFile = path.join(mainWorktree, WORKTREE_IGNORE_FILENAME)
  const existing = [configFile, ignoreFile].filter(file => isExistingFile(file))
  if (existing.length > 0) stopWith(out, ['worktree config already exists', ...existing].join('\n'), 'already-exists')

  let targetRepository: string
  try {
    targetRepository = sharedLinkTarget(mainWorktree)
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError || error instanceof OsError || error instanceof ConfigError)) throw error
    return stopWith(out, `could not read the active config: ${error.message}`, 'config-invalid')
  }

  writeInitFiles(configFile, ignoreFile, getDefaultConfig(targetRepository, path.basename(mainWorktree)), out)
  return 0
}

function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isExistingFile(file: string): boolean {
  try {
    statSync(file)
    return true
  }
  catch (error: unknown) {
    if (isMissingPath(error)) return false
    throw error
  }
}

const worktreeLinkInput = z.object({
  directory: directorySchema,
  force: z.boolean().default(false).describe('Overwrite real files and directories without asking'),
  all: z.boolean().default(false).describe('Apply to all sub-worktrees'),
})

const LINK_ROW = z.strictObject({
  path: z.string().describe('Absolute path of the symlink'),
  destination: z.string().describe('Absolute path the symlink points to'),
  change: z.enum(['create', 'update', 'skip', 'error']).describe('create: a new symlink; update: an existing one was replaced; skip: left as it was; error: could not be made'),
  reason: z.string().optional().describe('Why the link was skipped or failed (omitted for create and update)'),
})

const LINK_OUTPUT = z.strictObject({
  links: z.array(LINK_ROW).describe('One entry per link of the config in each target worktree (an empty array when there is no sub-worktree)'),
})

type LinkData = z.input<typeof LINK_OUTPUT>
type LinkEntry = NonNullable<LinkData['links']>[number]

const worktreeLinkCommand = defineTool({
  name: 'worktree_link',
  title: 'Update worktree symlinks',
  writes: { destructive: true, idempotent: true },
  description: 'Apply or update symlinks in existing worktrees',
  input: worktreeLinkInput,
  output: LINK_OUTPUT,
  run: (input, io) => Promise.resolve(runLink(input, io)),
})

type LinkTargets
  = | { readonly kind: 'main-needs-all' }
    | { readonly kind: 'worktrees', readonly directories: readonly string[] }

// 対象の worktree。--all はサブの全部（0 個もある）、無ければ -D を含む worktree のルート
function linkTargets(directory: string, mainWorktree: string, isAll: boolean): LinkTargets {
  if (isAll) return { kind: 'worktrees', directories: getWorktreeDirectories(directory) }
  const resolvedDirectory = resolveRealPath(gitToplevel({ cwd: directory }) ?? directory)
  return resolvedDirectory === resolveRealPath(mainWorktree) ? { kind: 'main-needs-all' } : { kind: 'worktrees', directories: [resolvedDirectory] }
}

// 1 つの worktree にリンクを作り、(作った数, 飛ばした数, 失敗した数) を返す
function applyLinks(target: string, config: Readonly<WorktreeConfig>, projectRoot: string, options: Readonly<{ readonly force: boolean, readonly all: boolean }>, io: CommandIo, out: Readonly<Output<LinkData>>): { readonly counts: readonly [number, number, number], readonly links: readonly LinkEntry[] } {
  const decision = decideOverwrite({ force: options.force, allWorktrees: options.all })
  // 作る前の計画で、新しい symlink か置き換えかを分ける。結果は config.links と同じ順に返る
  const plans = config.links.map(link => planLink(link, projectRoot, target, decision))
  const results = createSymlinksSafe(config, projectRoot, target, out, {
    force: decision.force,
    confirm: decision.ask ? symlinkPath => abortUnconfirmed(io, `real file exists: ${symlinkPath}\noverwrite it?`) : undefined,
  })
  const created = results.filter(result => result.action === 'created')
  const skipped = results.filter(result => result.action === 'skipped')
  out.count(`symlinks created in ${target}`, created.length)
  for (const result of skipped) out.done({ verb: 'skip', target: `symlink ${result.symlinkPath} (${result.message})` })
  const links = results.map((result, index): LinkEntry => {
    const base = { path: result.symlinkPath, destination: result.targetPath }
    if (result.action === 'created') return { ...base, change: plans.at(index) === 'create' ? 'create' : 'update' }
    return { ...base, change: result.action === 'skipped' ? 'skip' : 'error', reason: result.message }
  })
  return { counts: [created.length, skipped.length, results.filter(result => result.action === 'error').length], links }
}

function runLink(input: Readonly<z.output<typeof worktreeLinkInput> & GlobalInput>, io: CommandIo): 0 {
  requireRepositoryMatch('reject', input.repo, io, process.cwd())
  const out = createOutput<LinkData>(false, io)
  try {
    ensureDevcontainerEnvironment()
    const configFile = findWorktreeConfigFile(input.directory)
    if (configFile === undefined) stopWith(out, hinted`worktree config not found\n${RUN_COLON}${commandHint(['worktree', 'init'], { directory: placeholder('directory') })}`, 'not-initialized')
    const config = loadConfig(configFile)
    const mainWorktree = findMainWorktree(input.directory)
    const projectRoot = detectProjectRoot(input.directory)

    const resolved = linkTargets(input.directory, mainWorktree, input.all)
    if (resolved.kind === 'main-needs-all') stopWith(out, hinted`use ${inputHint(['worktree', 'link'], 'all')} in the main worktree`, 'invalid-input')
    const targets = resolved.directories
    if (targets.length === 0) {
      out.count('sub-worktrees', 0)
      out.result({ links: [] })
      return 0
    }
    const options = { force: input.force, all: input.all }
    let [created, skipped, failed] = [0, 0, 0]
    const links: LinkEntry[] = []
    for (const target of targets) {
      const applied = applyLinks(target, config, projectRoot, options, io, out)
      const [targetCreated, targetSkipped, targetFailed] = applied.counts
      links.push(...applied.links)
      out.result({ links: [...links] })
      created += targetCreated
      skipped += targetSkipped
      failed += targetFailed
    }
    if (targets.length > 1) {
      out.count('symlinks created', created)
      out.count('symlinks skipped', skipped)
      out.count('symlink errors', failed)
    }
    return 0
  }
  catch (error: unknown) {
    if (error instanceof WorktreeConfigError) stopWith(out, error.message, 'config-invalid')
    return reportRuntimeError(out, error)
  }
}

export const WORKTREE_TOOLS: readonly ToolDefinition[] = [worktreeAddCommand, worktreeRemoveCommand, worktreeInitCommand, worktreeLinkCommand]
