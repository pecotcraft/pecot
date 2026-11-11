// リポジトリのブランチを扱うコマンド（create-branch・delete-branch）。Python の cli/commands/repo.py の移植。
import { z } from 'zod'

import { findRepository, getFieldId, getOptionId, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { ReferenceParseError, parseIssueReference, parseRepositoryReference } from '../domain/reference-parser.js'
import { compareStrings, pythonStringRepr } from '../domain/python-format.js'
import { repositoryFullName } from '../domain/repository-resolver.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, describeApiError, isMissingReferenceError } from '../infra/github/errors.js'
import { readFlag } from '../infra/state-store.js'
import { apiErrorDetail } from './api-error.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { CommandExit, defineCommand } from './command-definition.js'
import { requireRepositoryMatch, resolveCurrentRepository } from './repository-match.js'
import { recordWorkTarget } from './work-target.js'

const NO_ACTIVE_PROJECT = 'no active project\nrun: pecot project activate <PROJECT>'

/**
使い方の誤り（コマンドの引数の形）の終了コード
*/
const USAGE_EXIT = 2

/**
設定を読む。アクティブなプロジェクトが無ければ error の行を出して止める
*/
function requireActiveConfig(out: Readonly<Output>): ProjectConfig {
  const config = loadActiveConfig()
  if (config === undefined) {
    out.error(NO_ACTIVE_PROJECT)
    throw new CommandExit(1)
  }
  return config
}

/**
A-1. 作業ディレクトリの git remote のリポジトリが Issue のリポジトリと違えば、終了コード 2 で止める
*/
function rejectCwdRepositoryMismatch(out: Readonly<Output>, owner: string, repository: string): void {
  const resolved = resolveCurrentRepository(process.cwd())
  if (resolved?.source !== 'current-git') return
  const current = resolved.repository
  if (current.owner === owner && current.repository === repository) return
  out.error(
    `the repository of the work Issue (${owner}/${repository}) differs from `
    + `the CWD git remote (${repositoryFullName(current)})\n`
    + 'move to the worktree of the target repository and run again:\n'
    + `<project-root>/base/${repository}/ or <project-root>/<wtN>/${repository}/\n`
    + 'create one with /pecot-w:w-worktree-add only if the repository has no worktree\n'
    + 'to issue the command on purpose from outside the CWD (for example in a script), '
    + 'give --allow-cross-repo',
  )
  throw new CommandExit(USAGE_EXIT)
}

interface BaseBranchQuery {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
  readonly issueNumber: number
  readonly branchName: string
  readonly base: string | undefined
}

/**
3. ベースブランチを決める（--base を先に、無ければ設定の develop_branch）
*/
function resolveBaseBranch(out: Readonly<Output>, query: Readonly<BaseBranchQuery>): string {
  const { config, owner, repository, issueNumber, branchName, base } = query
  if (base !== undefined && base !== '') return base
  const developBranch = findRepository(config, owner, repository)?.develop_branch
  if (developBranch === undefined || developBranch === '') {
    out.error(
      `develop_branch is not set for ${owner}/${repository}\n`
      + `set it with: pecot project set-repo ${owner}/${repository} --develop-branch develop\n`
      + `or give the base: pecot create-branch ${owner}/${repository}/${String(issueNumber)} ${branchName} --base main`,
    )
    throw new CommandExit(1)
  }
  return developBranch
}

/**
A-2. .pecot-active が別の OPEN な Issue を指していれば、終了コード 2 で止める
*/
async function guardActiveOverwrite(out: Readonly<Output>, client: Readonly<GitHubClient>, issueReference: string): Promise<void> {
  const existing = readFlag(FLAG_PECOT_ACTIVE) ?? ''
  if (existing === '' || existing === issueReference) return
  let existingReference
  try {
    existingReference = parseIssueReference(existing)
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    out.warning(`the content of .pecot-active (${pythonStringRepr(existing)}) is malformed; overwriting it`)
    return
  }
  const { repository, number } = existingReference
  const { state } = await client.getIssueSlim(repository.owner, repository.repository, number)
  if (state === 'OPEN') {
    out.error(
      `this worktree is already working on another Issue (${existing}, OPEN)\n`
      + 'overwriting .pecot-active could mix up the tasks\n'
      + 'finish the other Issue first, or create another worktree with '
      + '/pecot-w:w-worktree-add and run /pecot-w:w-active again in its session\n'
      + 'if it is stale and you want to overwrite it on purpose, give --force-overwrite-active',
    )
    throw new CommandExit(USAGE_EXIT)
  }
  out.warning(state === 'CLOSED'
    ? `.pecot-active points to closed Issue ${existing}; overwriting it`
    : `the state of ${existing} in .pecot-active is unexpected (${pythonStringRepr(state)}); overwriting it`)
}

/**
7.5. プロジェクトアイテムのステータスを active にする（失敗は warning にとどめる）
*/
async function setIssueStatusActive(out: Readonly<Output>, client: Readonly<GitHubClient>, config: ProjectConfig, issue: Readonly<{ owner: string, repository: string, number: number }>): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${owner}/${repository}/${String(number)} status active`
  try {
    const itemId = await client.getItemIdByIssue(config.project.id, owner, repository, number)
    if (itemId === undefined || itemId === '') {
      out.warning(`could not set ${target}: the Issue is not on the project board`)
      return
    }
    const fieldId = getFieldId(config, 'workflow')
    const optionId = getOptionId(config, 'workflow', 'active')
    if (fieldId === undefined || fieldId === '' || optionId === undefined || optionId === '') {
      out.warning(`could not set ${target}: the workflow status field has no 'active' option`)
      return
    }
    await client.updateProjectItemField(config.project.id, itemId, fieldId, optionId)
    out.done({ verb: 'set', target })
  }
  catch (error: unknown) {
    // ブランチは作成済みなので、ステータスの失敗でコマンドは止めない
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not set ${target}: ${apiErrorDetail(error)}`)
  }
}

