#!/bin/bash
# Check if committing directly to protected branches.
#
# Stage: commit-msg (runs after pre-commit, receives COMMIT_EDITMSG as $1).
# This lets us exempt release commits (chore(release):) produced by `nx release`.
# `nx release` commits to current HEAD only.
#
# Exemption: a message starting with "chore(release)" is allowed on any
# branch (including main). 単一ブランチ(trunk-based)運用では
# release commit が main 上に直接載るため main でも許可する。人間が
# chore(release): を手書きすることはないため安全。release 以外の直接
# コミットは protected branch では引き続き block する。

current_branch=$(git rev-parse --abbrev-ref HEAD)
commit_msg_file="$1"

# Release commit exemption
if [ -n "$commit_msg_file" ] && [ -f "$commit_msg_file" ]; then
    first_line=$(head -n 1 "$commit_msg_file")
    if [[ "$first_line" =~ ^chore\(release\) ]]; then
        exit 0
    fi
fi

# Protected branches list
protected_branches=("main")

# wtブランチは正規表現で判定
if [[ "$current_branch" =~ ^wt[0-9]+$ ]]; then
    echo ""
    echo "=========================================="
    echo "❌ エラー: $current_branch ブランチへの直接コミットは禁止されています"
    echo "=========================================="
    echo ""
    echo "📋 正しい手順:"
    echo ""
    echo "  1. feature branchを作成:"
    echo "     git checkout -b feat/your-feature-name"
    echo ""
    echo "  2. feature branchでコミット:"
    echo "     git commit -m \"your commit message\""
    echo ""
    echo "  3. PRを作成:"
    echo "     /pecot-w:w-pr"
    echo ""
    echo "※ chore(release): から始まる commit（Nx Release）は例外的に許可されます。"
    echo "=========================================="
    echo ""
    exit 1
fi

for branch in "${protected_branches[@]}"; do
    if [ "$current_branch" = "$branch" ]; then
        echo ""
        echo "=========================================="
        echo "❌ エラー: $current_branch ブランチへの直接コミットは禁止されています"
        echo "=========================================="
        echo ""
        echo "📋 正しい手順:"
        echo ""

        echo "  ${branch} への変更は feature branch からのPRのみ許可されています"
        echo ""
        echo "  1. feature branchを作成:"
        echo "     git checkout -b feat/your-feature-name"
        echo ""
        echo "  2. feature branchでコミット・PRを作成"
        echo ""
        echo "※ chore(release): から始まる commit（Nx Release）は例外的に許可されます。"

        echo ""
        echo "=========================================="
        echo ""
        exit 1
    fi
done

exit 0
