// board show。表示と alert の収集は board-view.ts、着手の判定は board-readiness.ts が持つ。何も書き換えない。
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
import { cliOnlyText, commandHint, hinted, inputHint, RUN } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import { readBoardReadiness, readinessOf, skipBoardReadiness } from './board-readiness.js'
import { BOARD_SHOW_OUTPUT, boardShowData, boardShowJson, boardShowMarkdown, boardShowResult, collectAlertStatuses, readBoard, warnOldFieldName } from './board-view.js'
import type { BoardShowJson } from './board-view.js'
import { failApi } from './project-sync.js'

const SYNC_PATH = ['board', 'sync']

function mismatchNote(count: number): HintedText {
  const subject = count === 1 ? '1 Ready or Blocked Issue may be' : `${String(count)} Ready or Blocked Issues may be`
  const preview = cliOnlyText(hinted` (${inputHint(SYNC_PATH, 'dry_run')} to preview)`)
  return hinted`${subject} in a column or Status that does not match its judgment; ${RUN} ${commandHint(SYNC_PATH)}${preview} to fix`
}

const boardShowCommand = defineCommand({
  path: ['board', 'show'],
  title: 'Show board dashboard',
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
  output: BOARD_SHOW_OUTPUT,
  positional: [],
  shortFlags: { json: '-j' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<BoardShowJson>(false, io)
    const config = requireActiveConfig(out)
    const configPath = getActiveConfigPath()
    const projectName = configPath === undefined ? `${config.host}_${config.owner}_${String(config.project.number)}` : path.parse(configPath).name
    try {
      const client = createGitHubClient(out, config.host)
      const read = await readBoard(client, config, input.repo)
      warnOldFieldName(out, config, read)
      const { items, progress, isLegacy } = read
      const statuses = await collectAlertStatuses(client, config)
      const view = { config, projectName, statuses }
      const readiness = isLegacy ? skipBoardReadiness(out) : await readBoardReadiness(out, client, config, items, input.repo, progress)
      if (readiness.mismatches > 0) out.warning(mismatchNote(readiness.mismatches))
      const json = readiness.json === undefined ? undefined : (item: BoardItem) => readinessOf(readiness, item)
      const data = boardShowData(view, items, json)
      out.result(boardShowResult(view, data, readiness.mismatches))
      out.data(input.json
        ? boardShowJson(data)
        : boardShowMarkdown(view, input.repo, formatBoardOutput(items, readiness.texts), formatStackableChains(readiness.chains)))
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return failApi(out, 'read project board', error)
      // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
      if (error instanceof Error && !(error instanceof CommandExit)) return stopWith(out, `unexpected error: ${error.message}`, 'other')
      throw error
    }
    return 0
  },
})

export const BOARD_SHOW_COMMANDS: readonly CommandDefinition[] = [boardShowCommand]
