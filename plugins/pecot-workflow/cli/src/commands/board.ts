// board のグループのコマンド。並びは help の一覧に出る順
import { BOARD_ADD_COMMANDS } from './board-add.js'
import { BOARD_MOVE_COMMANDS } from './board-move.js'
import { BOARD_SHOW_COMMANDS } from './board-show.js'
import { BOARD_SYNC_COMMANDS } from './board-sync.js'
import type { CommandDefinition } from './command-definition.js'

export const BOARD_COMMANDS: readonly CommandDefinition[] = [
  ...BOARD_SHOW_COMMANDS,
  ...BOARD_ADD_COMMANDS,
  ...BOARD_MOVE_COMMANDS,
  ...BOARD_SYNC_COMMANDS,
]
