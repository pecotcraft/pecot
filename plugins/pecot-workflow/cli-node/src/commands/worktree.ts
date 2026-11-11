/* eslint-disable security/detect-non-literal-fs-filename -- パスは検証済みの -D と、main worktree 配下の設定ファイル */
// worktree add / remove / init / link。移す元は cli/commands/worktree.py。
// 4 個とも、本体の前に --repo と git の remote の食い違いを reject で止める。
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { InvalidValueError } from '../domain/errors.js'
import { pythonStringRepr } from '../domain/python-format.js'
import { aggregationRepositoryReference, ConfigError } from '../domain/config.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitToplevel } from '../infra/git.js'
import { hasErrorCode, OsError, toOsError } from '../infra/os-error.js'
import { resolveRealPath, WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME } from '../infra/paths.js'
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
import type { LinkPlan, SymlinkResult, WorktreeConfig } from '../infra/worktree-links.js'
import { createOutput, isConfirmed } from './output.js'
import type { Operation, Output } from './output.js'
import { defineCommand } from './registry.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './registry.js'
import { requireRepositoryMatch } from './repository-match.js'

const FAILURE = 1

// typer の DirectoryOption と同じ検証と文にする。
// symlink は解決する。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function checkDirectory(value: string, context: z.RefinementCtx): void {
  const fail = (reason: string): void => {
    context.addIssue({ code: 'custom', message: `Directory ${pythonStringRepr(value)} ${reason}` })
  }
  const resolved = resolveRealPath(value)
  let isFile: boolean
  try {
    isFile = statSync(resolved).isFile()
  }
  catch (error: unknown) {
    if (!hasErrorCode(error)) throw error
    fail('does not exist.')
    return
  }
  if (isFile) {
    fail('is a file.')
    return
  }
  try {
    accessSync(resolved, constants.R_OK)
  }
  catch (error: unknown) {
    if (!hasErrorCode(error)) throw error
    fail('is not readable.')
  }
}

const directoryInput = z.string().superRefine(checkDirectory).transform(resolveRealPath).describe('Target Git repository (absolute or relative path)')
const dryRunInput = z.boolean().default(false).describe('Show what would happen without changing anything')

// WorktreeRuntimeError は最上位の網にかからないので、ここで error の行と終了コード 1 にする
function reportRuntimeError(out: Readonly<Output>, error: unknown): number {
  if (!(error instanceof WorktreeRuntimeError)) throw error
  out.error(error.message)
  return FAILURE
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
  directory: directoryInput,
  base: z.string().optional().describe('Base branch (default: the develop_branch of the repository in the active project)'),
  path: z.string().transform(resolveRealPath).optional().describe('Where to create the worktree (default: <project_root>/<auto-numbered>/<repository name>)'),
  no_copy: z.boolean().default(false).describe('Skip copying untracked files'),
  no_link: z.boolean().default(false).describe('Skip creating symlinks'),
  setup: z.string().optional().describe('Command to run after creation'),
  dry_run: dryRunInput,
  allow_existing_branch: z.boolean().default(false).describe('Allow reusing an existing branch even if its upstream differs from develop_branch'),
})

const worktreeAddCommand = defineCommand({
  path: ['worktree', 'add'],
  description: 'Create a new worktree',
  input: worktreeAddInput,
  positional: [],
  shortFlags: { directory: '-D' },
  aliases: { allow_existing_branch: '--force' },
  interactive: false,
  run: (input, io) => Promise.resolve(runAdd(input, io)),
})

function runAdd(input: Readonly<z.output<typeof worktreeAddInput> & GlobalInput>, io: CommandIo): number {
  const match = requireRepositoryMatch('reject', input.repo, io)
  if (match.kind === 'exit') return match.exitCode
  const out = createOutput(input.dry_run, io)
  try {
    ensureDevcontainerEnvironment()
    const result = createWorktree(input.directory, out, {
      baseBranch: input.base,
      path: input.path,
      shouldCopy: !input.no_copy,
      shouldLink: !input.no_link,
      setupCommand: input.setup,
      isDryRun: input.dry_run,
      isExistingBranchAllowed: input.allow_existing_branch,
    })
    const operation: Operation = { verb: 'create', target: `worktree ${result.name} at ${result.path} (branch ${result.branch} from ${result.baseBranch})` }
    out.planned(operation)
    out.done(operation)
    out.data(result.path)
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
  directory: directoryInput,
  force: z.boolean().default(false).describe('Force removal even if there are changes'),
  keep_branch: z.boolean().default(false).describe('Keep the branch'),
})

