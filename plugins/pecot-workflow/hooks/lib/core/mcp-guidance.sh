#!/bin/bash
# Bash の pecot から MCP ツールへ移った後の案内文（source して使う）。
# 各関数は文を stdout に出すだけ。hook_message の kind は呼ぶ側が付ける。
# 読むのは gh-command-check.sh・git-worktree-branch-check.sh。

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
the status field settings, and the template validation, which breaks the consistency
and traceability of the workflow.

Use one of these instead:
  the MCP tool issue_create with freeform: true  (free-form quick filing)
  the MCP tool issue_create                      (from Markdown with frontmatter)
EOF
}

# gh-command-check.sh: gh stack の阻止。
mcp_guidance_gh_stack() {
    cat <<'EOF'
gh-stack-check: gh stack is not allowed (only gh stack view (use --json) and --help are).

Reason: running gh stack directly changes the stack without the workflow's records,
the Issue reference and the readiness checks, which breaks the consistency of the workflow.

Use these instead:
  the MCP tool pr_create of the workflow server  (open a PR, stacked when needed)
  the MCP tool pr_merge of the workflow server   (merge a PR)
  the MCP tool pr_restack of the workflow server (restack a stacked branch)
EOF
}

# git-worktree-branch-check.sh: 保護ブランチの push の阻止に足す、リモートブランチ削除の案内。
mcp_guidance_branch_delete() {
    cat <<'EOF'
To delete a remote branch, use the MCP tool branch_delete of the workflow server with repo (owner/repo) and branch.
EOF
}
