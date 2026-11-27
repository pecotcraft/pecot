// tracker-sync の action が起動する関数。inputs を読み、source ごとの本体に渡す。
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'

import { TRACKER_SYNC_INPUT } from './commands/tracker-sync.js'
import type { TrackerSyncInput } from './commands/tracker-sync.js'
import { runDependabotSync } from './commands/tracker-sync-dependabot.js'
import { runSecuritySync } from './commands/tracker-sync-security.js'
import { booleanInput, optionalInput, runAction } from './entry.js'

async function run(input: Readonly<TrackerSyncInput>, io: CommandIo): Promise<number> {
  return await (input.source === 'dependabot' ? runDependabotSync(input, io) : runSecuritySync(input, io))
}

export async function main(io?: CommandIo): Promise<number> {
  return await runAction({ input: TRACKER_SYNC_INPUT, run }, {
    source: optionalInput('source'),
    dry_run: booleanInput('dry-run'),
    project: optionalInput('project'),
  }, io)
}
