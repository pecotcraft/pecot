// コマンド定義の一覧。CLI と MCP の両方がこの一覧から作られる。
// 各コマンドは defineCommand() で定義して COMMANDS に足す。定義の型と defineCommand は command-definition.ts にあり、ここから再公開する。
import type { CommandDefinition } from './command-definition.js'
import { BOARD_COMMANDS } from './board.js'
import { ISSUE_BOARD_COMMANDS, ISSUE_COMMANDS } from './issue.js'
import { COMMAND_GROUPS } from './names.js'
import { PR_COMMANDS } from './pr.js'
import { PROJECT_COMMANDS } from './project.js'
import { RELEASE_COMMANDS } from './release.js'
import { REPOSITORY_COMMANDS } from './repository.js'
import { SESSION_COMMANDS } from './session.js'
import { TRACKER_COMMANDS } from './tracker.js'
import { WORKTREE_COMMANDS } from './worktree.js'

export { defineCommand, toolNameOf } from './command-definition.js'
export type { CommandDefinition, CommandIo, PreparedCommand } from './command-definition.js'

// グループの中の並びは、この登録順になる
const DEFINITIONS: readonly CommandDefinition[] = [
  ...PROJECT_COMMANDS,
  ...ISSUE_BOARD_COMMANDS,
  ...BOARD_COMMANDS,
  ...ISSUE_COMMANDS,
  ...REPOSITORY_COMMANDS,
  ...SESSION_COMMANDS,
  ...PR_COMMANDS,
  ...RELEASE_COMMANDS,
  ...TRACKER_COMMANDS,
  ...WORKTREE_COMMANDS,
]

// グループの順は names.ts の COMMAND_GROUPS の順。一覧に無い 1 語目は末尾に登録順で並ぶ
function groupRank(path: readonly string[]): number {
  const rank = COMMAND_GROUPS.findIndex(group => group.name === path.at(0))
  return rank === -1 ? COMMAND_GROUPS.length : rank
}

// 1 語目のグループごとにまとめる。グループの中は登録順（toSorted は安定）
export const COMMANDS: readonly CommandDefinition[] = DEFINITIONS.toSorted((left, right) => groupRank(left.path) - groupRank(right.path))

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
