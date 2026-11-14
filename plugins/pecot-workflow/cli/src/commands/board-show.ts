// board show。表示と Archived の整理と alert の収集は board-view.ts、着手の判定は board-readiness.ts が持つ。
import path from 'node:path'

import { z } from 'zod'

import { InvalidValueError } from '../domain/errors.js'
import { formatBoardOutput, formatStackableChains } from '../domain/format.js'
import type { BoardItem } from '../domain/format.js'
import { parseOwnerRepository } from '../domain/repository-resolver.js'
import { getActiveConfigPath } from '../infra/config-store.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import { readBoardReadiness, readinessOf, skipBoardReadiness } from './board-readiness.js'
import { boardShowJson, boardShowMarkdown, collectAlertStatuses, pruneArchivedItems, readBoard } from './board-view.js'
import { failApi } from './project-sync.js'

function mismatchNote(count: number): string {
  const subject = count === 1 ? '1 Ready or Blocked Issue may be' : `${String(count)} Ready or Blocked Issues may be`
  return `${subject} in a column or Status that does not match its judgment; run pecot board sync (--dry-run to preview) to fix`
}

const boardShowCommand = defineCommand({
  path: ['board', 'show'],
  description: 'Show the dashboard of the project board',
  input: z.strictObject({
    json: z.boolean().default(false).describe('Output as JSON'),
    repo: z.string().superRefine((value, context) => {
      try {
        parseOwnerRepository(value)
      }
      catch (error: unknown) {
        if (!(error instanceof InvalidValueError)) throw error
        context.addIssue({ code: 'custom', message: `must be in 'owner/repo' form: ${error.message}` })
      }
    }).optional().describe('Target repository, given explicitly as \'owner/repo\''),
  }),
  hasOwnRepo: true,
  positional: [],
  shortFlags: { json: '-j' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const config = requireActiveConfig(out)
    const configPath = getActiveConfigPath()
    const projectName = configPath === undefined ? `${config.host}_${config.owner}_${String(config.project.number)}` : path.parse(configPath).name
    try {
      const client = createGitHubClient(out, config.host)
      const { allItems, items, progress, isLegacy } = await readBoard(client, config, input.repo)
      const statuses = await collectAlertStatuses(client, config)
      await pruneArchivedItems(out, client, config, allItems)
      const view = { config, projectName, statuses }
      const readiness = isLegacy ? skipBoardReadiness(out) : await readBoardReadiness(out, client, config, items, input.repo, progress)
      if (readiness.mismatches > 0) out.warning(mismatchNote(readiness.mismatches))
      const json = readiness.json === undefined ? undefined : (item: BoardItem) => readinessOf(readiness, item)
      out.data(input.json
        ? boardShowJson(view, items, json)
        : boardShowMarkdown(view, input.repo, formatBoardOutput(items, readiness.texts), formatStackableChains(readiness.chains)))
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return failApi(out, 'read project board', error)
      // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
      if (error instanceof Error && !(error instanceof CommandExit)) return stopWith(out, `unexpected error: ${error.message}`)
      throw error
    }
    return 0
  },
})

export const BOARD_SHOW_COMMANDS: readonly CommandDefinition[] = [boardShowCommand]
