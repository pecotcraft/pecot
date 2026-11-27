// board のグループのツール。並びは tools/list に出る順
import { BOARD_ADD_TOOLS } from './board-add.js'
import { BOARD_MOVE_TOOLS } from './board-move.js'
import { BOARD_SHOW_TOOLS } from './board-show.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'

export const BOARD_TOOLS: readonly ToolDefinition[] = [
  ...BOARD_SHOW_TOOLS,
  ...BOARD_ADD_TOOLS,
  ...BOARD_MOVE_TOOLS,
]
