// session start。Python の cli/commands/repo.py の create_branch の移植。
import { z } from 'zod'

import { findRepository, getFieldId, getOptionId, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { ReferenceParseError, parseIssueReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { pythonStringRepr } from '../domain/python-format.js'
import { repositoryFullName } from '../domain/repository-resolver.js'
import { displayReference } from '../domain/readiness.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { decideStart, describeBaseMismatch } from '../domain/work-start.js'
import type { StartDecision } from '../domain/work-start.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { readFlag } from '../infra/state-store.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, inputHint, joinHinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { requireRepositoryMatch, resolveCurrentRepository } from './repository-match.js'
import { createReadinessCache, readIssueReadinessIfSupported } from './issue-readiness.js'
import { planWorkTarget, recordWorkTarget } from './work-target.js'

const START_PATH = ['session', 'start']

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
    joinHinted([
      `the repository of the work Issue (${owner}/${repository}) differs from `
      + `the CWD git remote (${repositoryFullName(current)})\n`
      + 'move to the worktree of the target repository and run again:\n'
      + `<project-root>/base/${repository}/ or <project-root>/<wtN>/${repository}/\n`
      + 'create one with /pecot-w:w-worktree-add only if the repository has no worktree\n'
      + 'to issue the command on purpose from outside the CWD (for example in a script), ',
      hinted`give ${inputHint(START_PATH, 'allow_cross_repo')}`,
    ], ''),
    'repo-mismatch',
    USAGE_EXIT_CODE,
  )
}

interface BaseBranchQuery {
  readonly config: ProjectConfig
  readonly owner: string
  readonly repository: string
  readonly issueNumber: number
  readonly branch: string
  readonly base: string | undefined
}

/**
develop_branch を設定する直し方の行
*/
function developBranchGuide(owner: string, repository: string): HintedText {
  return hinted`set it with: ${commandHint(['project', 'link'], { repo: `${owner}/${repository}`, develop_branch: 'develop' })}`
}

