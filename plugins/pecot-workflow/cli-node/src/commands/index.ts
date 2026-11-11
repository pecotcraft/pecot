// 移植済みのコマンドの一覧。CLI と MCP の両方がこの一覧から作られる。
// 新しいコマンドは、コマンドのファイルで defineCommand() した定義を import して COMMANDS に足す。
import type { CommandDefinition } from './registry.js'
import { RELEASE_COMMANDS } from './release.js'
import { WORKTREE_COMMANDS } from './worktree.js'

export const COMMANDS: readonly CommandDefinition[] = [...RELEASE_COMMANDS, ...WORKTREE_COMMANDS]

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
