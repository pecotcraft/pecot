// issue のグループと、Issue をボードで動かすコマンドの一覧。
import type { CommandDefinition } from './command.js'
import { ISSUE_COMMENT_COMMANDS } from './issue-comment.js'
import { ISSUE_CREATE_COMMANDS } from './issue-create.js'
import { ISSUE_QUICK_COMMANDS } from './issue-quick.js'
import { ISSUE_PROJECT_COMMANDS } from './issue-project.js'
import { ISSUE_READ_COMMANDS } from './issue-read.js'

export const ISSUE_COMMANDS: readonly CommandDefinition[] = [
  ...ISSUE_PROJECT_COMMANDS,
  ...ISSUE_CREATE_COMMANDS,
  ...ISSUE_QUICK_COMMANDS,
  ...ISSUE_READ_COMMANDS,
  ...ISSUE_COMMENT_COMMANDS,
]
