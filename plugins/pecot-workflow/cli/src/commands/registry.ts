// コマンド定義の一覧。CLI と MCP の両方がこの一覧から作られる。
// 各コマンドは defineCommand() で定義して COMMANDS に足す。定義の型と defineCommand は command-definition.ts にあり、ここから再公開する。
import type { CommandDefinition } from './command-definition.js'
import { BOARD_COMMANDS } from './board.js'
import { DEPENDABOT_COMMANDS } from './dependabot.js'
import { ISSUE_BOARD_COMMANDS, ISSUE_COMMANDS } from './issue.js'
import { PR_COMMANDS } from './pr.js'
import { PROJECT_COMMANDS } from './project.js'
import { RELEASE_COMMANDS } from './release.js'
import { REPOSITORY_COMMANDS } from './repository.js'
import { SECURITY_COMMANDS } from './security.js'
import { SESSION_COMMANDS } from './session.js'
import { WORKTREE_COMMANDS } from './worktree.js'

export { defineCommand, toolNameOf } from './command-definition.js'
export type { CommandDefinition, CommandIo, PreparedCommand } from './command-definition.js'

// 並びは Python の登録順。help の一覧と「近いコマンド」の案内が、この順で出る
export const COMMANDS: readonly CommandDefinition[] = [
  ...ISSUE_BOARD_COMMANDS,
  ...REPOSITORY_COMMANDS,
  ...PROJECT_COMMANDS,
  ...ISSUE_COMMANDS,
  ...PR_COMMANDS,
  ...SESSION_COMMANDS,
  ...RELEASE_COMMANDS,
  ...SECURITY_COMMANDS,
  ...DEPENDABOT_COMMANDS,
  ...BOARD_COMMANDS,
  ...WORKTREE_COMMANDS,
]

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
