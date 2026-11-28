// session_show。ブランチ・remote・作業の Issue・スタックの記録・比べる base・worktree を手元で読む。GitHub を読まない
import path from 'node:path'

import { z } from 'zod'

import { getDevelopBranch } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { RemoteLocation } from '@pecot/workflow-core/domain/git-url.js'
import { pythonStrip } from '@pecot/workflow-core/domain/python-format.js'
import { issueReferenceToCliReference, issueReferenceToString } from '@pecot/workflow-core/domain/reference-parser.js'
import type { BaseReading } from '@pecot/workflow-core/domain/state.js'
import { configLookupFailure, findConfigFor } from '@pecot/workflow-core/infra/config-store.js'
import { activeIssueOf, gitCurrentBranch, gitStdout, gitToplevel, primaryRemoteName, primaryRemoteRepository, remoteBranchHead, runGit } from '@pecot/workflow-core/infra/git.js'
import { resolveRealPath } from '@pecot/workflow-core/infra/paths.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition, CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { joinHinted } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { readBaseRecordAt } from '../infra/state-store.js'
import { directorySchema } from './directory-option.js'
import { SESSION_FINISH_TOOLS } from './session-finish.js'
import { SESSION_START_TOOLS } from './session-start.js'

const SHOW_PATH = ['session', 'show']

const ACTIVE_ISSUE_DATA = z.strictObject({
  reference: z.string().describe('Work Issue found from the git remote and the number that ends the branch name (owner/repo/N, the form issue_ref takes)'),
})

const STACK_DATA = z.strictObject({
  branch: z.string().describe('Base branch the work branch is stacked on'),
  stackedOn: z.string().describe('Issue stacked on (owner/repo/N)'),
  sha: z.string().describe('Commit of the base branch the work started from'),
})

const WORKTREE_DATA = z.strictObject({
  list: z.string().describe('Output of git worktree list'),
  directoryName: z.string().describe('Name of the current directory'),
  isWorktree: z.boolean().optional().describe('Whether the directory is a linked worktree (omitted when it could not be determined)'),
})

const SESSION_SHOW_OUTPUT = z.strictObject({
  branch: z.string().optional().describe('Current branch (omitted when it cannot be read)'),
  repository: z.string().optional().describe('Repository of the git remote (owner/repo; omitted when it cannot be read)'),
  activeIssue: ACTIVE_ISSUE_DATA.optional().describe('Work Issue of the session (omitted when there is none)'),
  stack: STACK_DATA.optional().describe('Base the work was stacked on, from .pecot-base (omitted when not stacked)'),
  baseBranch: z.string().optional().describe('Remote branch to compare the work against (remote/branch): the stack branch while it is on the remote, else the develop branch (omitted when it cannot be decided)'),
  worktree: WORKTREE_DATA.describe('Worktree information'),
})

type SessionShowData = z.input<typeof SESSION_SHOW_OUTPUT>

function hasBranch(branch: string, cwd: string): boolean {
  return runGit(['rev-parse', '--verify', branch], { cwd }).exitCode === 0
}

// 親ブランチがマージで消えた後は、開発ブランチと比べる。追跡参照は fetch --prune まで残るので remote に尋ね、
// 無いと答えたときだけ消えたとみなす。届かないか時間切れなら追跡参照で決める
async function isOnRemote(branch: string, cwd: string, remote: string, out: Readonly<Output>): Promise<boolean> {
  const head = await remoteBranchHead(cwd, remote, branch, out.signal)
  if (head.isReachable && head.sha === undefined) return false
  const isTracked = hasBranch(`${remote}/${branch}`, cwd)
  if (!isTracked && head.isReachable) out.warning(`base branch ${branch} is on ${remote}, but ${remote}/${branch} is not fetched; compared with the develop branch\nrun: git fetch ${remote} ${branch}`)
  return isTracked
}

function configOf(location: Readonly<RemoteLocation>, project: string | undefined, out: Readonly<Output>): ProjectConfig | undefined {
  const repository = { owner: location.owner, repository: location.repository }
  const lookup = findConfigFor(repository, project)
  if (lookup.kind === 'found') return lookup.found.config
  out.warning(joinHinted(['baseBranch is not decided: ', configLookupFailure(lookup, repository, SHOW_PATH).message], ''))
  return undefined
}

