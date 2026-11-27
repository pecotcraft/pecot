// 案内（domain/command-hint.ts）が名指しできるツールの形。actions/ は pecot-workflow の registry を持たないので、ここから登録する。
// TOOL_HINT_COMMANDS と registry の一致は cli の registry.test.ts が確かめる。ACTION_HINT_COMMANDS と action.yml の一致は actions のテストが確かめる。
import { registerHintCommands } from '../domain/command-hint.js'
import type { HintCommandShape } from '../domain/command-hint.js'

/**
pecot-workflow の MCP のサーバの registry.ts が登録するツールの形。並びは registry と同じ
*/
export const TOOL_HINT_COMMANDS: readonly HintCommandShape[] = [
  { name: 'project_list', inputs: ['repo'] },
  { name: 'project_search', inputs: ['owner', 'host', 'repo'] },
  { name: 'project_init', inputs: ['owner', 'name', 'host', 'lanes', 'confirm_delete', 'repo'] },
  { name: 'project_create', inputs: ['owner', 'title', 'host', 'lanes', 'repo'] },
  { name: 'project_activate', inputs: ['project', 'owner', 'host', 'repo'] },
  { name: 'project_link', inputs: ['repo', 'develop_branch', 'release_branch', 'changelog_file', 'package', 'clear_packages', 'release_type'] },
  { name: 'project_get', inputs: ['key', 'repo'] },
  { name: 'project_set', inputs: ['key', 'value', 'yes', 'repo'] },
  { name: 'project_unset', inputs: ['key', 'repo'] },
  { name: 'board_show', inputs: ['json', 'repo'] },
  { name: 'board_add', inputs: ['issue_ref', 'status', 'project', 'repo'] },
  { name: 'board_move', inputs: ['issue_ref', 'status', 'project', 'repo'] },
  { name: 'issue_create', inputs: ['files', 'message', 'title', 'repo', 'type', 'status', 'parent_epic', 'order', 'label', 'attributes', 'lane', 'freeform', 'project'] },
  { name: 'issue_check', inputs: ['files', 'project', 'repo'] },
  { name: 'issue_show', inputs: ['issue_ref', 'project', 'json', 'comment_limit', 'repo'] },
  { name: 'issue_attributes', inputs: ['project', 'json', 'repo'] },
  { name: 'issue_edit', inputs: ['issue_ref', 'attributes', 'project', 'repo'] },
  { name: 'issue_comment', inputs: ['file', 'message', 'issue_ref', 'template', 'project', 'repo'] },
  { name: 'issue_block', inputs: ['issue_ref', 'by', 'wait', 'reason', 'project', 'repo'] },
  { name: 'issue_unblock', inputs: ['issue_ref', 'by', 'project', 'repo'] },
  { name: 'issue_reopen', inputs: ['issue_ref', 'status', 'project', 'comment', 'repo'] },
  { name: 'session_start', inputs: ['issue_ref', 'branch', 'base', 'checkout', 'project', 'repo'] },
  { name: 'session_show', inputs: ['directory', 'project', 'repo'] },
  { name: 'session_finish', inputs: ['pr_ref', 'delete_branch', 'project', 'repo'] },
  { name: 'pr_create', inputs: ['file', 'message', 'title', 'base', 'head', 'draft', 'repo', 'no_issue_ref', 'template', 'screenshot', 'project'] },
  { name: 'pr_show', inputs: ['pr_ref', 'json', 'reviews', 'project', 'repo'] },
  { name: 'pr_check', inputs: ['directory', 'project', 'repo'] },
  { name: 'pr_merge', inputs: ['pr_ref', 'project', 'repo'] },
  { name: 'pr_restack', inputs: ['check', 'continue', 'abort', 'project', 'repo'] },
  { name: 'release_check', inputs: ['version', 'package', 'project', 'repo'] },
  { name: 'release_create', inputs: ['version', 'package', 'project', 'repo'] },
  { name: 'release_merge', inputs: ['pr_ref', 'delete_branch', 'admin', 'project', 'repo'] },
  { name: 'worktree_add', inputs: ['directory', 'base', 'path', 'no_copy', 'no_link', 'setup', 'allow_existing_branch', 'project', 'repo'] },
  { name: 'worktree_remove', inputs: ['name', 'directory', 'force', 'keep_branch', 'repo'] },
  { name: 'worktree_init', inputs: ['directory', 'repo'] },
  { name: 'worktree_link', inputs: ['directory', 'force', 'all', 'repo'] },
  { name: 'branch_delete', inputs: ['repo', 'branch', 'project'] },
  { name: 'workflow_install', inputs: ['name', 'check', 'force', 'directory', 'repo'] },
  { name: 'workflow_doctor', inputs: ['name', 'directory', 'repo'] },
]

/**
actions/ に移した処理の形。name の `_` を `-` にしたものが actions/<name>/action.yml、inputs は token を除く inputs を snake_case にしたもの
*/
export const ACTION_HINT_COMMANDS: readonly HintCommandShape[] = [
  { name: 'board_sync', inputs: ['project', 'dry_run'] },
  { name: 'review_finish', inputs: ['pr', 'job_status', 'execution_file', 'since', 'review_outcome', 'review_conclusion', 'review_has_token'] },
  { name: 'tracker_sync', inputs: ['source', 'project', 'dry_run'] },
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
