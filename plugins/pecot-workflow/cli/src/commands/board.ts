// board のグループのツール。並びは tools/list に出る順
import { BOARD_CHECK_TOOLS } from './board-check.js'
import { BOARD_SHOW_TOOLS } from './board-show.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'

export const BOARD_TOOLS: readonly ToolDefinition[] = [
  ...BOARD_SHOW_TOOLS,
  ...BOARD_CHECK_TOOLS,
]
