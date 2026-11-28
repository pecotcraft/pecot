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
  check the values with the MCP tool pr_check of the workflow server,
  then create the PR with create_pull_request of the official GitHub MCP server
  (steps: skills/w-help/references/github-write.md)
EOF
}

# gh-command-check.sh: gh issue create の阻止。
mcp_guidance_gh_issue_create() {
    cat <<'EOF'
gh-issue-create-check: gh issue create is not allowed.

Reason: using gh issue create directly skips the checks of the workflow (the template,
the title number, the prerequisites and the board fields), which breaks the consistency
and traceability of the workflow.

Use this instead:
  check the arguments with the MCP tool issue_check of the workflow server,
  then create the Issue with issue_write of the official GitHub MCP server
  (steps: skills/w-help/references/github-write.md)
EOF
}

# gh-command-check.sh: gh stack の阻止。
mcp_guidance_gh_stack() {
    cat <<'EOF'
gh-stack-check: gh stack is not allowed (only gh stack view (use --json) and --help are).

Reason: running gh stack directly changes the stack without the workflow's records,
the Issue reference and the readiness checks, which breaks the consistency of the workflow.

Use these instead:
  open a stacked PR: check with the MCP tool pr_check of the workflow server, create it with
    create_pull_request of the official GitHub MCP server, then register it with the
    stack-register operation of github-ops (steps: skills/w-help/references/github-write.md)
  merge a PR: the merge button on the GitHub page (/pecot-w:w-pr waits for it and cleans up)
  restack a stacked branch: the MCP tool pr_restack of the workflow server
EOF
}

# git-worktree-branch-check.sh: 保護ブランチの push の阻止に足す、リモートブランチ削除の案内。
mcp_guidance_branch_delete() {
    cat <<'EOF'
To delete a merged branch on the remote, leave it to the repository setting
"Automatically delete head branches". Delete the local branch with git branch -D.
EOF
}
