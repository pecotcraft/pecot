---
pecot-workflow: patch
---

`pecot worktree remove <名前>` は、機能ブランチに移った worktree も削除する。
`worktree add` が記録した名前、`<project root>/<名前>/<repo>` の置き場所、ブランチ名の順で worktree を探す。
`pecot worktree` のコマンドは、空白を含むパスの worktree を一覧から正しく読む。
