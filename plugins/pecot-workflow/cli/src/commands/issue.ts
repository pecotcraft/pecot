// issue のグループのツール。並びは tools/list に出る順
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { ISSUE_CHECK_TOOLS } from './issue-check.js'
import { ISSUE_COMMENT_CHECK_TOOLS } from './issue-comment-check.js'
import { ISSUE_DEPENDENCY_CHECK_TOOLS } from './issue-dependency-check.js'

export const ISSUE_TOOLS: readonly ToolDefinition[] = [
  ...ISSUE_CHECK_TOOLS,
  ...ISSUE_DEPENDENCY_CHECK_TOOLS,
  ...ISSUE_COMMENT_CHECK_TOOLS,
]
