// pecot がボードに求める欄と選択肢の定義。GitHub を読み書きしないチェックからも読む
import type { OptionPlacement } from '../domain/field-options.js'
import type { ProjectFieldOption } from '../infra/github/projects.js'

/**
選択肢の定義。isOptional は無くても同期を止めない。placement は足すときの差し込み先の候補（先から使い、無ければ末尾）
*/
export interface OptionSpec {
  readonly option: ProjectFieldOption
  readonly isOptional?: true
  readonly placement?: readonly OptionPlacement[]
}

/**
前提を待つ Issue を pecot が置く列
*/
const BLOCKED_SPEC: OptionSpec = {
  option: { name: 'Blocked', color: 'GRAY', description: 'Tasks waiting for prerequisite Issues. pecot moves them to Ready once they can start.' },
  isOptional: true,
  placement: [{ after: 'Backlog' }, { before: 'Ready' }],
}

/**
人の判断を待つ Issue の札。既定の Status の末尾に足す
*/
export const NEEDS_ATTENTION_SPEC: OptionSpec = {
  option: { name: 'Needs Attention', color: 'RED', description: 'Waiting for a human decision or action.' },
  isOptional: true,
}

/**
既定の Status のフィールド名
*/
export const STATUS_FIELD_NAME = 'Status'

/**
workflow フィールドの選択肢の定義。作る順でもある
*/
export const WORKFLOW_FIELD_SPECS: readonly OptionSpec[] = [
  { option: { name: 'Pending', color: 'GRAY', description: 'Items on hold (Epic or Task). Moved here from Ready or Backlog when deprioritized.' } },
  { option: { name: 'Backlog', color: 'RED', description: 'Items waiting to be planned. Not for direct work - break down into smaller tasks first.' } },
  BLOCKED_SPEC,
  { option: { name: 'Ready', color: 'GREEN', description: 'Tasks ready for implementation. AI agent picks from here and moves to Active on start.' } },
  { option: { name: 'Active', color: 'BLUE', description: 'Currently being worked on. One active task per worktree - track progress and updates here.' } },
  { option: { name: 'In Review', color: 'YELLOW', description: 'Pull request created and waiting for review. Moves to Archived after merge is completed.' } },
  { option: { name: 'Archived', color: 'PURPLE', description: 'Completed or cancelled items. Moved here after the issue is closed or no longer needed.' } },
]

/**
pecot が使わない欄。project_check の fields が deletable に挙げる
*/
export const UNUSED_FIELD_NAMES: readonly string[] = ['pecot-priority', 'pecot-size']
