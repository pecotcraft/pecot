// 案内（domain/command-hint.ts）が名指しできるコマンドの形。actions/ は pecot-workflow の registry を持たないので、ここから登録する。
// CLI_HINT_COMMANDS が registry と同じかは、cli の registry.test.ts が確かめる。
// ACTION_HINT_COMMANDS が action.yml と合うかは、actions のテストが確かめる。
import { registerHintCommands } from '../domain/command-hint.js'
import type { HintCommandShape } from '../domain/command-hint.js'

/**
pecot-workflow の cli の registry.ts が登録するコマンドの形。並びは registry と同じ
*/
export const CLI_HINT_COMMANDS: readonly HintCommandShape[] = [
  { path: ['project', 'list'], positional: [], inputs: ['repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['project', 'search'], positional: ['owner'], inputs: ['owner', 'host', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['project', 'init'], positional: ['owner', 'name'], inputs: ['owner', 'name', 'host', 'lanes', 'dry_run', 'confirm_delete', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['project', 'create'], positional: ['owner', 'title'], inputs: ['owner', 'title', 'host', 'lanes', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['project', 'activate'], positional: ['project'], inputs: ['project', 'owner', 'host', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['project', 'link'], positional: ['repo'], inputs: ['repo', 'develop_branch', 'release_branch', 'changelog_file', 'package', 'clear_packages', 'release_type', 'dry_run'], cliOnly: ['dry_run'], hasOwnRepo: true },
  { path: ['project', 'get'], positional: ['key'], inputs: ['key', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['project', 'set'], positional: ['key', 'value'], inputs: ['key', 'value', 'yes', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['project', 'unset'], positional: ['key'], inputs: ['key', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['board', 'show'], positional: [], inputs: ['json', 'repo'], cliOnly: [], hasOwnRepo: true },
  { path: ['board', 'add'], positional: ['issue_ref'], inputs: ['issue_ref', 'status', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['board', 'move'], positional: ['issue_ref', 'status'], inputs: ['issue_ref', 'status', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['issue', 'create'], positional: ['files'], inputs: ['files', 'message', 'title', 'repo', 'type', 'status', 'parent_epic', 'order', 'label', 'attributes', 'lane', 'freeform', 'project'], cliOnly: [], hasOwnRepo: true },
  { path: ['issue', 'check'], positional: ['files'], inputs: ['files', 'project', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['issue', 'show'], positional: ['issue_ref'], inputs: ['issue_ref', 'project', 'json', 'comment_limit', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['issue', 'attributes'], positional: [], inputs: ['project', 'json', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['issue', 'edit'], positional: ['issue_ref'], inputs: ['issue_ref', 'attributes', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['issue', 'comment'], positional: ['file'], inputs: ['file', 'message', 'issue_ref', 'template', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['issue', 'block'], positional: ['issue_ref'], inputs: ['issue_ref', 'by', 'wait', 'reason', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['issue', 'unblock'], positional: ['issue_ref'], inputs: ['issue_ref', 'by', 'project', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['issue', 'reopen'], positional: ['issue_ref'], inputs: ['issue_ref', 'status', 'project', 'comment', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['session', 'start'], positional: ['issue_ref', 'branch'], inputs: ['issue_ref', 'branch', 'base', 'checkout', 'dry_run', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['session', 'show'], positional: [], inputs: ['directory', 'project', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['session', 'finish'], positional: ['pr_ref'], inputs: ['pr_ref', 'dry_run', 'delete_branch', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['pr', 'create'], positional: ['file'], inputs: ['file', 'message', 'title', 'base', 'head', 'draft', 'dry_run', 'repo', 'no_issue_ref', 'template', 'screenshot', 'project'], cliOnly: ['dry_run'], hasOwnRepo: true },
  { path: ['pr', 'show'], positional: ['pr_ref'], inputs: ['pr_ref', 'json', 'reviews', 'project', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['pr', 'check'], positional: [], inputs: ['directory', 'project', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['pr', 'merge'], positional: ['pr_ref'], inputs: ['pr_ref', 'dry_run', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['pr', 'restack'], positional: [], inputs: ['check', 'continue', 'abort', 'dry_run', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['release', 'check'], positional: ['version'], inputs: ['version', 'package', 'project', 'repo'], cliOnly: [], hasOwnRepo: false },
  { path: ['release', 'create'], positional: ['version'], inputs: ['version', 'dry_run', 'package', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['release', 'merge'], positional: ['pr_ref'], inputs: ['pr_ref', 'dry_run', 'delete_branch', 'admin', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['worktree', 'add'], positional: [], inputs: ['directory', 'base', 'path', 'no_copy', 'no_link', 'setup', 'dry_run', 'allow_existing_branch', 'project', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['worktree', 'remove'], positional: ['name'], inputs: ['name', 'directory', 'force', 'keep_branch', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['worktree', 'init'], positional: [], inputs: ['directory', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['worktree', 'link'], positional: [], inputs: ['directory', 'force', 'all', 'dry_run', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['branch', 'delete'], positional: ['repo', 'branch'], inputs: ['repo', 'branch', 'dry_run', 'project'], cliOnly: ['dry_run'], hasOwnRepo: true },
  { path: ['workflow', 'install'], positional: ['name'], inputs: ['name', 'check', 'force', 'dry_run', 'directory', 'repo'], cliOnly: ['dry_run'], hasOwnRepo: false },
  { path: ['workflow', 'doctor'], positional: ['name'], inputs: ['name', 'directory', 'repo'], cliOnly: [], hasOwnRepo: false },
]

/**
actions/ に移した処理の形。path は actions/<path を - でつないだ名前>/action.yml、inputs は token を除く inputs を snake_case にしたもの
*/
export const ACTION_HINT_COMMANDS: readonly HintCommandShape[] = [
  { path: ['board', 'sync'], positional: [], inputs: ['project', 'dry_run'], cliOnly: [], hasOwnRepo: false },
  { path: ['review', 'finish'], positional: [], inputs: ['pr', 'job_status', 'execution_file', 'since', 'review_outcome', 'review_conclusion', 'review_has_token'], cliOnly: [], hasOwnRepo: false },
  { path: ['tracker', 'sync'], positional: [], inputs: ['source', 'project', 'dry_run'], cliOnly: [], hasOwnRepo: false },
  { path: ['auto', 'gate'], positional: [], inputs: ['max_ci_attempts', 'project'], cliOnly: [], hasOwnRepo: false },
  { path: ['auto', 'start'], positional: [], inputs: ['issue', 'project'], cliOnly: [], hasOwnRepo: false },
  { path: ['auto', 'finish'], positional: [], inputs: ['issue', 'project', 'result_file', 'job_status', 'execution_file', 'start_outcome', 'result', 'body_file'], cliOnly: [], hasOwnRepo: false },
]

/**
CLI と actions/ の両方の形を、案内の描き方に登録する。actions/ の処理は、案内を描く前にこれを呼ぶ
*/
export function registerHintCatalog(): void {
  registerHintCommands([...CLI_HINT_COMMANDS, ...ACTION_HINT_COMMANDS])
}
