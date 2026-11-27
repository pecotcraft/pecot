// issue のグループのツール。並びは tools/list に出る順
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { ISSUE_ATTRIBUTES_TOOLS } from './issue-attributes.js'
import { ISSUE_CHECK_TOOLS } from './issue-check.js'
import { ISSUE_COMMENT_TOOLS } from './issue-comment.js'
import { ISSUE_CREATE_TOOLS } from './issue-create.js'
import { ISSUE_DEPENDENCY_TOOLS } from './issue-dependency.js'
import { ISSUE_EDIT_TOOLS } from './issue-edit.js'
import { ISSUE_REOPEN_TOOLS } from './issue-reopen.js'
import { ISSUE_SHOW_TOOLS } from './issue-show.js'

export const ISSUE_TOOLS: readonly ToolDefinition[] = [
  ...ISSUE_CREATE_TOOLS,
  ...ISSUE_CHECK_TOOLS,
  ...ISSUE_SHOW_TOOLS,
  ...ISSUE_ATTRIBUTES_TOOLS,
  ...ISSUE_EDIT_TOOLS,
  ...ISSUE_COMMENT_TOOLS,
  ...ISSUE_DEPENDENCY_TOOLS,
  ...ISSUE_REOPEN_TOOLS,
]