const worktreeRemoveCommand = defineCommand({
  path: ['worktree', 'remove'],
  description: 'Remove a worktree',
  input: worktreeRemoveInput,
  positional: ['name'],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: (input, io) => Promise.resolve(runRemove(input, io)),
})

function runRemove(input: Readonly<z.output<typeof worktreeRemoveInput> & GlobalInput>, io: CommandIo): number {
  const match = requireRepositoryMatch('reject', input.repo, io)
  if (match.kind === 'exit') return match.exitCode
  const out = createOutput(false, io)
  try {
    ensureDevcontainerEnvironment()
    const branchError = removeWorktree(input.directory, input.name, out, { isForced: input.force, shouldKeepBranch: input.keep_branch })
    out.done({ verb: 'remove', target: `worktree ${input.name}` })
    if (!input.keep_branch) {
      if (branchError === undefined) out.done({ verb: 'delete', target: `local branch ${input.name}` })
      else out.warning(`could not delete local branch ${input.name}: ${branchError}`)
    }
    return 0
  }
  catch (error: unknown) {
    return reportRuntimeError(out, error)
  }
}

const worktreeInitInput = z.object({ directory: directoryInput })

const worktreeInitCommand = defineCommand({
  path: ['worktree', 'init'],
  description: 'Create the worktree config files in the main worktree',
  input: worktreeInitInput,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: (input, io) => Promise.resolve(runInit(input, io)),
})

// 共有する 3 つのリンクの向き先は、アクティブなプロジェクトの aggregation_repo。無ければこのリポジトリ
function sharedLinkTarget(mainWorktree: string): string {
  const config = loadActiveConfig()
  const aggregation = config === undefined ? undefined : aggregationRepositoryReference(config)
  return aggregation === undefined ? path.basename(mainWorktree) : aggregation.repository
}

function writeInitFiles(configFile: string, ignoreFile: string, config: Readonly<WorktreeConfig>, out: Readonly<Output>): void {
  try {
    saveConfig(config, configFile)
    out.done({ verb: 'create', target: `worktree config ${configFile}` })
    mkdirSync(path.dirname(ignoreFile), { recursive: true })
    writeFileSync(ignoreFile, DEFAULT_WORKTREEIGNORE_CONTENT)
    out.done({ verb: 'create', target: `worktree ignore file ${ignoreFile}` })
  }
  catch (error: unknown) {
    throw hasErrorCode(error) ? toOsError(error) : error
  }
}

function runInit(input: Readonly<z.output<typeof worktreeInitInput> & GlobalInput>, io: CommandIo): number {
  const match = requireRepositoryMatch('reject', input.repo, io)
  if (match.kind === 'exit') return match.exitCode
  const out = createOutput(false, io)
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
  if (existing.length > 0) {
    out.error(['worktree config already exists', ...existing].join('\n'))
    return FAILURE
  }

  let targetRepository: string
  try {
    targetRepository = sharedLinkTarget(mainWorktree)
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError || error instanceof OsError || error instanceof ConfigError)) throw error
    out.error(`could not read the active config: ${error.message}`)
    return FAILURE
  }

  writeInitFiles(configFile, ignoreFile, getDefaultConfig(targetRepository, path.basename(mainWorktree)), out)
  return 0
}

function isExistingFile(file: string): boolean {
  try {
    statSync(file)
    return true
  }
  catch (error: unknown) {
    if (hasErrorCode(error)) return false
    throw error
  }
}

const worktreeLinkInput = z.object({
  directory: directoryInput,
  force: z.boolean().default(false).describe('Overwrite real files and directories without asking'),
  all: z.boolean().default(false).describe('Apply to all sub-worktrees'),
  dry_run: dryRunInput,
})

const worktreeLinkCommand = defineCommand({
  path: ['worktree', 'link'],
  description: 'Apply or update symlinks in existing worktrees',
  input: worktreeLinkInput,
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: true,
  run: (input, io) => Promise.resolve(runLink(input, io)),
})

// 対象の worktree。--all はサブの全部、無ければ -D を含む worktree のルート（メインなら undefined）
function linkTargets(directory: string, mainWorktree: string, isAll: boolean): readonly string[] | undefined {
  if (isAll) return getWorktreeDirectories(directory)
  const resolvedDirectory = resolveRealPath(gitToplevel({ cwd: directory }) ?? directory)
  return resolvedDirectory === resolveRealPath(mainWorktree) ? undefined : [resolvedDirectory]
}

