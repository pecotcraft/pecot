// コマンド定義の一覧。CLI と MCP の両方がこの一覧から作られる。
// コマンドは command.ts の defineCommand() で定義し、グループごとの一覧を COMMANDS に足す。
import type { CommandDefinition } from './command.js'
import { ISSUE_COMMANDS } from './issue.js'
import { SESSION_COMMANDS } from './session.js'

export { defineCommand, toolNameOf } from './command.js'
export type { CommandDefinition, CommandIo, PreparedCommand } from './command.js'

/**
移植済みのコマンド
*/
export const COMMANDS: readonly CommandDefinition[] = [...ISSUE_COMMANDS, ...SESSION_COMMANDS]

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
