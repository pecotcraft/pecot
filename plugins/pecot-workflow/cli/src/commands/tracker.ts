// `pecot tracker sync <source>`。source ごとの本体（dependabot.ts・security.ts）を呼び分ける。
import { z } from 'zod'

import { defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { runDependabotSync } from './tracker-sync-dependabot.js'
import { runSecuritySync } from './tracker-sync-security.js'

const syncCommand = defineCommand({
  path: ['tracker', 'sync'],
  description: 'Rewrite the open Tracker\'s list for a source: Dependabot PRs waiting for a human decision, or open security alerts',
  input: z.strictObject({
    source: z.enum(['dependabot', 'security']).describe('What to put into the Tracker: dependabot (Dependabot PRs waiting for a human decision) or security (open security alerts)'),
    dry_run: z.boolean().default(false).describe('Show the planned Tracker changes without changing anything'),
  }),
  positional: ['source'],
  interactive: false,
  run: async (input, io) => await (input.source === 'dependabot' ? runDependabotSync(input, io) : runSecuritySync(input, io)),
})

export const TRACKER_COMMANDS: readonly CommandDefinition[] = [syncCommand]
