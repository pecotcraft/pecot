// リポジトリのブランチを扱うコマンド（branch create・branch delete）。Python の cli/commands/repo.py の移植。
import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { findRepository, getFieldId, getOptionId, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { ReferenceParseError, parseIssueReference, parseRepositoryReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { compareStrings, pythonStringRepr } from '../domain/python-format.js'
import { repositoryFullName } from '../domain/repository-resolver.js'
import { displayReference } from '../domain/readiness.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { decideStart, describeBaseMismatch } from '../domain/work-start.js'
import type { StartDecision } from '../domain/work-start.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, isMissingReferenceError } from '../infra/github/errors.js'
import { readFlag } from '../infra/state-store.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { defineCommand } from './command-definition.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { requireRepositoryMatch, resolveCurrentRepository } from './repository-match.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import { recordWorkTarget } from './work-target.js'

/**
A-1. 作業ディレクトリの git remote のリポジトリが Issue のリポジトリと違えば、終了コード 2 で止める
*/
function rejectCwdRepositoryMismatch(out: Readonly<Output>, owner: string, repository: string): void {
  const resolved = resolveCurrentRepository(process.cwd())
  if (resolved?.source !== 'current-git') return
  const current = resolved.repository
  if (current.owner === owner && current.repository === repository) return
  stopWith(
    out,
    `the repository of the work Issue (${owner}/${repository}) differs from `
    + `the CWD git remote (${repositoryFullName(current)})\n`
    + 'move to the worktree of the target repository and run again:\n'
    + `<project-root>/base/${repository}/ or <project-root>/<wtN>/${repository}/\n`
    + 'create one with /pecot-w:w-worktree-add only if the repository has no worktree\n'
    + 'to issue the command on purpose from outside the CWD (for example in a script), '
    + 'give --allow-cross-repo',
    USAGE_EXIT_CODE,
  )
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
develop_branch を設定する直し方の行
*/
function developBranchGuide(owner: string, repository: string): string {
  return `set it with: pecot repo set ${owner}/${repository} --develop-branch develop`
}

/**
3. ベースブランチを決める（--base を先に、無ければ設定の develop_branch）
*/
function resolveBaseBranch(out: Readonly<Output>, query: Readonly<BaseBranchQuery>): string {
  const { config, owner, repository, issueNumber, branchName, base } = query
  if (base !== undefined && base !== '') return base
  const developBranch = findRepository(config, owner, repository)?.develop_branch
  if (developBranch === undefined || developBranch === '') {
    stopWith(
      out,
      `develop_branch is not set for ${owner}/${repository}\n`
      + `${developBranchGuide(owner, repository)}\n`
      + `or give the base: pecot branch create ${owner}/${repository}/${String(issueNumber)} ${branchName} --base main`,
    )
  }
  return developBranch
}

/**
3.5. 着手の判定を読み、積む先を決める。blocked と読めないときは止める。依存関係を持たない GHES は、warning を出して判定なしで進める
*/
async function decideWorkStart(out: Readonly<Output>, client: Readonly<GitHubClient>, config: ProjectConfig, issue: Readonly<IssueReference>): Promise<Exclude<StartDecision, { kind: 'blocked' }>> {
  const label = displayReference(issue, issue.repository)
  const warnNotChecked = (reason: string): void => {
    out.warning(`readiness is not checked: ${reason}`)
  }
  const result = await readIssueReadinessIfSupported(client, config, issue, createReadinessCache(), warnNotChecked)
  if (result === undefined) return { kind: 'start' }
  if (result.kind === 'unreadable') {
    if (result.snapshot === undefined) return stopWith(out, `could not read blocked-by of ${label}: ${result.reason}`)
    const isUnset = result.snapshot.developmentBranch === undefined || result.snapshot.developmentBranch === ''
    const guide = isUnset ? `\n${developBranchGuide(issue.repository.owner, issue.repository.repository)}` : ''
    return stopWith(out, `could not judge readiness of ${label}: ${result.reason}${guide}`)
  }
  const decision = decideStart(result.readiness, result.prerequisites, issue)
  return decision.kind === 'blocked' ? stopWith(out, decision.message, USAGE_EXIT_CODE) : decision
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
    stopWith(
      out,
      `this worktree is already working on another Issue (${existing}, OPEN)\n`
      + 'overwriting .pecot-active could mix up the tasks\n'
      + 'finish the other Issue first, or create another worktree with '
      + '/pecot-w:w-worktree-add and run /pecot-w:w-active again in its session\n'
      + 'if it is stale and you want to overwrite it on purpose, give --force-overwrite-active',
      USAGE_EXIT_CODE,
    )
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
    out.warning(`could not set ${target}: ${error.message}`)
  }
}

const branchCreationCommand = defineCommand({
  path: ['branch', 'create'],
  description: 'Create a branch linked to an Issue (shown in the Development section of the Issue)',
  input: z.strictObject({
    issue_ref: z.string().describe('Issue reference (owner/repo/123)'),
    branch_name: z.string().describe('Name of the branch to create'),
    base: z.string().optional().describe('Base branch (default: chosen by readiness, else develop_branch from the config)'),
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
      return stopWith(out, error.message, USAGE_EXIT_CODE)
    }
    const { owner, repository } = issue.repository
    const issueNumber = issue.number

    // A-1. 作業ディレクトリと Issue ref のリポジトリの整合チェック
    if (!input.allow_cross_repo) rejectCwdRepositoryMismatch(out, owner, repository)

    const finalBranchName = `${input.branch_name}/${String(issueNumber)}`
    try {
      const client = createGitHubClient(out, config.host)

      // A-2. .pecot-active 上書きガード
      if (!input.force_overwrite_active) await guardActiveOverwrite(out, client, `${owner}/${repository}/${String(issueNumber)}`)

      // 4. リポジトリがプロジェクトに含まれているか確認
      if (!await isRepositoryInProject(config, owner, repository, client)) {
        stopWith(out, `${owner}/${repository} is not in the project`)
      }

      // 4.5. 着手の判定で base を選ぶ。--base は積む先と比べる
      const decision = await decideWorkStart(out, client, config, issue)
      const mismatch = describeBaseMismatch(input.base, decision, issue)
      if (mismatch !== undefined) stopWith(out, mismatch, USAGE_EXIT_CODE)
      // 3. ベースブランチ決定（積まないときだけ、--base か設定の develop_branch を求める）
      const baseBranch = decision.kind === 'stack' ? decision.branch : resolveBaseBranch(out, { config, owner, repository, issueNumber, branchName: input.branch_name, base: input.base })

      // 5. Issue Node ID とタイトル取得（タイトルはセッション名用）
      const { id: issueNodeId, title: issueTitle } = await client.getIssueNodeIdAndTitle(owner, repository, issueNumber)

      // 6. ベースブランチの commit SHA 取得
      let baseSha: string
      try {
        baseSha = await client.getBranchSha(owner, repository, baseBranch)
      }
      catch (error: unknown) {
        if (error instanceof GitHubAPIError && decision.kind === 'stack') {
          out.error(`base branch ${baseBranch} of ${displayReference(decision.issue, issue.repository)} not found: ${error.message}`)
          return 1
        }
        throw error
      }

      // 7. リンクブランチ作成（ブランチ名末尾に Issue 番号を自動付与）
      const createdBranch = await client.createLinkedBranch(issueNodeId, baseSha, finalBranchName)
      const stackedNote = decision.kind === 'stack' ? ` (stacked on ${displayReference(decision.issue, issue.repository)})` : ''
      out.done({ verb: 'create', target: `branch ${createdBranch} in ${owner}/${repository} from ${baseBranch}${stackedNote}` })

      // 7.5. プロジェクトアイテムのステータスを active に更新
      await setIssueStatusActive(out, client, config, { owner, repository, number: issueNumber })

      // 9. 作業対象を .pecot-active と .pecot-session-title に保存（hook の自動投稿とセッション名用）
      recordWorkTarget(out, owner, repository, issueNumber, issueTitle, {
        base: { branch: baseBranch, sha: baseSha, stackedOn: decision.kind === 'stack' ? decision.issue : undefined },
      })
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not create branch ${finalBranchName} in ${owner}/${repository}: ${error.message}`)
      return 1
    }
  },
})

const branchDeletionCommand = defineCommand({
  path: ['branch', 'delete'],
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
      return stopWith(out, error.message, USAGE_EXIT_CODE)
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
      client = createGitHubClient(out, config.host)
      protectedBranches.add(await client.getRepositoryDefaultBranch(owner, repository))
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.error(`could not read the default branch of ${owner}/${repository}: ${error.message}`)
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
      out.error(`could not delete remote branch ${input.branch} in ${owner}/${repository}: ${error.message}`)
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
      // wip ブランチの削除の失敗だけは、API の応答の本文の詳細も見せる（Python の describe_api_error と同じ）。存在しない場合は何も出さない
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
