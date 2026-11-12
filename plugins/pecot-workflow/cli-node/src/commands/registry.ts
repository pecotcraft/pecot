// コマンド定義の一覧。CLI と MCP の両方がこの一覧から作られる。
// 各コマンドは defineCommand() で定義して COMMANDS に足す。定義の型と defineCommand は command-definition.ts にあり、ここから再公開する。
import type { CommandDefinition } from './command-definition.js'
import { ISSUE_COMMANDS } from './issue.js'
import { PROJECT_COMMANDS } from './project.js'
import { RELEASE_COMMANDS } from './release.js'
import { REPOSITORY_COMMANDS } from './repository.js'
import { SESSION_COMMANDS } from './session.js'
import { WORKTREE_COMMANDS } from './worktree.js'

export { defineCommand, toolNameOf } from './command-definition.js'
export type { CommandDefinition, CommandIo, PreparedCommand } from './command-definition.js'

/**
移植済みのコマンド
*/
export const COMMANDS: readonly CommandDefinition[] = [
  ...REPOSITORY_COMMANDS,
  ...PROJECT_COMMANDS,
  ...ISSUE_COMMANDS,
  ...SESSION_COMMANDS,
  ...WORKTREE_COMMANDS,
  ...RELEASE_COMMANDS,
]

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
