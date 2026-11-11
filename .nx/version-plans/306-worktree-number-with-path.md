---
pecot-workflow: patch
---

`pecot worktree add` は、`--path` で作った worktree が使う wtN を避け、作った worktree に wtN を記録する。
`pecot pr cleanup` は、記録した wtN に戻る。
