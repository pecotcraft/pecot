// session-finish。マージの後の GitHub 側の片付けだけを行う。ブランチは消さない（FR-018）。
import { z } from 'zod'

import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { requireConfigFor } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { parseReference } from '@pecot/workflow-core/commands-shared/pr-reference.js'
import { finishOnGithub, requireMergedPullRequest } from '@pecot/workflow-core/commands-shared/session-finish-remote.js'

export const SESSION_FINISH_INPUT = z.strictObject({
  pr_ref: z.string(),
  project: z.string().optional(),
  dry_run: z.boolean().default(false),
})

/**
マージ済みの PR が閉じる Issue を閉じ、それを待つ Issue の列と札を動かす。個々の失敗は warning にとどめ、0 を返す
*/
export async function runSessionFinish(input: Readonly<z.output<typeof SESSION_FINISH_INPUT>>, io: CommandIo): Promise<number> {
  const out = createOutput(input.dry_run, io)
  const reference = parseReference(input.pr_ref, undefined, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }
  const { config } = requireConfigFor(out, location, input.project, ['session', 'finish'])
  const merged = await requireMergedPullRequest(out, config, reference)
  await finishOnGithub({ out, isDryRun: input.dry_run, record: { closedIssues: [], skippedIssues: [], readinessChanges: [], restack: [] } }, config, merged)
  return 0
}