type SkipPlan = Exclude<LinkPlan, 'create' | 'update' | 'ask'>

function skipReason(plan: SkipPlan): string {
  switch (plan) {
    case 'skip-missing': { return 'target does not exist' }
    case 'skip-dangling': { return 'target is a dangling symlink' }
    case 'skip-real-file': { return 'a real file exists' }
    case 'skip-tracked': { return 'tracked by git' }
  }
}

function plannedOperation(plan: LinkPlan, symlinkPath: string, destination: string): Operation {
  if (plan === 'create') return { verb: 'create', target: `symlink ${symlinkPath} -> ${destination}` }
  if (plan === 'update') return { verb: 'update', target: `symlink ${symlinkPath} -> ${destination}` }
  if (plan === 'ask') return { verb: 'update', target: `symlink ${symlinkPath} -> ${destination} (real file, asks first)` }
  return { verb: 'skip', target: `symlink ${symlinkPath} (${skipReason(plan)})` }
}

function previewLinks(targets: readonly string[], config: Readonly<WorktreeConfig>, projectRoot: string, options: Readonly<{ readonly force: boolean, readonly all: boolean }>, out: Readonly<Output>): void {
  const decision = decideOverwrite({ force: options.force, allWorktrees: options.all })
  for (const target of targets) {
    for (const link of config.links) {
      const destination = path.join(projectRoot, 'base', link.target_repo, link.target_path)
      out.planned(plannedOperation(planLink(link, projectRoot, target, decision), path.join(target, link.path), destination))
    }
  }
}

// 1 つの worktree にリンクを作り、(作った数, 飛ばした数, 失敗した数) を返す
function applyLinks(target: string, config: Readonly<WorktreeConfig>, projectRoot: string, options: Readonly<{ readonly force: boolean, readonly all: boolean }>, io: CommandIo, out: Readonly<Output>): readonly [number, number, number] {
  const decision = decideOverwrite({ force: options.force, allWorktrees: options.all })
  const results = createSymlinksSafe(config, projectRoot, target, out, {
    force: decision.force,
    confirm: decision.ask ? symlinkPath => isConfirmed(io, `real file exists: ${symlinkPath}\noverwrite it?`) : undefined,
  })
  const created = results.filter(result => result.action === 'created')
  const skipped = results.filter(result => result.action === 'skipped')
  out.count(`symlinks created in ${target}`, created.length)
  for (const result of skipped) out.done({ verb: 'skip', target: `symlink ${result.symlinkPath} (${result.message})` })
  return [created.length, skipped.length, results.filter(result => result.action === 'error').length]
}

function runLink(input: Readonly<z.output<typeof worktreeLinkInput> & GlobalInput>, io: CommandIo): number {
  const match = requireRepositoryMatch('reject', input.repo, io)
  if (match.kind === 'exit') return match.exitCode
  const out = createOutput(input.dry_run, io)
  try {
    ensureDevcontainerEnvironment()
    const configFile = findWorktreeConfigFile(input.directory)
    if (configFile === undefined) {
      out.error('worktree config not found\nrun: pecot worktree init -D <directory>')
      return FAILURE
    }
    const config = loadConfig(configFile)
    const mainWorktree = findMainWorktree(input.directory)
    const projectRoot = detectProjectRoot(input.directory)

    const targets = linkTargets(input.directory, mainWorktree, input.all)
    if (targets === undefined) {
      out.error('use --all in the main worktree')
      return FAILURE
    }
    if (targets.length === 0) {
      out.count('sub-worktrees', 0)
      return 0
    }
    const options = { force: input.force, all: input.all }
    if (input.dry_run) {
      previewLinks(targets, config, projectRoot, options, out)
      return 0
    }
    let [created, skipped, failed] = [0, 0, 0]
    for (const target of targets) {
      const [targetCreated, targetSkipped, targetFailed] = applyLinks(target, config, projectRoot, options, io, out)
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
    if (error instanceof WorktreeConfigError) {
      out.error(error.message)
      return FAILURE
    }
    return reportRuntimeError(out, error)
  }
}

export const WORKTREE_COMMANDS: readonly CommandDefinition[] = [worktreeAddCommand, worktreeRemoveCommand, worktreeInitCommand, worktreeLinkCommand]
