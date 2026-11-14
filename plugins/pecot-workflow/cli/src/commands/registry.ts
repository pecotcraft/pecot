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

// help の一覧と「近いコマンド」の案内に出るグループの順。ここに無い 1 語目は末尾に登録順で並ぶ
const GROUP_ORDER: readonly string[] = ['project', 'repo', 'aggregation', 'issue', 'board', 'branch', 'pr', 'session', 'release', 'security', 'dependabot', 'worktree']

const DEFINITIONS: readonly CommandDefinition[] = [
  ...PROJECT_COMMANDS,
  ...ISSUE_COMMANDS,
  ...ISSUE_BOARD_COMMANDS,
  ...BOARD_COMMANDS,
  ...REPOSITORY_COMMANDS,
  ...PR_COMMANDS,
  ...SESSION_COMMANDS,
  ...RELEASE_COMMANDS,
  ...SECURITY_COMMANDS,
  ...DEPENDABOT_COMMANDS,
  ...WORKTREE_COMMANDS,
]

function groupRank(path: readonly string[]): number {
  const rank = GROUP_ORDER.indexOf(path.at(0) ?? '')
  return rank === -1 ? GROUP_ORDER.length : rank
}

// 1 語目のグループごとにまとめる。グループの中は登録順（toSorted は安定）
export const COMMANDS: readonly CommandDefinition[] = DEFINITIONS.toSorted((left, right) => groupRank(left.path) - groupRank(right.path))

export function findCommand(path: readonly string[], commands: readonly CommandDefinition[] = COMMANDS): CommandDefinition | undefined {
  return commands.find(command => command.path.join(' ') === path.join(' '))
}
