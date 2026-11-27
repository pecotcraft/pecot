// MCP のツールの一覧。各ツールは defineTool() で定義して、グループのファイルの一覧に足す。
import { BOARD_TOOLS } from './board.js'
import { BRANCH_TOOLS } from './branch.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { registerToolHints } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { ISSUE_TOOLS } from './issue.js'
import { PR_RESTACK_TOOLS } from './pr-restack.js'
import { PR_TOOLS } from './pr.js'
import { PROJECT_TOOLS } from './project.js'
import { RELEASE_TOOLS } from './release.js'
import { SESSION_TOOLS } from './session.js'
import { WORKTREE_TOOLS } from './worktree.js'
import { WORKFLOW_TOOLS } from './workflow.js'

export { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
export type { CommandIo, PreparedCommand, ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'

// 並びは tools/list の順で、names.ts の COMMAND_GROUPS の順に合わせる
export const TOOLS: readonly ToolDefinition[] = [
  ...PROJECT_TOOLS,
  ...BOARD_TOOLS,
  ...ISSUE_TOOLS,
  ...SESSION_TOOLS,
  ...PR_TOOLS,
  ...PR_RESTACK_TOOLS,
  ...RELEASE_TOOLS,
  ...WORKTREE_TOOLS,
  ...BRANCH_TOOLS,
  ...WORKFLOW_TOOLS,
]

registerToolHints(TOOLS)