/**
3. ベースブランチを決める（--base を先に、無ければ設定の develop_branch）
*/
function resolveBaseBranch(out: Readonly<Output>, query: Readonly<BaseBranchQuery>): string {
  const { config, owner, repository, issueNumber, branch, base } = query
  if (base !== undefined && base !== '') return base
  const developBranch = findRepository(config, owner, repository)?.develop_branch
  if (developBranch === undefined || developBranch === '') {
    const withBase = commandHint(START_PATH, { issue_ref: `${owner}/${repository}/${String(issueNumber)}`, branch, base: 'main' })
    stopWith(out, joinHinted([`develop_branch is not set for ${owner}/${repository}`, developBranchGuide(owner, repository), hinted`or give the base: ${withBase}`]), 'repo-setting-missing')
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
    if (result.snapshot === undefined) return stopWith(out, `could not read blocked-by of ${label}: ${result.reason}`, 'dependency-unreadable')
    const isUnset = result.snapshot.developmentBranch === undefined || result.snapshot.developmentBranch === ''
    const guide = isUnset ? [developBranchGuide(issue.repository.owner, issue.repository.repository)] : []
    return stopWith(out, joinHinted([`could not judge readiness of ${label}: ${result.reason}`, ...guide]), 'dependency-unreadable')
  }
  const decision = decideStart(result.readiness, result.prerequisites, issue)
  return decision.kind === 'blocked' ? stopWith(out, decision.message, 'not-ready', USAGE_EXIT_CODE) : decision
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
      joinHinted([
        `this worktree is already working on another Issue (${existing}, OPEN)\n`
        + 'overwriting .pecot-active could mix up the tasks\n'
        + 'finish the other Issue first, or create another worktree with '
        + '/pecot-w:w-worktree-add and run /pecot-w:w-active again in its session',
        hinted`if it is stale and you want to overwrite it on purpose, give ${inputHint(START_PATH, 'force_overwrite_active')}`,
      ]),
      'guard-blocked',
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

const sessionStartCommand = defineCommand({
  path: START_PATH,
  description: 'Create a branch linked to an Issue (shown in the Development section of the Issue)',
  input: z.strictObject({
    issue_ref: z.string().describe('Issue reference (owner/repo/123)'),
    branch: z.string().describe('Name of the branch to create'),
    base: z.string().optional().describe('Base branch (default: chosen by readiness, else develop_branch from the config)'),
    checkout: z.boolean().default(true).describe('Kept for compatibility; has no effect'),
    allow_cross_repo: z.boolean().default(false).describe('Allow the CWD repository to differ from the Issue ref (for scripts and runs outside the CWD)'),
    force_overwrite_active: z.boolean().default(false).describe('Disable the .pecot-active overwrite guard (when sure it is stale)'),
    dry_run: z.boolean().default(false).describe('Show what would be created and recorded without writing anything'),
  }),
  positional: ['issue_ref', 'branch'],
  shortFlags: { base: '-b', allow_cross_repo: '-X', force_overwrite_active: '-F', dry_run: '-n' },
  negations: { checkout: '--no-checkout' },
  interactive: false,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput(input.dry_run, io)
    // 1. 設定取得
    const config = requireActiveConfig(out)

    // 2. issue_ref をパース（フル形式必須、基準リポは渡さない）
    let issue
    try {
      issue = parseIssueReference(input.issue_ref)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      return stopWith(out, error.message, 'invalid-input', USAGE_EXIT_CODE)
    }
    const { owner, repository } = issue.repository
    const issueNumber = issue.number

    // A-1. 作業ディレクトリと Issue ref のリポジトリの整合チェック
    if (!input.allow_cross_repo) rejectCwdRepositoryMismatch(out, owner, repository)

    const finalBranchName = `${input.branch}/${String(issueNumber)}`
    try {
      const client = createGitHubClient(out, config.host)

      // A-2. .pecot-active 上書きガード
      if (!input.force_overwrite_active) await guardActiveOverwrite(out, client, `${owner}/${repository}/${String(issueNumber)}`)

      // 4. リポジトリがプロジェクトに含まれているか確認
      if (!await isRepositoryInProject(config, owner, repository, client)) {
        stopWith(out, `${owner}/${repository} is not in the project`, 'repo-not-in-project')
      }

      // 4.5. 着手の判定で base を選ぶ。--base は積む先と比べる
      const decision = await decideWorkStart(out, client, config, issue)
      const mismatch = describeBaseMismatch(input.base, decision, issue)
      if (mismatch !== undefined) stopWith(out, mismatch, 'invalid-input', USAGE_EXIT_CODE)
      // 3. ベースブランチ決定（積まないときだけ、--base か設定の develop_branch を求める）
      const baseBranch = decision.kind === 'stack' ? decision.branch : resolveBaseBranch(out, { config, owner, repository, issueNumber, branch: input.branch, base: input.base })

      // 5. Issue Node ID とタイトル取得（タイトルはセッション名用）
      const { id: issueNodeId, title: issueTitle } = await client.getIssueNodeIdAndTitle(owner, repository, issueNumber)

      // 6. ベースブランチの commit SHA 取得
      let baseSha: string
      try {
        baseSha = await client.getBranchSha(owner, repository, baseBranch)
      }
      catch (error: unknown) {
        if (error instanceof GitHubAPIError && decision.kind === 'stack') {
          return stopWith(out, `base branch ${baseBranch} of ${displayReference(decision.issue, issue.repository)} not found: ${error.message}`, 'git-unresolved')
        }
        throw error
      }

      const stackedNote = decision.kind === 'stack' ? ` (stacked on ${displayReference(decision.issue, issue.repository)})` : ''
      if (input.dry_run) {
        out.planned({ verb: 'create', target: `branch ${finalBranchName} in ${owner}/${repository} from ${baseBranch}${stackedNote}` })
        out.planned({ verb: 'set', target: `Issue ${owner}/${repository}/${String(issueNumber)} status active` })
        planWorkTarget(out, owner, repository, issueNumber)
        return 0
      }
      // 7. リンクブランチ作成（ブランチ名末尾に Issue 番号を自動付与）
      const createdBranch = await client.createLinkedBranch(issueNodeId, baseSha, finalBranchName)
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
      return stopWith(out, `could not create branch ${finalBranchName} in ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
    }
  },
})

export const SESSION_START_COMMANDS: readonly CommandDefinition[] = [sessionStartCommand]
