// 案内（domain/command-hint.ts）が名指しできるツールの形。actions/ は pecot-workflow の registry を持たないので、ここから登録する。
// TOOL_HINT_COMMANDS と registry の一致は cli の registry.test.ts が確かめる。ACTION_HINT_COMMANDS と action.yml の一致は actions のテストが確かめる。
import { registerHintCommands } from '../domain/command-hint.js'
import type { HintCommandShape } from '../domain/command-hint.js'

/**
pecot-workflow の MCP のサーバの registry.ts が登録するツールの形。並びは registry と同じ
*/
export const TOOL_HINT_COMMANDS: readonly HintCommandShape[] = [
  { name: 'project_list', inputs: ['repo'] },
  { name: 'project_check', inputs: ['method', 'owner', 'owner_type', 'title', 'project', 'changes', 'lanes', 'reads', 'repo'] },
  { name: 'project_activate', inputs: ['project', 'owner', 'owner_type', 'host', 'reads', 'repo'] },
  { name: 'project_link', inputs: ['repo', 'develop_branch', 'release_branch', 'changelog_file', 'package', 'clear_packages', 'release_type'] },
  { name: 'project_get', inputs: ['key', 'repo'] },
  { name: 'project_set', inputs: ['key', 'value', 'yes', 'repo'] },
  { name: 'project_unset', inputs: ['key', 'repo'] },
  { name: 'board_show', inputs: ['json', 'repo', 'reads'] },
  { name: 'board_check', inputs: ['method', 'owner', 'project_number', 'issue_number', 'item_owner', 'item_repo', 'updated_field', 'project', 'reads', 'repo'] },
  { name: 'issue_check', inputs: ['method', 'project', 'issues', 'reads', 'repo'] },
  { name: 'issue_dependency_check', inputs: ['method', 'owner', 'repo', 'issue_number', 'type', 'related_owner', 'related_repo', 'related_issue_number', 'wait', 'reason', 'project', 'reads'] },
  { name: 'issue_comment_check', inputs: ['method', 'owner', 'repo', 'issue_number', 'comment_id', 'body', 'template', 'template_text', 'reads'] },
  { name: 'session_start', inputs: ['issue_ref', 'base', 'sha', 'stacked_on', 'title', 'reads', 'repo'] },
  { name: 'session_show', inputs: ['directory', 'project', 'repo'] },
  { name: 'session_finish', inputs: ['pr_ref', 'project', 'reads', 'repo'] },
  { name: 'pr_check', inputs: ['method', 'owner', 'repo', 'title', 'head', 'base', 'draft', 'body', 'pullNumber', 'merge_method', 'expectedHeadSha', 'template', 'template_text', 'screenshot', 'project', 'reads'] },
  { name: 'pr_restack', inputs: ['check', 'continue', 'abort', 'project', 'reads', 'repo'] },
  { name: 'release_check', inputs: ['params', 'project', 'reads', 'repo'] },
  { name: 'worktree_add', inputs: ['directory', 'base', 'path', 'no_copy', 'no_link', 'setup', 'allow_existing_branch', 'project', 'repo'] },
  { name: 'worktree_remove', inputs: ['name', 'directory', 'force', 'keep_branch', 'repo'] },
  { name: 'worktree_init', inputs: ['directory', 'repo'] },
  { name: 'worktree_link', inputs: ['directory', 'force', 'all', 'repo'] },
  { name: 'branch_check', inputs: ['owner', 'repo', 'issue', 'branch', 'base', 'project', 'reads'] },
  { name: 'workflow_install', inputs: ['name', 'check', 'force', 'directory', 'reads', 'repo'] },
  { name: 'workflow_doctor', inputs: ['name', 'directory', 'reads', 'repo'] },
]

/**
actions/ に移した処理の形。name の `_` を `-` にしたものが actions/<name>/action.yml、inputs は token を除く inputs を snake_case にしたもの
*/
export const ACTION_HINT_COMMANDS: readonly HintCommandShape[] = [
  { name: 'board_sync', inputs: ['project', 'dry_run'] },
  { name: 'review_finish', inputs: ['pr', 'job_status', 'execution_file', 'since', 'review_outcome', 'review_conclusion', 'review_has_token'] },
  { name: 'tracker_sync', inputs: ['source', 'surface_file', 'project', 'dry_run'] },
  { name: 'auto_gate', inputs: ['max_ci_attempts', 'project'] },
  { name: 'auto_start', inputs: ['issue', 'project'] },
  { name: 'auto_finish', inputs: ['issue', 'project', 'result_file', 'job_status', 'execution_file', 'start_outcome', 'result', 'body_file'] },
]

/**
ツールと actions/ の両方の形を、案内の描き方に登録する。actions/ の処理は、案内を描く前にこれを呼ぶ
*/
export function registerHintCatalog(): void {
  registerHintCommands([...TOOL_HINT_COMMANDS, ...ACTION_HINT_COMMANDS])
}
