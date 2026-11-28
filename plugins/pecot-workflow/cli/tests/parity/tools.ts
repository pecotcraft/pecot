// 前後比較の対象にする 9 個のツールの名前。src/commands/registry.ts の TOOLS から、公式の MCP の読み取りを reads で受けるツールを除いたもの。
// シナリオの tool の集合がこの一覧と一致することを scenario.test.ts が確かめる。
export const TOOL_NAMES: readonly string[] = [
  'project_list',
  'project_get',
  'project_set',
  'project_unset',
  'session_show',
  'worktree_add',
  'worktree_remove',
  'worktree_init',
  'worktree_link',
]
