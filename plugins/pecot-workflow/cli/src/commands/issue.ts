// issue のグループのコマンド。並びは help の一覧に出る順
import type { CommandDefinition } from './command-definition.js'
import { ISSUE_COMMENT_COMMANDS } from './issue-comment.js'
import { ISSUE_CREATE_COMMANDS } from './issue-create.js'
import { ISSUE_DEPENDENCY_COMMANDS } from './issue-dependency.js'
import { ISSUE_QUICK_COMMANDS } from './issue-quick.js'
import { ISSUE_REOPEN_COMMANDS } from './issue-reopen.js'
import { ISSUE_SHOW_COMMANDS } from './issue-show.js'

export const ISSUE_COMMANDS: readonly CommandDefinition[] = [
  ...ISSUE_CREATE_COMMANDS,
  ...ISSUE_QUICK_COMMANDS,
  ...ISSUE_SHOW_COMMANDS,
  ...ISSUE_COMMENT_COMMANDS,
  ...ISSUE_DEPENDENCY_COMMANDS,
  ...ISSUE_REOPEN_COMMANDS,
]
