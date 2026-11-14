// issue のグループと、Issue をボードで動かすコマンド（board add・board move）の一覧。
import type { CommandDefinition } from './command-definition.js'
import { ISSUE_COMMENT_COMMANDS } from './issue-comment.js'
import { ISSUE_CREATE_COMMANDS } from './issue-create.js'
import { ISSUE_DEPENDENCY_COMMANDS } from './issue-dependency.js'
import { ISSUE_QUICK_COMMANDS } from './issue-quick.js'
import { ISSUE_PROJECT_COMMANDS } from './issue-project.js'
import { ISSUE_READ_COMMANDS } from './issue-read.js'

// issue-project.ts は board のグループと issue のグループのコマンドを持つ。1 語目で振り分ける
export const ISSUE_BOARD_COMMANDS: readonly CommandDefinition[] = ISSUE_PROJECT_COMMANDS.filter(command => command.path.at(0) === 'board')

// 並びは help の一覧に出る順
export const ISSUE_COMMANDS: readonly CommandDefinition[] = [
  ...ISSUE_CREATE_COMMANDS,
  ...ISSUE_QUICK_COMMANDS,
  ...ISSUE_READ_COMMANDS,
  ...ISSUE_COMMENT_COMMANDS,
  ...ISSUE_DEPENDENCY_COMMANDS,
  ...ISSUE_PROJECT_COMMANDS.filter(command => command.path.at(0) === 'issue'),
]
