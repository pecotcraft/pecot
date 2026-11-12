#!/bin/bash
# Bash の pecot から MCP ツールへ移った後の案内文（source して使う）。
# 各関数は文を stdout に出すだけ。hook_message の kind は呼ぶ側が付ける。
# 読むのは次のファイル。
# gh-command-check.sh、git-worktree-branch-check.sh、external-post-check.sh。
# mcp-handlers/pecot-post-ask.sh、pre-tool-use/pecot-issue-pending-reminder.sh。

# gh-command-check.sh: gh pr create の阻止。
mcp_guidance_gh_pr_create() {
    cat <<'EOF'
gh-pr-create-check: gh pr create is not allowed.

Reason: using gh pr create directly skips the automatic Issue reference, the PR template validation,
and the traceability record, which breaks the consistency of the workflow.

Use this instead:
  the MCP tool pr_create of the workflow server
EOF
}

# gh-command-check.sh: gh issue create の阻止。
mcp_guidance_gh_issue_create() {
    cat <<'EOF'
gh-issue-create-check: gh issue create is not allowed.

Reason: using gh issue create directly skips the automatic registration on the project board,
the status/priority/size field settings, and the template validation, which breaks the consistency
and traceability of the workflow.

Use one of these instead:
  the MCP tool issue_quick   (free-form quick filing)
  the MCP tool issue_create  (from Markdown with frontmatter)
EOF
}

# git-worktree-branch-check.sh: 保護ブランチの push の阻止に足す、リモートブランチ削除の案内。
mcp_guidance_delete_branch() {
    cat <<'EOF'
To delete a remote branch, use the MCP tool delete_branch of the workflow server with repo_ref (owner/repo) and branch.
EOF
}

# pecot-issue-pending-reminder.sh: w-quick 起点の起票リマインド。
mcp_guidance_reminder_quick() {
    cat <<'EOF'
Issue filing is not complete.

Complete Step 1 of w-quick before moving on.
  Call the MCP tool issue_quick with repo (owner/repo) and message (summary of the user instruction).

This reminder disappears automatically once filing succeeds.
EOF
}

# pecot-issue-pending-reminder.sh: w-ready 起点の起票リマインド。
mcp_guidance_reminder_ready() {
    cat <<'EOF'
Subtask Issue filing is not complete.

Complete Step 4 of w-ready before moving on.
  1. Call the MCP tool issue_create with prepare: true, template: task, and repo (owner/repo)

  2. Edit the generated file (set title / parent_epic; repository is already set by repo)

  3. Call the MCP tool issue_create with files (the file path)

This reminder disappears automatically once filing succeeds.
EOF
}

# pecot-issue-pending-reminder.sh: 起点が分からないときの起票リマインド。
mcp_guidance_reminder_other() {
    cat <<'EOF'
Issue filing is not complete. Call the MCP tool issue_quick or issue_create first.
EOF
}

# external-post-check.sh: gh pr merge の ask の文。
mcp_guidance_pr_merge() {
    cat <<'EOF'
external-post-check: gh pr merge publishes a PR merge externally.

Do not run it until the user has explicitly approved.
The canonical route for merging is /pecot-w:w-merge.
Merge with gh pr merge, then clean up with the MCP tool pr_cleanup.
EOF
}

# exit-plan-comment-update.md: 承認後の計画が投稿済みの計画と違うときの打ち直しの案内。
mcp_guidance_plan_comment_update() {
    cat <<'EOF'
Plan comment update: if the approved plan differs from the posted one, fix the posted file.
Then call the MCP tool issue_comment with that file again.
EOF
}

# pecot-post-ask.sh: Issue 投稿の ask の文を、MCP の入力名で書いた版。
mcp_guidance_post_ask_issue() {
    cat <<'EOT'
external-post-check: the MCP tools issue_create / issue_quick (a real post) publish an Issue externally.

Do not call them until the user has explicitly approved.
The canonical routes for filing are these skills:
/pecot-w:w-quick, /pecot-w:w-ready, /pecot-w:w-backlog, /pecot-w:w-issueize.
To only generate a template, call issue_create with prepare: true.
The tool issue_quick has no prepare.
EOT
}

# pecot-post-ask.sh: PR 投稿の ask の文を、MCP の入力名で書いた版。
mcp_guidance_post_ask_pr() {
    cat <<'EOT'
external-post-check: the MCP tool pr_create (a real post) publishes a PR externally.

Do not call it until the user has explicitly approved.
To only review the content, call pr_create with prepare: true (template generation) or dry_run: true.
EOT
}
