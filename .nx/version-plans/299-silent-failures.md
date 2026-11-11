---
pecot-workflow: patch
---

`add-to-project`・`delete-branch`・`worktree remove`・`worktree init` が失敗を流さずに知らせる。
release 系は origin が無ければ最初の remote を使い、`worktree add --base` の help は実際の既定を示す。
