// tracker-sync の action が起動する関数。inputs を読み、source ごとの本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { TRACKER_SYNC_INPUT } from './commands/tracker-sync.js'
import type { TrackerSyncInput } from './commands/tracker-sync.js'
import { runDependabotSync } from './commands/tracker-sync-dependabot.js'
import { runIssueSurfaceSync } from './commands/tracker-sync-issue-surface.js'
import { runSecuritySync } from './commands/tracker-sync-security.js'
import { booleanInput, optionalInput, runAction } from './entry.js'

async function run(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<number> {
  switch (input.source) {
    case 'dependabot': {
      return await runDependabotSync(input, io)
    }
    case 'security': {
      return await runSecuritySync(input, io)
    }
    case 'issue-surface': {
      return await runIssueSurfaceSync(input, io)
    }
  }
}

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: TRACKER_SYNC_INPUT, run }, {
    source: optionalInput('source'),
    dry_run: booleanInput('dry-run'),
    project: optionalInput('project'),
    surface_file: optionalInput('surface-file'),
  }, io)
}