const branchCreationCommand = defineCommand({
  path: ['create-branch'],
  description: 'Create a branch linked to an Issue (shown in the Development section of the Issue)',
  input: z.strictObject({
    issue_ref: z.string().describe('Issue reference (owner/repo/123)'),
    branch_name: z.string().describe('Name of the branch to create'),
    base: z.string().optional().describe('Base branch (default: develop_branch from the config)'),
    checkout: z.boolean().default(true).describe('Kept for compatibility; has no effect'),
    allow_cross_repo: z.boolean().default(false).describe('Allow the CWD repository to differ from the Issue ref (for scripts and runs outside the CWD)'),
    force_overwrite_active: z.boolean().default(false).describe('Disable the .pecot-active overwrite guard (when sure it is stale)'),
  }),
  positional: ['issue_ref', 'branch_name'],
  shortFlags: { base: '-b', allow_cross_repo: '-X', force_overwrite_active: '-F' },
  negations: { checkout: '--no-checkout' },
  interactive: false,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput(false, io)
    // 1. 設定取得
    const config = requireActiveConfig(out)

    // 2. issue_ref をパース（フル形式必須、基準リポは渡さない）
    let issue
    try {
      issue = parseIssueReference(input.issue_ref)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      out.error(error.message)
      throw new CommandExit(USAGE_EXIT)
    }
    const { owner, repository } = issue.repository
    const issueNumber = issue.number

    // A-1. 作業ディレクトリと Issue ref のリポジトリの整合チェック
    if (!input.allow_cross_repo) rejectCwdRepositoryMismatch(out, owner, repository)

    // 3. ベースブランチ決定（ローカル設定から）
    const baseBranch = resolveBaseBranch(out, { config, owner, repository, issueNumber, branchName: input.branch_name, base: input.base })

    const finalBranchName = `${input.branch_name}/${String(issueNumber)}`
    try {
      const client = new GitHubClient({ host: config.host, diagnostics: out })

      // A-2. .pecot-active 上書きガード
      if (!input.force_overwrite_active) await guardActiveOverwrite(out, client, `${owner}/${repository}/${String(issueNumber)}`)

      // 4. リポジトリがプロジェクトに含まれているか確認
      if (!await isRepositoryInProject(config, owner, repository, client)) {
        out.error(`${owner}/${repository} is not in the project`)
        throw new CommandExit(1)
      }

      // 5. Issue Node ID とタイトル取得（タイトルはセッション名用）
      const { id: issueNodeId, title: issueTitle } = await client.getIssueNodeIdAndTitle(owner, repository, issueNumber)

      // 6. ベースブランチの commit SHA 取得
      const baseSha = await client.getBranchSha(owner, repository, baseBranch)

      // 7. リンクブランチ作成（ブランチ名末尾に Issue 番号を自動付与）
      const createdBranch = await client.createLinkedBranch(issueNodeId, baseSha, finalBranchName)
      out.done({ verb: 'create', target: `branch ${createdBranch} in ${owner}/${repository} from ${baseBranch}` })

      // 7.5. プロジェクトアイテムのステータスを active に更新
      await setIssueStatusActive(out, client, config, { owner, repository, number: issueNumber })

      // 9. 作業対象を .pecot-active と .pecot-session-title に保存（hook の自動投稿とセッション名用）
      recordWorkTarget(out, owner, repository, issueNumber, issueTitle)
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not create branch ${finalBranchName} in ${owner}/${repository}: ${apiErrorDetail(error)}`)
      return 1
    }
  },
})

const branchDeletionCommand = defineCommand({
  path: ['delete-branch'],
  description: 'Delete a remote branch (a protected branch is never deleted)',
  input: z.strictObject({
    repo_ref: z.string().describe('Repository reference (owner/repo)'),
    branch: z.string().describe('Name of the branch to delete'),
    dry_run: z.boolean().default(false).describe('Show what would be deleted without deleting anything'),
  }),
  positional: ['repo_ref', 'branch'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput(input.dry_run, io)
    // 1. repo_ref をパース
    let target
    try {
      target = parseRepositoryReference(input.repo_ref)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      out.error(error.message)
      throw new CommandExit(USAGE_EXIT)
    }
    const { owner, repository } = target

    // 2. 設定取得
    const config = requireActiveConfig(out)

    // 3. 保護ブランチ収集（設定の develop_branch・release_branch と、API の既定ブランチ）
    const protectedBranches = new Set<string>()
    const repositoryConfig = findRepository(config, owner, repository)
    for (const branch of [repositoryConfig?.develop_branch, repositoryConfig?.release_branch]) {
      if (branch !== undefined && branch !== '') protectedBranches.add(branch)
    }

    let client
    try {
      client = new GitHubClient({ host: config.host, diagnostics: out })
      protectedBranches.add(await client.getRepositoryDefaultBranch(owner, repository))
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not read the default branch of ${owner}/${repository}: ${apiErrorDetail(error)}`)
      return 1
    }

    // 4. 保護ブランチチェック
    if (protectedBranches.has(input.branch)) {
      out.error(`${input.branch} is a protected branch\nprotected: ${[...protectedBranches].toSorted(compareStrings).join(', ')}`)
      return 1
    }

    // 5. dry-run
    const operation: Operation = { verb: 'delete', target: `remote branch ${input.branch} in ${owner}/${repository}` }
    if (input.dry_run) {
      out.planned(operation)
      return 0
    }

    // 6. 削除実行
    try {
      await client.deleteBranch(owner, repository, input.branch)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not delete remote branch ${input.branch} in ${owner}/${repository}: ${apiErrorDetail(error)}`)
      return 1
    }
    out.done(operation)

    // wip ブランチも連動削除
    const wipBranch = `wip/${input.branch}`
    try {
      await client.deleteBranch(owner, repository, wipBranch)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      // 存在しない場合は何も出さない
      if (!isMissingReferenceError(error)) out.warning(`could not delete remote branch ${wipBranch} in ${owner}/${repository}: ${describeApiError(error)}`)
      return 0
    }
    out.done({ verb: 'delete', target: `remote branch ${wipBranch} in ${owner}/${repository}` })
    return 0
  },
})

/**
ブランチを扱うコマンド。並びは tests/parity/commands.ts と同じ
*/
export const REPOSITORY_COMMANDS = [branchCreationCommand, branchDeletionCommand]
