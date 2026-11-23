// session start。Python の cli/commands/repo.py の create_branch の移植。
import { z } from 'zod'

import { findRepository, getFieldId, getOptionId, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { ReferenceParseError, parseIssueReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { repositoryFullName } from '../domain/repository-resolver.js'
import { displayReference } from '../domain/readiness.js'
import { decideStart, describeBaseMismatch } from '../domain/work-start.js'
import type { StartDecision } from '../domain/work-start.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { issuePath } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, joinHinted, surfaceText } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { fieldWriteFailure } from './field-write-failure.js'
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
    hinted`the repository of the work Issue (${owner}/${repository}) differs from the CWD git remote (${repositoryFullName(current)})\nmove to the worktree of the target repository and ${surfaceText('run again', 'call the tool again')}:\n<project-root>/base/${repository}/ or <project-root>/<wtN>/${repository}/\ncreate one with /pecot-w:w-worktree-add only if the repository has no worktree`,
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
    const withBase = commandHint(START_PATH, { issue_ref: issuePath(owner, repository, issueNumber), branch, base: 'main' })
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
7.5. プロジェクトアイテムのステータスを active にする（失敗は warning にとどめる）
*/
async function setIssueStatusActive(out: Readonly<Output>, client: Readonly<GitHubClient>, config: ProjectConfig, issue: Readonly<{ owner: string, repository: string, number: number }>): Promise<void> {
  const { owner, repository, number } = issue
  const target = `Issue ${issuePath(owner, repository, number)} status active`
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
    try {
      await client.updateProjectItemField(config.project.id, itemId, fieldId, optionId)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(fieldWriteFailure(`could not set ${target}: ${error.message}`, error, config))
      return
    }
    out.done({ verb: 'set', target })
  }
  catch (error: unknown) {
    // ブランチは作成済みなので、ステータスの失敗でコマンドは止めない
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not set ${target}: ${error.message}`)
  }
}

const SESSION_START_OUTPUT = z.strictObject({
  branch: z.string().describe('Branch created (or to be created), with the Issue number appended'),
  repository: z.string().describe('Repository of the branch (owner/repo)'),
  base: z.string().describe('Base branch the branch starts from'),
  stackedOn: z.int().optional().describe('Issue number whose branch this one is stacked on (omitted when not stacked)'),
  issue: z.string().describe('Work Issue (owner/repo/N)'),
  workDirectory: z.string().optional().describe('Absolute path of the work directory (omitted when it could not be created)'),
})

const sessionStartCommand = defineCommand({
  path: START_PATH,
  title: 'Start Issue branch',
  description: 'Create a branch linked to an Issue (shown in the Development section of the Issue)',
  input: z.strictObject({
    issue_ref: z.string().describe('Issue reference (owner/repo/123)'),
    branch: z.string().describe('Name of the branch to create'),
    base: z.string().optional().describe('Base branch (default: chosen by readiness, else develop_branch from the config)'),
    checkout: z.boolean().default(true).describe('Kept for compatibility; has no effect'),
    dry_run: z.boolean().default(false).describe('Show what would be created and recorded without writing anything'),
    project: PROJECT_INPUT,
  }),
  output: SESSION_START_OUTPUT,
  positional: ['issue_ref', 'branch'],
  shortFlags: { base: '-b', dry_run: '-n' },
  negations: { checkout: '--no-checkout' },
  interactive: false,
  run: async (input, io) => {
    requireRepositoryMatch('reject', input.repo, io, process.cwd())
    const out = createOutput<z.input<typeof SESSION_START_OUTPUT>>(input.dry_run, io)
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
    rejectCwdRepositoryMismatch(out, owner, repository)

    // 1. 設定取得（issue_ref のリポを含む設定）
    const config = requireConfigFor(out, issue.repository, input.project, ['session', 'start']).config

    const finalBranchName = `${input.branch}/${String(issueNumber)}`
    try {
      const client = createGitHubClient(out, config.host)

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
      const started = { repository: `${owner}/${repository}`, base: baseBranch, ...decision.kind === 'stack' && { stackedOn: decision.issue.number }, issue: issuePath(owner, repository, issueNumber) }
      if (input.dry_run) {
        out.result({ ...started, branch: finalBranchName })
        out.planned({ verb: 'create', target: `branch ${finalBranchName} in ${owner}/${repository} from ${baseBranch}${stackedNote}` })
        out.planned({ verb: 'set', target: `Issue ${issuePath(owner, repository, issueNumber)} status active` })
        planWorkTarget(out, issueNumber)
        return 0
      }
      // 7. リンクブランチ作成（ブランチ名末尾に Issue 番号を自動付与）
      const createdBranch = await client.createLinkedBranch(issueNodeId, baseSha, finalBranchName)
      out.done({ verb: 'create', target: `branch ${createdBranch} in ${owner}/${repository} from ${baseBranch}${stackedNote}` })
      out.result({ ...started, branch: createdBranch })

      // 7.5. プロジェクトアイテムのステータスを active に更新
      await setIssueStatusActive(out, client, config, { owner, repository, number: issueNumber })

      // 9. セッション名のキャッシュ（.pecot-session-title）と作業ディレクトリを作る
      const recorded = recordWorkTarget(out, owner, repository, issueNumber, issueTitle, {
        base: { branch: baseBranch, sha: baseSha, stackedOn: decision.kind === 'stack' ? decision.issue : undefined },
      })
      if (recorded.workDirectory !== undefined) out.result({ workDirectory: recorded.workDirectory })
      return 0
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      return stopWith(out, `could not create branch ${finalBranchName} in ${owner}/${repository}: ${error.message}`, kindOfFailure(error))
    }
  },
})

export const SESSION_START_COMMANDS: readonly CommandDefinition[] = [sessionStartCommand]
