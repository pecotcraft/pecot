// branch のグループのツール。並びは tools/list に出る順
import { BRANCH_CHECK_TOOLS } from './branch-check.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'

export const BRANCH_TOOLS: readonly ToolDefinition[] = [...BRANCH_CHECK_TOOLS]