async function baseBranchOf(reading: BaseReading, location: Readonly<RemoteLocation>, cwd: string, project: string | undefined, out: Readonly<Output>): Promise<string | undefined> {
  const remote = primaryRemoteName(cwd)
  if (remote === undefined) return undefined
  if (reading.kind === 'stacked' && await isOnRemote(reading.record.branch, cwd, remote, out)) return `${remote}/${reading.record.branch}`
  const config = configOf(location, project, out)
  if (config === undefined) return undefined
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    out.warning(`baseBranch is not decided: develop_branch is not set for ${location.owner}/${location.repository}`)
    return undefined
  }
  const branchName = `${remote}/${developBranch}`
  if (hasBranch(branchName, cwd)) return branchName
  out.warning(`baseBranch is not decided: branch ${branchName} does not exist\ncheck the remote branches with: git branch -r`)
  return undefined
}

function readWorktreeInfo(cwd: string): SessionShowData['worktree'] {
  const listed = gitStdout(['worktree', 'list'], { cwd })
  const list = listed === undefined ? '(git worktree list failed)' : pythonStrip(listed)
  const directoryName = path.basename(cwd)
  const gitDirectory = gitStdout(['rev-parse', '--git-dir'], { cwd })
  const commonDirectory = gitDirectory === undefined ? undefined : gitStdout(['rev-parse', '--git-common-dir'], { cwd })
  if (gitDirectory === undefined || commonDirectory === undefined) return { list, directoryName }
  const isWorktree = resolveRealPath(path.resolve(cwd, pythonStrip(gitDirectory))) !== resolveRealPath(path.resolve(cwd, pythonStrip(commonDirectory)))
  return { list, directoryName, isWorktree }
}

function readStack(directory: string, out: Readonly<Output>): BaseReading {
  const toplevel = gitToplevel({ cwd: directory })
  if (toplevel === undefined) return { kind: 'development', record: undefined }
  const reading = readBaseRecordAt(toplevel)
  if (reading.kind === 'malformed') out.warning(`.pecot-base is malformed: ${reading.content}`)
  return reading
}

const SESSION_SHOW = defineTool({
  name: 'session_show',
  title: 'Show session',
  description: 'Show the branch, repository, work Issue, stack record, the base branch to compare against and the worktree of the session. Reads nothing on GitHub; read the Issue and the PRs stacked above with the official GitHub MCP',
  input: z.object({ directory: directorySchema, project: PROJECT_INPUT }),
  output: SESSION_SHOW_OUTPUT,
  run: async (input, io: CommandIo) => {
    const output = createOutput<SessionShowData>(false, io)
    const branch = gitCurrentBranch(input.directory)
    const origin = primaryRemoteRepository(input.directory)
    const active = activeIssueOf(input.directory)
    const reading = readStack(input.directory, output)
    const baseBranch = origin === undefined ? undefined : await baseBranchOf(reading, origin, input.directory, input.project, output)
    const worktree = readWorktreeInfo(input.directory)
    const stack = reading.kind === 'stacked' ? { branch: reading.record.branch, stackedOn: issueReferenceToCliReference(reading.stackedOn), sha: reading.record.sha } : undefined
    output.result({
      ...branch !== undefined && { branch },
      ...origin !== undefined && { repository: `${origin.owner}/${origin.repository}` },
      ...active !== undefined && { activeIssue: { reference: issueReferenceToCliReference(active) } },
      ...stack !== undefined && { stack },
      ...baseBranch !== undefined && { baseBranch },
      worktree,
    })

    const lines = [
      '# Session status',
      '',
      `- Branch: ${branch ?? 'unknown'}`,
      `- Repository: ${origin === undefined ? 'unknown' : `${origin.owner}/${origin.repository}`}`,
      `- Active Issue: ${active === undefined ? 'none' : issueReferenceToString(active)}`,
      `- Base branch: ${baseBranch ?? 'unknown'}`,
      `- Directory: ${worktree.directoryName}${worktree.isWorktree === true ? ' (worktree)' : ''}`,
      ...stack === undefined ? [] : ['', '## Stack', `- branch: ${stack.branch}`, `- stacked on: ${stack.stackedOn}`, `- sha: ${stack.sha}`],
    ]
    output.data(lines.join('\n'))
    return 0
  },
})

/**
session のグループのコマンド。start は session-start.ts、finish は session-finish.ts にある。並びは tools/list に出る順
*/
export const SESSION_TOOLS: readonly ToolDefinition[] = [...SESSION_START_TOOLS, SESSION_SHOW, ...SESSION_FINISH_TOOLS]
