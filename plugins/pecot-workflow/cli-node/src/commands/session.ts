// session status・session restore。cli/commands/session.py の移植。
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { ConfigError } from '../domain/config.js'
import { PecotError } from '../domain/errors.js'
import { parseIssueReference, ReferenceParseError } from '../domain/reference-parser.js'
import { FLAG_PECOT_ACTIVE } from '../domain/state.js'
import { pythonStringRepr } from '../domain/python-format.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitCurrentBranch, primaryRemoteRepository } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { hasFlag, readFlag } from '../infra/state-store.js'
import { defineCommand } from './command.js'
import type { CommandDefinition, CommandIo } from './command.js'
import { FAILURE_EXIT_CODE } from './failure.js'
import { createClient, runWithExit, throwExit } from './issue-shared.js'
import { createOutput } from './output.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE } from './usage-error.js'
import { recordWorkTarget } from './work-target.js'

const ALL_FLAGS: readonly string[] = [FLAG_PECOT_ACTIVE]

const DIRECTORY_DESCRIPTION = 'Target Git repository (absolute or relative path)'

// click の Path(exists=True, file_okay=False) と同じ順の確認（存在・ファイル・読める）。誤りの文も click と同じ
function directoryProblem(value: string): string | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者が渡したパスを確かめる
    if (!statSync(value).isDirectory()) return 'is a file'
  }
  catch {
    return 'does not exist'
  }
  try {
    accessSync(value, constants.R_OK)
  }
  catch {
    return 'is not readable'
  }
  return undefined
}

const directorySchema = z.string().describe(DIRECTORY_DESCRIPTION).superRefine((value, context) => {
  const problem = directoryProblem(value)
  if (problem !== undefined) context.addIssue({ code: 'custom', message: `Directory ${pythonStringRepr(value)} ${problem}.` })
})

interface FlagStatus {
  readonly name: string
  readonly isSet: boolean
  readonly content: string
}

function collectFlagStatuses(): FlagStatus[] {
  return ALL_FLAGS.map((name) => {
    const isSet = hasFlag(name)
    return { name, isSet, content: isSet ? readFlag(name) ?? '' : '' }
  })
}

// .pecot-active の Issue を GitHub から読んで、Markdown の行にする。読めなければ warning だけ出して空にする
async function activeIssueLines(statuses: readonly FlagStatus[], output: Output): Promise<string[]> {
  const active = statuses.find(status => status.name === FLAG_PECOT_ACTIVE && status.isSet && status.content !== '')
  if (active === undefined) return []

  let reference
  try {
    reference = parseIssueReference(active.content)
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return []
    throw error
  }

  let issue
  try {
    const config = loadActiveConfig()
    if (config === undefined) {
      output.warning('cannot read the active Issue: no active project')
      return []
    }
    issue = await createClient(config, output).getIssueSlim(reference.repository.owner, reference.repository.repository, reference.number, 0)
  }
  catch (error: unknown) {
    if (error instanceof ConfigError || error instanceof GitHubAPIError) {
      output.warning(`cannot read the active Issue: ${error.message}`)
      return []
    }
    throw error
  }

  const lines = ['', '## Active Issue', '', `#${String(issue.number)} ${issue.title} (${issue.state})`]
  if (issue.body !== '') lines.push('', issue.body)
  return lines
}

const STATUS = defineCommand({
  path: ['session', 'status'],
  description: 'Show the session flag state, branch information, and inferred Issue',
  input: z.object({ directory: directorySchema }),
  positional: [],
  shortFlags: { directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    const directory = path.resolve(input.directory)
    const branch = gitCurrentBranch(directory)
    const origin = primaryRemoteRepository(directory)
    const issueNumber = branch === undefined ? undefined : extractIssueNumberFromBranch(branch)
    const statuses = collectFlagStatuses()

    const lines = [
      '# Session status',
      '',
      `- Branch: ${branch ?? 'unknown'}`,
      `- Repository: ${origin === undefined ? 'unknown' : `${origin.owner}/${origin.repository}`}`,
      `- Inferred Issue: ${issueNumber === undefined ? 'none' : `#${String(issueNumber)}`}`,
      '',
      '| Flag | State | Content |',
      '|------|-------|---------|',
      ...statuses.map(status => `| ${status.name} | ${status.isSet ? 'set' : 'unset'} | ${status.content} |`),
      ...await activeIssueLines(statuses, output),
    ]
    output.data(lines.join('\n'))
    return 0
  },
})

// セッション名に添える題名。設定が無いか API が失敗したときだけ空にする。設定が読めないなら ConfigError を伝える
async function fetchIssueTitle(owner: string, repository: string, number: number, output: Output): Promise<string> {
  try {
    const config = loadActiveConfig()
    if (config === undefined) return ''
    const issue = await createClient(config, output).getIssueSlim(owner, repository, number, 0)
    return issue.title
  }
  catch (error: unknown) {
    if (error instanceof ConfigError) throw error
    if (error instanceof PecotError) return ''
    throw error
  }
}

interface RestoreTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

// --issue が無いときの、ブランチ名と remote からの推定。決められなければ error を出して終了コード 1
function inferTarget(directory: string, output: Output): RestoreTarget {
  const branch = gitCurrentBranch(directory)
  if (branch === undefined) {
    output.error('cannot read the branch name')
    return throwExit(FAILURE_EXIT_CODE)
  }
  const number = extractIssueNumberFromBranch(branch)
  if (number === undefined) {
    output.error(`cannot infer the Issue number from the branch name: ${branch}\nrun: pecot session restore --issue <owner/repo/N>`)
    return throwExit(FAILURE_EXIT_CODE)
  }
  const origin = primaryRemoteRepository(directory)
  if (origin === undefined) {
    output.error('cannot read the repository information')
    return throwExit(FAILURE_EXIT_CODE)
  }
  return { owner: origin.owner, repository: origin.repository, number }
}

// --issue の参照を分ける。形が誤っていれば error を出して終了コード 2
function parseTarget(issue: string, output: Output): RestoreTarget {
  try {
    const reference = parseIssueReference(issue)
    return { owner: reference.repository.owner, repository: reference.repository.repository, number: reference.number }
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    output.error(error.message)
    return throwExit(USAGE_EXIT_CODE)
  }
}

const RESTORE = defineCommand({
  path: ['session', 'restore'],
  description: 'Restore lost session flags (such as .pecot-active) from the branch information',
  input: z.object({
    issue: z.string().optional().describe('Issue reference (owner/repo/number)'),
    directory: directorySchema,
  }),
  positional: [],
  shortFlags: { issue: '-i', directory: '-D' },
  interactive: false,
  run: async (input, io: CommandIo) => {
    const output = createOutput(false, io)
    return await runWithExit(async () => {
      const target = input.issue === undefined ? inferTarget(path.resolve(input.directory), output) : parseTarget(input.issue, output)
      let title: string
      try {
        title = await fetchIssueTitle(target.owner, target.repository, target.number, output)
      }
      catch (error: unknown) {
        if (!(error instanceof ConfigError)) throw error
        output.error(error.message)
        return throwExit(FAILURE_EXIT_CODE)
      }
      const code = recordWorkTarget(output, target.owner, target.repository, target.number, title, { failWithExit: true })
      if (code !== undefined) throwExit(code)
    })
  },
})

export const SESSION_COMMANDS: readonly CommandDefinition[] = [STATUS, RESTORE]
