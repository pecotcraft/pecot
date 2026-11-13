// issue のグループと、Issue をボードで動かすコマンドの一覧。
import type { CommandDefinition } from './command-definition.js'
import { ISSUE_COMMENT_COMMANDS } from './issue-comment.js'
import { ISSUE_CREATE_COMMANDS } from './issue-create.js'
import { ISSUE_DEPENDENCY_COMMANDS } from './issue-dependency.js'
import { ISSUE_QUICK_COMMANDS } from './issue-quick.js'
import { ISSUE_PROJECT_COMMANDS } from './issue-project.js'
import { ISSUE_READ_COMMANDS } from './issue-read.js'

// 並びは Python の登録順（help の一覧に出る順）にそろえる
export const ISSUE_BOARD_COMMANDS: readonly CommandDefinition[] = ISSUE_PROJECT_COMMANDS.filter(command => command.path.length === 1)

export const ISSUE_COMMANDS: readonly CommandDefinition[] = [
  ...ISSUE_CREATE_COMMANDS,
  ...ISSUE_QUICK_COMMANDS,
  ...ISSUE_READ_COMMANDS,
  ...ISSUE_COMMENT_COMMANDS,
  ...ISSUE_DEPENDENCY_COMMANDS,
  ...ISSUE_PROJECT_COMMANDS.filter(command => command.path.length !== 1),
]
